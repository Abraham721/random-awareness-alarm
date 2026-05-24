// server.js — Random Awareness Alarm (persistent notifications + re-nudge)
'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const { DateTime } = require('luxon');
const Store = require('./store');
const scheduler = require('./scheduler');

(function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const PORT = process.env.PORT || 3000;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
let VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
if (!/^https?:/i.test(VAPID_SUBJECT) && !/^mailto:/i.test(VAPID_SUBJECT)) VAPID_SUBJECT = 'mailto:' + VAPID_SUBJECT;

if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  console.error('FATAL: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set (see .env).');
  process.exit(1);
}
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const store = new Store(process.env.DATA_FILE || path.join(__dirname, 'data.json'));
const DEFAULT_CONFIG = { alarmsPerDay: 5, minGapMinutes: 30, renudgeIntervalMinutes: 10, renudgeMaxCount: 1, exclusions: [] };
const jsWeekday = (dt) => dt.weekday % 7;
const localNow = (tz) => DateTime.now().setZone(tz || 'UTC');

function ensureSchedule(user, opts) {
  opts = opts || {};
  const tz = user.timezone || 'UTC';
  const dt = localNow(tz);
  const today = dt.toFormat('yyyy-LL-dd');
  if (!user.schedule || user.schedule.date !== today || opts.force) {
    const cfg = user.config || DEFAULT_CONFIG;
    const res = scheduler.generateTimesForDay(cfg, jsWeekday(dt));
    const times = res.times.map(scheduler.formatHHMM);
    const nowMin = dt.hour * 60 + dt.minute;
    const fired = times.filter((t) => scheduler.parseHHMM(t) <= nowMin);
    const now = Date.now();
    const events = {};
    for (const t of fired) events[t] = { firedAt: now, ackedAt: now, nudges: 0, lastNudgeAt: now };
    user.schedule = { date: today, times, fired, events,
      meta: { requested: res.requested, placed: res.placed, capped: res.capped } };
    store.upsertUser(user.id, { schedule: user.schedule });
  }
  if (!user.schedule.events) user.schedule.events = {};
  return user.schedule;
}

async function sendPush(user, payload) {
  try { await webpush.sendNotification(user.subscription, JSON.stringify(payload)); return true; }
  catch (err) {
    const code = err.statusCode;
    if (code === 404 || code === 410) { console.log('Subscription expired; removing user', user.id); store.deleteUser(user.id); }
    else console.error('Push error', code, (err.body || err.message || '').toString().slice(0, 200));
    return false;
  }
}

