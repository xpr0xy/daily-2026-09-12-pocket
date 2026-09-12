// POCKET — loop renderer, WAV writer, MIDI writer.
// Audition and export share this exact path: renderLoop() produces the integer
// PCM samples; the WAV file and the live AudioBuffer are both built from them.
import { SR, renderKick, renderSnare, renderHat, renderSub, masterClip } from './dsp.js';
import { VOICES, noteFreq } from './pattern.js';

export function stepSeconds(bpm) {
  return 60 / bpm / 4;
}

export function stepOffsetSeconds(state, voice, step) {
  const s16 = stepSeconds(state.bpm);
  const swing = state.swing * 0.5 * s16 * (step % 2);
  const nudge = (state.params[voice].nudge || 0) / 1000;
  return step * s16 + swing + nudge;
}

export function eventList(state) {
  const events = [];
  for (const v of VOICES) {
    for (let s = 0; s < state.steps; s++) {
      const vel = state.grid[v][s];
      if (!(vel > 0)) continue;
      events.push({
        voice: v,
        step: s,
        vel: vel,
        note: v === 'sub' ? state.notes[s] : 0,
        t: stepOffsetSeconds(state, v, s),
      });
    }
  }
  events.sort((a, b) => a.t - b.t || VOICES.indexOf(a.voice) - VOICES.indexOf(b.voice) || a.step - b.step);
  return events;
}

const cache = new Map();
export function clearVoiceCache() {
  cache.clear();
}

export function voiceBuffer(state, voice, note, sr = SR) {
  const p = state.params[voice];
  const key =
    voice + '|' + sr + '|' + JSON.stringify(p) + '|' + (voice === 'sub' ? note : '') + '|' + state.root + '|' + state.scale;
  let buf = cache.get(key);
  if (buf) return buf;
  if (cache.size > 220) cache.clear();
  if (voice === 'kick') buf = renderKick(p, sr, 11);
  else if (voice === 'snare') buf = renderSnare(p, sr, 23);
  else if (voice === 'hat') buf = renderHat(p, sr, 37);
  else buf = renderSub(p, sr, noteFreq(state, note));
  cache.set(key, buf);
  return buf;
}

export function loopFrames(state, sr = SR) {
  return Math.round(state.steps * stepSeconds(state.bpm) * sr);
}

// Integer PCM16, stereo (identical channels — the pattern is mono-safe).
export function renderLoop(state, sr = SR) {
  const frames = loopFrames(state, sr);
  const bus = new Float32Array(frames);
  for (const ev of eventList(state)) {
    const buf = voiceBuffer(state, ev.voice, ev.note, sr);
    let off = Math.round(ev.t * sr) % frames;
    if (off < 0) off += frames;
    for (let i = 0; i < buf.length; i++) {
      bus[(off + i) % frames] += buf[i] * ev.vel;
    }
  }
  masterClip(bus, state.master.drive, state.master.level);
  const pcm = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.max(-1, Math.min(1, bus[i]));
    const s = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    pcm[i * 2] = s;
    pcm[i * 2 + 1] = s;
  }
  return { pcm, frames, sr };
}

export function wavFromPcm(pcm, frames, sr = SR) {
  const dataBytes = frames * 2 * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const str = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

export function exportWav(state) {
  const { pcm, frames, sr } = renderLoop(state);
  return wavFromPcm(pcm, frames, sr);
}

// FNV-1a over the exported PCM. Used for determinism and control-causality checks.
export function hashPcm(pcm) {
  let h = 0x811c9dc5;
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const PPQ = 480;

function vlq(n) {
  const out = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    out.unshift((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return out;
}

function track(events, extraHeader) {
  const bytes = [];
  if (extraHeader) bytes.push(0x00, ...extraHeader);
  let last = 0;
  for (const ev of events) {
    bytes.push(...vlq(ev.tick - last));
    last = ev.tick;
    bytes.push(...ev.data);
  }
  bytes.push(...vlq(0), 0xff, 0x2f, 0x00);
  const out = [];
  out.push(0x4d, 0x54, 0x72, 0x6b);
  const len = bytes.length;
  out.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  return out.concat(bytes);
}

const NOTE_MAP = { kick: 36, snare: 38, hat: 42 };
const CHANNEL = { kick: 0, snare: 1, hat: 2, sub: 3 };

// Standard MIDI File, format 1: tempo map + one track per voice.
export function exportMidi(state) {
  const stepTicks = PPQ / 4;
  const totalTicks = state.steps * stepTicks;
  const tracks = [];

  const tempoUs = Math.round(60000000 / state.bpm);
  const nameHeader = [0xff, 0x03, 5, 0x50, 0x4f, 0x43, 0x4b, 0x54];
  tracks.push(
    track(
      [
        { tick: 0, data: [0xff, 0x51, 0x03, (tempoUs >> 16) & 0xff, (tempoUs >> 8) & 0xff, tempoUs & 0xff] },
        { tick: 0, data: [0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08] },
      ],
      nameHeader
    )
  );

  for (const v of VOICES) {
    const evs = [];
    const durTicks = v === 'sub' ? stepTicks * 2 : stepTicks;
    for (let s = 0; s < state.steps; s++) {
      const vel = state.grid[v][s];
      if (!(vel > 0)) continue;
      const tSec = stepOffsetSeconds(state, v, s);
      const tick = Math.round((tSec / stepSeconds(state.bpm)) * stepTicks);
      const note = v === 'sub' ? 24 + state.root + scaleInterval(state, state.notes[s]) : NOTE_MAP[v];
      const gate = Math.max(1, Math.min(127, Math.round(vel * 127)));
      evs.push({ tick, data: [0x90 | CHANNEL[v], note, gate], order: 1 });
      evs.push({ tick: tick + durTicks, data: [0x80 | CHANNEL[v], note, 0x40], order: 0 });
    }
    evs.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const nameBytes = [];
    const text = v.toUpperCase();
    nameBytes.push(0xff, 0x03, text.length, ...Array.from(text).map((c) => c.charCodeAt(0)));
    const body = evs.map((e) => ({ tick: e.tick, data: e.data }));
    tracks.push(track(body, nameBytes));
  }

  const header = [
    0x4d, 0x54, 0x68, 0x64,
    0, 0, 0, 6,
    0, 1,
    (tracks.length >> 8) & 0xff, tracks.length & 0xff,
    (PPQ >> 8) & 0xff, PPQ & 0xff,
  ];
  const all = header.concat(...tracks);
  void totalTicks;
  return new Uint8Array(all);
}

function scaleInterval(state, noteIndex) {
  const intervals = { minPent: [0, 3, 5, 7, 10], natMinor: [0, 2, 3, 5, 7, 8, 10], phryg: [0, 1, 3, 5, 7, 8, 10] };
  const arr = intervals[state.scale] || intervals.minPent;
  const i = Math.max(0, Math.min(arr.length - 1, noteIndex));
  return arr[i];
}