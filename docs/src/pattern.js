// POCKET — pattern state, scales, presets, dice, serialization.
import { makeRng } from './dsp.js';

export const STEPS = 32;
export const VOICES = ['kick', 'snare', 'hat', 'sub'];

export const VOICE_META = {
  kick: { label: 'KICK', role: 'low strike', intervalLabels: false },
  snare: { label: 'SNARE', role: 'backbeat', intervalLabels: false },
  hat: { label: 'HAT', role: 'top', intervalLabels: false },
  sub: { label: 'SUB', role: 'bass stab', intervalLabels: true },
};

// Root note is a semitone offset from C1 (MIDI 24). Subs sit 33–65 Hz.
export const ROOTS = [0, 2, 3, 5, 7, 9, 10].map((semi) => ({
  semi,
  name: ['C', 'D', 'D#', 'F', 'G', 'A', 'A#'][[0, 2, 3, 5, 7, 9, 10].indexOf(semi)],
  freq: 32.703 * Math.pow(2, semi / 12),
}));

export const SCALES = {
  minPent: { label: 'MIN PENT', intervals: [0, 3, 5, 7, 10], names: ['1', 'b3', '4', '5', 'b7'] },
  natMinor: { label: 'NAT MINOR', intervals: [0, 2, 3, 5, 7, 8, 10], names: ['1', '2', 'b3', '4', '5', 'b6', 'b7'] },
  phryg: { label: 'PHRYG', intervals: [0, 1, 3, 5, 7, 8, 10], names: ['1', 'b2', 'b3', '4', '5', 'b6', 'b7'] },
};

export function rootIndex(semi) {
  const i = ROOTS.findIndex((r) => r.semi === semi);
  return i < 0 ? 0 : i;
}

export function noteFreq(state, noteIndex) {
  const root = ROOTS[rootIndex(state.root)];
  const scale = SCALES[state.scale] || SCALES.minPent;
  const interval = scale.intervals[Math.max(0, Math.min(scale.intervals.length - 1, noteIndex))];
  return root.freq * Math.pow(2, interval / 12);
}

export function noteLabel(state, noteIndex) {
  const scale = SCALES[state.scale] || SCALES.minPent;
  const i = Math.max(0, Math.min(scale.names.length - 1, noteIndex));
  return scale.names[i];
}

const zeros = (v) => new Float32Array(STEPS).fill(v || 0);

export function blankState(bpm = 172) {
  return {
    bpm,
    swing: 0.14,
    steps: STEPS,
    root: 9,
    scale: 'minPent',
    grid: { kick: zeros(), snare: zeros(), hat: zeros(), sub: zeros() },
    notes: new Int8Array(STEPS),
    params: {
      kick: { tune: 48, decay: 0.3, drive: 0.35, nudge: 0 },
      snare: { tune: 190, decay: 0.18, drive: 0.45, nudge: 0 },
      hat: { tune: 8600, decay: 0.05, drive: 0.2, nudge: 0 },
      sub: { decay: 0.35, drive: 0.25, nudge: 0 },
    },
    master: { drive: 0.3, level: 0.88 },
  };
}

function grid(partial) {
  const g = { kick: zeros(), snare: zeros(), hat: zeros(), sub: zeros() };
  for (const v of VOICES) {
    const entries = partial[v] || [];
    for (const [step, vel] of entries) g[v][step] = vel;
  }
  return g;
}

function notes(entries) {
  const n = new Int8Array(STEPS);
  for (const [step, note] of entries) n[step] = note;
  return n;
}

