import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT_DIR = process.cwd();
const SAMPLES_DIR = path.join(ROOT_DIR, 'samples');
const TRASH_DIR = path.join(ROOT_DIR, '_trash');
const CATALOG_PATH = path.join(ROOT_DIR, 'catalog.json');

const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));

function cloneOrCopyFile(src, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size) {
    return;
  }
  try {
    // macOS APFS copy-on-write clone: instant and uses 0 extra disk space until temp folder is deleted!
    execFileSync('cp', ['-c', src, dest]);
  } catch {
    fs.copyFileSync(src, dest);
  }
}

let colocatedActive = 0;
let colocatedTrash = 0;
let missingCount = 0;

for (const v of catalog.videos) {
  const sourceFile = `${v.slug}_source.mp4`;

  if (v.deleted) {
    const trashFolder = path.join(TRASH_DIR, v.folderName);
    fs.mkdirSync(trashFolder, { recursive: true });
    const destAbs = path.join(trashFolder, sourceFile);

    const candidates = [
      v.trashedSourcePath ? path.join(ROOT_DIR, v.trashedSourcePath) : null,
      v.sourcePath ? path.join(ROOT_DIR, v.sourcePath) : null,
      path.join(TRASH_DIR, v.originalFilename)
    ].filter(Boolean);

    const foundSrc = candidates.find(p => fs.existsSync(p));
    if (foundSrc && foundSrc !== destAbs) {
      cloneOrCopyFile(foundSrc, destAbs);
      if (foundSrc === path.join(TRASH_DIR, v.originalFilename)) {
        fs.rmSync(foundSrc, { force: true });
      }
      colocatedTrash++;
    }
    v.sourceFile = sourceFile;
    v.sourcePath = `samples/${v.folderName}/${sourceFile}`;
    v.trashedSourcePath = `_trash/${v.folderName}/${sourceFile}`;
    continue;
  }

  const itemDir = path.join(SAMPLES_DIR, v.folderName);
  fs.mkdirSync(itemDir, { recursive: true });
  const destAbs = path.join(itemDir, sourceFile);
  const curSrcAbs = path.join(ROOT_DIR, v.sourcePath);

  if (fs.existsSync(destAbs)) {
    v.sourceFile = sourceFile;
    v.sourcePath = `samples/${v.folderName}/${sourceFile}`;
    colocatedActive++;
  } else if (fs.existsSync(curSrcAbs)) {
    cloneOrCopyFile(curSrcAbs, destAbs);
    v.sourceFile = sourceFile;
    v.sourcePath = `samples/${v.folderName}/${sourceFile}`;
    colocatedActive++;
  } else {
    console.warn(`WARNING: Missing source MP4 for #${v.index} ${v.slug}: ${v.sourcePath}`);
    missingCount++;
  }
}

fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));

const stillPointingToTemp = catalog.videos.filter(
  v => (v.sourcePath || '').includes('temp-photo-import') || (v.trashedSourcePath || '').includes('temp-photo-import')
).length;

console.log(`Co-located full original MP4s next to slices: ${colocatedActive} active + ${colocatedTrash} trashed (missing: ${missingCount})`);
console.log(`Catalog entries still referencing temp-photo-import/: ${stillPointingToTemp}`);
