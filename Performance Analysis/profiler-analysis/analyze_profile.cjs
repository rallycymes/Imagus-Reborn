// Consolidated profiler analysis for "Firefox 2026-11-23 13.19 profile.json.gz"
// (Firefox preprocessed profile v78, deviantart.com tab, three deliberate gallery hovers).
//
// Usage:  node analyze_profile.js [path\to\profile.json.gz]
// Defaults to the .gz sitting next to this script. Reproduces every number cited in
// "Performance Analysis.md" Part 2. See Part 3 of that file for format quirks this
// script works around.
//
// Node >= 18, no dependencies.

'use strict';
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const gzPath = process.argv[2] || path.join(__dirname, '..', 'Firefox 2026-11-23 13.19 profile.json.gz');
const p = JSON.parse(zlib.gunzipSync(fs.readFileSync(gzPath)));
const S = p.shared.stringArray;                       // global string table
const stackTable = p.shared.stackTable;               // { frame[], prefixOffset[], length }
const frameTable = p.shared.frameTable;               // { func[], ... }
const funcTable = p.shared.funcTable;                 // { name[], resource[], ... }
const frameArr = stackTable.frame, prefixArr = stackTable.prefixOffset;
const PROF_START = p.meta.profilingStartTime;         // markers use this absolute base

// ---- identities discovered in THIS recording (see Part 3 notes) ----
const IMAGUS_RES = 15;                                // resourceTable[15] = Imagus Reborn - Custom
const IMAGUS_EXT_ID = '{07296774-75b1-41dd-9f41-7183178cb436}';
const DA_PID = '17288';                               // NOTE: pids are STRINGS in this format
const BG_PID = '3044';                                // extension background process

const stackMemo = new Map();
function stackFis(si) {                               // -> array of func indices, leaf first
  const c = stackMemo.get(si);
  if (c) return c;
  const out = [];
  let s = si;
  while (typeof s === 'number' && s >= 0 && s < frameArr.length) {
    out.push(frameTable.func[frameArr[s]]);
    s = prefixArr[s] ? s - prefixArr[s] : -1;         // prefixOffset = distance to parent
  }
  stackMemo.set(si, out);
  return out;
}
const fname = fi => S[funcTable.name[fi]] || '?';
const isIm = fi => funcTable.resource[fi] === IMAGUS_RES;

function ms(x) { return Math.round(x) + ' ms'; }

function thread(pid, name) {
  return p.threads.find(t => t.pid === pid && t.name === name);
}

// Samples: timeDeltas[0] is the absolute start (in ms, ~403M); later deltas are intervals.
// Return relative times (0-based) and duration.
function timeline(t) {
  const td = t.samples.timeDeltas;
  const rel = [];
  let acc = 0;
  for (let i = 0; i < t.samples.stack.length; i++) {
    rel.push(acc);
    acc += td[i + 1] !== undefined ? td[i + 1] : p.meta.interval;
  }
  return { rel, duration: acc, td };
}

// Markers are columnar: name/startTime/endTime/phase/data arrays.
// Phase semantics in this file: 0=instant, 1=interval start (start col = absolute),
// 2=interval end (start col = END time, absolute; end col = garbage sentinel),
// 3=complete interval (start col = garbage sentinel, end col = absolute end).
// 36467.068115234375 appears as the garbage/sentinel value in start/end columns.
function markers(t) {
  const out = [];
  for (let i = 0; i < t.markers.data.length; i++) {
    if (t.markers.data[i] === null && t.markers.name[i] === null) continue;
    out.push({
      name: t.markers.name[i] != null ? S[t.markers.name[i]] : '(null)',
      start: t.markers.startTime[i], end: t.markers.endTime[i],
      phase: t.markers.phase[i], data: t.markers.data[i],
    });
  }
  return out;
}

// ============================== 0. recording map ==============================
console.log('=== RECORDING MAP ===');
console.log('profile start (abs):', PROF_START, ' interval:', p.meta.interval, 'ms');
const hostOf = new Map();
for (const pg of p.pages) {
  let h = '';
  try { h = new URL(pg.url).host || pg.url.slice(0, 30); } catch { h = pg.url.slice(0, 30); }
  hostOf.set(pg.innerWindowID, h);
}
for (const t of p.threads) {
  if (t.name !== 'GeckoMain') continue;
  const hosts = {};
  (t.usedInnerWindowIDs || []).forEach(iw => { const h = hostOf.get(iw) || '?'; hosts[h] = (hosts[h] || 0) + 1; });
  const keys = Object.keys(hosts);
  if (keys.some(h => /deviantart/.test(h))) console.log('deviantart process: pid' + t.pid);
}
const idx = p.meta.extensions.id.indexOf(IMAGUS_EXT_ID);
console.log('Imagus extension:', p.meta.extensions.name[idx], IMAGUS_EXT_ID, '->', p.meta.extensions.baseURL[idx]);
console.log('resourceTable[IMAGUS_RES=' + IMAGUS_RES + ']:', S[p.shared.resourceTable.name[IMAGUS_RES]]);