export function preset(name) {
  const base = blankState();
  if (name === 'two-step') {
    return Object.assign(base, {
      swing: 0.14,
      grid: grid({
        kick: [[0, 1], [10, 1], [16, 1], [26, 0.95], [20, 0.45]],
        snare: [[4, 1], [12, 1], [20, 1], [28, 1]],
        hat: [[2, 0.4], [6, 0.5], [10, 0.4], [14, 0.55], [18, 0.4], [22, 0.5], [26, 0.4], [30, 0.6]],
        sub: [[0, 1], [10, 0.7], [16, 1], [26, 0.6]],
      }),
      notes: notes([[0, 0], [10, 2], [16, 0], [26, 1]]),
    });
  }
  if (name === 'half-time') {
    return Object.assign(base, {
      swing: 0.1,
      params: {
        kick: { tune: 42, decay: 0.5, drive: 0.4, nudge: 0 },
        snare: { tune: 170, decay: 0.26, drive: 0.5, nudge: 4 },
        hat: { tune: 7400, decay: 0.09, drive: 0.2, nudge: 0 },
        sub: { decay: 0.62, drive: 0.3, nudge: 0 },
      },
      grid: grid({
        kick: [[0, 1], [16, 1], [24, 0.55], [7, 0.35]],
        snare: [[8, 1], [24, 1]],
        hat: [[6, 0.35], [14, 0.45], [22, 0.35], [30, 0.5]],
        sub: [[0, 1], [12, 0.55], [16, 1], [28, 0.7]],
      }),
      notes: notes([[0, 0], [12, 3], [16, 0], [28, 2]]),
    });
  }
  if (name === 'shuffle') {
    return Object.assign(base, {
      swing: 0.55,
      grid: grid({
        kick: [[0, 1], [10, 0.9], [16, 1], [26, 0.85]],
        snare: [[4, 0.9], [12, 1], [20, 0.9], [28, 1]],
        hat: [[3, 0.45], [7, 0.55], [11, 0.45], [15, 0.6], [19, 0.45], [23, 0.55], [27, 0.45], [31, 0.6]],
        sub: [[0, 1], [6, 0.6], [16, 1], [22, 0.6]],
      }),
      notes: notes([[0, 0], [6, 2], [16, 0], [22, 1]]),
    });
  }
  if (name === 'dub-cut') {
    return Object.assign(base, {
      swing: 0,
      params: {
        kick: { tune: 44, decay: 0.46, drive: 0.45, nudge: 0 },
        snare: { tune: 205, decay: 0.3, drive: 0.55, nudge: 0 },
        hat: { tune: 9200, decay: 0.06, drive: 0.2, nudge: 0 },
        sub: { decay: 0.92, drive: 0.35, nudge: 0 },
      },
      grid: grid({
        kick: [[0, 1], [16, 1], [22, 0.5]],
        snare: [[12, 1], [28, 0.6]],
        hat: [],
        sub: [[0, 1], [10, 0.5], [16, 1]],
      }),
      notes: notes([[0, 0], [10, 4], [16, 0]]),
    });
  }
  return base;
}

export const PRESET_NAMES = ['two-step', 'half-time', 'shuffle', 'dub-cut'];

// Structured dice: each voice randomizes on its own musical weight map so a
// roll stays playable instead of becoming noise. Locked voices are untouched.
const WEIGHTS = {
  kick: [1.0, 0.05, 0.12, 0.04, 0.1, 0.05, 0.2, 0.06, 0.5, 0.06, 0.55, 0.1, 0.35, 0.06, 0.2, 0.06,
         1.0, 0.05, 0.12, 0.04, 0.1, 0.05, 0.2, 0.06, 0.5, 0.06, 0.35, 0.1, 0.35, 0.06, 0.2, 0.06],
  snare: [0.06, 0.02, 0.05, 0.02, 0.95, 0.03, 0.1, 0.03, 0.06, 0.02, 0.12, 0.02, 0.9, 0.03, 0.1, 0.03,
          0.06, 0.02, 0.05, 0.02, 0.95, 0.03, 0.1, 0.03, 0.06, 0.02, 0.12, 0.02, 0.9, 0.03, 0.14, 0.03],
  hat: [0.12, 0.02, 0.5, 0.05, 0.2, 0.03, 0.5, 0.06, 0.12, 0.02, 0.5, 0.05, 0.2, 0.03, 0.5, 0.06,
        0.12, 0.02, 0.5, 0.05, 0.2, 0.03, 0.5, 0.06, 0.12, 0.02, 0.5, 0.05, 0.2, 0.03, 0.55, 0.08],
  sub: [0.9, 0.03, 0.1, 0.04, 0.1, 0.05, 0.3, 0.05, 0.2, 0.05, 0.5, 0.05, 0.2, 0.05, 0.2, 0.05,
        0.9, 0.03, 0.1, 0.04, 0.1, 0.05, 0.3, 0.05, 0.2, 0.05, 0.4, 0.05, 0.25, 0.05, 0.2, 0.05],
};

