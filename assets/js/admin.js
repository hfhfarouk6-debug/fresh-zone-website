/* Fresh Zone - admin panel.
   Pricing and formatting come from assets/js/pricing.js, so the number the
   operator sees in this table is provably the number printed on the poster.
   They used to be two separate copies of the same formula with two different
   numeral systems. */
(function () {
  'use strict';

  var sb = FZ.client();
  var loginScreen = document.getElementById('loginScreen');
  var adminScreen = document.getElementById('adminScreen');
  var sessionWarn = document.getElementById('sessionWarn');
  var toastEl = document.getElementById('toast');

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

  /* Without this, an expired JWT left a UI that looked live while every save
     failed with a generic toast. */
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

  /* Any Supabase error that means "your session is gone" should say so rather
     than showing the same "try again" toast as a network blip. */
  function isAuthError(error) {
    if (!error) return false;
    var s = String(error.status || '');
    var m = String(error.message || '').toLowerCase();
    return s === '401' || s === '403' || m.indexOf('jwt') > -1 || m.indexOf('expired') > -1;
  }
  function reportError(error, fallback) {
    if (isAuthError(error)) {
      /* Straight back to the login screen. Leaving the dashboard up with an
         empty table read as "my products were deleted" rather than "you are
         logged out", which is a frightening thing to show someone about their
         own data. */
      sessionWarn.classList.add('show');
      toast('الجلسة انتهت، سجّل دخولك تاني', true);
      showLogin();
    } else {
      toast(fallback, true);
    }
    console.error('Fresh Zone admin:', error);
  }

  /* ---------- MARKET BASE PRICE ---------- */
  function loadMarketPrice() {
    return sb.from('market_settings').select('*').eq('id', 1).single().then(function (res) {
      var upd = document.getElementById('marketUpdated');
      var statBase = document.getElementById('statBase');
      var statUpdated = document.getElementById('statUpdated');

      /* This used to `return` silently on error, leaving yesterday's price on
         screen with no signal that it was stale. */
      if (res.error || !res.data) {
        basePriceFailed = true;
        currentBasePrice = null;
        statBase.textContent = '—';
        upd.textContent = 'تعذّر تحميل سعر البورصة';
        statUpdated.textContent = 'غير معروف';
        reportError(res.error, 'تعذّر تحميل سعر البورصة');
        return;
      }
      basePriceFailed = false;
      var data = res.data;
      currentBasePrice = data.base_price;
      document.getElementById('marketPrice').value = data.base_price == null ? '' : data.base_price;
      statBase.textContent = data.base_price == null ? '—' : FZ.formatPrice(data.base_price);

      if (data.updated_at) {
        var label = FZ.formatDateTime(new Date(data.updated_at));
        upd.textContent = 'آخر تحديث: ' + label;
        statUpdated.textContent = label;
      } else {
        upd.textContent = '';
        statUpdated.textContent = 'لسه محدّدش';
      }
    });
  }

  document.getElementById('saveMarketBtn').addEventListener('click', function () {
    var btn = this;
    var val = document.getElementById('marketPrice').value;
    if (val === '' || isNaN(Number(val)) || Number(val) <= 0) {
      toast('اكتب رقم البورصة الأول', true); return;
    }
    btn.disabled = true; btn.textContent = 'بيتم الحفظ...';
    /* updated_at is written explicitly: no client ever wrote it before, so if
       the database has no trigger the "last updated" line silently showed the
       row's creation date forever while prices changed daily.
       FZ.now(), not new Date(): the timestamp must be the real moment the price
       changed, not what this particular device believes the time is. */
    sb.from('market_settings')
      .update({ base_price: Number(val), updated_at: FZ.now().toISOString() })
      .eq('id', 1)
      .then(function (res) {
        btn.disabled = false; btn.textContent = 'حفظ سعر اليوم';
        if (res.error) { reportError(res.error, 'حصل خطأ في الحفظ'); return; }
        toast('سعر البورصة اتحدّث');
        loadProducts();
      });
  });

  /* ---------- PRODUCTS ---------- */
  function loadProducts() {
    var body = document.getElementById('productsBody');
    var empty = document.getElementById('emptyState');
    body.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:#5c5346;">بيتم التحميل...</td></tr>';

    return loadMarketPrice().then(function () {
      return sb.from('products').select('*').order('sort_order', { ascending: true });
    }).then(function (res) {
      if (res.error) {
        body.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:#b3364a;">تعذّر تحميل المنتجات</td></tr>';
        reportError(res.error, 'حصل خطأ في تحميل المنتجات');
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

  /* Split out of loadProducts so a reorder can repaint the table from the
     in-memory list without a round trip to the database. */
  function renderRows() {
    var body = document.getElementById('productsBody');
    body.innerHTML = products.map(rowHtml).join('');

    /* Rows carry only the row id. The previous build serialised the whole
       record into a single-quoted data-edit attribute and escaped only the
       apostrophe - but the HTML parser decodes character references inside
       attribute values, so a product name containing the literal text
       "&#39;" closed the attribute and turned the rest into live handlers.
       Looking the record up by id removes the escaping question entirely. */
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

  /* Reordering by typing sort_order numbers meant the operator had to hold the
     whole list in their head and renumber by hand. Moving one row swaps it with
     its neighbour and renumbers the list 1..N, so gaps and duplicate
     sort_orders left over from manual editing heal themselves on first use. */
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
        writes.push(sb.from('products').update({ sort_order: want }).eq('id', p.id));
      }
    });

    /* Repaint first: the operator sees the row move immediately instead of
       waiting on the round trip. A failed write reloads the true order back. */
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

  /* Drag to reorder. The arrow buttons stay: HTML5 drag-and-drop does not fire
     on touch screens, and this panel gets used from a phone. */
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
          /* Firefox refuses to start a drag unless some payload is set. */
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
        /* Look the target up again AFTER the removal - its index shifts by one
           whenever the dragged row sat above it. */
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
        (p.is_available ? 'متاح' : 'مخفي') + '</span></td>' +
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

  /* Guards the two ways this form can publish a nonsense price:
     a multiplier left at its default 0 (free product), and a "10" typed as if
     it meant 10% (which multiplies the base by ten). */
  function validateDraft(d) {
    if (d.price !== null && (!isFinite(d.price) || d.price < 0)) return 'السعر اليدوي لازم يكون رقم موجب.';
    /* A manual price bypasses the formula entirely, so the markup fields are
       dead weight at that point. Validating them anyway blocked operators from
       adding a fixed-price product whenever the (ignored) multiplier happened
       to sit outside 1-3. */
    if (d.price !== null) return null;
    if (d.markup_type === 'percent') {
      /* Ceiling was 3, which the highest-yield cut (بانيه) sat on exactly - so
         any real price rise was rejected. 5 still catches the mistake this
         guard exists for: a "10" typed meaning 10%. */
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

    /* Make the bypass visible instead of leaving two live-looking fields that
       no longer affect anything. */
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
      ? (basePriceFailed ? 'سعر البورصة مش متحمّل' : 'حدّد سعر البورصة الأول')
      : val + ' ج.م';
  }

  ['price', 'markupValue', 'markupType'].forEach(function (id) {
    $(id).addEventListener('input', refreshPreview);
    $(id).addEventListener('change', refreshPreview);
  });

  /* Switching to the multiplier while the value is still the additive default
     would otherwise publish the product at zero. */
  $('markupType').addEventListener('change', function () {
    if (this.value === 'percent' && Number($('markupValue').value) < 1) $('markupValue').value = '1';
    if (this.value === 'fixed' && Number($('markupValue').value) === 1) $('markupValue').value = '0';
    refreshPreview();
  });

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

  /* ---------- IMAGE UPLOAD ---------- */
  $('imgFile').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;

    var preview = $('imgPreview'), placeholder = $('uploadPlaceholder'), status = $('uploadStatus');

    function fail(msg) {
      /* Restore what was there before. The previous build left the new
         local preview on screen after a failed upload while #imageUrl still
         held the OLD url - so the operator saved believing the photo had
         changed, and the old one stayed live on the poster. */
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
      toast(msg, true);
    }

    /* Extension comes from the sniffed MIME type, never from the filename.
       An .svg landing in a public bucket is script-capable on the storage
       origin, and `accept` is only a client-side hint. */
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

    /* crypto.randomUUID is undefined outside a secure context; calling it on
       plain http threw inside the async handler and the status hung on
       "uploading" forever with no error anywhere. */
    var uid = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));

    sb.storage.from('product-images').upload(uid + '.' + ext, file, {
      cacheControl: '3600', upsert: false, contentType: file.type
    }).then(function (res) {
      if (res.error) { fail('حصل خطأ في الرفع، جرب تاني'); console.error(res.error); return; }
      var pub = sb.storage.from('product-images').getPublicUrl(uid + '.' + ext);
      $('imageUrl').value = pub.data.publicUrl;
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
      is_available: $('isAvailable').checked
    };

    var q = id
      ? sb.from('products').update(payload).eq('id', id)
      : sb.from('products').insert(payload);

    q.then(function (res) {
      saveBtn.disabled = false; saveBtn.textContent = 'حفظ';
      /* A generic toast hid a real NOT NULL violation for weeks: the operator
         saw "حصل خطأ" with no way to tell what the database objected to.
         Surface the actual reason next to the form. */
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
      'هتشيل "' + p.name_ar + '" نهائيًا من القائمة. مش هينفع ترجعه.';
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
    sb.from('products').delete().eq('id', pendingDelete.id).then(function (res) {
      btn.disabled = false; btn.textContent = 'احذف';
      if (res.error) { reportError(res.error, 'حصل خطأ في الحذف'); return; }
      closeConfirm();
      toast('اتشال');
      loadProducts();
    });
  });

  /* A device clock that is hours out is the quiet cause of "my session keeps
     expiring": the auth client schedules its token refresh against LOCAL time,
     so a clock running behind makes it believe a token is still fresh long
     after the server has stopped accepting it - no refresh is attempted, and
     every save fails. Worth saying out loud, because nothing else on screen
     would ever point at the clock. */
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
