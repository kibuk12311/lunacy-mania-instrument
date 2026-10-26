// End-to-end test of interlude-reader against the fake Interlude fixtures (no real game needed).
//   powershell -File build.ps1   (once)    then    node test.mjs [--keep-log]
// Starts out/fake/FakeInterlude.exe, drives it through stdin commands and checks the reader's JSON lines.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, 'out');
const READER = join(OUT, 'reader', 'interlude-reader.exe');
const FAKE = join(OUT, 'fake', 'FakeInterlude.exe');
const FAKE_RENAMED = join(OUT, 'fake-renamed', 'FakeInterlude.exe');
const FAKE_FD = join(OUT, 'fake-fd', 'FakeInterlude.exe');
for (const f of [READER, FAKE, FAKE_RENAMED, FAKE_FD]) if (!existsSync(f)) { console.error(`missing ${f} - run build.ps1 first`); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const samples = {};
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}

class Proc {
  constructor(exe, args = [], env = {}) {
    this.lines = [];
    this.waiters = [];
    this.p = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    this.exited = new Promise(r => this.p.on('exit', (code) => { this.exitCode = code; r(code); }));
    let buf = '';
    this.p.stdout.on('data', d => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        const rec = { t: Date.now(), line, json: null };
        try { rec.json = JSON.parse(line); } catch { }
        this.lines.push(rec);
        for (const w of [...this.waiters]) if (w.pred(rec)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(rec); }
      }
    });
    this.stderr = '';
    this.p.stderr.on('data', d => { this.stderr += d; });
  }
  get pid() { return this.p.pid; }
  send(cmd) { this.p.stdin.write(cmd + '\n'); }
  // resolves with the first line (already received after `since`, or future) matching pred
  waitFor(pred, timeoutMs = 8000, since = 0) {
    const have = this.lines.find(r => r.t >= since && pred(r));
    if (have) return Promise.resolve(have);
    return new Promise(resolve => {
      const w = { pred: r => r.t >= since && pred(r), resolve };
      this.waiters.push(w);
      setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); resolve(null); } }, timeoutMs);
    });
  }
  kill() { try { this.p.kill(); } catch { } }
}

const J = pred => r => r.json && pred(r.json);
const stateLine = pred => J(j => j.client === 'interlude' && pred(j));

function cpuSeconds(pid) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `$p=Get-Process -Id ${pid}; "$($p.TotalProcessorTime.TotalSeconds) $($p.WorkingSet64) $($p.PrivateMemorySize64)"`], { encoding: 'utf8' }).trim();
    const [cpu, ws, priv] = out.split(/\s+/).map(Number);
    return { cpu, ws, priv };
  } catch { return null; }
}

async function startFake(exe = FAKE, env = {}) {
  const f = new Proc(exe, [], env);
  const ready = await f.waitFor(r => r.line.startsWith('ready'), 15000);
  if (!ready) throw new Error('fake did not start: ' + f.stderr);
  return f;
}

async function cmd(fake, c) {
  const t = Date.now();
  fake.send(c);
  await fake.waitFor(r => r.line === 'ok ' + c, 5000, t);
  return t;
}

const CHART_A = 'hashA|Freedom Dive|xi|4K Another|Mapper One|4|258000|222|6.75';
const CHART_B = 'hashB|Blue Zenith|xi|4K Insane|Mapper Two|4|210000|200|5.25';

