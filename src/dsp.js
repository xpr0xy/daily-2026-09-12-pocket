// POCKET — deterministic drum/sub voice synthesis.
// Every voice renders to a Float32Array at unit velocity. Same params + seed
// always produce the same samples. No samples, no randomness that is not seeded.

export const SR = 48000;

export function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return (s / 4294967296) * 2 - 1;
  };
}

function normalize(buf) {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = buf[i] < 0 ? -buf[i] : buf[i];
    if (a > peak) peak = a;
  }
  if (peak > 0) {
    const g = 1 / peak;
    for (let i = 0; i < buf.length; i++) buf[i] *= g;
  }
  return buf;
}

// Soft saturation with unity peak mapping: drive adds harmonics, not level.
export function applyDrive(buf, drive) {
  const d = Math.max(0, Math.min(1, drive || 0));
  if (d <= 0.001) return buf;
  const k = 1 + d * 6;
  const nk = Math.tanh(k);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(k * buf[i]) / nk;
  return buf;
}

export function renderKick(p, sr = SR, seed = 1) {
  const dur = 0.07 + p.decay;
  const n = Math.ceil(dur * sr);
  const out = new Float32Array(n);
  const rnd = makeRng(seed ^ 0x51ed2701);
  const f0 = p.tune;
  const fStart = p.tune * 3.4;
  const tau = 0.010;
  const ampTau = Math.max(0.02, p.decay / 4.2);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = f0 + (fStart - f0) * Math.exp(-t / tau);
    ph += (2 * Math.PI * f) / sr;
    let a = Math.exp(-t / ampTau);
    if (t < 0.0015) a *= t / 0.0015;
    let x = Math.sin(ph) * a;
    if (t < 0.007) x += rnd() * 0.35 * (1 - t / 0.007) * a;
    out[i] = x;
  }
  return applyDrive(normalize(out), p.drive);
}

export function renderSnare(p, sr = SR, seed = 2) {
  const dur = 0.08 + p.decay * 1.7;
  const n = Math.ceil(dur * sr);
  const out = new Float32Array(n);
  const rnd = makeRng(seed ^ 0x2f9a1b);
  const bodyTau = Math.max(0.02, p.decay * 0.55);
  const noiseTau = Math.max(0.03, p.decay * 0.85);
  const f = 2 * Math.sin((Math.PI * 2100) / sr);
  const q = 1 / 1.15;
  let low = 0, band = 0, hpState = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const body =
      (Math.sin(2 * Math.PI * p.tune * t) * 0.7 +
        Math.sin(2 * Math.PI * p.tune * 1.58 * t) * 0.45) *
      Math.exp(-t / bodyTau);
    const raw = rnd();
    const hp = raw - hpState;
    hpState += (raw - hpState) * 0.09;
    low += f * band;
    const high = hp - low - q * band;
    band += f * high;
    let env = Math.exp(-t / noiseTau);
    if (t < 0.0008) env *= t / 0.0008;
    out[i] = body + band * 1.25 * env;
  }
  return applyDrive(normalize(out), p.drive);
}

export function renderHat(p, sr = SR, seed = 3) {
  const dur = 0.018 + p.decay;
  const n = Math.ceil(dur * sr);
  const out = new Float32Array(n);
  const rnd = makeRng(seed ^ 0x7b1d5f);
  const a = 1 - Math.exp((-2 * Math.PI * p.tune) / sr);
  const ringF = 2 * Math.sin((Math.PI * Math.min(9200, p.tune * 0.72)) / sr);
  const q = 1 / 0.8;
  const ampTau = Math.max(0.006, p.decay / 4);
  let lp1 = 0, lp2 = 0, low = 0, band = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const raw = rnd();
    lp1 += (raw - lp1) * a;
    const h1 = raw - lp1;
    lp2 += (h1 - lp2) * a;
    const h2 = h1 - lp2;
    low += ringF * band;
    const high = h2 - low - q * band;
    band += ringF * high;
    let env = Math.exp(-t / ampTau);
    if (t < 0.0006) env *= t / 0.0006;
    out[i] = (h2 * 0.8 + band * 0.45) * env;
  }
  return applyDrive(normalize(out), p.drive);
}

export function renderSub(p, sr = SR, freq = 55) {
  const dur = 0.1 + p.decay * 1.4;
  const n = Math.ceil(dur * sr);
  const out = new Float32Array(n);
  const ampTau = Math.max(0.03, p.decay / 3.2);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = freq * (1 + 0.035 * Math.exp(-t / 0.03));
    ph += (2 * Math.PI * f) / sr;
    let a = Math.exp(-t / ampTau);
    if (t < 0.004) a *= t / 0.004;
    out[i] = Math.sin(ph) * a;
  }
  return applyDrive(normalize(out), p.drive);
}

// Master bus: gain, hard clip. The user's spec is a hard-clipped master,
// so this is a real limiter-free clip, not a soft compressor in disguise.
export function masterClip(buf, drive, level = 0.9) {
  const g = level * (1 + drive * 2.2);
  const lim = 0.985;
  for (let i = 0; i < buf.length; i++) {
    let x = buf[i] * g;
    if (x > lim) x = lim;
    else if (x < -lim) x = -lim;
    buf[i] = x;
  }
  return buf;
}

export const PARAM_SPECS = {
  kick: {
    tune: { min: 34, max: 72, step: 1, unit: 'Hz' },
    decay: { min: 0.08, max: 0.7, step: 0.005, unit: 's' },
    drive: { min: 0, max: 1, step: 0.01, unit: '' },
    nudge: { min: -20, max: 20, step: 0.5, unit: 'ms' },
  },
  snare: {
    tune: { min: 140, max: 300, step: 1, unit: 'Hz' },
    decay: { min: 0.05, max: 0.45, step: 0.005, unit: 's' },
    drive: { min: 0, max: 1, step: 0.01, unit: '' },
    nudge: { min: -20, max: 20, step: 0.5, unit: 'ms' },
  },
  hat: {
    tune: { min: 4800, max: 12000, step: 50, unit: 'Hz' },
    decay: { min: 0.015, max: 0.34, step: 0.005, unit: 's' },
    drive: { min: 0, max: 1, step: 0.01, unit: '' },
    nudge: { min: -20, max: 20, step: 0.5, unit: 'ms' },
  },
  sub: {
    decay: { min: 0.15, max: 1.0, step: 0.01, unit: 's' },
    drive: { min: 0, max: 1, step: 0.01, unit: '' },
    nudge: { min: -20, max: 20, step: 0.5, unit: 'ms' },
  },
};
