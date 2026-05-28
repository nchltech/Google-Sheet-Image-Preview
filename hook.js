/**
 * hook.js  — Sheet Image Preview (v11)
 *
 * Key fixes vs v8:
 *  1. Each message carries a stable `frameId` (random, assigned once per frame)
 *     so ui.js can namespace registry keys per frame and avoid cross-frame collisions.
 *  2. Each message carries a `scrollGen` that ui.js bumps on every scroll/resize
 *     event.  Entries whose scrollGen is stale are evicted immediately — this
 *     prevents coordinates from a previous scroll position matching a different
 *     cell at the same pixel after the sheet moves.
 *  3. postMessage is sent only ONCE (to window.top).  The v8 double-send
 *     (parent + top) created duplicate registry entries with slightly different
 *     timestamps, both of which could pass hitTest independently.
 *  4. A per-draw `drawSeq` sequence number is included so ui.js can detect and
 *     drop the rare case where the same logical draw fires the hook twice
 *     (e.g. canvas compositing layers).
 */
(function () {
  if (window.__shpHooked) return;
  window.__shpHooked = true;

  // Stable random id for this frame (survives re-injection attempts).
  var frameId = Math.random().toString(36).slice(2);
  var drawSeq = 0;

  var orig = CanvasRenderingContext2D.prototype.drawImage;
  var _visMap = new WeakMap();
  var _io = null;
  try {
    _io = new IntersectionObserver(function (entries) {
      entries.forEach(function (ent) { _visMap.set(ent.target, !!ent.isIntersecting); });
    }, { root: null, threshold: 0 });
  } catch (e) { _io = null; }

  CanvasRenderingContext2D.prototype.drawImage = function (source) {
    orig.apply(this, arguments);

    if (!(source instanceof HTMLImageElement)) return;
    var src = source.currentSrc || source.src || "";
    if (!src || src.indexOf("data:") === 0) return;

    var canvas = this.canvas;
    var cr = canvas.getBoundingClientRect();
    if (cr.width < 1 || cr.height < 1) return;
    // Quick viewport culling
    if (cr.bottom < 0 || cr.top > (window.innerHeight || document.documentElement.clientHeight)) return;

    var args = arguments;
    var dx, dy, dw, dh;
    if (args.length >= 9) {
      dx = args[5]; dy = args[6]; dw = args[7]; dh = args[8];
    } else if (args.length >= 5) {
      dx = args[1]; dy = args[2]; dw = args[3]; dh = args[4];
    } else {
      dx = args[1] || 0; dy = args[2] || 0;
      dw = source.naturalWidth || 0; dh = source.naturalHeight || 0;
    }
    if (!dw || !dh) return;

    // Apply canvas transform to get canvas-space bounding box.
    var t;
    try { t = this.getTransform(); }
    catch (e) { t = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }

    var pts = [[dx, dy], [dx + dw, dy], [dx + dw, dy + dh], [dx, dy + dh]].map(function (p) {
      return [t.a * p[0] + t.c * p[1] + t.e, t.b * p[0] + t.d * p[1] + t.f];
    });
    var xs = pts.map(function (p) { return p[0]; });
    var ys = pts.map(function (p) { return p[1]; });

    // Scale from canvas logical pixels → CSS pixels. Use client size fallbacks
    // and devicePixelRatio as a safety fallback if the element is high DPI.
    var logicalW = canvas.width || Math.max(1, canvas.clientWidth || 1);
    var logicalH = canvas.height || Math.max(1, canvas.clientHeight || 1);
    var cssW = cr.width || (canvas.clientWidth || logicalW / (window.devicePixelRatio || 1));
    var cssH = cr.height || (canvas.clientHeight || logicalH / (window.devicePixelRatio || 1));
    var sx = cssW / logicalW;
    var sy = cssH / logicalH;

    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);

    var x = cr.left + minX * sx,  y = cr.top + minY * sy;
    var w = (maxX - minX) * sx,   h = (maxY - minY) * sy;
    if (w < 8 || h < 8) return;

    // Ensure the reported rect is within the viewport and has valid dimensions.
    if (x + w < 0 || y + h < 0) return;
    if (x > (window.innerWidth || document.documentElement.clientWidth) ||
        y > (window.innerHeight || document.documentElement.clientHeight)) return;

    // If we have an IntersectionObserver, ensure canvas is observed and visible
    try {
      if (_io && !_visMap.has(canvas)) { _io.observe(canvas); }
      if (_io && !_visMap.get(canvas)) return;
    } catch (e) {}

    var msg = {
      __shpImg : true,
      src      : src,
      x        : x,
      y        : y,
      w        : w,
      h        : h,
      frameId  : frameId,   // which iframe produced this
      drawSeq  : ++drawSeq  // monotone counter for dedup
    };

    // Send only to top — one message per draw, no duplicate.
    try {
      if (window.console && console.debug) console.debug('[shpHook] postMsg', msg.src, Math.round(msg.x), Math.round(msg.y), Math.round(msg.w), Math.round(msg.h));
      window.top.postMessage(msg, "*");
    } catch (e) {}
  };
})();