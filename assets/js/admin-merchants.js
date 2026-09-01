/* Fresh Zone - merchant (wholesale trader) price list admin panel.
   Deliberately a SEPARATE table (merchant_products) and a SEPARATE page from
   the customer catalog, not a filter/flag on `products`:
     1. Farouk asked for a list he controls independently, the same way he
        controls the customer list - not a hidden toggle bolted onto it.
     2. `merchant_products` has no RLS policy for the `anon` role at all
        (see the create_merchant_products_table migration), so it is
        provably unreachable from the public site and the customer poster,
        not merely unlisted. Folding it into `products` would have forced a
        `visible_to` column instead, and one bug in that filter would leak
        trader prices to a customer.

   CRUD logic below mirrors admin.js closely on purpose (same pricing engine,
   same validation, same reorder/upload UX) so this page behaves exactly the
   way Farouk already knows from the products page. The one real addition is
   the "download list image" button at the bottom of the file - there is no
   server-side export for this list (the existing /api/poster function is
   hardcoded to the public, unauthenticated pricelist.html and cannot see
   this table), so the image is built and rendered entirely in the browser
   with html2canvas, on demand, only after Farouk is logged in. */
(function () {
  'use strict';

  var sb = FZ.client();
  var loginScreen = document.getElementById('loginScreen');
  var adminScreen = document.getElementById('adminScreen');
  var sessionWarn = document.getElementById('sessionWarn');
  var toastEl = document.getElementById('toast');

  var TABLE = 'merchant_products';

  var products = [];          /* the live rows, kept in memory */
  var currentBasePrice = null;
  var basePriceFailed = false;

  var MAX_UPLOAD = 5 * 1024 * 1024;
  var ALLOWED = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

  function toast(msg, isErr) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('err', !!isErr);
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
  }

  /* ---------- AUTH ---------- */
  function showLogin() {
    loginScreen.style.display = 'flex';
    adminScreen.style.display = 'none';
  }
  function showAdmin() {
    loginScreen.style.display = 'none';
    adminScreen.style.display = 'block';
  }

  function checkSession() {
    return sb.auth.getSession().then(function (res) {
      if (res.data && res.data.session) {
        sessionWarn.classList.remove('show');
        showAdmin();
        return loadProducts();
      }
      showLogin();
    });
  }

  sb.auth.onAuthStateChange(function (event) {
    if (event === 'SIGNED_OUT') {
      showLogin();
    } else if (event === 'TOKEN_REFRESHED') {
      sessionWarn.classList.remove('show');
    }
  });

  document.getElementById('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = document.getElementById('loginBtn');
    var err = document.getElementById('loginErr');
    err.textContent = '';
    btn.disabled = true; btn.textContent = 'بيتم الدخول...';
    sb.auth.signInWithPassword({
      email: document.getElementById('loginEmail').value.trim(),
      password: document.getElementById('loginPassword').value
    }).then(function (res) {
      btn.disabled = false; btn.textContent = 'دخول';
      if (res.error) { err.textContent = 'الإيميل أو كلمة السر غلط.'; return; }
      checkSession();
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('.logout-btn'), function (btn) {
    btn.addEventListener('click', function () {
      sb.auth.signOut().then(checkSession);
    });
  });

  function isAuthError(error) {
    if (!error) return false;
    var s = String(error.status || '');
    var m = String(error.message || '').toLowerCase();
    return s === '401' || s === '403' || m.indexOf('jwt') > -1 || m.indexOf('expired') > -1;
  }
  function reportError(error, fallback) {
    if (isAuthError(error)) {
      sessionWarn.classList.add('show');
      toast('الجلسة انتهت، سجّل دخولك تاني', true);
      showLogin();
    } else {
      toast(fallback, true);
    }
    console.error('Fresh Zone admin-merchants:', error);
  }

  /* ---------- MARKET BASE PRICE (read-only here - edited from admin.html) --
     Same market_settings row the customer list uses. One bourse price feeds
     both lists; only the markup per item differs, which is exactly why this
     page has no "save price" button of its own - two editable copies of the
     same number is how they drift. */
  function loadMarketPrice() {
    return sb.from('market_settings').select('*').eq('id', 1).single().then(function (res) {
      var upd = document.getElementById('marketUpdated');
      var statBase = document.getElementById('statBase');

      if (res.error || !res.data) {
        basePriceFailed = true;
        currentBasePrice = null;
        statBase.textContent = '—';
        upd.textContent = 'تعذّر تحميل سعر البورصة';
        reportError(res.error, 'تعذّر تحميل سعر البورصة');
        return;
      }
      basePriceFailed = false;
      var data = res.data;
      currentBasePrice = data.base_price;
      statBase.textContent = data.base_price == null ? '—' : FZ.formatPrice(data.base_price);
      upd.textContent = data.updated_at
        ? 'آخر تحديث: ' + FZ.formatDateTime(new Date(data.updated_at))
        : '';
    });
  }

  /* ---------- PRODUCTS ---------- */
  function loadProducts() {
    var body = document.getElementById('productsBody');
    var empty = document.getElementById('emptyState');
    body.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:#5c5346;">بيتم التحميل...</td></tr>';

    return loadMarketPrice().then(function () {
      return sb.from(TABLE).select('*').order('sort_order', { ascending: true });
    }).then(function (res) {
      if (res.error) {
        body.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:#b3364a;">تعذّر تحميل الأصناف</td></tr>';
        reportError(res.error, 'حصل خطأ في تحميل الأصناف');
        return;
      }
      products = res.data || [];
      document.getElementById('statTotal').textContent = products.length;
      document.getElementById('statAvailable').textContent =
        products.filter(function (p) { return p.is_available; }).length;

      if (!products.length) {
        body.innerHTML = '';
        empty.style.display = 'block';
        return;
      }
      empty.style.display = 'none';
      renderRows();
    });
  }

  function renderRows() {
    var body = document.getElementById('productsBody');
    body.innerHTML = products.map(rowHtml).join('');

    Array.prototype.forEach.call(body.querySelectorAll('[data-edit]'), function (b) {
      b.addEventListener('click', function () {
        openModal(products.filter(function (p) { return String(p.id) === b.dataset.edit; })[0]);
      });
    });
    Array.prototype.forEach.call(body.querySelectorAll('[data-del]'), function (b) {
      b.addEventListener('click', function () {
        var p = products.filter(function (x) { return String(x.id) === b.dataset.del; })[0];
        if (p) askDelete(p);
      });
    });
    Array.prototype.forEach.call(body.querySelectorAll('[data-move-up]'), function (b) {
      b.addEventListener('click', function () { moveProduct(b.dataset.moveUp, -1); });
    });
    Array.prototype.forEach.call(body.querySelectorAll('[data-move-down]'), function (b) {
      b.addEventListener('click', function () { moveProduct(b.dataset.moveDown, 1); });
    });
    bindDrag(body);
  }

  function markupLabel(p) {
    return p.markup_type === 'percent'
      ? '× ' + (p.markup_value == null ? 0 : p.markup_value)
      : '+' + (p.markup_value == null ? 0 : p.markup_value) + ' ج.م';
  }

  var ARROW_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>';
  var ARROW_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  var GRIP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';

  var reordering = false;

  function indexOfId(id) {
    var i = -1;
    products.forEach(function (p, idx) { if (String(p.id) === String(id)) i = idx; });
    return i;
  }

  function persistOrder(reordered) {
    if (reordering) return;
    reordering = true;

    var writes = [];
    reordered.forEach(function (p, idx) {
      var want = idx + 1;
      if (p.sort_order !== want) {
        p.sort_order = want;
        writes.push(sb.from(TABLE).update({ sort_order: want }).eq('id', p.id));
      }
    });

    products = reordered;
    renderRows();

    if (!writes.length) { reordering = false; return; }

    Promise.all(writes).then(function (results) {
      reordering = false;
      var failed = results.filter(function (r) { return r && r.error; })[0];
      if (failed) { reportError(failed.error, 'تعذّر حفظ الترتيب'); loadProducts(); return; }
      toast('الترتيب اتحفظ');
    }).catch(function (err) {
      reordering = false;
      reportError(err, 'تعذّر حفظ الترتيب');
      loadProducts();
    });
  }

  function moveProduct(id, dir) {
    var i = indexOfId(id);
    var j = i + dir;
    if (i < 0 || j < 0 || j >= products.length) return;
    var reordered = products.slice();
    var tmp = reordered[i]; reordered[i] = reordered[j]; reordered[j] = tmp;
    persistOrder(reordered);
  }

  var dragId = null;

  function clearDropMarks(body) {
    Array.prototype.forEach.call(body.querySelectorAll('.drop-before, .drop-after'), function (el) {
      el.classList.remove('drop-before', 'drop-after');
    });
  }

  function bindDrag(body) {
    Array.prototype.forEach.call(body.querySelectorAll('tr[data-id]'), function (tr) {
      tr.addEventListener('dragstart', function (e) {
        if (reordering) { e.preventDefault(); return; }
        dragId = tr.dataset.id;
        tr.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', dragId); } catch (err) {}
        }
      });

      tr.addEventListener('dragend', function () {
        tr.classList.remove('dragging');
        clearDropMarks(body);
        dragId = null;
      });

      tr.addEventListener('dragover', function (e) {
        if (dragId === null || tr.dataset.id === dragId) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        var rect = tr.getBoundingClientRect();
        var after = (e.clientY - rect.top) > rect.height / 2;
        clearDropMarks(body);
        tr.classList.add(after ? 'drop-after' : 'drop-before');
      });

      tr.addEventListener('dragleave', function () {
        tr.classList.remove('drop-before', 'drop-after');
      });

      tr.addEventListener('drop', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (dragId === null || tr.dataset.id === dragId) return;

        var after = tr.classList.contains('drop-after');
        var from = indexOfId(dragId);
        var targetRow = products[indexOfId(tr.dataset.id)];
        clearDropMarks(body);
        dragId = null;
        if (from < 0 || !targetRow) return;

        var arr = products.slice();
        var moved = arr.splice(from, 1)[0];
        var at = arr.indexOf(targetRow) + (after ? 1 : 0);
        arr.splice(at, 0, moved);
        persistOrder(arr);
      });
    });
  }

  function rowHtml(p, i, arr) {
    var priceStr = FZ.formatPrice(FZ.computeFinalPrice(p, currentBasePrice));
    var priceLabel = priceStr === null ? '—' : priceStr + ' ج.م';
    var override = (p.price !== null && p.price !== undefined)
      ? '<span class="override-note">سعر يدوي</span>' : '';
    var thumb = p.image_url
      ? '<img src="' + FZ.escapeHtml(p.image_url) + '" alt="">'
      : '<div class="no-img"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m21 15-5-5L5 21"/></svg></div>';

    return '<tr draggable="true" data-id="' + FZ.escapeHtml(p.id) + '">' +
      '<td class="thumb">' + thumb + '</td>' +
      '<td><b>' + FZ.escapeHtml(p.name_ar) + '</b>' +
        '<span class="name-en" dir="ltr">' + FZ.escapeHtml(p.name_en || '') + '</span></td>' +
      '<td>' + markupLabel(p) + override + '</td>' +
      '<td><b>' + priceLabel + '</b></td>' +
      '<td><span class="badge ' + (p.is_available ? 'on' : 'off') + '">' +
        (p.is_available ? 'ظاهر' : 'مخفي') + '</span></td>' +
      '<td><div class="sort-cell">' +
        '<span class="grip" aria-hidden="true" title="اسحب لتغيير الترتيب">' + GRIP + '</span>' +
        '<button class="icon-btn move" type="button" data-move-up="' + FZ.escapeHtml(p.id) + '"' +
          (i === 0 ? ' disabled' : '') + ' aria-label="حرّك لفوق" title="حرّك لفوق">' + ARROW_UP + '</button>' +
        '<span class="sort-num">' + (i + 1) + '</span>' +
        '<button class="icon-btn move" type="button" data-move-down="' + FZ.escapeHtml(p.id) + '"' +
          (i === arr.length - 1 ? ' disabled' : '') + ' aria-label="حرّك لتحت" title="حرّك لتحت">' + ARROW_DOWN + '</button>' +
      '</div></td>' +
      '<td><div class="row-actions">' +
        '<button class="icon-btn" type="button" data-edit="' + FZ.escapeHtml(p.id) + '">تعديل</button>' +
        '<button class="icon-btn danger" type="button" data-del="' + FZ.escapeHtml(p.id) + '">حذف</button>' +
      '</div></td>' +
    '</tr>';
  }

  /* ---------- MODAL ---------- */
  var overlay = document.getElementById('modalOverlay');
  var form = document.getElementById('productForm');
  var lastFocused = null;
  var pendingObjectUrl = null;
  var previewBeforeUpload = null;

  var $ = function (id) { return document.getElementById(id); };

  function currentDraft() {
    var priceVal = $('price').value;
    return {
      price: priceVal === '' ? null : Number(priceVal),
      markup_type: $('markupType').value,
      markup_value: Number($('markupValue').value) || 0
    };
  }

  function validateDraft(d) {
    if (d.price !== null && (!isFinite(d.price) || d.price < 0)) return 'السعر اليدوي لازم يكون رقم موجب.';
    if (d.price !== null) return null;
    if (d.markup_type === 'percent') {
      if (!(d.markup_value >= 1 && d.markup_value <= 5)) {
        return 'معامل الضرب لازم يكون بين 1 و 5 (يعني 1.15 = زيادة 15%). لو عايز تضيف مبلغ ثابت، غيّر النوع.';
      }
    } else if (d.markup_value < 0 || d.markup_value > 200) {
      return 'المبلغ الثابت لازم يكون بين 0 و 200 جنيه.';
    }
    return null;
  }

  function refreshPreview() {
    var d = currentDraft();
    var box = $('pricePreview');
    var out = $('pricePreviewVal');
    var hint = $('markupHint');

    var manual = d.price !== null;
    $('markupType').disabled = manual;
    $('markupValue').disabled = manual;
    ['markupType', 'markupValue'].forEach(function (id) {
      var wrap = $(id).closest ? $(id).closest('.field') : null;
      if (wrap) wrap.style.opacity = manual ? '0.45' : '';
    });

    hint.textContent = manual
      ? 'الصنف ده على سعر يدوي — البورصة والمعامل مش بيأثروا عليه. فضّي خانة السعر اليدوي عشان يرجع للحسبة.'
      : (d.markup_type === 'percent'
        ? 'مثال: البورصة 62 → 62+5 = 67، والمعامل 1.1 → 67 × 1.1 = 74 ج.م.'
        : 'مثال: البورصة 62 → 62+5 = 67، والمبلغ 8 → 67 + 8 = 75 ج.م.');

    var problem = validateDraft(d);
    if (problem) { box.classList.add('warn'); out.textContent = '—'; return; }

    var val = FZ.formatPrice(FZ.computeFinalPrice(d, currentBasePrice));
    box.classList.toggle('warn', val === null);
    out.textContent = val === null
      ? (basePriceFailed ? 'سعر البورصة مش متحمّل' : 'حدّد سعر البورصة من صفحة المنتجات الأول')
      : val + ' ج.م';
  }

  ['price', 'markupValue', 'markupType'].forEach(function (id) {
    $(id).addEventListener('input', refreshPreview);
    $(id).addEventListener('change', refreshPreview);
  });

  $('markupType').addEventListener('change', function () {
    if (this.value === 'percent' && Number($('markupValue').value) < 1) $('markupValue').value = '1';
    if (this.value === 'fixed' && Number($('markupValue').value) === 1) $('markupValue').value = '0';
    refreshPreview();
  });

  /* 84px frame with a 2.5px border => 79px content box. Bigger than the
     poster's 51px on purpose: same geometry, easier to judge by eye. */
  var ZOOM_PREVIEW_BOX = 79;

  /* Mirrors exactly what the poster will do with this photo. Hidden entirely
     when there is no image, because a zoom control over an empty circle just
     invites the question of what it does. */
  function refreshZoomPreview() {
    var url = $('imageUrl').value.trim();
    var field = $('zoomField'), img = $('zoomPreviewImg');
    var zoom = FZ.normalizePhotoZoom($('photoZoom').value);
    $('photoZoomVal').textContent = zoom.toFixed(2) + '×';

    if (!url) { field.style.display = 'none'; img.removeAttribute('src'); return; }
    field.style.display = '';

    function apply() { FZ.applyCover(img, ZOOM_PREVIEW_BOX, zoom); }
    if (img.getAttribute('src') !== url) {
      img.addEventListener('load', apply, { once: true });
      img.setAttribute('src', url);
    }
    /* Already loaded (cached, or only the zoom moved): re-frame immediately. */
    if (img.complete && img.naturalWidth) apply();
  }

  $('photoZoom').addEventListener('input', refreshZoomPreview);

  function openModal(p) {
    lastFocused = document.activeElement;
    $('modalTitle').textContent = p ? 'تعديل صنف' : 'إضافة صنف';
    $('productId').value = p ? p.id : '';
    $('nameAr').value = p ? (p.name_ar || '') : '';
    $('nameEn').value = p ? (p.name_en || '') : '';
    $('markupType').value = p ? (p.markup_type || 'fixed') : 'fixed';
    $('markupValue').value = p && p.markup_value != null ? p.markup_value : 0;
    $('price').value = p && p.price != null ? p.price : '';
    $('sortOrder').value = p && p.sort_order != null ? p.sort_order : (products.length + 1);
    $('imageUrl').value = p ? (p.image_url || '') : '';
    $('isAvailable').checked = p ? !!p.is_available : true;
    $('imgFile').value = '';
    $('formErr').textContent = '';
    $('uploadStatus').textContent = 'JPG أو PNG أو WEBP، حد أقصى 5 ميجا';
    $('uploadStatus').className = 'hint';

    var preview = $('imgPreview'), placeholder = $('uploadPlaceholder');
    if (p && p.image_url) {
      preview.src = p.image_url; preview.style.display = 'block'; placeholder.style.display = 'none';
    } else {
      preview.removeAttribute('src'); preview.style.display = 'none'; placeholder.style.display = 'flex';
    }
    previewBeforeUpload = { src: preview.getAttribute('src') || '', url: $('imageUrl').value };

    $('photoZoom').value = p && p.photo_zoom != null ? FZ.normalizePhotoZoom(p.photo_zoom) : 1;
    refreshZoomPreview();

    refreshPreview();
    overlay.classList.add('show');
    $('nameAr').focus();
  }

  function closeModal() {
    overlay.classList.remove('show');
    form.reset();
    releaseObjectUrl();
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  function releaseObjectUrl() {
    if (pendingObjectUrl) { URL.revokeObjectURL(pendingObjectUrl); pendingObjectUrl = null; }
  }

  $('addBtn').addEventListener('click', function () { openModal(null); });
  $('cancelBtn').addEventListener('click', closeModal);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (overlay.classList.contains('show')) closeModal();
    else if (confirmOverlay.classList.contains('show')) closeConfirm();
  });

  /* ---------- IMAGE UPLOAD (same product-images bucket as the customer
     catalog - it is already public-read/authenticated-write, and a photo by
     itself does not disclose a wholesale price, so a second bucket would add
     nothing) ---------- */
  $('imgFile').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;

    var preview = $('imgPreview'), placeholder = $('uploadPlaceholder'), status = $('uploadStatus');

    function fail(msg) {
      status.textContent = msg;
      status.className = 'hint err';
      e.target.value = '';
      releaseObjectUrl();
      if (previewBeforeUpload && previewBeforeUpload.src) {
        preview.src = previewBeforeUpload.src;
        preview.style.display = 'block';
        placeholder.style.display = 'none';
      } else {
        preview.removeAttribute('src');
        preview.style.display = 'none';
        placeholder.style.display = 'flex';
      }
      $('imageUrl').value = previewBeforeUpload ? previewBeforeUpload.url : '';
      refreshZoomPreview();   /* rolled back to the previous photo, or to none */
      toast(msg, true);
    }

    var ext = ALLOWED[file.type];
    if (!ext) { fail('لازم صورة JPG أو PNG أو WEBP'); return; }
    if (file.size > MAX_UPLOAD) { fail('الصورة أكبر من 5 ميجا'); return; }

    releaseObjectUrl();
    pendingObjectUrl = URL.createObjectURL(file);
    preview.src = pendingObjectUrl;
    preview.style.display = 'block';
    placeholder.style.display = 'none';
    status.textContent = 'بيتم الرفع...';
    status.className = 'hint ok';

    var uid = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));

    sb.storage.from('product-images').upload('merchant-' + uid + '.' + ext, file, {
      cacheControl: '3600', upsert: false, contentType: file.type
    }).then(function (res) {
      if (res.error) { fail('حصل خطأ في الرفع، جرب تاني'); console.error(res.error); return; }
      var pub = sb.storage.from('product-images').getPublicUrl('merchant-' + uid + '.' + ext);
      $('imageUrl').value = pub.data.publicUrl;
      refreshZoomPreview();   /* a new photo needs re-framing at the current zoom */
      status.textContent = 'اترفعت بنجاح';
      status.className = 'hint ok';
    }).catch(function (err) {
      fail('حصل خطأ في الرفع، جرب تاني');
      console.error(err);
    });
  });

  /* ---------- SAVE ---------- */
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var saveBtn = $('saveBtn');
    var errEl = $('formErr');
    errEl.textContent = '';

    var draft = currentDraft();
    var problem = validateDraft(draft);
    if (problem) { errEl.textContent = problem; return; }

    var name = $('nameAr').value.trim();
    if (!name) { errEl.textContent = 'اكتب اسم الصنف بالعربي.'; return; }

    saveBtn.disabled = true; saveBtn.textContent = 'بيتم الحفظ...';
    var id = $('productId').value;
    var payload = {
      name_ar: name,
      name_en: $('nameEn').value.trim() || null,
      price: draft.price,
      markup_type: draft.markup_type,
      markup_value: draft.markup_value,
      sort_order: Number($('sortOrder').value) || 0,
      image_url: $('imageUrl').value.trim() || null,
      photo_zoom: FZ.normalizePhotoZoom($('photoZoom').value),
      is_available: $('isAvailable').checked
    };

    var q = id
      ? sb.from(TABLE).update(payload).eq('id', id)
      : sb.from(TABLE).insert(payload);

    q.then(function (res) {
      saveBtn.disabled = false; saveBtn.textContent = 'حفظ';
      if (res.error) {
        errEl.textContent = res.error.message || 'حصل خطأ، جرب تاني';
        reportError(res.error, 'حصل خطأ، جرب تاني');
        return;
      }
      closeModal();
      toast('اتحفظ بنجاح');
      loadProducts();
    });
  });

  /* ---------- DELETE ---------- */
  var confirmOverlay = document.getElementById('confirmOverlay');
  var pendingDelete = null;

  function askDelete(p) {
    pendingDelete = p;
    document.getElementById('confirmBody').textContent =
      'هتشيل "' + p.name_ar + '" نهائيًا من قائمة التجار. مش هينفع ترجعه.';
    confirmOverlay.classList.add('show');
    document.getElementById('confirmCancel').focus();
  }
  function closeConfirm() {
    confirmOverlay.classList.remove('show');
    pendingDelete = null;
  }
  document.getElementById('confirmCancel').addEventListener('click', closeConfirm);
  confirmOverlay.addEventListener('click', function (e) { if (e.target === confirmOverlay) closeConfirm(); });
  document.getElementById('confirmOk').addEventListener('click', function () {
    if (!pendingDelete) return;
    var btn = this;
    btn.disabled = true; btn.textContent = 'بيتم الحذف...';
    sb.from(TABLE).delete().eq('id', pendingDelete.id).then(function (res) {
      btn.disabled = false; btn.textContent = 'احذف';
      if (res.error) { reportError(res.error, 'حصل خطأ في الحذف'); return; }
      closeConfirm();
      toast('اتشال');
      loadProducts();
    });
  });

  /* ---------- DOWNLOAD LIST IMAGE ----------------------------------------
     Builds a branded poster off-screen from the CURRENT in-memory list
     (only items with is_available) and rasterises it with html2canvas. This
     never touches /api/poster: that function is unauthenticated and
     hardcoded to pricelist.html, so it cannot see this table, and routing
     trader prices through a public, unauthenticated endpoint would defeat
     the whole point of this page. Everything here runs client-side, after
     Farouk's own login, and the file goes straight to his downloads folder -
     he sends it on to traders himself over WhatsApp. */
  var HTML2CANVAS_SRC = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
  var POSTER_WIDTH = 720;

  function loadHtml2Canvas() {
    if (window.html2canvas) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = HTML2CANVAS_SRC;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('html2canvas failed to load')); };
      document.head.appendChild(s);
    });
  }

  function posterRowHtml(p) {
    var priceStr = FZ.formatPrice(FZ.computeFinalPrice(p, currentBasePrice));
    var priceLabel = priceStr === null ? '—' : priceStr;
    /* data-fzphoto marks the photos that get cover geometry once loaded; the
       logo and icons in the same poster must NOT be touched. The frame needs
       position:relative because that geometry is absolutely positioned. */
    var photo = p.image_url
      ? '<img src="' + FZ.escapeHtml(p.image_url) + '" alt="" crossorigin="anonymous"' +
        ' data-fzphoto="1" data-zoom="' + FZ.normalizePhotoZoom(p.photo_zoom) + '">'
      : '';
    return (
      '<div style="display:flex; align-items:center; gap:14px; padding:11px 16px; background:#FFFDF9; border:1px solid rgba(28,23,16,.08); border-radius:14px;">' +
        '<div style="position:relative; width:56px; height:56px; border-radius:50%; overflow:hidden; flex-shrink:0; border:2.5px solid #E6B25A; background:#0c1c2b;">' + photo + '</div>' +
        '<div style="flex:1; min-width:0;">' +
          '<div style="font-size:16px; font-weight:800; color:#030C13; line-height:1.2;">' + FZ.escapeHtml(p.name_ar) + '</div>' +
          (p.name_en ? '<div style="margin-top:2px; font-size:10px; font-weight:700; color:#0665BD; direction:ltr; text-align:right; letter-spacing:.3px; text-transform:uppercase;">' + FZ.escapeHtml(p.name_en) + '</div>' : '') +
        '</div>' +
        '<div style="flex-shrink:0; text-align:center; background:#0665BD; color:#fff; border-radius:10px; padding:8px 14px; min-width:74px;">' +
          '<div style="font-size:19px; font-weight:900; line-height:1;">' + priceLabel + '</div>' +
          '<div style="font-size:10px; font-weight:700; opacity:.85; margin-top:2px;">ج.م / كجم</div>' +
        '</div>' +
      '</div>'
    );
  }

  function buildPosterNode() {
    var visible = products.filter(function (p) { return p.is_available; });
    var host = document.createElement('div');
    host.id = 'fzMerchantCaptureHost';
    host.style.position = 'fixed';
    host.style.left = '-99999px';
    host.style.top = '0';

    var rowsHtml = visible.length
      ? visible.map(posterRowHtml).join('<div style="height:9px;"></div>')
      : '<div style="text-align:center; padding:30px; color:#5c5346; font-weight:700;">مفيش أصناف ظاهرة في القائمة</div>';

    host.innerHTML =
      '<div style="width:' + POSTER_WIDTH + 'px; font-family:Tajawal,sans-serif; direction:rtl; background:#F4EEE2; padding:34px 30px 30px;">' +
        '<div style="display:flex; flex-direction:column; align-items:center; text-align:center;">' +
          '<div style="width:64px; height:64px; border-radius:50%; background:#030C13; display:flex; align-items:center; justify-content:center;">' +
            '<img src="assets/icon-white.png" alt="" width="34" height="34" crossorigin="anonymous">' +
          '</div>' +
          '<div style="margin-top:10px; font-size:11px; font-weight:700; color:#0665BD;"><span style="letter-spacing:4px;">WHOLESALE</span> · <span>تجار</span></div>' +
          '<div style="margin-top:4px; font-size:38px; font-weight:900; color:#030C13; line-height:1;">FRESH<span style="color:#0665BD;">ZONE</span></div>' +
          '<div style="margin-top:5px; font-size:17px; font-weight:800; color:#030C13;">قائمة أسعار الجملة — فريش زون</div>' +
          '<div style="margin-top:4px; font-size:12px; font-weight:600; color:rgba(28,23,16,.6);">' + FZ.escapeHtml(FZ.formatDate()) + '</div>' +
        '</div>' +
        '<div style="margin-top:22px; display:flex; flex-direction:column; gap:0;">' + rowsHtml + '</div>' +
        '<div style="margin-top:24px; background:#030C13; border-radius:14px; padding:16px 20px; text-align:center;">' +
          '<div style="font-size:11px; font-weight:700; color:#E6B25A;">للتواصل والطلب</div>' +
          '<div style="margin-top:6px; font-size:26px; font-weight:900; color:#F4EEE2; direction:ltr;">' + FZ.escapeHtml(FZ.PHONE_PRIMARY) + '</div>' +
          '<div style="margin-top:6px; font-size:11px; font-weight:600; color:rgba(244,238,226,.7);">جاردينيا سيتي – مدينة نصر · القاهرة</div>' +
        '</div>' +
        '<div style="margin-top:14px; text-align:center; font-size:10px; font-weight:600; color:rgba(28,23,16,.45);">قائمة داخلية للتجار — مش للنشر العام</div>' +
      '</div>';

    document.body.appendChild(host);
    return host.firstElementChild;
  }

  /* The product photo frame is 56px border-box with a 2.5px gold border, so
     the content box the photo must cover is 51px. Kept as a named constant
     because getting it from the DOM would read the border-box width and
     silently under-fill every photo by 5px. */
  var POSTER_PHOTO_BOX = 51;

  /* Cover geometry can only be computed once naturalWidth is known, which is
     exactly what this function already waits for - so it is applied here
     rather than in a second pass that would have to wait all over again. */
  function frameIfPhoto(im) {
    if (im.dataset.fzphoto === '1') FZ.applyCover(im, POSTER_PHOTO_BOX, im.dataset.zoom);
  }

  function awaitImages(node) {
    var imgs = Array.prototype.slice.call(node.querySelectorAll('img'));
    return Promise.all(imgs.map(function (im) {
      if (im.complete && im.naturalWidth) { frameIfPhoto(im); return Promise.resolve(); }
      return new Promise(function (r) {
        im.addEventListener('load', function () { frameIfPhoto(im); r(); }, { once: true });
        im.addEventListener('error', r, { once: true });
        setTimeout(r, 8000);
      });
    }));
  }

  var downloadBtn = $('downloadBtn');
  downloadBtn.addEventListener('click', function () {
    if (downloadBtn.disabled) return;
    downloadBtn.disabled = true;
    var label = downloadBtn.innerHTML;
    downloadBtn.textContent = 'بيتم التجهيز...';

    var posterEl = null;
    loadHtml2Canvas()
      .then(function () {
        posterEl = buildPosterNode();
        return awaitImages(posterEl);
      })
      .then(function () {
        return document.fonts && document.fonts.ready ? document.fonts.ready : null;
      })
      .then(function () {
        return window.html2canvas(posterEl, {
          backgroundColor: '#F4EEE2',
          scale: 2,
          useCORS: true,
          logging: false,
          imageTimeout: 20000
        });
      })
      .then(function (canvas) {
        return new Promise(function (resolve, reject) {
          canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('toBlob returned null')); }, 'image/png');
        });
      })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'fresh-zone-merchant-price-list-' + FZ.dateSlug() + '.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        toast('اتحملت — تقدر تبعتها للتجار من الداونلودز');
      })
      .catch(function (err) {
        console.error('Fresh Zone merchant export failed:', err);
        toast('حصل خطأ في تجهيز الصورة، جرب تاني', true);
      })
      .finally(function () {
        var host = document.getElementById('fzMerchantCaptureHost');
        if (host && host.parentNode) host.parentNode.removeChild(host);
        downloadBtn.disabled = false;
        downloadBtn.innerHTML = label;
      });
  });

  FZ.syncClock().then(function () {
    var skewMin = Math.round((FZ.now().getTime() - Date.now()) / 60000);
    if (Math.abs(skewMin) < 5) return;
    var hours = Math.round(Math.abs(skewMin) / 60 * 10) / 10;
    var amount = Math.abs(skewMin) < 60 ? (Math.abs(skewMin) + ' دقيقة') : (hours + ' ساعة');
    var dir = skewMin > 0 ? 'متأخرة' : 'مقدّمة';
    var el = document.createElement('div');
    el.className = 'session-warn show';
    el.setAttribute('role', 'alert');
    el.textContent = 'ساعة جهازك ' + dir + ' حوالي ' + amount +
      ' — ده بيقطع الجلسة كل شوية. اظبط الوقت التلقائي في إعدادات الجهاز.';
    document.body.insertBefore(el, document.body.firstChild);
  });

  checkSession();
})();
