import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parseMidiFile } from './public/midi-parser.mjs';
import { computeKeyboardMap } from './dsp-pipeline.mjs';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.join(ROOT_DIR, 'catalog.json');
const RENDERS_DIR = path.join(ROOT_DIR, 'renders');

const CHROMATIC_HEX = [
  '#e33059', // C
  '#f75839', // C#
  '#f7943d', // D
  '#f3b72f', // D#
  '#edd929', // E
  '#95c631', // F
  '#56a754', // F#
  '#11826d', // G
  '#3160a3', // G#
  '#5b37cc', // A
  '#a347bf', // A#
  '#ea57b2'  // B
];
const PERC_HEX = '#8c95a4';

const MIN_MIDI = 24;
const MAX_MIDI = 103;
const MAX_CLIP_DUR = 2.50;
const RELEASE_SEC = 0.40;
const HIGHPASS_HZ = 80;
const AUDIO_SR = 48000;
const STAGE_SLOT_COUNT = 3;

const SPEC_MIN_FREQ = 45;
const SPEC_MAX_FREQ = 4200;
const SPEC_LOG_MIN = Math.log(SPEC_MIN_FREQ);
const SPEC_LOG_MAX = Math.log(SPEC_MAX_FREQ);

const FFT_SIZE = 1024;
const HANN_WIN = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  HANN_WIN[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
}

