/* ==========================================================================
   Fresh Zone - price-list poster: render, readiness gate, deterministic export.

   The whole poster is built here rather than in each page's HTML. It used to
   be duplicated byte-for-byte across index.html and pricelist.html, and the
   two copies had already drifted (different accent blue, different inherited
   line-height => posters ~40px apart in height). One builder, one result.

   Everything in here exists to make one promise true: the PNG you download is
   the poster you see. Read the notes before changing any of it.
   ========================================================================== */
window.FZ = window.FZ || {};

(function () {
  'use strict';

  /* .pphoto is 38px border-box with 1.5px borders => 35px content box.
     Hardcoded rather than measured, because CSS `zoom` on the stage skews
     clientWidth and the export must not inherit that skew. Keep in sync with
     .pphoto in poster.css. */
  var PHOTO_BOX = 35;

  var CAPTURE_WIDTH = 460;   /* the poster's one true layout width */
  var CAPTURE_SCALE = 3;     /* -> 1380px PNG, comfortable for WhatsApp */
  var MAX_ZOOM = 1.35;

  /* Fills the 24px rounded corners with the same cream the poster sits on in
     both pages, so the exported PNG reads as a card rather than showing
     transparent corners that WhatsApp composites black in dark mode. */
  var CAPTURE_BG = '#F4EEE2';

  /* Literal, never `currentColor`. html2canvas serialises each inline <svg>
     into a standalone document via XMLSerializer; CSS `color` is inherited
     through the DOM and does NOT travel with the serialised subtree, so
     `stroke="currentColor"` resolves against the SVG's own initial color -
     black - and every icon came out invisible on the navy background. */
  var ACCENT = '#3E8FD9';

  var HTML2CANVAS_SRC = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';

  /* ---- server-side export ------------------------------------------------
     /api/poster screenshots this very page in a real headless Chrome, so the
     PNG is produced by the same engine that painted the screen instead of by
     html2canvas re-implementing it. That removes the whole class of
     "looks right live, wrong in the file" bugs (text baselines under a
     custom Arabic font, object-fit, box-shadow, gradients) rather than
     working around them one at a time.

     html2canvas stays loaded as a fallback: if the function cold-starts too
     slowly, errors, or the deployment has no /api at all, the button still
     produces an image. Server first, canvas second, never nothing. */
  var API_ENDPOINT = '/api/poster';
  var API_TIMEOUT = 45000;

  /* The flag the server-side browser waits on. Set once data, product images
     and every font weight have settled - i.e. exactly when the on-screen
     poster stops changing. Screenshotting before this captures a half-built
     grid. */
  var READY_FLAG = '__fzPosterReady';

  /* Rendering this page for the camera, not for a person. */
  var EXPORT_MODE = /[?&]fzexport=1(?:&|$)/.test(window.location.search);

  /* Local, same-origin, ~250 bytes. Replaces the old fallback, which was the
     107KB landscape hero photo decoded into a 38px square. */
  var PLACEHOLDER =
    'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="70" height="70">' +
      '<rect width="70" height="70" fill="#0c1c2b"/>' +
      '<path d="M20 44c0-9 6-16 15-16s15 7 15 16z" fill="#1b3a55"/>' +
      '<circle cx="35" cy="24" r="7" fill="#1b3a55"/></svg>'
    );

  /* ---- inline SVG is not safe here ---------------------------------------
     html2canvas 1.4.1 routes inline <svg> through SVGElementContainer, which
     re-serialises each element into its own standalone document. In practice
     that path is unreliable: with four sibling swirls only ONE was ever
     painted, deterministically, regardless of position, offsets or transforms
     (verified by capturing with each swirl hidden in turn). The serialised
     documents themselves are valid and load fine as images.

     So every graphic inside the poster is emitted as an <img> holding a
     data: URI instead. That is the ordinary replaced-element path - the same
     one the product photos and the logo already use - and it is exact. It
     also permanently removes the url(#id) hazard, because each icon is its
     own document and can safely reuse a local gradient id.                */
  function svgUri(markup) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
  }

  var SWIRL_MIRROR = {
    tl: '',
    tr: 'scale(-1,1) translate(-200,0)',
    bl: 'scale(1,-1) translate(0,-200)',
    br: 'scale(-1,-1) translate(-200,-200)'
  };

  function swirl(pos) {
    var g = SWIRL_MIRROR[pos];
    var markup =
      '<svg xmlns="http://www.w3.org/2000/svg" width="130" height="130" viewBox="0 0 200 200">' +
      '<defs><linearGradient id="g" x1="0" y1="1" x2="1" y2="0">' +
      '<stop offset="0" stop-color="' + ACCENT + '" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="' + ACCENT + '" stop-opacity=".9"/>' +
      '</linearGradient></defs>' +
      '<g' + (g ? ' transform="' + g + '"' : '') + '>' +
      '<path d="M6,150 C6,70 70,6 150,6" stroke="url(#g)" stroke-width="5" fill="none" stroke-linecap="round"/>' +
      '<path d="M6,110 C6,50 50,6 110,6" stroke="url(#g)" stroke-width="2.5" fill="none" stroke-linecap="round" opacity=".6"/>' +
      '</g></svg>';
    return '<img class="corner-swirl ' + pos + '" src="' + svgUri(markup) +
           '" alt="" aria-hidden="true" width="130" height="130">';
  }

  var ICON_DROP   = '<path d="M12 2C9 6 6 8.5 6 13a6 6 0 0 0 12 0c0-4.5-3-7-6-11Z"/>';
  var ICON_SHIELD = '<path d="M12 2 4 5.5v5C4 15.5 7.4 19.7 12 21c4.6-1.3 8-5.5 8-10.5v-5L12 2Z"/>';
  var ICON_SNOW   = '<path d="M12 2v20M4.2 6.5l15.6 11M4.2 17.5l15.6-11"/>';
  var ICON_CHECK  = '<path d="m9 12 2 2 4-4"/><circle cx="12" cy="12" r="9"/>';

  function icon(paths, sw) {
    var markup =
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
      'fill="none" stroke="' + ACCENT + '" stroke-width="' + (sw || 1.6) + '" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
    return '<img src="' + svgUri(markup) + '" alt="" aria-hidden="true" width="24" height="24">';
  }

  var AR = {
    brand:    'فريش زون',
    chicken:  'دواجن طازجة',
    fresh:    'طازج',
    quality:  'جودة عالية',
    keep:     'إبقاء طازج',
    priceList:'قائمة الأسعار',
    loading:  'بيتم التحميل...',
    empty:    'مفيش أصناف متاحة دلوقتي',
    failed:   'تعذّر تحميل الأسعار، حاول تفتح الصفحة تاني',
    noServer: 'تعذّر الاتصال بالخادم',
    guaranteed:'جودة مضمونة',
    daily:    'طازج يوميّا',
    clean:    'نظافة وأمان',
    tagline:  'طازج لكل يوم',
    order:    'للطلب:',
    whatsapp: 'واتساب',
    egp:      'ج.م',
    pricesOf: 'أسعار يوم ',
    preparing:'بيتم تجهيز القائمة...',
    building: 'بيتم التجهيز...',
    buildingN:'بيتم التجهيز… ',
    almost:   'باقي لحظات…',
    secs:     ' ث',
    dlOff:    'التحميل غير متاح',
    dlLocal:  'افتح الموقع من سيرفر عشان تنزّل الصورة',
    exportErr:'حصلت مشكلة في تجهيز الصورة، جرب تاني.',
    imgWarnA: 'فيه ',
    imgWarnB: ' صورة ما اتحمّلتش، القائمة نزلت من غيرها.'
  };

  function chrome() {
    var phones = '<bdi>' + FZ.PHONE_PRIMARY + '</bdi>';
    if (FZ.PHONE_SECONDARY) phones += ' / <bdi>' + FZ.PHONE_SECONDARY + '</bdi>';

    return swirl('tl') + swirl('tr') + swirl('bl') + swirl('br') +

      '<div class="shield-wrap">' +
        '<div class="shield"><div class="shield-inner">' +
          '<img src="assets/icon-white.png" alt="" width="34" height="34">' +
          '<div class="premium-tag" lang="en">&#183; PREMIUM QUALITY &#183;</div>' +
          '<div class="brand-word" lang="en">FRESH<span>ZONE</span></div>' +
          '<div class="brand-ar">' + AR.brand + '</div>' +
        '</div></div>' +
        '<div class="ribbon"><span lang="en">FRESH CHICKEN</span>' +
          '<span class="sub">' + AR.chicken + '</span>' +
        '</div>' +
        '<div class="mini-badges">' +
          '<div><div class="ic">' + icon(ICON_DROP) + '</div><b lang="en">100% FRESH</b><span>100% ' + AR.fresh + '</span></div>' +
          '<div><div class="ic">' + icon(ICON_SHIELD) + '</div><b lang="en">HIGH QUALITY</b><span>' + AR.quality + '</span></div>' +
          '<div><div class="ic">' + icon(ICON_SNOW) + '</div><b lang="en">KEEP FRESH</b><span>' + AR.keep + '</span></div>' +
        '</div>' +
      '</div>' +

      '<div class="list-title">' +
        '<span>' + AR.priceList + '</span>' +
        '<span class="divider"></span>' +
        '<span class="en" lang="en">PRICE LIST</span>' +
      '</div>' +
      '<div class="date-row" id="fzDateRow"></div>' +

      '<div class="plist" id="fzPlist" aria-live="polite" aria-busy="true">' +
        '<div class="plist-msg">' + AR.loading + '</div>' +
      '</div>' +

      '<div class="footer-trust">' +
        '<div><div class="ic">' + icon(ICON_CHECK, 2) + '</div>' + AR.guaranteed + '<span class="sub" lang="en">PREMIUM QUALITY</span></div>' +
        '<div><div class="ic">' + icon(ICON_SNOW, 2) + '</div>' + AR.daily + '<span class="sub" lang="en">FRESH DAILY</span></div>' +
        '<div><div class="ic">' + icon(ICON_SHIELD, 2) + '</div>' + AR.clean + '<span class="sub" lang="en">CLEAN &amp; SAFE</span></div>' +
      '</div>' +
      '<div class="footer-tag">' + AR.tagline +
        '<span class="en" lang="en">FRESH EVERY DAY</span></div>' +
      '<div class="wa-strip">' + AR.order + ' <b>' + phones + '</b> &#8212; ' + AR.whatsapp + '</div>';
  }

  function rowHtml(p, basePrice) {
    var priceStr = FZ.formatPrice(FZ.computeFinalPrice(p, basePrice));
    var priceHtml = priceStr !== null
      ? '<span class="val">' + priceStr + '</span><span class="unit">' + AR.egp + '</span>'
      : '<span class="val dots">&#183;&#183;&#183;&#183;&#183;</span><span class="unit">' + AR.egp + '</span>';

    var src = p.image_url || PLACEHOLDER;
    var nameAr = FZ.escapeHtml(p.name_ar || '');
    var nameEn = FZ.escapeHtml(p.name_en || '');

    return '<div class="prow">' +
      '<div class="ptop">' +
        '<div class="pphoto">' +
          '<img src="' + FZ.escapeHtml(src) + '" alt="" crossorigin="anonymous" decoding="sync">' +
        '</div>' +
        '<div class="pinfo">' +
          '<div class="nm">' + nameAr + '</div>' +
          (nameEn ? '<div class="en" lang="en">' + nameEn + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="pprice-box"><span class="pprice-inner">' + priceHtml + '</span></div>' +
    '</div>';
  }

  /* ---- hand-rolled object-fit:cover -------------------------------------
     html2canvas 1.4.1 has no object-fit branch: it does one drawImage that
     stretches the whole bitmap into the element's layout box. So we make the
     layout box itself the correct cover rectangle and let the parent's
     overflow:hidden do the cropping. Stretch then IS the right crop, and the
     export matches the screen exactly. */
  function fitCover(img) {
    var nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh) return;
    var s = Math.max(PHOTO_BOX / nw, PHOTO_BOX / nh);
    var w = Math.round(nw * s * 100) / 100;
    var h = Math.round(nh * s * 100) / 100;
    img.style.width = w + 'px';
    img.style.height = h + 'px';
    img.style.left = ((PHOTO_BOX - w) / 2) + 'px';
    img.style.top = ((PHOTO_BOX - h) / 2) + 'px';
    img.style.objectFit = 'fill';
  }

  /* Resolves once every image has loaded or definitively failed.
     A CORS rejection is retried once without the crossorigin attribute: the
     photo then still shows on screen, but html2canvas cannot use it, so it is
     flagged and the operator is warned - instead of the previous behaviour,
     where html2canvas swallowed the failure per-image, left the canvas
     untainted, and silently exported dark empty squares. */
  function settleImages(root) {
    var imgs = Array.prototype.slice.call(root.querySelectorAll('.pphoto img'));
    return Promise.all(imgs.map(function (img) {
      return new Promise(function (resolve) {
        var done = false;
        function finish() { if (!done) { done = true; resolve(img); } }
        function onLoad() { fitCover(img); finish(); }
        function onError() {
          if (!img.dataset.fzRetry) {
            img.dataset.fzRetry = '1';
            img.dataset.fzNoCors = '1';
            var src = img.getAttribute('src');
            img.removeAttribute('crossorigin');
            img.setAttribute('src', '');
            img.setAttribute('src', src);
            return;
          }
          img.dataset.fzFailed = '1';
          delete img.dataset.fzNoCors;
          img.removeEventListener('error', onError);
          img.addEventListener('load', onLoad, { once: true });
          img.setAttribute('src', PLACEHOLDER);
        }
        img.addEventListener('load', onLoad);
        img.addEventListener('error', onError);
        if (img.complete && img.naturalWidth) onLoad();
        setTimeout(finish, 20000);
      });
    }));
  }

  /* document.fonts.ready alone is not enough: it resolves against faces the
     document has already requested, and a face whose unicode-range was never
     hit is never requested. Force each weight with a sample spanning the three
     scripts the poster prints - Arabic letter, Western digit, Latin letter. */
  /* Chrome graphics (swirls, badge icons, logo) are same-origin data: URIs or
     local files, so they only need to be decoded before the capture - no CORS
     dance. Kept separate from settleImages, which additionally applies the
     cover geometry and the crossorigin retry to product photos. */
  function awaitImages(root) {
    var imgs = Array.prototype.slice.call(root.querySelectorAll('img'));
    return Promise.all(imgs.map(function (img) {
      if (img.complete && img.naturalWidth) return Promise.resolve();
      return new Promise(function (r) {
        img.addEventListener('load', r, { once: true });
        img.addEventListener('error', r, { once: true });
        setTimeout(r, 15000);
      });
    }));
  }

  function fontsReady() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    var sample = 'ا' + '0' + 'A';
    var faces = ['500 16px Tajawal', '700 16px Tajawal', '800 16px Tajawal', '900 16px Tajawal'];
    return Promise.all(faces.map(function (f) {
      return document.fonts.load(f, sample).catch(function () {});
    })).then(function () { return document.fonts.ready; }).catch(function () {});
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (window.html2canvas) return resolve();
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('script failed: ' + src)); };
      document.head.appendChild(s);
    });
  }

  /* CSS zoom keeps the poster at its single 460px layout on every viewport, so
     what is on screen and what is exported are the same layout - only the
     display scale differs. A fluid width would reflow the grid (names wrapping
     to two lines below ~400px, price pills falling out of alignment across the
     two columns) and the export would stop matching. */
  function fitStage(stage) {
    if (!stage) return;
    if (window.CSS && CSS.supports && !CSS.supports('zoom', '1')) return;
    var parent = stage.parentElement;
    if (!parent) return;
    /* clientWidth includes padding, and the poster's parent is usually a
       padded .wrap - so subtract it or the poster overflows on mobile. */
    var cs = window.getComputedStyle(parent);
    var avail = parent.clientWidth
      - (parseFloat(cs.paddingInlineStart || cs.paddingLeft) || 0)
      - (parseFloat(cs.paddingInlineEnd || cs.paddingRight) || 0);
    if (!avail || avail < 0) return;
    var z = Math.min(MAX_ZOOM, avail / CAPTURE_WIDTH);
    stage.style.zoom = (Math.abs(z - 1) < 0.005) ? '' : String(Math.round(z * 1000) / 1000);
  }

  function canvasToBlob(canvas) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) {
        canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('toBlob returned null')); }, 'image/png');
      } else {
        reject(new Error('toBlob unsupported'));
      }
    });
  }

  /* ---- export ---------------------------------------------------------
     Never captures the live poster, whose rendered width follows the device.
     Clones into an off-screen host pinned at exactly 460px, so the PNG is the
     same image whether it was produced on a phone or a desktop. */
  function rasterise(poster) {
    var host = document.createElement('div');
    host.id = 'fzCaptureHost';

    var clone = poster.cloneNode(true);
    clone.removeAttribute('id');
    clone.style.width = CAPTURE_WIDTH + 'px';
    clone.style.maxWidth = CAPTURE_WIDTH + 'px';
    clone.style.margin = '0';
    clone.style.boxShadow = 'none';
    host.appendChild(clone);
    document.body.appendChild(host);

    var cloneImgs = Array.prototype.slice.call(clone.querySelectorAll('img'));
    var degraded = cloneImgs.filter(function (i) {
      return i.dataset.fzNoCors || i.dataset.fzFailed;
    }).length;

    return Promise.all(cloneImgs.map(function (im) {
      if (im.complete && im.naturalWidth) return Promise.resolve();
      return new Promise(function (r) {
        im.addEventListener('load', r, { once: true });
        im.addEventListener('error', r, { once: true });
        setTimeout(r, 8000);
      });
    }))
      /* Was a bare double-rAF. rAF is suspended while a tab is backgrounded,
         and on a phone that is simply what happens when someone taps the
         button and switches to WhatsApp - the export would then never finish
         and the button sat on "preparing" forever. settleFrames keeps the
         two-frame accuracy but cannot hang. */
      .then(settleFrames)
      .then(function () {
        /* No width/windowWidth/scrollX/scrollY overrides. The clone is already
           pinned to exactly CAPTURE_WIDTH in an unscaled host, so letting
           html2canvas use the element's own bounds is both simpler and safer -
           overriding the capture window is what shifts the output. */
        return window.html2canvas(clone, {
          backgroundColor: CAPTURE_BG,
          scale: CAPTURE_SCALE,
          useCORS: true,
          logging: false,
          imageTimeout: 20000
        });
      })
      .then(function (canvas) { return { canvas: canvas, degraded: degraded }; })
      .finally(function () {
        if (host.parentNode) host.parentNode.removeChild(host);
      });
  }

  /* ---- export mode -------------------------------------------------------
     Reduce the document to the poster alone, unscaled, on the same cream the
     rounded corners composite against. Done by moving the node rather than by
     hiding page furniture with CSS, so it behaves identically on both host
     pages and cannot be broken later by a new wrapper element.

     No zoom here on purpose: the poster's one true layout is 460px, and the
     server browser is given a 460px viewport, so what the camera sees is the
     canonical layout at 1:1. */
  function stripToPoster(poster) {
    if (poster.parentNode) poster.parentNode.removeChild(poster);
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    document.body.appendChild(poster);

    document.documentElement.style.background = CAPTURE_BG;
    var b = document.body.style;
    b.background = CAPTURE_BG;
    b.margin = '0';
    b.padding = '0';
    b.width = CAPTURE_WIDTH + 'px';
    b.overflow = 'hidden';

    poster.style.width = CAPTURE_WIDTH + 'px';
    poster.style.maxWidth = CAPTURE_WIDTH + 'px';
    poster.style.margin = '0';
    /* falls outside the element box; the server crops to the element, so it
       would only bleed a grey halo into the top edge of the PNG. */
    poster.style.boxShadow = 'none';
  }

  /* Wait for the final layout to be painted, not merely computed.
     Two animation frames are the accurate signal, but rAF is suspended in a
     backgrounded tab - and a headless page can be backgrounded, which is
     exactly where this is used. So a timer runs alongside and settles it
     regardless; whichever fires first wins. Without the timer the export
     waits forever on a frame that is never scheduled. */
  function settleFrames() {
    return new Promise(function (resolve) {
      var done = false;
      function finish() { if (done) return; done = true; resolve(); }
      requestAnimationFrame(function () { requestAnimationFrame(finish); });
      setTimeout(finish, 250);
    });
  }

  /* ---- download progress -------------------------------------------------
     A disabled, greyed-out button is indistinguishable from a broken one for
     the several seconds this takes, and people re-tap it. So the button turns
     into its own progress bar with a live countdown.

     The countdown is an estimate and is treated as one: it counts down to
     zero and then STOPS pretending, switching to "almost there" rather than
     sitting on 0 or, worse, counting into negative numbers. Overrunning is
     normal - a cold server or the browser fallback both take longer. */
  function startProgress(btn, seconds) {
    if (!btn) return function () {};

    var fill = document.createElement('span');
    fill.className = 'dl-fill';
    var label = document.createElement('span');
    label.className = 'dl-label';
    var count = document.createElement('span');
    count.className = 'dl-count';

    btn.textContent = '';
    btn.appendChild(fill);
    btn.appendChild(label);
    btn.appendChild(count);
    btn.classList.add('is-working');
    btn.classList.remove('is-overrun');

    var left = seconds;
    function paint() {
      if (left > 0) {
        label.textContent = AR.buildingN;
        count.textContent = left + AR.secs;
        /* Stop short of the end: the bar must not read "finished" while the
           image is still being made. */
        fill.style.width = Math.round(((seconds - left) / seconds) * 92) + '%';
      } else {
        label.textContent = AR.almost;
        count.textContent = '';
        btn.classList.add('is-overrun');
        fill.style.width = '92%';
      }
    }
    paint();

    var timer = setInterval(function () {
      left -= 1;
      paint();
      if (left <= 0) { clearInterval(timer); timer = null; }
    }, 1000);

    return function stop() {
      if (timer) { clearInterval(timer); timer = null; }
      btn.classList.remove('is-working', 'is-overrun');
    };
  }

  /* Asks the server for the PNG. Rejects - rather than hanging - on a cold
     start that overruns, so the caller can fall back while the customer is
     still watching. */
  function fetchServerPng() {
    if (!window.fetch) return Promise.reject(new Error('no fetch'));

    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, API_TIMEOUT);

    return fetch(API_ENDPOINT + '?t=' + Date.now(), {
      signal: ctrl ? ctrl.signal : undefined,
      cache: 'no-store'
    })
      .then(function (res) {
        if (!res.ok) throw new Error('api ' + res.status);
        return res.blob();
      })
      .then(function (blob) {
        /* An error page served with a 200 would otherwise be "downloaded" as
           a broken .png. */
        if (!blob || blob.type.indexOf('image/png') !== 0 || blob.size < 1024) {
          throw new Error('api returned non-image');
        }
        return blob;
      })
      .finally(function () { clearTimeout(timer); });
  }

  /* toDataURL on a 1380 x ~2100 canvas produces a multi-megabyte base64
     string, and assigning that to an anchor href fails silently on iOS
     Safari - the platform the owner's staff actually share from. A Blob URL
     works everywhere, and Web Share hands the file straight to WhatsApp. */
  function deliver(blob, filename) {
    var file = null;
    try {
      if (window.File && navigator.canShare) file = new File([blob], filename, { type: 'image/png' });
    } catch (e) { /* File constructor unsupported */ }

    if (file && navigator.canShare({ files: [file] }) && navigator.share) {
      return navigator.share({ files: [file] }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        return saveBlob(blob, filename);
      });
    }
    return saveBlob(blob, filename);
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.download = filename;
    link.href = url;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    /* revoking immediately cancels the download in some browsers */
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    return Promise.resolve();
  }

  /* ---- public entry point --------------------------------------------- */
  FZ.initPoster = function (opts) {
    opts = opts || {};
    var stage = document.querySelector(opts.stage || '.poster-stage');
    var poster = document.getElementById('poster');
    var btn = document.querySelector(opts.button || '#downloadBtn');
    if (!poster) return;

    poster.innerHTML = chrome();

    var listEl = poster.querySelector('#fzPlist');
    var dateEl = poster.querySelector('#fzDateRow');
    if (dateEl) dateEl.textContent = AR.pricesOf + FZ.formatDate();

    if (EXPORT_MODE) {
      stripToPoster(poster);
    } else {
      fitStage(stage);
      var rt;
      window.addEventListener('resize', function () {
        clearTimeout(rt);
        rt = setTimeout(function () { fitStage(stage); }, 120);
      });
    }

    var btnLabel = btn ? btn.innerHTML : '';
    function setBusy(text) {
      if (!btn) return;
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      btn.textContent = text;
    }
    function setReady() {
      if (!btn) return;
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.innerHTML = btnLabel;
    }
    function setDead(text) {
      if (!btn) return;
      btn.disabled = true;
      btn.removeAttribute('aria-busy');
      btn.textContent = text;
    }
    function msg(text) {
      listEl.innerHTML = '<div class="plist-msg">' + FZ.escapeHtml(text) + '</div>';
      listEl.setAttribute('aria-busy', 'false');
    }
    function warn(text) {
      if (typeof opts.onWarn === 'function') opts.onWarn(text);
      else console.warn('Fresh Zone:', text);
    }

    /* Canvas taint is a browser security rule on file://, not a bug: any image
       drawn from a local path poisons toBlob. Say so instead of failing. */
    var isLocal = location.protocol === 'file:';

    /* The button stays disabled until data, images, fonts AND html2canvas have
       all settled. It used to be live from first paint, so a fast click
       downloaded a poster whose grid read "loading...". */
    setBusy(AR.preparing);

    /* In export mode the server is the renderer, so html2canvas is dead weight
       - and a CDN it cannot reach would stall the screenshot behind a network
       timeout. On the live page it is still loaded, but no longer fatal: it is
       only the fallback now, so a CDN outage must not disable the button. */
    var libReady = (isLocal || EXPORT_MODE)
      ? Promise.resolve()
      : loadScript(HTML2CANVAS_SRC).catch(function (e) {
          console.warn('Fresh Zone: html2canvas failed to load; server export only.', e);
        });

    var sb = FZ.client();
    var dataReady;

    if (!sb) {
      msg(AR.noServer);
      dataReady = Promise.reject(new Error('no supabase client'));
    } else {
      dataReady = Promise.all([
        sb.from('market_settings').select('*').eq('id', 1).single(),
        sb.from('products').select('*').eq('is_available', true).order('sort_order', { ascending: true })
      ]).then(function (res) {
        var settings = res[0].data;
        var products = res[1].data;
        if (res[1].error) throw res[1].error;
        if (!products || !products.length) {
          msg(AR.empty);
          var stop = new Error('empty');
          stop.fzHandled = true;
          throw stop;
        }
        var basePrice = settings ? settings.base_price : null;
        if (basePrice === null || basePrice === undefined) {
          console.warn('Fresh Zone: market_settings.base_price is not set; prices will show as dots.');
        }
        listEl.innerHTML = products.map(function (p) { return rowHtml(p, basePrice); }).join('');
        listEl.setAttribute('aria-busy', 'false');
        return Promise.all([settleImages(listEl), awaitImages(poster)]);
      });
    }

    Promise.all([dataReady, fontsReady(), libReady])
      .then(function () {
        /* Raising the flag any earlier lets the server screenshot land
           mid-reflow. */
        if (EXPORT_MODE) {
          return settleFrames().then(function () { window[READY_FLAG] = true; });
        }
        if (isLocal) { setDead(AR.dlLocal); return; }
        setReady();
      })
      .catch(function (e) {
        if (!e || !e.fzHandled) {
          console.warn('Fresh Zone: price list unavailable.', e);
          if (listEl && !listEl.querySelector('.plist-msg')) msg(AR.failed);
        }
        /* Tell the server why, so it fails fast with a real reason instead of
           timing out on a flag that will never be set. */
        if (EXPORT_MODE) { window.__fzPosterError = String((e && e.message) || e); return; }
        setDead(AR.dlOff);
      });

    if (EXPORT_MODE) return;

    if (btn) {
      btn.addEventListener('click', function () {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        /* Tuned to the measured server render. A cached poster beats it and
           the bar simply never gets going; a cold start overruns it and the
           bar says so. Both are better than a silent grey button. */
        var stopProgress = startProgress(btn, 12);

        /* Server first. Only if it cannot deliver do we fall back to painting
           the poster in the browser, which is the path with the known
           fidelity limits. */
        fetchServerPng()
          .catch(function (e) {
            console.warn('Fresh Zone: server export unavailable, using browser fallback.', e);
            if (!window.html2canvas) throw e;
            return rasterise(poster).then(function (out) {
              if (out.degraded) warn(AR.imgWarnA + out.degraded + AR.imgWarnB);
              return canvasToBlob(out.canvas);
            });
          })
          .then(function (blob) {
            return deliver(blob, 'fresh-zone-price-list-' + FZ.dateSlug() + '.png');
          })
          .catch(function (e) {
            console.error('Fresh Zone: export failed.', e);
            window.alert(AR.exportErr);
          })
          /* Order matters: stopProgress tears down the bar it built, and
             setReady then restores the button's original icon and label. */
          .finally(function () {
            stopProgress();
            setReady();
          });
      });
    }
  };
})();