export function dice(state, seed, locks = {}) {
  const rnd = makeRng(seed);
  const next = cloneState(state);
  for (const v of VOICES) {
    if (locks[v]) continue;
    next.grid[v] = zeros();
    for (let s = 0; s < STEPS; s++) {
      if (rnd() * 0.5 + 0.5 < WEIGHTS[v][s] * 0.85) {
        const accent = v === 'hat' ? 0.35 + rnd() * 0.25 : 0.65 + rnd() * 0.35;
        next.grid[v][s] = Math.round(Math.min(1, accent) * 20) / 20;
      }
    }
  }
  const scale = SCALES[next.scale] || SCALES.minPent;
  for (let s = 0; s < STEPS; s++) {
    if (next.grid.sub[s] > 0) {
      next.notes[s] = Math.floor((rnd() * 0.5 + 0.5) * scale.intervals.length) % scale.intervals.length;
    }
  }
  next.notes[0] = 0;
  return next;
}

export function cloneState(state) {
  return {
    bpm: state.bpm,
    swing: state.swing,
    steps: state.steps,
    root: state.root,
    scale: state.scale,
    grid: {
      kick: Float32Array.from(state.grid.kick),
      snare: Float32Array.from(state.grid.snare),
      hat: Float32Array.from(state.grid.hat),
      sub: Float32Array.from(state.grid.sub),
    },
    notes: Int8Array.from(state.notes),
    params: JSON.parse(JSON.stringify(state.params)),
    master: { ...state.master },
  };
}

// Copying material from one slot to another never carries tempo.
export function copyMaterial(from, to) {
  const next = cloneState(to);
  next.swing = from.swing;
  next.root = from.root;
  next.scale = from.scale;
  next.grid = {
    kick: Float32Array.from(from.grid.kick),
    snare: Float32Array.from(from.grid.snare),
    hat: Float32Array.from(from.grid.hat),
    sub: Float32Array.from(from.grid.sub),
  };
  next.notes = Int8Array.from(from.notes);
  next.params = JSON.parse(JSON.stringify(from.params));
  next.master = { ...from.master };
  return next;
}

export function serialize(state) {
  return {
    v: 1,
    bpm: state.bpm,
    swing: Number(state.swing.toFixed(4)),
    steps: state.steps,
    root: state.root,
    scale: state.scale,
    grid: Object.fromEntries(VOICES.map((v) => [v, Array.from(state.grid[v]).map((x) => Number(x.toFixed(3)))])),
    notes: Array.from(state.notes),
    params: state.params,
    master: state.master,
  };
}

export function deserialize(obj, fallback) {
  const base = fallback ? cloneState(fallback) : blankState();
  if (!obj || obj.v !== 1) return base;
  base.bpm = Number(obj.bpm) || base.bpm;
  base.swing = Number(obj.swing) || 0;
  base.root = Number(obj.root) || 0;
  base.scale = SCALES[obj.scale] ? obj.scale : base.scale;
  for (const v of VOICES) {
    const row = obj.grid?.[v];
    if (Array.isArray(row)) base.grid[v] = Float32Array.from({ length: STEPS }, (_, i) => Number(row[i]) || 0);
  }
  if (Array.isArray(obj.notes)) base.notes = Int8Array.from({ length: STEPS }, (_, i) => Number(obj.notes[i]) || 0);
  if (obj.params) base.params = JSON.parse(JSON.stringify(obj.params));
  if (obj.master) base.master = { ...base.master, ...obj.master };
  return base;
}

export function activeCount(state, voice) {
  let n = 0;
  for (let s = 0; s < STEPS; s++) if (state.grid[voice][s] > 0) n++;
  return n;
}

export function isEmpty(state) {
  return VOICES.every((v) => activeCount(state, v) === 0);
}
