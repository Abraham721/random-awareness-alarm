'use strict';
/* app.js — Random Awareness Alarm (client) */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const DAYS = ['일', '월', '화', '수', '목', '금', '토']; // 0=Sun..6=Sat

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ---- state ----
const userId = (() => {
  let id = localStorage.getItem('aw_userId');
  if (!id) { id = uuid(); localStorage.setItem('aw_userId', id); }
  return id;
})();
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const DEFAULT_CONFIG = {
  alarmsPerDay: 5,
  minGapMinutes: 30,
  exclusions: [
    { id: 'sleep', name: '수면', start: '23:00', end: '07:00', days: [0, 1, 2, 3, 4, 5, 6] },
    { id: 'work', name: '업무', start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
  ],
};
let config = loadConfig();
let currentPromptTs = null;

function loadConfig() {
  try {
    const c = JSON.parse(localStorage.getItem('aw_config'));
    if (c && c.exclusions) return c;
  } catch (_) {}
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}
function persistConfig() { localStorage.setItem('aw_config', JSON.stringify(config)); }

// ---- api ----
async function api(path, method = 'GET', body) {
  const opt = { method, headers: {} };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(path, opt);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// ---- push subscription ----
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

async function getRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.ready; } catch (_) { return null; }
}

async function isSubscribed() {
  if (!pushSupported || Notification.permission !== 'granted') return false;
  const reg = await getRegistration();
  if (!reg) return false;
  const sub = await reg.pushManager.getSubscription();
  return !!sub;
}

async function ensureSubscribed() {
  const reg = await getRegistration();
  if (!reg) throw new Error('no service worker');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { publicKey } = await api('/api/vapidPublicKey');
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  await api('/api/subscribe', 'POST', { userId, subscription: sub, timezone: tz, config });
  return sub;
}

async function enableFlow() {
  if (!pushSupported) { toast('이 브라우저는 알림을 지원하지 않아요'); return; }
  if (isiOS && !isStandalone) { toast('먼저 "홈 화면에 추가"로 설치해 주세요'); return; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('알림이 허용되지 않았어요'); await refresh(); return; }
    await ensureSubscribed();
    toast('알림이 켜졌어요 🔔');
    await refresh();
  } catch (e) {
    console.error(e);
    toast('알림 설정에 실패했어요: ' + e.message);
  }
}

// ---- IndexedDB (logs + received events) ----
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
function txStore(db, name, mode) { return db.transaction(name, mode).objectStore(name); }
function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

async function addLog(entry) {
  const db = await openDB();
  await reqP(txStore(db, 'logs', 'readwrite').add(entry));
  db.close();
}
async function getLogs() {
  const db = await openDB();
  const all = await reqP(txStore(db, 'logs', 'readonly').getAll());
  db.close();
  return (all || []).sort((a, b) => b.ts - a.ts);
}
async function getReceived() {
  const db = await openDB();
  const all = await reqP(txStore(db, 'received', 'readonly').getAll());
  db.close();
  return all || [];
}
async function markResponded(ts) {
  if (!ts) return;
  const db = await openDB();
  const store = txStore(db, 'received', 'readwrite');
  const rec = await reqP(store.get(ts));
  if (rec) { rec.respondedAt = Date.now(); await reqP(store.put(rec)); }
  db.close();
}

// ---- helpers ----
function nowHHMM() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ---- HOME rendering ----
let lastSchedule = null;

async function refresh() {
  const subscribed = await isSubscribed();
  const enableCard = $('#enableCard');
  const iosHint = $('#iosHint');
  const heroCard = $('#heroCard');
  const todayCard = $('#todayCard');

  if (subscribed) {
    enableCard.style.display = 'none';
    iosHint.style.display = 'none';
    heroCard.style.display = '';
    todayCard.style.display = '';
    try {
      // make sure server has our latest config + a schedule
      await ensureSubscribed();
      const r = await api('/api/schedule?userId=' + encodeURIComponent(userId));
      lastSchedule = r.schedule;
      renderToday(r.schedule);
    } catch (e) {
      console.error(e);
      $('#statusText').textContent = '서버에 연결할 수 없어요';
    }
  } else {
    heroCard.style.display = 'none';
    todayCard.style.display = 'none';
    if (isiOS && !isStandalone) {
      iosHint.style.display = '';
      enableCard.style.display = 'none';
    } else {
      iosHint.style.display = 'none';
      enableCard.style.display = '';
    }
  }
}

