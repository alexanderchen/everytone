import fs from 'fs';
import path from 'path';
import {
  analyzeVideoAudio,
  extractSliceAssets,
  computeKeyboardMap,
  computePercussionMap
} from './dsp-pipeline.mjs';

const ROOT_DIR = process.cwd();
const SAMPLES_DIR = path.join(ROOT_DIR, 'samples');
const TRASH_DIR = path.join(ROOT_DIR, '_trash');
const CATALOG_PATH = path.join(ROOT_DIR, 'catalog.json');

fs.mkdirSync(TRASH_DIR, { recursive: true });
const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));

// ----------------------------------------------------------------------------
// 1. Move Chord Organ videos (#24 & #25) to _trash/ (out of the running)
// ----------------------------------------------------------------------------
for (const idx of [24, 25]) {
  const v = catalog.videos.find(x => x.index === idx);
  if (!v || v.deleted) continue;

  const itemDir = path.join(SAMPLES_DIR, v.folderName);
  const trashItemDir = path.join(TRASH_DIR, v.folderName);
  if (fs.existsSync(itemDir)) {
    if (fs.existsSync(trashItemDir)) fs.rmSync(trashItemDir, { recursive: true, force: true });
    fs.renameSync(itemDir, trashItemDir);
  }
  const sourceAbs = path.join(ROOT_DIR, v.sourcePath);
  if (fs.existsSync(sourceAbs)) {
    const trashSourcePath = path.join(TRASH_DIR, v.originalFilename);
    fs.renameSync(sourceAbs, trashSourcePath);
    v.trashedSourcePath = `_trash/${v.originalFilename}`;
  }
  v.deleted = true;
  console.log(`Moved #${idx} ${v.slug} to _trash/`);
}

// ----------------------------------------------------------------------------
// 2. Relabel #53 & #54 -> puffball-mushroom-1 & 2 (Percussion Only)
// ----------------------------------------------------------------------------
for (const idx of [53, 54]) {
  const v = catalog.videos.find(x => x.index === idx);
  if (!v) continue;
  const subNum = idx === 53 ? 1 : 2;
  const newSlug = `puffball-mushroom-${subNum}`;
  const newFolder = `${idx}_${newSlug}`;
  const oldDir = path.join(SAMPLES_DIR, v.folderName);
  const newDir = path.join(SAMPLES_DIR, newFolder);

  if (fs.existsSync(oldDir) && oldDir !== newDir) {
    fs.renameSync(oldDir, newDir);
  }
  fs.mkdirSync(newDir, { recursive: true });

  const oldThumb = path.join(newDir, v.thumbFile);
  const newThumbFile = `${newSlug}_thumb.jpg`;
  const newThumb = path.join(newDir, newThumbFile);
  if (fs.existsSync(oldThumb) && oldThumb !== newThumb) {
    fs.renameSync(oldThumb, newThumb);
  }
  for (const f of fs.readdirSync(newDir)) {
    if (f !== newThumbFile) fs.rmSync(path.join(newDir, f), { force: true });
  }

  v.slug = newSlug;
  v.label = `Puffball Mushroom ${subNum}`;
  v.category = 'percussion';
  v.folderName = newFolder;
  v.thumbFile = newThumbFile;
  v.thumbUrl = `/samples/${newFolder}/${newThumbFile}`;

  const takes = idx === 53
    ? [
        { startSec: 15.36, durSec: 0.95, bucket: 'kick', label: 'Puffball Hollow Kick 1', hp: 35, freq: 74.0, name: 'D2', midi: 38 },
        { startSec: 18.87, durSec: 0.95, bucket: 'kick', label: 'Puffball Deep Kick 2', hp: 35, freq: 77.6, name: 'D#2', midi: 39 },
        { startSec: 3.47, durSec: 0.85, bucket: 'snare', label: 'Puffball Skin Tap', hp: 70, freq: 171.5, name: 'F3', midi: 53 }
      ]
    : [
        { startSec: 5.22, durSec: 0.95, bucket: 'kick', label: 'Puffball Punch Kick 3', hp: 35, freq: 78.0, name: 'D#2', midi: 39 },
        { startSec: 2.48, durSec: 0.90, bucket: 'snare', label: 'Puffball Mid Thwack', hp: 60, freq: 88.9, name: 'F2', midi: 41 }
      ];

  v.slices = takes.map((t, sIdx) => {
    const hitNum = String(sIdx + 1).padStart(2, '0');
    const tag = t.bucket.toUpperCase();
    const baseName = `${newSlug}_hit${hitNum}_${tag}`;
    const mp4File = `${baseName}.mp4`;
    const wavFile = `${baseName}.wav`;
    extractSliceAssets(
      path.join(ROOT_DIR, v.sourcePath),
      t.startSec,
      t.durSec,
      path.join(newDir, mp4File),
      path.join(newDir, wavFile),
      v.extraRotateDeg || 0,
      t.hp
    );
    return {
      id: `v${idx}_s${hitNum}`,
      hitIndex: sIdx + 1,
      baseName,
      mp4File,
      wavFile,
      videoUrl: `/samples/${newFolder}/${mp4File}`,
      audioUrl: `/samples/${newFolder}/${wavFile}`,
      startSec: t.startSec,
      durSec: t.durSec,
      highpassHz: t.hp,
      percBucket: t.bucket,
      percLabel: t.label,
      midi: t.midi,
      name: t.name,
      cents: 0,
      exactMidi: t.midi,
      freq: t.freq,
      confidence: 0.88,
      peakDb: -16,
      candidatePeaks: [{ freq: t.freq, midi: t.midi, name: t.name, cents: 0, relDb: 0 }],
      starred: sIdx === 0,
      deleted: false
    };
  });
  console.log(`Relabeled #${idx} -> ${newSlug} (${v.slices.length} percussion takes)`);
}