// ======================================================================== 1. main scenario (single-file, trimmed fake)
async function mainScenario() {
  console.log('\n== main scenario: single-file trimmed fake (FakeInterlude.exe), reader finds it by name');
  let fake = await startFake();
  const reader = new Proc(READER, ['--name', 'FakeInterlude', '--play-hz', '30']);

  const att = await reader.waitFor(J(j => j.status === 'attached'), 15000);
  check('attached status', !!att && att.json.pid === fake.pid, att ? `clr ${att.json.clr} dac ${att.json.dac?.source} exact=${att.json.dac?.exact}` : 'no attached line');
  if (att) samples.attached = att.json;
  check('version read from Updates.short_version', att?.json.version === '0.7.28.7', att?.json.version);
  check('screen splash', !!(await reader.waitFor(stateLine(j => j.screen === 'splash'))));

  let t = await cmd(fake, 'screen mainmenu');
  check('screen -> mainmenu', !!(await reader.waitFor(stateLine(j => j.screen === 'mainmenu'), 4000, t)));
  t = await cmd(fake, 'screen levelselect');
  check('screen -> levelselect', !!(await reader.waitFor(stateLine(j => j.screen === 'levelselect'), 4000, t)));

  t = await cmd(fake, 'select ' + CHART_A);
  // SelectedChart's file is initialised lazily on first use: the reader has to refresh its DAC view to see it
  let r = await reader.waitFor(stateLine(j => j.chart?.hash === 'hashA'), 8000, t);
  check('selection change -> chart A', !!r, r ? `${r.t - t} ms after select` : 'timeout');
  if (r) {
    samples.selection = r.json;
    const c = r.json.chart;
    check('chart fields', c.title === 'Freedom Dive' && c.artist === 'xi' && c.diff === '4K Another' && c.creator === 'Mapper One'
      && c.keys === 4 && c.lengthMs === 258000 && c.bpm === 222 && Math.abs(c.rating - 6.75) < 1e-4 && c.rate === 1 && Array.isArray(c.mods) && c.mods.length === 0,
      JSON.stringify(c));
  }

  t = await cmd(fake, 'rate 1.25');
  r = await reader.waitFor(stateLine(j => j.chart?.rate === 1.25), 4000, t);
  check('rate change -> 1.25', !!r, r ? `${r.t - t} ms` : 'timeout');

  t = await cmd(fake, 'mods mirror=0,nln=1');
  r = await reader.waitFor(stateLine(j => j.chart?.mods?.length === 2), 4000, t);
  check('mods change', !!r && r.json.chart.mods[0].id === 'mirror' && r.json.chart.mods[1].id === 'nln' && r.json.chart.mods[1].state === 1, r ? JSON.stringify(r.json.chart.mods) : 'timeout');

  t = await cmd(fake, 'select ' + CHART_B);
  r = await reader.waitFor(stateLine(j => j.chart?.hash === 'hashB'), 4000, t);
  check('selection change -> chart B', !!r, r ? `${r.t - t} ms` : 'timeout');

  // no spam while nothing changes
  const quietStart = Date.now() + 1; // strictly after the line we just matched
  await sleep(1500);
  const quietLines = reader.lines.filter(l => l.t >= quietStart && l.json?.client);
  check('selection emitted only on change', quietLines.length === 0,
    `${quietLines.length} lines in 1.5 s of idle level select ${quietLines.map(l => l.line.slice(0, 400)).join(' | ')}`);

  // ---- play
  const cpu0 = cpuSeconds(reader.pid);
  t = await cmd(fake, 'play');
  r = await reader.waitFor(stateLine(j => j.screen === 'play' && j.play), 6000, t);
  check('screen -> play with play object', !!r, r ? `${r.t - t} ms` : 'timeout');
  await sleep(3000);
  t = await cmd(fake, 'gc');            // force compacting GCs mid-play: objects move, reader must re-walk
  await sleep(1500);
  const playFrames = reader.lines.filter(l => l.json?.play && l.json.play.playId === r?.json.play.playId);
  const last = playFrames.at(-1)?.json.play;
  if (playFrames.length > 10) samples.playFrame = playFrames[Math.floor(playFrames.length * 0.6)].json;
  const span = (playFrames.at(-1)?.t - playFrames[0]?.t) / 1000;
  check('play frames at poll rate', playFrames.length / span > 20, `${playFrames.length} frames in ${span.toFixed(2)} s = ${(playFrames.length / span).toFixed(1)}/s`);
  const times = playFrames.map(f => f.json.play.timeMs);
  check('timeMs increases', times.every((v, i) => i === 0 || v >= times[i - 1]) && times.at(-1) - times[0] > 3000, `${times[0]} -> ${times.at(-1)}`);
  check('chart time ~ rate * wall time', !!last && Math.abs((times.at(-1) - times[0]) / 1000 / span - 1.25) < 0.15, `${((times.at(-1) - times[0]) / 1000 / span).toFixed(3)} (rate 1.25)`);
  const sumHits = last ? Object.values(last.hits).reduce((a, b) => a + b, 0) : 0;
  check('judgement counts', !!last && sumHits > 50 && last.hits.MARVELLOUS > 0 && last.hits.MISS > 0 && last.judgements.length === 6, last ? JSON.stringify(last.hits) : '');
  check('accuracy/combo', !!last && last.accuracy > 0.3 && last.accuracy < 1 && last.bestCombo >= 20 && last.comboBreaks > 0, last ? `acc ${last.accuracy} combo ${last.combo} best ${last.bestCombo} breaks ${last.comboBreaks}` : '');
  const allEvents = playFrames.flatMap(f => f.json.play.events || []);
  const idx = allEvents.map(e => e.i);
  check('per-note events: complete, in order, no duplicates', allEvents.length === last?.eventCount && idx.every((v, i) => v === i),
    `${allEvents.length} events vs eventCount ${last?.eventCount}`);
  check('event fields', allEvents.length > 0 && allEvents.every(e => e.k === 'hit' && typeof e.d === 'number' && Math.abs(e.d) <= 30 && typeof e.j === 'number' && typeof e.m === 'boolean'),
    JSON.stringify(allEvents[0]));
  check('missed notes flagged', allEvents.filter(e => e.m).length > 0 && allEvents.filter(e => e.m).every(e => e.j === 5));
  check('key state seen', playFrames.some(f => f.json.play.keysDown.length > 0) && playFrames.some(f => f.json.play.keysDown.length === 0));
  const afterGc = reader.lines.filter(l => l.t > t + 300 && l.json?.play);
  check('survives compacting GC', afterGc.length > 10, `${afterGc.length} frames after gc`);
  check('no error status during play', !reader.lines.some(l => l.json?.status === 'error'), reader.lines.filter(l => l.json?.status === 'error').map(l => l.line).join(' | '));
  const cpu1 = cpuSeconds(reader.pid);
  const playSecs = (Date.now() - quietStart - 1500) / 1000;
  if (cpu0 && cpu1) {
    samples.perf = { cpuPercentOfOneCore: +(100 * (cpu1.cpu - cpu0.cpu) / playSecs).toFixed(2), workingSetMB: +(cpu1.ws / 1048576).toFixed(1), privateMB: +(cpu1.priv / 1048576).toFixed(1), seconds: +playSecs.toFixed(1), pollHz: 30 };
    check('CPU during play < 10% of one core', samples.perf.cpuPercentOfOneCore < 10, JSON.stringify(samples.perf));
  }

  // ---- retry => new play id
  const prevId = last?.playId;
  t = await cmd(fake, 'retry');
  r = await reader.waitFor(stateLine(j => j.play && j.play.playId > prevId), 4000, t);
  check('retry -> new playId', !!r, r ? `playId ${prevId} -> ${r.json.play.playId}` : `timeout; prev ${prevId}; frames since: ${reader.lines.filter(l => l.t >= t - 300 && l.json?.play).slice(0, 12).map(l => `id${l.json.play.playId}/n${l.json.play.eventCount}/t${l.json.play.timeMs}`).join(' ')}`);

  // ---- score screen
  t = await cmd(fake, 'screen score');
  r = await reader.waitFor(stateLine(j => j.screen === 'score' && j.play === null), 4000, t);
  check('screen -> score, play null', !!r);

  // ---- reconnect after the game restarts
  const oldPid = fake.pid;
  const tk = Date.now();
  fake.kill();
  r = await reader.waitFor(J(j => j.status === 'waiting'), 6000, tk);
  check('game exit -> waiting', !!r, r?.line);
  fake = await startFake();
  r = await reader.waitFor(J(j => j.status === 'attached' && j.pid === fake.pid), 15000, tk);
  check('game restart -> re-attached', !!r && fake.pid !== oldPid, r ? `pid ${oldPid} -> ${fake.pid}` : 'timeout');
  t = await cmd(fake, 'select ' + CHART_A);
  r = await reader.waitFor(stateLine(j => j.pid === fake.pid && j.chart?.hash === 'hashA'), 8000, t);
  check('selection after reconnect', !!r);

  // ---- lifetime: stdin EOF => exit 0
  const te = Date.now();
  reader.p.stdin.end();
  const code = await Promise.race([reader.exited, sleep(4000).then(() => 'timeout')]);
  check('reader exits when stdin closes', code === 0, `exit ${code} after ${Date.now() - te} ms`);
  fake.kill();
  reader.kill();
  return reader;
}

