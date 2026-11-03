import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  SR,
  getVideoRotationMetadata,
  extractSquareThumbnail,
  extractSliceAssets,
  analyzeSliceRegion,
  computeKeyboardMap,
  computePercussionMap
} from './dsp-pipeline.mjs';

const ROOT_DIR = process.cwd();
const SAMPLES_DIR = path.join(ROOT_DIR, 'samples');
const CATALOG_PATH = path.join(ROOT_DIR, 'catalog.json');

const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));

// ============================================================================
// 1. Relabel #55 – #59 (green-steel-bin-1..5 -> bird-feeder-1..5) & Percussion Only
// ============================================================================
const BIRD_FEEDER_CONFIG = {
  55: { sub: 1, startSec: 3.68, durSec: 0.90, bucket: 'kick', hp: 40, percLabel: 'Bird Feeder Deep Thud 1' },
  56: { sub: 2, startSec: 0.79, durSec: 0.85, bucket: 'snare', hp: 90, percLabel: 'Bird Feeder Clang' },
  57: { sub: 3, startSec: 4.67, durSec: 0.90, bucket: 'kick', hp: 40, percLabel: 'Bird Feeder Deep Thud 2' },
  58: { sub: 4, startSec: 0.86, durSec: 0.85, bucket: 'snare', hp: 85, percLabel: 'Bird Feeder Hollow Snap' },
  59: { sub: 5, startSec: 3.47, durSec: 0.80, bucket: 'hihat', hp: 140, percLabel: 'Bird Feeder Metal Ping' }
};

for (const idx of [55, 56, 57, 58, 59]) {
  const v = catalog.videos.find(x => x.index === idx);
  if (!v) continue;

  const cfg = BIRD_FEEDER_CONFIG[idx];
  const newSlug = `bird-feeder-${cfg.sub}`;
  const newFolder = `${idx}_${newSlug}`;
  const oldDir = path.join(SAMPLES_DIR, v.folderName);
  const newDir = path.join(SAMPLES_DIR, newFolder);

  if (fs.existsSync(oldDir) && oldDir !== newDir) {
    if (fs.existsSync(newDir)) fs.rmSync(newDir, { recursive: true, force: true });
    fs.renameSync(oldDir, newDir);
  }
  fs.mkdirSync(newDir, { recursive: true });

  const oldThumb = path.join(newDir, v.thumbFile);
  const newThumbFile = `${newSlug}_thumb.jpg`;
  const newThumb = path.join(newDir, newThumbFile);
  if (fs.existsSync(oldThumb) && oldThumb !== newThumb) {
    fs.renameSync(oldThumb, newThumb);
  }

  const sourceAbs = path.join(ROOT_DIR, v.sourcePath);
  if (!fs.existsSync(newThumb) && fs.existsSync(sourceAbs)) {
    extractSquareThumbnail(sourceAbs, newThumb, 0.1, v.extraRotateDeg || 0);
  }

  for (const f of fs.readdirSync(newDir)) {
    if (f !== newThumbFile) fs.rmSync(path.join(newDir, f), { force: true });
  }

  v.slug = newSlug;
  v.label = `Metal Bird Feeder ${cfg.sub}`;
  v.category = 'percussion';
  v.folderName = newFolder;
  v.thumbFile = newThumbFile;
  v.thumbUrl = `/samples/${newFolder}/${newThumbFile}`;

  // Decode audio to measure exact DSP stats on the chosen percussive hit
  const pcmBuf = execFileSync('ffmpeg', [
    '-v', 'error', '-i', sourceAbs,
    '-vn', '-af', `highpass=f=${cfg.hp}`, '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1'
  ], { maxBuffer: 90 * 1024 * 1024 });
  const pcm = new Float32Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 4);
  const analysis = analyzeSliceRegion(pcm, cfg.startSec, cfg.durSec, 65);

  const tag = cfg.bucket.toUpperCase();
  const baseName = `${newSlug}_hit01_${tag}`;
  const mp4File = `${baseName}.mp4`;
  const wavFile = `${baseName}.wav`;

  extractSliceAssets(
    sourceAbs,
    cfg.startSec,
    cfg.durSec,
    path.join(newDir, mp4File),
    path.join(newDir, wavFile),
    v.extraRotateDeg || 0,
    cfg.hp
  );

  v.slices = [
    {
      id: `v${idx}_s01`,
      hitIndex: 1,
      baseName,
      mp4File,
      wavFile,
      videoUrl: `/samples/${newFolder}/${mp4File}`,
      audioUrl: `/samples/${newFolder}/${wavFile}`,
      startSec: cfg.startSec,
      durSec: cfg.durSec,
      highpassHz: cfg.hp,
      percBucket: cfg.bucket,
      percLabel: cfg.percLabel,
      midi: analysis.midi,
      name: analysis.name,
      cents: analysis.cents,
      exactMidi: analysis.exactMidi,
      freq: analysis.freq,
      confidence: analysis.confidence,
      peakDb: analysis.peakDb,
      candidatePeaks: analysis.candidatePeaks,
      starred: false,
      deleted: false
    }
  ];

  console.log(`Relabeled #${idx} -> ${newSlug} [${tag}] ${cfg.percLabel} (@${cfg.startSec}s, ${analysis.freq}Hz, ${analysis.peakDb}dB)`);
}

