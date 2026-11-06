import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  SR,
  MAX_CLIP_DUR,
  getVideoRotationMetadata,
  extractSquareThumbnail,
  extractSliceAssets,
  analyzeSliceRegion,
  getEffectiveSliceMidi,
  computeKeyboardMap,
  enableVideoSlicesByDefault,
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

function loadMonoSamples(filePath, highpassHz = 55) {
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

// Portrait bugle crop: keep upright portrait orientation (extraRotateDeg = 90 on raw -noautorotate 1920x1080)
// and crop 75% down the vertical slack (halfway between vertical middle 50% and very bottom 100%):
// x = (1920 - 1080) * 0.75 = 630 -> cropLeftFrac = 630 / 1920 = 0.328125.
const BUGLE_PORTRAIT_LOWER_CROP_FRAC = 0.328125;

const NEW_BATCH = [
  {
    index: 132,
    file: 'PXL_20261106_122716100.mp4',
    slug: 'bird-call-1',
    label: 'Wooden Bird Call 1',
    groupName: 'bird call',
    category: 'winds',
    extraRotateDeg: 0, // Portrait (-90) rotated to upright landscape via -noautorotate
    thumbSec: 4.90,
    hp: 250,
    minHz: 350,
    moments: [
      { startSec: 3.39, durSec: 0.68 },
      { startSec: 4.86, durSec: 0.68 },
      { startSec: 10.17, durSec: 0.45 },
      { startSec: 13.88, durSec: 0.48 },
      { startSec: 17.36, durSec: 0.75 }
    ]
  },
  {
    index: 133,
    file: 'PXL_20261106_122744016.mp4',
    slug: 'bird-call-2',
    label: 'Wooden Bird Call 2',
    groupName: 'bird call',
    category: 'winds',
    extraRotateDeg: 0, // Portrait (-90) rotated to upright landscape via -noautorotate
    thumbSec: 3.30,
    hp: 250,
    minHz: 350,
    moments: [
      { startSec: 0.15, durSec: 0.60 },
      { startSec: 4.84, durSec: 0.60 },
      { startSec: 7.80, durSec: 0.72 },
      { startSec: 8.33, durSec: 0.55 },
      { startSec: 12.69, durSec: 0.65 },
      { startSec: 16.22, durSec: 0.40 }
    ]
  },
  {
    index: 134,
    file: 'PXL_20261106_123001375.mp4',
    slug: 'bird-call-3',
    label: 'Wooden Bird Whistle',
    groupName: 'bird call',
    category: 'winds',
    extraRotateDeg: 0, // Already landscape (rot = 0)
    thumbSec: 9.75,
    hp: 500,
    minHz: 750,
    moments: [
      { startSec: 0.12, durSec: 0.42 },
      { startSec: 1.20, durSec: 0.35 },
      { startSec: 2.64, durSec: 0.35 },
      { startSec: 3.25, durSec: 0.55 },
      { startSec: 6.33, durSec: 0.42 },
      { startSec: 8.20, durSec: 0.38 },
      { startSec: 10.90, durSec: 0.38 },
      { startSec: 14.48, durSec: 0.38 },
      { startSec: 15.53, durSec: 0.35 },
      { startSec: 16.27, durSec: 0.35 }
    ]
  },
  {
    index: 135,
    file: 'PXL_20261106_123521528.mp4',
    slug: 'brass-bugle-1',
    label: 'Brass Bugle 1',
    groupName: 'brass bugle',
    category: 'winds',
    extraRotateDeg: 90,
    cropLeftFrac: BUGLE_PORTRAIT_LOWER_CROP_FRAC,
    thumbSec: 2.95,
    hp: 90,
    minHz: 150,
    moments: [
      { startSec: 2.18, durSec: 0.38 },
      { startSec: 2.90, durSec: 0.76 },
      { startSec: 3.84, durSec: 0.32 },
      { startSec: 4.14, durSec: 0.42 },
      { startSec: 8.08, durSec: 0.38 }
    ]
  },
  {
    index: 136,
    file: 'PXL_20261106_123618519.mp4',
    slug: 'brass-bugle-2',
    label: 'Brass Bugle 2',
    groupName: 'brass bugle',
    category: 'winds',
    extraRotateDeg: 90,
    cropLeftFrac: BUGLE_PORTRAIT_LOWER_CROP_FRAC,
    thumbSec: 3.20,
    hp: 90,
    minHz: 150,
    moments: [
      { startSec: 0.66, durSec: 1.32 },
      { startSec: 4.36, durSec: 0.90 },
      { startSec: 5.76, durSec: 0.62 },
      { startSec: 6.45, durSec: 0.95 },
      { startSec: 8.01, durSec: 0.62 }
    ]
  },
  {
    index: 137,
    file: 'PXL_20261106_123654300.mp4',
    slug: 'brass-bugle-3',
    label: 'Brass Bugle 3',
    groupName: 'brass bugle',
    category: 'winds',
    extraRotateDeg: 90,
    cropLeftFrac: BUGLE_PORTRAIT_LOWER_CROP_FRAC,
    thumbSec: 4.30,
    hp: 90,
    minHz: 150,
    moments: [
      { startSec: 0.88, durSec: 1.35 },
      { startSec: 4.22, durSec: 0.90 },
      { startSec: 7.56, durSec: 0.70 },
      { startSec: 9.44, durSec: 0.48 }
    ]
  },
  {
    index: 138,
    file: 'PXL_20261106_123725445.mp4',
    slug: 'brass-bugle-4',
    label: 'Brass Bugle 4',
    groupName: 'brass bugle',
    category: 'winds',
    extraRotateDeg: 90,
    cropLeftFrac: BUGLE_PORTRAIT_LOWER_CROP_FRAC,
    thumbSec: 2.40,
    hp: 90,
    minHz: 150,
    moments: [
      { startSec: 5.99, durSec: 0.45 },
      { startSec: 7.54, durSec: 0.90 },
      { startSec: 8.92, durSec: 0.48 },
      { startSec: 9.84, durSec: 0.62 },
      { startSec: 12.79, durSec: 0.50 },
      { startSec: 13.72, durSec: 0.48 }
    ]
  },
  {
    index: 139,
    file: 'PXL_20261106_124323955.mp4',
    slug: 'wooden-recorder',
    label: 'Wooden Recorder',
    groupName: 'wooden recorder',
    category: 'winds',
    extraRotateDeg: 0, // Portrait (-90) rotated to upright landscape via -noautorotate
    thumbSec: 4.00,
    hp: 220,
    minHz: 450,
    moments: [
      { startSec: 3.80, durSec: 0.84 },
      { startSec: 10.40, durSec: 0.98 },
      { startSec: 11.40, durSec: 0.32 },
      { startSec: 11.72, durSec: 0.54 },
      { startSec: 20.55, durSec: 0.42 }
    ]
  },
  {
    index: 140,
    file: 'PXL_20261106_124650204.mp4',
    slug: 'wet-leaf-1',
    label: 'Wet Leaf Drops 1 (Percussion)',
    groupName: 'wet leaf',
    category: 'percussion',
    extraRotateDeg: 0,
    gainDb: 6,
    thumbSec: 1.50,
    hp: 55,
    minHz: 60,
    moments: [
      { startSec: 1.26, durSec: 0.70, hp: 160, minHz: 250, percBucket: 'hihat', percLabel: 'Wet Leaf Droplet Snap 1' },
      { startSec: 4.56, durSec: 0.70, hp: 160, minHz: 250, percBucket: 'hihat', percLabel: 'Wet Leaf Droplet Snap 2' },
      { startSec: 10.57, durSec: 0.80, hp: 55, minHz: 60, percBucket: 'kick', percLabel: 'Wet Leaf Thud 1' },
      { startSec: 15.18, durSec: 0.75, hp: 55, minHz: 60, percBucket: 'kick', percLabel: 'Wet Leaf Thud 2' }
    ]
  },
  {
    index: 141,
    file: 'PXL_20261106_124720097.mp4',
    slug: 'wet-leaf-2',
    label: 'Wet Leaf Drops 2 (Percussion)',
    groupName: 'wet leaf',
    category: 'percussion',
    extraRotateDeg: 0,
    gainDb: 8,
    thumbSec: 1.50,
    hp: 55,
    minHz: 60,
    moments: [
      { startSec: 1.54, durSec: 0.70, hp: 80, minHz: 75, percBucket: 'snare', percLabel: 'Wet Leaf Tap 1' },
      { startSec: 3.78, durSec: 0.60, hp: 55, minHz: 60, percBucket: 'kick', percLabel: 'Wet Leaf Thump' },
      { startSec: 8.69, durSec: 0.75, hp: 80, minHz: 80, percBucket: 'snare', percLabel: 'Wet Leaf Tap 2' },
      { startSec: 13.40, durSec: 0.55, hp: 80, minHz: 80, percBucket: 'snare', percLabel: 'Wet Leaf Tap 3' }
    ]
  }
];

const importedEntries = [];

for (const cfg of NEW_BATCH) {
  const srcTempPath = path.join(TEMP_DIR, cfg.file);
  const folderName = `${cfg.index}_${cfg.slug}`;
  const outDir = path.join(SAMPLES_DIR, folderName);
  fs.mkdirSync(outDir, { recursive: true });

  const sourceFile = `${cfg.slug}_source.mp4`;
  const colocatedAbs = path.join(outDir, sourceFile);
  if (fs.existsSync(srcTempPath)) {
    cloneOrCopyFile(srcTempPath, colocatedAbs);
  } else if (!fs.existsSync(colocatedAbs)) {
    throw new Error(`Missing source file for ${cfg.slug}: ${srcTempPath}`);
  }

  // Clean out any stale slice MP4/WAV files in outDir before writing curated slices
  for (const existing of fs.readdirSync(outDir)) {
    if (existing.includes('_hit') && (existing.endsWith('.mp4') || existing.endsWith('.wav'))) {
      fs.unlinkSync(path.join(outDir, existing));
    }
  }

  const thumbFile = `${cfg.slug}_thumb.jpg`;
  extractSquareThumbnail(
    colocatedAbs,
    path.join(outDir, thumbFile),
    cfg.thumbSec,
    cfg.extraRotateDeg || 0,
    cfg.cropLeftFrac ?? null
  );

  const baseSamples = loadMonoSamples(colocatedAbs, Math.min(cfg.hp, 120));
  const duration = Number((baseSamples.length / SR).toFixed(2));
  const { waveformPeaks, noiseFloorDb, peakDb } = computeWaveformAndStats(baseSamples);

  const sampleCacheByHp = new Map();
  const getSamplesForHp = hp => {
    if (!sampleCacheByHp.has(hp)) {
      sampleCacheByHp.set(hp, loadMonoSamples(colocatedAbs, hp));
    }
    return sampleCacheByHp.get(hp);
  };

  const chosenMoments = cfg.moments.map(m => {
    const sliceHp = m.hp ?? cfg.hp;
    const sliceMinHz = m.minHz ?? cfg.minHz;
    const clampedDur = Number(Math.min(MAX_CLIP_DUR, m.durSec).toFixed(2));
    const a = analyzeSliceRegion(getSamplesForHp(sliceHp), m.startSec, clampedDur, sliceMinHz);
    return {
      startSec: m.startSec,
      durSec: clampedDur,
      hp: sliceHp,
      percBucket: m.percBucket || null,
      percLabel: m.percLabel || null,
      ...a
    };
  });

  const allDetectedOnsets = chosenMoments.map(o => ({
    startSec: o.startSec,
    durSec: o.durSec,
    midi: o.midi,
    name: o.name,
    cents: o.cents,
    freq: o.freq,
    confidence: o.confidence,
    peakDb: o.peakDb
  }));

  const slices = [];
  const isPercVideo = cfg.category === 'percussion';

  for (let i = 0; i < chosenMoments.length; i++) {
    const m = chosenMoments[i];
    const durSec = m.durSec;
    const hitIdx = i + 1;
    const hitTag = String(hitIdx).padStart(2, '0');
    const safeNote = m.percBucket ? m.percBucket.toUpperCase() : m.name.replace('#', 's');
    const baseName = `${cfg.slug}_hit${hitTag}_${safeNote}`;
    const mp4File = `${baseName}.mp4`;
    const wavFile = `${baseName}.wav`;

    extractSliceAssets(
      colocatedAbs,
      m.startSec,
      durSec,
      path.join(outDir, mp4File),
      path.join(outDir, wavFile),
      cfg.extraRotateDeg || 0,
      m.hp,
      cfg.cropLeftFrac ?? null
    );

    const sliceObj = {
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
      highpassHz: m.hp,
      midi: m.midi,
      name: m.name,
      cents: m.cents,
      exactMidi: m.exactMidi,
      freq: m.freq,
      confidence: m.confidence,
      peakDb: m.peakDb,
      candidatePeaks: m.candidatePeaks,
      isNew: true,
      starred: false,
      deleted: false
    };

    if (m.percBucket) {
      sliceObj.percBucket = m.percBucket;
    }
    if (m.percLabel) {
      sliceObj.percLabel = m.percLabel;
    }
    if (!isPercVideo) {
      sliceObj.dspOriginal = {
        midi: m.midi,
        name: m.name,
        cents: m.cents,
        exactMidi: m.exactMidi,
        freq: m.freq
      };
    }

    slices.push(sliceObj);
  }

  const videoEntry = {
    id: `v${cfg.index}`,
    index: cfg.index,
    originalFilename: cfg.file,
    sourceFile,
    sourcePath: `samples/${folderName}/${sourceFile}`,
    slug: cfg.slug,
    label: cfg.label,
    groupName: cfg.groupName,
    category: cfg.category,
    folderName,
    thumbFile,
    thumbUrl: `/samples/${folderName}/${thumbFile}`,
    rotationMetadata: getVideoRotationMetadata(colocatedAbs),
    extraRotateDeg: cfg.extraRotateDeg || 0,
    ...(Number.isFinite(cfg.cropLeftFrac) ? { cropLeftFrac: cfg.cropLeftFrac } : {}),
    ...(Number.isFinite(cfg.gainDb) ? { gainDb: cfg.gainDb } : {}),
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
      slices
        .map(s =>
          isPercVideo
            ? `${s.percBucket}->MIDI${getEffectiveSliceMidi(videoEntry, s)}(${s.freq}Hz)`
            : `${s.name}(${s.cents >= 0 ? '+' : ''}${s.cents}c)`
        )
        .join(', ')
  );
}

// Re-read catalog.json right before saving so live UI settings are preserved
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

catalog.videos.sort((a, b) => a.index - b.index);
catalog.keyboardMap = enableVideoSlicesByDefault(
  catalog.videos,
  importedEntries,
  catalog.keyboardConfig
);
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
  `\nSaved catalog.json -> ${activeVideos.length} active videos | ${activeSlices} slices | ${coveredKeys}/${keysWithCandidates} keys active | ${totalCandidates} total candidates | ${percCount} perc slots!`
);
