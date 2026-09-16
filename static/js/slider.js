/* ============================================================================
 * PG supplementary site — RGB <-> depth comparison slider.
 * Vendored, dependency-free, no network. Offline-safe. (cf. pg.js/pipeline.js)
 *
 * Auto-initialises every element with class="pg-slider". Each instance is
 * configured ENTIRELY by data-* attributes (the contract the integrate step
 * uses — see the header block in this file and the returned `api`). The
 * component never reads the page beyond its own root, and writes no globals.
 *
 * TWO modes in ONE component, picked at runtime:
 *   STATIC  two stacked <img> (RGB under, colorized depth over); a draggable
 *           vertical divider clips the top image.
 *   VIDEO   two frame-synced <video> (RGB under, depth over) under one shared
 *           controller (single play loop; both kept aligned, re-synced on loop);
 *           the same draggable divider clips the top video while BOTH play.
 *
 * GRACEFUL DEGRADATION — the page must never break:
 *   - if prefers-reduced-motion is set, OR
 *   - if no video basename is supplied, OR
 *   - if the video element errors / cannot load,
 *   the instance falls back to the STATIC slider. Both DOM layers are built
 *   (when assets are given) and the live one is chosen by [data-mode] on root.
 *
 * The divider is a single custom property --rev (0..100) = percent revealed
 * from the RIGHT edge. clip-path: inset(0 var(--rev)% 0 0) on the over media.
 *
 * Performance: instances below the fold are built lazily (IntersectionObserver);
 * width/height + aspect-ratio are set so the box reserves height before media
 * decode (no layout shift); videos are preload=metadata and only created when
 * the instance enters view.
 *
 * ---------------------------------------------------------------------------
 * DATA-ATTRIBUTE CONTRACT (set on the class="pg-slider" element)
 *
 *   data-base        (string, required) directory + basename PREFIX for assets,
 *                    WITHOUT extension. The component appends extensions:
 *                      STATIC:  "<base>_rgb.<ext>"  and  "<base>_depth.<ext>"
 *                      VIDEO :  "<base>_rgb.webm|.mp4" and "<base>_depth.webm|.mp4"
 *                    e.g. data-base="static/images/scene" ->
 *                         static/images/scene_rgb.png / scene_depth.png
 *                    (Use data-rgb-src / data-depth-src to override exactly.)
 *
 *   data-rgb-src     (string, optional) explicit URL for the UNDER (RGB) still,
 *                    overrides "<base>_rgb.<img-ext>".
 *   data-depth-src   (string, optional) explicit URL for the OVER (depth) still,
 *                    overrides "<base>_depth.<img-ext>".
 *   data-img-ext     (string, optional, default "png") still extension used with
 *                    data-base, e.g. "jpg".
 *
 *   data-video       (string, optional) basename PREFIX for the video pair,
 *                    WITHOUT extension. If absent (or reduced-motion / failure),
 *                    the instance stays STATIC. The component builds two <source>
 *                    per video, webm THEN mp4:
 *                      "<data-video>_rgb.webm",  "<data-video>_rgb.mp4"
 *                      "<data-video>_depth.webm","<data-video>_depth.mp4"
 *   data-video-rgb   (string, optional) explicit basename for the RGB video
 *                    (without extension); overrides "<data-video>_rgb".
 *   data-video-depth (string, optional) explicit basename for the depth video
 *                    (without extension); overrides "<data-video>_depth".
 *   data-poster      (string, optional) poster image for the videos
 *                    (defaults to the RGB still).
 *
 *   data-label-rgb   (string, optional, default "RGB") under-layer corner label.
 *   data-label-depth (string, optional, default "Raw depth") over-layer label.
 *   data-cam         (string, optional) camera name; if given and data-label-depth
 *                    is NOT, the depth label becomes "Raw depth (<cam>)".
 *
 *   data-start       (number, optional, default 50) initial % revealed (0..100).
 *   data-aspect      (string, optional, default "1/1") CSS aspect-ratio, e.g.
 *                    "16/9" or "4/3"; reserves height to avoid layout shift.
 *   data-width       (number, optional) intrinsic px width for the <img> width
 *                    attr; data-height the height. Defaults derived from aspect
 *                    when omitted (purely advisory — aspect-ratio governs box).
 *   data-alt-rgb / data-alt-depth (string, optional) alt text for the stills.
 *
 * The component is idempotent: re-running init() never double-builds an instance
 * (guarded by a data-flag). Returned text from this file IS the contract.
 * ========================================================================== */