// ==================== 1. Imagus attribution + bursts (content pid) ====================
const tMain = thread(DA_PID, 'GeckoMain');
const { rel, duration, td } = timeline(tMain);
const stacks = tMain.samples.stack;

let imTime = 0, imSamples = 0;
const imLeafSelf = new Map(), imIncl = new Map();
const spinSampleTimes = [];
for (let i = 0; i < stacks.length; i++) {
  const st = stacks[i];
  if (st == null || st === -1) continue;
  const d = td[i + 1] !== undefined ? td[i + 1] : p.meta.interval;
  const fis = stackFis(st);
  if (!fis.length) continue;
  const names = fis.map(fname);
  const hasIm = fis.some(isIm);
  if (!hasIm) continue;
  imTime += d; imSamples++;
  imLeafSelf.set(names[0], (imLeafSelf.get(names[0]) || 0) + d);
  const seen = new Set();
  for (let j = 0; j < fis.length; j++) {
    if (isIm(fis[j]) && !seen.has(names[j])) { seen.add(names[j]); imIncl.set(names[j], (imIncl.get(names[j]) || 0) + d); }
  }
  if (names.some(n => /SpinEventLoopUntil|XMLHttpRequestMainThread/.test(n))) spinSampleTimes.push(rel[i]);
}
console.log('\n=== IMAGUS ATTRIBUTION (pid' + DA_PID + ' GeckoMain) ===');
console.log('duration:', ms(duration), ' Imagus-attributed sample time:', ms(imTime), 'in', imSamples, 'samples');

// bursts: cluster Imagus samples, gap > 2s
const GAP = 2000;
const bursts = [];
function imSampleTimesSorted() {
  const a = [];
  for (let i = 0; i < stacks.length; i++) {
    const st = stacks[i];
    if (st == null || st === -1) continue;
    if (stackFis(st).some(isIm)) a.push(rel[i]);
  }
  return a.sort((x, y) => x - y);
}
{
  let c2 = null;
  for (const s of imSampleTimesSorted()) {
    if (c2 && s - c2.end > GAP) { bursts.push(c2); c2 = null; }
    if (!c2) c2 = { start: s, end: s };
    c2.end = s;
  }
  if (c2) bursts.push(c2);
  console.log('\nImagus bursts (gap>2s):');
  bursts.forEach((b, i) => console.log('  burst ' + i + ': ' + Math.round(b.start) + ' .. ' + Math.round(b.end) + ' (span ' + Math.round(b.end - b.start) + ')'));
}

// ==================== 2. sync-XHR spin runs ====================
spinSampleTimes.sort((a, b) => a - b);
const runs = [];
let rc = null;
for (const t0 of spinSampleTimes) {
  if (rc && t0 - rc.end > 150) { runs.push(rc); rc = null; }
  if (!rc) rc = { start: t0, end: t0 };
  rc.end = t0;
}
if (rc) runs.push(rc);
const spinTotal = runs.reduce((a, r) => a + (r.end - r.start), 0);
console.log('\n=== SYNC-XHR SPIN RUNS (content process, inside Imagus onMessage -> rule Function) ===');
runs.forEach((r, i) => console.log('  run ' + i + ': ' + Math.round(r.start) + ' .. ' + Math.round(r.end) + '  (~' + Math.round(r.end - r.start) + ' ms)'));
console.log('  total:', ms(spinTotal), '(' + (100 * spinTotal / duration).toFixed(1) + '% of recording)');
console.log('  stack: SpinEventLoopUntil XMLHttpRequestMainThread::SendInternal <- XMLHttpRequest.send <- anonymous');
console.log('         (content/content.js line 3775 > Function) <- onMessage (content.js:3765) <- listen/this.listener (app.js:87)');

// ==================== 3. Imagus leaf self time (top) ====================
console.log('\n=== TOP IMAGUS SELF (leaf) ===');
[...imLeafSelf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22)
  .forEach(([f, v]) => console.log('  ' + String(Math.round(v)).padStart(6) + ' ms  ' + f.slice(0, 110)));
console.log('\n=== TOP IMAGUS INCLUSIVE ===');
[...imIncl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22)
  .forEach(([f, v]) => console.log('  ' + String(Math.round(v)).padStart(6) + ' ms  ' + f.slice(0, 110)));

