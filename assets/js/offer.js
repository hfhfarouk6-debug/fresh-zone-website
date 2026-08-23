/* Fresh Zone - offer image generator.
   Builds one 1080x1350 social image per four products, priced from the same
   formula the poster and the dashboard use, so an offer image can never quote
   a number the website disagrees with. Regenerated on every load rather than
   saved, because the prices move daily. */
(function () {
  'use strict';

  var PER_IMAGE = 4;
  var PHONE = '010 2757 2394';

  var boardsEl = document.getElementById('boards');
  var statusEl = document.getElementById('status');
  var kilosEl = document.getElementById('kilos');
  var discountEl = document.getElementById('discount');
  var applyBtn = document.getElementById('applyBtn');

  var products = [];
  var basePrice = null;

  function say(t) { statusEl.textContent = t; }

  function arabicDigits(n) {
    return String(n).replace(/[0-9]/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'[+d]; });
  }

  function chunk(arr, n) {
    var out = [];
    for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  function cardHtml(p, kilos, discount) {
    var unit = FZ.roundPrice(FZ.computeFinalPrice(p, basePrice));
    if (unit === null) return '';
    var total = unit * kilos;
    var after = Math.max(0, total - discount);
    var img = p.image_url
      ? '<img src="' + FZ.escapeHtml(p.image_url) + '" alt="" crossorigin="anonymous">'
      : '<div style="height:178px;background:#12202f"></div>';

    return '<div class="b-card">' + img +
      '<div class="b-body">' +
        '<div class="b-name">' + FZ.escapeHtml(p.name_ar) + '</div>' +
        '<div class="b-unit">الكيلو ' + FZ.formatPrice(unit) + ' ج.م</div>' +
        '<div class="b-boxes">' +
          '<div class="b-box b-old"><span class="lbl">' + arabicDigits(kilos) + ' كيلو</span>' +
            '<span class="val">' + FZ.formatPrice(total) + '</span></div>' +
          '<div class="b-box b-new"><span class="lbl">بعد الخصم</span>' +
            '<span class="val">' + FZ.formatPrice(after) + '</span></div>' +
        '</div>' +
      '</div></div>';
  }

  function boardHtml(group, kilos, discount) {
    return '<div class="board">' +
      '<div class="b-head">' +
        '<span class="b-pill">عرض النهاردة</span>' +
        '<div class="b-h1">عرض <span>' + arabicDigits(kilos) + ' كيلو</span></div>' +
        '<div class="b-loc">جاردينيا سيتي · توصيل لباب البيت</div>' +
      '</div>' +
      '<div class="b-grid">' + group.map(function (p) {
        return cardHtml(p, kilos, discount);
      }).join('') + '</div>' +
      '<div class="b-foot">' +
        '<div class="b-note">أسعار يوم ' + FZ.formatDate() + ' · بنجهّز ونقطّع في نفس اليوم</div>' +
        '<div class="b-cta"><span class="lbl">اطلب على واتساب</span>' +
          '<span class="num">' + PHONE + '</span></div>' +
      '</div>' +
      '<div class="b-logo"></div>' +
    '</div>';
  }

  /* The preview is a scaled wrapper, never a scaled board: html2canvas measures
     the element's own box, so a transform on the board itself would export a
     cropped or stretched image. */
  function fitScalers() {
    var w = boardsEl.clientWidth || 600;
    var k = Math.min(1, w / 1080);
    Array.prototype.forEach.call(boardsEl.querySelectorAll('.scaler'), function (s) {
      s.style.transform = 'scale(' + k + ')';
      s.parentNode.style.height = Math.round(1350 * k) + 'px';
    });
  }

  function render() {
    var kilos = Math.max(1, Number(kilosEl.value) || 1);
    var discount = Math.max(0, Number(discountEl.value) || 0);
    var groups = chunk(products, PER_IMAGE);

    boardsEl.innerHTML = groups.map(function (g, i) {
      return '<div class="item">' +
        '<div class="item-bar"><b>صورة ' + arabicDigits(i + 1) + ' من ' +
          arabicDigits(groups.length) + '</b>' +
          '<button class="btn" type="button" data-dl="' + i + '">تحميل الصورة</button></div>' +
        '<div class="frame"><div class="scaler">' + boardHtml(g, kilos, discount) + '</div></div>' +
      '</div>';
    }).join('');

    fitScalers();

    Array.prototype.forEach.call(boardsEl.querySelectorAll('[data-dl]'), function (b) {
      b.addEventListener('click', function () { download(Number(b.dataset.dl), b); });
    });

    say('جاهزة — ' + arabicDigits(groups.length) + ' صور، ' +
        arabicDigits(products.length) + ' صنف.');
  }

  function download(index, btn) {
    var item = boardsEl.querySelectorAll('.item')[index];
    var scaler = item.querySelector('.scaler');
    var frame = item.querySelector('.frame');
    var board = item.querySelector('.board');
    var label = btn.textContent;

    btn.disabled = true; btn.textContent = 'بيتم التجهيز...';

    /* Un-scale for the capture, then put it straight back. Without this the
       exported PNG comes out at the preview size, not 1080x1350. */
    var savedTransform = scaler.style.transform;
    var savedHeight = frame.style.height;
    scaler.style.transform = 'none';
    frame.style.height = '1350px';
    frame.style.overflow = 'hidden';

    html2canvas(board, {
      scale: 2, useCORS: true, backgroundColor: '#030C13',
      width: 1080, height: 1350, windowWidth: 1080, windowHeight: 1350
    }).then(function (canvas) {
      canvas.toBlob(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'fresh-zone-offer-' + FZ.dateSlug() + '-' + (index + 1) + '.png';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      }, 'image/png');
    }).catch(function (e) {
      console.error(e);
      say('حصل خطأ في تجهيز الصورة، جرّب تاني.');
    }).then(function () {
      scaler.style.transform = savedTransform;
      frame.style.height = savedHeight;
      btn.disabled = false; btn.textContent = label;
    });
  }

  applyBtn.addEventListener('click', render);
  window.addEventListener('resize', fitScalers);

  /* Read-only page: never carry the dashboard login (see FZ.publicClient). */
  var sb = FZ.publicClient ? FZ.publicClient() : FZ.client();
  if (!sb) { say('تعذّر الاتصال بالسيرفر.'); return; }

  Promise.all([
    FZ.syncClock(),
    sb.from('market_settings').select('*').eq('id', 1).single(),
    sb.from('products').select('*').eq('is_available', true).order('sort_order', { ascending: true })
  ]).then(function (res) {
    var settings = res[1].data;
    if (res[2].error) throw res[2].error;
    products = res[2].data || [];
    basePrice = settings ? settings.base_price : null;
    if (!products.length) { say('مفيش أصناف متاحة.'); return; }
    render();
  }).catch(function (e) {
    console.error(e);
    say('تعذّر تحميل الأصناف.');
  });
})();
