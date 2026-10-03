/* Scroll stage runtime for generated sites. No dependencies.
 *
 * Reads site.json, pins a full-viewport <canvas id="stage">, and maps scroll position onto a
 * piecewise timeline: [clip frames] [hold on last frame] [dither dissolve to next clip] ...
 * Copy elements in the page are timed by data attributes:
 *   data-scene="0..N-1" | "finale"   which scene block they belong to
 *   data-in / data-out               scene-local progress window 0..1 (clip + hold), defaults from site.json
 *   data-fx="fade|rise|smear|fragments"
 * Any element with [data-section-label] shows the current scene's label.
 * Scrubbing is smoothed (critically damped follow of the scroll position), so it runs forwards
 * and backwards. prefers-reduced-motion: no scrubbing; each scene becomes a static section
 * with its poster still and its copy.
 * ?measure in the page URL adds an on-screen panel (runtime/measure.js) showing what this device
 * got: time to the first scene, data downloaded, dropped frames, longest stall. It sends nothing.
 */
(function () {
  "use strict";
  var doc = document.documentElement;
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var mobile = window.matchMedia("(max-width: 760px)").matches;
  if (/[?&]measure(=|&|$)/.test(location.search) && document.currentScript) {
    var ms = document.createElement("script");
    ms.src = new URL("measure.js", document.currentScript.src).href;
    document.head.appendChild(ms);
  }

  fetch("site.json")
    .then(function (r) { return r.json(); })
    .then(function (site) { (reduce ? staticMode : stageMode)(site); })
    .catch(function (err) { console.error("[stage] site.json failed", err); doc.classList.add("stage-failed"); });

  function copyEls() { return Array.prototype.slice.call(document.querySelectorAll("[data-scene]")); }

  /* ---------------- reduced motion: static sections ---------------- */
  function staticMode(site) {
    doc.classList.add("rm");
    var main = document.querySelector("[data-copy-layer]") || document.body;
    var blocks = site.scenes.map(function (s, i) {
      var sec = document.createElement("section");
      sec.className = "rm-scene";
      // posters = [hero, end still of clip 1, ..., end still of clip N]: scene i's copy belongs to the
      // frame its clip lands on (posters[i + 1]); the hero copy belongs to the opening frame.
      sec.style.backgroundImage = "url(" + site.posters[i === 0 ? 0 : Math.min(i + 1, site.posters.length - 1)] + ")";
      sec.setAttribute("aria-label", s.label);
      main.appendChild(sec);
      return sec;
    });
    var fin = document.createElement("section");
    fin.className = "rm-scene rm-finale";
    fin.style.backgroundImage = "url(" + site.posters[site.posters.length - 1] + ")";
    main.appendChild(fin);
    copyEls().forEach(function (el) {
      var k = el.getAttribute("data-scene");
      (k === "finale" ? fin : blocks[+k] || fin).appendChild(el);
      el.classList.add("is-active");
    });
    setLabel(site.scenes[0].label);
    // The fixed chrome label follows the section being read.
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting && e.target.getAttribute("aria-label")) setLabel(e.target.getAttribute("aria-label")); });
      }, { rootMargin: "-45% 0px -50% 0px" });
      blocks.forEach(function (b) { io.observe(b); });
    }
  }

  /* ---------------- scroll stage ---------------- */
  function stageMode(site) {
    doc.classList.add("js-stage");
    var canvas = document.getElementById("stage");
    var track = document.getElementById("track");
    if (!canvas || !track) { console.error("[stage] needs #stage canvas and #track"); return; }
    var box = canvas.parentNode;

    // ---- frame sets ----
    // Phones (touch, short side <= 600 px) get the light sets (540 px, smaller files): the full sets
    // cost a phone ~50 MB on mobile data for no visible gain on its screen. Portrait screens get the
    // portrait set when the site has one. All sets have the same frames per clip as site.clips.
    var touch = window.matchMedia("(pointer: coarse)").matches;
    var phone = touch && Math.min(screen.width, screen.height) <= 600;
    var conn = navigator.connection || {};
    // Data saver or a slow connection: every other frame (scrubbing still works, half the data).
    var thin = !!(conn.saveData || /(^|-)(2g|3g)$/.test(conn.effectiveType || ""));
    var stride1 = thin ? 2 : 1;
    function pickSet() {
      var portrait = window.innerHeight > window.innerWidth;
      if (phone && portrait && site.phoneClips) return { name: "phone-portrait", clips: site.phoneClips };
      if (phone && site.phoneLandscapeClips) return { name: "phone-landscape", clips: site.phoneLandscapeClips };
      if (portrait && site.mobileClips) return { name: "portrait", clips: site.mobileClips };
      return { name: "landscape", clips: site.clips };
    }

    // ---- timeline (viewport heights), from site.clips so it is the same for every set ----
    var vhPerSec = (site.timing && site.timing.vhPerSecond) || 0.3;
    var mult = mobile ? 0.8 : 1;
    var segs = [];
    var sceneSpan = [];
    var at = 0;
    site.scenes.forEach(function (s, i) {
      var start = at;
      var len = (site.clips[s.clip].count / site.fps) * vhPerSec * mult;
      segs.push({ type: "clip", scene: i, clip: s.clip, a: at, b: at + len });
      at += len;
      if (s.holdVh > 0) { segs.push({ type: "hold", scene: i, clip: s.clip, a: at, b: at + s.holdVh * mult }); at += s.holdVh * mult; }
      sceneSpan.push({ a: start, b: at, clipEnd: start + len });
      if (s.seamToNext === "dissolve" && i < site.scenes.length - 1) {
        var d = (site.timing && site.timing.dissolveVh) || 0.4;
        segs.push({ type: "dissolve", scene: i, clip: s.clip, next: site.scenes[i + 1].clip, a: at, b: at + d * mult });
        at += d * mult;
      }
    });
    var finaleVh = ((site.timing && site.timing.finaleVh) || 0.9) * mult;
    segs.push({ type: "hold", scene: site.scenes.length - 1, clip: site.scenes[site.scenes.length - 1].clip, a: at, b: at + finaleVh, finale: true });
    var finaleStart = at;
    at += finaleVh;
    var total = at;

    // ---- layout ----
    // The stage is 100lvh (base.css): the largest viewport, so a phone's address bar showing or
    // hiding never resizes the canvas or the track (which would clear the picture and make the
    // film jump). Only a width change (rotation, window resize) lays out again, keeping the
    // viewer at the same point of the film.
    var trackPx = 0, viewH = 0, viewW = 0;
    function layout() {
      viewW = window.innerWidth;
      viewH = box.clientHeight || window.innerHeight;
      trackPx = total * viewH + viewH;
      track.style.height = trackPx + "px";
    }
    function trackMax() { return trackPx - viewH; }
    layout();

    // ---- frames: download compressed, decode ahead of the playhead off the main thread ----
    // Drawing an <img> into WebGL makes the browser decode it again, synchronously, on every new
    // frame (~10 ms per frame on a fast desktop, ~50 ms on a phone-class CPU). Frames are fetched as
    // compressed blobs, every 4th frame of a clip first (so it scrubs at once), then the rest, and
    // decoded with createImageBitmap a little ahead of where the viewer is heading; only a bounded
    // window of decoded frames is kept. Phones fetch only the clips near the playhead and let go
    // of far ones, so data and memory follow how far the visitor actually scrolls.
    var set, clips, blobs, offsets, totalFrames, gen = 0;
    var bitmaps = new Map(), retired = null, decoding = new Set();
    var globalOf = new WeakMap(); // decoded frame -> global index (exposed as __stage.drawn)
    var loading = 0, queue = [], fetchedBytes = 0, fetchedFiles = 0;
    var maxConc = phone ? 6 : 12;
    var AHEAD = phone ? 16 : 30, BEHIND = phone ? 4 : 10, KEEP = phone ? 24 : 48;
    var CLIPS_AHEAD = phone ? 2 : 99, CLIPS_BEHIND = phone ? 1 : 99;
    var wantDecode = true, heading = 1, maxDecoding = phone ? 2 : 4;
    var canBitmap = typeof window.createImageBitmap === "function";
    var marks = {};
    function useSet(s) {
      gen++;
      set = s;
      clips = s.clips;
      if (retired) retired.forEach(function (bm) { if (bm.close) bm.close(); });
      retired = bitmaps; // closed once the new set has drawn, so the picture never goes blank
      bitmaps = new Map();
      decoding = new Set();
      blobs = clips.map(function (c) { return new Array(c.count); });
      offsets = [];
      totalFrames = clips.reduce(function (n, c) { offsets.push(n); return n + c.count; }, 0);
      queue = [];
      doc.classList.toggle("portrait-clips", s.clips === site.mobileClips || s.clips === site.phoneClips);
      doc.setAttribute("data-frame-set", s.name);
    }
    function src(ci, fi) { return clips[ci].dir + "/f" + ("000" + fi).slice(-4) + ".webp"; }
    function buildQueue(center, dir) {
      queue = [];
      var step = dir < 0 ? -1 : 1;
      var push = function (ci, stride) {
        if (ci < 0 || ci >= clips.length) return;
        if ((ci - center) * step > CLIPS_AHEAD || (center - ci) * step > CLIPS_BEHIND) return;
        for (var fi = 0; fi < clips[ci].count; fi += stride) if (blobs[ci][fi] === undefined) queue.push([ci, fi]);
        var last = clips[ci].count - 1;
        if (blobs[ci][last] === undefined) queue.push([ci, last]);
      };
      push(center, 4); push(center + step, 4);
      push(center, stride1); push(center + step, stride1);
      push(center - step, 4); push(center + 2 * step, 4);
      push(center + 2 * step, stride1); push(center - step, stride1 * 2);
      var rest = clips.map(function (_, i) { return i; }).sort(function (x, y) { return Math.abs(x - center) - Math.abs(y - center); });
      [4, 2, stride1].forEach(function (stride) { rest.forEach(function (ci) { push(ci, stride); }); });
      // Phones let go of downloaded frames outside the window (the HTTP cache keeps them cheap to refetch).
      if (phone) blobs.forEach(function (arr, ci) {
        if ((ci - center) * step > CLIPS_AHEAD || (center - ci) * step > CLIPS_BEHIND) for (var fi = 0; fi < arr.length; fi++) if (arr[fi]) arr[fi] = undefined;
      });
    }
    function clipLoaded(ci, stride) {
      var arr = blobs[ci], last = arr.length - 1;
      for (var fi = 0; fi <= last; fi++) if ((fi % stride === 0 || fi === last) && !arr[fi]) return false;
      return true;
    }
    function pump() {
      while (loading < maxConc && queue.length) {
        var job = queue.shift();
        var ci = job[0], fi = job[1];
        if (blobs[ci][fi] !== undefined) continue;
        blobs[ci][fi] = null; // in flight
        loading++;
        (function (ci, fi, g, arr) {
          fetch(src(ci, fi)).then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.blob(); }).then(function (b) {
            fetchedBytes += b.size; fetchedFiles++;
            if (g !== gen || arr !== blobs[ci]) return;
            arr[fi] = b; wantDecode = true;
            if (ci === 0 && !marks.sceneCoarse && clipLoaded(0, 4)) { marks.sceneCoarse = performance.now(); marks.bytesAtSceneCoarse = fetchedBytes; }
            if (ci === 0 && !marks.sceneReady && clipLoaded(0, stride1)) { marks.sceneReady = performance.now(); marks.bytesAtSceneReady = fetchedBytes; }
          }, function () { if (g === gen && arr === blobs[ci] && arr[fi] === null) arr[fi] = undefined; }).then(function () {
            loading--; pump();
          });
        })(ci, fi, gen, blobs[ci]);
      }
    }

    function decodeOne(ci, fi) {
      if (ci < 0 || ci >= clips.length || fi < 0 || fi >= clips[ci].count) return false;
      var g = offsets[ci] + fi, blob = blobs[ci][fi], myGen = gen;
      if (!blob || bitmaps.has(g) || decoding.has(g)) return false;
      decoding.add(g);
      var done = function (bm) {
        if (myGen !== gen) { if (bm && bm.close) bm.close(); return; }
        decoding.delete(g);
        if (bm) { bitmaps.set(g, bm); globalOf.set(bm, g); dirty = true; }
        wantDecode = true;
      };
      if (canBitmap) {
        createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" })
          .catch(function () { return createImageBitmap(blob); })
          .then(done, function () { done(null); });
      } else {
        var url = URL.createObjectURL(blob), img = new Image();
        img.src = url;
        (img.decode ? img.decode() : Promise.resolve()).then(function () { done(img); }, function () { done(null); }).then(function () { URL.revokeObjectURL(url); });
      }
      return true;
    }
    function scheduleDecode(ci, fi, dest) {
      if (!wantDecode) return;
      wantDecode = false;
      // A flick: the frame the scroll will come to rest on comes first.
      if (dest.ci !== ci || Math.abs(dest.fi - fi) > AHEAD) decodeOne(dest.ci, dest.fi);
      // Then nearest first, in the direction of travel, then a few behind.
      var order = [];
      for (var d = 0; d <= AHEAD; d++) order.push(fi + d * heading);
      for (var e = 1; e <= BEHIND; e++) order.push(fi - e * heading);
      for (var k = 0; k < order.length && decoding.size < maxDecoding; k++) decodeOne(ci, order[k]);
      // Nothing near the playhead has arrived yet (slow network, visitor scrolling ahead of the
      // downloads): decode the nearest frame of this clip that has, rather than show nothing.
      var have = false;
      for (var q = Math.max(0, fi - AHEAD); q <= Math.min(clips[ci].count - 1, fi + AHEAD) && !have; q++) have = bitmaps.has(offsets[ci] + q) || decoding.has(offsets[ci] + q);
      if (!have) for (var r = 1; r < clips[ci].count && decoding.size < maxDecoding; r++) if (decodeOne(ci, fi - r) || decodeOne(ci, fi + r)) break;
      // Near a clip boundary, the first frames of the next clip as well.
      var nc = ci + heading;
      if (nc >= 0 && nc < clips.length && (heading > 0 ? clips[ci].count - fi : fi) < AHEAD) {
        var startF = heading > 0 ? 0 : clips[nc].count - 1;
        for (var m = 0; m < 6 && decoding.size < maxDecoding; m++) decodeOne(nc, startF + m * heading);
      }
      if (decoding.size >= maxDecoding) wantDecode = true;
      // Free decoded frames far from the playhead (close() releases the memory at once).
      if (bitmaps.size > KEEP) {
        var here = offsets[ci] + fi, there = offsets[dest.ci] + dest.fi;
        bitmaps.forEach(function (bm, g) {
          if (Math.abs(g - here) > KEEP / 2 && Math.abs(g - there) > 2 && bitmaps.size > KEEP) { if (bm.close) bm.close(); bitmaps.delete(g); }
        });
      }
    }
    function nearest(ci, fi) {
      var base = offsets[ci], n = clips[ci].count;
      for (var d = 0; d < n; d++) {
        var a = fi - d >= 0 ? bitmaps.get(base + fi - d) : null, b = fi + d < n ? bitmaps.get(base + fi + d) : null;
        if (a) return a;
        if (b) return b;
      }
      return lastDrawn;
    }
    var queueClip = -1, lastDrawn = null;
    useSet(pickSet());

    // ---- renderer: WebGL with a luminance-keyed dither dissolve; 2D fallback ----
    var gl = canvas.getContext("webgl", { premultipliedAlpha: false, antialias: false });
    var R = gl ? glRenderer(gl) : null;
    var ctx2d = gl ? null : canvas.getContext("2d");
    var dpr = Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2);
    function sizeCanvas() {
      // Assigning width/height clears the canvas, so only when the size really changed.
      var w = Math.round((box.clientWidth || window.innerWidth) * dpr), h = Math.round((box.clientHeight || window.innerHeight) * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; dirty = true; }
    }
    function onResize() {
      var h = box.clientHeight || window.innerHeight;
      if (window.innerWidth === viewW && h === viewH) return; // address bar only: nothing moves
      var p = cur / total;
      var next = pickSet();
      if (next.clips !== clips) { useSet(next); queueClip = -1; wantDecode = true; }
      layout();
      sizeCanvas();
      window.scrollTo(0, p * trackMax());
      target = cur = p * total;
    }
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", function () { setTimeout(onResize, 120); });

    function cover(img, focusX) {
      var cw = canvas.width, ch = canvas.height, w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      var s = Math.max(cw / w, ch / h);
      var sx = cw / (w * s), sy = ch / (h * s);
      return { sx: sx, sy: sy, ox: (1 - sx) * focusX, oy: (1 - sy) * 0.5 };
    }

    // ---- state + loop ----
    var target = 0, cur = 0, last = performance.now(), dirty = true, lastKey = "", lastFi = -1, lastProg = -1;
    sizeCanvas();
    // Stable identity per decoded frame, for "did the picture change".
    var idOf = new WeakMap(), nextId = 1;
    function ids(x) { if (!x) return "-"; var v = idOf.get(x); if (!v) { v = nextId++; idOf.set(x, v); } return v; }
    // The track length is cached (set in layout()), so the scroll handler never forces a layout.
    // Overscroll (rubber-banding past either end on iOS) is clamped to the film's ends.
    function readScroll() {
      var max = trackMax();
      var y = Math.min(max, Math.max(0, window.scrollY));
      target = max > 0 ? (y / max) * total : 0;
    }
    window.addEventListener("scroll", readScroll, { passive: true });
    readScroll();
    cur = target;

    var els = copyEls();
    els.forEach(function (el) {
      var k = el.getAttribute("data-scene");
      if (k !== "finale" && !el.hasAttribute("data-in")) {
        var sc = site.scenes[+k];
        if (sc) el.setAttribute("data-in", String(sc.copyIn));
      }
      if (el.getAttribute("data-fx") === "fragments") splitChars(el);
    });

    function frameAt(t) {
      var seg = segs[segs.length - 1];
      for (var i = 0; i < segs.length; i++) if (t < segs[i].b) { seg = segs[i]; break; }
      var u = Math.min(1, Math.max(0, (t - seg.a) / (seg.b - seg.a)));
      var c = clips[seg.clip];
      if (seg.type === "clip") return { seg: seg, ci: seg.clip, fi: Math.round(u * (c.count - 1)), mix: 0 };
      if (seg.type === "hold") return { seg: seg, ci: seg.clip, fi: c.count - 1, mix: 0 };
      return { seg: seg, ci: seg.clip, fi: c.count - 1, ci2: seg.next, fi2: 0, mix: u };
    }

    function tick(now) {
      var dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      var k = 1 - Math.exp(-dt * 12);
      var before = cur;
      cur += (target - cur) * k;
      if (Math.abs(target - cur) < 0.0005) cur = target;
      if (cur !== before) heading = target > before ? 1 : -1;
      var f = frameAt(cur), dest = frameAt(target);
      // Downloads follow where the scroll is going (after a flick, that is far ahead of the picture).
      if (dest.ci !== queueClip) { queueClip = dest.ci; buildQueue(queueClip, heading); pump(); wantDecode = true; }
      if (f.fi !== lastFi) { lastFi = f.fi; wantDecode = true; }
      scheduleDecode(f.ci, f.fi, dest);
      if (f.mix > 0) decodeOne(f.ci2, f.fi2);
      var scene = site.scenes[f.seg.scene];
      var a = nearest(f.ci, f.fi);
      var b = f.mix > 0 ? nearest(f.ci2, f.fi2) : a;
      var key = ids(a) + "|" + ids(b) + "|" + f.mix.toFixed(3) + "|" + canvas.width + "x" + canvas.height;
      if (a && (dirty || key !== lastKey)) {
        lastDrawn = a;
        var drawnG = globalOf.get(a);
        st.drawn = drawnG === undefined ? -1 : drawnG;
        var focus = scene.focusX;
        if (f.mix > 0) focus = focus + (site.scenes[f.seg.scene + 1].focusX - focus) * f.mix;
        var cv = cover(a, mobile ? focus : 0.5);
        if (R) R.draw(a, b || a, f.mix, cv);
        else draw2d(a, b, f.mix, cv);
        lastKey = key;
        dirty = false;
        if (!marks.firstFrame) marks.firstFrame = performance.now();
        if (retired && bitmaps.has(drawnG)) { retired.forEach(function (bm) { if (bm.close) bm.close(); }); retired = null; }
      }
      updateCopy(cur);
      // Custom properties on the root restyle the whole page: only write visible changes.
      var prog = cur / total;
      if (Math.abs(prog - lastProg) >= 0.004 || (cur === target && prog !== lastProg)) { lastProg = prog; doc.style.setProperty("--progress", prog.toFixed(4)); }
      st.progress = prog;
      st.settled = cur === target;
      st.offsets = offsets;
      st.wanted = offsets[f.ci] + f.fi;
      st.frame = f.ci + ":" + f.fi + (f.mix ? "~" + f.ci2 + ":" + f.fi2 + "@" + f.mix.toFixed(2) : "");
      requestAnimationFrame(tick);
    }

    var activeScene = -1;
    function updateCopy(t) {
      var sceneIdx = 0;
      for (var i = 0; i < sceneSpan.length; i++) if (t >= sceneSpan[i].a) sceneIdx = i;
      if (sceneIdx !== activeScene) {
        activeScene = sceneIdx;
        setLabel(site.scenes[sceneIdx].label);
        doc.setAttribute("data-active-scene", String(sceneIdx));
      }
      var inFinale = t >= finaleStart;
      doc.classList.toggle("in-finale", inFinale);
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        var k = el.getAttribute("data-scene");
        var on;
        if (k === "finale") on = t >= finaleStart + 0.15;
        else {
          var sp = sceneSpan[+k];
          if (!sp) continue;
          var p = (t - sp.a) / (sp.b - sp.a);
          var pin = parseFloat(el.getAttribute("data-in") || "0");
          var pout = parseFloat(el.getAttribute("data-out") || "0.97");
          on = p >= pin && p < pout && !(inFinale && +k === site.scenes.length - 1 && el.getAttribute("data-keep") !== "true");
          var pv = Math.round(Math.min(1, Math.max(0, p)) * 250) / 250;
          if (el.__p !== pv) { el.__p = pv; el.style.setProperty("--p", pv.toFixed(3)); }
        }
        if (on !== el.classList.contains("is-active")) el.classList.toggle("is-active", on);
      }
    }

    function draw2d(a, b, mix, cv) {
      var w = a.naturalWidth || a.width, h = a.naturalHeight || a.height;
      ctx2d.globalAlpha = 1;
      ctx2d.drawImage(a, cv.ox * w, cv.oy * h, cv.sx * w, cv.sy * h, 0, 0, canvas.width, canvas.height);
      if (mix > 0 && b) {
        ctx2d.globalAlpha = mix;
        ctx2d.drawImage(b, cv.ox * w, cv.oy * h, cv.sx * w, cv.sy * h, 0, 0, canvas.width, canvas.height);
        ctx2d.globalAlpha = 1;
      }
    }

    var st = window.__stage = { progress: 0, settled: false, frame: "", drawn: -1, wanted: 0, offsets: offsets, total: total, segments: segs, scenes: sceneSpan, finaleStart: finaleStart, marks: marks,
      /** What the visitor's device got so far (read by the ?measure panel; nothing is sent anywhere). */
      info: function () {
        var decoded = 0;
        bitmaps.forEach(function (bm) { decoded += (bm.width || bm.naturalWidth || 0) * (bm.height || bm.naturalHeight || 0) * 4; });
        var held = 0;
        blobs.forEach(function (arr) { for (var i = 0; i < arr.length; i++) if (arr[i]) held += arr[i].size; });
        st.offsets = offsets;
        return { set: set.name, frameDir: clips[0].dir.replace(/\d+$/, "*"), thin: thin, phone: phone, fetchedBytes: fetchedBytes, fetchedFiles: fetchedFiles,
          decodedFrames: bitmaps.size, decodedBytes: decoded, heldBlobBytes: held, totalFrames: totalFrames, dpr: dpr, canvas: canvas.width + "x" + canvas.height };
      },
      /** Scroll so the stage shows timeline position t (in vh units). */
      seek: function (t) { window.scrollTo(0, (t / total) * trackMax()); readScroll(); st.settled = false; } };
    requestAnimationFrame(tick);
  }

  function setLabel(text) {
    var nodes = document.querySelectorAll("[data-section-label]");
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = text;
  }

  function splitChars(el) {
    if (el.getAttribute("data-split")) return;
    el.setAttribute("data-split", "1");
    el.setAttribute("aria-label", el.textContent.trim());
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    var texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    var n = 0;
    texts.forEach(function (node) {
      var frag = document.createDocumentFragment();
      node.textContent.split(/(\s+)/).forEach(function (word) {
        if (!word) return;
        if (/^\s+$/.test(word)) { frag.appendChild(document.createTextNode(word)); return; }
        var w = document.createElement("span");
        w.className = "w";
        w.setAttribute("aria-hidden", "true");
        for (var i = 0; i < word.length; i++) {
          var c = document.createElement("span");
          c.className = "ch";
          c.style.setProperty("--d", (Math.random() * 0.35 + n * 0.008).toFixed(3) + "s");
          c.textContent = word[i];
          w.appendChild(c);
          n++;
        }
        frag.appendChild(w);
      });
      node.parentNode.replaceChild(frag, node);
    });
  }

  function glRenderer(gl) {
    var vs = "attribute vec2 p;varying vec2 uv;void main(){uv=vec2(p.x*.5+.5,.5-p.y*.5);gl_Position=vec4(p,0.,1.);}";
    var fs = [
      "precision mediump float;varying vec2 uv;",
      "uniform sampler2D A,B;uniform float mixv;uniform vec4 cv;uniform float px;",
      "float hash(vec2 q){return fract(sin(dot(q,vec2(12.9898,78.233)))*43758.5453);}",
      "void main(){",
      " vec2 t=uv*cv.xy+cv.zw;",
      " vec4 a=texture2D(A,t);",
      " if(mixv<=0.){gl_FragColor=vec4(a.rgb,1.);return;}",
      " vec4 b=texture2D(B,t);",
      " float lum=dot(a.rgb,vec3(.299,.587,.114));",
      " float n=hash(floor(gl_FragCoord.xy/px));",
      // bright areas of the outgoing frame dissolve first (as in the reference reel)
      " float th=mix(n,1.-lum,.55)*.94+.03;",
      " float m=step(th,mixv);",
      " float edge=1.-smoothstep(0.,.022,abs(th-mixv));",
      " vec3 col=mix(a.rgb,b.rgb,m);",
      " col=mix(col,vec3(.97,.96,.93),edge*.6*(1.-mixv*mixv));",
      " gl_FragColor=vec4(col,1.);}",
    ].join("\n");
    function sh(type, srcText) {
      var s = gl.createShader(type);
      gl.shaderSource(s, srcText);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    var prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    function tex(unit) {
      var t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return t;
    }
    var tA = tex(0), tB = tex(1), onA = null, onB = null;
    gl.uniform1i(gl.getUniformLocation(prog, "A"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "B"), 1);
    var uMix = gl.getUniformLocation(prog, "mixv"), uCv = gl.getUniformLocation(prog, "cv"), uPx = gl.getUniformLocation(prog, "px");
    return {
      draw: function (a, b, mix, cv) {
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        if (onA !== a) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tA); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, a); onA = a; }
        if (mix > 0 && onB !== b) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tB); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, b); onB = b; }
        gl.uniform1f(uMix, mix);
        gl.uniform4f(uCv, cv.sx, cv.sy, cv.ox, cv.oy);
        gl.uniform1f(uPx, Math.max(1, Math.round(gl.drawingBufferWidth / 900)));
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      },
    };
  }
})();
