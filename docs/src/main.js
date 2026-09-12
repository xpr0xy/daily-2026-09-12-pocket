// POCKET — interface. One work surface: four rails of 32 steps.
// The signature gesture is drawing an accent contour across a rail.
import {
  blankState, preset, PRESET_NAMES, VOICES, VOICE_META, STEPS, SCALES, ROOTS,
  dice, cloneState, copyMaterial, serialize, deserialize, activeCount, isEmpty, noteLabel, noteFreq,
} from './pattern.js';
import { PARAM_SPECS, renderKick, renderSnare, renderHat, renderSub } from './dsp.js';
import { Engine } from './engine.js';
import { exportWav, exportMidi, renderLoop, hashPcm, loopFrames } from './render.js';

const DEFAULT_BPM = 172;
const slots = { a: preset('two-step'), b: preset('two-step') };
let active = 'a';
let state = slots[active];
state.bpm = DEFAULT_BPM;
const locks = { kick: false, snare: false, hat: false, sub: false };
let selectedVoice = 'kick';
let pendingSeed = 0;

const el = (id) => document.getElementById(id);
const engine = new Engine(() => state);

function syncBpm() {
  state.bpm = Number(el('bpm').value) || DEFAULT_BPM;
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

// ---------------------------------------------------------------- rails

const cellsByVoice = {};

function buildRails() {
  const rails = el('rails');
  rails.innerHTML = '';
  for (const voice of VOICES) {
    const rail = document.createElement('div');
    rail.className = 'rail';
    rail.dataset.voice = voice;

    const gutter = document.createElement('div');
    gutter.className = 'gutter';
    gutter.innerHTML =
      `<button class="vname" data-voice="${voice}" aria-pressed="false">` +
      `<span class="dot" aria-hidden="true"></span>${VOICE_META[voice].label}` +
      `<span class="hits" data-hits="${voice}">0</span></button>` +
      `<span class="gbtns">` +
      `<button class="lock" data-voice="${voice}" aria-pressed="false" title="protect this voice from DICE">LCK</button>` +
      `<button class="clr" data-voice="${voice}" title="clear this voice">CLR</button>` +
      `</span>`;

    const cells = document.createElement('div');
    cells.className = 'cells';
    cells.dataset.voice = voice;
    cells.setAttribute('role', 'group');
    cells.setAttribute('aria-label', VOICE_META[voice].label + ' steps');
    for (let s = 0; s < STEPS; s++) {
      const cell = document.createElement('button');
      cell.className = 'cell';
      cell.dataset.step = String(s);
      cell.dataset.voice = voice;
      cell.dataset.beat = String(Math.floor(s / 4) % 4);
      cell.setAttribute('aria-pressed', 'false');
      cell.setAttribute('aria-label', `${VOICE_META[voice].label} step ${s + 1}`);
      cell.innerHTML = '<span class="bar" aria-hidden="true"></span><span class="tag" aria-hidden="true"></span>';
      cells.appendChild(cell);
    }
    const ph = document.createElement('div');
    ph.className = 'ph';
    ph.setAttribute('aria-hidden', 'true');
    cells.appendChild(ph);
    rail.appendChild(gutter);
    rail.appendChild(cells);
    rails.appendChild(rail);
    cellsByVoice[voice] = cells;
  }
}

// The playhead line is sized from the real cell geometry so it cannot drift
// across 32 steps at any viewport width.
function syncPlayheads() {
  for (const voice of VOICES) {
    const cells = cellsByVoice[voice];
    const first = cells.children[0];
    const ph = cells.querySelector('.ph');
    if (!first || !ph) continue;
    ph.style.left = first.offsetLeft + 'px';
    ph.style.width = first.offsetWidth + 'px';
  }
}

function paintCells() {
  for (const voice of VOICES) {
    const cells = cellsByVoice[voice];
    for (let s = 0; s < STEPS; s++) {
      const cell = cells.children[s];
      const v = state.grid[voice][s];
      const on = v > 0;
      if (on !== cell.classList.contains('on')) cell.classList.toggle('on', on);
      cell.setAttribute('aria-pressed', on ? 'true' : 'false');
      cell.style.setProperty('--v', on ? v.toFixed(2) : '0');
      const tag = cell.querySelector('.tag');
      const label = voice === 'sub' && on ? noteLabel(state, state.notes[s]) : '';
      if (tag.textContent !== label) tag.textContent = label;
      const aria = on
        ? `${VOICE_META[voice].label} step ${s + 1} on, velocity ${Math.round(v * 100)}%` +
          (voice === 'sub' ? `, note ${noteLabel(state, state.notes[s])}` : '')
        : `${VOICE_META[voice].label} step ${s + 1} off`;
      if (cell.dataset.aria !== aria) {
        cell.setAttribute('aria-label', aria);
        cell.dataset.aria = aria;
      }
    }
    const hits = document.querySelector(`[data-hits="${voice}"]`);
    hits.textContent = String(activeCount(state, voice));
  }
  const empty = isEmpty(state);
  el('hint').classList.toggle('empty', empty);
  el('hint').textContent = empty
    ? 'empty pattern — drag across a rail to write the first hits'
    : 'drag across a rail to draw accents · click toggles a step · SUB: right-click or shift+↑↓ steps the note · space plays';
}

function setStep(voice, step, vel, note) {
  const g = state.grid[voice];
  g[step] = vel;
  if (voice === 'sub' && note !== undefined) state.notes[step] = note;
  if (voice === 'sub' && !(state.grid.sub[step] > 0)) state.notes[step] = 0;
}

function afterMaterialChange() {
  paintCells();
  engine.commit();
  el('pend').hidden = !engine.pending;
  drawVoicePreview();
}

// --------------------------------------------------------- paint gesture

function velFromEvent(event, cell) {
  const rect = cell.getBoundingClientRect();
  const frac = 1 - (event.clientY - rect.top) / rect.height;
  const v = 0.2 + clamp(frac, 0, 1) * 0.8;
  return Math.round(v * 20) / 20;
}

let paint = null;

el('rails').addEventListener('contextmenu', (e) => e.preventDefault());

el('rails').addEventListener('pointerdown', (e) => {
  const cell = e.target.closest('.cell');
  if (!cell) {
    const head = e.target.closest('.vname');
    if (head) selectVoice(head.dataset.voice);
    const lock = e.target.closest('.lock');
    if (lock) toggleLock(lock.dataset.voice, lock);
    const clr = e.target.closest('.clr');
    if (clr) {
      state.grid[clr.dataset.voice].fill(0);
      if (clr.dataset.voice === 'sub') state.notes.fill(0);
      afterMaterialChange();
      flash(clr.dataset.voice + ' cleared');
    }
    return;
  }
  const voice = cell.dataset.voice;
  const step = Number(cell.dataset.step);
  selectVoice(voice);
  if (e.button === 2) {
    if (voice === 'sub' && state.grid.sub[step] > 0) {
      const scale = SCALES[state.scale];
      state.notes[step] = (state.notes[step] + 1) % scale.intervals.length;
      afterMaterialChange();
    }
    return;
  }
  e.preventDefault();
  const wasOn = state.grid[voice][step] > 0;
  paint = { voice, step, moved: false, x: e.clientX, y: e.clientY, pendingOff: wasOn };
  cellsByVoice[voice].setPointerCapture?.(e.pointerId);
  if (!wasOn) {
    setStep(voice, step, velFromEvent(e, cell));
    afterMaterialChange();
  }
});

el('rails').addEventListener('pointermove', (e) => {
  if (!paint) return;
  const dist = Math.abs(e.clientX - paint.x) + Math.abs(e.clientY - paint.y);
  if (dist > 6) paint.moved = true;
  if (!paint.moved) return;
  paint.pendingOff = false;
  const node = document.elementFromPoint(e.clientX, e.clientY);
  const cell = node && node.closest ? node.closest('.cell') : null;
  if (!cell || cell.dataset.voice !== paint.voice) return;
  const step = Number(cell.dataset.step);
  const vel = velFromEvent(e, cell);
  if (state.grid[paint.voice][step] === vel && step === paint.step) return;
  paint.step = step;
  setStep(paint.voice, step, vel);
  afterMaterialChange();
});

function endPaint() {
  if (!paint) return;
  const p = paint;
  paint = null;
  if (p.pendingOff && !p.moved) setStep(p.voice, p.step, 0);
  afterMaterialChange();
}
el('rails').addEventListener('pointerup', endPaint);
el('rails').addEventListener('pointercancel', endPaint);

el('rails').addEventListener('keydown', (e) => {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  const voice = cell.dataset.voice;
  const step = Number(cell.dataset.step);
  const v = state.grid[voice][step];
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const dir = e.key === 'ArrowUp' ? 1 : -1;
    if (e.shiftKey && voice === 'sub' && v > 0) {
      const scale = SCALES[state.scale];
      state.notes[step] = (state.notes[step] + dir + scale.intervals.length) % scale.intervals.length;
    } else if (v > 0) {
      setStep(voice, step, clamp(Math.round((v + dir * 0.1) * 20) / 20, 0.05, 1));
    }
    afterMaterialChange();
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    setStep(voice, step, v > 0 ? 0 : 0.8);
    afterMaterialChange();
  }
});

