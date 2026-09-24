/* ============================================================
   app.js — 日本史索引
   画面の組み立て・データの読み込み（同梱／取り込み）・絞り込み・表示
   ============================================================ */
(function () {
  'use strict';

  var APP_VERSION = 'v1.0.0';
  var PAGE_SIZE = 100;                 // スクロールで少しずつ表示する件数
  var STORE_KEY = 'nihonshi.state.v1';

  var DB_NAME = 'nihonshi-index', DB_VER = 1, DB_STORE = 'files';
  var FILE_KINDS = ['index', 'periods', 'chapters', 'tags'];
  var BUNDLED_PATH = {
    index: 'data/nihonshi_index_all.csv',
    periods: 'data/periods.csv',
    chapters: 'data/chapters.csv',
    tags: 'data/manual_tags.csv'
  };

  /* ---------- 状態 ---------- */

  var entries = [], periods = { byId: new Map(), roots: [] }, chapters = [];
  var usingImported = false;
  var results = [], shown = 0;
  var expanded = new Set();
  var rafId = 0;

  var state = {
    sort: 'year_asc',
    periods: [], yearFrom: '', yearTo: '',
    fields: [], kinds: [], countries: [], roles: [], chapters: []
  };

  var $ = function (id) { return document.getElementById(id); };
  var el = {};
  ['topbar', 'q', 'btn-clear', 'count', 'sort', 'btn-filter', 'filter-badge', 'chips',
    'results', 'sentinel', 'empty-msg', 'onboarding', 'btn-import-onboard', 'onboard-status',
    'backdrop', 'filter-sheet', 'settings-sheet', 'btn-settings', 'btn-reset-all',
    'period-tree', 'year-from', 'year-to', 'field-chips', 'kind-chips', 'person-extra',
    'country-chips', 'role-chips', 'chapter-list', 'btn-sheet-close', 'sheet-count',
    'data-status', 'btn-import', 'btn-drop', 'app-version', 'btn-refresh',
    'btn-settings-close', 'file-input'].forEach(function (id) {
      el[id] = $(id);
    });

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ---------- IndexedDB（取り込んだCSVの保存先） ---------- */

  function openDB() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('IndexedDB なし')); return; }
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbReadAll() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var out = {}, tx = db.transaction(DB_STORE, 'readonly'), st = tx.objectStore(DB_STORE);
        FILE_KINDS.forEach(function (k) {
          var r = st.get(k);
          r.onsuccess = function () { if (typeof r.result === 'string') out[k] = r.result; };
        });
        tx.oncomplete = function () { db.close(); resolve(out); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    });
  }

  function idbWrite(obj) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readwrite'), st = tx.objectStore(DB_STORE);
        Object.keys(obj).forEach(function (k) { st.put(obj[k], k); });
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    });
  }

  function idbClear() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).clear();
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    });
  }

  /* ---------- 同梱データの読み込み ---------- */

  function fetchBundled() {
    var out = {};
    return Promise.all(FILE_KINDS.map(function (k) {
      return fetch(BUNDLED_PATH[k], { cache: 'no-cache' })
        .then(function (r) { return r.ok ? r.text() : null; })
        .then(function (t) { if (t && t.trim()) out[k] = t; })
        .catch(function () { /* file:// では読めない。無視する */ });
    })).then(function () { return out; });
  }

  /* ---------- 起動 ---------- */

  function boot() {
    el['app-version'].textContent = 'バージョン ' + APP_VERSION;
    loadState();
    el.sort.value = state.sort;
    bindEvents();
    registerSW();

    idbReadAll().catch(function () { return {}; }).then(function (stored) {
      return fetchBundled().then(function (bundled) {
        var src = {};
        FILE_KINDS.forEach(function (k) { src[k] = stored[k] || bundled[k] || null; });
        usingImported = !!stored.index;
        if (!src.index) { showOnboarding(true); return; }
        showOnboarding(false);
        buildAll(src, Object.keys(stored).length > 0);
      });
    });
  }

  function buildAll(src, imported) {
    usingImported = !!imported;
    entries = NS.buildEntries(src.index);
    periods = NS.buildPeriods(src.periods || 'ID,親ID,区分名,開始年,終了年,備考');
    chapters = NS.buildChapters(src.chapters || '章,部,章タイトル,開始ページ,終了ページ');
    NS.attachManualTags(entries, NS.buildManualTags(src.tags || '用語,時期ID'));

    cleanState();
    buildFilterUI();
    updateDataStatus();
    run();
  }

  var lastMsg = '';

  function updateDataStatus() {
    var lines = [];
    if (lastMsg) lines.push(lastMsg);
    lines.push('索引：' + entries.length + '件');
    lines.push('時期：' + periods.byId.size + '区分');
    lines.push('章：' + chapters.length + '章');
    lines.push(usingImported ? '（取り込んだデータを使用中）' : '（アプリ同梱のデータを使用中）');
    el['data-status'].textContent = lines.join(' / ');
    el['btn-drop'].disabled = !usingImported;
  }

  /* ---------- 保存した条件 ---------- */

  function loadState() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      Object.keys(state).forEach(function (k) {
        if (o[k] === undefined) return;
        if (Array.isArray(state[k])) { if (Array.isArray(o[k])) state[k] = o[k].slice(); }
        else if (typeof o[k] === 'string') state[k] = o[k];
      });
      if (!NS.SORTERS[state.sort]) state.sort = 'year_asc';
    } catch (e) { /* 壊れていたら無視 */ }
  }

  function saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { }
  }

  // 今のデータに存在しないIDが残っていたら落とす
  function cleanState() {
    state.periods = state.periods.filter(function (id) { return periods.byId.has(id); });
    var chNos = chapters.map(function (c) { return c.no; });
    state.chapters = state.chapters.filter(function (n) { return chNos.indexOf(n) >= 0; });
    if (state.kinds.indexOf('人物') < 0) { state.countries = []; state.roles = []; }
  }

  /* ---------- 絞り込みUIの組み立て ---------- */

  function buildFilterUI() {
    renderChipset(el['field-chips'], NS.FIELD_ORDER, 'fields');
    renderChipset(el['kind-chips'], NS.KIND_ORDER, 'kinds');
    renderChipset(el['country-chips'], NS.COUNTRY_ORDER, 'countries');
    renderChipset(el['role-chips'], NS.ROLE_ORDER, 'roles');
    renderChapters();
    renderTree();
    el['year-from'].value = state.yearFrom;
    el['year-to'].value = state.yearTo;
    updatePersonExtra();
  }

  function renderChipset(box, list, key) {
    box.innerHTML = list.map(function (v) {
      var on = state[key].indexOf(v) >= 0;
      return '<button type="button" data-set="' + key + '" data-val="' + esc(v) + '" aria-pressed="' +
        on + '">' + esc(v) + '</button>';
    }).join('');
  }

  function renderChapters() {
    var parts = [], byPart = {};
    chapters.forEach(function (c) {
      if (!byPart[c.part]) { byPart[c.part] = []; parts.push(c.part); }
      byPart[c.part].push(c);
    });
    el['chapter-list'].innerHTML = parts.map(function (p) {
      return '<div class="part-title">' + esc(p) + '</div>' + byPart[p].map(function (c) {
        var on = state.chapters.indexOf(c.no) >= 0;
        return '<button type="button" class="chapter-btn" data-set="chapters" data-val="' +
          esc(c.no) + '" aria-pressed="' + on + '">第' + esc(c.no) + '章 ' + esc(c.title) +
          ' <span class="pg">（p.' + c.p0 + '〜' + c.p1 + '）</span></button>';
      }).join('');
    }).join('');
  }

  function fmtY(n) { return n < 0 ? '前' + (-n) : String(n); }

  function periodYears(p) {
    if (p.y0 === null) return '';
    if (p.y1 !== null && p.y1 >= 2100) return fmtY(p.y0) + '〜現在';
    if (p.y1 === null || p.y1 === p.y0) return fmtY(p.y0);
    return fmtY(p.y0) + '〜' + fmtY(p.y1);
  }

  function ancestorSelected(p) {
    var cur = p.parent ? periods.byId.get(p.parent) : null;
    while (cur) {
      if (state.periods.indexOf(cur.id) >= 0) return true;
      cur = cur.parent ? periods.byId.get(cur.parent) : null;
    }
    return false;
  }

  function nodeHtml(p) {
    var sel = state.periods.indexOf(p.id) >= 0;
    var inh = !sel && ancestorSelected(p);
    var open = expanded.has(p.id);
    var kids = p.children.length;
    var h = '<div class="node">';
    h += '<div class="row">';
    h += kids
      ? '<button type="button" class="toggle' + (open ? ' open' : '') + '" data-toggle="' +
        esc(p.id) + '" aria-label="開閉"><span class="tri">›</span></button>'
      : '<span class="spacer"></span>';
    h += '<button type="button" class="pick' + (inh ? ' inherited' : '') + '" data-pick="' +
      esc(p.id) + '" aria-pressed="' + sel + '">' +
      '<span class="box">✓</span><span class="nm">' + esc(p.name) + '</span>' +
      '<span class="yr">' + esc(periodYears(p)) + '</span></button>';
    h += '</div>';
    if (kids) {
      h += '<div class="kids"' + (open ? '' : ' hidden') + '>' +
        p.children.map(nodeHtml).join('') + '</div>';
    }
    return h + '</div>';
  }

  function renderTree() {
    el['period-tree'].innerHTML = periods.roots.map(nodeHtml).join('');
  }

  function updatePersonExtra() {
    el['person-extra'].hidden = state.kinds.indexOf('人物') < 0;
  }

  /* ---------- 条件チップ ---------- */

  function yearChipLabel() {
    var a = state.yearFrom.trim(), b = state.yearTo.trim();
    if (!a && !b) return '';
    if (a && b) return a + '〜' + b;
    if (a) return a + '年以降';
    return b + '年以前';
  }

  function renderChips() {
    var items = [];
    state.periods.forEach(function (id) {
      var p = periods.byId.get(id);
      if (p) items.push(['period', id, '時期', p.name]);
    });
    var yl = yearChipLabel();
    if (yl) items.push(['year', '', '西暦', yl]);
    state.fields.forEach(function (v) { items.push(['fields', v, '分野', v]); });
    state.kinds.forEach(function (v) { items.push(['kinds', v, '種類', v]); });
    state.countries.forEach(function (v) { items.push(['countries', v, '国', v]); });
    state.roles.forEach(function (v) { items.push(['roles', v, '立場', v]); });
    state.chapters.forEach(function (v) {
      var c = chapters.filter(function (x) { return x.no === v; })[0];
      items.push(['chapters', v, '章', '第' + v + '章' + (c ? ' ' + c.title : '')]);
    });

    el.chips.hidden = items.length === 0;
    el.chips.innerHTML = items.map(function (it) {
      return '<span class="chip"><b>' + esc(it[2]) + '</b>' + esc(it[3]) +
        '<button type="button" class="x" data-chip="' + esc(it[0]) + '" data-val="' +
        esc(it[1]) + '" aria-label="この条件を外す">×</button></span>';
    }).join('');

    var n = items.length;
    el['filter-badge'].hidden = n === 0;
    el['filter-badge'].textContent = String(n);

    setSecCount('period', state.periods.length + (yl ? 1 : 0));
    setSecCount('field', state.fields.length);
    setSecCount('kind', state.kinds.length + state.countries.length + state.roles.length);
    setSecCount('chapter', state.chapters.length);
  }

  function setSecCount(name, n) {
    var e = document.querySelector('.sec-count[data-for="' + name + '"]');
    if (e) e.textContent = n ? n + '件選択' : '';
  }

  /* ---------- 絞り込みの実行 ---------- */

  function expandedPeriodSet() {
    var set = new Set();
    state.periods.forEach(function (id) {
      var p = periods.byId.get(id);
      if (!p) return;
      (p.descendants || [id]).forEach(function (x) { set.add(x); });
    });
    return set;
  }

  function yearRange() {
    var a = NS.parseYear(state.yearFrom), b = NS.parseYear(state.yearTo);
    if (a === null && b === null) return null;
    var lo = (a === null) ? -Infinity : a;
    var hi = (b === null) ? Infinity : b;
    if (lo > hi) { var t = lo; lo = hi; hi = t; }
    return [lo, hi];
  }

  function run() {
    var pats = NS.compileQuery(el.q.value);
    var pset = expandedPeriodSet();
    var prep = pset.size > 0 ? NS.preparePeriodFilter(pset, periods) : null;
    var yr = yearRange();
    var periodOn = prep !== null || yr !== null;
    var chs = chapters.filter(function (c) { return state.chapters.indexOf(c.no) >= 0; });

    var fieldOn = state.fields.length > 0, kindOn = state.kinds.length > 0;
    var countryOn = state.countries.length > 0, roleOn = state.roles.length > 0;
    var chapterOn = chs.length > 0;

    var out = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];

      if (kindOn && state.kinds.indexOf(e.kind) < 0) continue;
      if (countryOn && state.countries.indexOf(e.country) < 0) continue;
      if (roleOn && !someIn(e.roles, state.roles)) continue;
      if (fieldOn && !someIn(e.fields, state.fields)) continue;
      if (chapterOn && !NS.matchChapters(e, chs)) continue;
      if (periodOn) {
        var ok = (prep !== null && NS.matchPeriodFilter(e, prep)) ||
          (yr !== null && NS.matchYearRange(e, yr[0], yr[1]));
        if (!ok) continue;
      }

      var m = NS.matchEntry(e, pats);
      if (!m.ok) continue;
      out.push({ e: e, alias: m.alias });
    }

    var cmp = NS.SORTERS[state.sort] || NS.SORTERS.year_asc;
    out.sort(function (a, b) { return cmp(a.e, b.e); });

    results = out;
    el.count.textContent = out.length + '件';
    el['sheet-count'].textContent = out.length + '件';
    el['empty-msg'].hidden = out.length > 0;
    renderChips();
    resetList();
  }

  function someIn(arr, sel) {
    for (var i = 0; i < arr.length; i++) if (sel.indexOf(arr[i]) >= 0) return true;
    return false;
  }

  function scheduleRun() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(function () { rafId = 0; run(); });
  }

  /* ---------- 結果の表示 ---------- */

  function yearLabel(e) {
    if (e.y0 === null) return e.eras.length ? e.eras.join('・') + '時代' : '';
    var hi = (e.y1 === null) ? e.y0 : e.y1;
    if (hi >= 2100) return fmtY(e.y0) + '年〜現在';
    if (hi === e.y0) return fmtY(e.y0) + '年';
    return fmtY(e.y0) + '〜' + fmtY(hi) + '年';
  }

  function cardHtml(item) {
    var e = item.e, h = '';
    h += '<article class="card">';
    h += '<div class="term">' + esc(e.term) + '</div>';
    if (e.kanaList.length) h += '<div class="yomi">' + esc(e.kanaList.join('／')) + '</div>';
    if (e.pages.length) h += '<div class="pages">p.' + e.pages.join(', ') + '</div>';

    var tags = [];
    if (e.kind) tags.push('<span class="tag kind">' + esc(e.kind) + '</span>');
    var yl = yearLabel(e);
    if (yl) tags.push('<span class="tag year">' + esc(yl) + '</span>');
    if (e.kind === '人物') {
      if (e.country) tags.push('<span class="tag person">' + esc(e.country) + '</span>');
      e.roles.forEach(function (r) { tags.push('<span class="tag person">' + esc(r) + '</span>'); });
    }
    e.fields.forEach(function (f) { tags.push('<span class="tag">' + esc(f) + '</span>'); });
    if (tags.length) h += '<div class="meta">' + tags.join('') + '</div>';

    if (item.alias) h += '<div class="alias">別名：' + esc(item.alias) + '</div>';
    e.plainMemos.forEach(function (m) {
      if (item.alias && NS.normText(m).indexOf(NS.normText(item.alias)) >= 0) return;
      h += '<div class="memo">' + esc(m) + '</div>';
    });
    e.warnMemos.forEach(function (m) { h += '<div class="warn">' + esc(m) + '</div>'; });

    return h + '</article>';
  }

  function resetList() {
    el.results.innerHTML = '';
    shown = 0;
    appendMore();
  }

  function appendMore() {
    if (shown >= results.length) return;
    var end = Math.min(shown + PAGE_SIZE, results.length);
    var html = '';
    for (var i = shown; i < end; i++) html += cardHtml(results[i]);
    el.results.insertAdjacentHTML('beforeend', html);
    shown = end;
  }

  /* ---------- シート ---------- */

  var sheetTimers = [];

  function clearSheetTimers() {
    sheetTimers.forEach(clearTimeout);
    sheetTimers = [];
  }

  function openSheet(sheet) {
    clearSheetTimers();
    el.backdrop.hidden = false;
    sheet.hidden = false;
    requestAnimationFrame(function () {
      el.backdrop.classList.add('show');
      sheet.classList.add('show');
    });
  }

  function closeSheets() {
    clearSheetTimers();
    [el['filter-sheet'], el['settings-sheet']].forEach(function (s) {
      if (s.hidden) return;
      s.classList.remove('show');
      sheetTimers.push(setTimeout(function () { s.hidden = true; }, 280));
    });
    el.backdrop.classList.remove('show');
    sheetTimers.push(setTimeout(function () { el.backdrop.hidden = true; }, 280));
  }

  /* ---------- 条件の操作 ---------- */

  function toggleIn(arr, v) {
    var i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1); else arr.push(v);
  }

  function clearGroup(name) {
    if (name === 'period') { state.periods = []; state.yearFrom = ''; state.yearTo = ''; el['year-from'].value = ''; el['year-to'].value = ''; renderTree(); }
    else if (name === 'field') state.fields = [];
    else if (name === 'kind') { state.kinds = []; state.countries = []; state.roles = []; }
    else if (name === 'country') state.countries = [];
    else if (name === 'role') state.roles = [];
    else if (name === 'chapter') state.chapters = [];
    refreshFilterUI();
  }

  function refreshFilterUI() {
    renderChipset(el['field-chips'], NS.FIELD_ORDER, 'fields');
    renderChipset(el['kind-chips'], NS.KIND_ORDER, 'kinds');
    renderChipset(el['country-chips'], NS.COUNTRY_ORDER, 'countries');
    renderChipset(el['role-chips'], NS.ROLE_ORDER, 'roles');
    renderChapters();
    updatePersonExtra();
    saveState();
    run();
  }

  function resetAll() {
    state.periods = []; state.yearFrom = ''; state.yearTo = '';
    state.fields = []; state.kinds = []; state.countries = []; state.roles = []; state.chapters = [];
    el['year-from'].value = ''; el['year-to'].value = '';
    el.q.value = ''; el['btn-clear'].hidden = true;
    renderTree();
    refreshFilterUI();
  }

  /* ---------- データの取り込み ---------- */

  function detectKind(name, text) {
    var head = text.replace(/^﻿/, '').split(/\r?\n/)[0] || '';
    if (head.indexOf('親ID') >= 0) return 'periods';
    if (head.indexOf('章タイトル') >= 0) return 'chapters';
    if (head.indexOf('時期ID') >= 0) return 'tags';
    if (head.indexOf('読み') >= 0 && head.indexOf('ページ') >= 0) return 'index';
    var n = (name || '').toLowerCase();
    if (n.indexOf('period') >= 0) return 'periods';
    if (n.indexOf('chapter') >= 0) return 'chapters';
    if (n.indexOf('tag') >= 0) return 'tags';
    if (n.indexOf('index') >= 0 || n.indexOf('nihonshi') >= 0) return 'index';
    return null;
  }

  function readFile(f) {
    return new Promise(function (resolve) {
      var fr = new FileReader();
      fr.onload = function () { resolve({ name: f.name, text: String(fr.result || '') }); };
      fr.onerror = function () { resolve(null); };
      fr.readAsText(f, 'UTF-8');
    });
  }

  function setStatus(msg) {
    lastMsg = msg;
    el['onboard-status'].textContent = msg;
    el['data-status'].textContent = msg;
  }

  function handleFiles(files) {
    if (!files || !files.length) return;
    setStatus('読み込み中…');
    Promise.all(Array.prototype.map.call(files, readFile)).then(function (list) {
      var got = {}, names = [];
      list.forEach(function (f) {
        if (!f) return;
        var k = detectKind(f.name, f.text);
        if (k) { got[k] = f.text; names.push(f.name); }
      });
      if (!got.index) {
        setStatus('索引データ（nihonshi_index_all.csv）が見つかりませんでした。4つのCSVをまとめて選んでください。');
        return;
      }
      // IndexedDB が使えない環境（パソコンでファイルを直接開いたときなど）でも、
      // その場で使えるように got を第2候補にしておく
      idbWrite(got).catch(function () { }).then(function () {
        return idbReadAll().catch(function () { return {}; });
      }).then(function (stored) {
        return fetchBundled().then(function (bundled) {
          var src = {};
          FILE_KINDS.forEach(function (k) { src[k] = stored[k] || got[k] || bundled[k] || null; });
          showOnboarding(false);
          buildAll(src, true);
          setStatus('取り込みました（' + names.length + 'ファイル）。');
          updateDataStatus();
        });
      });
    });
  }

  function dropImported() {
    if (!window.confirm('取り込んだデータを削除して、アプリ同梱のデータに戻します。よろしいですか？')) return;
    idbClear().catch(function () { }).then(function () {
      return fetchBundled();
    }).then(function (bundled) {
      if (!bundled.index) {
        entries = []; results = []; resetList();
        el.count.textContent = '0件';
        showOnboarding(true);
        setStatus('削除しました。同梱データが無いので、もう一度取り込んでください。');
        return;
      }
      buildAll(bundled, false);
      setStatus('削除しました。同梱データに戻りました。');
      updateDataStatus();
    });
  }

  function showOnboarding(on) {
    el.onboarding.hidden = !on;
  }

  /* ---------- Service Worker ---------- */

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    navigator.serviceWorker.register('sw.js').catch(function () { });
  }

  function hardRefresh() {
    var p = Promise.resolve();
    if (window.caches) {
      p = caches.keys().then(function (ks) {
        return Promise.all(ks.map(function (k) { return caches.delete(k); }));
      });
    }
    p.catch(function () { }).then(function () {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        return navigator.serviceWorker.getRegistrations().then(function (rs) {
          return Promise.all(rs.map(function (r) { return r.unregister(); }));
        }).catch(function () { });
      }
    }).then(function () { location.reload(); });
  }

  /* ---------- イベント ---------- */

  function bindEvents() {
    el.q.addEventListener('input', function () {
      el['btn-clear'].hidden = el.q.value === '';
      scheduleRun();
    });
    el['btn-clear'].addEventListener('click', function () {
      el.q.value = ''; el['btn-clear'].hidden = true; el.q.focus(); run();
    });
    el.sort.addEventListener('change', function () {
      state.sort = el.sort.value; saveState(); run();
    });

    el['btn-filter'].addEventListener('click', function () { openSheet(el['filter-sheet']); });
    el['btn-sheet-close'].addEventListener('click', closeSheets);
    el['btn-settings'].addEventListener('click', function () {
      updateDataStatus(); openSheet(el['settings-sheet']);
    });
    el['btn-settings-close'].addEventListener('click', closeSheets);
    el.backdrop.addEventListener('click', closeSheets);
    el['btn-reset-all'].addEventListener('click', resetAll);

    // チップ類（分野・種類・国・立場・章）
    document.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('[data-set]') : null;
      if (!b) return;
      var key = b.getAttribute('data-set'), val = b.getAttribute('data-val');
      toggleIn(state[key], val);
      if (key === 'kinds' && state.kinds.indexOf('人物') < 0) { state.countries = []; state.roles = []; }
      refreshFilterUI();
    });

    // 「すべて解除」
    document.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('[data-clear]') : null;
      if (!b) return;
      clearGroup(b.getAttribute('data-clear'));
    });

    // 時期ツリー
    el['period-tree'].addEventListener('click', function (ev) {
      var t = ev.target.closest('[data-toggle]');
      if (t) {
        var id = t.getAttribute('data-toggle');
        if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
        renderTree();
        return;
      }
      var p = ev.target.closest('[data-pick]');
      if (p) {
        toggleIn(state.periods, p.getAttribute('data-pick'));
        renderTree();
        saveState();
        run();
      }
    });

    // 西暦範囲
    function onYear() {
      state.yearFrom = el['year-from'].value.trim();
      state.yearTo = el['year-to'].value.trim();
      saveState();
      run();
    }
    el['year-from'].addEventListener('input', onYear);
    el['year-to'].addEventListener('input', onYear);

    // 条件チップの「×」
    el.chips.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-chip]');
      if (!b) return;
      var type = b.getAttribute('data-chip'), val = b.getAttribute('data-val');
      if (type === 'period') { toggleIn(state.periods, val); renderTree(); }
      else if (type === 'year') {
        state.yearFrom = ''; state.yearTo = '';
        el['year-from'].value = ''; el['year-to'].value = '';
      } else {
        toggleIn(state[type], val);
        if (type === 'kinds' && state.kinds.indexOf('人物') < 0) { state.countries = []; state.roles = []; }
      }
      refreshFilterUI();
    });

    // データ取り込み
    el['btn-import'].addEventListener('click', function () { el['file-input'].click(); });
    el['btn-import-onboard'].addEventListener('click', function () { el['file-input'].click(); });
    el['file-input'].addEventListener('change', function () {
      handleFiles(el['file-input'].files);
      el['file-input'].value = '';
    });
    el['btn-drop'].addEventListener('click', dropImported);
    el['btn-refresh'].addEventListener('click', hardRefresh);

    // 続きの読み込み（スクロール）
    if (window.IntersectionObserver) {
      new IntersectionObserver(function (es) {
        if (es[0].isIntersecting) appendMore();
      }, { rootMargin: '600px 0px' }).observe(el.sentinel);
    } else {
      window.addEventListener('scroll', function () {
        if (window.innerHeight + window.scrollY > document.body.offsetHeight - 600) appendMore();
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