function hexToRgb(hex) {
  const clean = String(hex || '#8c95a4').replace('#', '');
  const n = parseInt(clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function getNoteRgb(midi) {
  if (midi < 36) return hexToRgb(PERC_HEX);
  const pc = ((midi % 12) + 12) % 12;
  return hexToRgb(CHROMATIC_HEX[pc]);
}

function fftInPlace(real, imag) {
  const n = real.length;
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (i < j) {
      const tr = real[i]; real[i] = real[j]; real[j] = tr;
      const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }
  for (let s = 1; (1 << s) <= n; s++) {
    const m = 1 << s;
    const halfM = m >> 1;
    const theta = (-2 * Math.PI) / m;
    const wpr = Math.cos(theta);
    const wpi = Math.sin(theta);
    for (let k = 0; k < n; k += m) {
      let wr = 1.0;
      let wi = 0.0;
      for (let j2 = 0; j2 < halfM; j2++) {
        const idx1 = k + j2;
        const idx2 = idx1 + halfM;
        const tr = wr * real[idx2] - wi * imag[idx2];
        const ti = wr * imag[idx2] + wi * real[idx2];
        real[idx2] = real[idx1] - tr;
        imag[idx2] = imag[idx1] - ti;
        real[idx1] += tr;
        imag[idx1] += ti;
        const wtemp = wr;
        wr = wr * wpr - wi * wpi;
        wi = wtemp * wpi + wi * wpr;
      }
    }
  }
}

export function noteTintedSpecColor(norm, noteRgb) {
  const t = Math.max(0, Math.min(1, norm));
  if (t <= 0.015) return [3, 4, 6];

  // Neutral grayscale backbone from stage black (#030406) up to crisp silver
  const g = Math.pow(t, 1.12);
  const baseR = 3 + g * 232;
  const baseG = 4 + g * 231;
  const baseB = 6 + g * 230;

  if (t <= 0.40 || !noteRgb) {
    return [Math.round(baseR), Math.round(baseG), Math.round(baseB)];
  }

  // Lift note hue to bright pastel-luminous target so intense spectral ridges
  // stay ~72%+ monochrome while carrying a subtle tint of the fundamental note hue
  const maxCh = Math.max(noteRgb[0], noteRgb[1], noteRgb[2], 1);
  const lift = 235 / maxCh;
  const tintR = Math.min(255, noteRgb[0] * lift * 0.82 + 45);
  const tintG = Math.min(255, noteRgb[1] * lift * 0.82 + 45);
  const tintB = Math.min(255, noteRgb[2] * lift * 0.82 + 45);

  const mix = Math.pow((t - 0.40) / 0.60, 1.25) * 0.30;
  return [
    Math.round(baseR * (1 - mix) + tintR * mix),
    Math.round(baseG * (1 - mix) + tintG * mix),
    Math.round(baseB * (1 - mix) + tintB * mix)
  ];
}

function buildMiniSpectrogramRgb(samples, sr, W, H, playbackRate, trimIn, bufferSpanSec, noteRgb) {
  const effectiveSr = sr * playbackRate;
  const s0 = Math.max(0, Math.min(samples.length - 1, Math.floor(trimIn * sr)));
  const spanSamples = bufferSpanSec
    ? Math.max(FFT_SIZE, Math.floor(bufferSpanSec * sr))
    : Math.max(FFT_SIZE, samples.length - s0);
  const sEnd = Math.min(samples.length, s0 + spanSamples);
  const usableSpan = Math.max(1, sEnd - s0 - FFT_SIZE);

  const real = new Float32Array(FFT_SIZE);
  const imag = new Float32Array(FFT_SIZE);
  const half = FFT_SIZE >> 1;
  const colMags = new Array(W);
  let globalMaxDb = -90;

  for (let x = 0; x < W; x++) {
    const startSample = s0 + Math.floor((x / W) * usableSpan);
    for (let i = 0; i < FFT_SIZE; i++) {
      real[i] = (samples[startSample + i] || 0) * HANN_WIN[i];
      imag[i] = 0;
    }
    fftInPlace(real, imag);
    const dbArr = new Float32Array(half);
    for (let k = 1; k < half; k++) {
      const db = 20 * Math.log10(Math.hypot(real[k], imag[k]) + 1e-7);
      dbArr[k] = db;
      if (db > globalMaxDb) globalMaxDb = db;
    }
    colMags[x] = dbArr;
  }

  const floorDb = globalMaxDb - 54;
  const rgbBuf = Buffer.alloc(W * H * 3);

  for (let x = 0; x < W; x++) {
    const dbArr = colMags[x];
    for (let y = 0; y < H; y++) {
      const normY = 1 - y / Math.max(1, H - 1);
      const freq = Math.exp(SPEC_LOG_MIN + normY * (SPEC_LOG_MAX - SPEC_LOG_MIN));
      const exactBin = (freq * FFT_SIZE) / effectiveSr;
      const b0 = Math.max(1, Math.min(half - 2, Math.floor(exactBin)));
      const frac = exactBin - b0;
      const db = dbArr[b0] * (1 - frac) + dbArr[b0 + 1] * frac;
      const norm = (db - floorDb) / (globalMaxDb - floorDb + 1e-5);
      const [r, g, b] = noteTintedSpecColor(norm, noteRgb);
      const off = (y * W + x) * 3;
      rgbBuf[off] = r;
      rgbBuf[off + 1] = g;
      rgbBuf[off + 2] = b;
    }
  }
  return rgbBuf;
}

function makeSeededRng(seed = 1337) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function computeScheduledGainAt(voice, elapsed) {
  const pk = voice.peakGain;
  if (elapsed <= 0) return 0.0001;
  if (elapsed < 0.006) return Math.max(0.0001, pk * (elapsed / 0.006));
  if (elapsed <= voice.forcedRelStart) return pk;
  const u = Math.max(0, Math.min(1, (elapsed - voice.forcedRelStart) / Math.max(0.02, voice.forcedRelDur)));
  if (u <= 0.35) return pk * (1 - (u / 0.35) * (1 - 0.56));
  if (u <= 0.72) return pk * (0.56 - ((u - 0.35) / 0.37) * (0.56 - 0.18));
  return Math.max(0.0001, pk * 0.18 * (1 - (u - 0.72) / 0.28));
}

function evalVoiceGain(voice, t) {
  if (t < voice.startSec || t >= voice.endSec) return 0;
  if (voice.stolenAtSec !== null && t >= voice.stolenAtSec) {
    const dt = t - voice.stolenAtSec;
    const fDur = Math.max(0.01, voice.stolenFadeDur || 0.016);
    if (dt >= fDur) return 0;
    return voice.stolenGainStart * (1 - dt / fDur);
  }
  if (voice.earlyRelSec !== null && t >= voice.earlyRelSec) {
    const u = Math.max(0, Math.min(1, (t - voice.earlyRelSec) / Math.max(0.02, voice.earlyRelDur)));
    const g0 = voice.earlyRelGainStart;
    if (u <= 0.35) return g0 * (1 - (u / 0.35) * (1 - 0.56));
    if (u <= 0.72) return g0 * (0.56 - ((u - 0.35) / 0.37) * (0.56 - 0.18));
    return Math.max(0, g0 * 0.18 * (1 - (u - 0.72) / 0.28));
  }
  return computeScheduledGainAt(voice, t - voice.startSec);
}

function evalStripeAlpha(voice, t) {
  if (t < voice.startSec || t >= voice.visualEndSec || t >= voice.endSec) return 0;
  const relStart =
    voice.earlyRelSec !== null
      ? Math.min(voice.earlyRelSec, voice.startSec + voice.forcedRelStart)
      : voice.startSec + voice.forcedRelStart;
  if (t <= relStart) return 1;
  const relSpan = Math.max(0.025, voice.endSec - relStart);
  return Math.max(0, Math.min(1, 1 - (t - relStart) / relSpan));
}

function applyBiquadHighpassInPlace(samples, sr, cutoffHz) {
  const w0 = (2 * Math.PI * cutoffHz) / sr;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * Math.SQRT1_2);
  const b0 = (1 + cosw0) / 2;
  const b1 = -(1 + cosw0);
  const b2 = (1 + cosw0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha;

  const nb0 = b0 / a0;
  const nb1 = b1 / a0;
  const nb2 = b2 / a0;
  const na1 = a1 / a0;
  const na2 = a2 / a0;

  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
    samples[i] = y0;
  }
}

function writeWavMono16(filePath, floatSamples, sr) {
  const numSamples = floatSamples.length;
  const dataBytes = numSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // Mono
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, floatSamples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  fs.writeFileSync(filePath, buf);
}

// Draw an anti-aliased filled or ring circle using Screen blend mode onto RGB24 buffer
function drawScreenCircleRgb(frameBuf, W, H, cx, cy, radius, rgb, alpha = 1.0, ringThickness = 0) {
  if (radius <= 0.2 || alpha <= 0.004) return;
  const x0 = Math.max(0, Math.floor(cx - radius - 1.5));
  const x1 = Math.min(W - 1, Math.ceil(cx + radius + 1.5));
  const y0 = Math.max(0, Math.floor(cy - radius - 1.5));
  const y1 = Math.min(H - 1, Math.ceil(cy + radius + 1.5));
  const innerR = ringThickness > 0 ? Math.max(0, radius - ringThickness) : 0;

  for (let py = y0; py <= y1; py++) {
    const dy = py - cy;
    const rowOff = py * W * 3;
    for (let px = x0; px <= x1; px++) {
      const dx = px - cx;
      const dist = Math.hypot(dx, dy);
      let cov = Math.max(0, Math.min(1, radius + 0.5 - dist));
      if (cov <= 0) continue;
      if (ringThickness > 0) {
        const innerCov = Math.max(0, Math.min(1, dist - innerR + 0.5));
        cov *= innerCov;
        if (cov <= 0) continue;
      }

      const effA = cov * alpha;
      const sr = rgb[0] * effA;
      const sg = rgb[1] * effA;
      const sb = rgb[2] * effA;

      const idx = rowOff + px * 3;
      const dr = frameBuf[idx];
      const dg = frameBuf[idx + 1];
      const db = frameBuf[idx + 2];

      // Exact Screen Blend: 1 - (1 - dst) * (1 - src)
      frameBuf[idx] = Math.min(255, Math.round(255 - ((255 - dr) * (255 - sr)) / 255));
      frameBuf[idx + 1] = Math.min(255, Math.round(255 - ((255 - dg) * (255 - sg)) / 255));
      frameBuf[idx + 2] = Math.min(255, Math.round(255 - ((255 - db) * (255 - sb)) / 255));
    }
  }
}

export async function renderMidiPerformanceToMp4({
  midiBytes,
  midiFilePath = null,
  outPath = null,
  width = 1440,
  height = 1080,
  fps = 30,
  onProgress = null
}) {
  const report = (phase, percent, extra = {}) => {
    if (typeof onProgress === 'function') {
      onProgress({ phase, percent: Math.round(percent), ...extra });
    }
  };

  const W = Math.max(320, Math.round(width / 2) * 2);
  const H = Math.max(240, Math.round(height / 2) * 2);
  const rawBytes = midiBytes || fs.readFileSync(midiFilePath);
  const parsed = parseMidiFile(rawBytes);

  if (!parsed.events.length || parsed.noteCount === 0) {
    throw new Error('MIDI file contains no playable Note-On events');
  }

  fs.mkdirSync(RENDERS_DIR, { recursive: true });
  const finalOutPath =
    outPath ||
    path.join(
      RENDERS_DIR,
      `render_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.mp4`
    );

  report('Simulating MIDI performance', 2);

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const keyMap = computeKeyboardMap(catalog.videos, catalog.keyboardConfig || {});
  const rng = makeSeededRng(20261103);
  const lastSliceByMidi = new Map();

  function pickCandidate(midi) {
    const enabled = (keyMap[midi]?.candidates || []).filter(c => c.enabled);
    if (!enabled.length) return null;
    if (enabled.length === 1) {
      lastSliceByMidi.set(midi, enabled[0].sliceId);
      return enabled[0];
    }
    const lastId = lastSliceByMidi.get(midi);
    const lastIdx = lastId ? enabled.findIndex(c => c.sliceId === lastId) : -1;
    const nextIdx = (lastIdx + 1) % enabled.length;
    const chosen = enabled[nextIdx];
    lastSliceByMidi.set(midi, chosen.sliceId);
    return chosen;
  }

  // First load PCM durations of candidate slices that might be triggered so durations are exact
  const pcmCache = new Map();
  function getSlicePcm(cand) {
    if (pcmCache.has(cand.audioUrl)) return pcmCache.get(cand.audioUrl);
    const wavAbs = path.join(ROOT_DIR, cand.audioUrl.replace(/^\//, ''));
    const raw = execFileSync('ffmpeg', [
      '-v', 'error',
      '-i', wavAbs,
      '-ac', '1',
      '-ar', String(AUDIO_SR),
      '-f', 'f32le',
      'pipe:1'
    ]);
    const floats = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
    pcmCache.set(cand.audioUrl, floats);
    return floats;
  }

  // Deterministic timeline simulation (voices + 3-slot same-clip stealing + dot hold intervals)
  const voices = [];
  const activeHeld = new Map(); // key: `${ch}_${midi}` -> voice
  const pendingPedalRelease = new Set();
  let pedalDown = false;

  const simSlots = [
    { voice: null, seq: 0 },
    { voice: null, seq: 0 },
    { voice: null, seq: 0 }
  ];
  let slotSeq = 0;

  function refreshExpiredSlotsAt(t) {
    for (let i = 0; i < STAGE_SLOT_COUNT; i++) {
      if (simSlots[i].voice && t >= simSlots[i].voice.visualEndSec) {
        simSlots[i].voice = null;
      }
    }
  }

  function allocateSlotAt(t, sliceKey) {
    refreshExpiredSlotsAt(t);
    // 1. Same-clip slot steal first!
    for (let i = 0; i < STAGE_SLOT_COUNT; i++) {
      if (simSlots[i].voice && simSlots[i].voice.sliceKey === sliceKey) {
        return i;
      }
    }
    // 2. Left-to-right empty slot
    for (let i = 0; i < STAGE_SLOT_COUNT; i++) {
      if (!simSlots[i].voice) return i;
    }
    // 3. Completed-playback slot that is only staying frozen on its last frame while held
    let oldestFrozen = -1;
    for (let i = 0; i < STAGE_SLOT_COUNT; i++) {
      if (simSlots[i].voice && t >= simSlots[i].voice.endSec) {
        if (oldestFrozen === -1 || simSlots[i].seq < simSlots[oldestFrozen].seq) {
          oldestFrozen = i;
        }
      }
    }
    if (oldestFrozen !== -1) return oldestFrozen;

    // 4. Oldest active slot fallback
    let oldest = 0;
    for (let i = 1; i < STAGE_SLOT_COUNT; i++) {
      if (simSlots[i].seq < simSlots[oldest].seq) oldest = i;
    }
    return oldest;
  }

  function triggerNoteRelease(voice, t) {
    if (!voice) return;
    if (t >= voice.endSec) {
      // Clip already completed in silence while frozen on its last frame: release visuals & dot right away!
      voice.visualEndSec = Math.min(voice.visualEndSec, t);
      voice.dotReleaseSec = Math.min(voice.dotReleaseSec, t);
      return;
    }
    if (voice.earlyRelSec !== null) return;
    const elapsed = Math.max(0, t - voice.startSec);
    const remaining = Math.max(0.02, voice.naturalDur - elapsed);
    const rel = Math.min(RELEASE_SEC, remaining);
    voice.earlyRelSec = t;
    voice.earlyRelDur = rel;
    voice.earlyRelGainStart = computeScheduledGainAt(voice, elapsed);
    voice.endSec = Math.min(voice.endSec, t + rel);
    voice.visualEndSec = Math.min(voice.visualEndSec, voice.endSec);
    voice.dotReleaseSec = Math.min(voice.dotReleaseSec, t);
  }

  for (const ev of parsed.events) {
    const t = ev.timeSec;
    if (ev.type === 'sustain') {
      pedalDown = !!ev.pedalDown;
      if (!pedalDown) {
        for (const k of Array.from(pendingPedalRelease)) {
          pendingPedalRelease.delete(k);
          const v = activeHeld.get(k);
          if (v) {
            activeHeld.delete(k);
            triggerNoteRelease(v, t);
          }
        }
      }
      continue;
    }

    const holdKey = `${ev.channel}_${ev.midi}`;
    if (ev.type === 'noteOff') {
      if (pedalDown) {
        if (activeHeld.has(holdKey)) pendingPedalRelease.add(holdKey);
      } else {
        const v = activeHeld.get(holdKey);
        if (v) {
          activeHeld.delete(holdKey);
          triggerNoteRelease(v, t);
        }
      }
      continue;
    }

    if (ev.type === 'noteOn') {
      if (ev.midi < MIN_MIDI || ev.midi > MAX_MIDI) continue;
      pendingPedalRelease.delete(holdKey);
      const prevHeld = activeHeld.get(holdKey);
      if (prevHeld) {
        activeHeld.delete(holdKey);
        triggerNoteRelease(prevHeld, t);
      }

      const cand = pickCandidate(ev.midi);
      if (!cand) continue;

      const pcm = getSlicePcm(cand);
      const bufDur = pcm.length / AUDIO_SR;
      const rate = cand.playbackRate || 1.0;
      const rawLimit = Math.min(MAX_CLIP_DUR, Number(cand.rawDurSec ?? bufDur), bufDur);
      const trimIn = Math.max(0, Math.min(Math.max(0, rawLimit - 0.08), Number(cand.trimIn ?? 0)));
      const trimOut = Math.max(trimIn + 0.08, Math.min(rawLimit, Number(cand.trimOut ?? rawLimit)));
      const unpitchedSpan = Math.max(0.08, trimOut - trimIn);
      const playDur = Math.min(MAX_CLIP_DUR, unpitchedSpan / rate);
      const bufferPlaySpan = Math.min(bufDur - trimIn, playDur * rate);

      const forcedRelDur = Math.min(RELEASE_SEC, playDur * 0.78);
      const forcedRelStart = Math.max(0.012, playDur - forcedRelDur);

      const dbOffset = cand.peakDb !== undefined ? Math.max(0, Math.min(8, (-22 - cand.peakDb) * 0.35)) : 0;
      const boost = Math.pow(10, dbOffset / 20);
      const peakGain = Math.min(1.25, 0.86 * (ev.velocity || 0.85) * boost);

      const slotIdx = allocateSlotAt(t, cand.sliceId);
      const displaced = simSlots[slotIdx].voice;
      if (displaced && t < displaced.visualEndSec) {
        displaced.visualEndSec = t;
        displaced.dotReleaseSec = Math.min(displaced.dotReleaseSec, t);
        if (displaced.holdKey && activeHeld.get(displaced.holdKey) === displaced) {
          activeHeld.delete(displaced.holdKey);
          pendingPedalRelease.delete(displaced.holdKey);
        }
        // Fade displaced voice if its audio was still playing
        if (displaced.stolenAtSec === null && t < displaced.endSec) {
          const fadeSec = displaced.sliceKey === cand.sliceId ? 0.016 : 0.18;
          displaced.stolenGainStart = evalVoiceGain(displaced, t);
          displaced.stolenAtSec = t;
          displaced.stolenFadeDur = fadeSec;
          displaced.endSec = Math.min(displaced.endSec, t + fadeSec);
        }
      }

      const isPerc = ev.midi < 36;
      const f0Hz = isPerc ? null : 440 * Math.pow(2, (ev.midi - 69) / 12);

      slotSeq += 1;
      const voice = {
        holdKey,
        midi: ev.midi,
        isPerc,
        cand,
        sliceKey: cand.sliceId,
        slotIdx,
        playbackRate: rate,
        trimIn,
        bufferPlaySpan,
        peakGain,
        startSec: t,
        naturalDur: playDur,
        forcedRelStart,
        forcedRelDur,
        earlyRelSec: null,
        earlyRelDur: RELEASE_SEC,
        earlyRelGainStart: peakGain,
        stolenAtSec: null,
        stolenGainStart: 0,
        stolenFadeDur: 0.016,
        endSec: t + playDur,
        // Stay frozen on last frame + spectrogram while held until noteOff or slot steal!
        visualEndSec: Infinity,
        dotReleaseSec: Infinity,
        f0Hz,
        noteRgb: getNoteRgb(ev.midi)
      };

      simSlots[slotIdx] = { voice, seq: slotSeq };
      activeHeld.set(holdKey, voice);
      voices.push(voice);
    }
  }

  // Release any notes left unclosed at end of MIDI stream
  for (const v of activeHeld.values()) {
    triggerNoteRelease(v, parsed.durationSec + 0.05);
  }

  let renderDurationSec = parsed.durationSec + 0.6;
  for (const v of voices) {
    if (v.endSec + 0.35 > renderDurationSec) {
      renderDurationSec = v.endSec + 0.35;
    }
  }

  // Geometry matching browser .performance-canvas proportions (4:3 centered composition)
  const slotGap = Math.round(W * 0.02);
  const tileSize = Math.round(Math.min(W * 0.256, H * 0.345));
  const specGap = Math.max(6, Math.round(tileSize * 0.024));
  const specH = Math.round(tileSize * 0.31); // +60% taller spectrogram
  const unitH = tileSize + specGap + specH;

  const stripW = STAGE_SLOT_COUNT * tileSize + (STAGE_SLOT_COUNT - 1) * slotGap;
  const stripLeft = Math.round((W - stripW) / 2);

  const dotsGapY = Math.max(10, Math.round(tileSize * 0.046));
  const dotsBandH = Math.round(H * 0.032);
  const totalBlockH = unitH + dotsGapY + dotsBandH;
  const stageTop = Math.round((H - totalBlockH) / 2);
  const specTop = stageTop + tileSize + specGap;
  const dotsCenterY = specTop + specH + dotsGapY + Math.round(dotsBandH / 2);

  // Pre-compute 80 dot X positions along stripW (with tonal-start pause before MIDI 36)
  const tonalPausePx = Math.round(stripW * 0.012);
  const usableDotsW = stripW - tonalPausePx;
  const totalSlots = MAX_MIDI - MIN_MIDI + 1; // 80
  const slotPitch = usableDotsW / totalSlots;
  const restingRadius = Math.max(3.2, slotPitch * 0.37); // ~74% diameter => 2.05x blooms boldly!

  const dotMeta = [];
  for (let midi = MIN_MIDI; midi <= MAX_MIDI; midi++) {
    const idx = midi - MIN_MIDI;
    const extraX = midi >= 36 ? tonalPausePx : 0;
    const cx = stripLeft + extraX + (idx + 0.5) * slotPitch;
    const entry = keyMap[midi];
    const candCount = entry?.candidateCount || 0;
    const enabledCount = entry?.enabledCount || 0;
    const isOctaveStart = midi % 12 === 0;
    dotMeta.push({
      midi,
      cx,
      cy: dotsCenterY,
      rgb: getNoteRgb(midi),
      enabledCount,
      candCount,
      isOctaveStart
    });
  }

  // Step 2: Sample-accurate 48kHz offline audio mix
  report('Synthesizing sample-accurate 48kHz audio', 10);
  const totalAudioSamples = Math.ceil(renderDurationSec * AUDIO_SR);
  const mixBuffer = new Float32Array(totalAudioSamples);

  for (const v of voices) {
    const srcPcm = getSlicePcm(v.cand);
    const iStart = Math.max(0, Math.floor(v.startSec * AUDIO_SR));
    const iEnd = Math.min(totalAudioSamples, Math.ceil(v.endSec * AUDIO_SR));
    const baseSrcIdx = v.trimIn * AUDIO_SR;
    const maxSrcIdx = Math.min(srcPcm.length - 2, (v.trimIn + v.bufferPlaySpan) * AUDIO_SR);

    for (let i = iStart; i < iEnd; i++) {
      const t = i / AUDIO_SR;
      const elapsed = t - v.startSec;
      const srcPos = baseSrcIdx + elapsed * AUDIO_SR * v.playbackRate;
      if (srcPos < 0 || srcPos >= maxSrcIdx) break;
      const s0 = srcPos | 0;
      const frac = srcPos - s0;
      const sample = srcPcm[s0] * (1 - frac) + srcPcm[s0 + 1] * frac;
      mixBuffer[i] += sample * evalVoiceGain(v, t);
    }
  }

  applyBiquadHighpassInPlace(mixBuffer, AUDIO_SR, HIGHPASS_HZ);

  // Clean headroom protection (-0.8 dBFS ceiling if peak exceeds 0.91)
  let maxAbs = 0;
  for (let i = 0; i < mixBuffer.length; i++) {
    const a = Math.abs(mixBuffer[i]);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs > 0.91) {
    const scale = 0.91 / maxAbs;
    for (let i = 0; i < mixBuffer.length; i++) {
      mixBuffer[i] *= scale;
    }
  }

  const tmpWavPath = path.join(
    os.tmpdir(),
    `everytone_render_${process.pid}_${Date.now()}.wav`
  );
  writeWavMono16(tmpWavPath, mixBuffer, AUDIO_SR);

  // Step 3: Precompute spectrograms and LRU-decode slice video frames at exact tileSize
  report('Preparing spectrograms & film clips', 18);
  const specCache = new Map();
  for (const v of voices) {
    const specKey = `${v.cand.audioUrl}__${v.midi}__${v.playbackRate.toFixed(4)}__${v.trimIn.toFixed(2)}__${v.bufferPlaySpan.toFixed(2)}`;
    if (!specCache.has(specKey)) {
      const pcm = getSlicePcm(v.cand);
      specCache.set(
        specKey,
        buildMiniSpectrogramRgb(
          pcm,
          AUDIO_SR,
          tileSize,
          specH,
          v.playbackRate,
          v.trimIn,
          v.bufferPlaySpan,
          v.isPerc ? null : v.noteRgb
        )
      );
    }
    v.specKey = specKey;
  }

  const MAX_DECODED_VIDEOS_LRU = 48;
  const videoFramesLru = new Map();
  const frameByteLen = tileSize * tileSize * 3;

  function getDecodedVideoFrames(videoUrl) {
    if (videoFramesLru.has(videoUrl)) {
      const val = videoFramesLru.get(videoUrl);
      videoFramesLru.delete(videoUrl);
      videoFramesLru.set(videoUrl, val);
      return val;
    }
    const mp4Abs = path.join(ROOT_DIR, videoUrl.replace(/^\//, ''));
    const rawRgb = execFileSync(
      'ffmpeg',
      [
        '-v', 'error',
        '-i', mp4Abs,
        '-vf', `fps=${fps},scale=${tileSize}:${tileSize}:flags=lanczos`,
        '-pix_fmt', 'rgb24',
        '-f', 'rawvideo',
        'pipe:1'
      ],
      { maxBuffer: 128 * 1024 * 1024 }
    );
    const frameCount = Math.max(1, Math.floor(rawRgb.length / frameByteLen));
    const entry = { rawRgb, frameCount };
    videoFramesLru.set(videoUrl, entry);
    if (videoFramesLru.size > MAX_DECODED_VIDEOS_LRU) {
      const oldestKey = videoFramesLru.keys().next().value;
      videoFramesLru.delete(oldestKey);
    }
    return entry;
  }

  // Step 4: Spawn ffmpeg H.264 + AAC encoder and pipe exact RGB24 frames
  const totalFrames = Math.max(1, Math.ceil(renderDurationSec * fps));
  const bgBuf = Buffer.alloc(W * H * 3);
  for (let i = 0; i < bgBuf.length; i += 3) {
    bgBuf[i] = 3;
    bgBuf[i + 1] = 4;
    bgBuf[i + 2] = 6;
  }
  const frameBuf = Buffer.alloc(W * H * 3);

  const ffProc = spawn(
    'ffmpeg',
    [
      '-y',
      '-v', 'error',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgb24',
      '-s', `${W}x${H}`,
      '-r', String(fps),
      '-i', 'pipe:0',
      '-i', tmpWavPath,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '17',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '256k',
      '-shortest',
      '-movflags', '+faststart',
      finalOutPath
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] }
  );

  let ffStderr = '';
  ffProc.stderr.on('data', d => {
    ffStderr += d.toString();
  });

  // Index voices by slot for fast per-frame lookup
  const voicesBySlot = [[], [], []];
  const voicesByMidi = new Map();
  for (const v of voices) {
    voicesBySlot[v.slotIdx].push(v);
    if (!voicesByMidi.has(v.midi)) voicesByMidi.set(v.midi, []);
    voicesByMidi.get(v.midi).push(v);
  }

  const stripeHalfThickness = Math.max(0.85, H / 900);

  try {
    for (let f = 0; f < totalFrames; f++) {
      const t = f / fps;
      bgBuf.copy(frameBuf);

      // 1. Render up to 3 active square video slots + instant-pop spectrograms + fading f0 stripes
      for (let slotIdx = 0; slotIdx < STAGE_SLOT_COUNT; slotIdx++) {
        const list = voicesBySlot[slotIdx];
        let activeVoice = null;
        for (let k = list.length - 1; k >= 0; k--) {
          const candV = list[k];
          if (candV.startSec <= t && t < candV.visualEndSec) {
            activeVoice = candV;
            break;
          }
        }
        if (!activeVoice) continue;

        const slotLeft = stripLeft + slotIdx * (tileSize + slotGap);

        // Blit video frame (clamped to trimmed clip end so held notes freeze cleanly on the last frame)
        const vidData = getDecodedVideoFrames(activeVoice.cand.videoUrl);
        const maxClipTime = Math.max(activeVoice.trimIn, activeVoice.trimIn + activeVoice.bufferPlaySpan - 0.01);
        const clipTime = Math.min(
          maxClipTime,
          activeVoice.trimIn + (t - activeVoice.startSec) * activeVoice.playbackRate
        );
        const vidFrameIdx = Math.max(0, Math.min(vidData.frameCount - 1, Math.floor(clipTime * fps)));
        const srcVidBase = vidFrameIdx * frameByteLen;
        const rowBytes = tileSize * 3;
        for (let r = 0; r < tileSize; r++) {
          const srcRowStart = srcVidBase + r * rowBytes;
          const dstRowStart = ((stageTop + r) * W + slotLeft) * 3;
          vidData.rawRgb.copy(frameBuf, dstRowStart, srcRowStart, srcRowStart + rowBytes);
        }

        // Blit full-width static spectrogram (100% visible until hard-cut with video!)
        const specBuf = specCache.get(activeVoice.specKey);
        if (specBuf) {
          for (let r = 0; r < specH; r++) {
            const srcRowStart = r * rowBytes;
            const dstRowStart = ((specTop + r) * W + slotLeft) * 3;
            specBuf.copy(frameBuf, dstRowStart, srcRowStart, srcRowStart + rowBytes);
          }
        }

        if (activeVoice.isPerc) {
          // Percussive sound: no horizontal line; thin 50% opacity vertical white playhead synced to playback
          const elapsed = Math.max(0, t - activeVoice.startSec);
          const progress = Math.max(0, Math.min(1, elapsed / Math.max(0.05, activeVoice.naturalDur)));
          const xCenter = slotLeft + progress * (tileSize - 1);
          const cx0 = Math.max(slotLeft, Math.floor(xCenter - 1));
          const cx1 = Math.min(slotLeft + tileSize - 1, Math.ceil(xCenter + 1));
          const vertHalfThick = Math.max(0.6, W / 2000);

          for (let px = cx0; px <= cx1; px++) {
            const cov = Math.max(0, Math.min(1, vertHalfThick + 0.5 - Math.abs(px - xCenter)));
            const a = cov * 0.5;
            if (a <= 0.005) continue;
            for (let py = specTop; py < specTop + specH; py++) {
              const pixIdx = (py * W + px) * 3;
              frameBuf[pixIdx] = Math.round(frameBuf[pixIdx] * (1 - a) + 255 * a);
              frameBuf[pixIdx + 1] = Math.round(frameBuf[pixIdx + 1] * (1 - a) + 255 * a);
              frameBuf[pixIdx + 2] = Math.round(frameBuf[pixIdx + 2] * (1 - a) + 255 * a);
            }
          }
        } else {
          // Tonal sound: solid horizontal fundamental stripe at exact f0 Y, fading out during release
          const sAlpha = evalStripeAlpha(activeVoice, t);
          if (sAlpha > 0.005 && activeVoice.f0Hz >= SPEC_MIN_FREQ && activeVoice.f0Hz <= SPEC_MAX_FREQ) {
            const normY = (Math.log(activeVoice.f0Hz) - SPEC_LOG_MIN) / (SPEC_LOG_MAX - SPEC_LOG_MIN);
            const yF0Local = (1 - normY) * (specH - 1);
            const yCenter = specTop + yF0Local;
            const ry0 = Math.max(specTop, Math.floor(yCenter - stripeHalfThickness - 1));
            const ry1 = Math.min(specTop + specH - 1, Math.ceil(yCenter + stripeHalfThickness + 1));
            const [nr, ng, nb] = activeVoice.noteRgb;

            for (let py = ry0; py <= ry1; py++) {
              const cov = Math.max(0, Math.min(1, stripeHalfThickness + 0.5 - Math.abs(py - yCenter)));
              const a = cov * sAlpha;
              if (a <= 0.005) continue;
              let pixIdx = (py * W + slotLeft) * 3;
              for (let x = 0; x < tileSize; x++) {
                frameBuf[pixIdx] = Math.round(frameBuf[pixIdx] * (1 - a) + nr * a);
                frameBuf[pixIdx + 1] = Math.round(frameBuf[pixIdx + 1] * (1 - a) + ng * a);
                frameBuf[pixIdx + 2] = Math.round(frameBuf[pixIdx + 2] * (1 - a) + nb * a);
                pixIdx += 3;
              }
            }
          }
        }
      }

      // 2. Render centered floating row of 80 chromatic dots with 2.05x hit bloom & Screen blend
      for (let d = 0; d < dotMeta.length; d++) {
        const dm = dotMeta[d];
        if (dm.enabledCount > 0) {
          let scale = 1.0;
          const mVoices = voicesByMidi.get(dm.midi);
          if (mVoices) {
            for (let k = 0; k < mVoices.length; k++) {
              const mv = mVoices[k];
              if (t < mv.startSec || t >= mv.dotReleaseSec + 0.36) continue;
              let vScale = 1.0;
              if (t <= mv.dotReleaseSec) {
                const uAtk = Math.min(1, (t - mv.startSec) / 0.065);
                const easedAtk = 1 - Math.pow(1 - uAtk, 3);
                vScale = 1 + 1.05 * easedAtk;
              } else {
                const uRel = Math.min(1, (t - mv.dotReleaseSec) / 0.34);
                const easedRel = 1 - Math.pow(1 - uRel, 2.4);
                vScale = 2.05 - 1.05 * easedRel;
              }
              if (vScale > scale) scale = vScale;
            }
          }
          drawScreenCircleRgb(frameBuf, W, H, dm.cx, dm.cy, restingRadius * scale, dm.rgb, 1.0, 0);
        } else if (dm.candCount > 0) {
          drawScreenCircleRgb(frameBuf, W, H, dm.cx, dm.cy, restingRadius, dm.rgb, 0.52, Math.max(1.4, restingRadius * 0.32));
        } else {
          const emptyR = restingRadius * (dm.isOctaveStart ? 0.38 : 0.32);
          const emptyAlpha = dm.isOctaveStart ? 0.28 : 0.16;
          drawScreenCircleRgb(frameBuf, W, H, dm.cx, dm.cy, emptyR, [255, 255, 255], emptyAlpha, 0);
        }
      }

      if (!ffProc.stdin.write(frameBuf)) {
        await once(ffProc.stdin, 'drain');
      }

      if (f % 15 === 0 || f === totalFrames - 1) {
        const pct = 22 + ((f + 1) / totalFrames) * 76;
        report('Encoding 4:3 frames', pct, { frame: f + 1, totalFrames });
      }
    }

    ffProc.stdin.end();
    const [exitCode] = await once(ffProc, 'close');
    if (exitCode !== 0) {
      throw new Error(`ffmpeg exited with code ${exitCode}: ${ffStderr}`);
    }
  } finally {
    try {
      if (fs.existsSync(tmpWavPath)) fs.unlinkSync(tmpWavPath);
    } catch {}
  }

  report('Complete', 100, { frame: totalFrames, totalFrames });
  return {
    outPath: finalOutPath,
    fileName: path.basename(finalOutPath),
    durationSec: Number(renderDurationSec.toFixed(2)),
    totalFrames,
    width: W,
    height: H,
    fps
  };
}

// Direct CLI execution:
// node offline-render.mjs path/to/input.mid [--out renders/output.mp4] [--width 1440] [--height 1080] [--fps 30]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const midiArg = args.find(a => !a.startsWith('--'));
  if (!midiArg) {
    console.error('Usage: node offline-render.mjs <input.mid> [--out renders/out.mp4] [--width 1440] [--height 1080] [--fps 30]');
    process.exit(1);
  }
  const getFlag = (name, fallback) => {
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
  };
  const outFlag = getFlag('--out', null);
  const widthFlag = Number(getFlag('--width', 1440));
  const heightFlag = Number(getFlag('--height', 1080));
  const fpsFlag = Number(getFlag('--fps', 30));

  let lastLoggedPct = -5;
  renderMidiPerformanceToMp4({
    midiFilePath: path.resolve(midiArg),
    outPath: outFlag ? path.resolve(outFlag) : null,
    width: widthFlag,
    height: heightFlag,
    fps: fpsFlag,
    onProgress: ({ phase, percent }) => {
      if (percent >= lastLoggedPct + 10 || percent === 100) {
        lastLoggedPct = percent;
        console.log(`[${percent}%] ${phase}`);
      }
    }
  })
    .then(res => {
      console.log(`Saved 4:3 render -> ${res.outPath} (${res.width}x${res.height} @ ${res.fps}fps, ${res.durationSec}s)`);
    })
    .catch(err => {
      console.error('Render failed:', err);
      process.exit(1);
    });
}
