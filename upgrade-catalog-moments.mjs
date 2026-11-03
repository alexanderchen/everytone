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
if (!catalog.keyboardConfig) {
  catalog.keyboardConfig = { selectedByMidi: {}, clearedMidis: [] };
}

// ============================================================================
// 1. Import #110 Ping Pong Ball strictly into Percussion (Hi-Hat / Click)
// ============================================================================
const ppRelPath = 'temp-photo-import/ping-pong/PXL_20261102_191712716.mp4';
const ppAbsPath = path.join(ROOT_DIR, ppRelPath);

if (fs.existsSync(ppAbsPath)) {
  const ppIndex = 110;
  const ppSlug = 'ping-pong-ball';
  const ppFolder = `${ppIndex}_${ppSlug}`;
  const ppDir = path.join(SAMPLES_DIR, ppFolder);
  fs.mkdirSync(ppDir, { recursive: true });
  for (const f of fs.readdirSync(ppDir)) {
    fs.rmSync(path.join(ppDir, f), { force: true });
  }

  const ppThumbFile = `${ppSlug}_thumb.jpg`;
  extractSquareThumbnail(ppAbsPath, path.join(ppDir, ppThumbFile), 0.39, 0);

  const ppBuf = execFileSync('ffmpeg', [
    '-v', 'error', '-i', ppAbsPath,
    '-vn', '-af', 'highpass=f=130', '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1'
  ], { maxBuffer: 25 * 1024 * 1024 });
  const ppSamples = new Float32Array(ppBuf.buffer, ppBuf.byteOffset, ppBuf.byteLength / 4);
  const ppDur = Number((ppSamples.length / SR).toFixed(2));

  // Waveform peaks for CMS inspector
  const numBuckets = 180;
  const bSize = Math.max(1, Math.floor(ppSamples.length / numBuckets));
  const waveformPeaks = [];
  for (let b = 0; b < numBuckets; b++) {
    let maxAbs = 0;
    const s0 = b * bSize;
    const s1 = Math.min(ppSamples.length, s0 + bSize);
    for (let i = s0; i < s1; i += 2) {
      const av = Math.abs(ppSamples[i]);
      if (av > maxAbs) maxAbs = av;
    }
    waveformPeaks.push(Number(maxAbs.toFixed(3)));
  }

  const startSec = 0.48;
  const sliceDur = 0.72;
  const hp = 140;
  const analysis = analyzeSliceRegion(ppSamples, startSec, sliceDur, 120);

  const baseName = `${ppSlug}_hit01_HIHAT`;
  const mp4File = `${baseName}.mp4`;
  const wavFile = `${baseName}.wav`;
  extractSliceAssets(ppAbsPath, startSec, sliceDur, path.join(ppDir, mp4File), path.join(ppDir, wavFile), 0, hp);

  const ppEntry = {
    id: `v${ppIndex}`,
    index: ppIndex,
    originalFilename: 'PXL_20261102_191712716.mp4',
    sourcePath: ppRelPath,
    slug: ppSlug,
    label: 'Ping Pong Ball (Percussion)',
    category: 'percussion',
    folderName: ppFolder,
    thumbFile: ppThumbFile,
    thumbUrl: `/samples/${ppFolder}/${ppThumbFile}`,
    rotationMetadata: getVideoRotationMetadata(ppAbsPath),
    extraRotateDeg: 0,
    duration: ppDur,
    noiseFloorDb: -77.6,
    peakDb: -19.6,
    waveformPeaks,
    allDetectedOnsets: [{
      startSec,
      durSec: sliceDur,
      midi: analysis.midi,
      name: analysis.name,
      cents: analysis.cents,
      freq: analysis.freq,
      confidence: analysis.confidence,
      peakDb: analysis.peakDb
    }],
    slices: [{
      id: `v${ppIndex}_s01`,
      hitIndex: 1,
      baseName,
      mp4File,
      wavFile,
      videoUrl: `/samples/${ppFolder}/${mp4File}`,
      audioUrl: `/samples/${ppFolder}/${wavFile}`,
      startSec,
      durSec: sliceDur,
      highpassHz: hp,
      percBucket: 'hihat',
      percLabel: 'Ping Pong Ball Click',
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
    }],
    deleted: false
  };

  const existingPp = catalog.videos.findIndex(v => v.index === ppIndex || v.slug === ppSlug);
  if (existingPp >= 0) catalog.videos[existingPp] = ppEntry;
  else catalog.videos.push(ppEntry);

  console.log(`Imported #${ppIndex} ${ppSlug} -> [HIHAT] Ping Pong Ball Click (@${startSec}s)`);
}

