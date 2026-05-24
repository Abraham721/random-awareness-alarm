// scheduler.js
// Pure, dependency-free scheduling engine.
// Turns a user's config (N alarms/day + free-form exclusion windows with
// per-weekday rules) into concrete random alarm times for a given weekday.
//
// Conventions:
//   - Times are minutes-from-midnight integers in [0, 1440).
//   - Weekday is 0=Sunday .. 6=Saturday (JS Date.getDay convention).
//   - Exclusion windows that wrap past midnight (end <= start), e.g. a
//     "sleep" window 23:00->07:00, are treated as blocking the late-night
//     segment AND the early-morning segment of that same weekday.

'use strict';

function parseHHMM(s) {
  if (typeof s !== 'string') throw new Error('time must be "HH:MM"');
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error('invalid time: ' + s);
  const h = +m[1], min = +m[2];
  if (h < 0 || h > 23 || min < 0 || min > 59) throw new Error('out of range time: ' + s);
  return h * 60 + min;
}

function formatHHMM(min) {
  min = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// Expand a single exclusion into [start,end) segments within [0,1440).
function expandExclusion(ex) {
  const s = parseHHMM(ex.start);
  const e = parseHHMM(ex.end);
  if (s === e) return []; // zero-length window = no effect
  if (e > s) return [[s, e]];
  return [[s, 1440], [0, e]]; // wraps past midnight
}

// All blocked segments active on the given weekday.
function activeExclusionSegments(exclusions, weekday) {
  const segs = [];
  for (const ex of exclusions || []) {
    const days = Array.isArray(ex.days) ? ex.days : [];
    if (!days.includes(weekday)) continue;
    for (const seg of expandExclusion(ex)) segs.push(seg);
  }
  return segs;
}

// Merge overlapping/adjacent [start,end) intervals.
function mergeIntervals(intervals) {
  if (!intervals.length) return [];
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  const out = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (cur[0] <= last[1]) {
      last[1] = Math.max(last[1], cur[1]);
    } else {
      out.push(cur.slice());
    }
  }
  return out;
}

// Complement of blocked intervals within [0,1440).
function complement(blocked) {
  const free = [];
  let cursor = 0;
  for (const [a, b] of blocked) {
    if (a > cursor) free.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < 1440) free.push([cursor, 1440]);
  return free;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Generate alarm times for a single day.
//   config: { alarmsPerDay, minGapMinutes, exclusions: [{name,start,end,days}] }
//   weekday: 0=Sun..6=Sat
//   rng: optional () => [0,1) for deterministic tests
// Returns { times:number[] (sorted minutes), requested, placed, capped:boolean }
function generateTimesForDay(config, weekday, rng) {
  rng = rng || Math.random;
  const N = Math.max(0, Math.floor(config.alarmsPerDay || 0));
  const g = Math.max(1, Math.floor(config.minGapMinutes != null ? config.minGapMinutes : 30));

  const blocked = mergeIntervals(activeExclusionSegments(config.exclusions, weekday));
  const free = complement(blocked);

  const freeMinutes = [];
  for (const [a, b] of free) for (let m = a; m < b; m++) freeMinutes.push(m);

  const L = freeMinutes.length;
  if (N === 0 || L === 0) {
    return { times: [], requested: N, placed: 0, capped: N > 0 };
  }

  // Try to place `target` alarms; reduce target if the day is too constrained.
  for (let target = N; target >= 1; target--) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const picks = [];
      // Stratified sampling: one pick per equal-width bucket of the free
      // timeline -> even spread across the day.
      for (let i = 0; i < target; i++) {
        const lo = Math.floor((i * L) / target);
        const hi = Math.floor(((i + 1) * L) / target);
        const span = Math.max(1, hi - lo);
        const idx = Math.min(L - 1, lo + Math.floor(rng() * span));
        picks.push(freeMinutes[idx]);
      }
      picks.sort((a, b) => a - b);
      let ok = true;
      for (let i = 1; i < picks.length; i++) {
        if (picks[i] - picks[i - 1] < g) { ok = false; break; }
      }
      if (ok) {
        return { times: picks, requested: N, placed: target, capped: target < N };
      }
    }
  }

  // Fallback: at least one alarm somewhere free.
  return {
    times: [freeMinutes[Math.floor(rng() * L)]],
    requested: N,
    placed: 1,
    capped: N > 1,
  };
}

module.exports = {
  parseHHMM,
  formatHHMM,
  expandExclusion,
  activeExclusionSegments,
  mergeIntervals,
  complement,
  mulberry32,
  generateTimesForDay,
};
