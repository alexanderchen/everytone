import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseMidiFile } from './public/midi-parser.mjs';
import {
  resolveTransposedMidiNote,
  evalFadeInCurve,
  evalVoiceGain,
  planMidiTimeline
} from './public/midi-timeline.mjs';
import { computeKeyboardMap, inferVideoGroupName } from './dsp-pipeline.mjs';

const execFileAsync = promisify(execFile);

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.join(ROOT_DIR, 'catalog.json');
const ATLAS_IMG_PATH = path.join(ROOT_DIR, 'public', 'stage-atlas.jpg');
const ATLAS_JSON_PATH = path.join(ROOT_DIR, 'public', 'stage-atlas.json');
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
const PERC_TRIGGER_HEX = '#8a8a8a';

const STAGE_GRID_SPECS = {
  '3x1': { cols: 3, rows: 1, slots: 3 },
  '2x2': { cols: 2, rows: 2, slots: 4 },
  '3x2': { cols: 3, rows: 2, slots: 6 },
  '4x2': { cols: 4, rows: 2, slots: 8 },
  '3x3': { cols: 3, rows: 3, slots: 9 }
};

const MIN_MIDI = 24;
const MAX_MIDI = 103;
const MAX_CLIP_DUR = 2.50;
const RELEASE_SEC = 0.40;
const HIGHPASS_HZ = 80;
const AUDIO_SR = 48000;

// Cropped low-rumble (< 130 Hz) + Mel-like perceptual frequency warp matching public/app.js
const SPEC_MIN_FREQ = 130;
const MINI_SPEC_MAX_FREQ = 2800;
const SPEC_WARP_HZ = 160;
const SPEC_WARP_MIN = Math.log(1 + SPEC_MIN_FREQ / SPEC_WARP_HZ);
const MINI_WARP_MAX = Math.log(1 + MINI_SPEC_MAX_FREQ / SPEC_WARP_HZ);

const FFT_SIZE = 2048;
const HANN_WIN = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  HANN_WIN[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
}

