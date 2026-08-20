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

/* Arabic month/weekday names with Latin digits, so the date matches the
   numeral system used by the prices. */
FZ.formatDate = function (d) {
  d = d || new Date();
  try {
    return d.toLocaleDateString('ar-EG-u-nu-latn', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
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
  d = d || new Date();
  var pad = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
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
