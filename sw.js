// 洋書リーダー Service Worker
// アプリ本体だけをキャッシュしてオフラインでも起動できるようにする。
// 目録と本文はアプリ側で IndexedDB に保存するので、ここでは扱わない。
const VERSION = "g1";
const SHELL = ["./", "./index.html", "./app.js", "./manifest.webmanifest", "./icons/apple-touch-icon.png", "./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  const isShell = (url.origin === location.origin && !url.pathname.endsWith("catalog.json")) || url.hostname.endsWith("fonts.googleapis.com") || url.hostname.endsWith("fonts.gstatic.com");
  if (!isShell) return; // 青空文庫のデータやAIのAPIは素通し
  // 通信できればそれを使ってキャッシュを更新、できなければキャッシュ
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
  );
});
