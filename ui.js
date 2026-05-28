/**
 * ui.js  — Sheet Image Preview (v11)
 *
 * New in v10:  READY-CELL INDICATOR
 *   A single position:fixed <canvas> overlay sits above the sheet (pointer-
 *   events:none so it never intercepts clicks).  Every ~200 ms it reads the
 *   live registry and draws a soft animated border around every cell whose
 *   image is registered and ready to click.
 *
 *   States painted per cell:
 *     READY   — solid teal border + faint teal fill + small camera icon top-right.
 *               Appears as soon as hook.js reports the image coordinates.
 *     HOVERED — brighter border + slightly more opaque fill, cursor zoom-in.
 *               Replaces READY when the mouse is inside that cell.
 *
 *   Nothing in Google Sheets is touched — the overlay is purely additive.
 *   pointer-events:none means Sheets receives every click, key, and scroll
 *   exactly as before.
 *
 *   The overlay canvas is cleared and redrawn on every tick so it
 *   automatically disappears for cells that have scrolled away (their
 *   registry entries are evicted by the scrollGen system from v9).
 */
(function () {
  if (window.__shpActive) return;
  window.__shpActive = true;

  /* ── constants ─────────────────────────────────────────────────── */
  var MIN_ZOOM = 0.1, MAX_ZOOM = 8, ZOOM_STEP = 0.12;
  var TTL             = 8000;   // TTL for a brand-new entry
  var TTL_SEEN        = 60000;  // Fix 2: once seen, keep alive 60s
  var HIT_INSET       = 2;
  var SCROLL_GRACE_MS = 120;

  // Fix 1: fast poll for 2s after scroll stops, normal otherwise
  var IND_TICK_NORMAL = 120;
  var IND_TICK_FAST   = 30;
  var IND_FAST_FOR_MS = 2000;
  var indInterval = IND_TICK_NORMAL;
  var _fastModeTimer = null;
  // Indicator visual constants
  var IND_RADIUS    = 4;
  var IND_BORDER    = 2;
  var IND_COLOR     = "rgba(0,188,180,0.90)";
  var IND_FILL      = "rgba(0,188,180,0.07)";
  var IND_HOV_COLOR = "rgba(0,220,210,1.00)";
  var IND_HOV_FILL  = "rgba(0,220,210,0.15)";
  var IND_ICON_SIZE = 13;

  /* ── state ──────────────────────────────────────────────────────── */
  var zoom = 1, rotation = 0, panX = 0, panY = 0;
  var dragging = false, dsx = 0, dsy = 0;
  var pinchStart = 0, pinchZoom = 1;
  var lastFocused = null;
  var currentImageSrc = "";
  var showOpenOriginalButton = true;
  var registry    = {};
  var lastDrawSeq = {};
  var modalOpen   = false;
  var scrollGen   = 0;
  var lastScrollTime = 0;
  var mouseX = -9999, mouseY = -9999;
  var _pendingHoverRedraw = false;
  // Runtime-configurable settings (populated from chrome.storage)
  var overlayEnabled = true;

  /* ── overlay interval manager (Fix 1) ──────────────────────────── */
  function setIndInterval(ms) {
    indInterval = ms;
  }

  /* ── scroll / resize invalidation ──────────────────────────────── */
  function bumpScroll() {
    scrollGen++;
    lastScrollTime = Date.now();
    Object.keys(registry).forEach(function (k) {
      if (registry[k].scrollGen !== scrollGen) delete registry[k];
    });
    // Fix 1: switch to fast poll immediately, schedule return to normal
    setIndInterval(IND_TICK_FAST);
    if (_fastModeTimer) clearTimeout(_fastModeTimer);
    _fastModeTimer = setTimeout(function () {
      setIndInterval(IND_TICK_NORMAL);
    }, IND_FAST_FOR_MS);
    if (overlayEnabled && !modalOpen) {
      try { redrawOverlay(); } catch (e) {}
    }
  }
  window.addEventListener("scroll", bumpScroll, true);
  window.addEventListener("resize", bumpScroll, true);
  window.addEventListener("wheel", function () {
    setTimeout(bumpScroll, 50);
  }, { passive: true, capture: true });

  /* ── message receiver ───────────────────────────────────────────── */
  window.addEventListener("message", function (ev) {
    // Security: accept only messages that look like ours and originate from
    // Google Docs / Google-hosted frames. This avoids accepting arbitrary
    // postMessage payloads from other sites.
    try {
      var origin = ev.origin || "";
      if (origin && origin.indexOf('.google.com') === -1 && origin.indexOf('docs.google.com') === -1) return;
    } catch (e) {
      return;
    }

    var d = ev.data;
    if (!d || !d.__shpImg) return;
    try { if (window.console && console.debug) console.debug('[shpUI] recv', d.src, Math.round(d.x||0), Math.round(d.y||0), Math.round(d.w||0), Math.round(d.h||0)); } catch (e) {}

    var fid = d.frameId || "?";
    var seq = d.drawSeq || 0;
    if (lastDrawSeq[fid] !== undefined && seq <= lastDrawSeq[fid]) return;
    lastDrawSeq[fid] = seq;

    var key = fid + ":" + Math.round(d.x) + "|" + Math.round(d.y);
    var existing = registry[key];
    if (existing) {
      existing.src       = d.src;
      existing.x         = d.x;
      existing.y         = d.y;
      existing.w         = d.w;
      existing.h         = d.h;
      existing.ts        = Date.now();
      existing.scrollGen = scrollGen;
    } else {
      registry[key] = {
        src: d.src,
        x: d.x,
        y: d.y,
        w: d.w,
        h: d.h,
        ts: Date.now(),
        scrollGen: scrollGen,
        seen: false   // Fix 2: promoted to true on first hitTest match
      };
    }

    if (overlayEnabled && !modalOpen) {
      try { redrawOverlay(); } catch (e) {}
    }
  });

  /* ── registry helpers ─────────────────────────────────────────────── */
  function getEntries() {
    var now = Date.now();
    var out = [];
    Object.keys(registry).forEach(function (k) {
      var e = registry[k];
      var ttl = e.seen ? TTL_SEEN : TTL;
      if (now - e.ts > ttl) { delete registry[k]; return; }
      if (e.scrollGen !== scrollGen) {
        if (now - lastScrollTime > SCROLL_GRACE_MS) { delete registry[k]; return; }
      }
      out.push(e);
    });
    return out;
  }

  function hitTest(cx, cy) {
    var best = null, bestArea = Infinity;
    getEntries().forEach(function (e) {
      if (cx >= e.x + HIT_INSET && cx <= e.x + e.w - HIT_INSET &&
          cy >= e.y + HIT_INSET && cy <= e.y + e.h - HIT_INSET) {
        var a = e.w * e.h;
        if (a < bestArea) { bestArea = a; best = e; }
      }
    });
    // Fix 2: first time the cursor is over this entry, promote it
    if (best && !best.seen) { best.seen = true; }
    return best;
  }

  /* ── OVERLAY CANVAS ─────────────────────────────────────────────── */
  var oc = document.createElement("canvas");
  oc.id = "shp-overlay";
  oc.style.cssText =
    "position:fixed;inset:0;width:100%;height:100%;" +
    "pointer-events:none;z-index:2147483640;";
  document.body.appendChild(oc);
  var octx = oc.getContext("2d");

  // React to runtime settings stored in chrome.storage
  try {
    if (chrome && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get({ overlayEnabled: true, ttl: TTL, ttlSeen: TTL_SEEN, iconSize: IND_ICON_SIZE, showOpenOriginalButton: true }, function (items) {
        overlayEnabled = items.overlayEnabled !== false;
        TTL = items.ttl || TTL;
        TTL_SEEN = items.ttlSeen || TTL_SEEN;
        IND_ICON_SIZE = items.iconSize || IND_ICON_SIZE;
        showOpenOriginalButton = items.showOpenOriginalButton !== false;
        oc.style.display = overlayEnabled ? 'block' : 'none';
      });
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'sync') return;
        if (changes.overlayEnabled) {
          overlayEnabled = changes.overlayEnabled.newValue;
          oc.style.display = overlayEnabled ? 'block' : 'none';
        }
        if (changes.ttl) TTL = changes.ttl.newValue || TTL;
        if (changes.ttlSeen) TTL_SEEN = changes.ttlSeen.newValue || TTL_SEEN;
        if (changes.iconSize) IND_ICON_SIZE = changes.iconSize.newValue || IND_ICON_SIZE;
        if (changes.showOpenOriginalButton) {
          showOpenOriginalButton = changes.showOpenOriginalButton.newValue;
          if (openOriginalBtn) {
            openOriginalBtn.style.display = showOpenOriginalButton ? '' : 'none';
          }
        }
      });
    }
  } catch (e) {}

  // Listen for extension messages (e.g. toggleOverlay command)
  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (msg && msg.cmd === 'toggleOverlay') {
        overlayEnabled = !overlayEnabled;
        oc.style.display = overlayEnabled ? 'block' : 'none';
        sendResponse && sendResponse({ overlayEnabled: overlayEnabled });
      }
    });
  } catch (e) {}

  function resizeOverlay() {
    oc.width  = window.innerWidth;
    oc.height = window.innerHeight;
  }
  resizeOverlay();
  window.addEventListener("resize", resizeOverlay);

  /* Small camera icon drawn with canvas primitives */
  function drawCameraIcon(ctx, cx, cy, size, color) {
    var s = size;
    ctx.save();
    ctx.translate(cx - s / 2, cy - s / 2);
    // Body
    ctx.fillStyle = color;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(0, s * 0.28, s, s * 0.65, s * 0.15);
    } else {
      ctx.rect(0, s * 0.28, s, s * 0.65);
    }
    ctx.fill();
    // Lens
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.62, s * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fill();
    // Viewfinder bump
    ctx.fillStyle = color;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(s * 0.3, s * 0.12, s * 0.4, s * 0.2, s * 0.08);
    } else {
      ctx.rect(s * 0.3, s * 0.12, s * 0.4, s * 0.2);
    }
    ctx.fill();
    ctx.restore();
  }

  function redrawOverlay() {
    var W = oc.width, H = oc.height;
    octx.clearRect(0, 0, W, H);
    if (!overlayEnabled) return;
    if (modalOpen && !(errDiv && errDiv.style.display === 'flex')) return;

    var entries = getEntries();

    // Fix 4: draw ghost outlines for seen entries that are within the grace
    // window — they were known before the scroll and are reloading.
    // This gives users immediate visual feedback instead of a blank wait.
    var now = Date.now();
    var inGrace = (now - lastScrollTime) <= SCROLL_GRACE_MS + 800;
    if (inGrace) {
      Object.keys(registry).forEach(function (k) {
        var e = registry[k];
        if (!e.seen) return;                        // only previously confirmed cells
        if (e.scrollGen === scrollGen) return;       // already showing teal, skip
        var x  = Math.max(0, Math.round(e.x));
        var y  = Math.max(0, Math.round(e.y));
        var x2 = Math.min(W, Math.round(e.x + e.w));
        var y2 = Math.min(H, Math.round(e.y + e.h));
        if (x2 - x < 6 || y2 - y < 6) return;
        octx.fillStyle   = IND_WAIT_FILL;
        octx.strokeStyle = IND_WAIT_COLOR;
        octx.lineWidth   = 1;
        octx.setLineDash([4, 3]);
        octx.beginPath();
        if (octx.roundRect) { octx.roundRect(x, y, x2 - x, y2 - y, IND_RADIUS); }
        else                 { octx.rect(x, y, x2 - x, y2 - y); }
        octx.fill();
        octx.stroke();
        octx.setLineDash([]);
      });
    }

    if (!entries.length) return;

    var hovered = hitTest(mouseX, mouseY);

    entries.forEach(function (e) {
      if (!e.seen) { e.seen = true; }  // Fix 2: promote on first render
      var isHov  = hovered && hovered === e;
      var bColor = isHov ? IND_HOV_COLOR : IND_COLOR;
      var fColor = isHov ? IND_HOV_FILL  : IND_FILL;

      // Clip rect to viewport
      var x  = Math.max(0, Math.round(e.x));
      var y  = Math.max(0, Math.round(e.y));
      var x2 = Math.min(W, Math.round(e.x + e.w));
      var y2 = Math.min(H, Math.round(e.y + e.h));
      if (x2 - x < 6 || y2 - y < 6) return;

      var r  = IND_RADIUS;
      var bh = IND_BORDER / 2;

      // Faint fill
      octx.fillStyle = fColor;
      octx.beginPath();
      if (octx.roundRect) {
        octx.roundRect(x, y, x2 - x, y2 - y, r);
      } else {
        octx.rect(x, y, x2 - x, y2 - y);
      }
      octx.fill();

      // Border
      octx.strokeStyle = bColor;
      octx.lineWidth   = IND_BORDER;
      octx.beginPath();
      if (octx.roundRect) {
        octx.roundRect(x + bh, y + bh, x2 - x - IND_BORDER, y2 - y - IND_BORDER, r);
      } else {
        octx.rect(x + bh, y + bh, x2 - x - IND_BORDER, y2 - y - IND_BORDER);
      }
      octx.stroke();

      // Camera icon — top-right, only if room
      var iconCX = x2 - IND_ICON_SIZE / 2 - 5;
      var iconCY = y  + IND_ICON_SIZE / 2 + 3;
      if (iconCX - IND_ICON_SIZE / 2 > x + 4) {
        drawCameraIcon(octx, iconCX, iconCY, IND_ICON_SIZE, bColor);
      }
    });
  }

  // Fix 4: ghost outline color for cells not yet registered
  var IND_WAIT_COLOR = "rgba(180,180,180,0.35)";
  var IND_WAIT_FILL  = "rgba(180,180,180,0.04)";

  // Kick off the requestAnimationFrame loop which respects `indInterval`.
  var _lastRaf = 0;
  function _rafLoop(ts) {
    if (!_lastRaf) _lastRaf = ts;
    var elapsed = ts - _lastRaf;
    if (elapsed >= indInterval || _pendingHoverRedraw) {
      try { redrawOverlay(); } catch (e) {}
      _pendingHoverRedraw = false;
      _lastRaf = ts;
    }
    // Pause updates when document is hidden to save cycles
    if (document.visibilityState === 'visible') requestAnimationFrame(_rafLoop);
    else _lastRaf = 0;
  }
  requestAnimationFrame(_rafLoop);

  /* ── DOM / styles ───────────────────────────────────────────────── */
  var style = document.createElement("style");
  style.textContent =
    "#shp-bd{display:none;position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.85);align-items:center;justify-content:center;opacity:0;transition:opacity .2s}" +
    "#shp-bd.on{opacity:1}" +
    "#shp-card{display:flex;flex-direction:column;background:#1e1e1e;border-radius:12px;box-shadow:0 8px 48px rgba(0,0,0,.8);overflow:hidden;max-width:92vw;max-height:92vh}" +
    "#shp-tb{display:flex;align-items:center;gap:4px;padding:8px 10px;background:#2a2a2a;border-bottom:1px solid #333}" +
    ".shp-b{background:#3a3a3a;color:#e0e0e0;border:none;border-radius:6px;padding:5px 10px;font-size:15px;cursor:pointer}" +
    ".shp-b:hover{background:#505050}" +
    "#shp-zb{color:#aaa;font-size:12px;min-width:42px;text-align:center;font-family:monospace}" +
    "#shp-dv{width:1px;height:20px;background:#444;margin:0 4px}" +
    "#shp-x{background:transparent;color:#aaa;border:none;font-size:18px;cursor:pointer;padding:4px 8px;border-radius:6px;margin-left:auto}" +
    "#shp-x:hover{background:#c0392b;color:#fff}" +
    "#shp-wrap{position:relative;flex:1;overflow:hidden;display:flex;align-items:center;justify-content:center;min-width:300px;min-height:300px;cursor:grab}" +
    "#shp-wrap.drag{cursor:grabbing}" +
    "#shp-img{max-width:80vw;max-height:75vh;object-fit:contain;transition:opacity .15s,transform .08s linear;pointer-events:none}" +
    "#shp-spin{position:absolute;width:36px;height:36px;border:3px solid #555;border-top-color:#fff;border-radius:50%;animation:shp-spin .7s linear infinite}" +
    "@keyframes shp-spin{to{transform:rotate(360deg)}}" +
    "#shp-err{display:none;position:absolute;flex-direction:column;align-items:center;gap:12px;color:#aaa;font-size:13px;font-family:sans-serif;text-align:center;padding:24px}" +
    "#shp-err button{background:#3a3a3a;color:#e0e0e0;border:none;border-radius:6px;padding:7px 16px;font-size:13px;cursor:pointer}" +
    "#shp-err button:hover{background:#505050}" +
    ".shp-badge{position:absolute;top:-6px;right:-6px;border-radius:999px;background:#0ff;color:#000;padding:2px 6px;font-size:10px;font-weight:700;opacity:0;transform:scale(0.85);transition:opacity .15s,transform .15s;pointer-events:none;}" +
    ".shp-badge.on{opacity:1;transform:scale(1);}" +
    "#shp-toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%) translateY(20px);padding:10px 16px;background:rgba(0,0,0,0.86);color:#fff;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,0.35);font-size:13px;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:2147483648;}" +
    "#shp-toast.on{opacity:1;transform:translateX(-50%) translateY(0);}" +
    "#shp-hint{padding:6px 12px;font-size:11px;color:#555;text-align:center;background:#1a1a1a}" +
    "#shp-hint kbd{background:#333;color:#aaa;border-radius:3px;padding:1px 5px;font-size:10px}";
  document.head.appendChild(style);

  var bd   = document.createElement("div"); bd.id   = "shp-bd"; bd.setAttribute("role", "presentation"); bd.setAttribute("aria-hidden", "true");
  var card = document.createElement("div"); card.id = "shp-card"; card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-label", "Sheet image preview"); card.tabIndex = -1;
  var tb   = document.createElement("div"); tb.id   = "shp-tb";
  var wrap = document.createElement("div"); wrap.id = "shp-wrap"; wrap.setAttribute("aria-label", "Image preview area"); wrap.tabIndex = 0;
  var spin = document.createElement("div"); spin.id = "shp-spin";
  var img  = document.createElement("img"); img.id  = "shp-img"; img.draggable = false;
  var zb   = document.createElement("div"); zb.id   = "shp-zb"; zb.textContent = "100%";
  var hint = document.createElement("div"); hint.id = "shp-hint";
  hint.innerHTML =
    "<kbd>Scroll</kbd> zoom &nbsp;&#183;&nbsp; <kbd>Q/E</kbd> rotate &nbsp;&#183;&nbsp;" +
    " <kbd>Drag</kbd> pan &nbsp;&#183;&nbsp; <kbd>Esc</kbd> close";

  var errDiv = document.createElement("div"); errDiv.id = "shp-err";
  errDiv.innerHTML =
    "<span>&#9888; Image could not be loaded.</span>" +
    "<button id='shp-err-open'>Open in new tab</button>" +
    "<button id='shp-err-close'>Close</button>";
  var toast = document.createElement("div"); toast.id = "shp-toast";
  document.body.appendChild(toast);

  function mkB(ic, tip, fn) {
    var b = document.createElement("button"); b.className = "shp-b";
    b.type = "button";
    b.innerHTML = ic; b.title = tip;
    b.setAttribute("aria-label", tip);
    b.addEventListener("click", fn);
    b.addEventListener("mousedown", function (e) { e.stopPropagation(); });
    return b;
  }
  function dv() { var d = document.createElement("div"); d.id = "shp-dv"; return d; }

  var xb = document.createElement("button"); xb.id = "shp-x"; xb.type = "button"; xb.innerHTML = "&#x2715;";
  xb.setAttribute("aria-label", "Close preview");
  xb.addEventListener("click", function () { closeModal(); });

  function getModalFocusables() {
    return Array.prototype.slice.call(card.querySelectorAll("button"));
  }
  function trapModalFocus(e) {
    var items = getModalFocusables();
    if (!items.length) return;
    var idx = items.indexOf(document.activeElement);
    if (idx === -1) idx = 0;
    idx = (idx + (e.shiftKey ? -1 : 1) + items.length) % items.length;
    items[idx].focus();
    e.preventDefault();
  }
  function touchDistance(touches) {
    var dx = touches[0].clientX - touches[1].clientX;
    var dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  tb.appendChild(mkB("&#8634;",  "Q - rotate left",  function () { rot(-90); }));
  tb.appendChild(mkB("&#8635;",  "E - rotate right", function () { rot(90);  }));
  tb.appendChild(dv());
  tb.appendChild(mkB("&#8722;",  "Zoom out",  function () { dz(-ZOOM_STEP); }));
  tb.appendChild(zb);
  tb.appendChild(mkB("+",        "Zoom in",   function () { dz(ZOOM_STEP);  }));
  tb.appendChild(mkB("&#9673;",  "Reset",     function () { reset();        }));
  tb.appendChild(dv());
  var openOriginalBtn = mkB("&#128279;", "Open original image", function () { openOriginal(); });
  openOriginalBtn.style.display = showOpenOriginalButton ? '' : 'none';
  tb.appendChild(openOriginalBtn);
  var copyBtn = mkB("&#128203;", "Copy image URL", function () { copyImageUrl(); });
  var copyBadge = document.createElement("span");
  copyBadge.className = "shp-badge";
  copyBadge.textContent = "Copied";
  copyBtn.style.position = "relative";
  copyBtn.appendChild(copyBadge);
  tb.appendChild(copyBtn);
  tb.appendChild(mkB("&#11015;", "Download",  function () { dlImg();        }));
  tb.appendChild(xb);

  /* ── image load / error ─────────────────────────────────────────── */
  img.addEventListener("load", function () {
    spin.style.display   = "none";
    errDiv.style.display = "none";
    img.style.opacity    = "1";
  });
  img.addEventListener("error", function () {
    spin.style.display   = "none";
    img.style.opacity    = "0";

    // Attempt an authenticated fetch as a fallback for images that require cookies/auth
    if (!img._fetchAttempted && currentImageSrc && typeof currentImageSrc === 'string' && currentImageSrc.indexOf('http') === 0) {
      img._fetchAttempted = true;
      try {
        fetch(currentImageSrc, { credentials: 'include', mode: 'cors' }).then(function (resp) {
          if (!resp.ok) throw new Error('fetch failed ' + resp.status);
          return resp.blob();
        }).then(function (blob) {
          var obj = URL.createObjectURL(blob);
          img.src = obj;
          showToast('Loaded preview via authenticated fetch.');
          return;
        }).catch(function () {
          // fall through to show error UI below
        });
      } catch (e) {}
    }

    errDiv.style.display = "flex";
    var openBtn  = document.getElementById("shp-err-open");
    var closeBtn = document.getElementById("shp-err-close");
    var ob2 = openBtn.cloneNode(true);
    var cb2 = closeBtn.cloneNode(true);
    openBtn.parentNode.replaceChild(ob2, openBtn);
    closeBtn.parentNode.replaceChild(cb2, closeBtn);
    ob2.addEventListener("click", function () {
      openOriginal();
      closeModal();
    });
    cb2.addEventListener("click", function () { closeModal(); });
    showToast("Unable to load preview. You can open the original image.");
  });

  /* ── drag / pan ─────────────────────────────────────────────────── */
  wrap.addEventListener("mousedown", function (e) {
    if (e.button !== 0) return;
    dragging = true; dsx = e.clientX - panX; dsy = e.clientY - panY;
    wrap.classList.add("drag"); e.preventDefault();
  });
  wrap.addEventListener("dblclick", function () { reset(); });
  wrap.addEventListener("touchstart", function (e) {
    if (!modalOpen || !e.touches.length) return;
    if (e.touches.length === 1) {
      dragging = true;
      dsx = e.touches[0].clientX - panX;
      dsy = e.touches[0].clientY - panY;
    } else if (e.touches.length === 2) {
      pinchStart = touchDistance(e.touches);
      pinchZoom = zoom;
    }
    e.preventDefault();
  }, { passive: false });
  wrap.addEventListener("touchmove", function (e) {
    if (!modalOpen) return;
    if (e.touches.length === 1 && dragging) {
      panX = e.touches[0].clientX - dsx;
      panY = e.touches[0].clientY - dsy;
      applyT();
    } else if (e.touches.length === 2 && pinchStart) {
      var dist = touchDistance(e.touches);
      zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinchZoom * dist / pinchStart));
      applyT();
    }
    e.preventDefault();
  }, { passive: false });
  wrap.addEventListener("touchend", function (e) {
    if (!e.touches.length) dragging = false;
    if (e.touches.length < 2) pinchStart = 0;
  });

  // Hover pan — how many px the image travels at the edge of the wrap
  var HOVER_PAN_STRENGTH = 40;
  var hoverPanning = false;  // true while mouse is inside wrap and modal is open

  wrap.addEventListener("mouseenter", function () { if (modalOpen && !dragging) hoverPanning = true;  });
  wrap.addEventListener("mouseleave", function () {
    hoverPanning = false;
    // Ease back to centre when cursor leaves the viewer
    if (modalOpen && !dragging) { panX = 0; panY = 0; applyT(); }
  });

  document.addEventListener("mousemove", function (e) {
    mouseX = e.clientX; mouseY = e.clientY;
    if (dragging) {
      panX = e.clientX - dsx; panY = e.clientY - dsy; applyT();
    } else if (modalOpen && hoverPanning) {
      // Map cursor position within wrap to a pan offset
      var wr = wrap.getBoundingClientRect();
      var relX = (e.clientX - wr.left)  / wr.width  - 0.5;  // -0.5 .. +0.5
      var relY = (e.clientY - wr.top)   / wr.height - 0.5;
      panX = relX * HOVER_PAN_STRENGTH * zoom;
      panY = relY * HOVER_PAN_STRENGTH * zoom;
      applyT();
    } else if (!modalOpen) {
      var hit = hitTest(e.clientX, e.clientY);
      if (hit) { hit.ts = Date.now(); }
      document.body.style.cursor = hit ? "zoom-in" : "";
      if (overlayEnabled) {
        _pendingHoverRedraw = true;
      }
    }
  });
  document.addEventListener("mouseup", function () {
    dragging = false; wrap.classList.remove("drag");
  });

  /* ── assemble DOM ───────────────────────────────────────────────── */
  wrap.appendChild(spin);
  wrap.appendChild(img);
  wrap.appendChild(errDiv);
  card.appendChild(tb);
  card.appendChild(wrap);
  card.appendChild(hint);
  bd.appendChild(card);
  document.body.appendChild(bd);

  bd.addEventListener("mousedown",   function (e) { if (e.target === bd) closeModal(); });
  card.addEventListener("mousedown", function (e) { e.stopPropagation(); });

  /* ── wheel zoom ─────────────────────────────────────────────────── */
  wrap.addEventListener("wheel", function (e) {
    e.preventDefault(); e.stopPropagation();
    dz(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  }, { passive: false });
  bd.addEventListener("wheel", function (e) {
    e.preventDefault(); e.stopPropagation();
    dz(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  }, { passive: false });

  /* ── keyboard ───────────────────────────────────────────────────── */
  document.addEventListener("keydown", function (e) {
    if (!modalOpen) return;
    if (e.key === "Tab") {
      trapModalFocus(e);
      return;
    }
    var map = {
      "q": function () { rot(-90); }, "ArrowLeft":  function () { rot(-90); },
      "e": function () { rot(90);  }, "ArrowRight": function () { rot(90);  }
    };
    map["+"] = map["="] = function () { dz(ZOOM_STEP);  };
    map["-"]            = function () { dz(-ZOOM_STEP); };
    map["0"]            = function () { reset();        };
    map["Escape"]       = function () { closeModal();   };
    if (map[e.key]) { map[e.key](); e.preventDefault(); e.stopPropagation(); }
  }, { capture: true });

  /* ── click to open ──────────────────────────────────────────────── */
  document.addEventListener("mousedown", function (e) {
    if (modalOpen) return;
    var hit = hitTest(e.clientX, e.clientY);
    if (!hit) return;
    e.stopPropagation(); e.preventDefault();
    openModal(hit.src);
  }, { capture: true });

  /* ── modal open / close ─────────────────────────────────────────── */
  function openModal(src) {
    lastFocused = document.activeElement;
    currentImageSrc = src || "";
    modalOpen = true;
    zoom = 1; rotation = 0; panX = 0; panY = 0; applyT();
    img.style.opacity    = "0";
    spin.style.display   = "block";
    errDiv.style.display = "none";
    img.src = src;
    bd.style.display = "flex";
    bd.setAttribute("aria-hidden", "false");
    requestAnimationFrame(function () { bd.classList.add("on"); xb.focus(); });
    redrawOverlay();
  }
  function closeModal() {
    hoverPanning = false;
    modalOpen = false;
    bd.classList.remove("on");
    bd.setAttribute("aria-hidden", "true");
    setTimeout(function () {
      bd.style.display = "none";
      document.body.style.cursor = "";
      img.src = "";
      errDiv.style.display = "none";
      currentImageSrc = "";
      if (lastFocused && lastFocused.focus) { lastFocused.focus(); }
      lastFocused = null;
    }, 230);
  }

  /* ── transform helpers ──────────────────────────────────────────── */
  function applyT() {
    img.style.transform =
      "rotate(" + rotation + "deg) scale(" + zoom + ") " +
      "translate(" + (panX / zoom) + "px," + (panY / zoom) + "px)";
    zb.textContent = Math.round(zoom * 100) + "%";
  }
  function dz(d) { zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom + d * zoom)); applyT(); }
  function rot(deg) { rotation = (rotation + deg + 360) % 360; applyT(); }
  function reset() { zoom = 1; rotation = 0; panX = 0; panY = 0; applyT(); }
  function getFilenameFromUrl(url) {
    try {
      var parsed = new URL(url, window.location.href);
      var pathname = parsed.pathname || "";
      var name = pathname.split("/").filter(Boolean).pop() || "image";
      name = decodeURIComponent(name.replace(/\+/g, " "));
      if (!/\.[a-zA-Z0-9]{1,6}$/.test(name)) {
        name += ".png";
      }
      return name;
    } catch (e) {
      return "image.png";
    }
  }

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("on");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () {
      toast.classList.remove("on");
    }, 1800);
  }

  function showCopyBadge() {
    if (!copyBadge) return;
    copyBadge.classList.add("on");
    clearTimeout(copyBadge._timer);
    copyBadge._timer = setTimeout(function () {
      copyBadge.classList.remove("on");
    }, 1400);
  }

  function copyImageUrl() {
    if (!currentImageSrc) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(currentImageSrc).then(function () {
        showToast("Image URL copied to clipboard.");
        showCopyBadge();
      }).catch(function () {
        prompt("Copy image URL:", currentImageSrc);
        showToast("Copy URL opened in prompt.");
      });
    } else {
      prompt("Copy image URL:", currentImageSrc);
      showToast("Copy URL opened in prompt.");
    }
  }

  function openOriginal() {
    if (!currentImageSrc) return;
    window.open(currentImageSrc, "_blank", "noopener,noreferrer");
    showToast("Opening the original image.");
  }

  function dlImg() {
    if (!img.src) return;
    var a = document.createElement("a");
    a.href = img.src;
    a.download = getFilenameFromUrl(img.src);
    a.target = "_blank";
    a.click();
  }
})();