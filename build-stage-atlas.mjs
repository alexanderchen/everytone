import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.join(ROOT_DIR, 'catalog.json');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const ATLAS_JPG_PATH = path.join(PUBLIC_DIR, 'stage-atlas.jpg');
const ATLAS_JSON_PATH = path.join(PUBLIC_DIR, 'stage-atlas.json');

const ATLAS_SIZE = 4096;
const MIN_GRID_DIM = 24;
const PAD = 2; // 2px extruded edge gutter per side for zero mipmap bleed
const CONCURRENCY = 8;

async function extractFrameRgb(mp4Path, seekSec, sizePx) {
  const tryExtract = async t => {
    const args = [];
    if (t > 0.005) {
      args.push('-ss', t.toFixed(3));
    }
    args.push(
      '-v', 'error',
      '-i', mp4Path,
      '-frames:v', '1',
      '-vf', `scale=${sizePx}:${sizePx}:flags=lanczos`,
      '-f', 'rawvideo',
      '-pix_fmt', 'rgb24',
      'pipe:1'
    );
    const { stdout } = await execFileAsync('ffmpeg', args, {
      encoding: 'buffer',
      maxBuffer: sizePx * sizePx * 4 + 65536
    });
    return stdout;
  };

  const expectedBytes = sizePx * sizePx * 3;
  try {
    const buf = await tryExtract(seekSec);
    if (buf && buf.length >= expectedBytes) {
      return buf.subarray(0, expectedBytes);
    }
  } catch {}

  const fallback = await tryExtract(0);
  if (fallback && fallback.length >= expectedBytes) {
    return fallback.subarray(0, expectedBytes);
  }
  return Buffer.alloc(expectedBytes, 18);
}

function blitCellWithExtrudedBorder(atlasBuf, col, row, cellRgb, slotStride, innerPx) {
  const baseX = col * slotStride + PAD;
  const baseY = row * slotStride + PAD;

  for (let sy = -PAD; sy < innerPx + PAD; sy++) {
    const clampedY = Math.max(0, Math.min(innerPx - 1, sy));
    const dstY = baseY + sy;
    for (let sx = -PAD; sx < innerPx + PAD; sx++) {
      const clampedX = Math.max(0, Math.min(innerPx - 1, sx));
      const dstX = baseX + sx;
      const srcOff = (clampedY * innerPx + clampedX) * 3;
      const dstOff = (dstY * ATLAS_SIZE + dstX) * 3;
      atlasBuf[dstOff] = cellRgb[srcOff];
      atlasBuf[dstOff + 1] = cellRgb[srcOff + 1];
      atlasBuf[dstOff + 2] = cellRgb[srcOff + 2];
    }
  }
}

export async function buildStageAtlas() {
  const t0 = Date.now();
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));

  // Tier 1 only: active (non-trashed) videos sorted by video index (#01 -> #131),
  // and within each video active (non-trashed) slices sorted chronologically by startSec
  const activeVideos = (catalog.videos || [])
    .filter(v => !v.deleted)
    .sort((a, b) => (a.index || 0) - (b.index || 0));

  const orderedEntries = [];
  for (const v of activeVideos) {
    const slices = (v.slices || [])
      .filter(s => !s.deleted)
      .slice()
      .sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0) || (a.hitIndex ?? 0) - (b.hitIndex ?? 0));

    for (const s of slices) {
      const mp4Rel = s.videoUrl ? s.videoUrl.replace(/^\//, '') : path.join('samples', v.folderName, s.mp4File);
      orderedEntries.push({
        sliceId: s.id,
        videoId: v.id,
        videoIndex: v.index,
        videoSlug: v.slug,
        mp4Abs: path.join(ROOT_DIR, mp4Rel),
        trimIn: Math.max(0, Number(s.trimIn ?? 0)),
        midi: Number.isFinite(s.manualMidi) ? Number(s.manualMidi) : Number(s.midi ?? 60)
      });
    }
  }

  const gridCols = Math.max(MIN_GRID_DIM, Math.ceil(Math.sqrt(Math.max(1, orderedEntries.length))));
  const gridRows = gridCols;
  const slotStride = Math.floor(ATLAS_SIZE / gridCols);
  const innerPx = slotStride - PAD * 2;
  if (innerPx < 32) {
    throw new Error(`Slice count ${orderedEntries.length} leaves too small atlas cell (${innerPx}px)`);
  }

  const atlasBuf = Buffer.alloc(ATLAS_SIZE * ATLAS_SIZE * 3, 3);
  let cursor = 0;

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= orderedEntries.length) break;
      const entry = orderedEntries[idx];
      const col = idx % gridCols;
      const row = Math.floor(idx / gridCols);
      const rgb = await extractFrameRgb(entry.mp4Abs, entry.trimIn, innerPx);
      blitCellWithExtrudedBorder(atlasBuf, col, row, rgb, slotStride, innerPx);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // Encode 4096x4096 JPEG atlas via ffmpeg
  await new Promise((resolve, reject) => {
    const proc = execFile(
      'ffmpeg',
      [
        '-y',
        '-v', 'error',
        '-f', 'rawvideo',
        '-pix_fmt', 'rgb24',
        '-s', `${ATLAS_SIZE}x${ATLAS_SIZE}`,
        '-i', 'pipe:0',
        '-q:v', '3',
        ATLAS_JPG_PATH
      ],
      err => (err ? reject(err) : resolve())
    );
    proc.stdin.on('error', () => {});
    proc.stdin.end(atlasBuf);
  });

  const items = orderedEntries.map((entry, idx) => {
    const col = idx % gridCols;
    const row = Math.floor(idx / gridCols);
    const x0 = col * slotStride + PAD;
    const y0 = row * slotStride + PAD;
    return {
      sliceId: entry.sliceId,
      videoId: entry.videoId,
      videoIndex: entry.videoIndex,
      videoSlug: entry.videoSlug,
      midi: entry.midi,
      u0: Number((x0 / ATLAS_SIZE).toFixed(6)),
      v0: Number((y0 / ATLAS_SIZE).toFixed(6)),
      u1: Number(((x0 + innerPx) / ATLAS_SIZE).toFixed(6)),
      v1: Number(((y0 + innerPx) / ATLAS_SIZE).toFixed(6))
    };
  });

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    atlasWidth: ATLAS_SIZE,
    atlasHeight: ATLAS_SIZE,
    cols: gridCols,
    rows: gridRows,
    cellPx: innerPx,
    count: items.length,
    items
  };

  fs.writeFileSync(ATLAS_JSON_PATH, JSON.stringify(manifest, null, 2));
  const jpgBytes = fs.statSync(ATLAS_JPG_PATH).size;
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(
    `Built stage atlas: ${items.length} slices across ${activeVideos.length} videos -> ${(jpgBytes / (1024 * 1024)).toFixed(2)} MB in ${elapsedSec}s`
  );
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildStageAtlas().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
