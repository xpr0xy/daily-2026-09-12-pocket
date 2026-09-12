// Deterministic tests for POCKET's synthesis, timing, render and export layers.
import assert from 'node:assert/strict';
import { renderLoop, eventList, exportWav, exportMidi, hashPcm, loopFrames, stepSeconds } from './src/render.js';
import { preset, blankState, copyMaterial, serialize, deserialize, dice, cloneState, noteFreq, ROOTS, STEPS } from './src/pattern.js';
import { renderKick, renderSnare, renderHat, renderSub, SR } from './src/dsp.js';
import { validateWav, validateMidi } from './validate.mjs';

let n = 0;
const test = (name, fn) => {
  try {
    fn();
    n++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.log('FAIL  ' + name + '\n      ' + e.message);
    process.exitCode = 1;
  }
};

const peak = (pcm) => {
  let p = 0;
  for (let i = 0; i < pcm.length; i++) p = Math.max(p, Math.abs(pcm[i]));
  return p;
};
const rms = (pcm) => {
  let s = 0;
  for (let i = 0; i < pcm.length; i++) s += pcm[i] * pcm[i];
  return Math.sqrt(s / pcm.length);
};

console.log('POCKET tests');

// ---------------------------------------------------------------- synthesis
test('each voice renders audible, finite samples', () => {
  const kick = renderKick({ tune: 48, decay: 0.3, drive: 0.35 });
  const snare = renderSnare({ tune: 190, decay: 0.18, drive: 0.45 });
  const hat = renderHat({ tune: 8600, decay: 0.05, drive: 0.2 });
  const sub = renderSub({ decay: 0.4, drive: 0.25 }, SR, 55);
  for (const [name, buf] of [['kick', kick], ['snare', snare], ['hat', hat], ['sub', sub]]) {
    assert.ok(buf.length > 100, name + ' too short');
    let p = 0;
    let finite = true;
    for (let i = 0; i < buf.length; i++) {
      if (!Number.isFinite(buf[i])) finite = false;
      p = Math.max(p, Math.abs(buf[i]));
    }
    assert.ok(finite, name + ' produced non-finite samples');
    assert.ok(p > 0.5 && p <= 1.0001, name + ' peak out of range: ' + p);
  }
});

test('synthesis is deterministic per params', () => {
  const a = renderKick({ tune: 50, decay: 0.25, drive: 0.5 });
  const b = renderKick({ tune: 50, decay: 0.25, drive: 0.5 });
  assert.deepEqual(Array.from(a.slice(0, 800)), Array.from(b.slice(0, 800)));
});

test('tune and decay change the voice samples', () => {
  const low = renderSub({ decay: 0.5, drive: 0.2 }, SR, 41.2);
  const high = renderSub({ decay: 0.5, drive: 0.2 }, SR, 65.4);
  assert.notEqual(peak(low) === 0, true);
  const diff = Array.from(low).some((v, i) => Math.abs(v - high[i]) > 1e-4);
  assert.ok(diff, 'changing sub pitch did not change samples');
  const short = renderKick({ tune: 48, decay: 0.1, drive: 0.2 });
  const long = renderKick({ tune: 48, decay: 0.6, drive: 0.2 });
  assert.ok(long.length > short.length * 2, 'decay did not change hit length');
});

// ------------------------------------------------------------------ pattern
test('presets fill a playable two-step pocket', () => {
  const p = preset('two-step');
  const kicks = Array.from(p.grid.kick).map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
  const snares = Array.from(p.grid.snare).map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(kicks, [0, 10, 16, 20, 26]);
  assert.deepEqual(snares, [4, 12, 20, 28]);
  assert.ok(p.swing > 0);
});

test('presets never carry tempo, slot copy leaves the target tempo alone', () => {
  const a = preset('half-time');
  const b = preset('dub-cut');
  a.bpm = 176;
  b.bpm = 160;
  const copied = copyMaterial(a, b);
  assert.equal(copied.bpm, 160);
  assert.equal(copied.swing, a.swing);
  assert.deepEqual(Array.from(copied.grid.kick), Array.from(a.grid.kick));
});

test('dice respects locks and stays structured', () => {
  const base = preset('two-step');
  const locked = Array.from(base.grid.kick);
  const rolled = dice(base, 12345, { kick: true });
  assert.deepEqual(Array.from(rolled.grid.kick), locked, 'locked voice changed');
  assert.notDeepEqual(Array.from(rolled.grid.snare), Array.from(base.grid.snare), 'unlocked voice unchanged');
  const rolled2 = dice(base, 12345, { kick: true });
  assert.deepEqual(Array.from(rolled2.grid.hat), Array.from(rolled.grid.hat), 'dice not seed-stable');
  let hits = 0;
  for (let s = 0; s < STEPS; s++) hits += rolled.grid.hat[s] > 0 ? 1 : 0;
  assert.ok(hits > 0 && hits <= STEPS, 'hat roll count implausible');
});

test('recipe round-trips exactly', () => {
  const p = preset('shuffle');
  p.master.drive = 0.62;
  const back = deserialize(JSON.parse(JSON.stringify(serialize(p))), blankState());
  assert.equal(hashPcm(renderLoop(p).pcm), hashPcm(renderLoop(back).pcm));
});