(function () {
  'use strict';

  var REDUCED = false;
  try {
    REDUCED = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { REDUCED = false; }

  /* --------------------------------------------------------- small helpers */
  function attr(el, name, dflt) {
    var v = el.getAttribute(name);
    return (v === null || v === '') ? dflt : v;
  }
  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }
  function num(v, dflt) {
    var n = parseFloat(v);
    return isFinite(n) ? n : dflt;
  }
  function make(tag, cls) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    return el;
  }

  /* ============================================================ one instance */
  function Slider(root) {
    this.root = root;
    this.rev = clamp(num(attr(root, 'data-start', '50'), 50), 0, 100);
    this.built = false;
    this.videoEls = null;   // [rgbVideo, depthVideo] once VIDEO mode is built
    this.dragging = false;
    this.pointerId = null;
    this._resyncTimer = null;
    this._initialPlaySettled = false;  // gate IO pause until first play() resolves
  }

  /* resolve every asset URL from the data-* contract */
  Slider.prototype.cfg = function () {
    var r = this.root;
    var base = attr(r, 'data-base', '');
    var imgExt = attr(r, 'data-img-ext', 'png');

    var rgbImg = attr(r, 'data-rgb-src',
      base ? (base + '_rgb.' + imgExt) : '');
    var depthImg = attr(r, 'data-depth-src',
      base ? (base + '_depth.' + imgExt) : '');

    // labels
    var labelRgb = attr(r, 'data-label-rgb', 'RGB');
    var cam = attr(r, 'data-cam', '');
    var labelDepth = r.getAttribute('data-label-depth');
    if (labelDepth === null || labelDepth === '') {
      labelDepth = cam ? ('Raw depth (' + cam + ')') : 'Raw depth';
    }

    // video basenames (webm + mp4 each); optional
    var videoBase = attr(r, 'data-video', '');
    var vRgb = attr(r, 'data-video-rgb', videoBase ? (videoBase + '_rgb') : '');
    var vDepth = attr(r, 'data-video-depth', videoBase ? (videoBase + '_depth') : '');

    return {
      rgbImg: rgbImg,
      depthImg: depthImg,
      labelRgb: labelRgb,
      labelDepth: labelDepth,
      altRgb: attr(r, 'data-alt-rgb', labelRgb + ' view'),
      altDepth: attr(r, 'data-alt-depth', labelDepth + ' view'),
      poster: attr(r, 'data-poster', rgbImg),
      width: attr(r, 'data-width', ''),
      height: attr(r, 'data-height', ''),
      hasVideo: !!(vRgb && vDepth),
      vRgb: vRgb,
      vDepth: vDepth
    };
  };

  /* build the two <source> (webm then mp4) for a video basename */
  Slider.prototype.sources = function (videoEl, basename) {
    var webm = make('source');
    webm.src = basename + '.webm';
    webm.type = 'video/webm';
    var mp4 = make('source');
    mp4.src = basename + '.mp4';
    mp4.type = 'video/mp4';
    videoEl.appendChild(webm);
    videoEl.appendChild(mp4);
  };

  /* build the STATIC layer (always built when stills exist) */
  Slider.prototype.buildStatic = function (c) {
    var layer = make('div', 'pg-slider__layer pg-slider__layer--static');

    var under = make('img', 'pg-slider__media pg-slider__media--under');
    under.src = c.rgbImg;
    under.alt = c.altRgb;
    under.decoding = 'async';
    // The box reserves height via aspect-ratio; width/height attrs are advisory
    // and further guard against layout shift if CSS is slow.
    if (c.width) under.setAttribute('width', c.width);
    if (c.height) under.setAttribute('height', c.height);
    under.setAttribute('draggable', 'false');

    var over = make('img', 'pg-slider__media pg-slider__media--over');
    over.src = c.depthImg;
    over.alt = c.altDepth;
    over.decoding = 'async';
    if (c.width) over.setAttribute('width', c.width);
    if (c.height) over.setAttribute('height', c.height);
    over.setAttribute('draggable', 'false');

    layer.appendChild(under);
    layer.appendChild(over);
    return layer;
  };

  /* build the VIDEO layer (only when a video basename is given) */
  Slider.prototype.buildVideo = function (c) {
    var layer = make('div', 'pg-slider__layer pg-slider__layer--video');

    var common = function (v, basename) {
      v.muted = true;            // required for autoplay
      v.defaultMuted = true;
      v.loop = true;
      v.autoplay = true;
      v.playsInline = true;
      v.setAttribute('muted', '');
      v.setAttribute('loop', '');
      v.setAttribute('autoplay', '');
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      v.setAttribute('preload', 'metadata');
      v.setAttribute('disablepictureinpicture', '');
      v.setAttribute('draggable', 'false');
      if (c.poster) v.setAttribute('poster', c.poster);
      this.sources(v, basename);
    }.bind(this);

    var under = make('video', 'pg-slider__media pg-slider__media--under');
    common(under, c.vRgb);
    var over = make('video', 'pg-slider__media pg-slider__media--over');
    common(over, c.vDepth);

    layer.appendChild(under);
    layer.appendChild(over);
    this.videoEls = [under, over];
    return layer;
  };

  /* corner labels, divider+handle, hint, sr-live — shared chrome */
  Slider.prototype.buildChrome = function (c) {
    var frag = document.createDocumentFragment();

    var tagU = make('span', 'pg-slider__tag pg-slider__tag--under');
    tagU.textContent = c.labelRgb;
    var tagO = make('span', 'pg-slider__tag pg-slider__tag--over');
    tagO.textContent = c.labelDepth;

    var divider = make('div', 'pg-slider__divider');
    var handle = make('div', 'pg-slider__handle');
    handle.appendChild(make('span', 'pg-slider__chev pg-slider__chev--l'));
    handle.appendChild(make('span', 'pg-slider__chev pg-slider__chev--r'));
    divider.appendChild(handle);

    var hint = make('span', 'pg-slider__hint');
    hint.textContent = 'Drag ↔';   // ↔

    var sr = make('span', 'pg-slider__sr');
    sr.setAttribute('aria-live', 'polite');
    this.srEl = sr;

    frag.appendChild(tagU);
    frag.appendChild(tagO);
    frag.appendChild(divider);
    frag.appendChild(hint);
    frag.appendChild(sr);
    return frag;
  };

  /* assemble the instance (idempotent) */
  Slider.prototype.build = function () {
    if (this.built) return;
    var root = this.root;
    var c = this.cfg();

    // aspect-ratio / size guards (set inline so they win even before CSS loads)
    var aspect = attr(root, 'data-aspect', '1 / 1').replace('/', ' / ');
    root.style.setProperty('--sl-aspect', aspect);
    root.style.setProperty('--rev', String(this.rev));

    // Build the STATIC layer whenever we have stills (this is the fallback).
    if (c.rgbImg && c.depthImg) {
      root.appendChild(this.buildStatic(c));
    }

    // Decide whether to attempt VIDEO: needs a video basename AND not reduced.
    this.wantVideo = c.hasVideo && !REDUCED;
    if (this.wantVideo) {
      root.appendChild(this.buildVideo(c));
    }

    // Shared chrome (labels, divider, handle, hint, sr-live).
    root.appendChild(this.buildChrome(c));

    // ARIA: the root is the slider.
    root.setAttribute('role', 'slider');
    root.setAttribute('tabindex', '0');
    root.setAttribute('aria-valuemin', '0');
    root.setAttribute('aria-valuemax', '100');
    root.setAttribute('aria-orientation', 'horizontal');
    if (!root.getAttribute('aria-label')) {
      root.setAttribute('aria-label',
        'Comparison slider: ' + c.labelRgb + ' versus ' + c.labelDepth +
        '. Drag, or use arrow keys, to reveal more of either image.');
    }

    this.labelRgb = c.labelRgb;
    this.labelDepth = c.labelDepth;

    this.built = true;
    this.wireEvents();
    this.applyMode();          // choose static/video + (re)apply --rev + aria
  };

  /* choose the live mode; arrange video startup + graceful fallback */
  Slider.prototype.applyMode = function () {
    var root = this.root;
    if (this.wantVideo && this.videoEls) {
      // Optimistically VIDEO; demote to static on any failure.
      root.setAttribute('data-mode', 'video');
      this.armVideo();
    } else {
      root.setAttribute('data-mode', 'static');
    }
    this.setRev(this.rev, true);   // sync css var + aria, silent
  };

  /* demote to the static slider (kept in DOM); pause/teardown video playback */
  Slider.prototype.fallbackToStatic = function () {
    this.wantVideo = false;
    if (this.videoEls) {
      this.videoEls.forEach(function (v) {
        try { v.pause(); } catch (e) {}
      });
    }
    // Only switch if a static layer actually exists; otherwise leave video DOM
    // (a poster frame still shows) rather than blanking the box.
    if (this.root.querySelector('.pg-slider__layer--static')) {
      this.root.setAttribute('data-mode', 'static');
    }
  };

  /* start both videos under one controller; keep them aligned, re-sync on loop */
  Slider.prototype.armVideo = function () {
    var self = this;
    var vids = this.videoEls;
    if (!vids) { this.fallbackToStatic(); return; }
    var rgb = vids[0], depth = vids[1];

    var failed = false;
    function fail() {
      if (failed) return;
      failed = true;
      self.fallbackToStatic();
    }
    rgb.addEventListener('error', fail);
    depth.addEventListener('error', fail);
    // <source> errors bubble as events on the <source>, not the <video>; catch
    // the case where NO source can play (networkState / error stays null but
    // playback never starts) via a stalled-load watchdog after metadata.
    vids.forEach(function (v) {
      v.querySelectorAll('source').forEach(function (s) {
        s.addEventListener('error', function () {
          // a single <source> erroring is normal (webm vs mp4); only fail if the
          // video itself ends up with no playable source.
          if (v.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) fail();
        });
      });
    });

    // The RGB video is the clock; the depth video follows it.
    function align() {
      if (failed) return;
      // keep within a small tolerance; hard re-seek if drift is large
      var drift = Math.abs(depth.currentTime - rgb.currentTime);
      if (drift > 0.06) {
        try { depth.currentTime = rgb.currentTime; } catch (e) {}
      }
    }
    rgb.addEventListener('timeupdate', align);
    // re-sync exactly at loop wrap: when RGB jumps back to ~0, snap depth too
    rgb.addEventListener('seeked', align);
    rgb.addEventListener('play', function () { play(depth); });
    rgb.addEventListener('pause', function () { try { depth.pause(); } catch (e) {} });
    // Some engines fire 'ended' even with loop on edge cases — re-kick both.
    rgb.addEventListener('ended', function () {
      try { rgb.currentTime = 0; } catch (e) {}
      try { depth.currentTime = 0; } catch (e) {}
      play(rgb); play(depth);
    });

    function play(v) {
      var p = v.play();
      if (p && typeof p.catch === 'function') {
        p.catch(function (err) {
          // AbortError ('The play() request was interrupted by a call to
          // pause()') is benign and EXPECTED here: armVideo() calls play() on
          // both videos while the IntersectionObserver (wireEvents) may pause
          // the same videos during scroll-settle, and several instances arming
          // at once amplify the race. Demoting on it is wrong — fail() is a
          // one-way latch, so a benign abort would permanently strand the
          // slider in static. Ignore it; the IO/loop handlers re-play. Only
          // genuinely-absent/undecodable media should demote, and the <source>
          // error listeners + the stalled-load watchdog already cover that.
          if (err && err.name === 'AbortError') return;
          // A real autoplay rejection (rare for muted) — fall back to static so
          // the page still shows the comparison instead of a frozen first frame.
          fail();
        });
      }
      return p;
    }

    // Kick off once enough metadata is known so dimensions are stable.
    function start() {
      if (failed) return;
      // depth follows; start the clock (rgb), then depth from rgb's play handler
      var pr = play(rgb);
      // also nudge depth directly in case the play->play chain is delayed
      var pd = play(depth);
      // Mark the initial play() promises as settled so the IO power-saver does
      // not pause mid-flight and provoke the (now-ignored, but still wasteful)
      // AbortError race while several instances arm at once. Settling either
      // way (resolve OR reject) is enough — we only need the in-flight window
      // to close before allowing IO-driven pauses.
      var settle = function () { self._initialPlaySettled = true; };
      var pending = [];
      if (pr && typeof pr.then === 'function') pending.push(pr['catch'](function () {}));
      if (pd && typeof pd.then === 'function') pending.push(pd['catch'](function () {}));
      if (pending.length && window.Promise) {
        Promise.all(pending).then(settle);
      } else {
        settle();
      }
    }
    if (rgb.readyState >= 1) start();
    else rgb.addEventListener('loadedmetadata', start, { once: true });

    // Watchdog: if after a short grace period neither video is actually
    // advancing, demote to static. (Covers absent files that never error.)
    this._resyncTimer = setTimeout(function () {
      if (failed) return;
      var advancing = rgb.currentTime > 0 && !rgb.paused;
      var loadedOk = rgb.readyState >= 2 && depth.readyState >= 2;
      if (!advancing && !loadedOk) fail();
    }, 1800);
  };

  /* ---------------------------------------------------- position math + a11y */
  // pointer X (clientX) -> % revealed from the right
  Slider.prototype.xToRev = function (clientX) {
    var rect = this.root.getBoundingClientRect();
    if (rect.width <= 0) return this.rev;
    var fromLeft = clamp((clientX - rect.left) / rect.width, 0, 1); // 0..1 left->right
    return clamp((1 - fromLeft) * 100, 0, 100);
  };

  Slider.prototype.setRev = function (rev, silent) {
    this.rev = clamp(rev, 0, 100);
    var rounded = Math.round(this.rev);
    this.root.style.setProperty('--rev', String(this.rev));
    // aria-valuenow reports % of the OVER (depth) shown = 100 - rev revealed-RGB.
    // Reporting depth-shown is the intuitive "how much depth is visible" value.
    var depthShown = 100 - rounded;
    this.root.setAttribute('aria-valuenow', String(depthShown));
    this.root.setAttribute('aria-valuetext',
      depthShown + '% ' + this.labelDepth + ', ' + rounded + '% ' + this.labelRgb);
    if (!silent && this.srEl) {
      this.srEl.textContent = depthShown + ' percent ' + this.labelDepth + ' visible';
    }
  };

  /* ------------------------------------------------------------- events */
  Slider.prototype.wireEvents = function () {
    var self = this;
    var root = this.root;

    // Pointer drag (covers mouse, touch, pen via Pointer Events).
    function onDown(ev) {
      // Only primary button / single touch.
      if (ev.button !== undefined && ev.button !== 0) return;
      self.dragging = true;
      self.pointerId = ev.pointerId;
      root.classList.add('is-dragging');
      if (root.setPointerCapture && ev.pointerId !== undefined) {
        try { root.setPointerCapture(ev.pointerId); } catch (e) {}
      }
      self.setRev(self.xToRev(ev.clientX));
      ev.preventDefault();
    }
    function onMove(ev) {
      if (!self.dragging) return;
      if (self.pointerId !== null && ev.pointerId !== undefined &&
          ev.pointerId !== self.pointerId) return;
      self.setRev(self.xToRev(ev.clientX));
      ev.preventDefault();
    }
    function onUp(ev) {
      if (!self.dragging) return;
      self.dragging = false;
      root.classList.remove('is-dragging');
      if (root.releasePointerCapture && self.pointerId !== null) {
        try { root.releasePointerCapture(self.pointerId); } catch (e) {}
      }
      self.pointerId = null;
    }

    if (window.PointerEvent) {
      root.addEventListener('pointerdown', onDown);
      root.addEventListener('pointermove', onMove);
      root.addEventListener('pointerup', onUp);
      root.addEventListener('pointercancel', onUp);
      root.addEventListener('lostpointercapture', onUp);
    } else {
      // Fallback: mouse + touch for engines without Pointer Events.
      root.addEventListener('mousedown', function (e) { onDown(e); });
      window.addEventListener('mousemove', function (e) { if (self.dragging) onMove(e); });
      window.addEventListener('mouseup', onUp);
      root.addEventListener('touchstart', function (e) {
        if (!e.touches.length) return;
        self.dragging = true;
        root.classList.add('is-dragging');
        self.setRev(self.xToRev(e.touches[0].clientX));
        e.preventDefault();
      }, { passive: false });
      root.addEventListener('touchmove', function (e) {
        if (!self.dragging || !e.touches.length) return;
        self.setRev(self.xToRev(e.touches[0].clientX));
        e.preventDefault();
      }, { passive: false });
      root.addEventListener('touchend', onUp);
      root.addEventListener('touchcancel', onUp);
    }

    // Keyboard: Left/Right (and Up/Down) nudge; Shift = big step; Home/End ends.
    // Increasing "depth shown" means moving the divider toward the RIGHT, i.e.
    // DECREASING rev (revealed-RGB). We map the keys to the intuitive visual:
    //   ArrowRight -> divider right -> more depth -> rev decreases
    //   ArrowLeft  -> divider left  -> more RGB   -> rev increases
    root.addEventListener('keydown', function (ev) {
      var step = ev.shiftKey ? 10 : 2;
      var handled = true;
      switch (ev.key) {
        case 'ArrowRight':
        case 'ArrowUp':
          self.setRev(self.rev - step); break;
        case 'ArrowLeft':
        case 'ArrowDown':
          self.setRev(self.rev + step); break;
        case 'Home':
          // Home -> show all RGB (divider far right): rev = 100
          self.setRev(100); break;
        case 'End':
          // End -> show all depth (divider far left): rev = 0
          self.setRev(0); break;
        case 'PageUp':
          self.setRev(self.rev - 10); break;
        case 'PageDown':
          self.setRev(self.rev + 10); break;
        default:
          handled = false;
      }
      if (handled) ev.preventDefault();
    });

    // double-click / double-tap resets to centre
    root.addEventListener('dblclick', function (ev) {
      self.setRev(50);
      ev.preventDefault();
    });

    // Pause videos when far off-screen to save power; resume on return.
    if (typeof IntersectionObserver !== 'undefined') {
      var pauseAll = function () {
        self.videoEls.forEach(function (v) { try { v.pause(); } catch (e) {} });
      };
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!self.videoEls || self.root.getAttribute('data-mode') !== 'video') return;
          if (en.isIntersecting) {
            self.videoEls.forEach(function (v) {
              var p = v.play(); if (p && p.catch) p.catch(function () {});
            });
          } else if (self._initialPlaySettled) {
            // Off-screen and the initial play() promise has already settled:
            // safe to pause now.
            pauseAll();
          } else {
            // Off-screen but armVideo()'s initial play() is still in flight.
            // Pausing now would interrupt it and trigger the benign-but-wasteful
            // AbortError race (and, before the catch fix, a permanent demotion).
            // Defer the pause until the play() promise settles; only then pause,
            // and only if we are still genuinely off-screen. Self-terminating:
            // also stops if the slider leaves video mode (genuine failure) or
            // after a hard cap, so it can never leak if play() never settles.
            var tries = 0;
            var deferred = setInterval(function () {
              tries++;
              var stillVideo = self.root.getAttribute('data-mode') === 'video';
              if (self._initialPlaySettled || !stillVideo || tries > 40) {
                clearInterval(deferred);
                if (self._initialPlaySettled && stillVideo) {
                  var rect = self.root.getBoundingClientRect();
                  var vis = (window.innerHeight || 0) + 200;
                  var stillOff = rect.bottom < -200 || rect.top > vis;
                  if (stillOff) pauseAll();
                }
              }
            }, 120);
          }
        });
      }, { threshold: 0.05 });
      io.observe(root);
    }
  };

  /* ============================================================ registry */
  function buildInstance(root) {
    if (root.getAttribute('data-slider-ready') === '1') return;
    root.setAttribute('data-slider-ready', '1');
    try {
      new Slider(root).build();
    } catch (e) {
      // Never let one bad instance break the page; leave its under-image visible.
      try { root.setAttribute('data-mode', 'static'); } catch (_) {}
      if (window.console && console.warn) {
        console.warn('[pg-slider] init failed for', root, e);
      }
    }
  }

  function init() {
    var roots = Array.prototype.slice.call(
      document.querySelectorAll('.pg-slider'));
    if (!roots.length) return;

    // Lazy-build below-the-fold instances; build above-the-fold ones eagerly.
    if (typeof IntersectionObserver === 'undefined') {
      roots.forEach(buildInstance);
      return;
    }
    var lazy = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          buildInstance(en.target);
          lazy.unobserve(en.target);
        }
      });
    }, { root: null, rootMargin: '200px 0px 200px 0px', threshold: 0.01 });

    roots.forEach(function (r) {
      var rect = r.getBoundingClientRect();
      var inView = rect.top < (window.innerHeight || 0) + 200 && rect.bottom > -200;
      if (inView) buildInstance(r);   // no flash for what's already visible
      else lazy.observe(r);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose a tiny re-scan hook for dynamically inserted sliders (no globals
  // leaked beyond this single namespaced property; safe to ignore).
  try {
    window.PgSlider = window.PgSlider || { rescan: init };
  } catch (e) {}
})();
