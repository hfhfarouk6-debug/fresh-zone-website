/* Fresh Zone - landing page behaviour. */
(function () {
  'use strict';

  /* Current year in the footer, so it does not go stale in January. */
  var yearEl = document.getElementById('fzYear');
  /* Server year, so a device with a wrong clock cannot print a wrong
     copyright year in the footer. */
  if (yearEl) {
    yearEl.textContent = (FZ.now ? FZ.now() : new Date()).getFullYear();
    if (FZ.syncClock) {
      FZ.syncClock().then(function () { yearEl.textContent = FZ.now().getFullYear(); });
    }
  }

  /* Real scroll reveal. The CSS animation it replaces had no observer at all,
     so every .reveal fired at page load - including the eight elements below
     the fold, which had finished animating before the user ever saw them.
     The hidden state is added here, not in the stylesheet, so the content is
     always visible when JS is off. */
  var targets = document.querySelectorAll('.reveal');
  if (!targets.length) return;

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || !('IntersectionObserver' in window)) return;

  document.documentElement.classList.add('js-reveal');

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var el = entry.target;
      var siblings = el.parentElement ? Array.prototype.indexOf.call(el.parentElement.children, el) : 0;
      el.style.transitionDelay = Math.min(siblings, 4) * 70 + 'ms';
      el.classList.add('reveal-on');
      io.unobserve(el);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

  targets.forEach(function (el) { io.observe(el); });
})();