// ------------------------------------------------------------- inspector

function selectVoice(voice) {
  selectedVoice = voice;
  for (const v of VOICES) {
    const head = document.querySelector(`.vname[data-voice="${v}"]`);
    head.setAttribute('aria-pressed', v === voice ? 'true' : 'false');
    cellsByVoice[v].closest('.rail').classList.toggle('selected', v === voice);
  }
  el('voiceName').textContent = VOICE_META[voice].label + ' · ' + VOICE_META[voice].role;
  buildVoicePanel();
  drawVoicePreview();
}

function buildVoicePanel() {
  const voice = selectedVoice;
  const specs = PARAM_SPECS[voice];
  const wrap = el('voiceCtl');
  wrap.innerHTML = '';
  const params = state.params[voice];
  for (const [key, spec] of Object.entries(specs)) {
    const id = `p-${voice}-${key}`;
    const label = document.createElement('label');
    label.className = 'ctl';
    label.setAttribute('for', id);
    const dec = spec.step < 1 ? String(spec.step).split('.')[1].length : 0;
    label.innerHTML =
      `<span class="k">${key.toUpperCase()}</span>` +
      `<input id="${id}" type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${params[key]}">` +
      `<output class="v">${Number(params[key]).toFixed(dec)}${spec.unit ? ' ' + spec.unit : ''}</output>`;
    const input = label.querySelector('input');
    input.addEventListener('input', () => {
      params[key] = Number(input.value);
      label.querySelector('.v').textContent = Number(input.value).toFixed(dec) + (spec.unit ? ' ' + spec.unit : '');
      afterMaterialChange();
    });
    wrap.appendChild(label);
  }
  if (voice === 'sub') {
    const rootLabel = document.createElement('label');
    rootLabel.className = 'ctl select';
    rootLabel.innerHTML =
      '<span class="k">ROOT</span><select id="subRoot">' +
      ROOTS.map((r, i) => `<option value="${i}"${i === rootIdx() ? ' selected' : ''}>${r.name}1 · ${r.freq.toFixed(1)} Hz</option>`).join('') +
      '</select><output class="v"></output>';
    rootLabel.querySelector('select').addEventListener('change', (e) => {
      state.root = ROOTS[Number(e.target.value)].semi;
      afterMaterialChange();
    });
    wrap.appendChild(rootLabel);
    const scaleLabel = document.createElement('label');
    scaleLabel.className = 'ctl select';
    scaleLabel.innerHTML =
      '<span class="k">SCALE</span><select id="subScale">' +
      Object.entries(SCALES).map(([k, s]) => `<option value="${k}"${k === state.scale ? ' selected' : ''}>${s.label}</option>`).join('') +
      '</select><output class="v"></output>';
    scaleLabel.querySelector('select').addEventListener('change', (e) => {
      const scale = SCALES[e.target.value];
      state.scale = e.target.value;
      for (let s = 0; s < STEPS; s++) state.notes[s] = Math.min(state.notes[s], scale.intervals.length - 1);
      afterMaterialChange();
    });
    wrap.appendChild(scaleLabel);
  }
}