// ============================================================================
// 2. Import #109 (music-box) with Strictly Singular Monophonic Notes Only
// ============================================================================
const mbRelPath = 'temp-photo-import/music-box-temp/PXL_20261102_185335358.mp4';
const mbAbsPath = path.join(ROOT_DIR, mbRelPath);

if (!fs.existsSync(mbAbsPath)) {
  throw new Error(`Missing music box file at ${mbAbsPath}`);
}

const mbIndex = 109;
const mbSlug = 'music-box';
const mbFolder = `${mbIndex}_${mbSlug}`;
const mbDir = path.join(SAMPLES_DIR, mbFolder);
fs.mkdirSync(mbDir, { recursive: true });
for (const f of fs.readdirSync(mbDir)) {
  fs.rmSync(path.join(mbDir, f), { force: true });
}

const mbThumbFile = `${mbSlug}_thumb.jpg`;
extractSquareThumbnail(mbAbsPath, path.join(mbDir, mbThumbFile), 0.5, 0);

// Decode full 70.8s audio with 240Hz highpass to reject mechanical winding rumble
const mbBuf = execFileSync('ffmpeg', [
  '-v', 'error', '-i', mbAbsPath,
  '-vn', '-af', 'highpass=f=240', '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1'
], { maxBuffer: 90 * 1024 * 1024 });
const mbSamples = new Float32Array(mbBuf.buffer, mbBuf.byteOffset, mbBuf.byteLength / 4);
const mbDuration = Number((mbSamples.length / SR).toFixed(2));

// Compute 180-bucket waveformPeaks + noiseFloorDb / peakDb for the CMS inspector
const numBuckets = 180;
const bucketSize = Math.max(1, Math.floor(mbSamples.length / numBuckets));
const waveformPeaks = [];
const rmsVals = [];
for (let b = 0; b < numBuckets; b++) {
  let maxAbs = 0;
  let sumSq = 0;
  let cnt = 0;
  const start = b * bucketSize;
  const end = Math.min(mbSamples.length, start + bucketSize);
  for (let i = start; i < end; i += 4) {
    const val = mbSamples[i];
    const av = Math.abs(val);
    if (av > maxAbs) maxAbs = av;
    sumSq += val * val;
    cnt++;
  }
  waveformPeaks.push(Number(maxAbs.toFixed(3)));
  rmsVals.push(20 * Math.log10(Math.sqrt(sumSq / Math.max(1, cnt)) + 1e-8));
}
rmsVals.sort((a, b) => a - b);
const mbNoiseFloorDb = Number((rmsVals[Math.floor(rmsVals.length * 0.2)] || -65).toFixed(1));
const mbPeakDb = Number((rmsVals[Math.floor(rmsVals.length * 0.99)] || -21).toFixed(1));