// ----------------------------------------------------------------------------
// 3. Move ALL Wood Logs (#40 – #52) strictly to Percussion Buckets
// ----------------------------------------------------------------------------
for (let idx = 40; idx <= 52; idx++) {
  const v = catalog.videos.find(x => x.index === idx);
  if (!v || v.deleted) continue;

  const sourceAbs = path.join(ROOT_DIR, v.sourcePath);
  if (!fs.existsSync(sourceAbs)) continue;

  v.category = 'percussion';
  const itemDir = path.join(SAMPLES_DIR, v.folderName);
  fs.mkdirSync(itemDir, { recursive: true });
  for (const f of fs.readdirSync(itemDir)) {
    if (f !== v.thumbFile) fs.rmSync(path.join(itemDir, f), { force: true });
  }

  const audioData = analyzeVideoAudio(sourceAbs, { minPitchHz: 65, maxSlices: 1 });
  v.noiseFloorDb = audioData.noiseFloorDb;
  v.peakDb = audioData.peakDb;
  v.waveformPeaks = audioData.waveformPeaks;
  v.allDetectedOnsets = audioData.allDetectedOnsets;

  const top = audioData.selectedSlices[0];
  if (top) {
    // Route deep hollow logs (<90Hz) to Kick, mid woody cracks (90-195Hz) to Snare, high woodblocks (>195Hz) to Hi-Hat/Click
    const bucket = top.freq < 90 ? 'kick' : top.freq < 195 ? 'snare' : 'hihat';
    const durSec = 0.90;
    const hp = bucket === 'kick' ? 45 : 80;
    const tag = bucket.toUpperCase();
    const logNum = String(idx - 39).padStart(2, '0');
    const percLabel =
      bucket === 'kick'
        ? `Wood Log Thud ${logNum}`
        : bucket === 'snare'
        ? `Wood Log Crack ${logNum}`
        : `Woodblock Log ${logNum}`;

    const baseName = `${v.slug}_hit01_${tag}`;
    const mp4File = `${baseName}.mp4`;
    const wavFile = `${baseName}.wav`;
    extractSliceAssets(
      sourceAbs,
      top.startSec,
      durSec,
      path.join(itemDir, mp4File),
      path.join(itemDir, wavFile),
      v.extraRotateDeg || 0,
      hp
    );

    v.slices = [
      {
        id: `v${idx}_s01`,
        hitIndex: 1,
        baseName,
        mp4File,
        wavFile,
        videoUrl: `/samples/${v.folderName}/${mp4File}`,
        audioUrl: `/samples/${v.folderName}/${wavFile}`,
        startSec: top.startSec,
        durSec,
        highpassHz: hp,
        percBucket: bucket,
        percLabel,
        midi: top.midi,
        name: top.name,
        cents: top.cents,
        exactMidi: top.exactMidi,
        freq: top.freq,
        confidence: top.confidence,
        peakDb: top.peakDb,
        candidatePeaks: top.candidatePeaks,
        starred: false,
        deleted: false
      }
    ];
    console.log(`Wood Log #${idx} -> [${tag}] ${percLabel} (@${top.startSec}s, ${top.freq}Hz)`);
  }
}