function rootIdx() {
  const i = ROOTS.findIndex((r) => r.semi === state.root);
  return i < 0 ? 0 : i;
}

function drawVoicePreview() {
  const canvas = el('voiceScope');
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 240;
  const h = canvas.clientHeight || 48;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const voice = selectedVoice;
  const buf = state.grid && voice ? voiceHitBuffer(voice) : null;
  ctx.fillStyle = 'rgba(255,255,255,0.045)';
  ctx.fillRect(0, h / 2 - 0.5, w, 1);
  if (!buf) return;
  ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue(`--c-${voice}`).trim() || '#fff';
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const step = Math.max(1, Math.floor(buf.length / w));
  for (let x = 0; x < w; x++) {
    let peak = 0;
    const start = x * step;
    for (let i = start; i < Math.min(buf.length, start + step); i++) {
      const a = Math.abs(buf[i]);
      if (a > peak) peak = a;
    }
    const y = h / 2 - peak * (h / 2 - 3);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  const dur = (buf.length / 48000).toFixed(3);
  el('scopeLabel').textContent = `one hit · ${dur} s`;
}

function voiceHitBuffer(voice) {
  const p = state.params[voice];
  if (voice === 'sub') {
    const noteIndex = state.notes[findFirstActive('sub')];
    return renderSub(p, 48000, noteFreq(state, noteIndex));
  }
  if (voice === 'kick') return renderKick(p, 48000, 11);
  if (voice === 'snare') return renderSnare(p, 48000, 23);
  return renderHat(p, 48000, 37);
}

function findFirstActive(voice) {
  for (let s = 0; s < STEPS; s++) if (state.grid[voice][s] > 0) return s;
  return 0;
}

// -------------------------------------------------------------- controls

function toggleLock(voice, btn) {
  locks[voice] = !locks[voice];
  btn.setAttribute('aria-pressed', locks[voice] ? 'true' : 'false');
  btn.classList.toggle('on', locks[voice]);
  flash(locks[voice] ? voice + ' protected' : voice + ' open to dice');
}

function flash(msg) {
  const node = el('status');
  node.textContent = msg;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => {
    node.textContent = defaultStatus();
  }, 2200);
}

