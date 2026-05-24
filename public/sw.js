/* sw.js — service worker: push display, click handling, offline shell, stats logging */
'use strict';

const CACHE = 'aw-shell-v1';
const SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.json', './icons/icon-192.png'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Network-first for same-origin GET, fall back to cache (so the app opens offline).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.url.includes('/api/')) return; // never cache API
  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      const c = await caches.open(CACHE);
      c.put(req, fresh.clone()).catch(() => {});
      return fresh;
    } catch (_) {
      const cached = await caches.match(req);
      return cached || caches.match('./index.html');
    }
  })());
});

// ---- tiny IndexedDB for "received" events (used by the stats view) ----
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('awareness', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('received')) db.createObjectStore('received', { keyPath: 'ts' });
      if (!db.objectStoreNames.contains('logs')) db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function addReceived(ts) {
  const db = await openDB();
  await new Promise((res, rej) => {
    const tx = db.transaction('received', 'readwrite');
    tx.objectStore('received').put({ ts, respondedAt: null });
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  db.close();
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (_) { data = { body: event.data ? event.data.text() : '' }; }

  const ts = data.ts || Date.now();
  const title = data.title || '지금, 알아차리기';
  const options = {
    body: data.body || '지금 이 순간 당신은 무엇을 하고 있나요?',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: data.tag || ('aw-' + ts),
    renotify: true,
    vibrate: [120, 60, 120],
    data: { ts, url: './?log=1&ts=' + ts },
  };
  event.waitUntil((async () => {
    try { await addReceived(ts); } catch (_) {}
    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const url = d.url || './?log=1';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { c.postMessage({ type: 'open-log', ts: d.ts }); return c.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
