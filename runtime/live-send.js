// Live-send switch for rebuilt sites. Loaded first on every page, before any page script.
// site-config.js says which origins belong to the source site and whether this copy may send to
// them. While sending is off (the default), nothing reaches those origins: fetch, XHR, beacons
// and native form posts to them are stopped, and the visitor sees "Preview: nothing was sent".
// Forms still validate first (a native submit event only fires once the form is valid).
(function () {
  var cfg = window.SITE_CONFIG || {};
  var origins = (cfg.liveOrigins || []).map(function (o) {
    return String(o).replace(/\/+$/, "").toLowerCase();
  });
  if (!origins.length || cfg.liveSend === true) return;

  var host = (cfg.liveOrigins[0] || "").replace(/^https?:\/\//, "");
  var MESSAGE = "Preview: nothing was sent. Sending to " + host + " is turned off for this copy of the site.";

  function isLive(url) {
    try {
      var u = new URL(url, location.href);
      return origins.indexOf(u.origin.toLowerCase()) >= 0;
    } catch {
      return false;
    }
  }

  var note;
  function tell() {
    if (!document.body) return;
    if (!note) {
      note = document.createElement("div");
      note.className = "live-send-note";
      note.setAttribute("role", "status");
      note.setAttribute("aria-live", "polite");
      note.style.cssText =
        "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;max-width:min(92vw,560px);" +
        "padding:14px 18px;border-radius:6px;background:#111;color:#fff;font:600 15px/1.4 system-ui,sans-serif;" +
        "box-shadow:0 10px 40px rgba(0,0,0,.45);border:2px solid #ffb81c";
      document.body.appendChild(note);
    }
    note.textContent = MESSAGE;
    note.hidden = false;
    clearTimeout(tell.t);
    tell.t = setTimeout(function () {
      note.hidden = true;
    }, 9000);
  }

  function PreviewNotSent() {
    this.name = "PreviewNotSent";
    this.message = MESSAGE;
  }
  PreviewNotSent.prototype = Object.create(Error.prototype);

  var realFetch = window.fetch;
  if (realFetch) {
    window.fetch = function (input) {
      var url = typeof input === "string" ? input : input && input.url;
      if (isLive(url)) {
        tell();
        return Promise.reject(new PreviewNotSent());
      }
      return realFetch.apply(this, arguments);
    };
  }

  var open = XMLHttpRequest.prototype.open;
  var send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__liveBlocked = isLive(url);
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__liveBlocked) {
      tell();
      setTimeout(
        function () {
          this.dispatchEvent(new Event("error"));
          this.dispatchEvent(new Event("loadend"));
        }.bind(this),
        0,
      );
      return;
    }
    return send.apply(this, arguments);
  };

  if (navigator.sendBeacon) {
    var beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url) {
      if (isLive(url)) {
        tell();
        return false;
      }
      return beacon.apply(null, arguments);
    };
  }

  // Native posts: a valid form whose action is the live site is stopped here (capture phase,
  // before page handlers), and programmatic form.submit() is held to the same rule.
  document.addEventListener(
    "submit",
    function (e) {
      var form = e.target;
      if (form && form.getAttribute && form.getAttribute("action") && isLive(form.action)) {
        e.preventDefault();
        tell();
      }
    },
    true,
  );
  var submit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    if (this.getAttribute("action") && isLive(this.action)) return tell();
    return submit.apply(this, arguments);
  };
})();
