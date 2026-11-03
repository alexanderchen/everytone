import fs from 'fs';
import path from 'path';
import {
  INITIAL_VIDEO_META,
  analyzeVideoAudio,
  extractSquareThumbnail,
  extractSliceAssets,
  computeKeyboardMap
} from './dsp-pipeline.mjs';

const ROOT_DIR = process.cwd();
const RAW_DIR = path.join(ROOT_DIR, 'photo downloads 1 ');
const SAMPLES_DIR = path.join(ROOT_DIR, 'samples');
const TRASH_DIR = path.join(ROOT_DIR, '_trash');
const CATALOG_PATH = path.join(ROOT_DIR, 'catalog.json');

fs.mkdirSync(SAMPLES_DIR, { recursive: true });
fs.mkdirSync(TRASH_DIR, { recursive: true });

const rawFiles = fs.readdirSync(RAW_DIR).filter(f => f.toLowerCase().endsWith('.mp4')).sort();

console.log(`Scanning ${rawFiles.length} source videos from "${RAW_DIR}"...`);

const videos = [];

for (let i = 0; i < rawFiles.length; i++) {
  const rawName = rawFiles[i];
  const rawPath = path.join(RAW_DIR, rawName);
  const meta = INITIAL_VIDEO_META[rawName] || {
    idx: i + 1,
    slug: `object-${String(i + 1).padStart(2, '0')}`,
    category: 'misc',
    label: `Object ${i + 1}`
  };

  const numPrefix = String(meta.idx).padStart(2, '0');
  const folderName = `${numPrefix}_${meta.slug}`;
  const itemDir = path.join(SAMPLES_DIR, folderName);
  fs.mkdirSync(itemDir, { recursive: true });

  // 1. Extract 512x512 square opening frame thumbnail
  const thumbFile = `${meta.slug}_thumb.jpg`;
  const thumbPath = path.join(itemDir, thumbFile);
  extractSquareThumbnail(rawPath, thumbPath, 0.1, 0);

  // 2. Run DSP onset & pitch analysis
  const audioData = analyzeVideoAudio(rawPath);

  // 3. Extract co-located silent 512x512 MP4 + clean WAV for each selected slice
  const slices = [];
  for (let sIdx = 0; sIdx < audioData.selectedSlices.length; sIdx++) {
    const s = audioData.selectedSlices[sIdx];
    const hitNum = String(sIdx + 1).padStart(2, '0');
    const safeNote = s.name.replace('#', 's');
    const baseSliceName = `${meta.slug}_hit${hitNum}_${safeNote}`;
    const mp4File = `${baseSliceName}.mp4`;
    const wavFile = `${baseSliceName}.wav`;
    const mp4Path = path.join(itemDir, mp4File);
    const wavPath = path.join(itemDir, wavFile);

    extractSliceAssets(rawPath, s.startSec, s.durSec, mp4Path, wavPath, 0, 85);

    slices.push({
      id: `v${numPrefix}_s${hitNum}`,
      hitIndex: sIdx + 1,
      baseName: baseSliceName,
      mp4File,
      wavFile,
      videoUrl: `/samples/${folderName}/${mp4File}`,
      audioUrl: `/samples/${folderName}/${wavFile}`,
      startSec: s.startSec,
      durSec: s.durSec,
      midi: s.midi,
      name: s.name,
      cents: s.cents,
      exactMidi: s.exactMidi,
      freq: s.freq,
      confidence: s.confidence,
      peakDb: s.peakDb,
      candidatePeaks: s.candidatePeaks,
      starred: sIdx === 0,
      deleted: false
    });
  }

  const videoEntry = {
    id: `v${numPrefix}`,
    index: meta.idx,
    originalFilename: rawName,
    sourcePath: `photo downloads 1 /${rawName}`,
    folderName,
    slug: meta.slug,
    label: meta.label,
    category: meta.category,
    extraRotateDeg: 0,
    thumbFile,
    thumbUrl: `/samples/${folderName}/${thumbFile}`,
    duration: audioData.duration,
    noiseFloorDb: audioData.noiseFloorDb,
    peakDb: audioData.peakDb,
    waveformPeaks: audioData.waveformPeaks,
    allDetectedOnsets: audioData.allDetectedOnsets,
    slices,
    deleted: false
  };

  videos.push(videoEntry);
  const noteList = slices.map(sl => `${sl.name}(${sl.cents >= 0 ? '+' : ''}${sl.cents}c)`).join(', ');
  console.log(`[${numPrefix}/27] ${folderName} -> ${slices.length} slices: ${noteList}`);
}

const keyboardMap = computeKeyboardMap(videos);
const coveredKeys = Object.keys(keyboardMap).length;
const exactKeys = Object.values(keyboardMap).filter(k => k.matchType === 'exact').length;

const catalog = {
  version: 1,
  updatedAt: new Date().toISOString(),
  stats: {
    totalVideos: videos.length,
    totalSlices: videos.reduce((acc, v) => acc + v.slices.length, 0),
    coveredKeys,
    exactKeys,
    neighborKeys: coveredKeys - exactKeys
  },
  videos,
  keyboardMap
};

fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));
console.log(`\nCatalog saved to catalog.json!`);
console.log(`Total active slices: ${catalog.stats.totalSlices}`);
console.log(`Chromatic Keyboard Coverage (C2-G7): ${coveredKeys} keys (${exactKeys} exact native + ${coveredKeys - exactKeys} via ±1 semitone shift)`);
