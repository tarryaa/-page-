/* ============================================================
   search.js  —  日本史索引検索アプリ
   正規化 / ルビ解析 / 検索判定 / CSV読み込み / データ組み立て
   （外部ライブラリは使いません）
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 0. 定数 ---------- */

  // 検索語の中の「～」「〜」「~」を表す内部記号（ワイルドカード）
  var WC = '\u0001';

  // 時代名 → periods.csv のID（時代名しかない語の判定に使う）
  var ERA_TO_PERIOD = {
    '旧石器': ['paleo'],
    '縄文': ['jomon'],
    '弥生': ['yayoi'],
    '古墳': ['kofun'],
    '飛鳥': ['asuka'],
    '奈良': ['nara'],
    '平安': ['heian'],
    '鎌倉': ['kamakura'],
    '室町': ['muromachi'],
    '戦国': ['sengoku'],
    '安土桃山': ['azuchi'],
    '江戸': ['edo'],
    '明治': ['modern_00', 'meiji']
  };

  // 時代名 → 年の範囲（年が無い語の並び替え・西暦範囲フィルターに使う）
  var ERA_RANGE = {
    '旧石器': [-38000, -14000],
    '縄文': [-14000, -400],
    '弥生': [-400, 250],
    '古墳': [250, 592],
    '飛鳥': [592, 710],
    '奈良': [710, 794],
    '平安': [794, 1185],
    '鎌倉': [1185, 1333],
    '室町': [1336, 1573],
    '戦国': [1467, 1590],
    '安土桃山': [1568, 1603],
    '江戸': [1603, 1867],
    '明治': [1868, 1912]
  };

  // 画面に並べる順番（仕様どおり）
  var FIELD_ORDER = ['政治・政策', '法制・制度', '政変・事件・反乱', '対外関係', '戦争・軍事',
    '条約・会議', '土地・税制', '農林漁業', '商業・流通・都市', '貨幣・金融', '産業・工業',
    '身分・社会構造', '一揆・打ちこわし', '社会運動', '労働運動', '農民運動', '女性',
    '北方・アイヌ', '琉球・沖縄', '植民地', '公害・環境・災害', '仏教', '神道', 'キリスト教',
    '思想・学問', '教育', '文学', '美術・建築', '芸能', '生活・風俗', '考古'];

  var KIND_ORDER = ['人物', '事件・戦争・乱', '法令・政策', '条約・協定・会議', '制度・役職',
    '組織・団体・政党', '書物・史料', '作品', '寺社・遺跡・場所', '国・地域・王朝',
    '文化・流派', 'その他'];

  var COUNTRY_ORDER = ['日本', '中国', '朝鮮', 'アメリカ', 'イギリス', 'ロシア・ソ連', 'フランス',
    'ドイツ', 'オランダ', 'ポルトガル・スペイン', 'イタリア', 'その他'];

  var ROLE_ORDER = ['天皇・皇族', '武家', '公家・貴族', '政治家', '軍人', '僧侶・宗教家',
    '学者・思想家', '文学者', '芸術家', '実業家', '社会運動家', '来日外国人', '渡来人',
    '国王・皇帝（外国）', 'その他'];

  /* ---------- 1. CSV ---------- */

  function parseCSV(text) {
    if (!text) return [];
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM を外す
    var rows = [], row = [], field = '', i = 0, inQ = false, c;
    while (i < text.length) {
      c = text.charAt(i);
      if (inQ) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i += 2; }
          else { inQ = false; i++; }
        } else { field += c; i++; }
      } else {
        if (c === '"') { inQ = true; i++; }
        else if (c === ',') { row.push(field); field = ''; i++; }
        else if (c === '\r') { i++; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; }
        else { field += c; i++; }
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) {
      return r.some(function (v) { return v !== ''; });
    });
  }

  function csvToObjects(text) {
    var rows = parseCSV(text);
    if (!rows.length) return [];
    var head = rows[0].map(function (h) { return h.trim(); });
    var out = [];
    for (var i = 1; i < rows.length; i++) {
      var o = {};
      for (var j = 0; j < head.length; j++) o[head[j]] = (rows[i][j] || '').trim();
      out.push(o);
    }
    return out;
  }

  function splitList(v) {
    if (!v) return [];
    return v.split(';').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  /* ---------- 2. 正規化 ---------- */

  // カタカナ→ひらがな（「ー」はそのまま残す）
  function kataToHira(s) {
    var out = '', i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c >= 0x30A1 && c <= 0x30F6) out += String.fromCharCode(c - 0x60);
      else if (c === 0x30FD) out += 'ゝ';
      else if (c === 0x30FE) out += 'ゞ';
      else out += s.charAt(i);
    }
    return out;
  }

  function nfkcLower(s) {
    s = String(s);
    if (String.prototype.normalize) s = s.normalize('NFKC');
    return kataToHira(s.toLowerCase());
  }

  // データ側の正規化（3種類のチルダは普通の「~」に揃える）
  function normText(s) {
    return nfkcLower(s).replace(/[〜～~]/g, '~');
  }

  // 検索語側の正規化（3種類のチルダはワイルドカード記号にする）
  function normQuery(s) {
    return nfkcLower(s).replace(/[〜～~]/g, WC);
  }

  /* ---------- 3. ルビ（読み）の解析 ---------- */

  function isKanjiCp(cp) {
    return (cp >= 0x3400 && cp <= 0x4DBF) ||
      (cp >= 0x4E00 && cp <= 0x9FFF) ||
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0x20000 && cp <= 0x2FA1F) ||
      cp === 0x3005 || cp === 0x3006 || cp === 0x3007 || cp === 0x30F6;
  }

  function isLatinCp(cp) {
    return (cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A) ||
      (cp >= 0xFF21 && cp <= 0xFF3A) || (cp >= 0xFF41 && cp <= 0xFF5A);
  }

  // 「日(にっ)中(ちゅう)…」を、かたまりの列 [{s:表記, r:読み}, …] に分解する
  function parseRuby(yomi) {
    var cps = Array.from(String(yomi));
    var chunks = [], buf = [], i = 0;

    function flushLiteral(keep) {
      var lit = buf.slice(0, buf.length - keep);
      for (var k = 0; k < lit.length; k++) chunks.push({ s: lit[k], r: lit[k] });
      var base = buf.slice(buf.length - keep).join('');
      buf = [];
      return base;
    }

    while (i < cps.length) {
      var ch = cps[i];
      if (ch === '(') {
        var close = -1;
        for (var j = i + 1; j < cps.length; j++) { if (cps[j] === ')') { close = j; break; } }
        if (close < 0) { buf.push(ch); i++; continue; }
        var reading = cps.slice(i + 1, close).join('');
        // 「(」の直前に続く、漢字のかたまり／英字のかたまりがルビの対象
        var keep = 0;
        if (buf.length) {
          var lastCp = buf[buf.length - 1].codePointAt(0);
          var test = isKanjiCp(lastCp) ? isKanjiCp : (isLatinCp(lastCp) ? isLatinCp : null);
          if (test) {
            var p = buf.length;
            while (p > 0 && test(buf[p - 1].codePointAt(0))) p--;
            keep = buf.length - p;
          }
        }
        var base = flushLiteral(keep);
        if (base === '') chunks.push({ s: reading, r: reading });
        else chunks.push({ s: base, r: reading });
        i = close + 1;
      } else { buf.push(ch); i++; }
    }
    flushLiteral(0);
    return chunks;
  }

  /* ---------- 4. 用語オートマトン（漢字・かな混ぜ書きの判定） ---------- */

  // かたまりの列から、文字単位の状態遷移表を作る
  function buildAutomaton(chunks) {
    var n = chunks.length;
    var edges = [];           // edges[node] = [文字コード, 行き先, 文字コード, 行き先, ...]
    for (var i = 0; i <= n; i++) edges.push([]);
    var nodeCount = n + 1;

    for (i = 0; i < n; i++) {
      var s = chunks[i].s, r = chunks[i].r;
      var reps = (s === r) ? [s] : [s, r];
      for (var q = 0; q < reps.length; q++) {
        var str = reps[q];
        if (!str.length) continue;
        var cur = i;
        for (var k = 0; k < str.length; k++) {
          var tgt;
          if (k === str.length - 1) tgt = i + 1;
          else { tgt = nodeCount++; edges.push([]); }
          edges[cur].push(str.charCodeAt(k), tgt);
          cur = tgt;
        }
      }
    }

    var byChar = new Map();
    for (var f = 0; f < edges.length; f++) {
      var e = edges[f];
      for (var m = 0; m < e.length; m += 2) {
        var a = byChar.get(e[m]);
        if (!a) { a = []; byChar.set(e[m], a); }
        if (a.indexOf(e[m + 1]) < 0) a.push(e[m + 1]);
      }
    }

    return {
      edges: edges, byChar: byChar, end: n,
      mark: new Int32Array(nodeCount), gen: 0
    };
  }

  function stepAuto(auto, cur, code) {
    var gen = ++auto.gen, mark = auto.mark, out = [];
    for (var i = 0; i < cur.length; i++) {
      var e = auto.edges[cur[i]];
      for (var k = 0; k < e.length; k += 2) {
        if (e[k] === code) {
          var t = e[k + 1];
          if (mark[t] !== gen) { mark[t] = gen; out.push(t); }
        }
      }
    }
    return out;
  }

  // 「～」の部分：ここから先へ何文字でも飛べる
  function reachAny(auto, cur) {
    var gen = ++auto.gen, mark = auto.mark, out = [], stack = [];
    for (var i = 0; i < cur.length; i++) {
      if (mark[cur[i]] !== gen) { mark[cur[i]] = gen; out.push(cur[i]); stack.push(cur[i]); }
    }
    while (stack.length) {
      var e = auto.edges[stack.pop()];
      for (var k = 1; k < e.length; k += 2) {
        var t = e[k];
        if (mark[t] !== gen) { mark[t] = gen; out.push(t); stack.push(t); }
      }
    }
    return out;
  }

  function matchAutomaton(auto, pat) {
    var segs = pat.segs;
    if (!segs.length) return true;
    var cur = null;
    for (var si = 0; si < segs.length; si++) {
      var seg = segs[si], k = 0;
      if (si === 0) {
        if (pat.anchorStart) cur = [0];
        else {
          var t = auto.byChar.get(seg.charCodeAt(0));
          if (!t) return false;
          cur = t.slice(); k = 1;
        }
      } else {
        cur = reachAny(auto, cur);
      }
      for (; k < seg.length; k++) {
        cur = stepAuto(auto, cur, seg.charCodeAt(k));
        if (!cur.length) return false;
      }
    }
    if (pat.anchorEnd) return cur.indexOf(auto.end) >= 0;
    return cur.length > 0;
  }

  /* ---------- 5. 検索語の解釈 ---------- */

  function charMask(str) {
    var m = 0;
    for (var i = 0; i < str.length; i++) m |= (1 << (str.charCodeAt(i) & 31));
    return m;
  }

  function compileToken(tok) {
    var hasWC = tok.indexOf(WC) >= 0, anchorStart, anchorEnd, segs;
    if (!hasWC) {
      anchorStart = false; anchorEnd = false; segs = [tok];
    } else {
      anchorStart = tok.charAt(0) !== WC;
      anchorEnd = tok.charAt(tok.length - 1) !== WC;
      segs = tok.split(WC).filter(function (s) { return s.length > 0; });
      if (!segs.length) { anchorStart = false; anchorEnd = false; }
    }
    return {
      raw: tok, segs: segs, anchorStart: anchorStart, anchorEnd: anchorEnd,
      mask: charMask(segs.join('')),
      plain: (!anchorStart && !anchorEnd && segs.length === 1) ? segs[0] : null
    };
  }

  function compileQuery(q) {
    var n = normQuery(q).trim();
    if (!n) return [];
    return n.split(/\s+/).filter(Boolean).map(compileToken);
  }

  // ふつうの文字列に対する判定（用語そのもの・読みそのもの・メモ用）
  function matchPlain(pat, text) {
    var segs = pat.segs;
    if (!segs.length) return true;
    if (pat.plain !== null) return text.indexOf(pat.plain) >= 0;

    var last = segs.length - 1, end = text.length, from = 0, i = 0;
    if (pat.anchorEnd) {
      var ls = segs[last];
      if (text.length < ls.length || text.slice(text.length - ls.length) !== ls) return false;
      end = text.length - ls.length;
      if (segs.length === 1) return pat.anchorStart ? (text === ls) : true;
    }
    if (pat.anchorStart) {
      if (text.slice(0, segs[0].length) !== segs[0]) return false;
      from = segs[0].length; i = 1;
    }
    var upto = pat.anchorEnd ? last : segs.length;
    for (; i < upto; i++) {
      var idx = text.indexOf(segs[i], from);
      if (idx < 0 || idx + segs[i].length > end) return false;
      from = idx + segs[i].length;
    }
    return true;
  }

  /* ---------- 6. 1語がその項目に当てはまるか ---------- */

  function getAutomata(entry) {
    if (!entry._auto) {
      entry._auto = entry.readings.map(function (rd) { return buildAutomaton(rd.nChunks); });
    }
    return entry._auto;
  }

  // 0＝はずれ / 1＝用語・読みでヒット / 2以上＝別名（メモ）でヒット
  function tokenHit(entry, pat) {
    var i;
    if (matchPlain(pat, entry.nTerm)) return 1;
    for (i = 0; i < entry.nKana.length; i++) {
      if (matchPlain(pat, entry.nKana[i])) return 1;
    }
    if ((entry.mask & pat.mask) === pat.mask) {   // 混ぜ書き判定は重いので先に絞る
      var autos = getAutomata(entry);
      for (i = 0; i < autos.length; i++) {
        if (matchAutomaton(autos[i], pat)) return 1;
      }
    }
    for (i = 0; i < entry.nAlias.length; i++) {
      if (matchPlain(pat, entry.nAlias[i])) return 2 + i;
    }
    return 0;
  }

  // 検索語すべて（AND）に当てはまるか。別名でヒットした場合はその文言も返す
  function matchEntry(entry, pats) {
    if (!pats.length) return { ok: true, alias: null };
    var alias = null;
    for (var i = 0; i < pats.length; i++) {
      var r = tokenHit(entry, pats[i]);
      if (!r) return { ok: false, alias: null };
      if (r >= 2 && alias === null) alias = entry.aliasLabel[r - 2];
    }
    return { ok: true, alias: alias };
  }

  /* ---------- 7. 索引データの組み立て ---------- */

  function parseYear(v) {
    if (v === undefined || v === null) return null;
    var s = String(v).trim();
    if (!s) return null;
    s = s.replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
    s = s.replace(/[−ー―‐–—]/g, '-');
    var minus = false;
    if (/^(紀元前|前|B\.C\.|BC|bc)/.test(s)) {
      minus = true; s = s.replace(/^(紀元前|前|B\.C\.|BC|bc)/, '');
    }
    if (s.charAt(0) === '-') { minus = true; s = s.slice(1); }
    s = s.replace(/[^0-9]/g, '');
    if (!s) return null;
    var n = parseInt(s, 10);
    if (isNaN(n)) return null;
    return minus ? -n : n;
  }

  // メモを「別名」として見せるときの整形
  function aliasLabel(memo) {
    var s = memo.replace(/^略語[：:]\s*/, '').replace(/のこと$/, '').trim();
    return s || memo;
  }

  function buildEntries(indexCsvText) {
    var rows = csvToObjects(indexCsvText);
    var map = new Map(), order = [];

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var term = (r['用語'] || '').trim();
      if (!term) continue;
      var pages = splitList(r['ページ']).map(function (p) { return parseInt(p, 10); })
        .filter(function (p) { return !isNaN(p); });
      // 用語もページも同じ行は「読みが2通りある同じ語」＝1件にまとめる
      var key = term + '\u0000' + pages.join(',');
      var e = map.get(key);
      if (!e) {
        e = {
          term: term, pages: pages, kind: r['種類'] || '', fields: [],
          country: r['国'] || '', roles: [],
          y0: parseYear(r['開始年']), y1: parseYear(r['終了年']),
          eras: [], memos: [], readings: []
        };
        map.set(key, e);
        order.push(e);
      }
      if (!e.kind) e.kind = r['種類'] || '';
      if (!e.country) e.country = r['国'] || '';
      if (e.y0 === null) { e.y0 = parseYear(r['開始年']); e.y1 = parseYear(r['終了年']); }
      (function (ent) {
        splitList(r['分野']).forEach(function (v) { if (ent.fields.indexOf(v) < 0) ent.fields.push(v); });
        splitList(r['立場']).forEach(function (v) { if (ent.roles.indexOf(v) < 0) ent.roles.push(v); });
        splitList(r['時代']).forEach(function (v) { if (ent.eras.indexOf(v) < 0) ent.eras.push(v); });
      })(e);
      var memo = (r['メモ'] || '').trim();
      if (memo && e.memos.indexOf(memo) < 0) e.memos.push(memo);
      var yomi = (r['読み'] || '').trim() || term;
      if (!e.readings.some(function (x) { return x.raw === yomi; })) e.readings.push({ raw: yomi });
    }

    for (i = 0; i < order.length; i++) finalizeEntry(order[i]);
    return order;
  }

  function finalizeEntry(e) {
    var i;
    e.readings.forEach(function (rd) {
      rd.chunks = parseRuby(rd.raw);
      rd.kana = rd.chunks.map(function (c) { return c.r; }).join('');
      rd.nChunks = rd.chunks.map(function (c) { return { s: normText(c.s), r: normText(c.r) }; });
      rd.nKana = normText(rd.kana);
    });

    e.kanaList = e.readings.map(function (r) { return r.kana; });
    e.nTerm = normText(e.term);
    e.nKana = e.readings.map(function (r) { return r.nKana; });

    // 「○○ とも読む」で、その読みがすでに表示されているメモは隠す
    var kanaSet = e.nKana.slice();
    e.memos = e.memos.filter(function (m) {
      var mm = /^(.+?)\s*とも読む$/.exec(m);
      return !(mm && kanaSet.indexOf(normText(mm[1])) >= 0);
    });

    e.warnMemos = e.memos.filter(function (m) { return /^要確認[：:]/.test(m); });
    e.plainMemos = e.memos.filter(function (m) { return !/^要確認[：:]/.test(m); });

    // 検索対象になるメモ（＝別名）
    e.nAlias = e.plainMemos.map(normText);
    e.aliasLabel = e.plainMemos.map(aliasLabel);

    // 文字の早い絞り込み用マスク
    var m = charMask(e.nTerm);
    for (i = 0; i < e.nKana.length; i++) m |= charMask(e.nKana[i]);
    e.mask = m;

    // 並び替え用のキー
    var ys = e.y0;
    if (ys === null) {
      var best = null;
      e.eras.forEach(function (era) {
        var rg = ERA_RANGE[era];
        if (rg && (best === null || rg[0] < best)) best = rg[0];
      });
      ys = (best === null) ? 99999 : best;
    }
    e.sortYear = ys;

    var k = e.nKana.length ? e.nKana[0] : e.nTerm;
    e.sortKana = k;
    e.sortGroup = /^[0-9a-z]/.test(k) ? 0 : 1;   // 英字・数字は先頭にまとめる

    // 西暦範囲フィルター用の年の幅
    if (e.y0 !== null) {
      e.rangeLo = e.y0;
      e.rangeHi = (e.y1 === null) ? e.y0 : e.y1;
    } else if (e.eras.length) {
      var lo = null, hi = null;
      e.eras.forEach(function (era) {
        var rg = ERA_RANGE[era];
        if (!rg) return;
        if (lo === null || rg[0] < lo) lo = rg[0];
        if (hi === null || rg[1] > hi) hi = rg[1];
      });
      e.rangeLo = lo; e.rangeHi = hi;
    } else { e.rangeLo = null; e.rangeHi = null; }

    // 時代名から求まる時期ID
    e.eraPeriodIds = [];
    e.eras.forEach(function (era) {
      (ERA_TO_PERIOD[era] || []).forEach(function (id) {
        if (e.eraPeriodIds.indexOf(id) < 0) e.eraPeriodIds.push(id);
      });
    });

    e.manualIds = [];
  }

  /* ---------- 8. 時期（periods.csv）・章・手動タグ ---------- */

  function buildPeriods(csvText) {
    var rows = csvToObjects(csvText);
    var byId = new Map(), roots = [];
    rows.forEach(function (r) {
      var id = (r['ID'] || '').trim();
      if (!id) return;
      byId.set(id, {
        id: id, parent: (r['親ID'] || '').trim(), name: (r['区分名'] || '').trim(),
        y0: parseYear(r['開始年']), y1: parseYear(r['終了年']),
        note: (r['備考'] || '').trim(), children: []
      });
    });
    byId.forEach(function (p) {
      if (p.parent && byId.has(p.parent)) byId.get(p.parent).children.push(p);
      else roots.push(p);
    });
    function collect(p) {
      var all = [p.id];
      p.children.forEach(function (c) { all = all.concat(collect(c)); });
      p.descendants = all;
      return all;
    }
    roots.forEach(collect);
    return { byId: byId, roots: roots };
  }

  function buildChapters(csvText) {
    var rows = csvToObjects(csvText);
    return rows.map(function (r) {
      return {
        no: (r['章'] || '').trim(), part: (r['部'] || '').trim(),
        title: (r['章タイトル'] || '').trim(),
        p0: parseInt(r['開始ページ'], 10), p1: parseInt(r['終了ページ'], 10)
      };
    }).filter(function (c) { return c.no && !isNaN(c.p0); });
  }

  function buildManualTags(csvText) {
    var rows = csvToObjects(csvText), map = new Map();
    rows.forEach(function (r) {
      var t = (r['用語'] || '').trim(), id = (r['時期ID'] || '').trim();
      if (!t || !id) return;
      if (!map.has(t)) map.set(t, []);
      var a = map.get(t);
      if (a.indexOf(id) < 0) a.push(id);
    });
    return map;
  }

  function attachManualTags(entries, tagMap) {
    entries.forEach(function (e) { e.manualIds = tagMap.get(e.term) || []; });
  }

  /* ---------- 9. フィルター判定 ---------- */

  function overlaps(a0, a1, b0, b1) { return a0 <= b1 && b0 <= a1; }

  // 選んだ時期ID（子孫まで展開済み）から、判定用のデータを先に作っておく
  function preparePeriodFilter(idSet, periods) {
    var ranges = [];
    idSet.forEach(function (id) {
      var p = periods.byId.get(id);
      if (p && p.y0 !== null && p.y1 !== null) ranges.push([p.y0, p.y1]);
    });
    ranges.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [];
    for (var i = 0; i < ranges.length; i++) {
      var last = merged[merged.length - 1];
      if (last && ranges[i][0] <= last[1]) { if (ranges[i][1] > last[1]) last[1] = ranges[i][1]; }
      else merged.push([ranges[i][0], ranges[i][1]]);
    }
    return { idSet: idSet, ranges: merged };
  }

  // 時期ツリーの選択に当てはまるか
  function matchPeriodFilter(entry, prep) {
    var i;
    if (entry.y0 !== null) {
      var lo = entry.y0, hi = (entry.y1 === null) ? entry.y0 : entry.y1;
      var rs = prep.ranges;
      for (i = 0; i < rs.length; i++) {
        if (rs[i][0] > hi) break;          // 開始年順に並んでいるので打ち切れる
        if (lo <= rs[i][1]) return true;
      }
    } else {
      for (i = 0; i < entry.eraPeriodIds.length; i++) {
        if (prep.idSet.has(entry.eraPeriodIds[i])) return true;
      }
    }
    for (i = 0; i < entry.manualIds.length; i++) {
      if (prep.idSet.has(entry.manualIds[i])) return true;
    }
    return false;
  }

  function matchPeriodIds(entry, idSet, periods) {
    return matchPeriodFilter(entry, preparePeriodFilter(idSet, periods));
  }

  function matchYearRange(entry, lo, hi) {
    if (entry.rangeLo === null || entry.rangeHi === null) return false;
    return overlaps(entry.rangeLo, entry.rangeHi, lo, hi);
  }

  function matchChapters(entry, chapters) {
    for (var i = 0; i < chapters.length; i++) {
      var c = chapters[i];
      for (var j = 0; j < entry.pages.length; j++) {
        if (entry.pages[j] >= c.p0 && entry.pages[j] <= c.p1) return true;
      }
    }
    return false;
  }

  /* ---------- 10. 並び替え ---------- */

  function cmpKana(a, b) {
    if (a.sortGroup !== b.sortGroup) return a.sortGroup - b.sortGroup;
    if (a.sortKana < b.sortKana) return -1;
    if (a.sortKana > b.sortKana) return 1;
    if (a.term < b.term) return -1;
    if (a.term > b.term) return 1;
    return 0;
  }

  var SORTERS = {
    'year_asc': function (a, b) { return (a.sortYear - b.sortYear) || cmpKana(a, b); },
    'year_desc': function (a, b) { return (b.sortYear - a.sortYear) || cmpKana(a, b); },
    'kana_asc': cmpKana,
    'kana_desc': function (a, b) { return -cmpKana(a, b); }
  };

  /* ---------- 11. 書き出し ---------- */

  var NS = {
    WC: WC,
    FIELD_ORDER: FIELD_ORDER, KIND_ORDER: KIND_ORDER,
    COUNTRY_ORDER: COUNTRY_ORDER, ROLE_ORDER: ROLE_ORDER,
    ERA_TO_PERIOD: ERA_TO_PERIOD, ERA_RANGE: ERA_RANGE,
    parseCSV: parseCSV, csvToObjects: csvToObjects, splitList: splitList,
    normText: normText, normQuery: normQuery, kataToHira: kataToHira,
    parseRuby: parseRuby, buildAutomaton: buildAutomaton, matchAutomaton: matchAutomaton,
    compileToken: compileToken, compileQuery: compileQuery, matchPlain: matchPlain,
    matchEntry: matchEntry, tokenHit: tokenHit,
    buildEntries: buildEntries, buildPeriods: buildPeriods, buildChapters: buildChapters,
    buildManualTags: buildManualTags, attachManualTags: attachManualTags,
    parseYear: parseYear, overlaps: overlaps,
    preparePeriodFilter: preparePeriodFilter, matchPeriodFilter: matchPeriodFilter,
    matchPeriodIds: matchPeriodIds, matchYearRange: matchYearRange, matchChapters: matchChapters,
    SORTERS: SORTERS
  };

  global.NS = NS;
  if (typeof module !== 'undefined' && module.exports) module.exports = NS;

})(typeof window !== 'undefined' ? window : globalThis);
