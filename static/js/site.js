/* ============================================================================
 * PG supplementary site — tiny page behaviours (no dependencies, no network).
 *   1. hero load orchestration (staggered reveal via a body class)
 *   2. scroll-reveal for .reveal elements (IntersectionObserver)
 *   3. scroll-spy: highlight the active nav link for the section in view
 *   4. mobile burger nav toggle
 *   5. copy-to-clipboard for the BibTeX block
 * Respects prefers-reduced-motion (final states render immediately).
 * ========================================================================== */
(function () {
  'use strict';

  var REDUCED = false;
  try {
    REDUCED = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { REDUCED = false; }

  /* ----------------------------------------------------- 1. hero load-in */
  function armHero() {
    // Add the loaded class on next frame so the CSS keyframes fire from start.
    if (REDUCED) { document.body.classList.add('pg-loaded'); return; }
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        document.body.classList.add('pg-loaded');
      });
    });
  }

  /* ------------------------------------------------ 2. scroll-reveal */
  function armReveal() {
    var nodes = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
    if (!nodes.length) return;
    if (REDUCED || typeof IntersectionObserver === 'undefined') {
      nodes.forEach(function (n) { n.classList.add('is-in'); });
      return;
    }
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add('is-in');
          obs.unobserve(en.target);
        }
      });
    }, { root: null, rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    nodes.forEach(function (n) { obs.observe(n); });
  }

  /* ------------------------------------------------ 3. scroll-spy nav */
  function armScrollSpy() {
    var links = Array.prototype.slice.call(
      document.querySelectorAll('.pg-nav__links a[href^="#"]'));
    if (!links.length) return;

    var map = {};
    var sections = [];
    links.forEach(function (a) {
      var id = a.getAttribute('href').slice(1);
      var sec = document.getElementById(id);
      if (sec) { map[id] = a; sections.push(sec); }
    });
    if (!sections.length) return;

    function setActive(id) {
      links.forEach(function (a) { a.classList.remove('is-active'); });
      if (map[id]) map[id].classList.add('is-active');
    }

    if (typeof IntersectionObserver === 'undefined') return;

    var visible = {};
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        visible[en.target.id] = en.isIntersecting ? en.intersectionRatio : 0;
      });
      // pick the section with the greatest visible ratio
      var bestId = null, best = 0;
      sections.forEach(function (s) {
        var r = visible[s.id] || 0;
        if (r > best) { best = r; bestId = s.id; }
      });
      if (bestId) setActive(bestId);
    }, {
      root: null,
      // bias toward the section crossing the upper third of the viewport
      rootMargin: '-' + (document.querySelector('.pg-nav') ?
        (document.querySelector('.pg-nav').offsetHeight + 8) : 60) + 'px 0px -55% 0px',
      threshold: [0.01, 0.2, 0.5, 0.8, 1]
    });
    sections.forEach(function (s) { spy.observe(s); });
  }

  /* ------------------------------------------------ 4. mobile burger */
  function armBurger() {
    var burger = document.querySelector('.pg-burger');
    var links = document.querySelector('.pg-nav__links');
    if (!burger || !links) return;

    function close() {
      links.classList.remove('is-open');
      burger.setAttribute('aria-expanded', 'false');
    }
    burger.addEventListener('click', function () {
      var open = links.classList.toggle('is-open');
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    links.addEventListener('click', function (ev) {
      if (ev.target.closest('a')) close();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') close();
    });
  }

  /* ------------------------------------------------ 5. copy bibtex */
  function armCopy() {
    var btn = document.querySelector('.pg-copy');
    var pre = document.getElementById('bibtex-src');
    if (!btn || !pre) return;
    var labelEl = btn.querySelector('.pg-copy__label');
    var defaultLabel = labelEl ? labelEl.textContent : 'Copy';

    btn.addEventListener('click', function () {
      var text = pre.innerText || pre.textContent || '';
      var done = function () {
        btn.classList.add('is-copied');
        if (labelEl) labelEl.textContent = 'Copied';
        setTimeout(function () {
          btn.classList.remove('is-copied');
          if (labelEl) labelEl.textContent = defaultLabel;
        }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallback(text, done); });
      } else {
        fallback(text, done);
      }
    });

    function fallback(text, done) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      } catch (e) { /* no-op */ }
    }
  }

  function init() {
    armHero();
    armReveal();
    armScrollSpy();
    armBurger();
    armCopy();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