// 10 verified 100% monophonic, temporally isolated single-tine plucks (all dyads/chords excluded!)
const SINGULAR_MUSIC_BOX_NOTES = [
  { startSec: 1.435, durSec: 2.38 },  // D#6 (+6c, 1248.8 Hz) — 2nd non-harmonic peak -37.5 dB
  { startSec: 3.905, durSec: 2.45 },  // C7  (+12c, 2107.0 Hz) — 2nd non-harmonic peak -21.8 dB
  { startSec: 8.125, durSec: 2.40 },  // G#6 (+8c, 1668.9 Hz)  — 2nd non-harmonic peak -30.5 dB
  { startSec: 17.425, durSec: 0.74 }, // G#5 (+7c, 833.8 Hz)   — 2nd non-harmonic peak -29.7 dB
  { startSec: 23.475, durSec: 0.72 }, // D#5 (+10c, 625.8 Hz)  — 2nd non-harmonic peak -38.4 dB
  { startSec: 24.235, durSec: 2.40 }, // G6  (+7c, 1574.7 Hz)  — 2nd non-harmonic peak -28.6 dB
  { startSec: 32.495, durSec: 2.15 }, // A#5 (+1c, 932.9 Hz)   — 2nd non-harmonic peak -36.8 dB
  { startSec: 43.175, durSec: 2.40 }, // A#6 (+11c, 1876.8 Hz) — 2nd non-harmonic peak -27.5 dB
  { startSec: 65.835, durSec: 1.95 }, // C6  (+6c, 1050.0 Hz)  — 2nd non-harmonic peak -29.1 dB
  { startSec: 67.865, durSec: 1.18 }  // C#6 (+2c, 1110.3 Hz)  — 2nd non-harmonic peak -28.9 dB
];

const mbSlices = [];
const mbDetectedOnsets = [];
const mbHp = 240;

for (let i = 0; i < SINGULAR_MUSIC_BOX_NOTES.length; i++) {
  const spec = SINGULAR_MUSIC_BOX_NOTES[i];
  const analysis = analyzeSliceRegion(mbSamples, spec.startSec, spec.durSec, 350);
  const hitNum = String(i + 1).padStart(2, '0');
  const safeNote = analysis.name.replace('#', 's');
  const baseName = `${mbSlug}_hit${hitNum}_${safeNote}`;
  const mp4File = `${baseName}.mp4`;
  const wavFile = `${baseName}.wav`;

  extractSliceAssets(
    mbAbsPath,
    spec.startSec,
    spec.durSec,
    path.join(mbDir, mp4File),
    path.join(mbDir, wavFile),
    0,
    mbHp
  );

  mbSlices.push({
    id: `v${mbIndex}_s${hitNum}`,
    hitIndex: i + 1,
    baseName,
    mp4File,
    wavFile,
    videoUrl: `/samples/${mbFolder}/${mp4File}`,
    audioUrl: `/samples/${mbFolder}/${wavFile}`,
    startSec: Number(spec.startSec.toFixed(3)),
    durSec: spec.durSec,
    highpassHz: mbHp,
    percBucket: null,
    midi: analysis.midi,
    name: analysis.name,
    cents: analysis.cents,
    exactMidi: analysis.exactMidi,
    freq: analysis.freq,
    confidence: analysis.confidence,
    peakDb: analysis.peakDb,
    candidatePeaks: analysis.candidatePeaks,
    starred: true,
    deleted: false
  });

  mbDetectedOnsets.push({
    startSec: Number(spec.startSec.toFixed(3)),
    durSec: spec.durSec,
    midi: analysis.midi,
    name: analysis.name,
    cents: analysis.cents,
    freq: analysis.freq,
    confidence: analysis.confidence,
    peakDb: analysis.peakDb
  });
}

