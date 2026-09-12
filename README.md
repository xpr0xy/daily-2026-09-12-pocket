# POCKET

A two-step pocket writer for drum-and-bass and bass-music producers. Draw a 32-step pattern across four
rails, shape its pocket with swing and per-voice nudge, then export a loop-ready WAV for Ableton or a MIDI
file for any host.

## Instrument contract

- **fixed character:** four synthesized voices with no sample library behind them — a pitch-swept kick, a
  body-plus-noise snare, a filtered metallic hat, and a scale-locked sine sub. No rolls, no ghost snares,
  no riser generators, no effects rack. The master is hard-clipped, per null_hax's DnB spec.
- **user ownership:** every step and its velocity on four rails, the sub note behind each sub step, root
  and scale, swing, per-voice tune / decay / drive / nudge, and master drive and level.
- **material controls** (they change the exported artifact): steps, velocities, sub notes, root, scale,
  the four voice parameter sets, swing, master drive and level.
- **performance controls:** play/stop (button, spacebar), live edits that land at the loop end, A/B slots
  for two patterns on one tempo.
- **transport/UI:** tempo, position readout, voice selection, panel disclosure, pending-swap indicator.
- **state controls:** four named patterns, CLEAR, DICE with per-voice locks, recipe download/import, slot copy.

## Reachable jobs from the same starting pattern

- **two-step roller** — kick on 1 and the "and" of 3, snare on 2 and 4, sparse tops.
- **half-time stomp** — kick and snare land on 1 and 3, dragged hat, longer kick and sub decay.
- **UKG shuffle** — swung offbeat hats over a straight backbeat.
- **dub cut** — one snare per two bars, no hats, a long sub that wraps through the loop point.

## Architecture

`src/dsp.js` renders each voice with seeded noise and analytic envelopes. `src/render.js` places every
event at a sample-accurate frame offset (swing, per-voice nudge) into a fixed-length loop buffer, wraps
long tails around the loop point, hard-clips the master, and quantizes to PCM16. The exported WAV and the
live `AudioBuffer` are both built from those exact integers, so audition and export cannot drift. The
live transport never restarts on an edit: it renders a new buffer and swaps it at the next loop boundary
with a 6 ms crossfade, preserving phase.

Verified in `test.mjs` (18 deterministic checks) and `qa.mjs` (39 browser checks, including the paint
gesture, lock-aware dice, boundary swap, phase continuity, both exports through the validators, mobile
horizontal-overflow and far-edge scroller reachability).

## Run

```sh
npm ci
npm test
npm run build
python3 -m http.server 8772 --bind 127.0.0.1 --directory docs
npm run qa
node validate.mjs qa/export.wav
```

Everything runs locally in the browser. No uploads, no network calls, no accounts.
