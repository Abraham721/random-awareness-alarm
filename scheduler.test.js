'use strict';
const S = require('./scheduler');
let passed = 0, failed = 0;
function ok(cond, msg){ if(cond)passed++; else { failed++; console.error('  FAIL: '+msg);} }
const inAnyFree = (min, free) => free.some(([a,b]) => min>=a && min<b);
ok(S.parseHHMM('07:30')===450,'07:30->450');
ok(S.formatHHMM(450)==='07:30','450->07:30');
ok(JSON.stringify(S.expandExclusion({start:'23:00',end:'07:00'}))===JSON.stringify([[1380,1440],[0,420]]),'wrap');
{ const cfg={alarmsPerDay:5,minGapMinutes:30,exclusions:[]}; const r=S.generateTimesForDay(cfg,1,S.mulberry32(12345));
  ok(r.placed===5,'placed 5'); let sp=true; for(let i=1;i<r.times.length;i++)if(r.times[i]-r.times[i-1]<30)sp=false; ok(sp,'gap>=30'); }
{ const cfg={alarmsPerDay:6,minGapMinutes:20,exclusions:[{name:'s',start:'23:00',end:'07:00',days:[0,1,2,3,4,5,6]},{name:'w',start:'09:00',end:'18:00',days:[1,2,3,4,5]}]};
  const free=S.complement(S.mergeIntervals(S.activeExclusionSegments(cfg.exclusions,1)));
  ok(JSON.stringify(free)===JSON.stringify([[420,540],[1080,1380]]),'Mon free windows');
  const r=S.generateTimesForDay(cfg,1,S.mulberry32(999)); ok(r.times.every(t=>inAnyFree(t,free)),'no Mon alarm in blocked'); }
console.log('\nPASSED '+passed+'  FAILED '+failed);
process.exit(failed?1:0);