function defaultStatus() {
  const frames = loopFrames(state);
  return `${state.steps} steps · ${(frames / 48000).toFixed(2)} s loop · 48 kHz stereo PCM16`;
}

function loadPreset(name) {
  const p = preset(name);
  p.bpm = state.bpm;
  slots[active] = p;
  state = p;
  engine.commit();
  el('pend').hidden = !engine.pending;
  paintCells();
  buildVoicePanel();
  drawVoicePreview();
  flash('pattern: ' + name + ' (tempo kept)');
}

function setSlot(next) {
  if (next === active) return;
  syncBpm();
  active = next;
  state = slots[active];
  el('bpm').value = state.bpm;
  syncRangeValues();
  engine.commit();
  el('pend').hidden = !engine.pending;
  paintCells();
  buildVoicePanel();
  drawVoicePreview();
  for (const b of document.querySelectorAll('[data-slot]')) {
    b.setAttribute('aria-pressed', b.dataset.slot === active ? 'true' : 'false');
  }
  flash('slot ' + active.toUpperCase());
}

function syncRangeValues() {
  el('swing').value = String(Math.round(state.swing * 100));
  el('swingOut').textContent = Math.round(state.swing * 100) + '%';
  el('mdrive').value = String(Math.round(state.master.drive * 100));
  el('mdriveOut').textContent = Math.round(state.master.drive * 100) + '%';
  el('mlevel').value = String(Math.round(state.master.level * 100));
  el('mlevelOut').textContent = Math.round(state.master.level * 100) + '%';
  el('bpm').value = String(state.bpm);
  el('status').textContent = defaultStatus();
}