function hexToRgb(hex) {
  const clean = String(hex || PERC_TRIGGER_HEX).replace('#', '');
  const n = parseInt(clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function getNoteRgb(midi, forcePerc = false) {
  if (forcePerc || midi < 36) return hexToRgb(PERC_TRIGGER_HEX);
  const pc = ((midi % 12) + 12) % 12;
  return hexToRgb(CHROMATIC_HEX[pc]);
}

function normalizeGridMode(raw) {
  const key = String(raw || '3x2').toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(STAGE_GRID_SPECS, key) ? key : '3x2';
}

function clampFadeInSec(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0.001) return 0.0;
  return Math.max(0.0, Math.min(1.00, Math.round(n * 100) / 100));
}

function clampFadeOutSec(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.20;
  if (n <= 0.001) return 0.0;
  return Math.max(0.0, Math.min(2.00, Math.round(n * 100) / 100));
}

function clampMaxDisplaySec(raw) {
  if (raw === null || raw === undefined || raw === false || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(0.50, Math.min(2.00, Math.round(n * 100) / 100));
}

function clampTileScale(raw) {
  let n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1.0;
  if (n > 10) n = n / 100;
  return Math.max(1.0, Math.min(2.5, Math.round(n * 20) / 20));
}

function clampSpecScale(raw) {
  let n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1.0;
  if (n > 10) n = n / 100;
  return Math.max(0.75, Math.min(4.5, Math.round(n * 20) / 20));
}

function getStageSpecRatio(rows, rawSpecScale = 1.0) {
  const baseRatio = rows >= 3 ? 0.13 : 0.145;
  const scale = clampSpecScale(rawSpecScale);
  if (scale <= 1.0) return baseRatio * scale;
  const t = (scale - 1.0) / (4.5 - 1.0);
  return baseRatio + t * (0.66 - baseRatio);
}

function getStageSpecKeylineWidth(rawSpecScale = 1.0) {
  const scale = clampSpecScale(rawSpecScale);
  if (scale <= 1.0) return 1.0;
  const t = Math.min(1, (scale - 1.0) / (4.5 - 1.0));
  return 1.0 + t * 1.0;
}

function miniSpecFreqToNormY(freq) {
  const f = Math.max(SPEC_MIN_FREQ, Math.min(MINI_SPEC_MAX_FREQ, freq));
  return (Math.log(1 + f / SPEC_WARP_HZ) - SPEC_WARP_MIN) / (MINI_WARP_MAX - SPEC_WARP_MIN);
}

function miniSpecNormYToFreq(normY) {
  const u = Math.max(0, Math.min(1, normY));
  return SPEC_WARP_HZ * (Math.exp(SPEC_WARP_MIN + u * (MINI_WARP_MAX - SPEC_WARP_MIN)) - 1);
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
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

function computeSpecDbBounds(colMags, minBin, maxBin, globalMaxDb, baseRangeDb) {
  const BINS = 128;
  const span = 72;
  const histMin = globalMaxDb - span;
  const counts = new Uint32Array(BINS);
  let total = 0;
  for (let x = 0; x < colMags.length; x++) {
    const dbArr = colMags[x];
    for (let k = minBin; k <= maxBin; k++) {
      const idx = Math.max(
        0,
        Math.min(BINS - 1, Math.floor(((dbArr[k] - histMin) / span) * (BINS - 1)))
      );
      counts[idx]++;
      total++;
    }
  }
  if (total === 0) {
    return { ceilDb: globalMaxDb, floorDb: globalMaxDb - baseRangeDb };
  }
  const medianTarget = total * 0.55;
  const p99Target = total * 0.992;
  let acc = 0;
  let medianDb = histMin;
  let p99Db = globalMaxDb;
  let foundMedian = false;
  for (let i = 0; i < BINS; i++) {
    acc += counts[i];
    if (!foundMedian && acc >= medianTarget) {
      medianDb = histMin + (i / (BINS - 1)) * span;
      foundMedian = true;
    }
    if (acc >= p99Target) {
      p99Db = histMin + (i / (BINS - 1)) * span;
      break;
    }
  }
  const headroomTrim = Math.min(8.5, Math.max(0, globalMaxDb - p99Db));
  const ceilDb = globalMaxDb - 0.5 * headroomTrim;
  const rawFloor = ceilDb - baseRangeDb;
  const noiseGuardFloor = medianDb + 5.0;
  const floorDb = Math.min(ceilDb - 18, Math.max(rawFloor, 0.5 * (noiseGuardFloor + rawFloor)));
  return { ceilDb, floorDb };
}

export function grayScreenSpecValue(norm) {
  const t = Math.max(0, Math.min(1, norm));
  if (t <= 0.035) return 0;
  const u = (t - 0.035) / 0.965;
  const toe = Math.min(1, u / 0.04);
  const curved = Math.max(0, Math.min(1, Math.pow(u, 0.865) * toe));
  return Math.max(0, Math.min(255, Math.round(curved * 243)));
}

function buildMiniSpectrogramRgb(samples, sr, targetW, targetH, playbackRate, trimIn, bufferSpanSec) {
  const bmpW = 256;
  const bmpH = 256;
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
  const minBin = Math.max(1, Math.floor((SPEC_MIN_FREQ * FFT_SIZE) / effectiveSr));
  const maxBin = Math.min(half - 1, Math.ceil((MINI_SPEC_MAX_FREQ * FFT_SIZE) / effectiveSr));
  const colMags = new Array(bmpW);
  let globalMaxDb = -90;

  for (let x = 0; x < bmpW; x++) {
    const startSample = s0 + Math.floor((x / bmpW) * usableSpan);
    for (let i = 0; i < FFT_SIZE; i++) {
      real[i] = (samples[startSample + i] || 0) * HANN_WIN[i];
      imag[i] = 0;
    }
    fftInPlace(real, imag);
    const dbArr = new Float32Array(half);
    for (let k = 1; k < half; k++) {
      const db = 20 * Math.log10(Math.hypot(real[k], imag[k]) + 1e-7);
      dbArr[k] = db;
      if (k >= minBin && k <= maxBin && db > globalMaxDb) {
        globalMaxDb = db;
      }
    }
    colMags[x] = dbArr;
  }

  const { ceilDb, floorDb } = computeSpecDbBounds(colMags, minBin, maxBin, globalMaxDb, 44);
  const denom = Math.max(1e-5, ceilDb - floorDb);
  const grayBmp = new Float32Array(bmpW * bmpH);

  for (let x = 0; x < bmpW; x++) {
    const dbArr = colMags[x];
    for (let y = 0; y < bmpH; y++) {
      const normY = 1 - y / (bmpH - 1);
      const freq = miniSpecNormYToFreq(normY);
      const exactBin = (freq * FFT_SIZE) / effectiveSr;
      const b0 = Math.max(1, Math.min(half - 2, Math.floor(exactBin)));
      const frac = exactBin - b0;
      const db = dbArr[b0] * (1 - frac) + dbArr[b0 + 1] * frac;
      const norm = (db - floorDb) / denom;
      grayBmp[y * bmpW + x] = grayScreenSpecValue(norm);
    }
  }

  // Bilinearly resample 256x104 neutral grayscale spectrogram to targetW x targetH
  const rgbBuf = Buffer.alloc(targetW * targetH * 3);
  for (let y = 0; y < targetH; y++) {
    const sy = (y / Math.max(1, targetH - 1)) * (bmpH - 1);
    const y0 = Math.min(bmpH - 1, Math.floor(sy));
    const y1 = Math.min(bmpH - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < targetW; x++) {
      const sx = (x / Math.max(1, targetW - 1)) * (bmpW - 1);
      const x0 = Math.min(bmpW - 1, Math.floor(sx));
      const x1 = Math.min(bmpW - 1, x0 + 1);
      const fx = sx - x0;

      const v00 = grayBmp[y0 * bmpW + x0];
      const v10 = grayBmp[y0 * bmpW + x1];
      const v01 = grayBmp[y1 * bmpW + x0];
      const v11 = grayBmp[y1 * bmpW + x1];
      const top = v00 * (1 - fx) + v10 * fx;
      const bot = v01 * (1 - fx) + v11 * fx;
      const gray = Math.max(0, Math.min(255, Math.round(top * (1 - fy) + bot * fy)));

      const off = (y * targetW + x) * 3;
      rgbBuf[off] = gray;
      rgbBuf[off + 1] = gray;
      rgbBuf[off + 2] = gray;
    }
  }
  return rgbBuf;
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

function evalSlotVisualAlpha(voice, t, fadeInSec, fadeOutSec) {
  if (t < voice.startSec || t >= voice.visualEndSec) return 0;
  if (voice.fadeStartSec === null || t <= voice.fadeStartSec) {
    return evalFadeInCurve(t - voice.startSec, fadeInSec);
  }
  if (fadeOutSec <= 0.002) return 0;
  const startOutAlpha = evalFadeInCurve(Math.max(0, voice.fadeStartSec - voice.startSec), fadeInSec);
  if (startOutAlpha <= 0.003) return 0;
  const effOutDur = Math.max(0.05, fadeOutSec * Math.sqrt(startOutAlpha));
  const u = Math.max(0, Math.min(1, (t - voice.fadeStartSec) / effOutDur));
  return startOutAlpha * Math.pow(1 - u, 1.5);
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

// Feed-forward soft-knee dynamics compressor matching Web Audio DynamicsCompressorNode
// (threshold = -16 dB, knee = 12 dB, ratio = 3.5, attack = 0.005s, release = 0.18s)
function applySoftCompressorInPlace(
  samples,
  sr,
  { thresholdDb = -16, kneeDb = 12, ratio = 3.5, attackSec = 0.005, releaseSec = 0.18 } = {}
) {
  const atkCoef = Math.exp(-1 / Math.max(1, sr * attackSec));
  const relCoef = Math.exp(-1 / Math.max(1, sr * releaseSec));
  const halfKnee = kneeDb * 0.5;
  const slope = 1 - 1 / ratio;
  let envLin = 0;

  for (let i = 0; i < samples.length; i++) {
    const absIn = Math.abs(samples[i]);
    if (absIn > envLin) {
      envLin = atkCoef * envLin + (1 - atkCoef) * absIn;
    } else {
      envLin = relCoef * envLin + (1 - relCoef) * absIn;
    }

    if (envLin <= 1e-6) continue;
    const envDb = 20 * Math.log10(envLin);
    const overDb = envDb - thresholdDb;

    let gainReductionDb = 0;
    if (overDb > -halfKnee) {
      if (overDb < halfKnee) {
        const x = overDb + halfKnee;
        gainReductionDb = slope * ((x * x) / (2 * kneeDb));
      } else {
        gainReductionDb = slope * overDb;
      }
    }
    if (gainReductionDb > 0.001) {
      samples[i] *= Math.pow(10, -gainReductionDb / 20);
    }
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

async function runPool(items, concurrency, workerFn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await workerFn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

// Build ordered micro-thumbnail mosaic items matching rebuildItemsFromCatalog in public/three-stage.mjs
function buildMosaicItems(catalog, atlasManifest, keyMap, disabledVideoIds) {
  if (!atlasManifest?.items?.length) return [];
  const atlasBySliceId = new Map();
  for (const it of atlasManifest.items) {
    atlasBySliceId.set(it.sliceId, it);
  }

  const assignedBySliceId = new Map();
  for (const [midiStr, entry] of Object.entries(keyMap || {})) {
    const m = Number(midiStr);
    for (const c of entry?.candidates || []) {
      if (c?.sliceId) {
        assignedBySliceId.set(c.sliceId, {
          midi: Number.isFinite(m) ? m : Number(c.midi ?? 60),
          isPerc: m < 36 || Boolean(c.isPerc)
        });
      }
    }
  }

  const activeVideos = (catalog.videos || [])
    .filter(v => !v.deleted && !disabledVideoIds.has(v.id))
    .slice()
    .sort((a, b) => (a.index || 0) - (b.index || 0));

  const out = [];
  for (const v of activeVideos) {
    const slices = (v.slices || [])
      .filter(s => !s.deleted)
      .slice()
      .sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0) || (a.hitIndex ?? 0) - (b.hitIndex ?? 0));

    for (const s of slices) {
      const uvEntry = atlasBySliceId.get(s.id);
      if (!uvEntry) continue;
      const assigned = assignedBySliceId.get(s.id);
      const midi = assigned
        ? assigned.midi
        : Number.isFinite(s.manualMidi)
          ? Number(s.manualMidi)
          : Number(s.midi ?? uvEntry.midi ?? 60);
      const isPerc = assigned
        ? assigned.isPerc
        : v.category === 'percussion' || midi < 36;

      out.push({
        ...uvEntry,
        sliceId: s.id,
        videoId: v.id,
        midi,
        isPerc,
        borderRgb: getNoteRgb(midi, isPerc)
      });
    }
  }
  return out;
}

function solveMosaicFlushScaled(targetW, availH, tileCount, desiredCellPx, mosaicGap, minCellPx) {
  if (tileCount <= 0) return { cols: 1, rows: 0, cell: desiredCellPx, gridW: 0, gridH: 0 };
  if (tileCount <= 3 && tileCount * desiredCellPx + (tileCount - 1) * mosaicGap <= targetW) {
    const cell = Math.min(desiredCellPx, availH);
    return {
      cols: tileCount,
      rows: 1,
      cell,
      gridW: tileCount * cell + (tileCount - 1) * mosaicGap,
      gridH: cell
    };
  }
  const maxCellPx = Math.max(desiredCellPx * 1.35, minCellPx * 3.1);
  const minCols = Math.max(1, Math.min(tileCount, Math.ceil((targetW + mosaicGap) / (maxCellPx + mosaicGap))));
  const maxCols = Math.min(
    tileCount,
    Math.max(minCols, Math.floor((targetW + mosaicGap) / (minCellPx + mosaicGap)))
  );

  let bestCols = maxCols;
  let bestScore = -1e9;
  let foundFitting = false;
  for (let mCols = minCols; mCols <= maxCols; mCols++) {
    const mRows = Math.ceil(tileCount / mCols);
    const cellByW = (targetW - (mCols - 1) * mosaicGap) / mCols;
    if (cellByW < minCellPx - 0.01) continue;
    const neededH = mRows * cellByW + (mRows - 1) * mosaicGap;
    if (neededH > availH + 0.5) continue;

    foundFitting = true;
    const lastRowCount = tileCount - (mRows - 1) * mCols;
    const lastRowFill = lastRowCount / mCols;
    const orphanPenalty = mRows > 1 && lastRowFill < 0.25 ? (0.25 - lastRowFill) * 22 : 0;
    const sizeCloseness =
      1.0 -
      Math.min(1.0, Math.abs(cellByW - desiredCellPx) / Math.max(minCellPx * 0.9, desiredCellPx * 0.6));
    const score = sizeCloseness * 38 + lastRowFill * 9 - orphanPenalty;
    if (score > bestScore) {
      bestScore = score;
      bestCols = mCols;
    }
  }
  if (!foundFitting) bestCols = maxCols;
  const bestCell = (targetW - (bestCols - 1) * mosaicGap) / bestCols;
  const mRows = Math.ceil(tileCount / bestCols);
  return {
    cols: bestCols,
    rows: mRows,
    cell: bestCell,
    gridW: bestCols * bestCell + (bestCols - 1) * mosaicGap,
    gridH: mRows * bestCell + (mRows - 1) * mosaicGap
  };
}

// Exact stage + flush micro-thumbnail layout solver matching updateStageTileSizes() + three-stage.mjs
function computeStageGeometry(W, H, gridSpec, tileCount, rawTileScale = 1.0, rawSpecScale = 1.0) {
  const uiScale = H / 1080;
  const tileScale = clampTileScale(rawTileScale);
  const { cols, rows } = gridSpec;

  const baseColGap = W < 920 * uiScale ? 12 : rows >= 3 ? 14 : rows === 2 ? 16 : 20;
  const colGap = Math.max(4, Math.round(baseColGap * uiScale));
  const rowGap = rows > 1 ? Math.max(4, Math.round((rows >= 3 ? 8 : 10) * uiScale)) : 0;
  const specRatio = getStageSpecRatio(rows, rawSpecScale);

  const marginY = Math.max(Math.round(12 * uiScale), Math.round(H * (rows >= 3 ? 0.024 : 0.034)));
  const betweenGap =
    tileCount > 0
      ? Math.max(Math.round(12 * uiScale), Math.round(H * (rows >= 3 ? 0.014 : 0.020)))
      : 0;
  const baseReserveH =
    tileCount > 0
      ? Math.round((rows >= 3 ? 54 : rows === 2 ? 64 : 76) * uiScale)
      : 0;

  const baseAvailTopH = Math.max(
    Math.round(140 * uiScale),
    H - marginY * 2 - betweenGap - baseReserveH - (rows - 1) * rowGap
  );
  const baseMaxSideByH = Math.floor(baseAvailTopH / (rows * (1 + specRatio)));

  const padX = Math.max(Math.round(32 * uiScale), Math.round(W * 0.065));
  const availW = Math.max(Math.round(200 * uiScale), W - padX * 2 - colGap * (cols - 1));
  const maxCap = Math.round((rows === 1 ? 388 : cols >= 4 ? 304 : rows === 2 ? 348 : 284) * uiScale);
  const baseRawSide = Math.max(
    Math.round(68 * uiScale),
    Math.min(maxCap, Math.floor(Math.min(baseMaxSideByH, availW / cols)))
  );
  const baseTileSize = Math.max(32, Math.floor(baseRawSide / 2) * 2); // Even px for crisp video scaling
  const baseStripW = baseTileSize * cols + colGap * (cols - 1);
  const baseCell100 = Math.min(12.0 * uiScale, Math.max(7.5 * uiScale, baseStripW / 76));
  const desiredCellPx = baseCell100 * tileScale;

  const mosaicGap = Math.max(1, Math.round(1 * uiScale));
  const minCellPx = 4.5 * uiScale;

  let tileSize = baseTileSize;
  if (tileCount > 0 && tileScale > 1.01) {
    const minAllowedSide = Math.max(
      32,
      Math.floor(Math.max(Math.round(68 * uiScale), Math.round(baseTileSize * 0.68)) / 2) * 2
    );
    let bestAchievedCell = -1;
    for (let s = baseTileSize; s >= minAllowedSide; s -= 2) {
      const candSpecH = Math.max(Math.round(14 * uiScale), Math.round(s * specRatio));
      const candStripW = s * cols + colGap * (cols - 1);
      const candTopH = rows * (s + candSpecH) + (rows - 1) * rowGap;
      const availMosaicH = H - marginY * 2 - betweenGap - candTopH;
      if (availMosaicH < Math.round(32 * uiScale)) continue;
      const m = solveMosaicFlushScaled(
        candStripW,
        availMosaicH,
        tileCount,
        desiredCellPx,
        mosaicGap,
        minCellPx
      );
      const effectiveGain = Math.min(m.cell, desiredCellPx);
      if (effectiveGain > bestAchievedCell + 0.08 * uiScale) {
        bestAchievedCell = effectiveGain;
        tileSize = s;
      }
      if (m.cell >= desiredCellPx * 0.96) break;
    }
  }

  const specH = Math.max(Math.round(14 * uiScale), Math.round(tileSize * specRatio));
  const stripW = tileSize * cols + colGap * (cols - 1);
  const topStripH = rows * (tileSize + specH) + (rows - 1) * rowGap;
  const stripLeft = Math.round((W - stripW) / 2);

  // Micro-thumbnail mosaic solver (1px gap, edge-to-edge flush with stripW)
  if (tileCount === 0) {
    const stackTopY = Math.max(marginY, Math.round((H - topStripH) * 0.5));
    return {
      uiScale,
      cols,
      rows,
      tileSize,
      specH,
      colGap,
      rowGap,
      stripW,
      stripLeft,
      topStripH,
      stackTopY,
      mosaic: { cols: 1, rows: 0, cell: 12 * uiScale, gap: mosaicGap, originX: stripLeft, originY: stackTopY + topStripH }
    };
  }

  const targetW = stripW;
  const availH = Math.max(Math.round(32 * uiScale), H - topStripH - betweenGap - marginY * 2);
  const solved = solveMosaicFlushScaled(
    targetW,
    availH,
    tileCount,
    desiredCellPx,
    mosaicGap,
    minCellPx
  );
  const bestCols = solved.cols;
  const bestCell = solved.cell;
  const mRows = solved.rows;
  const gridW = solved.gridW;
  const gridH = solved.gridH;
  const totalStackH = topStripH + betweenGap + gridH;
  const stackTopY = Math.max(Math.round(10 * uiScale), Math.round((H - totalStackH) * 0.5));
  const originX = (W - gridW) * 0.5;
  const originY = stackTopY + topStripH + betweenGap;

  return {
    uiScale,
    cols,
    rows,
    tileSize,
    specH,
    colGap,
    rowGap,
    stripW,
    stripLeft,
    topStripH,
    stackTopY,
    mosaic: {
      cols: bestCols,
      rows: mRows,
      cell: bestCell,
      gap: mosaicGap,
      gridW,
      gridH,
      originX,
      originY
    }
  };
}

// Pre-bake analytical subpixel patches for all mosaic tiles + stamp idle B&W mosaic onto bgBuf
function prepareMosaicRasterPatches(W, H, bgBuf, mosaicItems, mosaicLayout, atlasRgb, atlasW, atlasH, uiScale) {
  const patches = [];
  if (!mosaicItems.length || !atlasRgb) return patches;

  const { cols, cell, gap, originX, originY } = mosaicLayout;
  const stride = cell + gap;

  function sampleAtlasArea(u0, v0, u1, v1, relX0, relY0, relX1, relY1) {
    const ax0 = Math.max(0, Math.min(atlasW - 1, (u0 + (u1 - u0) * relX0) * atlasW));
    const ax1 = Math.max(ax0 + 0.5, Math.min(atlasW, (u0 + (u1 - u0) * relX1) * atlasW));
    const ay0 = Math.max(0, Math.min(atlasH - 1, (v0 + (v1 - v0) * relY0) * atlasH));
    const ay1 = Math.max(ay0 + 0.5, Math.min(atlasH, (v0 + (v1 - v0) * relY1) * atlasH));

    const ix0 = Math.floor(ax0);
    const ix1 = Math.min(atlasW - 1, Math.floor(ax1));
    const iy0 = Math.floor(ay0);
    const iy1 = Math.min(atlasH - 1, Math.floor(ay1));

    let sr = 0, sg = 0, sb = 0, count = 0;
    for (let ay = iy0; ay <= iy1; ay++) {
      const rowBase = ay * atlasW * 3;
      for (let ax = ix0; ax <= ix1; ax++) {
        const off = rowBase + ax * 3;
        sr += atlasRgb[off];
        sg += atlasRgb[off + 1];
        sb += atlasRgb[off + 2];
        count++;
      }
    }
    if (count === 0) return [0, 0, 0];
    return [sr / (count * 255), sg / (count * 255), sb / (count * 255)];
  }

  for (let i = 0; i < mosaicItems.length; i++) {
    const it = mosaicItems[i];
    const col = i % cols;
    const row = (i / cols) | 0;
    const x0 = originX + col * stride;
    const y0 = originY + row * stride;
    const x1 = x0 + cell;
    const y1 = y0 + cell;

    const px0 = Math.max(0, Math.floor(x0));
    const px1 = Math.min(W - 1, Math.ceil(x1) - 1);
    const py0 = Math.max(0, Math.floor(y0));
    const py1 = Math.min(H - 1, Math.ceil(y1) - 1);

    const pw = Math.max(0, px1 - px0 + 1);
    const ph = Math.max(0, py1 - py0 + 1);
    const idleRgb = new Uint8Array(pw * ph * 3);
    const activeRgb = new Uint8Array(pw * ph * 3);

    for (let py = py0; py <= py1; py++) {
      const covY = Math.max(0, Math.min(py + 1, y1) - Math.max(py, y0));
      const relY0 = Math.max(0, Math.min(1, (Math.max(py, y0) - y0) / cell));
      const relY1 = Math.max(relY0 + 0.02, Math.min(1, (Math.min(py + 1, y1) - y0) / cell));

      for (let px = px0; px <= px1; px++) {
        const covX = Math.max(0, Math.min(px + 1, x1) - Math.max(px, x0));
        const cov = covX * covY;
        if (cov <= 0.001) continue;

        const relX0 = Math.max(0, Math.min(1, (Math.max(px, x0) - x0) / cell));
        const relX1 = Math.max(relX0 + 0.02, Math.min(1, (Math.min(px + 1, x1) - x0) / cell));
        const [tr, tg, tb] = sampleAtlasArea(it.u0, it.v0, it.u1, it.v1, relX0, relY0, relX1, relY1);

        // Match TILE_FRAG_SHADER in public/three-stage.mjs:
        // Idle: crisp B&W at 42% opacity; Active max: chromatic hex at 85% opacity over idle square
        const luma = 0.299 * tr + 0.587 * tg + 0.114 * tb;
        const crispLuma = Math.min(1, Math.pow(Math.max(0, luma), 0.88) * 1.08);
        const idleInside = crispLuma * 0.42 * 255;
        const idleVal = Math.round(idleInside * cov);

        const [nr, ng, nb] = it.borderRgb;
        const actR = Math.round((idleInside * 0.15 + nr * 0.85) * cov);
        const actG = Math.round((idleInside * 0.15 + ng * 0.85) * cov);
        const actB = Math.round((idleInside * 0.15 + nb * 0.85) * cov);

        const pOff = ((py - py0) * pw + (px - px0)) * 3;
        idleRgb[pOff] = idleVal;
        idleRgb[pOff + 1] = idleVal;
        idleRgb[pOff + 2] = idleVal;

        activeRgb[pOff] = actR;
        activeRgb[pOff + 1] = actG;
        activeRgb[pOff + 2] = actB;

        // Stamp idle monochrome B&W pixel into bgBuf once
        const bgOff = (py * W + px) * 3;
        bgBuf[bgOff] = Math.min(255, bgBuf[bgOff] + idleVal);
        bgBuf[bgOff + 1] = Math.min(255, bgBuf[bgOff + 1] + idleVal);
        bgBuf[bgOff + 2] = Math.min(255, bgBuf[bgOff + 2] + idleVal);
      }
    }

    patches.push({
      sliceId: it.sliceId,
      px0,
      py0,
      pw,
      ph,
      idleRgb,
      activeRgb
    });
  }

  return patches;
}

export async function renderMidiPerformanceToMp4({
  midiBytes,
  midiFilePath = null,
  outPath = null,
  width = 1440,
  height = 1080,
  fps = 30,
  gridMode = null,
  tileScale = null,
  specScale = null,
  fadeInSec = null,
  fadeOutSec = null,
  maxDisplaySec = undefined,
  transposeOctaves = undefined,
  disabledVideoIds: customDisabledVideoIds = null,
  videoGains: customVideoGains = null,
  onProgress = null
}) {
  const report = (phase, percent, extra = {}) => {
    if (typeof onProgress === 'function') {
      onProgress({ phase, percent: Math.round(percent), ...extra });
    }
  };

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const savedStageCfg = catalog.stageConfig || {};

  const W = Math.max(320, Math.round(width / 2) * 2);
  const H = Math.max(240, Math.round(height / 2) * 2);
  const normGridMode = normalizeGridMode(gridMode || savedStageCfg.stageGridMode || '3x2');
  const gridSpec = STAGE_GRID_SPECS[normGridMode];
  const stageSlotCount = gridSpec.slots;
  const effTileScale = clampTileScale(tileScale ?? savedStageCfg.stageTileScale ?? 1.0);
  const effSpecScale = clampSpecScale(specScale ?? savedStageCfg.stageSpecScale ?? 1.0);
  const effFadeInSec = clampFadeInSec(fadeInSec ?? savedStageCfg.stageFadeInSec ?? 0.0);
  const effFadeOutSec = clampFadeOutSec(fadeOutSec ?? savedStageCfg.stageFadeSec ?? 0.20);
  const resolvedMaxDisplayRaw =
    maxDisplaySec !== undefined
      ? maxDisplaySec
      : savedStageCfg.stageMaxDisplayEnabled
        ? savedStageCfg.stageMaxDisplaySec
        : null;
  const effMaxDisplaySec = clampMaxDisplaySec(resolvedMaxDisplayRaw);
  const effTransposeOctaves = Math.round(
    Number(transposeOctaves !== undefined ? transposeOctaves : savedStageCfg.midiTransposeOctaves ?? 0) || 0
  );

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
      `render_${normGridMode}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.mp4`
    );

  report(`Simulating MIDI performance (${normGridMode} grid)`, 2);

  const disabledVideoIds = new Set(
    (catalog.videos || []).filter(v => v.enabled === false).map(v => v.id)
  );
  if (Array.isArray(customDisabledVideoIds)) {
    for (const id of customDisabledVideoIds) disabledVideoIds.add(String(id));
  }

  const videoGainDbById = new Map(
    (catalog.videos || []).map(v => [v.id, Number.isFinite(v.gainDb) ? Math.round(v.gainDb) : 0])
  );
  if (customVideoGains && typeof customVideoGains === 'object') {
    for (const [vid, db] of Object.entries(customVideoGains)) {
      if (Number.isFinite(Number(db))) {
        videoGainDbById.set(vid, Math.max(-12, Math.min(12, Math.round(Number(db)))));
      }
    }
  }

  const keyMap = computeKeyboardMap(catalog.videos, catalog.keyboardConfig || {});
  const groupKeyByVideoId = new Map(
    (catalog.videos || []).map(v => {
      const cat = String(v.category || 'other').toLowerCase();
      const gName = String(v.groupName || inferVideoGroupName(v) || v.slug || 'sample')
        .trim()
        .toLowerCase();
      return [v.id, `${cat}::${gName}`];
    })
  );

  // Shared deterministic timeline simulation (100% identical to browser playback & scrubbing)
  const { voices: rawPlannedVoices } = planMidiTimeline({
    parsed,
    keyboardMap: keyMap,
    isVideoDisabled: videoId => disabledVideoIds.has(videoId),
    getGroupKey: cand => groupKeyByVideoId.get(cand.videoId) || '',
    getVideoGainDb: videoId => videoGainDbById.get(videoId) || 0,
    stageSlotCount,
    fadeInSec: effFadeInSec,
    fadeOutSec: effFadeOutSec,
    maxDisplaySec: effMaxDisplaySec,
    transposeOctaves: effTransposeOctaves,
    releaseSec: RELEASE_SEC
  });

  // Decode only the exact audio WAVs triggered by the deterministic timeline
  const neededAudioUrls = new Set();
  for (const v of rawPlannedVoices) {
    if (v.cand?.audioUrl) neededAudioUrls.add(v.cand.audioUrl);
  }

  const pcmCache = new Map();
  await runPool(Array.from(neededAudioUrls), 8, async audioUrl => {
    const wavAbs = path.join(ROOT_DIR, audioUrl.replace(/^\//, ''));
    const { stdout } = await execFileAsync(
      'ffmpeg',
      ['-v', 'error', '-i', wavAbs, '-ac', '1', '-ar', String(AUDIO_SR), '-f', 'f32le', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }
    );
    const aligned = Buffer.allocUnsafe(stdout.length);
    stdout.copy(aligned);
    const floats = new Float32Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.byteLength / 4));
    pcmCache.set(audioUrl, floats);
  });

  function getSlicePcm(cand) {
    return pcmCache.get(cand.audioUrl);
  }

  const voices = [];
  for (const v of rawPlannedVoices) {
    const pcm = getSlicePcm(v.cand);
    if (!pcm) continue;
    const bufDur = pcm.length / AUDIO_SR;
    v.bufferPlaySpan = Math.max(
      0.04,
      Math.min(bufDur - v.trimIn, v.naturalDur * v.playbackRate)
    );
    v.noteRgb = getNoteRgb(v.midi, v.isPerc);
    voices.push(v);
  }

  let renderDurationSec = parsed.durationSec + Math.max(0.6, effFadeOutSec + 0.35);
  for (const v of voices) {
    const tailEnd = Math.max(v.endSec, Number.isFinite(v.visualEndSec) ? v.visualEndSec : v.endSec) + 0.35;
    if (tailEnd > renderDurationSec) {
      renderDurationSec = tailEnd;
    }
  }

  // Step 2: Sample-accurate 48kHz offline audio mix + 80Hz highpass + soft compressor
  report('Synthesizing sample-accurate 48kHz audio', 10);
  const totalAudioSamples = Math.ceil(renderDurationSec * AUDIO_SR);
  const mixBuffer = new Float32Array(totalAudioSamples);

  for (const v of voices) {
    const srcPcm = getSlicePcm(v.cand);
    if (!srcPcm) continue;
    const iStart = Math.max(0, Math.ceil(v.startSec * AUDIO_SR));
    const iEnd = Math.min(totalAudioSamples, Math.ceil(v.endSec * AUDIO_SR));
    const baseSrcIdx = v.trimIn * AUDIO_SR;
    const maxSrcIdx = Math.min(srcPcm.length - 2, (v.trimIn + v.bufferPlaySpan) * AUDIO_SR);

    for (let i = iStart; i < iEnd; i++) {
      const t = i / AUDIO_SR;
      const elapsed = t - v.startSec;
      if (elapsed < 0) continue;
      const srcPos = baseSrcIdx + elapsed * AUDIO_SR * v.playbackRate;
      if (srcPos < 0) continue;
      if (srcPos >= maxSrcIdx) break;
      const s0 = srcPos | 0;
      const frac = srcPos - s0;
      const sample = srcPcm[s0] * (1 - frac) + srcPcm[s0 + 1] * frac;
      mixBuffer[i] += sample * evalVoiceGain(v, t);
    }
  }

  applyBiquadHighpassInPlace(mixBuffer, AUDIO_SR, HIGHPASS_HZ);

  // Apply Web Audio DynamicsCompressor makeup pre-gain (+8.5 dB) into soft-knee compressor
  const makeupPreGain = Math.pow(10, 8.5 / 20);
  for (let i = 0; i < mixBuffer.length; i++) {
    mixBuffer[i] *= makeupPreGain;
  }
  applySoftCompressorInPlace(mixBuffer, AUDIO_SR);

  // Normalize master render headroom cleanly to -1.2 dBFS (0.871), capped at +16 dB additional lift
  let maxAbs = 0;
  for (let i = 0; i < mixBuffer.length; i++) {
    const a = Math.abs(mixBuffer[i]);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs > 1e-4) {
    const targetPeak = 0.871; // -1.2 dBFS
    const scale = maxAbs > targetPeak ? targetPeak / maxAbs : Math.min(6.31, targetPeak / maxAbs);
    for (let i = 0; i < mixBuffer.length; i++) {
      mixBuffer[i] *= scale;
    }
  }

  const outDir = path.dirname(finalOutPath);
  fs.mkdirSync(outDir, { recursive: true });
  const tmpWavPath = path.join(
    outDir,
    `.tmp_render_${process.pid}_${Date.now()}.wav`
  );
  const tmpMp4Path = path.join(
    outDir,
    `.tmp_render_${process.pid}_${Date.now()}.mp4`
  );
  writeWavMono16(tmpWavPath, mixBuffer, AUDIO_SR);

  // Step 3: Load stage atlas + compute exact stage geometry + pre-bake pure #000000 background & mosaic
  report('Preparing stage mosaic & spectrograms', 16);
  let atlasManifest = null;
  let atlasRgb = null;
  if (fs.existsSync(ATLAS_JSON_PATH) && fs.existsSync(ATLAS_IMG_PATH)) {
    atlasManifest = JSON.parse(fs.readFileSync(ATLAS_JSON_PATH, 'utf8'));
    atlasRgb = execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', ATLAS_IMG_PATH, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
      { maxBuffer: 96 * 1024 * 1024 }
    );
  }

  const mosaicItems = buildMosaicItems(catalog, atlasManifest, keyMap, disabledVideoIds);
  const geom = computeStageGeometry(W, H, gridSpec, mosaicItems.length, effTileScale, effSpecScale);
  const {
    uiScale,
    cols: stageCols,
    tileSize,
    specH,
    colGap,
    rowGap,
    stripLeft,
    stackTopY
  } = geom;

  // Pure #000000 solid black background (Buffer.alloc is zero-filled: [0, 0, 0])
  const bgBuf = Buffer.alloc(W * H * 3);
  const mosaicPatches = prepareMosaicRasterPatches(
    W,
    H,
    bgBuf,
    mosaicItems,
    geom.mosaic,
    atlasRgb,
    atlasManifest?.atlasWidth || 4096,
    atlasManifest?.atlasHeight || 4096,
    uiScale
  );
  atlasRgb = null; // Free 48MB raw atlas immediately after pre-sampling patches

  const patchIndexBySliceId = new Map();
  for (let i = 0; i < mosaicPatches.length; i++) {
    patchIndexBySliceId.set(mosaicPatches[i].sliceId, i);
  }

  // Precompute neutral grayscale flush spectrograms
  const specCache = new Map();
  for (const v of voices) {
    const specKey = `${v.cand.audioUrl}__gray__${v.playbackRate.toFixed(4)}__${v.trimIn.toFixed(2)}__${v.bufferPlaySpan.toFixed(2)}`;
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
          v.bufferPlaySpan
        )
      );
    }
    v.specKey = specKey;
  }

  // Track video clip lifetime & max needed clip duration so each clip is decoded at most once
  const videoMetaByUrl = new Map();
  for (const v of voices) {
    const url = v.cand.videoUrl;
    const maxClipTime = v.trimIn + v.bufferPlaySpan + 0.05;
    const prev = videoMetaByUrl.get(url);
    if (!prev) {
      videoMetaByUrl.set(url, {
        videoUrl: url,
        maxDurSec: maxClipTime,
        firstStartSec: v.startSec,
        lastVisualEndSec: v.visualEndSec
      });
    } else {
      if (maxClipTime > prev.maxDurSec) prev.maxDurSec = maxClipTime;
      if (v.startSec < prev.firstStartSec) prev.firstStartSec = v.startSec;
      if (v.visualEndSec > prev.lastVisualEndSec) prev.lastVisualEndSec = v.visualEndSec;
    }
  }

  const frameByteLen = tileSize * tileSize * 3;
  const videoFramesCache = new Map();
  const videoHdrCache = new Map();
  const MAX_CACHED_CLIPS = 96;

  function isHdrVideoClipSync(mp4Abs) {
    if (videoHdrCache.has(mp4Abs)) return videoHdrCache.get(mp4Abs);
    let isHdr = false;
    try {
      const out = execFileSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=color_transfer,color_primaries',
          '-of',
          'csv=p=0',
          mp4Abs
        ],
        { encoding: 'utf8' }
      )
        .trim()
        .toLowerCase();
      isHdr =
        out.includes('bt2020') || out.includes('arib-std-b67') || out.includes('smpte2084');
    } catch {}
    videoHdrCache.set(mp4Abs, isHdr);
    return isHdr;
  }

  async function isHdrVideoClipAsync(mp4Abs) {
    if (videoHdrCache.has(mp4Abs)) return videoHdrCache.get(mp4Abs);
    let isHdr = false;
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=color_transfer,color_primaries',
        '-of',
        'csv=p=0',
        mp4Abs
      ]);
      const out = String(stdout || '')
        .trim()
        .toLowerCase();
      isHdr =
        out.includes('bt2020') || out.includes('arib-std-b67') || out.includes('smpte2084');
    } catch {}
    videoHdrCache.set(mp4Abs, isHdr);
    return isHdr;
  }

  function buildClipDecodeVf(isHdr) {
    if (isHdr) {
      // Gamut-only Rec.2020 -> Rec.709 conversion preserving HLG's natural SDR-compatible brightness/contrast curve (zero dark S-curve tone-map)
      return `fps=${fps},colorspace=all=bt709:iall=bt2020:itrc=bt709:trc=bt709:fast=0,scale=${tileSize}:${tileSize}:flags=lanczos:in_color_matrix=bt709`;
    }
    return `fps=${fps},scale=${tileSize}:${tileSize}:flags=lanczos:in_color_matrix=bt709`;
  }

  async function decodeVideoClipAsync(url) {
    const meta = videoMetaByUrl.get(url);
    const mp4Abs = path.join(ROOT_DIR, url.replace(/^\//, ''));
    const isHdr = await isHdrVideoClipAsync(mp4Abs);
    const args = ['-v', 'error'];
    if (meta && Number.isFinite(meta.maxDurSec)) {
      args.push('-t', (meta.maxDurSec + 0.08).toFixed(3));
    }
    args.push(
      '-i',
      mp4Abs,
      '-vf',
      buildClipDecodeVf(isHdr),
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1'
    );
    const { stdout } = await execFileAsync('ffmpeg', args, {
      encoding: 'buffer',
      maxBuffer: 96 * 1024 * 1024
    });
    const frameCount = Math.max(1, Math.floor(stdout.length / frameByteLen));
    return { rawRgb: stdout, frameCount };
  }

  function decodeVideoClipSync(url) {
    const meta = videoMetaByUrl.get(url);
    const mp4Abs = path.join(ROOT_DIR, url.replace(/^\//, ''));
    const isHdr = isHdrVideoClipSync(mp4Abs);
    const args = ['-v', 'error'];
    if (meta && Number.isFinite(meta.maxDurSec)) {
      args.push('-t', (meta.maxDurSec + 0.08).toFixed(3));
    }
    args.push(
      '-i',
      mp4Abs,
      '-vf',
      buildClipDecodeVf(isHdr),
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1'
    );
    const rawRgb = execFileSync('ffmpeg', args, { maxBuffer: 96 * 1024 * 1024 });
    const frameCount = Math.max(1, Math.floor(rawRgb.length / frameByteLen));
    return { rawRgb, frameCount };
  }

  // Parallel pre-warm of the earliest clips up to MAX_CACHED_CLIPS
  const orderedVideoMetas = Array.from(videoMetaByUrl.values()).sort(
    (a, b) => a.firstStartSec - b.firstStartSec
  );
  const initialWarmList = orderedVideoMetas.slice(0, MAX_CACHED_CLIPS);
  report(`Decoding film clips (0/${orderedVideoMetas.length})`, 20);
  await runPool(initialWarmList, 8, async meta => {
    const entry = await decodeVideoClipAsync(meta.videoUrl);
    videoFramesCache.set(meta.videoUrl, entry);
  });

  function getDecodedVideoFramesAt(videoUrl, t) {
    // Evict clips whose final appearance in the render has already passed
    for (const cachedUrl of videoFramesCache.keys()) {
      const m = videoMetaByUrl.get(cachedUrl);
      if (m && t > m.lastVisualEndSec + 0.05) {
        videoFramesCache.delete(cachedUrl);
      }
    }
    if (videoFramesCache.has(videoUrl)) {
      const val = videoFramesCache.get(videoUrl);
      videoFramesCache.delete(videoUrl);
      videoFramesCache.set(videoUrl, val);
      return val;
    }
    if (videoFramesCache.size >= MAX_CACHED_CLIPS) {
      const oldestKey = videoFramesCache.keys().next().value;
      videoFramesCache.delete(oldestKey);
    }
    const decoded = decodeVideoClipSync(videoUrl);
    videoFramesCache.set(videoUrl, decoded);
    return decoded;
  }

  // Step 4: Spawn ffmpeg H.264 + AAC encoder and pipe exact 4:3 RGB24 frames
  const totalFrames = Math.max(1, Math.ceil(renderDurationSec * fps));
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
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '17',
      '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709',
      '-colorspace', 'bt709',
      '-color_primaries', 'bt709',
      '-color_trc', 'bt709',
      '-color_range', 'tv',
      '-c:a', 'aac',
      '-b:a', '256k',
      '-shortest',
      '-movflags', '+faststart+write_colr',
      tmpMp4Path
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] }
  );

  let ffStderr = '';
  let ffStdinErr = null;
  ffProc.stderr.on('data', d => {
    ffStderr += d.toString();
  });
  ffProc.stdin.on('error', err => {
    ffStdinErr = err;
  });
  const ffClosedPromise = once(ffProc, 'close');

  const voicesBySlot = Array.from({ length: stageSlotCount }, () => []);
  for (const v of voices) {
    voicesBySlot[v.slotIdx].push(v);
  }

  const tileActiveValues = new Float32Array(mosaicPatches.length);
  const dtFrame = 1 / fps;
  const TILE_COLOR_DECAY_SEC = 0.12;
  const keylineCssPx = getStageSpecKeylineWidth(effSpecScale);
  const stripeHalfThickness = Math.max(0.45, 0.5 * keylineCssPx * uiScale);
  const percPlayheadHalfThick = Math.max(0.5, 0.55 * uiScale);
  const unitHeight = tileSize + specH; // 0px vertical gap between video & spectrogram (100% flush)

  try {
    for (let f = 0; f < totalFrames; f++) {
      const t = f / fps;
      bgBuf.copy(frameBuf);

      const currentlyActivePatchIndices = new Set();
      for (let i = 0; i < voices.length; i++) {
        const v = voices[i];
        if (v.startSec > t) break;
        if (t < v.tileReleaseSec) {
          const pIdx = patchIndexBySliceId.get(v.sliceKey);
          if (pIdx !== undefined) currentlyActivePatchIndices.add(pIdx);
        }
      }

      // 1. Render foreground stage video grid + flush neutral grayscale spectrograms + f0 bars
      //    Strict 1-clip-per-slot (never overlapping two clips in the same slot)
      for (let slotIdx = 0; slotIdx < stageSlotCount; slotIdx++) {
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

        const unitAlpha = evalSlotVisualAlpha(activeVoice, t, effFadeInSec, effFadeOutSec);
        if (unitAlpha <= 0.004) continue;

        const slotCol = slotIdx % stageCols;
        const slotRow = (slotIdx / stageCols) | 0;
        const slotLeft = stripLeft + slotCol * (tileSize + colGap);
        const videoTop = stackTopY + slotRow * (unitHeight + rowGap);
        const specTop = videoTop + tileSize;

        // Blit square video frame (continues playing during fade-out, or holds freeze-frame at trimOut)
        const vidData = getDecodedVideoFramesAt(activeVoice.cand.videoUrl, t);
        const maxClipTime = Math.max(
          activeVoice.trimIn,
          activeVoice.trimIn + activeVoice.bufferPlaySpan - 0.015
        );
        const clipTime = Math.min(
          maxClipTime,
          activeVoice.trimIn + (t - activeVoice.startSec) * activeVoice.playbackRate
        );
        const vidFrameIdx = Math.max(0, Math.min(vidData.frameCount - 1, Math.floor(clipTime * fps)));
        const srcVidBase = vidFrameIdx * frameByteLen;
        const rowBytes = tileSize * 3;

        if (unitAlpha >= 0.996) {
          for (let r = 0; r < tileSize; r++) {
            const srcRowStart = srcVidBase + r * rowBytes;
            const dstRowStart = ((videoTop + r) * W + slotLeft) * 3;
            vidData.rawRgb.copy(frameBuf, dstRowStart, srcRowStart, srcRowStart + rowBytes);
          }
        } else {
          const aInt = Math.round(unitAlpha * 256);
          for (let r = 0; r < tileSize; r++) {
            let sOff = srcVidBase + r * rowBytes;
            let dOff = ((videoTop + r) * W + slotLeft) * 3;
            for (let b = 0; b < rowBytes; b++) {
              frameBuf[dOff + b] = (vidData.rawRgb[sOff + b] * aInt) >> 8;
            }
          }
        }

        // Blit flush neutral grayscale spectrogram directly underneath video
        const specBuf = specCache.get(activeVoice.specKey);
        if (specBuf) {
          if (unitAlpha >= 0.996) {
            for (let r = 0; r < specH; r++) {
              const srcRowStart = r * rowBytes;
              const dstRowStart = ((specTop + r) * W + slotLeft) * 3;
              specBuf.copy(frameBuf, dstRowStart, srcRowStart, srcRowStart + rowBytes);
            }
          } else {
            const aInt = Math.round(unitAlpha * 256);
            for (let r = 0; r < specH; r++) {
              let sOff = r * rowBytes;
              let dOff = ((specTop + r) * W + slotLeft) * 3;
              for (let b = 0; b < rowBytes; b++) {
                frameBuf[dOff + b] = (specBuf[sOff + b] * aInt) >> 8;
              }
            }
          }
        }

        if (activeVoice.isPerc) {
          const elapsed = Math.max(0, t - activeVoice.startSec);
          const progress = Math.max(0, Math.min(1, elapsed / Math.max(0.05, activeVoice.naturalDur)));
          const xCenter = slotLeft + progress * (tileSize - 1);
          const cx0 = Math.max(slotLeft, Math.floor(xCenter - 1));
          const cx1 = Math.min(slotLeft + tileSize - 1, Math.ceil(xCenter + 1));

          for (let px = cx0; px <= cx1; px++) {
            const cov = Math.max(0, Math.min(1, percPlayheadHalfThick + 0.5 - Math.abs(px - xCenter)));
            const a = cov * 0.55 * unitAlpha;
            if (a <= 0.005) continue;
            for (let py = specTop; py < specTop + specH; py++) {
              const pixIdx = (py * W + px) * 3;
              frameBuf[pixIdx] = Math.round(frameBuf[pixIdx] * (1 - a) + 255 * a);
              frameBuf[pixIdx + 1] = Math.round(frameBuf[pixIdx + 1] * (1 - a) + 255 * a);
              frameBuf[pixIdx + 2] = Math.round(frameBuf[pixIdx + 2] * (1 - a) + 255 * a);
            }
          }
        } else {
          const sAlpha = evalStripeAlpha(activeVoice, t) * 0.85 * unitAlpha;
          if (
            sAlpha > 0.005 &&
            activeVoice.f0Hz >= 50 &&
            activeVoice.f0Hz <= MINI_SPEC_MAX_FREQ * 1.15
          ) {
            const normY = miniSpecFreqToNormY(activeVoice.f0Hz);
            const yF0Local = Math.max(1.5 * uiScale, Math.min(specH - 1.5 * uiScale, (1 - normY) * (specH - 1)));
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

      // 2. Update & render active/fading tiles in the flush 1px-gap micro-thumbnail mosaic underneath
      //    Bottom mosaic tile colors NEVER fade in (hard pop-on) and dim fast (~0.12s) on end event
      const activeTileIndicesThisFrame = [];
      for (let i = 0; i < mosaicPatches.length; i++) {
        const target = currentlyActivePatchIndices.has(i) ? 1.0 : 0.0;
        const cur = tileActiveValues[i];
        let next = 0.0;
        if (target >= 1.0) {
          next = 1.0;
        } else if (cur > 0.004) {
          next = Math.max(0.0, cur - dtFrame / TILE_COLOR_DECAY_SEC);
        }
        tileActiveValues[i] = next;
        if (next > 0.004) {
          activeTileIndicesThisFrame.push(i);
        }
      }

      // Pass 2: blend chromatic hex square fill (85% max opacity) on active/fading micro-thumbnails
      for (let k = 0; k < activeTileIndicesThisFrame.length; k++) {
        const idx = activeTileIndicesThisFrame[k];
        const patch = mosaicPatches[idx];
        const mixT = smoothstep(0.0, 1.0, tileActiveValues[idx]);
        const mixInt = Math.round(mixT * 256);
        const invInt = 256 - mixInt;
        const { px0, py0, pw, ph, idleRgb, activeRgb } = patch;

        for (let ry = 0; ry < ph; ry++) {
          let pOff = ry * pw * 3;
          let dOff = ((py0 + ry) * W + px0) * 3;
          for (let rx = 0; rx < pw; rx++) {
            frameBuf[dOff] = (idleRgb[pOff] * invInt + activeRgb[pOff] * mixInt) >> 8;
            frameBuf[dOff + 1] = (idleRgb[pOff + 1] * invInt + activeRgb[pOff + 1] * mixInt) >> 8;
            frameBuf[dOff + 2] = (idleRgb[pOff + 2] * invInt + activeRgb[pOff + 2] * mixInt) >> 8;
            pOff += 3;
            dOff += 3;
          }
        }
      }

      if (ffStdinErr) {
        await ffClosedPromise;
        throw new Error(`ffmpeg stdin closed early: ${ffStderr || ffStdinErr.message}`);
      }
      if (!ffProc.stdin.write(frameBuf)) {
        await Promise.race([
          once(ffProc.stdin, 'drain'),
          ffClosedPromise
        ]);
      }

      if (f % 30 === 0 || f === totalFrames - 1) {
        const pct = 24 + ((f + 1) / totalFrames) * 74;
        report(`Encoding 4:3 ${normGridMode} stage frames`, pct, { frame: f + 1, totalFrames });
      }
    }

    ffProc.stdin.end();
    const [exitCode] = await ffClosedPromise;
    if (exitCode !== 0) {
      throw new Error(`ffmpeg exited with code ${exitCode}: ${ffStderr}`);
    }
    fs.renameSync(tmpMp4Path, finalOutPath);
  } finally {
    try {
      if (fs.existsSync(tmpWavPath)) fs.unlinkSync(tmpWavPath);
    } catch {}
    try {
      if (fs.existsSync(tmpMp4Path)) fs.unlinkSync(tmpMp4Path);
    } catch {}
  }

  report('Complete', 100, { frame: totalFrames, totalFrames });
  return {
    outPath: finalOutPath,
    fileName: path.basename(finalOutPath),
    gridMode: normGridMode,
    tileScale: effTileScale,
    fadeInSec: effFadeInSec,
    fadeOutSec: effFadeOutSec,
    maxDisplaySec: effMaxDisplaySec,
    transposeOctaves: effTransposeOctaves,
    durationSec: Number(renderDurationSec.toFixed(2)),
    totalFrames,
    width: W,
    height: H,
    fps
  };
}

// Direct CLI execution:
// node offline-render.mjs path/to/input.mid [--out renders/output.mp4] [--grid 3x2] [--tile-scale 100..250] [--fade-in 0..1.0] [--fade 0..2.0] [--max-display 1.0] [--transpose 0] [--width 1440] [--height 1080] [--fps 30]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const midiArg = args.find(a => !a.startsWith('--'));
  if (!midiArg) {
    console.error(
      'Usage: node offline-render.mjs <input.mid> [--out renders/out.mp4] [--grid 3x1|2x2|3x2|4x2|3x3] [--tile-scale 100..250] [--fade-in 0..1.0] [--fade 0..2.0] [--max-display 0.5..2.0] [--transpose 0] [--width 1440] [--height 1080] [--fps 30]'
    );
    process.exit(1);
  }
  const getFlag = (name, fallback) => {
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] !== undefined ? args[idx + 1] : fallback;
  };
  const outFlag = getFlag('--out', null);
  const gridFlag = getFlag('--grid', null);
  const tileScaleRaw = getFlag('--tile-scale', null);
  const tileScaleFlag = tileScaleRaw !== null ? Number(tileScaleRaw) : null;
  const fadeInRaw = getFlag('--fade-in', null);
  const fadeInFlag = fadeInRaw !== null ? Number(fadeInRaw) : null;
  const fadeRaw = getFlag('--fade', null);
  const fadeFlag = fadeRaw !== null ? Number(fadeRaw) : null;
  const maxDisplayFlag = getFlag('--max-display', undefined);
  const transposeRaw = getFlag('--transpose', undefined);
  const transposeFlag = transposeRaw !== undefined ? Number(transposeRaw) : undefined;
  const widthFlag = Number(getFlag('--width', 1440));
  const heightFlag = Number(getFlag('--height', 1080));
  const fpsFlag = Number(getFlag('--fps', 30));

  let lastLoggedPct = -5;
  renderMidiPerformanceToMp4({
    midiFilePath: path.resolve(midiArg),
    outPath: outFlag ? path.resolve(outFlag) : null,
    gridMode: gridFlag,
    tileScale: tileScaleFlag,
    fadeInSec: fadeInFlag,
    fadeOutSec: fadeFlag,
    maxDisplaySec: maxDisplayFlag,
    transposeOctaves: transposeFlag,
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
      console.log(
        `Saved 4:3 (${res.gridMode}) render -> ${res.outPath} (${res.width}x${res.height} @ ${res.fps}fps, ${res.durationSec}s)`
      );
    })
    .catch(err => {
      console.error('Render failed:', err);
      process.exit(1);
    });
}
