/* ============================================================
   sw.js — サービスワーカー（オフラインで使えるようにする係）
   ------------------------------------------------------------
   ★更新のしかた★
   アプリのファイルや data/ のCSVを直したら、
   すぐ下の CACHE_VERSION の数字を 1 つ増やしてください。
   例： 'v1' → 'v2' → 'v3' …
   これだけで、古いキャッシュは自動で消えて新しい内容に入れ替わります。
   ============================================================ */

var CACHE_VERSION = 'v1';
var CACHE_NAME = 'nihonshi-index-' + CACHE_VERSION;

var ASSETS = [
  './',
  './index.html',
  './style.css',
  './search.js',
  './app.js',
  './manifest.json',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './data/nihonshi_index_all.csv',
  './data/periods.csv',
  './data/chapters.csv',
  './data/manual_tags.csv'
];

// 取り付け：必要なファイルを先に保存しておく
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // 1つでも欠けていると全部失敗するので、1件ずつ入れる
      return Promise.all(ASSETS.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' })).catch(function () { });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

// 有効化：古いバージョンのキャッシュを消す
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE_NAME) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

// 取り出し：まずネットを試し、だめならキャッシュ（機内モードでも動く）
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); }).catch(function () { });
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        // ページの要求なら index.html を返す
        if (req.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 504, statusText: 'offline' });
      });
    })
  );
});
