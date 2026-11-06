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
  extractSliceAssets,
  analyzeSliceRegion,
  computeKeyboardMap,
  enableVideoSlicesByDefault
} from './dsp-pipeline.mjs';

const PORT = process.env.PORT || 3456;
const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const SAMPLES_DIR = path.join(ROOT_DIR, 'samples');
const MIDI_DIR = path.join(ROOT_DIR, 'midi');
const TRASH_DIR = path.join(ROOT_DIR, '_trash');
const CATALOG_PATH = path.join(ROOT_DIR, 'catalog.json');

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(SAMPLES_DIR, { recursive: true });
fs.mkdirSync(MIDI_DIR, { recursive: true });
fs.mkdirSync(TRASH_DIR, { recursive: true });

function formatLocalMidiStamp(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
    `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

function listMidiFiles() {
  if (!fs.existsSync(MIDI_DIR)) return [];
  const out = [];
  for (const ent of fs.readdirSync(MIDI_DIR, { withFileTypes: true })) {
    if (!ent.isFile() || ent.name.startsWith('.')) continue;
    if (!/\.(mid|midi)$/i.test(ent.name)) continue;
    const full = path.join(MIDI_DIR, ent.name);
    const st = fs.statSync(full);
    out.push({
      name: ent.name,
      url: `./midi/${encodeURIComponent(ent.name)}`,
      mtimeMs: Math.round(st.mtimeMs),
      size: st.size,
      isRecording: /^rec_/i.test(ent.name)
    });
  }
  out.sort((a, b) => {
    if (a.isRecording !== b.isRecording) return a.isRecording ? -1 : 1;
    if (a.isRecording) return b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name);
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  return out;
}

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
  delete catalog.percussionMap;

  const activeVideos = catalog.videos.filter(v => !v.deleted);
  const activeSlices = activeVideos.reduce((sum, v) => sum + (v.slices || []).filter(s => !s.deleted).length, 0);
  const keyEntries = Object.values(catalog.keyboardMap);
  const coveredKeys = keyEntries.filter(k => !!k.primary).length;
  const keysWithCandidates = keyEntries.length;
  const totalCandidates = keyEntries.reduce((sum, k) => sum + (k.candidateCount || 0), 0);
  const newConsiderations = keyEntries.reduce((sum, k) => sum + (k.newCount || 0), 0);
  const percCount = keyEntries
    .filter(k => k.isPercKey)
    .reduce((sum, k) => sum + (k.candidateCount || 0), 0);

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
  '.mp4': 'video/mp4',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi'
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

    if (pathname === '/api/stage-config' && req.method === 'POST') {
      const body = await parseBody(req);
      const catalog = loadCatalog();
      catalog.stageConfig = {
        ...(catalog.stageConfig || {}),
        stageGridMode: String(body.stageGridMode || '3x1'),
        stageTileScale: Number(body.stageTileScale ?? 1.0),
        stageSpecScale: Number(body.stageSpecScale ?? 1.0),
        stageFadeInSec: Number(body.stageFadeInSec ?? 0.0),
        stageFadeSec: Number(body.stageFadeSec ?? 0.2),
        stageMaxDisplayEnabled: Boolean(body.stageMaxDisplayEnabled),
        stageMaxDisplaySec: Number(body.stageMaxDisplaySec ?? 1.0),
        midiTransposeOctaves: Math.round(Number(body.midiTransposeOctaves ?? 0))
      };
      catalog.updatedAt = new Date().toISOString();
      fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));
      return sendJson(res, 200, { ok: true, stageConfig: catalog.stageConfig });
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
          exactMidi: slice.exactMidi ?? (slice.midi + (slice.cents || 0) / 100)
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
      const newSlice = {
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
      };
      video.slices.push(newSlice);
      enableVideoSlicesByDefault(
        catalog.videos,
        [{ ...video, slices: [newSlice] }],
        catalog.keyboardConfig
      );

      return sendJson(res, 200, saveCatalog(catalog));
    }

    if (pathname === '/api/midi/list' && req.method === 'GET') {
      return sendJson(res, 200, { files: listMidiFiles() });
    }

    if (pathname === '/api/midi/save' && req.method === 'POST') {
      const body = await parseBody(req);
      const rawB64 = String(body.base64 || '').trim();
      if (!rawB64) return sendJson(res, 400, { error: 'Missing MIDI base64 payload' });
      const buf = Buffer.from(rawB64, 'base64');
      if (buf.length < 14 || buf.toString('ascii', 0, 4) !== 'MThd') {
        return sendJson(res, 400, { error: 'Invalid Standard MIDI File payload' });
      }

      let baseStem = '';
      if (body.fileName) {
        baseStem = path
          .basename(String(body.fileName))
          .replace(/\.(mid|midi)$/i, '')
          .replace(/[^a-zA-Z0-9._-]+/g, '_')
          .replace(/^_+|_+$/g, '');
      }
      if (!baseStem) {
        baseStem = `rec_${formatLocalMidiStamp(new Date())}`;
      }

      let finalName = `${baseStem}.mid`;
      let suffix = 2;
      while (fs.existsSync(path.join(MIDI_DIR, finalName))) {
        finalName = `${baseStem}-${suffix++}.mid`;
      }

      const destPath = path.join(MIDI_DIR, finalName);
      fs.writeFileSync(destPath, buf);
      const st = fs.statSync(destPath);
      const savedEntry = {
        name: finalName,
        url: `./midi/${encodeURIComponent(finalName)}`,
        mtimeMs: Math.round(st.mtimeMs),
        size: st.size,
        isRecording: /^rec_/i.test(finalName)
      };
      return sendJson(res, 200, { ok: true, file: savedEntry, files: listMidiFiles() });
    }

    if (pathname === '/api/midi/trash' && req.method === 'POST') {
      const body = await parseBody(req);
      const cleanName = path.basename(String(body.name || ''));
      if (!cleanName || !/\.(mid|midi)$/i.test(cleanName)) {
        return sendJson(res, 400, { error: 'Invalid MIDI filename' });
      }
      const srcPath = path.join(MIDI_DIR, cleanName);
      if (!fs.existsSync(srcPath)) {
        return sendJson(res, 404, { error: 'MIDI file not found' });
      }
      const trashMidiDir = path.join(TRASH_DIR, 'midi');
      fs.mkdirSync(trashMidiDir, { recursive: true });
      let dstPath = path.join(trashMidiDir, cleanName);
      if (fs.existsSync(dstPath)) {
        dstPath = path.join(trashMidiDir, `${Date.now()}_${cleanName}`);
      }
      fs.renameSync(srcPath, dstPath);
      return sendJson(res, 200, { ok: true, files: listMidiFiles() });
    }

    // Serve static files from /midi/, /samples/, or /public/
    if (pathname.startsWith('/midi/')) {
      const rel = pathname.slice('/midi/'.length);
      const safePath = path.normalize(path.join(MIDI_DIR, rel));
      if (!safePath.startsWith(MIDI_DIR)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      return serveStaticFile(req, res, safePath);
    }

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