// ==================== 4. DOMEvent pairing + hover timeline ====================
const tMk = markers(tMain);
const pend = [];
const events = [];
for (let i = 0; i < tMk.length; i++) {
  const m = tMk[i];
  if (m.name !== 'DOMEvent') continue;
  if (m.phase === 2) pend.push({ start: m.start, d: m.data });
  else if (m.phase === 3) {
    let best = -1;
    for (let j = pend.length - 1; j >= 0; j--) {
      const q = pend[j];
      if (q.d?.eventType === m.data?.eventType && q.d?.target === m.data?.target && q.d?.latency === m.data?.latency) { best = j; break; }
    }
    if (best === -1) for (let j = pend.length - 1; j >= 0; j--) if (pend[j].d?.eventType === m.data?.eventType) { best = j; break; }
    if (best >= 0) {
      const q = pend.splice(best, 1)[0];
      events.push({ type: m.data?.eventType || '?', target: String(m.data?.target || ''), start: q.start, end: m.end, dur: m.end - q.start });
    }
  }
}
events.sort((a, b) => a.start - b.start);
console.log('\n=== DOMEVENTS (paired: ' + events.length + ') ===');
const evAgg = {};
for (const e of events) { const a = evAgg[e.type] || (evAgg[e.type] = { n: 0, sum: 0, max: 0 }); a.n++; a.sum += e.dur; a.max = Math.max(a.max, e.dur); }
Object.entries(evAgg).sort((a, b) => b[1].sum - a[1].sum).slice(0, 12)
  .forEach(([k, v]) => console.log('  ' + k + ': n=' + v.n + ' total=' + ms(v.sum) + ' max=' + ms(v.max)));
console.log('\nmouseover events (= the hovers):');
events.filter(e => e.type === 'mouseover').forEach(e =>
  console.log('  rel' + Math.round(e.start - PROF_START) + '  ' + ms(e.dur) + '  ' + e.target.slice(0, 60)));

// ==================== 5. reflow causes ====================
let reflowTot = 0, reflowIm = 0;
for (const m of tMk) {
  if (m.phase !== 2 || !m.data?.cause?.stack) continue;
  if (/Reflow/.test(m.name)) { reflowTot++; if (stackFis(m.data.cause.stack).some(isIm)) reflowIm++; }
}
console.log('\n=== REFLOW CAUSES ===');
console.log('  reflow markers caused by Imagus frames: ' + reflowIm + '/' + reflowTot);

// ==================== 6. GC / CC ====================
// GC/CC markers (GCSlice/GCMajor/GCMinor/CCSlice) are phase 1 but BOTH columns carry
// real absolute timestamps, so dur = end - start. "CC" complete markers use the
// phase-2/3 pair with the garbage sentinel; CCSlice covers the same interval.
let gc = 0, gcN = 0, cc = 0, ccN = 0;
for (const m of tMk) {
  if (m.start == null || m.end == null) continue;
  const d = m.end - m.start;
  if (!(d > 0) || d > 1e6) continue;                 // filters garbage-sentinel pairs
  if (/^GCSlice|^GCMajor|^GCMinor/.test(m.name)) { gc += d; gcN++; }
  if (/^CCSlice/.test(m.name)) { cc += d; ccN++; }
}
console.log('\n=== GC / CC (content process) ===');
console.log('  GC ' + ms(gc) + ' across ' + gcN + ' slices;  CC ' + ms(cc) + ' across ' + ccN + ' slices');

// ==================== 7. main-thread occupancy ====================
let idle = 0, total = 0;
for (let i = 0; i < stacks.length; i++) {
  const st = stacks[i];
  const d = td[i + 1] !== undefined ? td[i + 1] : p.meta.interval;
  total += d;
  if (st == null || st === -1) continue;
  const leaf = fname(stackFis(st)[0] ?? -1);
  if (leaf === '0x7ff95f7fa054') idle += d;    // idle-wait AND spin-wait share this leaf address
}
console.log('\n=== MAIN THREAD OCCUPANCY ===');
console.log('  sampled total:', ms(total), ' idle+spin-wait leaf:', ms(idle), ' other work:', ms(total - idle));
console.log('  NOTE: the 1.59 s sync-XHR spin shares the idle leaf address; true idle = idle - spinTotal.');

// ==================== 8. background process check ====================
const tBg = thread(BG_PID, 'GeckoMain');
if (tBg) {
  let bgIm = 0;
  for (let i = 0; i < tBg.samples.stack.length; i++) {
    const st = tBg.samples.stack[i];
    if (st == null || st === -1) continue;
    if (stackFis(st).some(isIm)) bgIm += tBg.samples.timeDeltas[i + 1] ?? p.meta.interval;
  }
  console.log('\n=== BACKGROUND PROCESS (pid' + BG_PID + ') ===');
  console.log('  Imagus-attributed sample time:', ms(bgIm), '(expected ~0: background fetch is async, no CPU)');
}