// ============================================================================
// 2. Mark #109 Music Box slices as `isNew: true` for initial consideration badges
// ============================================================================
const mbVideo = catalog.videos.find(v => v.index === 109);
if (mbVideo) {
  for (const s of mbVideo.slices || []) {
    if (!s.deleted) s.isNew = true;
  }
}

// ============================================================================
// 3. Extract ALL remaining distinct musical moments across multi-note videos
//    (Especially #10..#14 Rubber Band + Metal Bowl, #5 Bamboo Flute, #1 Ukulele,
//     #22 Drumhead Mallet, #26 Open Strings, #27/#105..#108 Bottle Blows, #62..#68 Chimes, #78/#80 Glasses)
// ============================================================================
// Extra verified sub-bass / singing-bowl plucks discovered via 4096-pt YIN scan in #13 & #14
const EXTRA_RUBBERBAND_MOMENTS = {
  13: [
    { startSec: 22.26, durSec: 0.72 } // F#5 singing metal bowl harmonic ring
  ],
  14: [
    { startSec: 12.52, durSec: 0.88 } // D#2 deep rubber band bass pluck
  ]
};

const MULTI_MOMENT_VIDEO_INDICES = [
  1, 2, 3, 4, 5,
  10, 11, 12, 13, 14,
  18, 22, 26, 27,
  62, 63, 64, 65, 66, 67, 68,
  78, 80,
  94, 100, 105, 106, 107, 108
];

let newlyMinedSlices = 0;

for (const idx of MULTI_MOMENT_VIDEO_INDICES) {
  const v = catalog.videos.find(x => x.index === idx);
  if (!v || v.deleted || v.category === 'percussion') continue;

  const sourceAbs = path.join(ROOT_DIR, v.sourcePath);
  if (!fs.existsSync(sourceAbs)) continue;

  const isHighRinging = v.category === 'glass' || v.slug.includes('bell') || v.slug.includes('chime');
  const isRubberband = v.slug.startsWith('rubberband-bowl');
  const hpCut = isHighRinging ? 150 : isRubberband ? 55 : 80;
  const minPitchHz = isHighRinging ? 220 : isRubberband ? 55 : 65;

  const activeExisting = (v.slices || []).filter(s => !s.deleted);
  const midiCountsInVid = new Map();
  for (const s of activeExisting) {
    midiCountsInVid.set(s.midi, (midiCountsInVid.get(s.midi) || 0) + 1);
  }

  // Combine already-detected onsets + any extra verified rubberband moments
  const candidateMoments = [
    ...(v.allDetectedOnsets || []).map(o => ({ startSec: o.startSec, durSec: o.durSec, hintConf: o.confidence, hintMidi: o.midi, hintDb: o.peakDb })),
    ...(EXTRA_RUBBERBAND_MOMENTS[idx] || []).map(m => ({ startSec: m.startSec, durSec: m.durSec, hintConf: 0.9, hintMidi: 60, hintDb: -30 }))
  ];

  // Filter to moments not yet extracted (at least 0.32s away from any existing slice in this video)
  const freshMoments = candidateMoments.filter(m => {
    if (activeExisting.some(ex => Math.abs(ex.startSec - m.startSec) < 0.32)) return false;
    if (v.slug.startsWith('ukulele') && m.hintMidi < 55) return false; // Reject table thumps on ukulele
    if (m.hintConf !== undefined && m.hintConf < 0.68) return false;
    if (m.hintDb !== undefined && m.hintDb < -49) return false;
    return true;
  });

  if (freshMoments.length === 0) continue;

  // Decode audio once for this video to run accurate 4096-window YIN + FFT analysis on each fresh moment
  const pcmBuf = execFileSync('ffmpeg', [
    '-v', 'error', '-i', sourceAbs,
    '-vn', '-af', `highpass=f=${hpCut}`, '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1'
  ], { maxBuffer: 90 * 1024 * 1024 });
  const pcm = new Float32Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 4);

  const itemDir = path.join(SAMPLES_DIR, v.folderName);
  fs.mkdirSync(itemDir, { recursive: true });
  const numPrefix = String(v.index).padStart(2, '0');

  for (const m of freshMoments) {
    const analysis = analyzeSliceRegion(pcm, m.startSec, m.durSec, minPitchHz);
    if (v.slug.startsWith('ukulele') && analysis.midi < 55) continue;
    if (analysis.midi < 36 || analysis.midi > 103) continue;
    if (analysis.confidence < 0.68) continue;

    // Allow up to 2 distinct moments of the same pitch per video (3 for rubberband-bowl), unlimited distinct pitches!
    const maxSameNotePerVid = isRubberband ? 3 : 2;
    const curCount = midiCountsInVid.get(analysis.midi) || 0;
    if (curCount >= maxSameNotePerVid) continue;

    // Double check we haven't just added an overlapping slice in this loop
    if ((v.slices || []).some(ex => !ex.deleted && Math.abs(ex.startSec - m.startSec) < 0.32)) continue;

    const nextHitIdx = (v.slices || []).length + 1;
    const hitNum = String(nextHitIdx).padStart(2, '0');
    const safeNote = analysis.name.replace('#', 's');
    const baseName = `${v.slug}_hit${hitNum}_${safeNote}`;
    const mp4File = `${baseName}.mp4`;
    const wavFile = `${baseName}.wav`;

    extractSliceAssets(
      sourceAbs,
      m.startSec,
      m.durSec,
      path.join(itemDir, mp4File),
      path.join(itemDir, wavFile),
      v.extraRotateDeg || 0,
      hpCut
    );

    v.slices.push({
      id: `v${numPrefix}_s${hitNum}`,
      hitIndex: nextHitIdx,
      baseName,
      mp4File,
      wavFile,
      videoUrl: `/samples/${v.folderName}/${mp4File}`,
      audioUrl: `/samples/${v.folderName}/${wavFile}`,
      startSec: Number(m.startSec.toFixed(2)),
      durSec: Number(m.durSec.toFixed(2)),
      highpassHz: hpCut,
      percBucket: null,
      midi: analysis.midi,
      name: analysis.name,
      cents: analysis.cents,
      exactMidi: analysis.exactMidi,
      freq: analysis.freq,
      confidence: analysis.confidence,
      peakDb: analysis.peakDb,
      candidatePeaks: analysis.candidatePeaks,
      starred: isRubberband,
      isNew: true,
      deleted: false
    });

    midiCountsInVid.set(analysis.midi, curCount + 1);
    newlyMinedSlices++;
    console.log(`  + Mined #${idx} ${v.slug} @${m.startSec}s -> ${analysis.name} (${analysis.cents >= 0 ? '+' : ''}${analysis.cents}c, ${analysis.freq}Hz)`);
  }

  // Sort slices chronologically within the video
  v.slices.sort((a, b) => a.startSec - b.startSec);
}

