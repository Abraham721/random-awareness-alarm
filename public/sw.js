/* sw.js — service worker: persistent push display, ack reporting, offline shell, stats logging */
'use strict';

const CACHE = 'aw-shell-v6';
const SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.json', '/img/icon-192.png'];

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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.url.includes('/api/')) return;
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

// ---- IndexedDB (received events for stats) ----
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

async function postAck(d) {
  if (!d || !d.userId || !d.date || !d.time) return;
  try {
    await fetch('/api/ack', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: d.userId, date: d.date, time: d.time }),
    });
  } catch (_) {}
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (_) { data = { body: event.data ? event.data.text() : '' }; }

  const ts = data.ts || Date.now();
  const title = data.title || '지금, 알아차리기';
  const url = './?log=1&ts=' + ts +
    (data.date ? '&date=' + encodeURIComponent(data.date) : '') +
    (data.time ? '&time=' + encodeURIComponent(data.time) : '');
  const options = {
    body: data.body || '지금 이 순간 당신은 무엇을 하고 있나요?',
    icon: '/img/icon-192.png',
    badge: '/img/icon-192.png',
    tag: data.tag || ('aw-' + ts),
    renotify: true,
    requireInteraction: true,
    vibrate: [180, 80, 180, 80, 180],
    actions: [{ action: 'log', title: '기록하기' }],
    data: { ts, date: data.date || null, time: data.time || null, userId: data.userId || null, url },
  };
  event.waitUntil((async () => {
    try { await addReceived(ts); } catch (_) {}
    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  event.waitUntil((async () => {
    await postAck(d);
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { c.postMessage({ type: 'open-log', ts: d.ts, date: d.date, time: d.time }); return c.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow(d.url || './?log=1');
  })());
});

self.addEventListener('notificationclose', (event) => {
  event.waitUntil(postAck(event.notification.data || {}));
});
