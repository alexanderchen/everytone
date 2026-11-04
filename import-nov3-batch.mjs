import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  SR,
  MAX_CLIP_DUR,
  freqToMidi,
  detectPitchYIN,
  analyzeSpectrum,
  getVideoRotationMetadata,
  extractSquareThumbnail,
  extractSliceAssets,
  analyzeSliceRegion,
  analyzeVideoAudio,
  computeKeyboardMap,
  computePercussionMap
} from './dsp-pipeline.mjs';

const ROOT_DIR = process.cwd();
const SAMPLES_DIR = path.join(ROOT_DIR, 'samples');
const TEMP_DIR = path.join(ROOT_DIR, 'temp-photo-import');
const CATALOG_PATH = path.join(ROOT_DIR, 'catalog.json');

function cloneOrCopyFile(src, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size) {
    return;
  }
  try {
    execFileSync('cp', ['-c', src, dest]);
  } catch {
    fs.copyFileSync(src, dest);
  }
}

function loadMonoSamples(filePath, highpassHz = 45) {
  const buf = execFileSync(
    'ffmpeg',
    [
      '-v', 'error',
      '-i', filePath,
      '-vn',
      '-af', `highpass=f=${highpassHz}`,
      '-ac', '1',
      '-ar', String(SR),
      '-f', 'f32le',
      'pipe:1'
    ],
    { maxBuffer: 95 * 1024 * 1024 }
  );
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function computeWaveformAndStats(samples) {
  const numBuckets = 180;
  const bucketSize = Math.max(1, Math.floor(samples.length / numBuckets));
  const waveformPeaks = [];
  const rmsVals = [];
  for (let b = 0; b < numBuckets; b++) {
    let maxAbs = 0;
    let sumSq = 0;
    let cnt = 0;
    const s0 = b * bucketSize;
    const s1 = Math.min(samples.length, s0 + bucketSize);
    for (let i = s0; i < s1; i += 4) {
      const v = samples[i];
      const av = Math.abs(v);
      if (av > maxAbs) maxAbs = av;
      sumSq += v * v;
      cnt++;
    }
    waveformPeaks.push(Number(maxAbs.toFixed(3)));
    rmsVals.push(20 * Math.log10(Math.sqrt(sumSq / Math.max(1, cnt)) + 1e-8));
  }
  rmsVals.sort((a, b) => a - b);
  return {
    waveformPeaks,
    noiseFloorDb: Number((rmsVals[Math.floor(rmsVals.length * 0.2)] || -65).toFixed(1)),
    peakDb: Number((rmsVals[Math.floor(rmsVals.length * 0.99)] || -20).toFixed(1))
  };
}

/**
 * Low-register tonal pitch measurement (keeps tonal floor >= C2 / 63.7Hz so bass plucks
 * never spill into Percussion Octave MIDI 24..35, while resolving true E2/D#2/C2/C#2 fundamentals
 * when the 2nd harmonic is stronger than f0).
 */
function analyzeTonalBassOrGuitarSlice(samples, startSec, durSec, minFreq = 63.7, isGuitar = false) {
  const base = analyzeSliceRegion(samples, startSec, durSec, minFreq);
  const halfFreq = base.freq / 2;
  if (halfFreq < minFreq) return base;

  const startSample = Math.max(0, Math.floor(startSec * SR));
  const endSample = Math.min(samples.length, Math.floor((startSec + Math.min(durSec, 1.5)) * SR));
  let peakOff = startSample;
  let maxDb = -100;
  for (let off = startSample; off <= Math.min(endSample - 2048, startSample + Math.floor(0.35 * SR)); off += 1024) {
    let s2 = 0;
    for (let i = 0; i < 2048; i++) s2 += samples[off + i] * samples[off + i];
    const db = 20 * Math.log10(Math.sqrt(s2 / 2048) + 1e-8);
    if (db > maxDb) {
      maxDb = db;
      peakOff = off;
    }
  }

  let subVotes = 0;
  let totalFrames = 0;
  const subFreqs = [];
  const relThreshold = isGuitar ? 0.08 : 0.16;

  for (let off = peakOff + 1024; off <= Math.min(endSample - 8192, peakOff + Math.floor(0.65 * SR)); off += 1024) {
    const y8 = detectPitchYIN(samples, off, 8192, minFreq, 900);
    const sp = analyzeSpectrum(samples, off, minFreq);
    totalFrames++;

    const topMag = sp.topPeaks[0]?.mag || 1;
    const subPk = sp.topPeaks.find(p => Math.abs(p.freq - halfFreq) / halfFreq < 0.055);
    const thirdHarm = sp.topPeaks.find(p => Math.abs(p.freq - halfFreq * 3) / (halfFreq * 3) < 0.04);

    if (y8.clarity > 0.74 && Math.abs(y8.freq - halfFreq) / halfFreq < 0.055 && (isGuitar || (subPk && subPk.mag > topMag * relThreshold))) {
      subVotes++;
      subFreqs.push(y8.freq);
    } else {
      if (subPk && (subPk.mag > topMag * relThreshold || (isGuitar && thirdHarm))) {
        subVotes++;
        subFreqs.push(subPk.freq);
      } else if (isGuitar && thirdHarm && thirdHarm.mag > topMag * 0.12) {
        subVotes++;
        subFreqs.push(halfFreq);
      }
    }
  }

  if (subVotes >= Math.max(2, Math.floor(totalFrames * 0.35)) && subFreqs.length > 0) {
    subFreqs.sort((a, b) => a - b);
    const med = subFreqs[Math.floor(subFreqs.length / 2)];
    const ni = freqToMidi(med);
    if (ni && ni.midi >= 36) {
      return {
        ...base,
        ...ni,
        confidence: Number(Math.max(base.confidence, 0.92).toFixed(2))
      };
    }
  }
  return base;
}

/**
 * Extract all 37 chromatic Melodica notes (F3..F6) without mid-breath split duplicates.
 */
function detectMelodicaChromaticMoments(filePath, samples) {
  const auto = analyzeVideoAudio(filePath, { minPitchHz: 150, allowWideDynamics: true, maxSlices: 60 });
  const hop = 1024;
  const nF = Math.floor((samples.length - 4096) / hop);
  const fDb = new Float32Array(nF);
  for (let f = 0; f < nF; f++) {
    let sq = 0;
    const off = f * hop;
    for (let i = 0; i < 2048; i++) sq += samples[off + i] * samples[off + i];
    fDb[f] = 20 * Math.log10(Math.sqrt(sq / 2048) + 1e-8);
  }

  // Merge consecutive onsets of same MIDI when breath never dipped into silence
  const merged = [];
  for (const o of auto.allDetectedOnsets) {
    // Fix the tail E6/F6 boundary verified in 0.15s profile:
    if (o.startSec >= 35.9 && o.startSec <= 36.2) continue; // fade-out tail of D6 @ 35.57s
    const prev = merged[merged.length - 1];
    if (prev && prev.midi === o.midi && o.startSec - prev.startSec < 1.2) {
      const f0 = Math.floor(((prev.startSec + 0.12) * SR) / hop);
      const f1 = Math.floor((o.startSec * SR) / hop);
      let minBetween = 0;
      for (let f = f0; f <= f1; f++) if (fDb[f] < minBetween) minBetween = fDb[f];
      if (minBetween > -38) continue;
    }
    merged.push({ startSec: o.startSec, midi: o.midi });
  }

  // Ensure exact E6 (37.20s) and F6 (37.95s) separation at the end of the scale
  const clean = merged.filter(m => m.startSec < 37.0);
  clean.push({ startSec: 37.20, durSec: 0.56 }); // E6
  clean.push({ startSec: 37.95, durSec: 0.72 }); // F6

  for (let i = 0; i < clean.length; i++) {
    if (clean[i].durSec) continue;
    const cur = clean[i];
    const nextStart = i + 1 < clean.length ? clean[i + 1].startSec - 0.04 : samples.length / SR - 0.05;
    const fStart = Math.floor(((cur.startSec + 0.15) * SR) / hop);
    const fMax = Math.min(nF - 1, Math.floor((nextStart * SR) / hop));
    let fEnd = fMax;
    for (let f = fStart; f <= fMax; f++) {
      if (fDb[f] < -42) {
        fEnd = f;
        break;
      }
    }
    cur.durSec = Number(Math.min(MAX_CLIP_DUR, Math.max(0.45, (fEnd * hop) / SR - cur.startSec + 0.04)).toFixed(2));
  }

  return clean;
}

/**
 * Select cleanest distinct bass plucks from a Yellow Bucket Rubber Band video.
 */
function selectBucketBassMoments(filePath, samples, maxPerNote = 1, maxTotal = 12) {
  const auto = analyzeVideoAudio(filePath, { minPitchHz: 64, allowWideDynamics: true, maxSlices: 32 });
  const candidates = auto.allDetectedOnsets.map(o => {
    const durSec = Number(Math.min(MAX_CLIP_DUR, o.durSec).toFixed(2));
    const analysis = analyzeTonalBassOrGuitarSlice(samples, o.startSec, durSec, 63.7, false);
    return {
      startSec: o.startSec,
      durSec,
      ...analysis
    };
  });

  const maxDb = Math.max(...candidates.map(c => c.peakDb), -35);
  const viable = candidates.filter(c => c.peakDb >= maxDb - 16 && c.midi >= 36);
  const pool = viable.length > 0 ? viable : candidates.filter(c => c.midi >= 36);

  const byMidi = new Map();
  const score = s => s.confidence * 2.0 + (s.peakDb - maxDb) / 7.5 - Math.abs(s.cents) / 220 + Math.min(0.4, s.durSec * 0.15);
  for (const c of pool) {
    const arr = byMidi.get(c.midi) || [];
    arr.push(c);
    byMidi.set(c.midi, arr);
  }

  const picked = [];
  const perNote = byMidi.size <= 2 ? 2 : maxPerNote;
  for (const [, list] of byMidi.entries()) {
    list.sort((a, b) => score(b) - score(a));
    picked.push(...list.slice(0, perNote));
  }
  picked.sort((a, b) => score(b) - score(a));
  const capped = picked.slice(0, maxTotal);
  capped.sort((a, b) => a.startSec - b.startSec);
  return { allOnsets: candidates, selected: capped };
}

const NOV3_BATCH = [
  {
    index: 120,
    file: 'PXL_20261103_120157826.mp4',
    slug: 'hand-whistle',
    label: 'Cupped Hand Whistle',
    category: 'winds',
    thumbSec: 5.35,
    hp: 320,
    minHz: 450,
    mode: 'moments',
    moments: [
      { startSec: 2.76, durSec: 0.56 }, // F5 (699 Hz, +1c)
      { startSec: 4.86, durSec: 1.18 }, // F#5 (727 Hz, sustained)
      { startSec: 7.02, durSec: 1.20 }, // G#5 / G5 (808 Hz, sustained)
      { startSec: 9.08, durSec: 0.96 }  // F5 (708 Hz, loudest breath)
    ]
  },
  {
    index: 121,
    file: 'PXL_20261103_122231827.mp4',
    slug: 'blue-melodica',
    label: 'Blue Melodica',
    category: 'keys',
    thumbSec: 15.80,
    hp: 130,
    minHz: 155,
    mode: 'melodica'
  },
  {
    index: 122,
    file: 'PXL_20261103_142317080.mp4',
    slug: 'bucket-rubberband-1',
    label: 'Yellow Bucket Bass 1',
    category: 'strings',
    thumbSec: 3.15,
    hp: 42,
    minHz: 63.7,
    mode: 'bucket-bass',
    maxSlices: 6
  },
  {
    index: 123,
    file: 'PXL_20261103_142355752.mp4',
    slug: 'bucket-rubberband-2',
    label: 'Yellow Bucket Bass 2',
    category: 'strings',
    thumbSec: 13.20,
    hp: 42,
    minHz: 63.7,
    mode: 'bucket-bass',
    maxSlices: 8
  },
  {
    index: 124,
    file: 'PXL_20261103_142415089.mp4',
    slug: 'bucket-rubberband-3',
    label: 'Yellow Bucket Bass 3',
    category: 'strings',
    thumbSec: 6.95,
    hp: 42,
    minHz: 63.7,
    mode: 'bucket-bass',
    maxSlices: 6
  },
  {
    index: 125,
    file: 'PXL_20261103_142447868.mp4',
    slug: 'bucket-rubberband-4',
    label: 'Yellow Bucket Bass 4',
    category: 'strings',
    thumbSec: 4.35,
    hp: 42,
    minHz: 63.7,
    mode: 'bucket-bass',
    maxSlices: 4
  },
  {
    index: 126,
    file: 'PXL_20261103_142506679.mp4',
    slug: 'bucket-rubberband-5',
    label: 'Yellow Bucket Bass 5',
    category: 'strings',
    thumbSec: 10.40,
    hp: 42,
    minHz: 63.7,
    mode: 'bucket-bass',
    maxSlices: 8
  },
  {
    index: 127,
    file: 'PXL_20261103_142555749.mp4',
    slug: 'bucket-rubberband-6',
    label: 'Yellow Bucket Bass 6',
    category: 'strings',
    thumbSec: 53.10,
    hp: 42,
    minHz: 63.7,
    mode: 'bucket-bass',
    // Explicitly ensure the clean C#3 @ 50.71s (136.6 Hz, -16 dB) is included alongside C2, C#2, F2, F#2, G2, G#2, B2, C3, D#3!
    extraMoments: [{ startSec: 50.71, durSec: 2.33, forceMinHz: 115 }],
    maxSlices: 12
  },
  {
    index: 128,
    file: 'PXL_20261103_152858385.mp4',
    slug: 'acoustic-guitar-1',
    label: 'Acoustic Guitar 1',
    category: 'strings',
    thumbSec: 10.35,
    hp: 45,
    minHz: 65,
    mode: 'guitar',
    moments: [
      { startSec: 2.18, durSec: 2.50 },  // E2
      { startSec: 10.24, durSec: 2.50 }, // A2
      { startSec: 18.97, durSec: 2.50 }, // D3
      { startSec: 26.35, durSec: 2.50 }  // G3
    ]
  },
  {
    index: 129,
    file: 'PXL_20261103_152935725.mp4',
    slug: 'acoustic-guitar-2',
    label: 'Acoustic Guitar 2',
    category: 'strings',
    thumbSec: 8.15,
    hp: 45,
    minHz: 65,
    mode: 'guitar',
    moments: [
      { startSec: 2.60, durSec: 2.50 },  // E2
      { startSec: 8.01, durSec: 2.50 },  // A2
      { startSec: 14.44, durSec: 2.50 }, // D3
      { startSec: 21.24, durSec: 2.50 }  // G3
    ]
  },
  {
    index: 130,
    file: 'PXL_20261103_153005107.mp4',
    slug: 'acoustic-guitar-3',
    label: 'Acoustic Guitar 3',
    category: 'strings',
    thumbSec: 8.90,
    hp: 45,
    minHz: 65,
    mode: 'guitar',
    moments: [
      { startSec: 4.11, durSec: 2.50 },  // E2
      { startSec: 8.80, durSec: 2.50 },  // A2
      { startSec: 15.53, durSec: 2.50 }, // D3
      { startSec: 21.38, durSec: 2.50 }  // G3
    ]
  },
  {
    index: 131,
    file: 'PXL_20261103_153035182.mp4',
    slug: 'acoustic-guitar-4',
    label: 'Acoustic Guitar 4',
    category: 'strings',
    thumbSec: 8.30,
    hp: 45,
    minHz: 65,
    mode: 'guitar',
    moments: [
      { startSec: 2.48, durSec: 2.50 },  // E2
      { startSec: 8.19, durSec: 2.50 },  // A2
      { startSec: 14.46, durSec: 2.50 }, // D3
      { startSec: 20.57, durSec: 2.50 }  // G3
    ]
  }
];

const onlyArg = process.argv.find(a => a.startsWith('--only='));
const onlyIndex = onlyArg ? Number(onlyArg.split('=')[1]) : null;
const batchToRun = onlyIndex ? NOV3_BATCH.filter(c => c.index === onlyIndex) : NOV3_BATCH;

const importedEntries = [];

for (const cfg of batchToRun) {
  const tempPath = path.join(TEMP_DIR, cfg.file);
  if (!fs.existsSync(tempPath)) {
    throw new Error(`Missing source video: ${tempPath}`);
  }

  const folderName = `${String(cfg.index).padStart(2, '0')}_${cfg.slug}`;
  const outDir = path.join(SAMPLES_DIR, folderName);
  fs.mkdirSync(outDir, { recursive: true });

  // 1. Co-locate full source MP4 via APFS copy-on-write clone
  const sourceFile = `${cfg.slug}_source.mp4`;
  const colocatedAbs = path.join(outDir, sourceFile);
  cloneOrCopyFile(tempPath, colocatedAbs);

  // 2. Clean old slice files if re-running idempotently
  for (const existing of fs.readdirSync(outDir)) {
    if (existing !== sourceFile) {
      fs.unlinkSync(path.join(outDir, existing));
    }
  }

  // 3. Extract 512x512 square thumbnail
  const thumbFile = `${cfg.slug}_thumb.jpg`;
  extractSquareThumbnail(colocatedAbs, path.join(outDir, thumbFile), cfg.thumbSec, 0);

  // 4. Load mono PCM at item's clean highpass frequency
  const samples = loadMonoSamples(colocatedAbs, cfg.hp);
  const duration = Number((samples.length / SR).toFixed(2));
  const { waveformPeaks, noiseFloorDb, peakDb } = computeWaveformAndStats(samples);

  let chosenMoments = [];
  let rawOnsetList = [];

  if (cfg.mode === 'melodica') {
    const mel = detectMelodicaChromaticMoments(colocatedAbs, samples);
    chosenMoments = mel.map(m => {
      const a = analyzeSliceRegion(samples, m.startSec, m.durSec, cfg.minHz);
      return { startSec: m.startSec, durSec: m.durSec, ...a };
    });
    rawOnsetList = chosenMoments;
  } else if (cfg.mode === 'bucket-bass') {
    const forcedStarts = (cfg.extraMoments || []).map(em => em.startSec);
    const { allOnsets, selected } = selectBucketBassMoments(colocatedAbs, samples, 1, cfg.maxSlices || 8);
    chosenMoments = selected.filter(cm => !forcedStarts.some(fsSec => Math.abs(cm.startSec - fsSec) < 0.25));
    if (Array.isArray(cfg.extraMoments)) {
      for (const em of cfg.extraMoments) {
        const a = analyzeSliceRegion(samples, em.startSec, em.durSec, em.forceMinHz || cfg.minHz);
        chosenMoments.push({ startSec: em.startSec, durSec: em.durSec, ...a });
      }
      chosenMoments.sort((a, b) => a.startSec - b.startSec);
    }
    rawOnsetList = allOnsets;
  } else if (cfg.mode === 'guitar') {
    chosenMoments = cfg.moments.map(m => {
      const clampedDur = Number(Math.min(MAX_CLIP_DUR, m.durSec).toFixed(2));
      const a = analyzeTonalBassOrGuitarSlice(samples, m.startSec, clampedDur, cfg.minHz, true);
      return { startSec: m.startSec, durSec: clampedDur, ...a };
    });
    rawOnsetList = chosenMoments;
  } else {
    chosenMoments = cfg.moments.map(m => {
      const clampedDur = Number(Math.min(MAX_CLIP_DUR, m.durSec).toFixed(2));
      const a = analyzeSliceRegion(samples, m.startSec, clampedDur, cfg.minHz);
      return { startSec: m.startSec, durSec: clampedDur, ...a };
    });
    rawOnsetList = chosenMoments;
  }

  const slices = [];
  const allDetectedOnsets = rawOnsetList.map(o => ({
    startSec: o.startSec,
    durSec: Number(Math.min(MAX_CLIP_DUR, o.durSec).toFixed(2)),
    midi: o.midi,
    name: o.name,
    cents: o.cents,
    freq: o.freq,
    confidence: o.confidence,
    peakDb: o.peakDb
  }));

  for (let i = 0; i < chosenMoments.length; i++) {
    const m = chosenMoments[i];
    const durSec = Number(Math.min(MAX_CLIP_DUR, m.durSec).toFixed(2));
    const hitIdx = i + 1;
    const hitTag = String(hitIdx).padStart(2, '0');
    const safeNote = m.name.replace('#', 's');
    const baseName = `${cfg.slug}_hit${hitTag}_${safeNote}`;
    const mp4File = `${baseName}.mp4`;
    const wavFile = `${baseName}.wav`;

    extractSliceAssets(
      colocatedAbs,
      m.startSec,
      durSec,
      path.join(outDir, mp4File),
      path.join(outDir, wavFile),
      0,
      cfg.hp
    );

    slices.push({
      id: `v${cfg.index}_s${hitTag}`,
      hitIndex: hitIdx,
      baseName,
      mp4File,
      wavFile,
      videoUrl: `/samples/${folderName}/${mp4File}`,
      audioUrl: `/samples/${folderName}/${wavFile}`,
      startSec: m.startSec,
      durSec,
      rawDurSec: durSec,
      trimIn: 0,
      trimOut: durSec,
      highpassHz: cfg.hp,
      midi: m.midi,
      name: m.name,
      cents: m.cents,
      exactMidi: m.exactMidi,
      freq: m.freq,
      confidence: m.confidence,
      peakDb: m.peakDb,
      candidatePeaks: m.candidatePeaks,
      dspOriginal: {
        midi: m.midi,
        name: m.name,
        cents: m.cents,
        exactMidi: m.exactMidi,
        freq: m.freq
      },
      isNew: true,
      starred: false,
      deleted: false
    });
  }

  const videoEntry = {
    id: `v${cfg.index}`,
    index: cfg.index,
    originalFilename: cfg.file,
    sourceFile,
    sourcePath: `samples/${folderName}/${sourceFile}`,
    slug: cfg.slug,
    label: cfg.label,
    category: cfg.category,
    folderName,
    thumbFile,
    thumbUrl: `/samples/${folderName}/${thumbFile}`,
    rotationMetadata: getVideoRotationMetadata(colocatedAbs),
    extraRotateDeg: 0,
    duration,
    noiseFloorDb,
    peakDb,
    waveformPeaks,
    allDetectedOnsets,
    slices,
    deleted: false
  };

  importedEntries.push(videoEntry);
  console.log(
    `Imported #${cfg.index} ${cfg.slug} (${slices.length} slices): ` +
      slices.map(s => `${s.name}(${s.cents >= 0 ? '+' : ''}${s.cents}c)`).join(', ')
  );
}

// Re-read catalog.json immediately prior to saving so live UI edits are never clobbered
const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
if (!catalog.keyboardConfig) {
  catalog.keyboardConfig = { selectedByMidi: {}, clearedMidis: [], enabledByMidi: {} };
}

for (const entry of importedEntries) {
  const existingIdx = catalog.videos.findIndex(v => v.index === entry.index || v.slug === entry.slug);
  if (existingIdx >= 0) {
    catalog.videos[existingIdx] = entry;
  } else {
    catalog.videos.push(entry);
  }
}

// MIDI 41 (F2) previously only had an unusable breath artifact (v27_s04) that was cleared;
// clear that stale clearedMidis flag so the new resonant Yellow Bucket Bass F2 lights up!
if (Array.isArray(catalog.keyboardConfig.clearedMidis) && catalog.keyboardConfig.clearedMidis.includes(41)) {
  const prevEnabled41 = catalog.keyboardConfig.enabledByMidi?.[41];
  if (!Array.isArray(prevEnabled41) || prevEnabled41.length === 0) {
    catalog.keyboardConfig.clearedMidis = catalog.keyboardConfig.clearedMidis.filter(m => Number(m) !== 41);
    delete catalog.keyboardConfig.enabledByMidi[41];
  }
}

catalog.videos.sort((a, b) => a.index - b.index);
catalog.keyboardMap = computeKeyboardMap(catalog.videos, catalog.keyboardConfig);
catalog.percussionMap = computePercussionMap(catalog.videos, catalog.percussionMap);

const activeVideos = catalog.videos.filter(v => !v.deleted);
const activeSlices = activeVideos.reduce((sum, v) => sum + (v.slices || []).filter(s => !s.deleted).length, 0);
const keyEntries = Object.values(catalog.keyboardMap);
const coveredKeys = keyEntries.filter(k => !!k.primary).length;
const keysWithCandidates = keyEntries.length;
const totalCandidates = keyEntries.reduce((sum, k) => sum + (k.candidateCount || 0), 0);
const percCount =
  (catalog.percussionMap.kick?.slots.length || 0) +
  (catalog.percussionMap.snare?.slots.length || 0) +
  (catalog.percussionMap.hihat?.slots.length || 0);

catalog.updatedAt = new Date().toISOString();
catalog.stats = {
  totalVideos: activeVideos.length,
  trashedVideos: catalog.videos.filter(v => v.deleted).length,
  totalSlices: activeSlices,
  coveredKeys,
  keysWithCandidates,
  totalCandidates,
  exactKeys: coveredKeys,
  neighborKeys: 0,
  percCount
};

fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));
console.log(
  `\nSaved catalog.json -> ${activeVideos.length} active videos | ${activeSlices} slices | ${coveredKeys}/${keysWithCandidates} keys active | ${totalCandidates} total candidates!`
);
