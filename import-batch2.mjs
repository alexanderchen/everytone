import fs from 'fs';
import path from 'path';
import {
  analyzeVideoAudio,
  extractSquareThumbnail,
  extractSliceAssets,
  computeKeyboardMap,
  computePercussionMap
} from './dsp-pipeline.mjs';

const ROOT_DIR = process.cwd();
const BATCH2_DIR = path.join(ROOT_DIR, 'temp-photo-import', 'Photos-1-001 (5)');
const SAMPLES_DIR = path.join(ROOT_DIR, 'samples');
const CATALOG_PATH = path.join(ROOT_DIR, 'catalog.json');

// Concise shorthand metadata from inspecting the 80 opening frames (028 to 107)
const BATCH2_META = [
  { idx: 28, slug: 'brass-turn-doorbell', category: 'metal', label: 'Brass Turn Doorbell' },
  { idx: 29, slug: 'antique-bell-dome', category: 'metal', label: 'Antique Doorbell Dome' },
  { idx: 30, slug: 'metal-tank-mallet-1', category: 'metal', label: 'Metal Tank Mallet 1' },
  { idx: 31, slug: 'metal-tank-mallet-2', category: 'metal', label: 'Metal Tank Mallet 2' },
  { idx: 32, slug: 'ac-housing-mallet', category: 'metal', label: 'AC Housing Mallet' },
  { idx: 33, slug: 'white-mailbox', category: 'metal', label: 'White Metal Mailbox' },
  { idx: 34, slug: 'silver-bike-bell-4', category: 'metal', label: 'Silver Bike Bell 4' },
  { idx: 35, slug: 'silver-bike-bell-5', category: 'metal', label: 'Silver Bike Bell 5' },
  { idx: 36, slug: 'unicorn-bike-bell', category: 'metal', label: 'Unicorn Bike Bell' },
  { idx: 37, slug: 'cellar-door-mallet-1', category: 'metal', label: 'Cellar Door Mallet 1' },
  { idx: 38, slug: 'cellar-door-mallet-2', category: 'metal', label: 'Cellar Door Mallet 2' },
  { idx: 39, slug: 'cellar-door-mallet-3', category: 'metal', label: 'Cellar Door Mallet 3' },
  { idx: 40, slug: 'wood-log-mallet-01', category: 'toms', label: 'Wood Log Mallet 01' },
  { idx: 41, slug: 'wood-log-mallet-02', category: 'toms', label: 'Wood Log Mallet 02' },
  { idx: 42, slug: 'wood-log-mallet-03', category: 'toms', label: 'Wood Log Mallet 03' },
  { idx: 43, slug: 'wood-log-mallet-04', category: 'toms', label: 'Wood Log Mallet 04' },
  { idx: 44, slug: 'wood-log-mallet-05', category: 'toms', label: 'Wood Log Mallet 05' },
  { idx: 45, slug: 'wood-log-mallet-06', category: 'toms', label: 'Wood Log Mallet 06' },
  { idx: 46, slug: 'wood-log-mallet-07', category: 'toms', label: 'Wood Log Mallet 07' },
  { idx: 47, slug: 'wood-log-mallet-08', category: 'toms', label: 'Wood Log Mallet 08' },
  { idx: 48, slug: 'wood-log-mallet-09', category: 'toms', label: 'Wood Log Mallet 09' },
  { idx: 49, slug: 'wood-log-mallet-10', category: 'toms', label: 'Wood Log Mallet 10' },
  { idx: 50, slug: 'wood-log-mallet-11', category: 'toms', label: 'Wood Log Mallet 11' },
  { idx: 51, slug: 'wood-log-mallet-12', category: 'toms', label: 'Wood Log Mallet 12' },
  { idx: 52, slug: 'wood-log-mallet-13', category: 'toms', label: 'Wood Log Mallet 13' },
  { idx: 53, slug: 'stone-planter-1', category: 'glass', label: 'Stone Planter Pot 1' },
  { idx: 54, slug: 'stone-planter-2', category: 'glass', label: 'Stone Planter Pot 2' },
  { idx: 55, slug: 'green-steel-bin-1', category: 'metal', label: 'Green Steel Bin 1' },
  { idx: 56, slug: 'green-steel-bin-2', category: 'metal', label: 'Green Steel Bin 2' },
  { idx: 57, slug: 'green-steel-bin-3', category: 'metal', label: 'Green Steel Bin 3' },
  { idx: 58, slug: 'green-steel-bin-4', category: 'metal', label: 'Green Steel Bin 4' },
  { idx: 59, slug: 'green-steel-bin-5', category: 'metal', label: 'Green Steel Bin 5' },
  { idx: 60, slug: 'porcelain-crank-bell', category: 'metal', label: 'Porcelain Crank Doorbell' },
  { idx: 61, slug: 'wind-chime-tube-1', category: 'metal', label: 'Wind Chime Tube 1' },
  { idx: 62, slug: 'wind-chime-tube-2', category: 'metal', label: 'Wind Chime Tube 2' },
  { idx: 63, slug: 'wind-chime-tube-3', category: 'metal', label: 'Wind Chime Tube 3' },
  { idx: 64, slug: 'wind-chime-tube-4', category: 'metal', label: 'Wind Chime Tube 4' },
  { idx: 65, slug: 'wind-chime-tube-5', category: 'metal', label: 'Wind Chime Tube 5' },
  { idx: 66, slug: 'wind-chime-tube-6', category: 'metal', label: 'Wind Chime Tube 6' },
  { idx: 67, slug: 'wind-chime-tube-7', category: 'metal', label: 'Wind Chime Tube 7' },
  { idx: 68, slug: 'wind-chime-tube-8', category: 'metal', label: 'Wind Chime Tube 8' },
  { idx: 69, slug: 'wind-chime-tube-9', category: 'metal', label: 'Wind Chime Tube 9' },
  { idx: 70, slug: 'faceted-glass-01', category: 'glass', label: 'Faceted Water Glass 01' },
  { idx: 71, slug: 'etched-glass-01', category: 'glass', label: 'Etched Water Glass 01' },
  { idx: 72, slug: 'etched-glass-02', category: 'glass', label: 'Etched Water Glass 02' },
  { idx: 73, slug: 'faceted-glass-02', category: 'glass', label: 'Faceted Water Glass 02' },
  { idx: 74, slug: 'faceted-glass-03', category: 'glass', label: 'Faceted Water Glass 03' },
  { idx: 75, slug: 'faceted-glass-04', category: 'glass', label: 'Faceted Water Glass 04' },
  { idx: 76, slug: 'faceted-glass-05', category: 'glass', label: 'Faceted Water Glass 05' },
  { idx: 77, slug: 'faceted-glass-06', category: 'glass', label: 'Faceted Water Glass 06' },
  { idx: 78, slug: 'wine-glass-tuned-01', category: 'glass', label: 'Tuned Wine Glass 01' },
  { idx: 79, slug: 'wine-glass-tuned-02', category: 'glass', label: 'Tuned Wine Glass 02' },
  { idx: 80, slug: 'wine-glass-tuned-03', category: 'glass', label: 'Tuned Wine Glass 03' },
  { idx: 81, slug: 'wine-glass-tuned-04', category: 'glass', label: 'Tuned Wine Glass 04' },
  { idx: 82, slug: 'wine-glass-tuned-05', category: 'glass', label: 'Tuned Wine Glass 05' },
  { idx: 83, slug: 'wine-glass-tuned-06', category: 'glass', label: 'Tuned Wine Glass 06' },
  { idx: 84, slug: 'wine-glass-tuned-07', category: 'glass', label: 'Tuned Wine Glass 07' },
  { idx: 85, slug: 'wine-glass-tuned-08', category: 'glass', label: 'Tuned Wine Glass 08' },
  { idx: 86, slug: 'wine-glass-tuned-09', category: 'glass', label: 'Tuned Wine Glass 09' },
  { idx: 87, slug: 'hex-jar-glass-1', category: 'glass', label: 'Hexagon Glass Jar 1' },
  { idx: 88, slug: 'hex-jar-glass-2', category: 'glass', label: 'Hexagon Glass Jar 2' },
  { idx: 89, slug: 'swingtop-glass-bottle', category: 'winds', label: 'Swing-Top Bottle Blow' },
  { idx: 90, slug: 'painted-tumbler-glass', category: 'glass', label: 'Painted Glass Tumbler' },
  { idx: 91, slug: 'crystal-goblet-glass', category: 'glass', label: 'Crystal Goblet Glass' },
  { idx: 92, slug: 'small-jar-glass-1', category: 'glass', label: 'Small Glass Jar 1' },
  { idx: 93, slug: 'ribbed-tumbler-glass', category: 'glass', label: 'Ribbed Glass Tumbler' },
  { idx: 94, slug: 'blue-bottle-blow-1', category: 'winds', label: 'Blue Bottle Blow 1' },
  { idx: 95, slug: 'blue-bottle-blow-2', category: 'winds', label: 'Blue Bottle Blow 2' },
  { idx: 96, slug: 'blue-bottle-blow-3', category: 'winds', label: 'Blue Bottle Blow 3' },
  { idx: 97, slug: 'purple-bottle-blow-1', category: 'winds', label: 'Purple Bottle Blow 1' },
  { idx: 98, slug: 'purple-bottle-blow-2', category: 'winds', label: 'Purple Bottle Blow 2' },
  { idx: 99, slug: 'purple-bottle-blow-3', category: 'winds', label: 'Purple Bottle Blow 3' },
  { idx: 100, slug: 'purple-bottle-blow-4', category: 'winds', label: 'Purple Bottle Blow 4' },
  { idx: 101, slug: 'wide-thermos-blow-1', category: 'winds', label: 'Wide Thermos Blow 1' },
  { idx: 102, slug: 'wide-thermos-blow-2', category: 'winds', label: 'Wide Thermos Blow 2' },
  { idx: 103, slug: 'wide-thermos-blow-3', category: 'winds', label: 'Wide Thermos Blow 3' },
  { idx: 104, slug: 'wide-thermos-blow-4', category: 'winds', label: 'Wide Thermos Blow 4' },
  { idx: 105, slug: 'silver-flask-blow-1', category: 'winds', label: 'Silver Flask Blow 1' },
  { idx: 106, slug: 'silver-flask-blow-2', category: 'winds', label: 'Silver Flask Blow 2' },
  { idx: 107, slug: 'silver-flask-blow-3', category: 'winds', label: 'Silver Flask Blow 3' }
];

