import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  SR,
  freqToMidi,
  detectPitchYIN,
  analyzeSpectrum,
  getVideoRotationMetadata,
  extractSquareThumbnail,
  extractSliceAssets,
  analyzeSliceRegion,
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
 * Measure steady pitch over a clean slice window, supporting high bird whistles up to G7 (3320 Hz).
 */
function measureCleanPitch(samples, startSec, durSec, minFreq = 65, maxFreq = 3320) {
  const base = analyzeSliceRegion(samples, startSec, durSec, minFreq);
  if (minFreq >= 500) {
    // High-register bird whistle: measure median YIN across loud steady frames up to maxFreq
    const i0 = Math.max(0, Math.floor(startSec * SR));
    const i1 = Math.min(samples.length - 4096, Math.floor((startSec + Math.min(durSec, 0.55)) * SR));
    const hop = Math.floor(0.02 * SR);
    const freqs = [];
    let bestCl = 0;
    for (let off = i0; off <= i1; off += hop) {
      const y = detectPitchYIN(samples, off, 4096, minFreq, maxFreq);
      if (y.clarity >= 0.82 && y.freq >= minFreq && y.freq <= maxFreq) {
        freqs.push(y.freq);
        if (y.clarity > bestCl) bestCl = y.clarity;
      }
    }
    if (freqs.length > 0) {
      freqs.sort((a, b) => a - b);
      const medF = freqs[Math.floor(freqs.length / 2)];
      const ni = freqToMidi(medF);
      if (ni) {
        return {
          ...base,
          ...ni,
          confidence: Number(Math.max(base.confidence, bestCl).toFixed(2))
        };
      }
    }
  }
  return base;
}

const NEW_BATCH = [
  {
    index: 111,
    file: 'PXL_20250527_155418284.mp4',
    slug: 'bird-song-1',
    label: 'Bird Song 1',
    category: 'winds',
    thumbSec: 6.85,
    hp: 520,
    minHz: 750,
    // Hand-verified steady, pure whistled single notes (no wild chirps/sweeps)
    moments: [
      { startSec: 5.55, durSec: 0.72 },
      { startSec: 6.80, durSec: 0.52 },
      { startSec: 7.95, durSec: 0.52 },
      { startSec: 20.52, durSec: 0.52 }
    ]
  },
  {
    index: 112,
    file: 'PXL_20250527_155454791.mp4',
    slug: 'bird-song-2',
    label: 'Bird Song 2',
    category: 'winds',
    thumbSec: 7.10,
    hp: 520,
    minHz: 750,
    // 3 cleanest whistled single bird notes
    moments: [
      { startSec: 6.44, durSec: 0.48 },
      { startSec: 10.02, durSec: 0.48 },
      { startSec: 12.80, durSec: 0.62 }
    ]
  },
  {
    index: 113,
    file: 'PXL_20250802_152856898.mp4',
    slug: 'wooden-automaton-box',
    label: 'Wooden Violin Music Box',
    category: 'metal',
    thumbSec: 11.60,
    hp: 210,
    minHz: 220,
    // Pure, temporally isolated monophonic single-tine notes
    moments: [
      { startSec: 7.85, durSec: 0.44 },
      { startSec: 11.57, durSec: 0.42 },
      { startSec: 12.01, durSec: 0.46 },
      { startSec: 14.12, durSec: 1.80 },
      { startSec: 16.84, durSec: 0.55 },
      { startSec: 19.30, durSec: 0.52 },
      { startSec: 19.86, durSec: 0.44 },
      { startSec: 21.85, durSec: 0.92 }
    ]
  },
  {
    index: 114,
    file: 'PXL_20250812_135316880 (1).mp4',
    slug: 'cat-toy-piano',
    label: 'Cat & Toy Piano',
    category: 'keys',
    thumbSec: 5.30,
    hp: 140,
    minHz: 180,
    moments: [
      { startSec: 3.50, durSec: 0.60 },
      { startSec: 5.24, durSec: 1.15 },
      { startSec: 6.45, durSec: 0.80 },
      { startSec: 19.82, durSec: 0.48 },
      { startSec: 21.82, durSec: 0.56 },
      { startSec: 29.52, durSec: 0.42 },
      { startSec: 29.96, durSec: 0.85 },
      { startSec: 33.08, durSec: 0.50 }
    ]
  },
  {
    index: 115,
    file: 'PXL_20261102_194329666.mp4',
    slug: 'brass-bell',
    label: 'Etched Brass Bell',
    category: 'metal',
    thumbSec: 3.25,
    hp: 180,
    minHz: 250,
    moments: [
      { startSec: 1.28, durSec: 1.85 },
      { startSec: 3.23, durSec: 1.85 }
    ]
  },
  {
    index: 116,
    file: 'PXL_20261102_194949418.mp4',
    slug: 'hand-drum-head',
    label: 'Hand Drum Head',
    category: 'toms',
    thumbSec: 1.30,
    hp: 55,
    minHz: 60,
    moments: [
      { startSec: 1.25, durSec: 2.20 }
    ]
  },
  {
    index: 117,
    file: 'PXL_20261102_195210569.mp4',
    slug: 'penny-whistle-1',
    label: 'Brass Penny Whistle 1',
    category: 'winds',
    thumbSec: 0.70,
    hp: 190,
    minHz: 260,
    moments: [
      { startSec: 0.56, durSec: 0.68 },
      { startSec: 3.16, durSec: 0.72 }
    ]
  },
  {
    index: 118,
    file: 'PXL_20261102_195333757.mp4',
    slug: 'penny-whistle-2',
    label: 'Penny Whistle 2',
    category: 'winds',
    thumbSec: 0.65,
    hp: 190,
    minHz: 260,
    moments: [
      { startSec: 0.46, durSec: 0.62 },
      { startSec: 2.66, durSec: 0.72 }
    ]
  },
  {
    index: 119,
    file: 'PXL_20261102_195710484.mp4',
    slug: 'wooden-marimba',
    label: 'Wooden Marimba',
    category: 'wood',
    thumbSec: 1.35,
    hp: 75,
    minHz: 95,
    // All 13 distinct wooden marimba bar strikes across D4 -> A5
    moments: [
      { startSec: 1.28, durSec: 2.25 },
      { startSec: 3.61, durSec: 1.95 },
      { startSec: 5.63, durSec: 2.05 },
      { startSec: 7.74, durSec: 1.82 },
      { startSec: 9.62, durSec: 1.98 },
      { startSec: 11.66, durSec: 1.88 },
      { startSec: 13.59, durSec: 1.85 },
      { startSec: 15.49, durSec: 1.70 },
      { startSec: 17.24, durSec: 1.70 },
      { startSec: 19.00, durSec: 1.62 },
      { startSec: 20.67, durSec: 1.68 },
      { startSec: 22.41, durSec: 2.55 },
      { startSec: 25.11, durSec: 1.48 }
    ]
  }
];

