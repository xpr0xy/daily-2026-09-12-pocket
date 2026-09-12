// POCKET — browser QA. Exercises the real workflow, measures causality
// between controls and rendered bytes, and captures desktop + mobile proof.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { validateWav, validateMidi } from './validate.mjs';

const url = process.env.APP_URL || 'http://localhost:8772/';
const out = 'qa';
await mkdir(out, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
});

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push('ok   ' + name);
    console.log('ok   ' + name);
  } catch (e) {
    results.push('FAIL ' + name + ' :: ' + e.message);
    console.log('FAIL ' + name + ' :: ' + e.message);
    process.exitCode = 1;
  }
};

await page.goto(url + '?qa=' + Date.now(), { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.pocket);

const hash = () => page.evaluate(() => window.pocket.hash());
const gstate = () =>
  page.evaluate(() => {
    const s = window.pocket.getState();
    return {
      bpm: s.bpm,
      swing: s.swing,
      kick: Array.from(s.grid.kick),
      snare: Array.from(s.grid.snare),
      hat: Array.from(s.grid.hat),
      sub: Array.from(s.grid.sub),
      notes: Array.from(s.notes),
      master: { ...s.master },
    };
  });
const wall = (fn) => page.evaluate(fn);
const rmsOf = () =>
  page.evaluate(() => {
    const p = window.pocket.pcm().pcm;
    let s = 0;
    for (let i = 0; i < p.length; i++) s += p[i] * p[i];
    return Math.sqrt(s / p.length);
  });

const marker = await page.locator('body').getAttribute('data-product');
check('product marker present', () => assert.equal(marker, 'POCKET'));
const scripts = await page.evaluate(() =>
  Array.from(document.querySelectorAll('script[src]')).map((s) => s.getAttribute('src'))
);
check('entry script is a relative module path', () => assert.deepEqual(scripts, ['./src/main.js']));

const cellCount = await page.locator('.cell').count();
check('32 steps render on each of 4 rails', () => assert.equal(cellCount, 128));

const frames = await page.evaluate(() => window.pocket.loopFrames());
const fixture = await gstate();
check('two-step fixture is the default state', () => {
  const kicks = fixture.kick.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(kicks, [0, 10, 16, 20, 26]);
  assert.equal(fixture.bpm, 172);
  assert.equal(frames, Math.round((2 * 4 * 60 * 48000) / 172));
});

// ------------------------------------------------------- control causality
const baseHash = await hash();
const baseRms = await rmsOf();

await wall(() => window.pocket.setStep('kick', 6, 0.9));
const afterStep = await hash();
const stepRms = await rmsOf();
check('writing a step changes rendered bytes', () => assert.notEqual(baseHash, afterStep));
check('an added hit adds real energy', () => assert.ok(stepRms > baseRms + 5, `${stepRms} vs ${baseRms}`));
await wall(() => window.pocket.setStep('kick', 6, 0));

await wall(() => window.pocket.setParam('kick', 'decay', 0.62));
const afterDecay = await hash();
check('voice decay changes the artifact', () => assert.notEqual(afterStep, afterDecay));
await wall(() => window.pocket.setParam('kick', 'decay', 0.3));

await wall(() => window.pocket.setMaster('drive', 1));
const afterDrive = await hash();
check('master drive changes the artifact', () => assert.notEqual(afterDecay, afterDrive));
await wall(() => window.pocket.setMaster('drive', 0.3));

await page.locator('#swing').evaluate((e) => {
  e.value = '50';
  e.dispatchEvent(new Event('input', { bubbles: true }));
});
const afterSwing = await hash();
check('swing changes the artifact', () => assert.notEqual(afterDrive, afterSwing));
await page.locator('#swing').evaluate((e) => {
  e.value = '14';
  e.dispatchEvent(new Event('input', { bubbles: true }));
});

await wall(() => window.pocket.setParam('sub', 'nudge', 0));
const restored = await hash();
check('restored material reproduces identical bytes', () => assert.equal(restored, baseHash));

const velocityArtefact = await (async () => {
  await wall(() => window.pocket.setStep('snare', 4, 0.25));
  const soft = await rmsOf();
  await wall(() => window.pocket.setStep('snare', 4, 1));
  const hard = await rmsOf();
  return { soft, hard };
})();
check('step velocity changes energy, not just metadata', () =>
  assert.ok(velocityArtefact.hard > velocityArtefact.soft + 2, JSON.stringify(velocityArtefact))
);
await wall(() => window.pocket.loadPreset('two-step'));

// ----------------------------------------------------------- paint gesture
const before = await gstate();
const kickCells = page.locator('.rail[data-voice="kick"] .cell');
const box0 = await kickCells.nth(1).boundingBox();
await page.mouse.move(box0.x + box0.width / 2, box0.y + box0.height * 0.15);
await page.mouse.down();
for (let i = 1; i <= 4; i++) {
  const b = await kickCells.nth(i).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * (0.15 + 0.2 * i), { steps: 4 });
}
await page.mouse.up();
const painted = await gstate();
check('one drag writes a velocity contour across the rail', () => {
  const vals = [1, 2, 3, 4].map((i) => painted.kick[i]);
  assert.ok(vals.every((v) => v > 0), 'drag left steps unwritten: ' + JSON.stringify(vals));
  assert.ok(vals[0] >= vals[1] && vals[1] >= vals[2] && vals[2] >= vals[3], 'velocity did not follow the stroke: ' + JSON.stringify(vals));
  assert.ok(vals[0] - vals[3] > 0.1, 'accent contour too flat: ' + JSON.stringify(vals));
});
const paintedHash = await hash();
check('the paint gesture changes rendered bytes', () => assert.notEqual(paintedHash, baseHash));

