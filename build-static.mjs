import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { computeKeyboardMap, inferVideoGroupName } from './dsp-pipeline.mjs';

const execFileAsync = promisify(execFile);

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const SAMPLES_DIR = path.join(ROOT_DIR, 'samples');
const CATALOG_PATH = path.join(ROOT_DIR, 'catalog.json');
const DIST_ROOT = path.join(ROOT_DIR, 'dist');

const CONCURRENCY = 8;

async function encodeWavToM4a(srcWav, dstM4a) {
  await execFileAsync('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    srcWav,
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-movflags',
    '+faststart',
    dstM4a
  ]);
}

export async function buildStaticSite(versionSlug = 'v1') {
  const t0 = Date.now();
  const outDir = path.join(DIST_ROOT, versionSlug);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // Root GitHub Pages files (.nojekyll + clean redirect to ./v1/)
  fs.writeFileSync(path.join(DIST_ROOT, '.nojekyll'), '');
  fs.writeFileSync(
    path.join(DIST_ROOT, 'index.html'),
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="refresh" content="0; url=./${versionSlug}/" />
  <title>Everytone</title>
  <script>window.location.replace('./${versionSlug}/');</script>
</head>
<body style="background:#000000;color:#fff;font-family:sans-serif;"></body>
</html>
`
  );

  // 1. Copy public frontend assets
  const publicFiles = [
    'index.html',
    'styles.css',
    'app.js',
    'midi-parser.mjs',
    'midi-timeline.mjs',
    'three-stage.mjs',
    'stage-atlas.jpg',
    'stage-atlas.json'
  ];
  for (const f of publicFiles) {
    const src = path.join(PUBLIC_DIR, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(outDir, f));
    }
  }
  const vendorSrc = path.join(PUBLIC_DIR, 'vendor', 'three.module.min.js');
  if (fs.existsSync(vendorSrc)) {
    fs.mkdirSync(path.join(outDir, 'vendor'), { recursive: true });
    fs.copyFileSync(vendorSrc, path.join(outDir, 'vendor', 'three.module.min.js'));
  }
  const fontsDirSrc = path.join(PUBLIC_DIR, 'vendor', 'fonts');
  if (fs.existsSync(fontsDirSrc)) {
    const fontsDirDst = path.join(outDir, 'vendor', 'fonts');
    fs.mkdirSync(fontsDirDst, { recursive: true });
    for (const ff of fs.readdirSync(fontsDirSrc)) {
      fs.copyFileSync(path.join(fontsDirSrc, ff), path.join(fontsDirDst, ff));
    }
  }
  const midiDirSrc = path.join(ROOT_DIR, 'midi');
  if (fs.existsSync(midiDirSrc)) {
    const midiDirDst = path.join(outDir, 'midi');
    fs.mkdirSync(midiDirDst, { recursive: true });
    const staticMidiFiles = [];
    for (const mf of fs.readdirSync(midiDirSrc)) {
      if (mf.startsWith('.') || !/\.(mid|midi)$/i.test(mf)) continue;
      const srcP = path.join(midiDirSrc, mf);
      const st = fs.statSync(srcP);
      if (!st.isFile()) continue;
      fs.copyFileSync(srcP, path.join(midiDirDst, mf));
      staticMidiFiles.push({
        name: mf,
        url: `./midi/${encodeURIComponent(mf)}`,
        mtimeMs: Math.round(st.mtimeMs),
        size: st.size,
        isRecording: /^rec_/i.test(mf)
      });
    }
    staticMidiFiles.sort((a, b) => {
      if (a.isRecording !== b.isRecording) return a.isRecording ? -1 : 1;
      if (a.isRecording) return b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name);
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    fs.writeFileSync(path.join(midiDirDst, 'index.json'), JSON.stringify({ files: staticMidiFiles }));
  }

  // 2. Copy spliced Tier-1 media (thumbnails + clip MP4s) and encode clip WAVs -> M4As
  const rawCatalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const slimVideos = [];
  const audioJobs = [];

  for (const v of rawCatalog.videos || []) {
    if (v.deleted) continue;
    const srcFolder = path.join(SAMPLES_DIR, v.folderName);
    const dstFolder = path.join(outDir, 'samples', v.folderName);
    fs.mkdirSync(dstFolder, { recursive: true });

    if (v.thumbFile) {
      const srcThumb = path.join(srcFolder, v.thumbFile);
      if (fs.existsSync(srcThumb)) {
        fs.copyFileSync(srcThumb, path.join(dstFolder, v.thumbFile));
      }
    }

    const slimSlices = [];
    for (const s of v.slices || []) {
      if (s.deleted) continue;

      const srcMp4 = path.join(srcFolder, s.mp4File);
      const dstMp4 = path.join(dstFolder, s.mp4File);
      if (fs.existsSync(srcMp4)) {
        fs.copyFileSync(srcMp4, dstMp4);
      }

      const m4aFile = s.wavFile.replace(/\.wav$/i, '.m4a');
      const srcWav = path.join(srcFolder, s.wavFile);
      const dstM4a = path.join(dstFolder, m4aFile);
      if (fs.existsSync(srcWav)) {
        audioJobs.push({ srcWav, dstM4a });
      }

      const { candidatePeaks, ...restSlice } = s;
      slimSlices.push({
        ...restSlice,
        audioFile: m4aFile,
        videoUrl: `./samples/${v.folderName}/${s.mp4File}`,
        audioUrl: `./samples/${v.folderName}/${m4aFile}`
      });
    }

    slimVideos.push({
      id: v.id,
      index: v.index,
      slug: v.slug,
      label: v.label,
      groupName: String(v.groupName || '').trim() || inferVideoGroupName(v),
      category: v.category,
      enabled: v.enabled !== false,
      gainDb: Number.isFinite(v.gainDb) ? Math.round(v.gainDb) : 0,
      folderName: v.folderName,
      thumbFile: v.thumbFile,
      thumbUrl: `./samples/${v.folderName}/${v.thumbFile}`,
      duration: v.duration,
      slices: slimSlices
    });
  }

  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= audioJobs.length) break;
      const job = audioJobs[idx];
      await encodeWavToM4a(job.srcWav, job.dstM4a);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // 3. Recompute keyboardMap against the slimmed .m4a catalog
  const keyboardConfig = JSON.parse(
    JSON.stringify(rawCatalog.keyboardConfig || { selectedByMidi: {}, enabledByMidi: {}, clearedMidis: [] })
  );
  const keyboardMap = computeKeyboardMap(slimVideos, keyboardConfig);

  const staticCatalog = {
    version: rawCatalog.version || 2,
    staticBuild: versionSlug,
    updatedAt: new Date().toISOString(),
    stats: rawCatalog.stats || {},
    stageConfig: rawCatalog.stageConfig || undefined,
    keyboardConfig,
    videos: slimVideos,
    keyboardMap
  };

  fs.writeFileSync(path.join(outDir, 'catalog.json'), JSON.stringify(staticCatalog));

  // Summarize output size
  let totalBytes = 0;
  function walkSize(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walkSize(p);
      else totalBytes += fs.statSync(p).size;
    }
  }
  walkSize(outDir);

  const catalogKb = (fs.statSync(path.join(outDir, 'catalog.json')).size / 1024).toFixed(1);
  const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `Built static ${versionSlug} in dist/${versionSlug}: ${audioJobs.length} clips, catalog=${catalogKb} KB, total=${totalMb} MB (${sec}s)`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ver = process.argv[2] || 'v1';
  buildStaticSite(ver).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