function download(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ------------------------------------------------------------------- wire

function wire() {
  el('play').addEventListener('click', async () => {
    await engine.toggle();
    el('play').setAttribute('aria-pressed', engine.playing ? 'true' : 'false');
    el('play').querySelector('.glyph').textContent = engine.playing ? '■' : '▶';
    el('play').querySelector('.lbl').textContent = engine.playing ? 'STOP' : 'PLAY';
  });

  el('bpm').addEventListener('input', () => {
    const v = clamp(Number(el('bpm').value) || DEFAULT_BPM, 120, 190);
    state.bpm = v;
    engine.commit();
    el('pend').hidden = !engine.pending;
    el('status').textContent = defaultStatus();
  });

  el('swing').addEventListener('input', () => {
    state.swing = Number(el('swing').value) / 100;
    el('swingOut').textContent = Math.round(state.swing * 100) + '%';
    engine.commit();
    el('pend').hidden = !engine.pending;
  });

  el('mdrive').addEventListener('input', () => {
    state.master.drive = Number(el('mdrive').value) / 100;
    el('mdriveOut').textContent = Math.round(state.master.drive * 100) + '%';
    engine.commit();
    el('pend').hidden = !engine.pending;
  });

  el('mlevel').addEventListener('input', () => {
    state.master.level = Number(el('mlevel').value) / 100;
    el('mlevelOut').textContent = Math.round(state.master.level * 100) + '%';
    engine.commit();
    el('pend').hidden = !engine.pending;
  });

  for (const b of document.querySelectorAll('[data-preset]')) {
    b.addEventListener('click', () => loadPreset(b.dataset.preset));
  }

  el('dice').addEventListener('click', () => {
    pendingSeed = (Math.random() * 0xffffffff) >>> 0;
    const next = dice(state, pendingSeed, locks);
    next.bpm = state.bpm;
    slots[active] = next;
    state = next;
    engine.commit();
    el('pend').hidden = !engine.pending;
    paintCells();
    buildVoicePanel();
    drawVoicePreview();
    flash('dice seed 0x' + pendingSeed.toString(16) + ' · ' + Object.keys(locks).filter((k) => !locks[k]).length + ' voices rolled');
  });

  el('clearAll').addEventListener('click', () => {
    const fresh = blankState(state.bpm);
    fresh.swing = state.swing;
    fresh.params = JSON.parse(JSON.stringify(state.params));
    fresh.master = { ...state.master };
    fresh.root = state.root;
    fresh.scale = state.scale;
    slots[active] = fresh;
    state = fresh;
    engine.commit();
    el('pend').hidden = !engine.pending;
    paintCells();
    buildVoicePanel();
    drawVoicePreview();
    flash('pattern cleared');
  });

  for (const b of document.querySelectorAll('[data-slot]')) {
    b.addEventListener('click', () => setSlot(b.dataset.slot));
  }

  el('copyAB').addEventListener('click', () => {
    syncBpm();
    if (active === 'a') slots.b = copyMaterial(slots.a, slots.b);
    else slots.a = copyMaterial(slots.b, slots.a);
    flash(active === 'a' ? 'A copied into B (tempo untouched)' : 'B copied into A (tempo untouched)');
  });

  el('exportWav').addEventListener('click', () => {
    const bytes = exportWav(state);
    const rendered = renderLoop(state);
    download(bytes, `pocket-${state.bpm}-${hashPcm(rendered.pcm)}.wav`, 'audio/wav');
    el('status').textContent = `WAV · ${(rendered.frames / 48000).toFixed(2)} s · ${bytes.length} bytes · hash ${hashPcm(rendered.pcm)}`;
  });

  el('exportMidi').addEventListener('click', () => {
    const bytes = exportMidi(state);
    download(bytes, `pocket-${state.bpm}.mid`, 'audio/midi');
    el('status').textContent = `MIDI · ${bytes.length} bytes · 480 PPQ · 4 voice tracks`;
  });

  el('exportRecipe').addEventListener('click', () => {
    const bytes = new TextEncoder().encode(JSON.stringify(serialize(state), null, 2));
    download(bytes, 'pocket-recipe.json', 'application/json');
    el('status').textContent = `RECIPE · ${bytes.length} bytes`;
  });

  el('importRecipe').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const obj = JSON.parse(await file.text());
      const next = deserialize(obj, state);
      next.bpm = state.bpm;
      slots[active] = next;
      state = next;
      syncRangeValues();
      engine.commit();
      el('pend').hidden = !engine.pending;
      paintCells();
      buildVoicePanel();
      drawVoicePreview();
      flash('recipe loaded into slot ' + active.toUpperCase());
    } catch (err) {
      flash('recipe not readable');
    }
    e.target.value = '';
  });

  document.addEventListener('keydown', async (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (e.code === 'Space') {
      e.preventDefault();
      await engine.toggle();
      el('play').setAttribute('aria-pressed', engine.playing ? 'true' : 'false');
      el('play').querySelector('.glyph').textContent = engine.playing ? '■' : '▶';
      el('play').querySelector('.lbl').textContent = engine.playing ? 'STOP' : 'PLAY';
    }
  });

  window.addEventListener('resize', () => {
    syncPlayheads();
    drawVoicePreview();
  });
}