await kickCells.nth(1).click();
const toggled = await gstate();
check('a plain click toggles a step off', () => assert.equal(toggled.kick[1], 0));

await wall(() => window.pocket.setStep('sub', 0, 1, 0));
const subCell = page.locator('.rail[data-voice="sub"] .cell').nth(0);
const tagBefore = await subCell.locator('.tag').textContent();
await subCell.click({ button: 'right' });
const tagAfter = await subCell.locator('.tag').textContent();
check('right-click steps the sub note', () => assert.notEqual(tagBefore, tagAfter));

// ------------------------------------------------------------------- dice
await wall(() => window.pocket.loadPreset('two-step'));
const preDice = await gstate();
const rolled = await page.evaluate(() => {
  const s = window.pocket.dice(4242, { kick: true, hat: true, sub: true });
  return { kick: Array.from(s.grid.kick), snare: Array.from(s.grid.snare), hat: Array.from(s.grid.hat) };
});
check('dice protects locked voices and rolls open ones', () => {
  assert.deepEqual(rolled.kick, preDice.kick, 'locked kick changed');
  assert.deepEqual(rolled.hat, preDice.hat, 'locked hat changed');
  assert.notDeepEqual(rolled.snare, preDice.snare, 'open snare did not roll');
});

// ---------------------------------------------------------------- slot A/B
await wall(() => window.pocket.loadPreset('two-step'));
await wall(() => window.pocket.setStep('hat', 31, 0.7));
const slotAState = await gstate();
await wall(() => window.pocket.copyAB());
await wall(() => window.pocket.setSlot('b'));
const slotB = await gstate();
check('slot B holds a copy of A with tempo intact', () => {
  assert.ok(Math.abs(slotB.hat[31] - 0.7) < 1e-6, 'hat step not copied: ' + slotB.hat[31]);
  assert.equal(slotB.bpm, 172);
  assert.deepEqual(slotB.kick, slotAState.kick);
});
await wall(() => window.pocket.setSlot('a'));