// ============================================================================
// 4. Compute Persistent Nearest-Note Keyboard Config & Percussion Map
// ============================================================================
// Clear previous auto-selected map once so initial Go-To Set picks cleanest nearest-note candidates (with rubberband bowls prioritized!)
catalog.keyboardConfig = { selectedByMidi: {}, clearedMidis: [] };
catalog.keyboardMap = computeKeyboardMap(catalog.videos, catalog.keyboardConfig);
catalog.percussionMap = computePercussionMap(catalog.videos, catalog.percussionMap);

const activeVideos = catalog.videos.filter(v => !v.deleted);
const activeSlices = activeVideos.reduce((sum, v) => sum + (v.slices || []).filter(s => !s.deleted).length, 0);
const keyEntries = Object.values(catalog.keyboardMap);
const coveredKeys = keyEntries.filter(k => !!k.primary).length;
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
  keysWithCandidates: keyEntries.length,
  totalCandidates,
  newConsiderations,
  exactKeys: coveredKeys,
  neighborKeys: 0,
  percCount
};

fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));

const rbPrimaryKeys = keyEntries
  .filter(k => k.primary?.videoSlug.startsWith('rubberband-bowl'))
  .map(k => k.targetName);
const rbCandidateKeys = keyEntries
  .filter(k => k.candidates.some(c => c.videoSlug.startsWith('rubberband-bowl')))
  .map(k => k.targetName);

console.log(`\n=== CATALOG UPGRADE COMPLETE ===`);
console.log(`Newly mined distinct moments: ${newlyMinedSlices}`);
console.log(`Active videos: ${activeVideos.length} | Total extracted slices: ${activeSlices}`);
console.log(`Nearest-Note Configured Keys (<= ±50c micro-tune only!): ${coveredKeys} / 68 (${totalCandidates} tonal candidates, ${newConsiderations} marked NEW)`);
console.log(`Rubberband Bowl active primary on ${rbPrimaryKeys.length} keys: [${rbPrimaryKeys.join(', ')}]`);
console.log(`Rubberband Bowl available across ${rbCandidateKeys.length} keys: [${rbCandidateKeys.join(', ')}]`);
console.log(`Percussion Buckets -> Kick: ${catalog.percussionMap.kick.slots.length}, Snare: ${catalog.percussionMap.snare.slots.length}, Hi-Hat: ${catalog.percussionMap.hihat.slots.length}`);
