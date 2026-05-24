// server.js — Random Awareness Alarm
// Serves the PWA and dispatches Web Push notifications at each user's
// randomly-generated daily alarm times (computed in their own timezone,
// respecting their exclusion windows).
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const { DateTime } = require('luxon');
const Store = require('./store');
const scheduler = require('./scheduler');

// ---- minimal .env loader (no dotenv dependency) ----
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
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  console.error('FATAL: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set (see .env).');
  process.exit(1);
}
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const store = new Store(process.env.DATA_FILE || path.join(__dirname, 'data.json'));
const DEFAULT_CONFIG = { alarmsPerDay: 5, minGapMinutes: 30, exclusions: [] };

// luxon weekday: 1=Mon..7=Sun  ->  JS: 0=Sun..6=Sat
const jsWeekday = (dt) => dt.weekday % 7;
const localNow = (tz) => DateTime.now().setZone(tz || 'UTC');

// Ensure the user has a schedule for "today" in their timezone.
function ensureSchedule(user, opts) {
  opts = opts || {};
  const tz = user.timezone || 'UTC';
  const dt = localNow(tz);
  const today = dt.toFormat('yyyy-LL-dd');
  if (!user.schedule || user.schedule.date !== today || opts.force) {
    const cfg = user.config || DEFAULT_CONFIG;
    const res = scheduler.generateTimesForDay(cfg, jsWeekday(dt));
    const times = res.times.map(scheduler.formatHHMM);
    // Times already elapsed today are marked fired so we never back-fire.
    const nowMin = dt.hour * 60 + dt.minute;
    const fired = times.filter((t) => scheduler.parseHHMM(t) <= nowMin);
    user.schedule = {
      date: today,
      times,
      fired,
      meta: { requested: res.requested, placed: res.placed, capped: res.capped },
    };
    store.upsertUser(user.id, { schedule: user.schedule });
  }
  return user.schedule;
}

async function sendPush(user, payload) {
  try {
    await webpush.sendNotification(user.subscription, JSON.stringify(payload));
    return true;
  } catch (err) {
    const code = err.statusCode;
    if (code === 404 || code === 410) {
      console.log('Subscription expired; removing user', user.id);
      store.deleteUser(user.id);
    } else {
      console.error('Push error', code, (err.body || err.message || '').toString().slice(0, 200));
    }
    return false;
  }
}

// ---- per-minute dispatch loop ----
async function tick() {
  for (const user of store.allUsers()) {
    if (!user.subscription || !user.config) continue;
    const dt = localNow(user.timezone || 'UTC');
    const sched = ensureSchedule(user);
    const hhmm = dt.toFormat('HH:mm');
    if (sched.times.includes(hhmm) && !sched.fired.includes(hhmm)) {
      await sendPush(user, {
        title: '지금, 알아차리기',
        body: '지금 이 순간 당신은 무엇을 하고 있나요?',
        tag: 'awareness-' + sched.date + '-' + hhmm,
        ts: Date.now(),
      });
      sched.fired.push(hhmm);
      store.upsertUser(user.id, { schedule: sched });
    }
  }
}
cron.schedule('* * * * *', () => { tick().catch((e) => console.error('tick error', e)); });

// ---- HTTP API ----
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function sanitizeConfig(c) {
  c = c || {};
  const alarmsPerDay = Math.max(1, Math.min(60, Math.floor(c.alarmsPerDay || 5)));
  const minGapMinutes = Math.max(1, Math.min(720, Math.floor(c.minGapMinutes != null ? c.minGapMinutes : 30)));
  const exclusions = Array.isArray(c.exclusions)
    ? c.exclusions.slice(0, 50).map((e, i) => ({
        id: e.id || ('ex' + i + '-' + Date.now()),
        name: String(e.name || '제외').slice(0, 40),
        start: e.start,
        end: e.end,
        days: Array.isArray(e.days) ? e.days.filter((d) => d >= 0 && d <= 6) : [],
      })).filter((e) => {
        try { scheduler.parseHHMM(e.start); scheduler.parseHHMM(e.end); return true; }
        catch (_) { return false; }
      })
    : [];
  return { alarmsPerDay, minGapMinutes, exclusions };
}

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/api/vapidPublicKey', (req, res) => res.json({ publicKey: VAPID_PUBLIC }));

app.post('/api/subscribe', (req, res) => {
  const { userId, subscription, timezone, config } = req.body || {};
  if (!userId || !subscription) return res.status(400).json({ error: 'userId and subscription required' });
  const user = store.upsertUser(userId, {
    subscription,
    timezone: timezone || 'UTC',
    config: sanitizeConfig(config),
  });
  const schedule = ensureSchedule(user, { force: true });
  res.json({ ok: true, schedule });
});

app.post('/api/config', (req, res) => {
  const { userId, timezone, config } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const existing = store.getUser(userId);
  if (!existing) return res.status(404).json({ error: 'unknown user; subscribe first' });
  const user = store.upsertUser(userId, {
    timezone: timezone || existing.timezone || 'UTC',
    config: sanitizeConfig(config),
  });
  const schedule = ensureSchedule(user, { force: true });
  res.json({ ok: true, schedule });
});

app.get('/api/schedule', (req, res) => {
  const user = store.getUser(req.query.userId);
  if (!user) return res.status(404).json({ error: 'unknown user' });
  const schedule = ensureSchedule(user);
  res.json({ ok: true, schedule, config: user.config, timezone: user.timezone });
});

app.post('/api/test', async (req, res) => {
  const user = store.getUser((req.body || {}).userId);
  if (!user) return res.status(404).json({ error: 'unknown user' });
  const ok = await sendPush(user, {
    title: '테스트 알림 🔔',
    body: '알림이 잘 도착했어요. 지금 무엇을 하고 있나요?',
    tag: 'test-' + Date.now(),
    ts: Date.now(),
  });
  res.json({ ok });
});

app.post('/api/unsubscribe', (req, res) => {
  const { userId } = req.body || {};
  if (userId) store.deleteUser(userId);
  res.json({ ok: true });
});

const server = app.listen(PORT, () => {
  console.log('Random Awareness Alarm server listening on :' + PORT);
});

function shutdown() { try { store.saveNow(); } catch (_) {} server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, ensureSchedule, sanitizeConfig, tick };
