// Downstream validators: the exported WAV and MIDI must be readable by a real host.
export function validateWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (off, n) => String.fromCharCode(...bytes.slice(off, off + n));
  const fail = (m) => {
    throw new Error('WAV invalid: ' + m);
  };
  if (bytes.length < 44) fail('too short');
  if (ascii(0, 4) !== 'RIFF') fail('missing RIFF');
  if (ascii(8, 4) !== 'WAVE') fail('missing WAVE');
  if (ascii(12, 4) !== 'fmt ') fail('missing fmt chunk');
  if (view.getUint32(16, true) !== 16) fail('unexpected fmt size');
  if (view.getUint16(20, true) !== 1) fail('not PCM');
  const channels = view.getUint16(22, true);
  const rate = view.getUint32(24, true);
  const bits = view.getUint16(34, true);
  if (channels !== 2) fail('expected stereo, got ' + channels);
  if (rate !== 48000) fail('expected 48000 Hz, got ' + rate);
  if (bits !== 16) fail('expected 16-bit, got ' + bits);
  const dataBytes = view.getUint32(40, true);
  if (44 + dataBytes !== bytes.length) fail('data chunk size does not match file length');
  if (dataBytes < 1000) fail('no audio data');
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset + 44, dataBytes / 2);
  let peak = 0;
  let energy = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    energy += samples[i] * samples[i];
  }
  const rms = Math.sqrt(energy / samples.length);
  if (peak < 500) fail('silent file (peak ' + peak + ')');
  if (peak > 32767) fail('clipped beyond PCM range');
  const frames = dataBytes / 4;
  return { channels, rate, bits, frames, seconds: frames / rate, peak, rms, peakDbfs: 20 * Math.log10(peak / 32768) };
}

export function validateMidi(bytes) {
  const fail = (m) => {
    throw new Error('MIDI invalid: ' + m);
  };
  const ascii = (off, n) => String.fromCharCode(...bytes.slice(off, off + n));
  if (bytes.length < 22) fail('too short');
  if (ascii(0, 4) !== 'MThd') fail('missing MThd');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4) !== 6) fail('bad header length');
  const format = view.getUint16(8);
  const tracks = view.getUint16(10);
  const division = view.getUint16(12);
  if (format !== 1) fail('expected format 1');
  if (division !== 480) fail('expected 480 PPQ');
  let off = 14;
  let noteOns = 0;
  let noteOffs = 0;
  let tempos = 0;
  for (let t = 0; t < tracks; t++) {
    if (ascii(off, 4) !== 'MTrk') fail('missing MTrk at track ' + t);
    const len = view.getUint32(off + 4);
    const end = off + 8 + len;
    if (end > bytes.length) fail('track ' + t + ' exceeds file');
    let i = off + 8;
    let running = 0;
    while (i < end) {
      // delta time
      while (bytes[i] & 0x80) i++;
      i++;
      let status = bytes[i];
      if (status & 0x80) {
        i++;
        running = status;
      } else {
        status = running;
      }
      if (status === 0xff) {
        const type = bytes[i++];
        let l = 0;
        while (bytes[i] & 0x80) l = (l << 7) | (bytes[i++] & 0x7f);
        l = (l << 7) | bytes[i++];
        if (type === 0x51) tempos++;
        i += l;
      } else if ((status & 0xf0) === 0x90) {
        const vel = bytes[i + 1];
        if (vel > 0) noteOns++;
        else noteOffs++;
        i += 2;
      } else if ((status & 0xf0) === 0x80) {
        noteOffs++;
        i += 2;
      } else if ((status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0) {
        i += 1;
      } else {
        i += 2;
      }
    }
    off = end;
  }
  if (off !== bytes.length) fail('trailing bytes after last track');
  if (noteOns === 0) fail('no note-on events');
  if (noteOns !== noteOffs) fail(`unbalanced notes (${noteOns} on / ${noteOffs} off)`);
  if (tempos === 0) fail('no tempo event');
  return { format, tracks, division, noteOns, noteOffs };
}