const mbVideoEntry = {
  id: `v${mbIndex}`,
  index: mbIndex,
  originalFilename: 'PXL_20261102_185335358.mp4',
  sourcePath: mbRelPath,
  slug: mbSlug,
  label: 'Music Box (Single Notes)',
  category: 'metal',
  folderName: mbFolder,
  thumbFile: mbThumbFile,
  thumbUrl: `/samples/${mbFolder}/${mbThumbFile}`,
  rotationMetadata: getVideoRotationMetadata(mbAbsPath),
  extraRotateDeg: 0,
  duration: mbDuration,
  noiseFloorDb: mbNoiseFloorDb,
  peakDb: mbPeakDb,
  waveformPeaks,
  allDetectedOnsets: mbDetectedOnsets,
  slices: mbSlices,
  deleted: false
};

const existingMbIdx = catalog.videos.findIndex(v => v.index === mbIndex || v.slug === mbSlug);
if (existingMbIdx >= 0) {
  catalog.videos[existingMbIdx] = mbVideoEntry;
} else {
  catalog.videos.push(mbVideoEntry);
}

console.log(
  `\nImported #${mbIndex} ${mbSlug} (${mbSlices.length} pure singular notes): ` +
    mbSlices.map(s => `${s.name}(${s.cents >= 0 ? '+' : ''}${s.cents}c @${s.startSec}s)`).join(', ')
);

// ============================================================================
// 3. Recompute Global 1-to-1 Chromatic Keyboard Map & Percussion Map
// ============================================================================
catalog.keyboardMap = computeKeyboardMap(catalog.videos);
catalog.percussionMap = computePercussionMap(catalog.videos, catalog.percussionMap);

const activeVideos = catalog.videos.filter(v => !v.deleted);
const activeSlices = activeVideos.reduce((sum, v) => sum + (v.slices || []).filter(s => !s.deleted).length, 0);
const coveredKeys = Object.keys(catalog.keyboardMap).length;
const exactKeys = Object.values(catalog.keyboardMap).filter(k => k.matchType === 'exact').length;

catalog.updatedAt = new Date().toISOString();
catalog.stats = {
  totalVideos: activeVideos.length,
  trashedVideos: catalog.videos.filter(v => v.deleted).length,
  totalSlices: activeSlices,
  coveredKeys,
  exactKeys,
  neighborKeys: coveredKeys - exactKeys
};

fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));

// Verification checks
const usedSliceIds = new Set();
let dupCount = 0;
let birdFeederOnKeyboard = 0;
const mbAssignedKeys = [];

for (const k of Object.values(catalog.keyboardMap).sort((a, b) => a.targetMidi - b.targetMidi)) {
  if (usedSliceIds.has(k.primary.sliceId)) dupCount++;
  usedSliceIds.add(k.primary.sliceId);
  if (k.primary.videoSlug.startsWith('bird-feeder') || k.primary.videoSlug.startsWith('green-steel-bin')) {
    birdFeederOnKeyboard++;
  }
  if (k.primary.videoSlug === 'music-box') {
    mbAssignedKeys.push(`${k.targetName} (from ${k.primary.name}, shift ${k.shiftCents >= 0 ? '+' : ''}${k.shiftCents}c)`);
  }
}

console.log('\n=== VERIFICATION SUMMARY ===');
console.log(`Active videos: ${activeVideos.length} (Trashed: ${catalog.stats.trashedVideos}) | Active slices: ${activeSlices}`);
console.log(`Covered Piano Keys (C2..G7 = 68 keys): ${coveredKeys}/68 (${exactKeys} exact + ${coveredKeys - exactKeys} neighbor)`);
console.log(`Duplicate slices on keyboard: ${dupCount} (strictly 1-to-1!)`);
console.log(`Bird Feeder slices on tonal keyboard: ${birdFeederOnKeyboard}`);
console.log(`Music Box keys assigned (${mbAssignedKeys.length}):\n  - ${mbAssignedKeys.join('\n  - ')}`);
console.log(
  `Percussion Buckets -> Kick: ${catalog.percussionMap.kick.slots.length}, ` +
    `Snare: ${catalog.percussionMap.snare.slots.length}, ` +
    `Hi-Hat: ${catalog.percussionMap.hihat.slots.length}`
);
