import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import {
  SR,
  MAX_CLIP_DUR,
  freqToMidi,
  midiToName,
  inferVideoGroupName,
  getDefaultSliceMidi,
  getEffectiveSliceMidi,
  extractSquareThumbnail,
  extractSliceAssets,
  analyzeSliceRegion,
  computeKeyboardMap,
  computePercussionMap
} from './dsp-pipeline.mjs';

const PORT = process.env.PORT || 3456;
const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const SAMPLES_DIR = path.join(ROOT_DIR, 'samples');
const TRASH_DIR = path.join(ROOT_DIR, '_trash');
const CATALOG_PATH = path.join(ROOT_DIR, 'catalog.json');

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(SAMPLES_DIR, { recursive: true });
fs.mkdirSync(TRASH_DIR, { recursive: true });

function loadCatalog() {
  if (!fs.existsSync(CATALOG_PATH)) {
    return {
      version: 2,
      updatedAt: new Date().toISOString(),
      stats: {},
      keyboardConfig: { selectedByMidi: {}, clearedMidis: [] },
      videos: [],
      keyboardMap: {}
    };
  }
  const cat = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  if (!cat.keyboardConfig) {
    cat.keyboardConfig = { selectedByMidi: {}, clearedMidis: [] };
  }
  return cat;
}

function saveCatalog(catalog) {
  if (!catalog.keyboardConfig) {
    catalog.keyboardConfig = { selectedByMidi: {}, clearedMidis: [] };
  }
  for (const v of catalog.videos || []) {
    if (!v.groupName || !String(v.groupName).trim()) {
      v.groupName = inferVideoGroupName(v);
    } else {
      v.groupName = String(v.groupName).trim();
    }
  }
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
  return catalog;
}

function sanitizeSlug(str) {
  return String(str || 'sample')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'sample';
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4'
};

