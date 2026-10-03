/* Measuring panel for the scroll film: add ?measure to the page URL.
 *
 * Shows on screen what this device actually got: time to the first picture and to the first
 * scene, data downloaded, frames in memory, dropped frames and the longest stall while
 * scrolling. Reads window.__stage (stage.js) and the browser's own resource timings.
 * Sends nothing anywhere; "Copy" puts the numbers on this device's clipboard.
 */
(function () {
  "use strict";
  var GOOD = { firstPicture: 2.5, sceneSmooth: 6, droppedPct: 5, stall: 0.5 };
  var other = { bytes: 0, files: 0 };
  function addEntry(e) {
    if (e.name.indexOf("/frames/") >= 0) return; // frames are counted by the stage itself
    other.bytes += e.transferSize || e.encodedBodySize || 0;
    other.files++;
  }
  try {
    var nav = performance.getEntriesByType("navigation")[0];
    if (nav) addEntry(nav);
    new PerformanceObserver(function (l) { l.getEntries().forEach(addEntry); }).observe({ type: "resource", buffered: true });
  } catch (e) { /* older browsers: frame bytes still come from the stage */ }

  var lastScroll = -1e9;
  window.addEventListener("scroll", function () { lastScroll = performance.now(); }, { passive: true });
  var lastT = 0, warm = [], refresh = 16.7;
  var m = { frames: 0, dropped: 0, stallStart: 0, longest: 0, stalls: 0, maxProg: 0 };
  function reset() { m = { frames: 0, dropped: 0, stallStart: 0, longest: 0, stalls: 0, maxProg: 0 }; }
  function loop(t) {
    var st = window.__stage;
    var dt = lastT ? t - lastT : 0;
    lastT = t;
    if (st && st.marks && dt > 0 && dt < 1000) {
      // The display's own frame interval: a low percentile of the first frames seen.
      if (warm.length < 90) { warm.push(dt); var s = warm.slice().sort(function (a, b) { return a - b; }); refresh = Math.min(34, Math.max(6.9, s[Math.floor(s.length * 0.2)])); }
      var moving = !st.settled || t - lastScroll < 200;
      if (moving) {
        m.frames++;
        if (dt > refresh * 1.5) { var extra = Math.round(dt / refresh) - 1; m.dropped += extra; m.frames += extra; }
        // A stall: the picture is more than 6 frames (a quarter second of film) behind the scroll.
        var behind = st.drawn < 0 ? 1e9 : Math.abs(st.wanted - st.drawn);
        if (behind > 6) { if (!m.stallStart) m.stallStart = t; }
        else if (m.stallStart) { endStall(t); }
      } else if (m.stallStart) endStall(t);
      m.maxProg = Math.max(m.maxProg, st.progress || 0);
    }
    requestAnimationFrame(loop);
  }
  function endStall(t) { var d = t - m.stallStart; if (d > 100) m.stalls++; m.longest = Math.max(m.longest, d); m.stallStart = 0; }
  requestAnimationFrame(loop);

  var panel = document.createElement("div");
  panel.setAttribute("data-measure-panel", "");
  panel.style.cssText = "position:fixed;z-index:2147483647;top:max(8px,env(safe-area-inset-top));right:8px;max-width:min(92vw,360px);" +
    "background:rgba(10,10,10,.86);color:#f4f4f4;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;padding:10px 12px;border-radius:8px;" +
    "box-shadow:0 2px 12px rgba(0,0,0,.4);-webkit-text-size-adjust:100%;";
  var body = document.createElement("div");
  var bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:6px;margin-top:8px";
  function button(label, fn) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText = "font:inherit;color:#111;background:#ffd34d;border:0;border-radius:5px;padding:5px 9px;cursor:pointer";
    b.addEventListener("click", fn);
    bar.appendChild(b);
    return b;
  }
  var hidden = false;
  var copyBtn = button("Copy", function () {
    var text = lines().map(function (l) { return l[0] + ": " + l[1] + (l[2] ? " (" + l[2] + ")" : ""); }).join("\n");
    var done = function () { copyBtn.textContent = "Copied"; setTimeout(function () { copyBtn.textContent = "Copy"; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    else { fallbackCopy(text); done(); }
  });
  button("Reset scroll numbers", reset);
  var hideBtn = button("Hide", function () { hidden = !hidden; body.style.display = hidden ? "none" : ""; hideBtn.textContent = hidden ? "Show numbers" : "Hide"; });
  panel.appendChild(body);
  panel.appendChild(bar);
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) { /* nothing else to try */ }
    ta.remove();
  }

  function mb(b) { return (b / 1048576).toFixed(1) + " MB"; }
  function sec(ms) { return (ms / 1000).toFixed(1) + " s"; }
  function verdict(ok) { return ok ? "good" : "slow"; }
  function lines() {
    var st = window.__stage;
    if (!st || !st.info) return [["Film", "not started yet"]];
    var i = st.info(), k = st.marks || {};
    var out = [];
    out.push(["Device", window.innerWidth + "×" + window.innerHeight + " @" + (window.devicePixelRatio || 1) + "x, frames " + i.set + (i.thin ? " (data saver: every other frame)" : "")]);
    out.push(["First picture", k.firstFrame ? sec(k.firstFrame) : "waiting", k.firstFrame ? verdict(k.firstFrame / 1000 <= GOOD.firstPicture) : ""]);
    out.push(["First scene scrubs", k.sceneCoarse ? sec(k.sceneCoarse) + " after " + mb(k.bytesAtSceneCoarse) : "loading"]);
    var past = st.scenes && st.scenes[0] && st.progress * st.total > st.scenes[0].b;
    out.push(["First scene smooth", k.sceneReady ? sec(k.sceneReady) + " after " + mb(k.bytesAtSceneReady) : past ? "you scrolled past it first" : "loading", k.sceneReady ? verdict(k.sceneReady / 1000 <= GOOD.sceneSmooth) : ""]);
    out.push(["Data downloaded", mb(i.fetchedBytes + other.bytes) + " (film frames " + mb(i.fetchedBytes) + " in " + i.fetchedFiles + " files)"]);
    out.push(["Frames in memory", i.decodedFrames + " ready to draw (" + mb(i.decodedBytes) + ") + " + mb(i.heldBlobBytes) + " downloaded"]);
    var pct = m.frames ? (m.dropped / m.frames) * 100 : 0;
    out.push(["Dropped frames while scrolling", m.frames ? pct.toFixed(1) + "% (" + m.dropped + " of " + m.frames + ")" : "scroll to measure", m.frames > 60 ? verdict(pct <= GOOD.droppedPct) : ""]);
    var longest = Math.max(m.longest, m.stallStart ? performance.now() - m.stallStart : 0);
    out.push(["Longest stall", m.frames ? sec(longest) + " (" + m.stalls + " stalls over 0.1 s)" : "scroll to measure", m.frames > 60 ? verdict(longest / 1000 <= GOOD.stall) : ""]);
    out.push(["Film scrolled through", Math.round(m.maxProg * 100) + "%"]);
    if (performance.memory) out.push(["Script memory", mb(performance.memory.usedJSHeapSize)]);
    return out;
  }
  function render() {
    if (!hidden) {
      body.textContent = "";
      var h = document.createElement("div");
      h.textContent = "Measuring: nothing is sent anywhere";
      h.style.cssText = "color:#ffd34d;margin-bottom:4px";
      body.appendChild(h);
      lines().forEach(function (l) {
        var row = document.createElement("div");
        row.textContent = l[0] + ": " + l[1] + " ";
        if (l[2]) {
          var tag = document.createElement("b");
          tag.textContent = l[2];
          tag.style.color = l[2] === "good" ? "#7be08a" : "#ff8a7a";
          row.appendChild(tag);
        }
        body.appendChild(row);
      });
    }
    setTimeout(render, 500);
  }
  function mount() { document.body.appendChild(panel); render(); }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
})();