function renderToday(sched) {
  const dot = $('#statusDot');
  const txt = $('#statusText');
  dot.className = 'dot on';
  const times = sched.times || [];
  const fired = sched.fired || [];
  txt.textContent = '알림 켜짐 · 오늘 ' + times.length + '회';

  // next upcoming
  const now = nowHHMM();
  const upcoming = times.filter((t) => t > now && !fired.includes(t));
  if (upcoming.length) {
    $('#nextTime').textContent = upcoming[0];
    $('#nextSub').textContent = '오늘 남은 알림 ' + upcoming.length + '회';
  } else {
    $('#nextTime').textContent = '—';
    $('#nextSub').textContent = times.length ? '오늘 알림이 모두 지나갔어요' : '오늘 예정된 알림이 없어요';
  }

  // chips
  const chips = $('#todayChips');
  chips.innerHTML = '';
  if (!times.length) {
    chips.innerHTML = '<span class="hint">제외 시간대 때문에 오늘은 울릴 시간이 없어요.</span>';
  } else {
    times.forEach((t) => {
      const el = document.createElement('span');
      el.className = 'chip' + ((fired.includes(t) || t <= now) ? ' done' : '');
      el.textContent = t;
      chips.appendChild(el);
    });
  }
  const meta = sched.meta || {};
  $('#todayMeta').textContent = meta.capped
    ? `요청한 ${meta.requested}회 중 ${meta.placed}회만 배치됐어요. 제외 시간대를 줄이거나 간격을 낮춰보세요.`
    : '';
}

// ---- SETTINGS rendering ----
function renderSettings() {
  $('#cntVal').textContent = config.alarmsPerDay;
  $('#gapSel').value = String(config.minGapMinutes);
  renderExclusions();
}