const importedEntries = [];

for (const cfg of NEW_BATCH) {
  const tempSrcAbs = path.join(TEMP_DIR, cfg.file);
  if (!fs.existsSync(tempSrcAbs)) {
    throw new Error(`Missing source video: ${tempSrcAbs}`);
  }

  const folderName = `${cfg.index}_${cfg.slug}`;
  const itemDir = path.join(SAMPLES_DIR, folderName);
  fs.mkdirSync(itemDir, { recursive: true });

  // Co-locate full original MP4 inside samples/<folderName>/<slug>_source.mp4 (APFS zero-extra-space clone)
  const sourceFile = `${cfg.slug}_source.mp4`;
  const colocatedAbs = path.join(itemDir, sourceFile);
  cloneOrCopyFile(tempSrcAbs, colocatedAbs);

  // Clean any old hit/thumb files in itemDir while keeping the co-located source.mp4
  for (const f of fs.readdirSync(itemDir)) {
    if (f !== sourceFile) {
      fs.rmSync(path.join(itemDir, f), { force: true });
    }
  }

  const thumbFile = `${cfg.slug}_thumb.jpg`;
  extractSquareThumbnail(colocatedAbs, path.join(itemDir, thumbFile), cfg.thumbSec, 0);

  const pcmBuf = execFileSync('ffmpeg', [
    '-v', 'error', '-i', colocatedAbs,
    '-vn', '-af', `highpass=f=${cfg.hp}`, '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1'
  ], { maxBuffer: 90 * 1024 * 1024 });
  const pcm = new Float32Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 4);
  const duration = Number((pcm.length / SR).toFixed(2));
  const { waveformPeaks, noiseFloorDb, peakDb } = computeWaveformAndStats(pcm);

  const slices = [];
  const allDetectedOnsets = [];

  for (let i = 0; i < cfg.moments.length; i++) {
    const m = cfg.moments[i];
    const hitIdx = i + 1;
    const hitTag = String(hitIdx).padStart(2, '0');
    const analysis = measureCleanPitch(pcm, m.startSec, m.durSec, cfg.minHz, 3320);

    const safeNote = (analysis.name || 'C4').replace('#', 's');
    const baseName = `${cfg.slug}_hit${hitTag}_${safeNote}`;
    const mp4File = `${baseName}.mp4`;
    const wavFile = `${baseName}.wav`;

    extractSliceAssets(
      colocatedAbs,
      m.startSec,
      m.durSec,
      path.join(itemDir, mp4File),
      path.join(itemDir, wavFile),
      0,
      cfg.hp
    );

    allDetectedOnsets.push({
      startSec: m.startSec,
      durSec: m.durSec,
      midi: analysis.midi,
      name: analysis.name,
      cents: analysis.cents,
      freq: analysis.freq,
      confidence: analysis.confidence,
      peakDb: analysis.peakDb
    });

    slices.push({
      id: `v${cfg.index}_s${hitTag}`,
      hitIndex: hitIdx,
      baseName,
      mp4File,
      wavFile,
      videoUrl: `/samples/${folderName}/${mp4File}`,
      audioUrl: `/samples/${folderName}/${wavFile}`,
      startSec: m.startSec,
      durSec: m.durSec,
      highpassHz: cfg.hp,
      midi: analysis.midi,
      name: analysis.name,
      cents: analysis.cents,
      exactMidi: analysis.exactMidi,
      freq: analysis.freq,
      confidence: analysis.confidence,
      peakDb: analysis.peakDb,
      candidatePeaks: analysis.candidatePeaks,
      isNew: true,
      starred: cfg.slug === 'wooden-marimba',
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

// Re-read catalog.json right before saving so any live UI Go-To clicks are 100% preserved!
const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
if (!catalog.keyboardConfig) {
  catalog.keyboardConfig = { selectedByMidi: {}, clearedMidis: [] };
}

for (const entry of importedEntries) {
  const existingIdx = catalog.videos.findIndex(v => v.index === entry.index || v.slug === entry.slug);
  if (existingIdx >= 0) {
    catalog.videos[existingIdx] = entry;
  } else {
    catalog.videos.push(entry);
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
const newConsiderations = keyEntries.reduce((sum, k) => sum + (k.newCount || 0), 0);
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
  newConsiderations,
  exactKeys: coveredKeys,
  neighborKeys: 0,
  percCount
};

fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));
console.log(`\nSaved catalog.json -> ${coveredKeys}/68 keys active | ${totalCandidates} total candidates | ${newConsiderations} new considerations!`);