function serveStaticFile(req, res, filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const range = req.headers.range;

  if (range && (ext === '.mp4' || ext === '.wav')) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(urlObj.pathname);

    // API Routes
    if (pathname === '/api/catalog' && req.method === 'GET') {
      const cat = saveCatalog(loadCatalog());
      return sendJson(res, 200, cat);
    }

    if (pathname === '/api/video/rename' && req.method === 'POST') {
      const body = await parseBody(req);
      const catalog = loadCatalog();
      const video = catalog.videos.find(v => v.id === body.videoId);
      if (!video) return sendJson(res, 404, { error: 'Video not found' });

      const newSlug = sanitizeSlug(body.slug || video.slug);
      if (body.label !== undefined) video.label = String(body.label).trim() || newSlug;
      if (body.groupName !== undefined) {
        video.groupName = String(body.groupName).trim() || inferVideoGroupName({ ...video, groupName: '' });
      }
      if (body.category !== undefined) video.category = String(body.category).trim().toLowerCase() || video.category;

      if (newSlug !== video.slug) {
        const numPrefix = String(video.index).padStart(2, '0');
        const oldFolder = path.join(SAMPLES_DIR, video.folderName);
        const newFolderName = `${numPrefix}_${newSlug}`;
        const newFolder = path.join(SAMPLES_DIR, newFolderName);

        if (fs.existsSync(oldFolder) && oldFolder !== newFolder) {
          fs.renameSync(oldFolder, newFolder);
        }

        // Rename co-located full source video inside folder if present
        const oldSourceFile = video.sourceFile || `${video.slug}_source.mp4`;
        const oldSourceInFolder = path.join(newFolder, oldSourceFile);
        const newSourceFile = `${newSlug}_source.mp4`;
        const newSourceInFolder = path.join(newFolder, newSourceFile);
        if (fs.existsSync(oldSourceInFolder) && oldSourceInFolder !== newSourceInFolder) {
          fs.renameSync(oldSourceInFolder, newSourceInFolder);
        }
        if (fs.existsSync(newSourceInFolder)) {
          video.sourceFile = newSourceFile;
          video.sourcePath = `samples/${newFolderName}/${newSourceFile}`;
        }

        // Rename thumbnail inside folder
        const oldThumbPath = path.join(newFolder, video.thumbFile);
        const newThumbFile = `${newSlug}_thumb.jpg`;
        const newThumbPath = path.join(newFolder, newThumbFile);
        if (fs.existsSync(oldThumbPath) && oldThumbPath !== newThumbPath) {
          fs.renameSync(oldThumbPath, newThumbPath);
        }
        video.thumbFile = newThumbFile;
        video.thumbUrl = `/samples/${newFolderName}/${newThumbFile}`;

        // Rename co-located slice MP4 & WAV pairs inside folder
        for (const s of video.slices || []) {
          if (s.deleted) continue;
          const hitNum = String(s.hitIndex).padStart(2, '0');
          const effMidi = getEffectiveSliceMidi(video, s);
          const safeNote = Number.isFinite(s.manualMidi)
            ? midiToName(effMidi).replace('#', 's')
            : s.percBucket
              ? s.percBucket.toUpperCase()
              : (s.name || midiToName(effMidi)).replace('#', 's');
          const newBase = `${newSlug}_hit${hitNum}_${safeNote}`;
          const newMp4 = `${newBase}.mp4`;
          const newWav = `${newBase}.wav`;

          const oldMp4Path = path.join(newFolder, s.mp4File);
          const oldWavPath = path.join(newFolder, s.wavFile);
          if (fs.existsSync(oldMp4Path)) fs.renameSync(oldMp4Path, path.join(newFolder, newMp4));
          if (fs.existsSync(oldWavPath)) fs.renameSync(oldWavPath, path.join(newFolder, newWav));

          s.baseName = newBase;
          s.mp4File = newMp4;
          s.wavFile = newWav;
          s.videoUrl = `/samples/${newFolderName}/${newMp4}`;
          s.audioUrl = `/samples/${newFolderName}/${newWav}`;
        }

        video.slug = newSlug;
        video.folderName = newFolderName;
      }

      return sendJson(res, 200, saveCatalog(catalog));
    }

    if (pathname === '/api/video/group-rename' && req.method === 'POST') {
      const body = await parseBody(req);
      const catalog = loadCatalog();
      const targetIds = new Set(
        Array.isArray(body.videoIds)
          ? body.videoIds.map(String)
          : body.videoId
            ? [String(body.videoId)]
            : []
      );
      if (targetIds.size === 0) return sendJson(res, 400, { error: 'No videoIds provided' });
      const cleanedName = String(body.groupName || '').trim();
      for (const v of catalog.videos || []) {
        if (targetIds.has(v.id)) {
          v.groupName = cleanedName || inferVideoGroupName({ ...v, groupName: '' });
        }
      }
      return sendJson(res, 200, saveCatalog(catalog));
    }

    if (pathname === '/api/video/toggle' && req.method === 'POST') {
      const body = await parseBody(req);
      const catalog = loadCatalog();
      const targetIds = new Set(
        Array.isArray(body.videoIds)
          ? body.videoIds.map(String)
          : body.videoId
            ? [String(body.videoId)]
            : []
      );
      if (targetIds.size === 0) return sendJson(res, 400, { error: 'No videoIds provided' });
      const nextEnabled = Boolean(body.enabled);
      for (const v of catalog.videos || []) {
        if (targetIds.has(v.id)) {
          v.enabled = nextEnabled;
        }
      }
      return sendJson(res, 200, saveCatalog(catalog));
    }

    if (pathname === '/api/video/gain' && req.method === 'POST') {
      const body = await parseBody(req);
      const catalog = loadCatalog();
      const video = (catalog.videos || []).find(v => v.id === body.videoId);
      if (!video) return sendJson(res, 404, { error: 'Video not found' });
      const rawGain = Number(body.gainDb);
      video.gainDb = Number.isFinite(rawGain) ? Math.max(-12, Math.min(12, Math.round(rawGain))) : 0;
      return sendJson(res, 200, saveCatalog(catalog));
    }

    if (pathname === '/api/video/rotate' && req.method === 'POST') {
      const body = await parseBody(req);
      const catalog = loadCatalog();
      const video = catalog.videos.find(v => v.id === body.videoId);
      if (!video) return sendJson(res, 404, { error: 'Video not found' });

      const delta = Number(body.deltaDeg) || 90;
      video.extraRotateDeg = ((video.extraRotateDeg || 0) + delta) % 360;

      const sourceAbs = path.join(ROOT_DIR, video.sourcePath);
      const itemDir = path.join(SAMPLES_DIR, video.folderName);
      if (fs.existsSync(sourceAbs) && fs.existsSync(itemDir)) {
        const thumbPath = path.join(itemDir, video.thumbFile);
        extractSquareThumbnail(sourceAbs, thumbPath, 0.1, video.extraRotateDeg, video.cropLeftFrac ?? null);
        for (const s of video.slices || []) {
          if (s.deleted) continue;
          const mp4Path = path.join(itemDir, s.mp4File);
          const wavPath = path.join(itemDir, s.wavFile);
          const rawDur = Math.min(MAX_CLIP_DUR, Number(s.rawDurSec ?? s.durSec ?? 2.0));
          s.rawDurSec = Number(rawDur.toFixed(2));
          extractSliceAssets(sourceAbs, s.startSec, rawDur, mp4Path, wavPath, video.extraRotateDeg, s.highpassHz || 85, video.cropLeftFrac ?? null);
        }
      }
      return sendJson(res, 200, saveCatalog(catalog));
    }

    if (pathname === '/api/video/trash' && req.method === 'POST') {
      const body = await parseBody(req);
      const catalog = loadCatalog();
      const video = catalog.videos.find(v => v.id === body.videoId);
      if (!video) return sendJson(res, 404, { error: 'Video not found' });

      const itemDir = path.join(SAMPLES_DIR, video.folderName);
      const trashItemDir = path.join(TRASH_DIR, video.folderName);
      if (fs.existsSync(itemDir)) {
        if (fs.existsSync(trashItemDir)) fs.rmSync(trashItemDir, { recursive: true, force: true });
        fs.renameSync(itemDir, trashItemDir);
      }

      if (video.sourceFile) {
        video.trashedSourcePath = `_trash/${video.folderName}/${video.sourceFile}`;
      } else {
        const sourceAbs = path.join(ROOT_DIR, video.sourcePath);
        if (fs.existsSync(sourceAbs)) {
          const trashSourcePath = path.join(TRASH_DIR, video.originalFilename);
          fs.renameSync(sourceAbs, trashSourcePath);
          video.trashedSourcePath = `_trash/${video.originalFilename}`;
        }
      }

      video.deleted = true;
      return sendJson(res, 200, saveCatalog(catalog));
    }

    if (pathname === '/api/video/restore' && req.method === 'POST') {
      const body = await parseBody(req);
      const catalog = loadCatalog();
      const video = catalog.videos.find(v => v.id === body.videoId);
      if (!video) return sendJson(res, 404, { error: 'Video not found' });

      const trashItemDir = path.join(TRASH_DIR, video.folderName);
      const itemDir = path.join(SAMPLES_DIR, video.folderName);
      if (fs.existsSync(trashItemDir)) {
        fs.renameSync(trashItemDir, itemDir);
      }
      if (video.sourceFile) {
        video.sourcePath = `samples/${video.folderName}/${video.sourceFile}`;
        delete video.trashedSourcePath;
      } else if (video.trashedSourcePath) {
        const trashSourceAbs = path.join(ROOT_DIR, video.trashedSourcePath);
        const origSourceAbs = path.join(ROOT_DIR, video.sourcePath);
        if (fs.existsSync(trashSourceAbs)) {
          fs.mkdirSync(path.dirname(origSourceAbs), { recursive: true });
          fs.renameSync(trashSourceAbs, origSourceAbs);
        }
        delete video.trashedSourcePath;
      }

      video.deleted = false;
      return sendJson(res, 200, saveCatalog(catalog));
    }

    if (pathname === '/api/slice/trash' && req.method === 'POST') {
      const body = await parseBody(req);
      const catalog = loadCatalog();
      const video = catalog.videos.find(v => v.id === body.videoId);
      if (!video) return sendJson(res, 404, { error: 'Video not found' });
      const slice = (video.slices || []).find(s => s.id === body.sliceId);
      if (!slice) return sendJson(res, 404, { error: 'Slice not found' });

      const itemDir = path.join(SAMPLES_DIR, video.folderName);
      const mp4Path = path.join(itemDir, slice.mp4File);
      const wavPath = path.join(itemDir, slice.wavFile);
      if (fs.existsSync(mp4Path)) fs.renameSync(mp4Path, path.join(TRASH_DIR, slice.mp4File));
      if (fs.existsSync(wavPath)) fs.renameSync(wavPath, path.join(TRASH_DIR, slice.wavFile));

      slice.deleted = true;
      return sendJson(res, 200, saveCatalog(catalog));
    }

    if (pathname === '/api/percussion/select' && req.method === 'POST') {
      const body = await parseBody(req);
      const catalog = loadCatalog();
      catalog.percussionMap = computePercussionMap(catalog.videos, catalog.percussionMap);
      const bucket = catalog.percussionMap[body.bucket];
      if (bucket && body.sliceId) {
        bucket.activeSliceId = body.sliceId;
      }
      return sendJson(res, 200, saveCatalog(catalog));
    }

    if (pathname === '/api/keyboard/toggle' && req.method === 'POST') {
      const body = await parseBody(req);
      const midi = Number(body.midi);
      const sliceId = String(body.sliceId || '');
      if (!Number.isFinite(midi) || midi < 24 || midi > 103 || !sliceId) {
        return sendJson(res, 400, { error: 'Invalid MIDI note or sliceId' });
      }
      const catalog = loadCatalog();
      if (!catalog.keyboardConfig) {
        catalog.keyboardConfig = { selectedByMidi: {}, enabledByMidi: {}, clearedMidis: [] };
      }
      // Ensure enabledByMidi is migrated before toggling
      computeKeyboardMap(catalog.videos, catalog.keyboardConfig);

      const cur = Array.isArray(catalog.keyboardConfig.enabledByMidi[midi])
        ? [...catalog.keyboardConfig.enabledByMidi[midi]]
        : [];
      const exists = cur.includes(sliceId);
      const shouldEnable = body.enabled !== undefined ? !!body.enabled : !exists;

      let next = cur;
      if (shouldEnable && !exists) {
        next.push(sliceId);
      } else if (!shouldEnable && exists) {
        next = cur.filter(id => id !== sliceId);
      }
      catalog.keyboardConfig.enabledByMidi[midi] = next;
      return sendJson(res, 200, saveCatalog(catalog));
    }

    if (pathname === '/api/keyboard/select' && req.method === 'POST') {
      const body = await parseBody(req);
      const midi = Number(body.midi);
      if (!Number.isFinite(midi) || midi < 24 || midi > 103) {
        return sendJson(res, 400, { error: 'Invalid MIDI note' });
      }
      const catalog = loadCatalog();
      if (!catalog.keyboardConfig) {
        catalog.keyboardConfig = { selectedByMidi: {}, enabledByMidi: {}, clearedMidis: [] };
      }
      computeKeyboardMap(catalog.videos, catalog.keyboardConfig);

      if (!body.sliceId) {
        catalog.keyboardConfig.enabledByMidi[midi] = [];
      } else {
        catalog.keyboardConfig.enabledByMidi[midi] = [String(body.sliceId)];
      }
      return sendJson(res, 200, saveCatalog(catalog));
    }

    if (pathname === '/api/keyboard/mark-seen' && req.method === 'POST') {
      const body = await parseBody(req);
      const catalog = loadCatalog();
      for (const v of catalog.videos) {
        for (const s of v.slices || []) {
          if (body.all) {
            s.isNew = false;
          } else if (body.sliceId && s.id === body.sliceId) {
            s.isNew = false;
          } else if (body.midi !== undefined && Number(s.midi) === Number(body.midi)) {
            s.isNew = false;
          }
        }
      }
      return sendJson(res, 200, saveCatalog(catalog));
    }

    if (pathname === '/api/slice/update' && req.method === 'POST') {
      const body = await parseBody(req);
      const catalog = loadCatalog();
      const video = catalog.videos.find(v => v.id === body.videoId);
      if (!video) return sendJson(res, 404, { error: 'Video not found' });
      const slice = (video.slices || []).find(s => s.id === body.sliceId);
      if (!slice) return sendJson(res, 404, { error: 'Slice not found' });

      if (!catalog.keyboardConfig) {
        catalog.keyboardConfig = { selectedByMidi: {}, enabledByMidi: {}, clearedMidis: [] };
      }
      // Migrate keyboardConfig before mutating slice slot assignments
      computeKeyboardMap(catalog.videos, catalog.keyboardConfig);
      const prevEffectiveMidi = getEffectiveSliceMidi(video, slice);

      function ensureDspOriginalSnapshot() {
        if (slice.dspOriginal && Number.isFinite(slice.dspOriginal.midi)) return;
        slice.dspOriginal = {
          midi: getDefaultSliceMidi(video, slice),
          rawMidi: slice.midi,
          name: slice.name,
          freq: slice.freq,
          cents: slice.cents ?? 0,
          exactMidi: slice.exactMidi ?? (slice.midi + (slice.cents || 0) / 100),
          percBucket: slice.percBucket ?? null
        };
      }

      function syncSliceEnablementAndFiles(nextEffectiveMidi) {
        if (prevEffectiveMidi !== nextEffectiveMidi) {
          const prevList = catalog.keyboardConfig.enabledByMidi?.[prevEffectiveMidi];
          if (Array.isArray(prevList)) {
            catalog.keyboardConfig.enabledByMidi[prevEffectiveMidi] = prevList.filter(id => id !== slice.id);
          }
          const destList = Array.isArray(catalog.keyboardConfig.enabledByMidi?.[nextEffectiveMidi])
            ? catalog.keyboardConfig.enabledByMidi[nextEffectiveMidi]
            : [];
          if (!destList.includes(slice.id)) {
            catalog.keyboardConfig.enabledByMidi[nextEffectiveMidi] = [...destList, slice.id];
          }
        }

        const hitNum = String(slice.hitIndex).padStart(2, '0');
        const safeNote = Number.isFinite(slice.manualMidi)
          ? midiToName(nextEffectiveMidi).replace('#', 's')
          : slice.percBucket
            ? slice.percBucket.toUpperCase()
            : (slice.name || midiToName(nextEffectiveMidi)).replace('#', 's');
        const newBase = `${video.slug}_hit${hitNum}_${safeNote}`;
        const newMp4 = `${newBase}.mp4`;
        const newWav = `${newBase}.wav`;

        const oldMp4Path = path.join(itemDir, slice.mp4File);
        const oldWavPath = path.join(itemDir, slice.wavFile);
        if (fs.existsSync(oldMp4Path) && oldMp4Path !== path.join(itemDir, newMp4)) {
          fs.renameSync(oldMp4Path, path.join(itemDir, newMp4));
        }
        if (fs.existsSync(oldWavPath) && oldWavPath !== path.join(itemDir, newWav)) {
          fs.renameSync(oldWavPath, path.join(itemDir, newWav));
        }

        slice.baseName = newBase;
        slice.mp4File = newMp4;
        slice.wavFile = newWav;
        slice.videoUrl = `/samples/${video.folderName}/${newMp4}`;
        slice.audioUrl = `/samples/${video.folderName}/${newWav}`;
      }

      if (body.starred !== undefined) {
        slice.starred = !!body.starred;
      }

      if (body.percBucket !== undefined) {
        slice.percBucket = (body.percBucket === 'tonal' || !body.percBucket) ? null : body.percBucket;
      }
      if (body.percLabel !== undefined) {
        slice.percLabel = String(body.percLabel).trim();
      }

      const itemDir = path.join(SAMPLES_DIR, video.folderName);

      // Non-destructive clip sub-trimming within [0, rawDurSec] (<= 2.50s)
      const rawDur = Number(Math.min(MAX_CLIP_DUR, Number(slice.rawDurSec ?? slice.durSec ?? 2.0)).toFixed(2));
      slice.rawDurSec = rawDur;

      if (body.resetTrim === true) {
        delete slice.trimIn;
        delete slice.trimOut;
      } else if (body.trimIn !== undefined || body.trimOut !== undefined) {
        const minSpan = Math.min(0.25, rawDur);
        const nextIn = Number(
          Math.max(0, Math.min(Math.max(0, rawDur - minSpan), Number(body.trimIn ?? slice.trimIn ?? 0))).toFixed(2)
        );
        const nextOut = Number(
          Math.max(
            Math.min(rawDur, nextIn + minSpan),
            Math.min(rawDur, Number(body.trimOut ?? slice.trimOut ?? rawDur))
          ).toFixed(2)
        );
        if (nextIn <= 0.005 && nextOut >= rawDur - 0.005) {
          delete slice.trimIn;
          delete slice.trimOut;
        } else {
          slice.trimIn = nextIn;
          slice.trimOut = nextOut;
        }
      }

      // 1. Revert clip back to DSP-suggested MIDI slot and original tuning
      if (body.resetToDsp === true) {
        if (slice.dspOriginal) {
          const orig = slice.dspOriginal;
          if (orig.rawMidi !== undefined) slice.midi = orig.rawMidi;
          if (orig.name !== undefined) slice.name = orig.name;
          if (orig.freq !== undefined) slice.freq = orig.freq;
          slice.cents = orig.cents ?? 0;
          slice.exactMidi = orig.exactMidi ?? slice.midi;
          slice.percBucket = orig.percBucket ?? null;
        }
        delete slice.manualMidi;
        delete slice.manualTuneCents;
        delete slice.dspOriginal;

        const restoredMidi = getEffectiveSliceMidi(video, slice);
        syncSliceEnablementAndFiles(restoredMidi);
      }

      // 2. Permanently move clip to an arbitrary MIDI key slot (24..103) at original 1.0x pitch
      if (body.assignMidi !== undefined) {
        const targetMidi = Math.round(Number(body.assignMidi));
        if (!Number.isFinite(targetMidi) || targetMidi < 24 || targetMidi > 103) {
          return sendJson(res, 400, { error: 'Invalid target MIDI note (24..103)' });
        }
        ensureDspOriginalSnapshot();
        slice.manualMidi = targetMidi;
        slice.manualTuneCents =
          body.manualTuneCents !== undefined
            ? Math.max(-100, Math.min(100, Math.round(Number(body.manualTuneCents) || 0)))
            : 0;
        syncSliceEnablementAndFiles(targetMidi);
      } else if (body.manualTuneCents !== undefined) {
        // 3. Re-pitch / fine-tune clip on its current slot (strictly clamped to ±1 semitone / ±100 cents)
        ensureDspOriginalSnapshot();
        slice.manualTuneCents = Math.max(
          -100,
          Math.min(100, Math.round(Number(body.manualTuneCents) || 0))
        );
      }

      // 4. Spectral harmonic peak chip override
      if (body.overrideFreq !== undefined) {
        ensureDspOriginalSnapshot();
        const ni = freqToMidi(Number(body.overrideFreq));
        if (ni) {
          delete slice.manualMidi;
          delete slice.manualTuneCents;
          slice.freq = ni.freq;
          slice.midi = ni.midi;
          slice.name = ni.name;
          slice.cents = ni.cents;
          slice.exactMidi = ni.exactMidi;
          syncSliceEnablementAndFiles(ni.midi);
        }
      }

      return sendJson(res, 200, saveCatalog(catalog));
    }

    if (pathname === '/api/slice/create' && req.method === 'POST') {
      const body = await parseBody(req);
      const catalog = loadCatalog();
      const video = catalog.videos.find(v => v.id === body.videoId);
      if (!video) return sendJson(res, 404, { error: 'Video not found' });

      const sourceAbs = path.join(ROOT_DIR, video.sourcePath);
      if (!fs.existsSync(sourceAbs)) return sendJson(res, 400, { error: 'Source MP4 not found' });

      const startSec = Number(Math.max(0, Number(body.startSec) || 0).toFixed(2));
      const durSec = Number(Math.min(5.0, Math.max(0.8, Number(body.durSec) || 2.5)).toFixed(2));
      const nextIdx = (video.slices || []).length + 1;
      const hitNum = String(nextIdx).padStart(2, '0');
      const itemDir = path.join(SAMPLES_DIR, video.folderName);

      const tempMp4 = path.join(itemDir, `temp_${hitNum}.mp4`);
      const tempWav = path.join(itemDir, `temp_${hitNum}.wav`);
      extractSliceAssets(sourceAbs, startSec, durSec, tempMp4, tempWav, video.extraRotateDeg || 0, 85, video.cropLeftFrac ?? null);

      const buf = execFileSync('ffmpeg', [
        '-v', 'error', '-i', tempWav, '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1'
      ]);
      const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      const analysis = analyzeSliceRegion(samples, 0, durSec);

      const safeNote = analysis.name.replace('#', 's');
      const baseName = `${video.slug}_hit${hitNum}_${safeNote}`;
      const mp4File = `${baseName}.mp4`;
      const wavFile = `${baseName}.wav`;
      fs.renameSync(tempMp4, path.join(itemDir, mp4File));
      fs.renameSync(tempWav, path.join(itemDir, wavFile));

      const numPrefix = String(video.index).padStart(2, '0');
      video.slices.push({
        id: `v${numPrefix}_s${hitNum}_${Date.now().toString(36).slice(-3)}`,
        hitIndex: nextIdx,
        baseName,
        mp4File,
        wavFile,
        videoUrl: `/samples/${video.folderName}/${mp4File}`,
        audioUrl: `/samples/${video.folderName}/${wavFile}`,
        startSec,
        durSec,
        ...analysis,
        starred: true,
        isNew: true,
        deleted: false
      });

      return sendJson(res, 200, saveCatalog(catalog));
    }

    // Serve static files from /samples/ or /public/
    if (pathname.startsWith('/samples/')) {
      const rel = pathname.slice('/samples/'.length);
      const safePath = path.normalize(path.join(SAMPLES_DIR, rel));
      if (!safePath.startsWith(SAMPLES_DIR)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      return serveStaticFile(req, res, safePath);
    }

    const staticPath = pathname === '/'
      ? path.join(PUBLIC_DIR, 'index.html')
      : path.normalize(path.join(PUBLIC_DIR, pathname));

    if (!staticPath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    return serveStaticFile(req, res, staticPath);
  } catch (err) {
    console.error('Server error:', err);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Everytone running at http://localhost:${PORT}`);
});