// ======================================================================== 2. renamed field
async function renamedScenario() {
  console.log('\n== renamed field: fixture where SelectedChart._rate/rate were renamed');
  const fake = await startFake(FAKE_RENAMED);
  const reader = new Proc(READER, ['--pid', String(fake.pid)]);
  await reader.waitFor(J(j => j.status === 'attached'), 15000);
  let t = await cmd(fake, 'screen levelselect');
  t = await cmd(fake, 'select ' + CHART_A);
  const r = await reader.waitFor(stateLine(j => j.chart?.hash === 'hashA'), 8000, t);
  check('other fields still read', !!r && r.json.chart.title === 'Freedom Dive' && r.json.chart.rate === undefined, r ? JSON.stringify(r.json.chart) : 'timeout');
  await cmd(fake, 'rate 1.5');
  await cmd(fake, 'select ' + CHART_B);
  await reader.waitFor(stateLine(j => j.chart?.hash === 'hashB'), 4000);
  const errs = reader.lines.filter(l => l.json?.status === 'error');
  const rateErrs = errs.filter(l => /_rate/.test(l.json.reason));
  check('missing field -> one error status', rateErrs.length === 1 && rateErrs[0].json.code === 'field_not_found', rateErrs.map(l => l.line).join(' | '));
  if (rateErrs[0]) samples.fieldError = rateErrs[0].json;
  check('no other errors', errs.length === rateErrs.length, errs.map(l => l.line).join(' | '));
  t = await cmd(fake, 'play');
  const p = await reader.waitFor(stateLine(j => j.play && j.play.eventCount > 5), 6000, t);
  check('play still works', !!p);
  check('reader still alive', reader.exitCode === undefined);
  reader.p.stdin.end();
  await Promise.race([reader.exited, sleep(3000)]);
  fake.kill(); reader.kill();
}