function renderExclusions() {
  const list = $('#exclList');
  list.innerHTML = '';
  if (!config.exclusions.length) {
    list.innerHTML = '<p class="hint">제외 시간대가 없습니다. 하루 종일 알림이 울릴 수 있어요.</p>';
  }
  config.exclusions.forEach((ex) => {
    const node = document.createElement('div');
    node.className = 'excl';
    node.dataset.id = ex.id;
    node.innerHTML = `
      <div class="top">
        <input type="text" data-field="name" value="${escapeHtml(ex.name)}" style="flex:1;font-weight:600;" />
        <button class="icon-btn" data-act="del" aria-label="삭제">🗑</button>
      </div>
      <div class="editor">
        <div class="times">
          <div class="field"><label>시작</label><input type="time" data-field="start" value="${ex.start}" /></div>
          <div class="field"><label>종료</label><input type="time" data-field="end" value="${ex.end}" /></div>
        </div>
        <div class="field"><label>요일</label>
          <div class="days">${DAYS.map((d, i) => `<button class="daybtn ${ex.days.includes(i) ? 'on' : ''}" data-day="${i}">${d}</button>`).join('')}</div>
        </div>
      </div>`;
    list.appendChild(node);
  });
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function findExcl(id) { return config.exclusions.find((e) => e.id === id); }

// settings event delegation
$('#exclList').addEventListener('input', (e) => {
  const node = e.target.closest('.excl'); if (!node) return;
  const ex = findExcl(node.dataset.id); if (!ex) return;
  const f = e.target.dataset.field;
  if (f === 'name') ex.name = e.target.value;
  if (f === 'start') ex.start = e.target.value;
  if (f === 'end') ex.end = e.target.value;
});
$('#exclList').addEventListener('click', (e) => {
  const node = e.target.closest('.excl'); if (!node) return;
  const ex = findExcl(node.dataset.id); if (!ex) return;
  if (e.target.dataset.act === 'del') {
    config.exclusions = config.exclusions.filter((x) => x.id !== ex.id);
    renderExclusions();
    return;
  }
  if (e.target.dataset.day != null) {
    const day = +e.target.dataset.day;
    const i = ex.days.indexOf(day);
    if (i >= 0) ex.days.splice(i, 1); else ex.days.push(day);
    e.target.classList.toggle('on');
  }
});
$('#addExclBtn').addEventListener('click', () => {
  config.exclusions.push({ id: 'ex' + Date.now(), name: '새 제외', start: '12:00', end: '13:00', days: [0, 1, 2, 3, 4, 5, 6] });
  renderExclusions();
});
$('#cntMinus').addEventListener('click', () => { config.alarmsPerDay = Math.max(1, config.alarmsPerDay - 1); $('#cntVal').textContent = config.alarmsPerDay; });
$('#cntPlus').addEventListener('click', () => { config.alarmsPerDay = Math.min(30, config.alarmsPerDay + 1); $('#cntVal').textContent = config.alarmsPerDay; });
$('#gapSel').addEventListener('change', (e) => { config.minGapMinutes = +e.target.value; });

$('#saveBtn').addEventListener('click', async () => {
  // basic validation
  for (const ex of config.exclusions) {
    if (!/^\d{2}:\d{2}$/.test(ex.start) || !/^\d{2}:\d{2}$/.test(ex.end)) { toast('시간 형식을 확인해주세요'); return; }
  }
  persistConfig();
  $('#saveHint').textContent = '';
  try {
    if (await isSubscribed()) {
      const r = await api('/api/config', 'POST', { userId, timezone: tz, config });
      lastSchedule = r.schedule;
      renderToday(r.schedule);
      toast('저장됐어요 · 오늘 일정 갱신');
    } else {
      toast('저장됐어요 (알림을 켜면 적용돼요)');
    }
  } catch (e) {
    console.error(e);
    toast('저장 중 오류: ' + e.message);
  }
});

// ---- LOG ----
function setPrompt(ts) {
  currentPromptTs = ts || null;
  if (ts) {
    const d = new Date(+ts);
    const hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    $('#logPromptSub').textContent = hhmm + ' 알림 · 그때 무엇을 하고 있었는지 떠오르는 그대로 적어보세요.';
  } else {
    $('#logPromptSub').textContent = '떠오르는 그대로 한 줄 적어보세요. 판단하지 말고, 그저 알아차립니다.';
  }
}

$('#logSaveBtn').addEventListener('click', async () => {
  const note = $('#logInput').value.trim();
  if (!note) { toast('한 줄 적어주세요'); return; }
  await addLog({ ts: Date.now(), note, promptTs: currentPromptTs ? +currentPromptTs : null });
  if (currentPromptTs) await markResponded(+currentPromptTs);
  $('#logInput').value = '';
  currentPromptTs = null;
  setPrompt(null);
  toast('기록했어요');
  renderLogs();
});

async function renderLogs() {
  const logs = await getLogs();
  const list = $('#logList');
  if (!logs.length) { list.innerHTML = '<p class="hint">아직 기록이 없어요.</p>'; return; }
  list.innerHTML = '';
  logs.slice(0, 50).forEach((l) => {
    const d = new Date(l.ts);
    const when = `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const el = document.createElement('div');
    el.className = 'log-entry';
    el.innerHTML = `<div class="when">${when}</div><div class="note">${escapeHtml(l.note)}</div>`;
    list.appendChild(el);
  });
}

// ---- STATS ----
async function renderStats() {
  const received = await getReceived();
  const logs = await getLogs();
  $('#statRecv').textContent = received.length;
  $('#statResp').textContent = logs.length;
  const rate = received.length ? Math.min(100, Math.round((received.filter((r) => r.respondedAt).length / received.length) * 100)) : 0;
  $('#statRate').textContent = rate + '%';

  // last 7 days
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    days.push({ key: dayKey(d.getTime()), label: DAYS[d.getDay()], recv: 0, resp: 0 });
  }
  const byKey = Object.fromEntries(days.map((d) => [d.key, d]));
  received.forEach((r) => { const k = dayKey(r.ts); if (byKey[k]) byKey[k].recv++; });
  logs.forEach((l) => { const k = dayKey(l.ts); if (byKey[k]) byKey[k].resp++; });

  const max = Math.max(1, ...days.map((d) => Math.max(d.recv, d.resp)));
  const H = 110;
  const bars = $('#weekBars');
  bars.innerHTML = '';
  days.forEach((d) => {
    const respH = Math.round((Math.min(d.resp, d.recv) / max) * H);
    const accH = Math.round((Math.max(0, d.recv - Math.min(d.resp, d.recv)) / max) * H);
    const col = document.createElement('div');
    col.className = 'bar-col';
    col.innerHTML = `
      <div class="bar-track">
        <div class="bar" style="height:${accH}px"></div>
        <div class="bar resp" style="height:${respH}px"></div>
      </div>
      <div class="bar-lbl">${d.label}</div>`;
    bars.appendChild(col);
  });
}

// ---- tab navigation ----
function showTab(tab) {
  $$('.view').forEach((v) => v.classList.remove('active'));
  $('#view-' + tab).classList.add('active');
  $$('nav.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'log') renderLogs();
  if (tab === 'stats') renderStats();
  if (tab === 'home') refresh();
  if (tab === 'settings') renderSettings();
}
$$('nav.tabbar button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

$('#enableBtn').addEventListener('click', enableFlow);
$('#testBtn').addEventListener('click', async () => {
  try {
    const r = await api('/api/test', 'POST', { userId });
    toast(r.ok ? '테스트 알림을 보냈어요' : '전송 실패 — 알림 권한을 확인하세요');
  } catch (e) { toast('전송 실패: ' + e.message); }
});

// service worker messages (clicked notification while app open)
navigator.serviceWorker && navigator.serviceWorker.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'open-log') { setPrompt(e.data.ts); showTab('log'); }
});

// ---- init ----
async function init() {
  $('#tzLabel').textContent = tz;
  renderSettings();
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) { console.error('SW reg failed', e); }
  }
  // deep link from notification: ?log=1&ts=...
  const params = new URLSearchParams(location.search);
  if (params.get('log')) {
    setPrompt(params.get('ts'));
    showTab('log');
    history.replaceState(null, '', location.pathname);
  }
  await refresh();
}
init();