// --------------------------------------------------------- live transport
await page.locator('#bpm').evaluate((e) => {
  e.value = '180';
  e.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.locator('#play').click();
await page.waitForFunction(() => window.pocket.playing());
const loopMs = await page.evaluate(() => (window.pocket.loopFrames() / 48000) * 1000);
await page.waitForTimeout(loopMs * 1.3);
const pass1 = await page.evaluate(() => window.pocket.pulse().passes);
check('playback runs past a full pattern until explicit stop', () => assert.ok(pass1 >= 1, 'passes=' + pass1));

await page.locator('.rail[data-voice="snare"] .cell').nth(6).click();
const pendingAfterEdit = await page.evaluate(() => window.pocket.pending());
check('a live edit arms a boundary swap instead of restarting', () => assert.ok(pendingAfterEdit));

const posSamples = [];
const t0 = Date.now();
while (Date.now() - t0 < loopMs * 1.5) {
  posSamples.push(await page.evaluate(() => window.pocket.pulse().pos));
  await page.waitForTimeout(40);
}
const swaps = await page.evaluate(() => window.pocket.swaps());
const pendGone = await page.evaluate(() => window.pocket.pending());
const wraps = [];
for (let i = 1; i < posSamples.length; i++) if (posSamples[i] < posSamples[i - 1]) wraps.push(posSamples[i - 1]);
check('the edit lands at the loop end and clears', () => {
  assert.ok(swaps >= 1, 'no boundary swap happened');
  assert.equal(pendGone, false, 'pending swap never cleared');
});
check('phase is preserved through the swap', () => {
  assert.ok(wraps.length >= 1, 'playhead never wrapped');
  assert.ok(wraps.every((p) => p > 0.8), 'playhead jumped backwards mid-loop: ' + JSON.stringify(wraps));
});
const stillPlaying = await page.evaluate(() => window.pocket.playing());
check('still playing', () => assert.ok(stillPlaying));
const editedSnare = await gstate();
check('the live edit is really in the rendered state', () => assert.ok(editedSnare.snare[6] > 0));

await page.locator('#play').click();
const stopped = await page.evaluate(() => window.pocket.playing());
check('stop is explicit and reachable', () => assert.equal(stopped, false));

// -------------------------------------------------------------- export gate
async function grab(selector) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator(selector).click()]);
  const path = await download.path();
  return { name: download.suggestedFilename(), bytes: new Uint8Array(await readFile(path)) };
}

const wav = await grab('#exportWav');
const framesNow = await page.evaluate(() => window.pocket.loopFrames());
check('WAV export downloads non-empty bytes', () => assert.ok(wav.bytes.length > 20000, 'wav too small: ' + wav.bytes.length));
let wavInfo = null;
check('WAV export passes the downstream validator', () => {
  wavInfo = validateWav(wav.bytes);
  assert.equal(wavInfo.rate, 48000);
  assert.equal(wavInfo.channels, 2);
  assert.equal(wavInfo.frames, framesNow);
  assert.ok(wavInfo.rms > 100, 'wav is too quiet');
});

const midi = await grab('#exportMidi');
check('MIDI export downloads non-empty bytes', () => assert.ok(midi.bytes.length > 100));
let midiInfo = null;
check('MIDI export passes the downstream validator', () => {
  midiInfo = validateMidi(midi.bytes);
  assert.equal(midiInfo.tracks, 5);
  let hits = 0;
  for (const row of [editedSnare.kick, editedSnare.snare, editedSnare.hat, editedSnare.sub])
    for (const v of row) if (v > 0) hits++;
  assert.equal(midiInfo.noteOns, hits);
});

const parity = await page.evaluate(() => {
  const live = window.pocket.pcm().pcm;
  const file = window.pocket.exportWavBytes();
  const view = new DataView(file.buffer, file.byteOffset + 44);
  let same = true;
  for (let i = 0; i < live.length; i += 97) if (Math.abs(view.getInt16(i * 2, true) - live[i]) > 1) same = false;
  return { same, frames: live.length / 2, bytes: file.length };
});
check('audition and export share the same samples', () => assert.ok(parity.same));

await writeFile('qa/export.wav', wav.bytes);
await writeFile('qa/export.mid', midi.bytes);
results.push(`     wav: ${wav.name} · ${wav.bytes.length} bytes · ${wavInfo.seconds.toFixed(2)} s · peak ${wavInfo.peak}`);
results.push(`     midi: ${midi.name} · ${midi.bytes.length} bytes · ${midiInfo.noteOns} notes · ${midiInfo.tracks} tracks`);

// -------------------------------------------------------------- screenshots
await page.evaluate(() => {
  window.pocket.loadPreset('two-step');
  window.pocket.selectVoice('kick');
});
await page.locator('#play').click();
await page.waitForTimeout(600);
await page.screenshot({ path: out + '/desktop-1600x900.png' });
results.push('     wrote qa/desktop-1600x900.png');