async function tick() {
  const now = Date.now();
  for (const user of store.allUsers()) {
    if (!user.subscription || !user.config) continue;
    const cfg = user.config;
    const dt = localNow(user.timezone || 'UTC');
    const sched = ensureSchedule(user);
    const hhmm = dt.toFormat('HH:mm');
    let changed = false;

    if (sched.times.includes(hhmm) && !sched.events[hhmm]) {
      await sendPush(user, { title: '지금, 알아차리기', body: '지금 이 순간 당신은 무엇을 하고 있나요?',
        tag: 'aw-' + sched.date + '-' + hhmm, ts: now, date: sched.date, time: hhmm, userId: user.id, kind: 'alarm' });
      sched.events[hhmm] = { firedAt: now, ackedAt: null, nudges: 0, lastNudgeAt: now };
      if (!sched.fired.includes(hhmm)) sched.fired.push(hhmm);
      changed = true;
    }

    const intervalMs = (cfg.renudgeIntervalMinutes || 10) * 60000;
    const maxCount = cfg.renudgeMaxCount || 0;
    if (maxCount > 0) {
      for (const t of Object.keys(sched.events)) {
        const ev = sched.events[t];
        if (ev.ackedAt || ev.nudges >= maxCount) continue;
        if (now - ev.lastNudgeAt >= intervalMs) {
          await sendPush(user, { title: '아직 거기 있나요?', body: '조금 전 알아차림 알림이 있었어요. 지금은 무엇을 하고 있나요?',
            tag: 'aw-nudge-' + sched.date + '-' + t + '-' + ev.nudges, ts: now, date: sched.date, time: t, userId: user.id, kind: 'nudge' });
          ev.nudges += 1; ev.lastNudgeAt = now; changed = true;
        }
      }
    }
    if (changed) store.upsertUser(user.id, { schedule: sched });
  }
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function sanitizeConfig(c) {
  c = c || {};
  const alarmsPerDay = Math.max(1, Math.min(60, Math.floor(c.alarmsPerDay || 5)));
  const minGapMinutes = Math.max(1, Math.min(720, Math.floor(c.minGapMinutes != null ? c.minGapMinutes : 30)));
  const exclusions = Array.isArray(c.exclusions)
    ? c.exclusions.slice(0, 50).map((e, i) => ({
        id: e.id || ('ex' + i + '-' + Date.now()), name: String(e.name || '제외').slice(0, 40),
        start: e.start, end: e.end, days: Array.isArray(e.days) ? e.days.filter((d) => d >= 0 && d <= 6) : [],
      })).filter((e) => { try { scheduler.parseHHMM(e.start); scheduler.parseHHMM(e.end); return true; } catch (_) { return false; } })
    : [];
  const renudgeIntervalMinutes = Math.max(1, Math.min(180, Math.floor(c.renudgeIntervalMinutes != null ? c.renudgeIntervalMinutes : 10)));
  const renudgeMaxCount = Math.max(0, Math.min(5, Math.floor(c.renudgeMaxCount != null ? c.renudgeMaxCount : 1)));
  return { alarmsPerDay, minGapMinutes, renudgeIntervalMinutes, renudgeMaxCount, exclusions };
}

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/api/vapidPublicKey', (req, res) => res.json({ publicKey: VAPID_PUBLIC }));

app.post('/api/subscribe', (req, res) => {
  const { userId, subscription, timezone, config } = req.body || {};
  if (!userId || !subscription) return res.status(400).json({ error: 'userId and subscription required' });
  const user = store.upsertUser(userId, { subscription, timezone: timezone || 'UTC', config: sanitizeConfig(config) });
  res.json({ ok: true, schedule: ensureSchedule(user, { force: true }) });
});

app.post('/api/config', (req, res) => {
  const { userId, timezone, config } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const existing = store.getUser(userId);
  if (!existing) return res.status(404).json({ error: 'unknown user; subscribe first' });
  const user = store.upsertUser(userId, { timezone: timezone || existing.timezone || 'UTC', config: sanitizeConfig(config) });
  res.json({ ok: true, schedule: ensureSchedule(user, { force: true }) });
});

app.get('/api/schedule', (req, res) => {
  const user = store.getUser(req.query.userId);
  if (!user) return res.status(404).json({ error: 'unknown user' });
  res.json({ ok: true, schedule: ensureSchedule(user), config: user.config, timezone: user.timezone });
});

app.post('/api/ack', (req, res) => {
  const { userId, date, time } = req.body || {};
  const user = store.getUser(userId);
  if (!user || !user.schedule || user.schedule.date !== date) return res.json({ ok: false });
  const ev = user.schedule.events && user.schedule.events[time];
  if (ev && !ev.ackedAt) { ev.ackedAt = Date.now(); store.upsertUser(userId, { schedule: user.schedule }); }
  res.json({ ok: true });
});

app.post('/api/test', async (req, res) => {
  const user = store.getUser((req.body || {}).userId);
  if (!user) return res.status(404).json({ error: 'unknown user' });
  const ok = await sendPush(user, { title: '테스트 알림 🔔', body: '알림이 잘 도착했어요. 지금 무엇을 하고 있나요?', tag: 'test-' + Date.now(), ts: Date.now(), kind: 'test' });
  res.json({ ok });
});

app.post('/api/unsubscribe', (req, res) => { const { userId } = req.body || {}; if (userId) store.deleteUser(userId); res.json({ ok: true }); });

if (require.main === module) {
  cron.schedule('* * * * *', () => { tick().catch((e) => console.error('tick error', e)); });
  const server = app.listen(PORT, () => console.log('Random Awareness Alarm server listening on :' + PORT));
  const shutdown = () => { try { store.saveNow(); } catch (_) {} server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

module.exports = { app, ensureSchedule, sanitizeConfig, tick, store };
