/* Fresh Zone - pricing + formatting.
   This file is the ONLY definition of the price formula. It used to be copied
   into index.html, pricelist.html and admin.html, which meant the poster and
   the admin table could silently disagree about what a product costs. */
window.FZ = window.FZ || {};

/* Flat integer added to the daily exchange (bourse) price before any per-item
   markup is applied. Not a percentage and not a currency conversion - it is a
   fixed uplift on the base. */
FZ.BASE_PRICE_BUFFER = 5;

/* markup_type semantics, as actually implemented:
     'fixed'   -> final = base + markup_value      (EGP added)
     'percent' -> final = base * markup_value      (a MULTIPLIER, despite the
                                                    column name; 1.1 = +10%)
   Anything else falls through to the additive branch. */
FZ.computeFinalPrice = function (p, basePrice) {
  if (p.price !== null && p.price !== undefined && p.price !== '') return Number(p.price);
  if (basePrice === null || basePrice === undefined || basePrice === '') return null;
  var base = Number(basePrice) + FZ.BASE_PRICE_BUFFER;
  var mv = Number(p.markup_value || 0);
  var final = p.markup_type === 'percent' ? base * mv : base + mv;
  return isFinite(final) ? final : null;
};

/* Prices are rounded to the nearest whole pound and rendered with Western
   digits, matching the phone numbers printed on the same poster. Before this,
   an unrounded float was formatted with ar-EG, so a 62.5 base could publish
   "77.63" in Arabic-Indic digits next to Western phone numbers. */
FZ.roundPrice = function (n) {
  return (n === null || n === undefined || !isFinite(n)) ? null : Math.round(Number(n));
};

FZ.formatPrice = function (n) {
  var r = FZ.roundPrice(n);
  return r === null ? null : r.toLocaleString('en-US');
};

/* ---- the clock ----------------------------------------------------------
   The poster date used to come from the visitor's device. A device whose
   clock is wrong - and they are, more often than you would guess - then
   published a price list dated the wrong day, which reads as carelessness
   about the prices themselves.

   So the date comes from the server instead: one HEAD request, whose `Date`
   response header is authoritative, and everything is then formatted in Cairo
   time regardless of where the device thinks it is. The device clock survives
   only as the fallback, because a wrong date beats no date. */
FZ.TIMEZONE = 'Africa/Cairo';

/* File-scope, not module-scope: pricing.js is a plain script, so these are
   prefixed to stay clear of anything else on the page. */
var fzClockSkew = null;  /* serverMillis - deviceMillis, once known */
var fzClockSync = null;  /* memoised in-flight promise */

FZ.syncClock = function () {
  if (fzClockSync) return fzClockSync;
  if (typeof fetch !== 'function') { fzClockSync = Promise.resolve(); return fzClockSync; }
  fzClockSync = fetch('/robots.txt?t=' + Date.now(), { method: 'HEAD', cache: 'no-store' })
    .then(function (res) {
      var header = res.headers.get('date');
      if (!header) return;
      var serverMs = Date.parse(header);
      /* Date.parse returns NaN on anything unexpected; never let that poison
         every date on the page. */
      if (!isFinite(serverMs)) return;
      fzClockSkew = serverMs - Date.now();
    })
    .catch(function () { /* offline, blocked, CORS - fall back to the device */ });
  return fzClockSync;
};

/* Uses the device clock only to measure ELAPSED time since the sync, which is
   correct even when its absolute reading is hours out. */
FZ.now = function () {
  return new Date(Date.now() + (fzClockSkew || 0));
};

/* Arabic month/weekday names with Latin digits, so the date matches the
   numeral system used by the prices. */
FZ.formatDate = function (d) {
  d = d || FZ.now();
  try {
    return d.toLocaleDateString('ar-EG-u-nu-latn', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: FZ.TIMEZONE
    });
  } catch (e) {
    return d.toLocaleDateString('ar-EG', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
  }
};

FZ.formatDateTime = function (d) {
  try {
    return d.toLocaleString('ar-EG-u-nu-latn', {
      day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
    });
  } catch (e) {
    return d.toLocaleString('ar-EG', { day: 'numeric', month: 'long' });
  }
};

/* Local date, not UTC. toISOString() was stamping downloads with yesterday
   between 00:00 and 03:00 Cairo time. */
FZ.dateSlug = function (d) {
  d = d || FZ.now();
  try {
    /* en-CA is the one common locale that formats as YYYY-MM-DD. */
    return d.toLocaleDateString('en-CA', { timeZone: FZ.TIMEZONE });
  } catch (e) {
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
};

/* Escapes & FIRST, which is what makes it safe inside an HTML attribute -
   the parser decodes character references in attribute values, so an
   unescaped & lets a literal "&#39;" in the data close a quoted attribute. */
FZ.escapeHtml = function (str) {
  return String(str === null || str === undefined ? '' : str)
    .replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
};