const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));

// 1. Update batch 1 sourcePaths now that "photo downloads 1 " is inside "temp-photo-import/"
for (const v of catalog.videos) {
  if (v.sourcePath && v.sourcePath.startsWith('photo downloads 1 /')) {
    v.sourcePath = `temp-photo-import/${v.sourcePath}`;
  }
}

const existingOriginalFiles = new Set(catalog.videos.map(v => v.originalFilename));
const batch2Files = fs
  .readdirSync(BATCH2_DIR)
  .filter(f => f.toLowerCase().endsWith('.mp4') && !existingOriginalFiles.has(f))
  .sort();

console.log(`Importing ${batch2Files.length} new videos from "${BATCH2_DIR}"...`);

for (let i = 0; i < batch2Files.length; i++) {
  const rawName = batch2Files[i];
  const rawPath = path.join(BATCH2_DIR, rawName);
  const meta = BATCH2_META[i] || {
    idx: 28 + i,
    slug: `object-${28 + i}`,
    category: 'glass',
    label: `Object ${28 + i}`
  };

  const numPrefix = String(meta.idx).padStart(2, '0');
  const folderName = `${numPrefix}_${meta.slug}`;
  const itemDir = path.join(SAMPLES_DIR, folderName);
  fs.mkdirSync(itemDir, { recursive: true });

  // Run DSP onset & pitch analysis first so we can grab thumbnail when object is in frame if needed
  const audioData = analyzeVideoAudio(rawPath);

  // Keep top 2 cleanest slices per new single-object video so library stays super curated
  const topSlices = [...audioData.selectedSlices]
    .sort((a, b) => (b.confidence * 2 + b.peakDb / 30) - (a.confidence * 2 + a.peakDb / 30))
    .slice(0, 2)
    .sort((a, b) => a.startSec - b.startSec);

  // Extract 512x512 square thumbnail (use 1.5s for #94 where bottle enters after 0.5s, otherwise 0.1s)
  const thumbTime = meta.idx === 94 ? 1.8 : 0.1;
  const thumbFile = `${meta.slug}_thumb.jpg`;
  const thumbPath = path.join(itemDir, thumbFile);
  extractSquareThumbnail(rawPath, thumbPath, thumbTime, 0);

  const slices = [];
  for (let sIdx = 0; sIdx < topSlices.length; sIdx++) {
    const s = topSlices[sIdx];
    const hitNum = String(sIdx + 1).padStart(2, '0');
    const safeNote = s.name.replace('#', 's');
    const baseSliceName = `${meta.slug}_hit${hitNum}_${safeNote}`;
    const mp4File = `${baseSliceName}.mp4`;
    const wavFile = `${baseSliceName}.wav`;

    extractSliceAssets(
      rawPath,
      s.startSec,
      s.durSec,
      path.join(itemDir, mp4File),
      path.join(itemDir, wavFile),
      0,
      85
    );

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
      highpassHz: 85,
      percBucket: null,
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

  catalog.videos.push({
    id: `v${numPrefix}`,
    index: meta.idx,
    originalFilename: rawName,
    sourcePath: `temp-photo-import/Photos-1-001 (5)/${rawName}`,
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
  });

  const noteSummary = slices.map(sl => `${sl.name}(${sl.cents >= 0 ? '+' : ''}${sl.cents}c)`).join(', ');
  console.log(`[${meta.idx}/107] ${folderName} -> ${noteSummary}`);
}

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
console.log(`\nFinished importing all ${catalog.stats.totalVideos} videos!`);
console.log(`Total slices: ${activeSlices}`);
console.log(`Keyboard coverage: ${coveredKeys} keys (${exactKeys} exact + ${coveredKeys - exactKeys} neighbor)`);