const mobile = await browser.newContext({
  viewport: { width: 375, height: 812 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const mp = await mobile.newPage();
const merrors = [];
mp.on('pageerror', (e) => merrors.push('pageerror: ' + e.message));
mp.on('console', (m) => {
  if (m.type() === 'error') merrors.push('console: ' + m.text());
});
await mp.goto(url + '?qa=mobile', { waitUntil: 'networkidle' });
await mp.waitForFunction(() => !!window.pocket);

const overflow = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
check('mobile has no page-level horizontal overflow', () => assert.ok(overflow.sw <= overflow.iw + 1, JSON.stringify(overflow)));

const reach = await mp.evaluate(() => {
  const scroller = document.getElementById('railscroll');
  scroller.scrollLeft = scroller.scrollWidth;
  const cells = document.querySelector('.rail[data-voice="sub"] .cells');
  const last = cells.children[31].getBoundingClientRect();
  return {
    scrollLeft: scroller.scrollLeft,
    max: scroller.scrollWidth - scroller.clientWidth,
    lastVisible: last.right <= window.innerWidth + 1 && last.left >= 0,
    lastRight: Math.round(last.right),
    inner: window.innerWidth,
  };
});
check('the far edge of the step scroller is mechanically reachable', () => {
  assert.ok(reach.max > 0, 'rails are not scrolling on mobile, cells are too small');
  assert.ok(reach.scrollLeft >= reach.max - 1, 'scroller did not reach the end: ' + JSON.stringify(reach));
  assert.ok(reach.lastVisible, 'step 32 not visible after scrolling: ' + JSON.stringify(reach));
});

const mobileControls = await mp.evaluate(() => ({
  cells: document.querySelectorAll('.cell').length,
  sliders: document.querySelectorAll('#voiceCtl input[type="range"]').length,
  exports: !!document.getElementById('exportWav') && !!document.getElementById('exportMidi'),
  playBox: (() => {
    const r = document.getElementById('play').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  })(),
  cellBox: (() => {
    const r = document.querySelector('.cell').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  })(),
  panelsOpen: Array.from(document.querySelectorAll('.rack details.panel')).map((d) => d.open),
  rackVisible: document.querySelector('.rack').getBoundingClientRect().width > 300,
}));
check('mobile keeps every material control and a usable transport', () => {
  assert.equal(mobileControls.cells, 128);
  assert.equal(mobileControls.exports, true);
  assert.ok(mobileControls.sliders >= 3, 'voice controls missing on mobile: ' + mobileControls.sliders);
  assert.ok(mobileControls.playBox.h >= 44, 'play target too small: ' + JSON.stringify(mobileControls.playBox));
  assert.ok(mobileControls.cellBox.h >= 40, 'step target too small: ' + JSON.stringify(mobileControls.cellBox));
  assert.deepEqual(mobileControls.panelsOpen, [true, true, false, false], 'panel disclosure is not grouped on mobile');
  assert.ok(mobileControls.rackVisible);
});

const mobileVoice = await (async () => {
  await mp.evaluate(() => window.pocket.selectVoice('sub'));
  return mp.evaluate(() => document.querySelectorAll('#voiceCtl input[type="range"]').length + document.querySelectorAll('#voiceCtl select').length);
})();
check('mobile exposes sub controls (decay, drive, nudge, root, scale)', () => assert.ok(mobileVoice >= 5, 'sub controls missing: ' + mobileVoice));

await mp.evaluate(() => {
  document.querySelectorAll('.rack details.panel').forEach((d) => (d.open = true));
});
await mp.screenshot({ path: out + '/mobile-375x812.png', fullPage: true });
await mp.evaluate(() => window.scrollTo(0, 0));
await mp.screenshot({ path: out + '/mobile-375x812-viewport.png' });
results.push('     wrote qa/mobile-375x812.png and qa/mobile-375x812-viewport.png');

await mp.evaluate(() => document.querySelectorAll('.rack details.panel').forEach((d, i) => (d.open = i < 2)));
await mp.keyboard.press('Space');
await mp.waitForTimeout(400);
const spacePlaying = await mp.evaluate(() => window.pocket.playing());
check('space toggles the transport', () => assert.ok(spacePlaying));
await mp.evaluate(() => window.pocket.stop());

check('no console or page errors', () => {
  assert.deepEqual(errors, []);
  assert.deepEqual(merrors, []);
});

await browser.close();
const failed = results.filter((r) => r.startsWith('FAIL'));
console.log(failed.length ? '\nQA FAILED (' + failed.length + ')' : '\nQA PASSED (' + results.length + ' checks)');