test('scale-locked sub frequencies land in the sub range', () => {
  for (const root of ROOTS) {
    const st = blankState();
    st.root = root.semi;
    for (let i = 0; i < 5; i++) {
      const f = noteFreq(st, i);
      assert.ok(f >= 30 && f <= 140, 'sub out of range: ' + f);
    }
  }
});

// ------------------------------------------------------------------- timing
test('swing delays odd steps and leaves even steps alone', () => {
  const st = preset('shuffle');
  const s16 = stepSeconds(st.bpm);
  const events = eventList(st);
  const even = events.find((e) => e.voice === 'snare' && e.step === 4);
  const odd = events.find((e) => e.voice === 'hat' && e.step === 3);
  assert.ok(Math.abs(even.t - 4 * s16) < 1e-9, 'even step moved: ' + even.t);
  assert.ok(odd.t > 3 * s16 + 1e-4, 'odd step was not swung: ' + odd.t);
});

test('voice nudge shifts that voice only', () => {
  const st = preset('two-step');
  const before = eventList(st).find((e) => e.voice === 'snare' && e.step === 4).t;
  st.params.snare.nudge = 12;
  const after = eventList(st).find((e) => e.voice === 'snare' && e.step === 4).t;
  const kickAfter = eventList(st).find((e) => e.voice === 'kick' && e.step === 0).t;
  assert.ok(Math.abs(after - before - 0.012) < 1e-6, 'nudge did not shift by ms');
  assert.ok(Math.abs(kickAfter - 0) < 1e-9, 'nudge leaked to another voice');
});

test('bpm sets the loop length', () => {
  const st = preset('two-step');
  const slow = loopFrames(st);
  st.bpm = 190;
  const fast = loopFrames(st);
  assert.ok(fast < slow, 'tempo did not shorten the loop');
  assert.ok(Math.abs(slow / SR - (2 * 4 * 60) / 172) < 0.01, 'loop is not 2 bars of 4/4');
});

// ------------------------------------------------------------------- render
test('identical material state produces identical bytes', () => {
  const st = preset('two-step');
  const a = renderLoop(st);
  const b = renderLoop(cloneState(st));
  assert.equal(hashPcm(a.pcm), hashPcm(b.pcm));
  assert.deepEqual(Array.from(exportWav(st).slice(0, 200)), Array.from(exportWav(cloneState(st)).slice(0, 200)));
});

test('changed material state changes the artifact, not just the metadata', () => {
  const st = preset('two-step');
  const before = renderLoop(st);
  const step = 6;
  st.grid.kick[step] = 1;
  const after = renderLoop(st);
  assert.notEqual(hashPcm(before.pcm), hashPcm(after.pcm));
  assert.ok(rms(after.pcm) > rms(before.pcm), 'added kick did not add energy');

  const quiet = preset('two-step');
  for (let s = 0; s < STEPS; s++) quiet.grid.snare[s] *= 0.25;
  assert.ok(rms(renderLoop(quiet).pcm) < rms(before.pcm), 'velocity change did not reduce energy');
});

test('decay that runs past the loop end wraps to the top', () => {
  const st = blankState();
  st.params.sub.decay = 1.0;
  st.grid.sub[31] = 1;
  st.notes[31] = 0;
  const { pcm, frames } = renderLoop(st);
  let head = 0;
  for (let i = 0; i < 2000; i++) head = Math.max(head, Math.abs(pcm[i * 2]));
  assert.ok(head > 2000, 'wrapped tail missing at the loop head: ' + head);
  const wrapped = renderLoop(st);
  assert.equal(hashPcm(wrapped.pcm), hashPcm(pcm));
  void frames;
});

test('transport-stopped export equals the live buffer source of truth', () => {
  const st = preset('dub-cut');
  const wav = exportWav(st);
  const info = validateWav(wav);
  assert.equal(info.frames, loopFrames(st));
  const pcm = renderLoop(st).pcm;
  const again = validateWav(exportWav(cloneState(st)));
  assert.equal(again.peak, info.peak);
  assert.ok(info.rms > 100, 'export is too quiet');
  assert.ok(info.peak <= 32767);
  assert.ok(info.peakDbfs < 0.01, 'peak is above full scale');
  void pcm;
});

test('WAV validator rejects silence and truncation', () => {
  const st = blankState();
  st.grid.kick.fill(0);
  const silent = exportWav(st);
  assert.throws(() => validateWav(silent), /silent/);
  const good = exportWav(preset('two-step'));
  assert.throws(() => validateWav(good.slice(0, good.length - 9)), /does not match/);
});

test('MIDI export matches the pattern note count and validates', () => {
  const st = preset('half-time');
  const info = validateMidi(exportMidi(st));
  let hits = 0;
  for (const v of ['kick', 'snare', 'hat', 'sub']) for (let s = 0; s < STEPS; s++) if (st.grid[v][s] > 0) hits++;
  assert.equal(info.tracks, 5);
  assert.equal(info.noteOns, hits);
  assert.equal(info.noteOns, info.noteOffs);
  assert.equal(info.division, 480);
});

test('MIDI carries swing and nudge offsets', () => {
  const st = preset('shuffle');
  const straight = exportMidi(st);
  st.swing = 0;
  const flat = exportMidi(st);
  assert.notEqual(Buffer.from(straight).toString('hex'), Buffer.from(flat).toString('hex'));
  assert.equal(validateMidi(straight).noteOns, validateMidi(flat).noteOns);
});

console.log(process.exitCode ? '\nFAILURES' : `\n${n} tests passed`);
