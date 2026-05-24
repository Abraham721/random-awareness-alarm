// scheduler.test.js  — run with: npm test  (or: node scheduler.test.js)
'use strict';
const S = require('./scheduler');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  FAIL: ' + msg); }
}
function section(name) { console.log('\n# ' + name); }

// Helpers
const inAnyFree = (min, free) => free.some(([a, b]) => min >= a && min < b);

section('parse / format');
ok(S.parseHHMM('00:00') === 0, '00:00 -> 0');
ok(S.parseHHMM('07:30') === 450, '07:30 -> 450');
ok(S.parseHHMM('23:59') === 1439, '23:59 -> 1439');
ok(S.formatHHMM(450) === '07:30', '450 -> 07:30');
ok(S.formatHHMM(0) === '00:00', '0 -> 00:00');

section('exclusion expansion');
ok(JSON.stringify(S.expandExclusion({ start: '09:00', end: '18:00' })) === JSON.stringify([[540, 1080]]), 'normal window');
ok(JSON.stringify(S.expandExclusion({ start: '23:00', end: '07:00' })) === JSON.stringify([[1380, 1440], [0, 420]]), 'wrap window splits');
ok(S.expandExclusion({ start: '08:00', end: '08:00' }).length === 0, 'zero-length window ignored');

section('no exclusions: N alarms, spaced, in range');
{
  const cfg = { alarmsPerDay: 5, minGapMinutes: 30, exclusions: [] };
  const rng = S.mulberry32(12345);
  const r = S.generateTimesForDay(cfg, 1, rng);
  ok(r.placed === 5, 'placed 5');
  ok(r.times.length === 5, '5 times');
  ok(r.times.every((t) => t >= 0 && t < 1440), 'all in [0,1440)');
  let spaced = true;
  for (let i = 1; i < r.times.length; i++) if (r.times[i] - r.times[i - 1] < 30) spaced = false;
  ok(spaced, 'min gap >= 30 respected');
  let sorted = true;
  for (let i = 1; i < r.times.length; i++) if (r.times[i] < r.times[i - 1]) sorted = false;
  ok(sorted, 'returned sorted');
}

section('weekday exclusions: sleep + work on a weekday (Mon)');
{
  const cfg = {
    alarmsPerDay: 6,
    minGapMinutes: 20,
    exclusions: [
      { name: 'sleep', start: '23:00', end: '07:00', days: [0, 1, 2, 3, 4, 5, 6] },
      { name: 'work', start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
    ],
  };
  const free = S.complement(S.mergeIntervals(S.activeExclusionSegments(cfg.exclusions, 1)));
  // Expected free windows on Monday: 07:00-09:00 and 18:00-23:00
  ok(JSON.stringify(free) === JSON.stringify([[420, 540], [1080, 1380]]), 'Mon free windows = 07:00-09:00, 18:00-23:00');
  const rng = S.mulberry32(999);
  const r = S.generateTimesForDay(cfg, 1, rng);
  ok(r.times.every((t) => inAnyFree(t, free)), 'no Mon alarm lands in sleep or work');
  ok(r.times.every((t) => !(t >= 540 && t < 1080)), 'none during 09:00-18:00 work');
  ok(r.times.every((t) => t >= 420 && t < 1380), 'none during sleep 23:00-07:00');
}

section('weekend: work window not active (Sun)');
{
  const cfg = {
    alarmsPerDay: 4,
    minGapMinutes: 30,
    exclusions: [
      { name: 'sleep', start: '23:00', end: '07:00', days: [0, 1, 2, 3, 4, 5, 6] },
      { name: 'work', start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
    ],
  };
  const free = S.complement(S.mergeIntervals(S.activeExclusionSegments(cfg.exclusions, 0)));
  // On Sunday only sleep applies -> free 07:00-23:00
  ok(JSON.stringify(free) === JSON.stringify([[420, 1380]]), 'Sun free = 07:00-23:00');
  const r = S.generateTimesForDay(cfg, 0, S.mulberry32(7));
  ok(r.times.some((t) => t >= 540 && t < 1080), 'Sunday CAN place alarms during 09:00-18:00');
}

section('over-constrained day: caps placed count, keeps gap');
{
  // Only 07:00-08:00 free (60 min), gap 30 -> at most ~3 fit (0,30,60 boundaries) but
  // with exclusive end and >=30 gap realistically 2-3. Request 10.
  const cfg = {
    alarmsPerDay: 10,
    minGapMinutes: 30,
    exclusions: [{ name: 'block', start: '08:00', end: '07:00', days: [0, 1, 2, 3, 4, 5, 6] }],
  };
  // wrap 08:00->07:00 blocks everything except 07:00-08:00
  const free = S.complement(S.mergeIntervals(S.activeExclusionSegments(cfg.exclusions, 3)));
  ok(JSON.stringify(free) === JSON.stringify([[420, 480]]), 'free = 07:00-08:00 only');
  const r = S.generateTimesForDay(cfg, 3, S.mulberry32(3));
  ok(r.placed < r.requested && r.capped === true, 'capped below requested');
  ok(r.placed >= 1, 'placed at least one');
  let spaced = true;
  for (let i = 1; i < r.times.length; i++) if (r.times[i] - r.times[i - 1] < 30) spaced = false;
  ok(spaced, 'gap still respected when capped');
}

section('determinism with seeded rng');
{
  const cfg = { alarmsPerDay: 5, minGapMinutes: 25, exclusions: [] };
  const a = S.generateTimesForDay(cfg, 2, S.mulberry32(42)).times;
  const b = S.generateTimesForDay(cfg, 2, S.mulberry32(42)).times;
  ok(JSON.stringify(a) === JSON.stringify(b), 'same seed -> same schedule');
}

section('fully blocked day -> no alarms');
{
  const cfg = {
    alarmsPerDay: 5,
    minGapMinutes: 30,
    exclusions: [{ name: 'all', start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] }],
  };
  const r = S.generateTimesForDay(cfg, 4, S.mulberry32(1));
  ok(r.times.length <= 1, 'almost no room (<=1 min free)');
}

console.log('\n--------------------------------------');
console.log(`PASSED ${passed}  FAILED ${failed}`);
process.exit(failed ? 1 : 0);
