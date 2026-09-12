// POCKET — live transport. The rendered loop is the single source of truth:
// audition and export are the same bytes. Edits never restart the playhead;
// a new render is swapped in at the next loop boundary.
import { renderLoop, loopFrames } from './render.js';

export class Engine {
  constructor(getState) {
    this.getState = getState;
    this.ctx = null;
    this.gain = null;
    this.source = null;
    this.buffer = null;
    this.pendingBuffer = null;
    this.startTime = 0;
    this.dur = 0;
    this.passes = 0; // completed loop passes since play()
    this.playing = false;
    this.pending = false;
    this.renderMs = 0;
    this.swaps = 0;
  }

  async ensureCtx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ sampleRate: 48000, latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0.85;
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  render(state) {
    const t0 = performance.now();
    const out = renderLoop(state);
    this.renderMs = performance.now() - t0;
    return out;
  }

  toAudioBuffer(rendered) {
    const buf = this.ctx.createBuffer(2, rendered.frames, rendered.sr);
    const ch = buf.getChannelData(0);
    const ch2 = buf.getChannelData(1);
    for (let i = 0; i < rendered.frames; i++) {
      const v = rendered.pcm[i * 2] / 32767;
      ch[i] = v;
      ch2[i] = v;
    }
    return buf;
  }

  async play() {
    await this.ensureCtx();
    if (this.playing) return;
    const rendered = this.render(this.getState());
    this.buffer = this.toAudioBuffer(rendered);
    this.dur = this.buffer.duration;
    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.loop = true;
    this.source.connect(this.gain);
    this.source.start();
    this.startTime = this.ctx.currentTime;
    this.passes = 0;
    this.pendingBuffer = null;
    this.pending = false;
    this.playing = true;
  }

  stop() {
    if (this.source) {
      try {
        this.source.stop();
      } catch (e) {}
      this.source.disconnect();
    }
    this.source = null;
    this.playing = false;
    this.pending = false;
    this.pendingBuffer = null;
  }

  async toggle() {
    if (this.playing) this.stop();
    else await this.play();
    return this.playing;
  }

  // Called after every material change. While stopped there is nothing to swap:
  // the next play() renders from the same state, so audition stays honest.
  commit() {
    if (!this.playing) return;
    const rendered = this.render(this.getState());
    this.pendingBuffer = this.toAudioBuffer(rendered);
    this.pending = true;
  }

  tick() {
    if (!this.playing || !this.dur) return { step: 0, pos: 0, passes: 0, pending: false };
    let elapsed = this.ctx.currentTime - this.startTime;
    if (elapsed >= this.dur) {
      const crossed = Math.floor(elapsed / this.dur);
      elapsed -= crossed * this.dur;
      this.startTime += crossed * this.dur;
      this.passes += crossed;
      if (this.pendingBuffer) this.swapBoundary();
    }
    const pos = Math.max(0, Math.min(0.9999, elapsed / this.dur));
    return { step: Math.floor(pos * 32), pos, passes: this.passes, pending: this.pending };
  }

  // Phase-preserving swap with a 6 ms crossfade so the seam cannot click.
  swapBoundary() {
    const next = this.pendingBuffer;
    if (!next) return;
    const at = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = next;
    src.loop = true;
    const fadeIn = this.ctx.createGain();
    fadeIn.gain.setValueAtTime(0, at);
    fadeIn.gain.linearRampToValueAtTime(1, at + 0.006);
    src.connect(fadeIn);
    fadeIn.connect(this.gain);
    src.start(at);
    const old = this.source;
    if (old) {
      const fadeOut = this.ctx.createGain();
      fadeOut.gain.setValueAtTime(1, at);
      fadeOut.gain.linearRampToValueAtTime(0, at + 0.006);
      old.disconnect();
      old.connect(fadeOut);
      fadeOut.connect(this.gain);
      try {
        old.stop(at + 0.012);
      } catch (e) {}
    }
    this.source = src;
    this.buffer = next;
    this.dur = next.duration;
    this.startTime = at;
    this.pendingBuffer = null;
    this.pending = false;
    this.swaps++;
  }
}

export { loopFrames };