// ----------------------------------------------------------------------------
// 4. Re-analyze ALL Tonal Videos (#06/#07 striking tone only + thumb-thump fix)
// ----------------------------------------------------------------------------
let recutVideos = 0;
for (const v of catalog.videos) {
  if (v.deleted || v.category === 'percussion') continue;

  const sourceAbs = path.join(ROOT_DIR, v.sourcePath);
  if (!fs.existsSync(sourceAbs)) continue;

  // Rename #06 from clock-chime-gears to clock-chime-strike1 so label reflects striking tone only
  if (v.index === 6) {
    v.label = 'Clock Chime Strike 1';
  } else if (v.index === 7) {
    v.label = 'Clock Chime Strike 2';
  }

  const isClockStrike = v.index === 6 || v.index === 7;
  const isHighRinging =
    v.category === 'glass' ||
    v.slug.includes('bell') ||
    v.slug.includes('chime');
  const isMultiNoteScale =
    v.slug.includes('ukulele-frets') ||
    v.slug.includes('bamboo-flute') ||
    v.slug.includes('rubberband-bowl') ||
    v.slug.includes('ukulele-open');

  const minPitchHz = isHighRinging ? 220 : 65;
  const maxSlices = isClockStrike ? 1 : isMultiNoteScale ? 8 : 2;

  const audioData = analyzeVideoAudio(sourceAbs, {
    minPitchHz,
    maxSlices,
    allowWideDynamics: isMultiNoteScale
  });

  v.noiseFloorDb = audioData.noiseFloorDb;
  v.peakDb = audioData.peakDb;
  v.waveformPeaks = audioData.waveformPeaks;
  v.allDetectedOnsets = audioData.allDetectedOnsets;

  const oldSlices = (v.slices || []).filter(s => !s.deleted);
  const newSelected = audioData.selectedSlices;

  let needsRebuild = oldSlices.length !== newSelected.length;
  if (!needsRebuild) {
    for (let i = 0; i < oldSlices.length; i++) {
      if (
        oldSlices[i].midi !== newSelected[i].midi ||
        Math.abs(oldSlices[i].startSec - newSelected[i].startSec) > 0.04
      ) {
        needsRebuild = true;
        break;
      }
    }
  }

  if (needsRebuild) {
    recutVideos++;
    const itemDir = path.join(SAMPLES_DIR, v.folderName);
    fs.mkdirSync(itemDir, { recursive: true });
    for (const f of fs.readdirSync(itemDir)) {
      if (f !== v.thumbFile) {
        fs.rmSync(path.join(itemDir, f), { force: true });
      }
    }

    const hpCut = isHighRinging ? 150 : 85;
    const rebuiltSlices = [];
    const numPrefix = String(v.index).padStart(2, '0');

    for (let sIdx = 0; sIdx < newSelected.length; sIdx++) {
      const s = newSelected[sIdx];
      const hitNum = String(sIdx + 1).padStart(2, '0');
      const safeNote = s.name.replace('#', 's');
      const baseSliceName = `${v.slug}_hit${hitNum}_${safeNote}`;
      const mp4File = `${baseSliceName}.mp4`;
      const wavFile = `${baseSliceName}.wav`;

      extractSliceAssets(
        sourceAbs,
        s.startSec,
        s.durSec,
        path.join(itemDir, mp4File),
        path.join(itemDir, wavFile),
        v.extraRotateDeg || 0,
        hpCut
      );

      rebuiltSlices.push({
        id: `v${numPrefix}_s${hitNum}`,
        hitIndex: sIdx + 1,
        baseName: baseSliceName,
        mp4File,
        wavFile,
        videoUrl: `/samples/${v.folderName}/${mp4File}`,
        audioUrl: `/samples/${v.folderName}/${wavFile}`,
        startSec: s.startSec,
        durSec: s.durSec,
        highpassHz: hpCut,
        percBucket: null,
        midi: s.midi,
        name: s.name,
        cents: s.cents,
        exactMidi: s.exactMidi,
        freq: s.freq,
        confidence: s.confidence,
        peakDb: s.peakDb,
        candidatePeaks: s.candidatePeaks,
        starred: !!s.isBestInVideo,
        deleted: false
      });
    }

    v.slices = rebuiltSlices;
    console.log(
      `Re-cut #${v.index} ${v.slug}: ${rebuiltSlices.map(sl => `${sl.starred ? '★' : ''}${sl.name}@${sl.startSec}s(${sl.peakDb}dB)`).join(', ') || '(silent - 0 slices)'}`
    );
  } else {
    for (let i = 0; i < oldSlices.length; i++) {
      oldSlices[i].starred = !!newSelected[i].isBestInVideo;
    }
  }
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
console.log(`\nFinished refining catalog! Re-cut ${recutVideos} tonal videos.`);
console.log(`Active videos: ${activeVideos.length} (Trashed: ${catalog.stats.trashedVideos}) | Active slices: ${activeSlices}`);
console.log(`Covered Piano Keys: ${coveredKeys} (${exactKeys} exact + ${coveredKeys - exactKeys} neighbor)`);
console.log(`Percussion Buckets -> Kick: ${catalog.percussionMap.kick.slots.length}, Snare: ${catalog.percussionMap.snare.slots.length}, HiHat: ${catalog.percussionMap.hihat.slots.length}`);