// -------------------------------------------------------------- headless API

window.pocket = {
  getState: () => state,
  slots,
  get active() {
    return active;
  },
  hash: () => hashPcm(renderLoop(state).pcm),
  pcm: () => renderLoop(state),
  exportWavBytes: () => exportWav(state),
  exportMidiBytes: () => exportMidi(state),
  play: () => engine.play(),
  stop: () => engine.stop(),
  playing: () => engine.playing,
  passes: () => engine.passes,
  pending: () => engine.pending,
  swaps: () => engine.swaps,
  renderMs: () => engine.renderMs,
  pulse: () => engine.tick(),
  loopFrames: () => loopFrames(state),
  setStep: (voice, step, vel, note) => {
    setStep(voice, step, vel, note);
    afterMaterialChange();
  },
  setParam: (voice, key, value) => {
    state.params[voice][key] = value;
    if (voice === selectedVoice) buildVoicePanel();
    afterMaterialChange();
  },
  setMaster: (key, value) => {
    state.master[key] = value;
    syncRangeValues();
    afterMaterialChange();
  },
  loadPreset,
  dice: (seed, lk) => {
    const next = dice(state, seed, lk || locks);
    next.bpm = state.bpm;
    slots[active] = next;
    state = next;
    afterMaterialChange();
    return next;
  },
  clearAll: () => el('clearAll').click(),
  selectVoice,
  setSlot,
  copyAB: () => el('copyAB').click(),
  activeCount: (voice) => activeCount(state, voice),
  railScroll: () => el('railscroll'),
  syncPlayheads,
};

// ------------------------------------------------------------------- boot

buildRails();
syncPlayheads();
paintCells();
selectVoice('kick');
syncRangeValues();
wire();
drawVoicePreview();
if (window.innerWidth < 900) {
  const panels = Array.from(document.querySelectorAll('.rack details.panel'));
  panels.forEach((p, i) => {
    p.open = i < 2;
  });
}

let hotCell = null;
const playheads = [];
function frame() {
  const t = engine.tick();
  const bar = Math.floor(t.pos * 2) + 1;
  const step = Math.floor(t.pos * 32) + 1;
  const pos = el('pos');
  const text = engine.playing ? `BAR ${bar} · ${String(step).padStart(2, '0')}` : 'BAR — · --';
  if (pos.textContent !== text) pos.textContent = text;
  if (hotCell) hotCell.classList.remove('hot');
  hotCell = null;
  if (engine.playing) {
    const cells = cellsByVoice[selectedVoice];
    const c = cells.children[Math.min(31, Math.floor(t.pos * 32))];
    if (c) {
      c.classList.add('hot');
      hotCell = c;
    }
  }
  const xf = `translateX(${(t.pos * 3200).toFixed(3)}%)`;
  for (const node of playheads) node.style.transform = xf;
  const pend = el('pend');
  if (pend.hidden === engine.pending) pend.hidden = !engine.pending;
  requestAnimationFrame(frame);
}
for (const voice of VOICES) playheads.push(cellsByVoice[voice].querySelector('.ph'));
requestAnimationFrame(frame);