// ======================================================================== 3. .NET 9 runtime
async function net9Scenario() {
  console.log('\n== .NET 9 target: framework-dependent fixture rolled forward onto the installed 9.0 runtime');
  const fake = await startFake(FAKE_FD, { DOTNET_ROLL_FORWARD: 'LatestMajor' });
  const reader = new Proc(READER, ['--pid', String(fake.pid)]);
  const att = await reader.waitFor(J(j => j.status === 'attached' || j.status === 'error'), 15000);
  check('attached to .NET 9 process', att?.json.status === 'attached' && /^9\./.test(att.json.clr), att?.line?.slice(0, 300));
  if (att?.json.status === 'attached') samples.net9 = { clr: att.json.clr, dac: att.json.dac };
  let t = await cmd(fake, 'screen levelselect');
  t = await cmd(fake, 'select ' + CHART_B);
  let r = await reader.waitFor(stateLine(j => j.chart?.hash === 'hashB'), 8000, t);
  check('net9: selection', !!r);
  t = await cmd(fake, 'rate 0.9');
  r = await reader.waitFor(stateLine(j => j.chart?.rate === 0.9), 4000, t);
  check('net9: rate', !!r);
  t = await cmd(fake, 'play');
  r = await reader.waitFor(stateLine(j => j.play && j.play.eventCount > 20), 8000, t);
  check('net9: play frames', !!r, r ? `acc ${r.json.play.accuracy} combo ${r.json.play.combo}` : '');

  // Interlude ships its own (unknown) 9.0.x runtime; the reader then falls back to a bundled DAC of another 9.0
  // patch. Simulate: force the bundled 9.0.22 DAC onto this 9.0.21 target.
  const bundled = join(OUT, 'reader', 'dac', '9.0.22', 'mscordaccore.dll');
  if (existsSync(bundled)) {
    let out, code = 0;
    try { out = execFileSync(READER, ['--pid', String(fake.pid), '--dac', bundled, '--once'], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { code = e.status; out = e.stdout || ''; }
    const ls = out.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const a = ls.find(l => l.status === 'attached');
    const snap = ls.find(l => l.client && l.screen);
    check('net9: mismatched 9.0 DAC (9.0.22 on 9.0.21) still reads play', code === 0 && a?.dac?.exact === false && snap?.play?.eventCount > 0,
      `exit ${code} exact=${a?.dac?.exact} eventCount=${snap?.play?.eventCount}`);
    if (a) samples.mismatchDac = { clr: a.clr, dac: a.dac };
  }
  reader.p.stdin.end();
  await Promise.race([reader.exited, sleep(3000)]);
  fake.kill(); reader.kill();
}

// ======================================================================== 4. DAC errors / once / waiting
async function miscScenario() {
  console.log('\n== misc: --once, waiting, dac_not_found');
  let out, code = 0;
  try { out = execFileSync(READER, ['--name', 'NoSuchGame123', '--once'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { code = e.status; out = e.stdout; }
  check('not running -> waiting (and --once exit 2)', JSON.parse(out.trim()).status === 'waiting' && code === 2, `exit ${code} ${out.trim()}`);
  const fake = await startFake();
  await cmd(fake, 'screen levelselect');
  await cmd(fake, 'select ' + CHART_A);
  code = 0;
  try { out = execFileSync(READER, ['--pid', String(fake.pid), '--dac', 'C:\\nope\\mscordaccore.dll', '--once'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { code = e.status; out = e.stdout; }
  const j = JSON.parse(out.trim().split('\n')[0]);
  check('missing DAC -> error dac_not_found, exit 3', j.code === 'dac_not_found' && code === 3, out.trim());
  try { out = execFileSync(READER, ['--pid', String(fake.pid), '--once'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }); code = 0; }
  catch (e) { code = e.status; out = e.stdout; }
  const lines = out.trim().split('\n').map(l => JSON.parse(l));
  check('--once prints attached + one snapshot', code === 0 && lines[0].status === 'attached' && lines.at(-1).screen === 'levelselect', out.trim().slice(0, 300));
  fake.kill();
}

try {
  await mainScenario();
  await renamedScenario();
  await net9Scenario();
  await miscScenario();
} catch (e) {
  check('test harness', false, e.stack);
}

console.log(`\n${results.length - failed}/${results.length} checks passed`);
writeFileSync(join(OUT, 'test-samples.json'), JSON.stringify(samples, null, 2));
console.log(`samples written to ${join(OUT, 'test-samples.json')}`);
process.exit(failed ? 1 : 0);
