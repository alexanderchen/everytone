// ============================================================================
// Client-Side Deterministic Browser Offline MP4 Renderer
// (`OfflineAudioContext` + `WebCodecs` VideoDecoder/VideoEncoder/AudioEncoder + `mp4-codec-lite.mjs`)
// Supports 9:16 (1080x1920), 1:1 (1080x1080), 4:3 (1440x1080), and 16:9 (1920x1080).
// ============================================================================

import {
  BUILD_NOTE_NAMES,
  sortCatalogVideosInSidebarOrder,
  evalFadeInCurve,
  evalVoiceGain,
  planMidiTimeline,
  clampBuildFullSec,
  clampBuildMaxFps,
  normalizeBuildRampUp,
  normalizeBuildSound,
  BUILD_TAP_BASE_GAIN,
  DEFAULT_POST_BUILD_SILENCE_SEC,
  synthesizeBuildTapPcm,
  evalBuildAudioGain,
  planIntroBuild
} from './midi-timeline.mjs';
import { demuxMp4AvcTrack, createMp4Muxer } from './mp4-codec-lite.mjs';

export const BROWSER_ASPECT_SPECS = {
  '9:16': { key: '9:16', slug: '9x16', label: '9:16', width: 1080, height: 1920 },
  '1:1': { key: '1:1', slug: '1x1', label: '1:1', width: 1080, height: 1080 },
  '4:3': { key: '4:3', slug: '4x3', label: '4:3', width: 1440, height: 1080 },
  '16:9': { key: '16:9', slug: '16x9', label: '16:9', width: 1920, height: 1080 }
};

function parseBrowserStageGridMode(raw, fallback = '3x2') {
  const parsePair = str => {
    const m = String(str || '')
      .trim()
      .toLowerCase()
      .match(/^(\d+)\s*[x×]\s*(\d+)$/);
    if (!m) return null;
    const cols = Math.max(1, Math.min(8, parseInt(m[1], 10) || 3));
    const rows = Math.max(1, Math.min(8, parseInt(m[2], 10) || 2));
    return { key: `${cols}x${rows}`, cols, rows, slots: cols * rows };
  };
  return parsePair(raw) || parsePair(fallback) || { key: '3x2', cols: 3, rows: 2, slots: 6 };
}

const CHROMATIC_HEX = [
  '#e33059', // C
  '#f75839', // C#
  '#f7943d', // D
  '#f3b72f', // D#
  '#edd929', // E
  '#95c631', // F
  '#56a754', // F#
  '#11826d', // G
  '#3160a3', // G#
  '#5b37cc', // A
  '#a347bf', // A#
  '#ea57b2'  // B
];
const PERC_TRIGGER_HEX = '#8a8a8a';

const MAX_CLIP_DUR = 6.0;
const RELEASE_SEC = 0.4;
const HIGHPASS_HZ = 26;
const AUDIO_SR = 48000;

const SPEC_MIN_FREQ = 130;
const MINI_SPEC_MAX_FREQ = 2800;
const SPEC_WARP_HZ = 160;
const SPEC_WARP_MIN = Math.log(1 + SPEC_MIN_FREQ / SPEC_WARP_HZ);
const MINI_WARP_MAX = Math.log(1 + MINI_SPEC_MAX_FREQ / SPEC_WARP_HZ);

const FFT_SIZE = 2048;
const HANN_WIN = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  HANN_WIN[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
}

export function isBrowserOfflineExportSupported() {
  return (
    typeof window !== 'undefined' &&
    typeof window.VideoEncoder === 'function' &&
    typeof window.VideoFrame === 'function' &&
    typeof window.OfflineAudioContext === 'function'
  );
}

export function normalizeBrowserAspectRatio(raw) {
  const s = String(raw || '9:16').trim().toLowerCase().replace(/x/g, ':');
  if (s === '9:16' || s === 'vertical' || s === 'portrait') return '9:16';
  if (s === '1:1' || s === 'square') return '1:1';
  if (s === '4:3') return '4:3';
  if (s === '16:9' || s === 'landscape' || s === 'wide') return '16:9';
  return '9:16';
}

function getNoteHex(midi, isPerc = false) {
  if (isPerc) return PERC_TRIGGER_HEX;
  const pc = ((Math.round(Number(midi) || 60) % 12) + 12) % 12;
  return CHROMATIC_HEX[pc];
}

function hexToRgb(hex) {
  const clean = String(hex || PERC_TRIGGER_HEX).replace('#', '');
  const n = parseInt(clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function clampTileScale(raw) {
  let n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1.0;
  if (n > 10) n = n / 100;
  return Math.max(0.6, Math.min(2.5, Math.round(n * 20) / 20));
}

function clampSpecScale(raw) {
  let n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1.0;
  if (n > 10) n = n / 100;
  return Math.max(0.75, Math.min(4.5, Math.round(n * 20) / 20));
}

function getStageSpecRatio(rows, rawSpecScale = 1.0) {
  const baseRatio = rows >= 3 ? 0.13 : 0.145;
  const scale = clampSpecScale(rawSpecScale);
  if (scale <= 1.0) return baseRatio * scale;
  const t = (scale - 1.0) / (4.5 - 1.0);
  return baseRatio + t * (0.66 - baseRatio);
}

function getStageSpecKeylineWidth(rawSpecScale = 1.0) {
  const scale = clampSpecScale(rawSpecScale);
  if (scale <= 1.0) return 1.0;
  const t = Math.min(1, (scale - 1.0) / (4.5 - 1.0));
  return 1.0 + t * 1.0;
}

function miniSpecFreqToNormY(freq) {
  const f = Math.max(SPEC_MIN_FREQ, Math.min(MINI_SPEC_MAX_FREQ, freq));
  return (Math.log(1 + f / SPEC_WARP_HZ) - SPEC_WARP_MIN) / (MINI_WARP_MAX - SPEC_WARP_MIN);
}

function miniSpecNormYToFreq(normY) {
  const u = Math.max(0, Math.min(1, normY));
  return SPEC_WARP_HZ * (Math.exp(SPEC_WARP_MIN + u * (MINI_WARP_MAX - SPEC_WARP_MIN)) - 1);
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function evalSlotVisualAlpha(voice, t, fadeInSec, fadeOutSec) {
  if (t < voice.startSec || t >= voice.visualEndSec) return 0;
  if (voice.fadeStartSec === null || t <= voice.fadeStartSec) {
    return evalFadeInCurve(t - voice.startSec, fadeInSec);
  }
  if (fadeOutSec <= 0.002) return 0;
  const startOutAlpha = evalFadeInCurve(Math.max(0, voice.fadeStartSec - voice.startSec), fadeInSec);
  if (startOutAlpha <= 0.003) return 0;
  const effOutDur = Math.max(0.05, fadeOutSec * Math.sqrt(startOutAlpha));
  const u = Math.max(0, Math.min(1, (t - voice.fadeStartSec) / effOutDur));
  return startOutAlpha * Math.pow(1 - u, 1.5);
}

// ============================================================================
// Stage + Mosaic Geometry Solver (100% Parity with offline-render.mjs)
// ============================================================================

function solveMosaicFlushScaled(targetW, availH, tileCount, desiredCellPx, mosaicGap, minCellPx) {
  if (tileCount <= 0) return { cols: 1, rows: 0, cell: desiredCellPx, gridW: 0, gridH: 0 };
  if (tileCount <= 3 && tileCount * desiredCellPx + (tileCount - 1) * mosaicGap <= targetW) {
    const cell = Math.min(desiredCellPx, availH);
    return {
      cols: tileCount,
      rows: 1,
      cell,
      gridW: tileCount * cell + (tileCount - 1) * mosaicGap,
      gridH: cell
    };
  }
  const maxCellPx = Math.max(desiredCellPx * 1.35, minCellPx * 2.2);
  const minCols = Math.max(1, Math.min(tileCount, Math.ceil((targetW + mosaicGap) / (maxCellPx + mosaicGap))));
  const maxCols = Math.min(
    tileCount,
    Math.max(minCols, Math.floor((targetW + mosaicGap) / (minCellPx + mosaicGap)))
  );

  let bestCols = maxCols;
  let bestScore = -1e9;
  let foundFitting = false;
  for (let mCols = minCols; mCols <= maxCols; mCols++) {
    const mRows = Math.ceil(tileCount / mCols);
    const cellByW = (targetW - (mCols - 1) * mosaicGap) / mCols;
    if (cellByW < minCellPx - 0.01) continue;
    const neededH = mRows * cellByW + (mRows - 1) * mosaicGap;
    if (neededH > availH + 0.5) continue;

    foundFitting = true;
    const lastRowCount = tileCount - (mRows - 1) * mCols;
    const lastRowFill = lastRowCount / mCols;
    const orphanPenalty = mRows > 1 && lastRowFill < 0.25 ? (0.25 - lastRowFill) * 22 : 0;
    const sizeCloseness =
      1.0 -
      Math.min(1.0, Math.abs(cellByW - desiredCellPx) / Math.max(minCellPx * 0.9, desiredCellPx * 0.6));
    const score = sizeCloseness * 38 + lastRowFill * 9 - orphanPenalty;
    if (score > bestScore) {
      bestScore = score;
      bestCols = mCols;
    }
  }
  if (!foundFitting) bestCols = maxCols;
  const bestCell = (targetW - (bestCols - 1) * mosaicGap) / bestCols;
  const mRows = Math.ceil(tileCount / bestCols);
  return {
    cols: bestCols,
    rows: mRows,
    cell: bestCell,
    gridW: bestCols * bestCell + (bestCols - 1) * mosaicGap,
    gridH: mRows * bestCell + (mRows - 1) * mosaicGap
  };
}

function computeStageGeometry(
  W,
  H,
  gridSpec,
  tileCount,
  rawTileScale = 1.0,
  rawSpecScale = 1.0,
  splitHandVideo = false,
  rawVideoWidthPct = 50,
  rawVideoPosition = 'right',
  rawVideoHeightPct = 23
) {
  const shortDim = Math.min(W, H);
  const uiScale = shortDim / 1080;
  const isPortrait = H > W * 1.15;
  const tileScale = clampTileScale(rawTileScale);
  const { cols, rows } = gridSpec;
  const videoPosition =
    String(rawVideoPosition || 'right').trim().toLowerCase() === 'below' ? 'below' : 'right';
  const isBelowHand = Boolean(splitHandVideo && videoPosition === 'below');
  const isRightHand = Boolean(splitHandVideo && !isBelowHand);

  const maxGridDim = Math.max(cols, rows);
  const baseColGap =
    maxGridDim >= 7
      ? 6
      : maxGridDim >= 5
        ? 8
        : W < 920 * uiScale
          ? 12
          : rows >= 3 || cols >= 4
            ? 14
            : rows === 2
              ? 16
              : 20;
  const colGap = Math.max(3, Math.round(baseColGap * uiScale));
  const rowGap =
    rows <= 1
      ? 0
      : Math.max(
          4,
          Math.round((rows >= 7 ? 7 : rows >= 5 ? 10 : rows >= 3 ? 18 : 22) * uiScale)
        );
  const minTileFloor = Math.round((maxGridDim >= 4 ? 22 : 48) * uiScale);
  const specRatio = getStageSpecRatio(rows, rawSpecScale);

  const marginY = Math.max(
    Math.round(12 * uiScale),
    Math.round(shortDim * (rows >= 3 ? 0.024 : 0.034))
  );
  const betweenGap =
    tileCount > 0 || splitHandVideo
      ? Math.max(Math.round(28 * uiScale), Math.round(H * (rows >= 3 ? 0.021 : 0.026)))
      : 0;
  const mosaicGap = Math.max(1, Math.round(1 * uiScale));
  const splitGap = mosaicGap;
  const handWidthPct = Number.isFinite(Number(rawVideoWidthPct))
    ? Math.max(15, Math.min(80, Math.round(Number(rawVideoWidthPct))))
    : 50;
  const handHeightPct = Number.isFinite(Number(rawVideoHeightPct))
    ? Math.max(10, Math.min(45, Math.round(Number(rawVideoHeightPct))))
    : 23;

  const padX = Math.max(Math.round(32 * uiScale), Math.round(W * 0.065));
  const availW = Math.max(Math.round(200 * uiScale), W - padX * 2 - colGap * (cols - 1));
  const maxCap = Math.round(
    (rows === 1
      ? 388
      : cols >= 4
        ? 304
        : rows === 2
          ? isPortrait
            ? 400
            : 348
          : isPortrait
            ? 310
            : 284) * uiScale
  );

  const rawReserveH =
    tileCount > 0
      ? Math.round((rows >= 3 ? 54 : rows === 2 ? 64 : 76) * uiScale)
      : isRightHand
        ? Math.round(64 * uiScale)
        : 0;
  const estStripW = Math.min(availW + colGap * (cols - 1), maxCap * cols + colGap * (cols - 1));
  const estBelowHandH = isBelowHand
    ? Math.min(
        Math.round(H * 0.28),
        Math.max(Math.round(36 * uiScale), Math.round(estStripW * (handHeightPct / 100)))
      )
    : 0;
  const baseReserveH = isBelowHand
    ? rawReserveH + (tileCount > 0 ? splitGap : 0) + estBelowHandH
    : rawReserveH;

  const baseAvailTopH = Math.max(
    Math.round(140 * uiScale),
    H - marginY * 2 - betweenGap - baseReserveH - (rows - 1) * rowGap
  );
  const baseMaxSideByH = Math.floor(baseAvailTopH / (rows * (1 + specRatio)));

  const baseRawSide = Math.max(
    minTileFloor,
    Math.min(maxCap, Math.floor(Math.min(baseMaxSideByH, availW / cols)))
  );
  const baseTileSize = Math.max(20, Math.floor(baseRawSide / 2) * 2);
  const baseStripW = baseTileSize * cols + colGap * (cols - 1);
  const mosaicRefW = isBelowHand
    ? isPortrait
      ? baseStripW
      : baseStripW * 0.56
    : isRightHand
      ? baseStripW * 0.62
      : baseStripW;
  const mosaicTileBoost = isBelowHand
    ? isPortrait
      ? 1.20
      : 1.12
    : isPortrait
      ? 1.30
      : 1.25;
  const baseCell100 = Math.min(
    18.0 * uiScale,
    Math.max((isBelowHand && !isPortrait ? 6.8 : 7.8) * uiScale, (mosaicRefW / 76) * mosaicTileBoost)
  );
  const desiredCellPx = baseCell100 * tileScale;
  const minCellPx = (splitHandVideo ? 2.5 : 3.5) * uiScale;

  let tileSize = baseTileSize;
  if (tileCount > 0 && (tileScale > 1.01 || splitHandVideo)) {
    const minAllowedSide = Math.max(
      20,
      Math.floor(
        Math.max(minTileFloor, Math.round(baseTileSize * (splitHandVideo ? 0.84 : 0.68))) / 2
      ) * 2
    );
    let bestAchievedCell = -1;
    for (let s = baseTileSize; s >= minAllowedSide; s -= 2) {
      const candSpecH = Math.max(Math.round(14 * uiScale), Math.round(s * specRatio));
      const candStripW = s * cols + colGap * (cols - 1);
      const minSideW = Math.min(Math.round(48 * uiScale), Math.floor((candStripW - splitGap) * 0.45));
      const candHandW = isRightHand
        ? Math.max(
            minSideW,
            Math.min(
              candStripW - splitGap - minSideW,
              Math.round((candStripW - splitGap) * (handWidthPct / 100))
            )
          )
        : 0;
      const candMosaicW = isRightHand
        ? Math.max(minSideW, candStripW - splitGap - candHandW)
        : candStripW;
      const candTopH = rows * (s + candSpecH) + (rows - 1) * rowGap;
      const rawAvailMosaicH = H - marginY * 2 - betweenGap - candTopH;
      const maxMosaicHCap = isPortrait ? Math.round(H * 0.25) : Math.round(shortDim * 0.42);
      const candBelowHandH = isBelowHand
        ? Math.min(
            Math.max(Math.round(24 * uiScale), Math.round(candStripW * (handHeightPct / 100))),
            Math.max(
              Math.round(24 * uiScale),
              rawAvailMosaicH -
                splitGap -
                Math.max(
                  Math.round(24 * uiScale),
                  Math.min(Math.round(64 * uiScale), Math.round(rawAvailMosaicH * 0.28))
                )
            )
          )
        : 0;
      const availMosaicH = isRightHand
        ? Math.min(rawAvailMosaicH, Math.max(Math.round(32 * uiScale), maxMosaicHCap))
        : isBelowHand
          ? rawAvailMosaicH - splitGap - candBelowHandH
          : rawAvailMosaicH;
      if (availMosaicH < Math.round((isBelowHand ? 24 : 32) * uiScale)) continue;
      const m = solveMosaicFlushScaled(
        candMosaicW,
        availMosaicH,
        tileCount,
        desiredCellPx,
        mosaicGap,
        minCellPx
      );
      const effectiveGain = Math.min(m.cell, desiredCellPx);
      if (effectiveGain > bestAchievedCell + 0.08 * uiScale) {
        bestAchievedCell = effectiveGain;
        tileSize = s;
      }
      if (m.cell >= desiredCellPx * 0.96) break;
    }
  }

  const specH = Math.max(Math.round(14 * uiScale), Math.round(tileSize * specRatio));
  const stripW = tileSize * cols + colGap * (cols - 1);
  const topStripH = rows * (tileSize + specH) + (rows - 1) * rowGap;
  const stripLeft = Math.round((W - stripW) / 2);

  const minSideW = Math.min(Math.round(48 * uiScale), Math.floor((stripW - splitGap) * 0.45));
  const handW = isRightHand
    ? Math.max(
        minSideW,
        Math.min(
          stripW - splitGap - minSideW,
          Math.round((stripW - splitGap) * (handWidthPct / 100))
        )
      )
    : isBelowHand
      ? stripW
      : 0;
  const targetW = isRightHand ? Math.max(minSideW, stripW - splitGap - handW) : stripW;
  const rawAvailH = Math.max(Math.round(32 * uiScale), H - topStripH - betweenGap - marginY * 2);
  const maxAvailHCap = isPortrait ? Math.round(H * 0.25) : Math.round(shortDim * 0.42);
  const desiredBelowHandH = isBelowHand
    ? Math.max(Math.round(24 * uiScale), Math.round(stripW * (handHeightPct / 100)))
    : 0;
  const minBelowMosaicH = isBelowHand
    ? Math.max(
        Math.round(24 * uiScale),
        Math.min(Math.round(64 * uiScale), Math.round(rawAvailH * 0.28))
      )
    : 0;
  const belowHandH = isBelowHand
    ? tileCount > 0
      ? Math.min(
          desiredBelowHandH,
          Math.max(Math.round(24 * uiScale), rawAvailH - splitGap - minBelowMosaicH)
        )
      : Math.min(desiredBelowHandH, rawAvailH)
    : 0;
  const availH = isRightHand
    ? Math.min(rawAvailH, Math.max(Math.round(32 * uiScale), maxAvailHCap))
    : isBelowHand
      ? Math.max(Math.round(24 * uiScale), rawAvailH - (tileCount > 0 ? splitGap + belowHandH : 0))
      : rawAvailH;

  if (tileCount === 0) {
    const bottomRowH = isRightHand
      ? Math.min(availH, Math.max(Math.round(24 * uiScale), Math.round(handW / 4.2)))
      : isBelowHand
        ? belowHandH
        : 0;
    const effBetween = topStripH > 0 && bottomRowH > 0 ? betweenGap : 0;
    const totalStackH = topStripH + effBetween + bottomRowH;
    const stackTopY = Math.max(marginY, Math.round((H - totalStackH) * 0.5));
    const bottomTopY = Math.round(stackTopY + topStripH + effBetween);
    const hx = isRightHand
      ? Math.max(0, Math.min(W - 2, stripLeft + stripW - handW))
      : Math.max(0, Math.min(W - 2, stripLeft));
    const hy = Math.max(0, Math.min(H - 2, bottomTopY));
    return {
      uiScale,
      cols,
      rows,
      tileSize,
      specH,
      colGap,
      rowGap,
      betweenGap,
      stripW,
      stripLeft,
      topStripH,
      stackTopY,
      videoPosition,
      handRect: splitHandVideo
        ? {
            x: hx,
            y: hy,
            w: Math.max(2, Math.min(W - hx, isBelowHand ? stripW : handW)),
            h: Math.max(2, Math.min(H - hy, Math.round(bottomRowH)))
          }
        : null,
      mosaic: {
        cols: 1,
        rows: 0,
        cell: 12 * uiScale,
        gap: mosaicGap,
        gridW: 0,
        gridH: 0,
        originX: stripLeft,
        originY: bottomTopY
      }
    };
  }

  const solved = solveMosaicFlushScaled(
    targetW,
    availH,
    tileCount,
    desiredCellPx,
    mosaicGap,
    minCellPx
  );
  const gridW = solved.gridW;
  const gridH = solved.gridH;
  const bottomRowH = isBelowHand ? gridH + splitGap + belowHandH : gridH;
  const effBetween = topStripH > 0 ? betweenGap : 0;
  const totalStackH = topStripH + effBetween + bottomRowH;
  const stackTopY = Math.max(Math.round(10 * uiScale), Math.round((H - totalStackH) * 0.5));
  const bottomTopY = Math.round(stackTopY + topStripH + effBetween);
  const originX = isRightHand ? stripLeft : (W - gridW) * 0.5;
  const originY = bottomTopY;
  const hx = isRightHand
    ? Math.max(0, Math.min(W - 2, Math.round(stripLeft + targetW + splitGap)))
    : Math.max(0, Math.min(W - 2, stripLeft));
  const hy = isBelowHand
    ? Math.max(0, Math.min(H - 2, Math.round(bottomTopY + gridH + splitGap)))
    : Math.max(0, Math.min(H - 2, bottomTopY));
  const hh = isBelowHand ? Math.round(belowHandH) : Math.round(gridH);

  return {
    uiScale,
    cols,
    rows,
    tileSize,
    specH,
    colGap,
    rowGap,
    betweenGap,
    stripW,
    stripLeft,
    topStripH,
    stackTopY,
    videoPosition,
    handRect: splitHandVideo
      ? {
          x: hx,
          y: hy,
          w: Math.max(2, Math.min(W - hx, isBelowHand ? stripW : handW)),
          h: Math.max(2, Math.min(H - hy, hh))
        }
      : null,
    mosaic: {
      cols: solved.cols,
      rows: solved.rows,
      cell: solved.cell,
      gap: mosaicGap,
      gridW,
      gridH,
      originX,
      originY
    }
  };
}

// ============================================================================
// Neutral Grayscale Spectrogram Builder (Matching offline-render.mjs & app.js)
// ============================================================================

function fftInPlace(real, imag) {
  const n = real.length;
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (i < j) {
      const tr = real[i]; real[i] = real[j]; real[j] = tr;
      const ti = imag[i]; imag[i] = imag[j]; imag[i] = ti;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }
  for (let s = 1; (1 << s) <= n; s++) {
    const m = 1 << s;
    const halfM = m >> 1;
    const theta = (-2 * Math.PI) / m;
    const wpr = Math.cos(theta);
    const wpi = Math.sin(theta);
    for (let k = 0; k < n; k += m) {
      let wr = 1.0;
      let wi = 0.0;
      for (let j2 = 0; j2 < halfM; j2++) {
        const idx1 = k + j2;
        const idx2 = idx1 + halfM;
        const tr = wr * real[idx2] - wi * imag[idx2];
        const ti = wr * imag[idx2] + wi * real[idx2];
        real[idx2] = real[idx1] - tr;
        imag[idx2] = imag[idx1] - ti;
        real[idx1] += tr;
        imag[idx1] += ti;
        const wtemp = wr;
        wr = wr * wpr - wi * wpi;
        wi = wtemp * wpi + wi * wpr;
      }
    }
  }
}

function computeSpecDbBounds(colMags, minBin, maxBin, globalMaxDb, baseRangeDb) {
  const BINS = 128;
  const span = 72;
  const histMin = globalMaxDb - span;
  const counts = new Uint32Array(BINS);
  let total = 0;
  for (let x = 0; x < colMags.length; x++) {
    const dbArr = colMags[x];
    for (let k = minBin; k <= maxBin; k++) {
      const idx = Math.max(
        0,
        Math.min(BINS - 1, Math.floor(((dbArr[k] - histMin) / span) * (BINS - 1)))
      );
      counts[idx]++;
      total++;
    }
  }
  if (total === 0) return { ceilDb: globalMaxDb, floorDb: globalMaxDb - baseRangeDb };
  const medianTarget = total * 0.55;
  const p99Target = total * 0.992;
  let acc = 0;
  let medianDb = histMin;
  let p99Db = globalMaxDb;
  let foundMedian = false;
  for (let i = 0; i < BINS; i++) {
    acc += counts[i];
    if (!foundMedian && acc >= medianTarget) {
      medianDb = histMin + (i / (BINS - 1)) * span;
      foundMedian = true;
    }
    if (acc >= p99Target) {
      p99Db = histMin + (i / (BINS - 1)) * span;
      break;
    }
  }
  const headroomTrim = Math.min(8.5, Math.max(0, globalMaxDb - p99Db));
  const ceilDb = globalMaxDb - 0.5 * headroomTrim;
  const rawFloor = ceilDb - baseRangeDb;
  const noiseGuardFloor = medianDb + 5.0;
  const floorDb = Math.min(ceilDb - 18, Math.max(rawFloor, 0.5 * (noiseGuardFloor + rawFloor)));
  return { ceilDb, floorDb };
}

function grayScreenSpecValue(norm) {
  const t = Math.max(0, Math.min(1, norm));
  if (t <= 0.035) return 0;
  const u = (t - 0.035) / 0.965;
  const toe = Math.min(1, u / 0.04);
  const curved = Math.max(0, Math.min(1, Math.pow(u, 0.865) * toe));
  return Math.max(0, Math.min(255, Math.round(curved * 243)));
}

function buildMiniSpectrogramCanvas(audioBuffer, targetW, targetH, playbackRate, trimIn, bufferSpanSec) {
  const samples = audioBuffer.getChannelData(0);
  const sr = audioBuffer.sampleRate;
  const bmpW = 256;
  const bmpH = 256;
  const effectiveSr = sr * playbackRate;
  const s0 = Math.max(0, Math.min(samples.length - 1, Math.floor(trimIn * sr)));
  const spanSamples = bufferSpanSec
    ? Math.max(FFT_SIZE, Math.floor(bufferSpanSec * sr))
    : Math.max(FFT_SIZE, samples.length - s0);
  const sEnd = Math.min(samples.length, s0 + spanSamples);
  const usableSpan = Math.max(1, sEnd - s0 - FFT_SIZE);

  const real = new Float32Array(FFT_SIZE);
  const imag = new Float32Array(FFT_SIZE);
  const half = FFT_SIZE >> 1;
  const minBin = Math.max(1, Math.floor((SPEC_MIN_FREQ * FFT_SIZE) / effectiveSr));
  const maxBin = Math.min(half - 1, Math.ceil((MINI_SPEC_MAX_FREQ * FFT_SIZE) / effectiveSr));
  const colMags = new Array(bmpW);
  let globalMaxDb = -90;

  for (let x = 0; x < bmpW; x++) {
    const startSample = s0 + Math.floor((x / bmpW) * usableSpan);
    for (let i = 0; i < FFT_SIZE; i++) {
      real[i] = (samples[startSample + i] || 0) * HANN_WIN[i];
      imag[i] = 0;
    }
    fftInPlace(real, imag);
    const dbArr = new Float32Array(half);
    for (let k = 1; k < half; k++) {
      const db = 20 * Math.log10(Math.hypot(real[k], imag[k]) + 1e-7);
      dbArr[k] = db;
      if (k >= minBin && k <= maxBin && db > globalMaxDb) globalMaxDb = db;
    }
    colMags[x] = dbArr;
  }

  const { ceilDb, floorDb } = computeSpecDbBounds(colMags, minBin, maxBin, globalMaxDb, 44);
  const denom = Math.max(1e-5, ceilDb - floorDb);

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = bmpW;
  srcCanvas.height = bmpH;
  const sctx = srcCanvas.getContext('2d');
  const imgData = sctx.createImageData(bmpW, bmpH);
  const data = imgData.data;

  for (let x = 0; x < bmpW; x++) {
    const dbArr = colMags[x];
    for (let y = 0; y < bmpH; y++) {
      const normY = 1 - y / (bmpH - 1);
      const freq = miniSpecNormYToFreq(normY);
      const exactBin = (freq * FFT_SIZE) / effectiveSr;
      const b0 = Math.max(1, Math.min(half - 2, Math.floor(exactBin)));
      const frac = exactBin - b0;
      const db = dbArr[b0] * (1 - frac) + dbArr[b0 + 1] * frac;
      const g = grayScreenSpecValue((db - floorDb) / denom);
      const off = (y * bmpW + x) * 4;
      data[off] = g;
      data[off + 1] = g;
      data[off + 2] = g;
      data[off + 3] = 255;
    }
  }
  sctx.putImageData(imgData, 0, 0);

  const dstCanvas = document.createElement('canvas');
  dstCanvas.width = Math.max(1, targetW);
  dstCanvas.height = Math.max(1, targetH);
  const dctx = dstCanvas.getContext('2d');
  dctx.imageSmoothingEnabled = true;
  dctx.imageSmoothingQuality = 'high';
  dctx.drawImage(srcCanvas, 0, 0, dstCanvas.width, dstCanvas.height);
  return dstCanvas;
}

// ============================================================================
// WebCodecs Video Clip Decoder + Streaming Hand Video Reader (with <video> Fallback)
// ============================================================================

async function decodeClipFramesViaWebCodecs(mp4Bytes, side, fps = 30, startSec = 0, maxDurSec = 6.0) {
  const track = demuxMp4AvcTrack(mp4Bytes);
  if (typeof VideoDecoder !== 'function') {
    throw new Error('VideoDecoder unavailable');
  }
  const cfg = {
    codec: track.codec,
    codedWidth: track.width,
    codedHeight: track.height,
    description: track.avcCBytes
  };
  const sup = await VideoDecoder.isConfigSupported(cfg);
  if (!sup.supported) {
    throw new Error(`Unsupported AVC config ${track.codec}`);
  }

  const endPtsUs = Math.ceil((startSec + maxDurSec + 0.12) * 1_000_000);
  const startPtsUs = Math.max(0, Math.floor((startSec - 0.05) * 1_000_000));

  // Find last keyframe at or before startPtsUs
  let startSampleIdx = 0;
  for (let i = 0; i < track.samples.length; i++) {
    const s = track.samples[i];
    if (s.isKeyframe && s.ptsUs <= startPtsUs) {
      startSampleIdx = i;
    }
  }

  const decoded = [];
  const scaleCanvas = document.createElement('canvas');
  scaleCanvas.width = side;
  scaleCanvas.height = side;
  const sctx = scaleCanvas.getContext('2d', { willReadFrequently: false });
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';

  let decodeError = null;
  const pendingBitmaps = [];

  const decoder = new VideoDecoder({
    output(vf) {
      const tsUs = vf.timestamp;
      if (tsUs >= startPtsUs - 40_000 && tsUs <= endPtsUs + 80_000) {
        sctx.drawImage(vf, 0, 0, side, side);
        const p = createImageBitmap(scaleCanvas).then(bmp => {
          decoded.push({ ptsUs: tsUs, bmp });
        });
        pendingBitmaps.push(p);
      }
      vf.close();
    },
    error(err) {
      decodeError = err;
    }
  });

  decoder.configure(cfg);

  for (let i = startSampleIdx; i < track.samples.length; i++) {
    const s = track.samples[i];
    // Stop feeding once we're past the GOP after endPtsUs
    if (s.isKeyframe && s.ptsUs > endPtsUs + 150_000 && i > startSampleIdx) {
      break;
    }
    const chunk = new EncodedVideoChunk({
      type: s.isKeyframe ? 'key' : 'delta',
      timestamp: s.ptsUs,
      duration: s.durationUs,
      data: track.dataBuffer.subarray(s.offset, s.offset + s.size)
    });
    decoder.decode(chunk);
  }

  await decoder.flush();
  decoder.close();
  await Promise.all(pendingBitmaps);
  if (decodeError) throw decodeError;

  decoded.sort((a, b) => a.ptsUs - b.ptsUs);
  if (!decoded.length) {
    const blank = await createImageBitmap(scaleCanvas);
    return [blank];
  }

  // Resample onto uniform `fps` timeline starting at `startSec`
  const targetCount = Math.max(1, Math.ceil(maxDurSec * fps));
  const outFrames = new Array(targetCount);
  const usedSet = new Set();
  let cursor = 0;
  for (let f = 0; f < targetCount; f++) {
    const targetUs = Math.round((startSec + f / fps) * 1_000_000);
    while (
      cursor + 1 < decoded.length &&
      Math.abs(decoded[cursor + 1].ptsUs - targetUs) <= Math.abs(decoded[cursor].ptsUs - targetUs)
    ) {
      cursor++;
    }
    outFrames[f] = decoded[cursor].bmp;
    usedSet.add(decoded[cursor].bmp);
  }
  for (const d of decoded) {
    if (!usedSet.has(d.bmp)) {
      try {
        d.bmp.close();
      } catch {}
    }
  }
  return outFrames;
}

async function decodeClipFramesViaVideoElement(url, side, fps = 30, startSec = 0, maxDurSec = 6.0) {
  const vid = document.createElement('video');
  vid.muted = true;
  vid.playsInline = true;
  vid.preload = 'auto';
  vid.crossOrigin = 'anonymous';
  vid.src = url;

  await new Promise((resolve, reject) => {
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error(`Failed loading video ${url}`));
    };
    const cleanup = () => {
      vid.removeEventListener('loadeddata', onLoaded);
      vid.removeEventListener('error', onErr);
    };
    vid.addEventListener('loadeddata', onLoaded, { once: true });
    vid.addEventListener('error', onErr, { once: true });
  });

  const dur = Math.max(0.05, Math.min(maxDurSec, (Number(vid.duration) || maxDurSec) - startSec));
  const count = Math.max(1, Math.ceil(dur * fps));
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d');
  const frames = [];

  for (let f = 0; f < count; f++) {
    const targetT = Math.min(Math.max(0, (Number(vid.duration) || dur) - 0.01), startSec + f / fps);
    if (Math.abs(vid.currentTime - targetT) > 0.004) {
      vid.currentTime = targetT;
      await new Promise(r => vid.addEventListener('seeked', r, { once: true }));
    }
    ctx.drawImage(vid, 0, 0, side, side);
    frames.push(await createImageBitmap(canvas));
  }
  vid.removeAttribute('src');
  vid.load();
  return frames;
}

function closeFrameBitmaps(frames) {
  if (!Array.isArray(frames)) return;
  const closed = new Set();
  for (const bmp of frames) {
    if (bmp && !closed.has(bmp) && typeof bmp.close === 'function') {
      closed.add(bmp);
      try {
        bmp.close();
      } catch {}
    }
  }
}

// Streaming Hand Video Reader: decodes GOPs progressively just ahead of `t` (<15MB memory even on 60s 1080p video!)
async function createStreamingHandVideoReader({
  videoUrl,
  dstW,
  dstH,
  zoom = 1.0,
  cropX = 50,
  cropY = 50,
  brightness = 1.0,
  leadOffsetSec = 0
}) {
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = dstW;
  cropCanvas.height = dstH;
  const cctx = cropCanvas.getContext('2d', { willReadFrequently: true });
  cctx.imageSmoothingEnabled = true;
  cctx.imageSmoothingQuality = 'high';

  const contrastLut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const cVal = Math.max(0, Math.min(255, (v - 128) * 1.06 + 128));
    contrastLut[v] = Math.max(0, Math.min(255, Math.round(cVal * brightness)));
  }

  function drawCroppedBwSource(source, srcW, srcH) {
    const zW = Math.max(dstW, dstW * zoom);
    const zH = Math.max(dstH, dstH * zoom);
    const scale = Math.max(zW / Math.max(1, srcW), zH / Math.max(1, srcH));
    const iw = srcW * scale;
    const ih = srcH * scale;
    const dx = -((iw - dstW) * (cropX / 100));
    const dy = -((ih - dstH) * (cropY / 100));

    cctx.clearRect(0, 0, dstW, dstH);
    cctx.drawImage(source, dx, dy, iw, ih);

    // Exact BT.709 grayscale + contrast(1.06) + brightness Lut matching offline-render.mjs
    const img = cctx.getImageData(0, 0, dstW, dstH);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
      const g = contrastLut[lum];
      d[i] = g;
      d[i + 1] = g;
      d[i + 2] = g;
      d[i + 3] = 255;
    }
    cctx.putImageData(img, 0, 0);
  }

  // Try fast WebCodecs MP4 streaming path first
  try {
    const resp = await fetch(videoUrl);
    if (!resp.ok) throw new Error('Hand video fetch failed');
    const buf = new Uint8Array(await resp.arrayBuffer());
    const track = demuxMp4AvcTrack(buf);
    const cfg = {
      codec: track.codec,
      codedWidth: track.width,
      codedHeight: track.height,
      description: track.avcCBytes
    };
    const sup = await VideoDecoder.isConfigSupported(cfg);
    if (!sup.supported) throw new Error('Hand AVC unsupported');

    const readyFrames = []; // sorted by ptsUs: { ptsUs, bmp }
    const pendingBmpPromises = new Set();
    let nextSampleIdx = 0;
    let lastReturnedBmp = null;
    let decoderClosed = false;

    const decoder = new VideoDecoder({
      output(vf) {
        const tsUs = vf.timestamp;
        drawCroppedBwSource(vf, track.width, track.height);
        vf.close();
        const p = createImageBitmap(cropCanvas).then(bmp => {
          readyFrames.push({ ptsUs: tsUs, bmp });
          readyFrames.sort((a, b) => a.ptsUs - b.ptsUs);
          pendingBmpPromises.delete(p);
        });
        pendingBmpPromises.add(p);
      },
      error() {
        decoderClosed = true;
      }
    });
    decoder.configure(cfg);

    async function pumpUpToUs(targetPtsUs) {
      const lookaheadUs = targetPtsUs + 600_000; // decode ~0.6s ahead so B-frame reordering is complete
      while (!decoderClosed && nextSampleIdx < track.samples.length) {
        const s = track.samples[nextSampleIdx];
        if (s.isKeyframe && s.ptsUs > lookaheadUs && readyFrames.length > 0) {
          break;
        }
        nextSampleIdx++;
        decoder.decode(
          new EncodedVideoChunk({
            type: s.isKeyframe ? 'key' : 'delta',
            timestamp: s.ptsUs,
            duration: s.durationUs,
            data: track.dataBuffer.subarray(s.offset, s.offset + s.size)
          })
        );
        if (decoder.decodeQueueSize > 24) {
          await new Promise(r => setTimeout(r, 2));
        }
        if (s.ptsUs > lookaheadUs && nextSampleIdx % 16 === 0) break;
      }
      if (nextSampleIdx >= track.samples.length && !decoderClosed) {
        await decoder.flush();
      }
      while (decoder.decodeQueueSize > 8) {
        await new Promise(r => setTimeout(r, 2));
      }
      if (pendingBmpPromises.size > 0) {
        await Promise.all(Array.from(pendingBmpPromises));
      }
    }

    return {
      async getFrameAtSec(songSec) {
        const targetUs = Math.max(0, Math.round((songSec + leadOffsetSec) * 1_000_000));
        await pumpUpToUs(targetUs);

        // Evict old frames well behind targetUs (keeping at least 2 recent frames)
        while (readyFrames.length > 2 && readyFrames[1].ptsUs <= targetUs) {
          const old = readyFrames.shift();
          if (old.bmp && old.bmp !== lastReturnedBmp) {
            try {
              old.bmp.close();
            } catch {}
          }
        }
        if (!readyFrames.length) return lastReturnedBmp;
        let best = readyFrames[0];
        for (let i = 1; i < readyFrames.length; i++) {
          if (Math.abs(readyFrames[i].ptsUs - targetUs) <= Math.abs(best.ptsUs - targetUs)) {
            best = readyFrames[i];
          } else {
            break;
          }
        }
        if (lastReturnedBmp && lastReturnedBmp !== best.bmp && !readyFrames.some(r => r.bmp === lastReturnedBmp)) {
          try {
            lastReturnedBmp.close();
          } catch {}
        }
        lastReturnedBmp = best.bmp;
        return best.bmp;
      },
      close() {
        decoderClosed = true;
        try {
          if (decoder.state !== 'closed') decoder.close();
        } catch {}
        for (const r of readyFrames) {
          try {
            r.bmp.close();
          } catch {}
        }
        if (lastReturnedBmp) {
          try {
            lastReturnedBmp.close();
          } catch {}
        }
        readyFrames.length = 0;
      }
    };
  } catch {
    // Fallback for in-memory .webm MediaRecorder webcam blobs
    const vid = document.createElement('video');
    vid.muted = true;
    vid.playsInline = true;
    vid.preload = 'auto';
    vid.src = videoUrl;
    await new Promise((resolve, reject) => {
      vid.addEventListener('loadeddata', resolve, { once: true });
      vid.addEventListener('error', () => reject(new Error('Hand video fallback load failed')), { once: true });
    });
    const vw = vid.videoWidth || 1280;
    const vh = vid.videoHeight || 720;
    let lastSeekT = -999;

    return {
      async getFrameAtSec(songSec) {
        const dur = Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : 300;
        const targetT = Math.max(0, Math.min(dur - 0.02, songSec + leadOffsetSec));
        if (Math.abs(targetT - lastSeekT) > 0.012) {
          vid.currentTime = targetT;
          await new Promise(r => vid.addEventListener('seeked', r, { once: true }));
          lastSeekT = targetT;
          drawCroppedBwSource(vid, vw, vh);
        }
        return cropCanvas;
      },
      close() {
        vid.removeAttribute('src');
        vid.load();
      }
    };
  }
}

// ============================================================================
// Pre-Bake Idle Mosaic Background + Active Chromatic Patch Sprites
// ============================================================================

function buildMosaicCanvasAndPatches(W, H, mosaicItems, mosaicLayout, atlasImage, stampIdleToBg = true) {
  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = W;
  bgCanvas.height = H;
  const bgCtx = bgCanvas.getContext('2d', { willReadFrequently: true });
  bgCtx.fillStyle = '#000000';
  bgCtx.fillRect(0, 0, W, H);

  if (!mosaicItems.length || !atlasImage) {
    return { bgCanvas, patches: [] };
  }

  // Read atlas pixels once on a temporary canvas for crisp subpixel sampling
  const aw = atlasImage.naturalWidth || atlasImage.width;
  const ah = atlasImage.naturalHeight || atlasImage.height;
  const tmpAtlas = document.createElement('canvas');
  tmpAtlas.width = aw;
  tmpAtlas.height = ah;
  const actx = tmpAtlas.getContext('2d', { willReadFrequently: true });
  actx.drawImage(atlasImage, 0, 0);
  const atlasData = actx.getImageData(0, 0, aw, ah).data;

  const bgImg = bgCtx.getImageData(0, 0, W, H);
  const bgData = bgImg.data;
  const { cols, cell, gap, originX, originY } = mosaicLayout;
  const stride = cell + gap;
  const patches = [];

  function sampleAtlasLuma(u0, v0, u1, v1, relX0, relY0, relX1, relY1) {
    const ax0 = Math.max(0, Math.min(aw - 1, (u0 + (u1 - u0) * relX0) * aw));
    const ax1 = Math.max(ax0 + 0.5, Math.min(aw, (u0 + (u1 - u0) * relX1) * aw));
    const ay0 = Math.max(0, Math.min(ah - 1, (v0 + (v1 - v0) * relY0) * ah));
    const ay1 = Math.max(ay0 + 0.5, Math.min(ah, (v0 + (v1 - v0) * relY1) * ah));
    const ix0 = Math.floor(ax0);
    const ix1 = Math.min(aw - 1, Math.floor(ax1));
    const iy0 = Math.floor(ay0);
    const iy1 = Math.min(ah - 1, Math.floor(ay1));
    let sr = 0, sg = 0, sb = 0, count = 0;
    for (let ay = iy0; ay <= iy1; ay++) {
      const rowBase = ay * aw * 4;
      for (let ax = ix0; ax <= ix1; ax++) {
        const off = rowBase + ax * 4;
        sr += atlasData[off];
        sg += atlasData[off + 1];
        sb += atlasData[off + 2];
        count++;
      }
    }
    if (!count) return 0;
    return (0.299 * sr + 0.587 * sg + 0.114 * sb) / (count * 255);
  }

  for (let i = 0; i < mosaicItems.length; i++) {
    const it = mosaicItems[i];
    const col = i % cols;
    const row = (i / cols) | 0;
    const x0 = originX + col * stride;
    const y0 = originY + row * stride;
    const x1 = x0 + cell;
    const y1 = y0 + cell;

    const px0 = Math.max(0, Math.floor(x0));
    const px1 = Math.min(W - 1, Math.ceil(x1) - 1);
    const py0 = Math.max(0, Math.floor(y0));
    const py1 = Math.min(H - 1, Math.ceil(y1) - 1);
    const pw = Math.max(1, px1 - px0 + 1);
    const ph = Math.max(1, py1 - py0 + 1);

    const idleCanvas = document.createElement('canvas');
    idleCanvas.width = pw;
    idleCanvas.height = ph;
    const ictx = idleCanvas.getContext('2d');
    const idleImg = ictx.createImageData(pw, ph);

    const activeCanvas = document.createElement('canvas');
    activeCanvas.width = pw;
    activeCanvas.height = ph;
    const actxTile = activeCanvas.getContext('2d');
    const actImg = actxTile.createImageData(pw, ph);

    const [nr, ng, nb] = it.borderRgb;

    for (let py = py0; py <= py1; py++) {
      const covY = Math.max(0, Math.min(py + 1, y1) - Math.max(py, y0));
      const relY0 = Math.max(0, Math.min(1, (Math.max(py, y0) - y0) / cell));
      const relY1 = Math.max(relY0 + 0.02, Math.min(1, (Math.min(py + 1, y1) - y0) / cell));

      for (let px = px0; px <= px1; px++) {
        const covX = Math.max(0, Math.min(px + 1, x1) - Math.max(px, x0));
        const cov = covX * covY;
        if (cov <= 0.001) continue;

        const relX0 = Math.max(0, Math.min(1, (Math.max(px, x0) - x0) / cell));
        const relX1 = Math.max(relX0 + 0.02, Math.min(1, (Math.min(px + 1, x1) - x0) / cell));
        const luma = sampleAtlasLuma(it.u0, it.v0, it.u1, it.v1, relX0, relY0, relX1, relY1);
        const crispLuma = Math.min(1, Math.pow(Math.max(0, luma), 0.88) * 1.08);
        const idleInside = crispLuma * 0.42 * 255;
        const idleVal = Math.round(idleInside * cov);

        const pOff = ((py - py0) * pw + (px - px0)) * 4;
        idleImg.data[pOff] = idleVal;
        idleImg.data[pOff + 1] = idleVal;
        idleImg.data[pOff + 2] = idleVal;
        idleImg.data[pOff + 3] = 255;

        actImg.data[pOff] = Math.round((idleInside * 0.15 + nr * 0.85) * cov);
        actImg.data[pOff + 1] = Math.round((idleInside * 0.15 + ng * 0.85) * cov);
        actImg.data[pOff + 2] = Math.round((idleInside * 0.15 + nb * 0.85) * cov);
        actImg.data[pOff + 3] = 255;

        if (stampIdleToBg) {
          const bOff = (py * W + px) * 4;
          bgData[bOff] = Math.min(255, bgData[bOff] + idleVal);
          bgData[bOff + 1] = Math.min(255, bgData[bOff + 1] + idleVal);
          bgData[bOff + 2] = Math.min(255, bgData[bOff + 2] + idleVal);
        }
      }
    }

    ictx.putImageData(idleImg, 0, 0);
    actxTile.putImageData(actImg, 0, 0);
    patches.push({ sliceId: it.sliceId, px0, py0, pw, ph, idleCanvas, activeCanvas });
  }

  bgCtx.putImageData(bgImg, 0, 0);
  return { bgCanvas, bgCtx, patches };
}

// ============================================================================
// OfflineAudioContext 48kHz Master Mix + Soft Compressor + Normalization
// ============================================================================

async function renderOfflineMasterAudio({
  renderDurationSec,
  voices,
  buildPlan,
  audioBufferByUrl,
  endFadeStartSec,
  endFadeCompleteSec
}) {
  const totalSamples = Math.max(1024, Math.ceil(renderDurationSec * AUDIO_SR));
  const offCtx = new OfflineAudioContext(2, totalSamples, AUDIO_SR);

  const highpass = offCtx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = HIGHPASS_HZ;
  highpass.Q.value = Math.SQRT1_2;

  const makeup = offCtx.createGain();
  makeup.gain.value = Math.pow(10, 8.5 / 20);

  const comp = offCtx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 12;
  comp.ratio.value = 3.5;
  comp.attack.value = 0.005;
  comp.release.value = 0.18;

  highpass.connect(makeup);
  makeup.connect(comp);
  comp.connect(offCtx.destination);

  if (buildPlan && buildPlan.buildSound && buildPlan.showcaseSteps?.length) {
    const tapFloat = synthesizeBuildTapPcm(AUDIO_SR);
    const tapBuf = offCtx.createBuffer(1, tapFloat.length, AUDIO_SR);
    tapBuf.getChannelData(0).set(tapFloat);

    for (const st of buildPlan.showcaseSteps) {
      const tapSrc = offCtx.createBufferSource();
      tapSrc.buffer = tapBuf;
      tapSrc.playbackRate.setValueAtTime(Number(st.tapRate) > 0 ? st.tapRate : 1.0, st.startSec);
      const tapGain = offCtx.createGain();
      tapGain.gain.setValueAtTime(st.tapGain ?? BUILD_TAP_BASE_GAIN, st.startSec);
      tapSrc.connect(tapGain);
      tapGain.connect(highpass);
      tapSrc.start(st.startSec);

      const ab = audioBufferByUrl.get(st.cand?.audioUrl);
      if (!ab) continue;
      const src = offCtx.createBufferSource();
      src.buffer = ab;
      src.playbackRate.setValueAtTime(st.playbackRate, st.startSec);

      const g = offCtx.createGain();
      const pk = st.peakGain;
      const relStart = st.startSec + st.relStartOffset;
      const relDur = Math.max(0.015, st.relDur);
      g.gain.setValueAtTime(0.0001, st.startSec);
      g.gain.linearRampToValueAtTime(pk, st.startSec + 0.004);
      if (relStart > st.startSec + 0.004) g.gain.setValueAtTime(pk, relStart);
      const r0 = Math.max(st.startSec + 0.005, relStart);
      g.gain.linearRampToValueAtTime(pk * 0.52, r0 + relDur * 0.38);
      g.gain.linearRampToValueAtTime(pk * 0.16, r0 + relDur * 0.74);
      g.gain.linearRampToValueAtTime(0.0001, r0 + relDur);

      src.connect(g);
      g.connect(highpass);
      src.start(st.startSec, st.trimIn, st.bufferPlaySpan + 0.02);
    }
  }

  for (const v of voices) {
    const ab = audioBufferByUrl.get(v.cand?.audioUrl);
    if (!ab) continue;
    const src = offCtx.createBufferSource();
    src.buffer = ab;
    src.playbackRate.setValueAtTime(v.playbackRate, v.startSec);

    const g = offCtx.createGain();
    g.gain.setValueAtTime(0.0001, v.startSec);

    if (v.stolenAtSec !== null && v.stolenAtSec <= v.startSec + 0.006) {
      g.gain.linearRampToValueAtTime(0.0001, v.startSec + 0.016);
    } else {
      g.gain.linearRampToValueAtTime(v.peakGain, v.startSec + 0.006);
      if (v.stolenAtSec !== null && v.stolenAtSec < v.endSec) {
        const fDur = Math.max(0.01, v.stolenFadeDur || 0.016);
        g.gain.setValueAtTime(Math.max(0.0001, v.stolenGainStart), v.stolenAtSec);
        g.gain.linearRampToValueAtTime(0.0001, v.stolenAtSec + fDur);
      } else if (v.earlyRelSec !== null && v.earlyRelSec < v.endSec) {
        const r0 = Math.max(v.startSec + 0.006, v.earlyRelSec);
        const rDur = Math.max(0.02, v.earlyRelDur);
        const g0 = Math.max(0.0001, v.earlyRelGainStart);
        g.gain.setValueAtTime(g0, r0);
        g.gain.linearRampToValueAtTime(g0 * 0.56, r0 + rDur * 0.35);
        g.gain.linearRampToValueAtTime(g0 * 0.18, r0 + rDur * 0.72);
        g.gain.linearRampToValueAtTime(0.0001, r0 + rDur);
      } else {
        const fStart = v.startSec + v.forcedRelStart;
        const fDur = Math.max(0.02, v.forcedRelDur);
        g.gain.setValueAtTime(v.peakGain, fStart);
        g.gain.linearRampToValueAtTime(v.peakGain * 0.56, fStart + fDur * 0.35);
        g.gain.linearRampToValueAtTime(v.peakGain * 0.18, fStart + fDur * 0.72);
        g.gain.linearRampToValueAtTime(0.0001, v.startSec + v.naturalDur);
      }
    }

    src.connect(g);
    g.connect(highpass);
    const playSpan = Math.max(0.03, (v.endSec - v.startSec) * v.playbackRate + 0.02);
    src.start(v.startSec, v.trimIn, Math.min(v.bufferPlaySpan + 0.02, playSpan));
  }

  const rendered = await offCtx.startRendering();
  const ch0 = rendered.getChannelData(0);
  const ch1 = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : ch0;

  let peak = 0;
  for (let i = 0; i < ch0.length; i++) {
    const a0 = Math.abs(ch0[i]);
    const a1 = Math.abs(ch1[i]);
    if (a0 > peak) peak = a0;
    if (a1 > peak) peak = a1;
  }
  const targetPeak = 0.871; // -1.2 dBFS
  const scale = peak > 1e-4 ? (peak > targetPeak ? targetPeak / peak : Math.min(6.31, targetPeak / peak)) : 1.0;

  const sFade0 = Number.isFinite(endFadeStartSec) ? Math.max(0, Math.floor(endFadeStartSec * AUDIO_SR)) : ch0.length;
  const sFade1 = Number.isFinite(endFadeCompleteSec) ? Math.min(ch0.length, Math.ceil(endFadeCompleteSec * AUDIO_SR)) : ch0.length;

  for (let i = 0; i < ch0.length; i++) {
    let env = scale;
    if (i >= sFade0) {
      if (i >= sFade1) env = 0;
      else {
        const u = Math.max(0, Math.min(1, (sFade1 - i) / Math.max(1, sFade1 - sFade0)));
        env *= u * u * (3 - 2 * u);
      }
    }
    ch0[i] *= env;
    if (ch1 !== ch0) ch1[i] *= env;
  }

  return rendered;
}

// ============================================================================
// Main Browser Offline MP4 Export Entrypoint
// ============================================================================

export async function renderMidiSessionInBrowserToMp4({
  parsedMidi,
  sessionName = 'everytone',
  aspectRatio = '9:16',
  fps = 30,
  catalog,
  keyboardMap,
  isVideoDisabled = () => false,
  getGroupKey = () => '',
  getVideoGainDb = () => 0,
  loadAudioBuffer,
  resolveMediaUrl = url => url,
  atlasManifest = null,
  atlasImage = null,
  gridMode = '3x2',
  tileScale = 1.1,
  specScale = 3.35,
  fadeInSec = 0.0,
  fadeOutSec = 0.2,
  minDisplaySec = 0.7,
  transposeOctaves = 0,
  showHandVideo = true,
  handVideoUrl = '',
  handVideoLeadOffsetSec = 0,
  videoPosition = 'right',
  videoWidthPct = 50,
  videoHeightPct = 23,
  videoCropX = 50,
  videoCropY = 50,
  videoZoom = 1.0,
  videoBrightness = 0.55,
  includeBuild = true,
  buildFullSec = 5.0,
  buildMaxFps = 12,
  buildRampUp = true,
  buildSound = true,
  signal = null,
  onProgress = null
}) {
  if (!isBrowserOfflineExportSupported()) {
    throw new Error('WebCodecs offline MP4 export requires a modern Chrome, Safari, Edge, or Firefox browser.');
  }
  if (!parsedMidi?.events?.length) {
    throw new Error('No MIDI events loaded to export.');
  }

  const checkAbort = () => {
    if (signal?.aborted) {
      const err = new Error('Export cancelled');
      err.name = 'AbortError';
      throw err;
    }
  };

  const report = (phase, percent) => {
    if (typeof onProgress === 'function') {
      onProgress({ phase, percent: Math.max(0, Math.min(100, Math.round(percent))) });
    }
  };

  const normAspect = normalizeBrowserAspectRatio(aspectRatio);
  const aspectSpec = BROWSER_ASPECT_SPECS[normAspect];
  const W = aspectSpec.width;
  const H = aspectSpec.height;
  const gridSpec = parseBrowserStageGridMode(gridMode, '3x2');
  const stageSlotCount = gridSpec.slots;

  report(`Planning ${aspectSpec.label} timeline…`, 2);
  checkAbort();

  // Deep-clone parsed MIDI events so live transport state is never mutated
  const parsedClone = {
    ...parsedMidi,
    events: parsedMidi.events.map(ev => ({ ...ev }))
  };

  // Build ordered mosaic items matching live Three.js stage
  const mosaicItems = [];
  if (atlasManifest?.items?.length && catalog?.videos?.length) {
    const atlasBySlice = new Map(atlasManifest.items.map(it => [it.sliceId, it]));
    const assignedBySlice = new Map();
    for (const [mStr, entry] of Object.entries(keyboardMap || {})) {
      const m = Number(mStr);
      for (const c of entry?.candidates || []) {
        if (c?.sliceId) {
          assignedBySlice.set(c.sliceId, {
            midi: Number.isFinite(m) ? m : Number(c.midi ?? 60),
            isPerc: Boolean(c.isPerc),
            cand: c
          });
        }
      }
    }

    const activeVids = sortCatalogVideosInSidebarOrder(
      catalog.videos.filter(v => !v.deleted && !isVideoDisabled(v.id))
    );
    for (const v of activeVids) {
      const gKey = getGroupKey({ videoId: v.id }) || v.id;
      const slices = (v.slices || [])
        .filter(s => !s.deleted)
        .slice()
        .sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0) || (a.hitIndex ?? 0) - (b.hitIndex ?? 0));
      for (const s of slices) {
        const uv = atlasBySlice.get(s.id);
        if (!uv) continue;
        const asg = assignedBySlice.get(s.id);
        const midi = asg
          ? asg.midi
          : Number.isFinite(s.manualMidi)
            ? Number(s.manualMidi)
            : Number(s.midi ?? uv.midi ?? 60);
        const isPerc = asg ? asg.isPerc : v.category === 'percussion';
        const rawDurSec = Math.min(MAX_CLIP_DUR, Number(s.rawDurSec ?? s.durSec ?? 1.8));
        const trimIn = Math.max(0, Number(s.trimIn ?? 0));
        const trimOut = Math.max(trimIn + 0.08, Math.min(rawDurSec, Number(s.trimOut ?? rawDurSec)));
        const cand = asg?.cand || {
          sliceId: s.id,
          videoId: v.id,
          videoSlug: v.slug,
          midi,
          isPerc,
          playbackRate: 1.0,
          videoUrl: s.videoUrl,
          audioUrl: s.audioUrl,
          rawDurSec,
          trimIn,
          trimOut,
          durSec: Math.max(0.08, trimOut - trimIn)
        };
        const instName = String(v.groupName || v.slug || 'sample').trim().toLowerCase();
        mosaicItems.push({
          ...uv,
          sliceId: s.id,
          videoId: v.id,
          groupKey: gKey,
          instrumentName: instName,
          midi,
          isPerc,
          cand,
          borderRgb: hexToRgb(getNoteHex(midi, isPerc))
        });
      }
    }
  }

  const splitHandVideo = Boolean(showHandVideo && handVideoUrl);
  const buildPlan =
    includeBuild && mosaicItems.length > 0
      ? planIntroBuild({
          items: mosaicItems,
          fullDurationSec: clampBuildFullSec(buildFullSec),
          rampUp: normalizeBuildRampUp(buildRampUp),
          buildSound: normalizeBuildSound(buildSound),
          maxFps: clampBuildMaxFps(buildMaxFps),
          hasHandVideo: splitHandVideo,
          getVideoGainDb
        })
      : null;
  const buildShowcaseSteps = buildPlan?.showcaseSteps || [];
  const buildOffsetSec = buildPlan
    ? buildPlan.tilesCompleteSec + DEFAULT_POST_BUILD_SILENCE_SEC
    : 0;

  const { voices: rawPlannedVoices } = planMidiTimeline({
    parsed: parsedClone,
    keyboardMap,
    isVideoDisabled,
    getGroupKey,
    getVideoGainDb,
    stageSlotCount,
    fadeInSec,
    fadeOutSec,
    minDisplaySec,
    transposeOctaves,
    releaseSec: RELEASE_SEC
  });

  // Load all required WebAudio buffers
  const neededAudioUrls = new Set();
  for (const st of buildShowcaseSteps) {
    if (st.cand?.audioUrl) neededAudioUrls.add(st.cand.audioUrl);
  }
  for (const v of rawPlannedVoices) {
    if (v.cand?.audioUrl) neededAudioUrls.add(v.cand.audioUrl);
  }

  report('Decoding sample audio…', 6);
  const audioBufferByUrl = new Map();
  const audioUrlList = Array.from(neededAudioUrls);
  {
    let cur = 0;
    const workers = Array.from({ length: Math.min(8, audioUrlList.length || 1) }, async () => {
      while (cur < audioUrlList.length) {
        checkAbort();
        const url = audioUrlList[cur++];
        const buf = await loadAudioBuffer(url).catch(() => null);
        if (buf) audioBufferByUrl.set(url, buf);
      }
    });
    await Promise.all(workers);
  }

  for (const st of buildShowcaseSteps) {
    const ab = audioBufferByUrl.get(st.cand?.audioUrl);
    const bufDur = ab ? ab.duration : MAX_CLIP_DUR;
    st.bufferPlaySpan = Math.max(
      0.04,
      Math.min(Math.max(0.04, bufDur - st.trimIn), st.naturalDur * st.playbackRate)
    );
    st.noteHex = getNoteHex(st.midi, st.isPerc);
  }

  let maxUnshiftedActivitySec = Number(parsedClone.durationSec || 0.5);
  const voices = [];
  for (const v of rawPlannedVoices) {
    const ab = audioBufferByUrl.get(v.cand?.audioUrl);
    if (!ab) continue;
    v.bufferPlaySpan = Math.max(
      0.04,
      Math.min(ab.duration - v.trimIn, v.naturalDur * v.playbackRate)
    );
    v.noteHex = getNoteHex(v.midi, v.isPerc);
    const vEnd = Math.max(v.endSec, Number.isFinite(v.visualEndSec) ? v.visualEndSec : v.endSec);
    if (vEnd > maxUnshiftedActivitySec) maxUnshiftedActivitySec = vEnd;

    if (buildOffsetSec > 0) {
      v.startSec += buildOffsetSec;
      v.endSec += buildOffsetSec;
      if (v.earlyRelSec !== null) v.earlyRelSec += buildOffsetSec;
      if (v.stolenAtSec !== null) v.stolenAtSec += buildOffsetSec;
      if (v.maxDisplayCutoff !== null) v.maxDisplayCutoff += buildOffsetSec;
      if (v.fadeStartSec !== null) v.fadeStartSec += buildOffsetSec;
      if (Number.isFinite(v.visualEndSec)) v.visualEndSec += buildOffsetSec;
      if (Number.isFinite(v.tileReleaseSec)) v.tileReleaseSec += buildOffsetSec;
    }
    voices.push(v);
  }

  const END_FADE_SEC = 0.45;
  const END_BLACK_HOLD_SEC = 0.20;
  const endFadeStartSec = buildOffsetSec + Math.max(0.2, maxUnshiftedActivitySec - 0.10);
  const endFadeCompleteSec = endFadeStartSec + END_FADE_SEC;
  const renderDurationSec = endFadeCompleteSec + END_BLACK_HOLD_SEC;

  // Render 48kHz master audio via OfflineAudioContext
  report('Mixing 48kHz master audio…', 11);
  checkAbort();
  const masterAudioBuffer = await renderOfflineMasterAudio({
    renderDurationSec,
    voices,
    buildPlan,
    audioBufferByUrl,
    endFadeStartSec,
    endFadeCompleteSec
  });

  // Select supported H.264 VideoEncoder + AAC/Opus AudioEncoder configurations
  const candidateVideoCodecs = [
    'avc1.64002a',
    'avc1.640032',
    'avc1.640033',
    'avc1.640028',
    'avc1.4d002a',
    'avc1.4d0032',
    'avc1.42002a',
    'avc1.420032',
    'avc1.42e02a'
  ];
  let chosenVideoConfig = null;
  for (const codec of candidateVideoCodecs) {
    const cfg = {
      codec,
      width: W,
      height: H,
      bitrate: 8_000_000,
      framerate: fps,
      avc: { format: 'avc' }
    };
    const sup = await VideoEncoder.isConfigSupported(cfg).catch(() => ({ supported: false }));
    if (sup.supported) {
      chosenVideoConfig = cfg;
      break;
    }
  }
  if (!chosenVideoConfig) {
    throw new Error(`H.264 VideoEncoder is not supported at ${W}x${H} on this browser.`);
  }

  let chosenAudioCodec = null;
  let chosenAudioConfig = null;
  if (typeof window.AudioEncoder === 'function' && typeof window.AudioData === 'function') {
    const aacCfg = {
      codec: 'mp4a.40.2',
      sampleRate: AUDIO_SR,
      numberOfChannels: 2,
      bitrate: 192_000,
      aac: { format: 'aac' }
    };
    const aacSup = await AudioEncoder.isConfigSupported(aacCfg).catch(() => ({ supported: false }));
    if (aacSup.supported) {
      chosenAudioCodec = 'mp4a';
      chosenAudioConfig = aacCfg;
    } else {
      const opusCfg = {
        codec: 'opus',
        sampleRate: AUDIO_SR,
        numberOfChannels: 2,
        bitrate: 160_000
      };
      const opusSup = await AudioEncoder.isConfigSupported(opusCfg).catch(() => ({ supported: false }));
      if (opusSup.supported) {
        chosenAudioCodec = 'opus';
        chosenAudioConfig = opusCfg;
      }
    }
  }

  const muxer = createMp4Muxer({
    width: W,
    height: H,
    fps,
    sampleRate: AUDIO_SR,
    channels: 2,
    audioCodec: chosenAudioCodec
  });

  // Encode all 48kHz audio upfront (~50ms!)
  if (chosenAudioConfig) {
    report('Encoding AAC audio track…', 14);
    let audioEncErr = null;
    const audioEncoder = new AudioEncoder({
      output(chunk, meta) {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        muxer.addAudioChunk(buf, chunk.timestamp, chunk.duration, meta?.decoderConfig || null);
      },
      error(e) {
        audioEncErr = e;
      }
    });
    audioEncoder.configure(chosenAudioConfig);

    const ch0 = masterAudioBuffer.getChannelData(0);
    const ch1 = masterAudioBuffer.getChannelData(1);
    const CHUNK_FRAMES = 1024;
    for (let offset = 0; offset < ch0.length; offset += CHUNK_FRAMES) {
      checkAbort();
      const framesHere = Math.min(CHUNK_FRAMES, ch0.length - offset);
      const planar = new Float32Array(framesHere * 2);
      planar.set(ch0.subarray(offset, offset + framesHere), 0);
      planar.set(ch1.subarray(offset, offset + framesHere), framesHere);
      const ad = new AudioData({
        format: 'f32-planar',
        sampleRate: AUDIO_SR,
        numberOfFrames: framesHere,
        numberOfChannels: 2,
        timestamp: Math.round((offset * 1_000_000) / AUDIO_SR),
        data: planar
      });
      audioEncoder.encode(ad);
      ad.close();
    }
    await audioEncoder.flush();
    audioEncoder.close();
    if (audioEncErr) throw audioEncErr;
  }

  // Prepare Stage Geometry + Mosaic + Spectrograms
  report('Preparing stage mosaic & spectrograms…', 18);
  checkAbort();

  const geom = computeStageGeometry(
    W,
    H,
    gridSpec,
    mosaicItems.length,
    tileScale,
    specScale,
    splitHandVideo,
    videoWidthPct,
    videoPosition,
    videoHeightPct
  );
  const { uiScale, cols: stageCols, tileSize, specH, colGap, rowGap, stripLeft, stackTopY } = geom;

  const { bgCanvas, bgCtx, patches: mosaicPatches } = buildMosaicCanvasAndPatches(
    W,
    H,
    mosaicItems,
    geom.mosaic,
    atlasImage,
    !buildPlan
  );
  const patchIndexBySliceId = new Map(mosaicPatches.map((p, i) => [p.sliceId, i]));

  const isPortraitFrame = H > W * 1.15;
  const buildTextBoost = isPortraitFrame ? 1.90 : 1.65;
  const buildFontPx = Math.max(16, Math.round(18.5 * uiScale * buildTextBoost));
  const buildSpecRatio = 0.475;
  const clusterOriginY = geom.mosaic.originY;
  const buildInstGapY = Math.max(Math.round(12 * uiScale), Math.round(14 * uiScale));
  const instLabelReserveH = buildInstGapY + Math.round(buildFontPx * 1.25);
  const targetBuildSideByScreen = Math.min(W * 0.50, Math.min(W, H) * 0.395);
  const minBuildVertBreathing = Math.max(Math.round(52 * uiScale), Math.round(clusterOriginY * 0.16));
  const maxBuildUnitByAbove = Math.max(
    Math.round(110 * uiScale),
    clusterOriginY - minBuildVertBreathing - instLabelReserveH
  );
  const maxBuildSideByAbove = maxBuildUnitByAbove / (1 + buildSpecRatio);
  const showcaseDotRadius = Math.max(5.5, 7.8 * uiScale);
  const buildLabelLeftPad = Math.round(16 * uiScale);
  const buildDotToNoteGap = Math.round(12 * uiScale);
  const buildNoteSlotW = Math.round(buildFontPx * 1.75);
  const rightBuildLabelReserveW =
    buildLabelLeftPad +
    Math.ceil(showcaseDotRadius * 2) +
    buildDotToNoteGap +
    buildNoteSlotW +
    Math.round(buildFontPx * 5.6) +
    Math.round(20 * uiScale);
  const maxBuildSideByWidth = Math.max(Math.round(110 * uiScale), W - rightBuildLabelReserveW * 2);
  const rawBuildSide = Math.max(
    Math.round(96 * uiScale),
    Math.min(targetBuildSideByScreen, maxBuildSideByAbove, maxBuildSideByWidth)
  );
  const buildTileSize = Math.max(48, Math.floor(rawBuildSide / 2) * 2);
  const buildSpecH = Math.max(Math.round(18 * uiScale), Math.round(buildTileSize * buildSpecRatio));

  const specCache = new Map();
  for (const st of buildShowcaseSteps) {
    const key = `b__${st.cand.audioUrl}__${st.playbackRate.toFixed(4)}__${st.trimIn.toFixed(2)}__${st.bufferPlaySpan.toFixed(2)}`;
    if (!specCache.has(key)) {
      const ab = audioBufferByUrl.get(st.cand.audioUrl);
      if (ab) {
        specCache.set(
          key,
          buildMiniSpectrogramCanvas(ab, buildTileSize, buildSpecH, st.playbackRate, st.trimIn, st.bufferPlaySpan)
        );
      }
    }
    st.specKey = key;
  }
  for (const v of voices) {
    const key = `v__${v.cand.audioUrl}__${v.playbackRate.toFixed(4)}__${v.trimIn.toFixed(2)}__${v.bufferPlaySpan.toFixed(2)}`;
    if (!specCache.has(key)) {
      const ab = audioBufferByUrl.get(v.cand.audioUrl);
      if (ab) {
        specCache.set(
          key,
          buildMiniSpectrogramCanvas(ab, tileSize, specH, v.playbackRate, v.trimIn, v.bufferPlaySpan)
        );
      }
    }
    v.specKey = key;
  }
  audioBufferByUrl.clear();

  // Track video clip lifetimes & pre-fetch raw MP4 bytes
  const rawMp4BytesCache = new Map();
  async function fetchMp4BytesCached(url) {
    const resolved = resolveMediaUrl(url);
    if (rawMp4BytesCache.has(resolved)) return rawMp4BytesCache.get(resolved);
    const res = await fetch(resolved);
    if (!res.ok) throw new Error(`Failed fetching ${resolved}`);
    const u8 = new Uint8Array(await res.arrayBuffer());
    rawMp4BytesCache.set(resolved, u8);
    return u8;
  }

  async function decodeSliceFrames(url, side, startSec, maxDurSec) {
    try {
      const bytes = await fetchMp4BytesCached(url);
      return await decodeClipFramesViaWebCodecs(bytes, side, fps, startSec, maxDurSec);
    } catch {
      return await decodeClipFramesViaVideoElement(resolveMediaUrl(url), side, fps, startSec, maxDurSec);
    }
  }

  // Decode short intro build showcase snippets
  const buildStepFrames = new Array(buildShowcaseSteps.length).fill(null);
  if (buildShowcaseSteps.length > 0) {
    report(`Decoding intro build clips (0/${buildShowcaseSteps.length})…`, 21);
    let bCur = 0;
    const bWorkers = Array.from({ length: Math.min(6, buildShowcaseSteps.length) }, async () => {
      while (bCur < buildShowcaseSteps.length) {
        checkAbort();
        const idx = bCur++;
        const st = buildShowcaseSteps[idx];
        if (!st.cand?.videoUrl) continue;
        const span = Math.max(0.05, st.durSec * st.playbackRate + 0.06);
        buildStepFrames[idx] = await decodeSliceFrames(st.cand.videoUrl, buildTileSize, st.trimIn, span);
      }
    });
    await Promise.all(bWorkers);
  }

  const videoMetaByUrl = new Map();
  for (const v of voices) {
    const url = v.cand.videoUrl;
    const maxClipTime = v.trimIn + v.bufferPlaySpan + 0.05;
    const prev = videoMetaByUrl.get(url);
    if (!prev) {
      videoMetaByUrl.set(url, {
        videoUrl: url,
        maxDurSec: maxClipTime,
        firstStartSec: v.startSec,
        lastVisualEndSec: v.visualEndSec
      });
    } else {
      if (maxClipTime > prev.maxDurSec) prev.maxDurSec = maxClipTime;
      if (v.startSec < prev.firstStartSec) prev.firstStartSec = v.startSec;
      if (v.visualEndSec > prev.lastVisualEndSec) prev.lastVisualEndSec = v.visualEndSec;
    }
  }

  const orderedMetas = Array.from(videoMetaByUrl.values()).sort((a, b) => a.firstStartSec - b.firstStartSec);
  const clipFramesCache = new Map();
  const MAX_CACHED_SONG_CLIPS = 48;

  const initialWarm = orderedMetas.slice(0, MAX_CACHED_SONG_CLIPS);
  if (initialWarm.length > 0) {
    report(`Decoding film clips (0/${orderedMetas.length})…`, 24);
    let wCur = 0;
    const wWorkers = Array.from({ length: Math.min(6, initialWarm.length) }, async () => {
      while (wCur < initialWarm.length) {
        checkAbort();
        const meta = initialWarm[wCur++];
        const frames = await decodeSliceFrames(meta.videoUrl, tileSize, 0, meta.maxDurSec);
        clipFramesCache.set(meta.videoUrl, frames);
      }
    });
    await Promise.all(wWorkers);
  }

  async function getSongClipFramesAt(url, t) {
    for (const [cachedUrl, frames] of clipFramesCache.entries()) {
      const m = videoMetaByUrl.get(cachedUrl);
      if (m && t > m.lastVisualEndSec + 0.08) {
        closeFrameBitmaps(frames);
        clipFramesCache.delete(cachedUrl);
        rawMp4BytesCache.delete(cachedUrl);
      }
    }
    if (clipFramesCache.has(url)) {
      const val = clipFramesCache.get(url);
      clipFramesCache.delete(url);
      clipFramesCache.set(url, val);
      return val;
    }
    if (clipFramesCache.size >= MAX_CACHED_SONG_CLIPS) {
      const [oldestUrl, oldestFrames] = clipFramesCache.entries().next().value;
      closeFrameBitmaps(oldestFrames);
      clipFramesCache.delete(oldestUrl);
    }
    const meta = videoMetaByUrl.get(url);
    const frames = await decodeSliceFrames(url, tileSize, 0, meta?.maxDurSec ?? MAX_CLIP_DUR);
    clipFramesCache.set(url, frames);
    return frames;
  }

  let handReader = null;
  if (splitHandVideo && geom.handRect && handVideoUrl) {
    report('Initializing synced B&W camera stream…', 27);
    handReader = await createStreamingHandVideoReader({
      videoUrl: resolveMediaUrl(handVideoUrl),
      dstW: geom.handRect.w,
      dstH: geom.handRect.h,
      zoom: videoZoom,
      cropX: videoCropX,
      cropY: videoCropY,
      brightness: videoBrightness,
      leadOffsetSec: handVideoLeadOffsetSec
    }).catch(() => null);
  }

  // Configure Hardware H.264 VideoEncoder
  let videoEncErr = null;
  const videoEncoder = new VideoEncoder({
    output(chunk, meta) {
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      muxer.addVideoChunk(
        buf,
        chunk.timestamp,
        chunk.duration || Math.round(1_000_000 / fps),
        chunk.type === 'key',
        meta?.decoderConfig || null
      );
    },
    error(e) {
      videoEncErr = e;
    }
  });
  videoEncoder.configure(chosenVideoConfig);

  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = W;
  frameCanvas.height = H;
  const ctx = frameCanvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const voicesBySlot = Array.from({ length: stageSlotCount }, () => []);
  for (const v of voices) voicesBySlot[v.slotIdx].push(v);

  const tileActiveValues = new Float32Array(mosaicPatches.length);
  const tileDecaySecs = new Float32Array(mosaicPatches.length);
  const TILE_COLOR_DECAY_SEC = 0.12;
  const BUILD_TILE_COLOR_DECAY_SEC = 0.65;
  tileDecaySecs.fill(TILE_COLOR_DECAY_SEC);

  const dtFrame = 1 / fps;
  const keylinePx = Math.max(1.0, getStageSpecKeylineWidth(specScale) * uiScale);
  const buildKeylinePx = Math.max(1.2, 1.5 * uiScale);
  const unitHeight = tileSize + specH;

  const showcaseLeft = Math.round((W - buildTileSize) * 0.5);
  const totalBuildVisualH = buildTileSize + buildSpecH + instLabelReserveH;
  const minShowcaseTop = Math.max(Math.round(14 * uiScale), Math.round(Math.min(W, H) * 0.025));
  const maxShowcaseTop = Math.max(
    minShowcaseTop,
    Math.floor(clusterOriginY - totalBuildVisualH - Math.round(16 * uiScale))
  );
  const fgZoneTop = Math.min(stackTopY, maxShowcaseTop);
  const fgZoneBottom = Math.max(fgZoneTop + totalBuildVisualH, clusterOriginY - (geom.betweenGap || 0));
  const showcaseTop = Math.max(
    minShowcaseTop,
    Math.min(maxShowcaseTop, Math.round(fgZoneTop + (fgZoneBottom - fgZoneTop - totalBuildVisualH) * 0.5))
  );
  const showcaseSpecTop = showcaseTop + buildTileSize;
  const showcaseFreqLabelX = showcaseLeft + buildTileSize + buildLabelLeftPad;
  const showcaseNoteNameX = showcaseFreqLabelX + Math.ceil(showcaseDotRadius * 2) + buildDotToNoteGap;
  const showcaseHzTextX = showcaseNoteNameX + buildNoteSlotW;
  const showcaseInstLabelTopY = showcaseSpecTop + buildSpecH + buildInstGapY;

  const totalFrames = Math.max(1, Math.ceil(renderDurationSec * fps));
  const frameDurationUs = Math.round(1_000_000 / fps);
  let stampedBuildCount = buildPlan ? 0 : mosaicPatches.length;
  let activeShowcaseIdx = 0;

  try {
    for (let f = 0; f < totalFrames; f++) {
      checkAbort();
      if (videoEncErr) throw videoEncErr;

      const t = f / fps;
      const currentlyActivePatchIndices = new Set();

      // Advance intro build pop-ins onto bgCanvas
      while (
        buildPlan &&
        stampedBuildCount < buildPlan.steps.length &&
        buildPlan.steps[stampedBuildCount].endSec <= t + 1e-6
      ) {
        if (stampedBuildCount < mosaicPatches.length) {
          const p = mosaicPatches[stampedBuildCount];
          bgCtx.globalCompositeOperation = 'lighter';
          bgCtx.drawImage(p.idleCanvas, p.px0, p.py0);
          bgCtx.globalCompositeOperation = 'source-over';
          currentlyActivePatchIndices.add(stampedBuildCount);
          tileDecaySecs[stampedBuildCount] = BUILD_TILE_COLOR_DECAY_SEC;
        }
        stampedBuildCount++;
      }

      if (buildPlan && buildShowcaseSteps.length > 0) {
        while (
          activeShowcaseIdx + 1 < buildShowcaseSteps.length &&
          buildShowcaseSteps[activeShowcaseIdx].endSec <= t + 1e-6
        ) {
          closeFrameBitmaps(buildStepFrames[activeShowcaseIdx]);
          buildStepFrames[activeShowcaseIdx] = null;
          activeShowcaseIdx++;
        }
        if (t >= buildPlan.tilesCompleteSec - 1e-6) {
          for (let s = activeShowcaseIdx; s < buildStepFrames.length; s++) {
            closeFrameBitmaps(buildStepFrames[s]);
            buildStepFrames[s] = null;
          }
        }
      }

      // Base frame from bgCanvas
      ctx.globalAlpha = 1.0;
      ctx.drawImage(bgCanvas, 0, 0);

      // 0. Synced B&W Hand Video
      if (handReader && geom.handRect) {
        const { x: hx, y: hy, w: hw, h: hh } = geom.handRect;
        let camAlpha = 1.0;
        if (buildPlan) {
          const fadeStart = buildPlan.handFadeStartSec ?? Math.max(0, buildPlan.tilesCompleteSec - 0.20);
          const fadeEnd = buildPlan.handFadeEndSec ?? buildPlan.tilesCompleteSec;
          if (t <= fadeStart) camAlpha = 0.0;
          else if (t < fadeEnd) {
            const u = Math.max(0, Math.min(1, (t - fadeStart) / Math.max(0.015, fadeEnd - fadeStart)));
            camAlpha = u * u * (3 - 2 * u);
          }
        }
        ctx.fillStyle = '#080808';
        ctx.fillRect(hx, hy, hw, hh);
        if (camAlpha > 0.002) {
          const songSec = buildPlan ? Math.max(0, t - buildOffsetSec) : t;
          const handBmp = await handReader.getFrameAtSec(buildPlan && t < buildOffsetSec ? 0 : songSec);
          if (handBmp) {
            ctx.globalAlpha = camAlpha;
            ctx.drawImage(handBmp, hx, hy, hw, hh);
            ctx.globalAlpha = 1.0;
          }
        }
      }

      // 0b. Intro Build Center Showcase
      if (buildPlan && buildShowcaseSteps.length > 0 && t < buildPlan.tilesCompleteSec - 1e-6) {
        const stepIdx = Math.min(buildShowcaseSteps.length - 1, activeShowcaseIdx);
        const st = buildShowcaseSteps[stepIdx];
        const bFrames = buildStepFrames[stepIdx];
        if (bFrames && bFrames.length > 0) {
          const vIdx = Math.max(
            0,
            Math.min(bFrames.length - 1, Math.floor(Math.max(0, t - st.startSec) * st.playbackRate * fps))
          );
          ctx.drawImage(bFrames[vIdx], showcaseLeft, showcaseTop, buildTileSize, buildTileSize);
        }

        const specCanvas = specCache.get(st.specKey);
        if (specCanvas) {
          ctx.drawImage(specCanvas, showcaseLeft, showcaseSpecTop, buildTileSize, buildSpecH);
        }

        ctx.font = `400 ${buildFontPx}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
        ctx.textBaseline = 'middle';

        if (!st.isPerc && st.f0Hz >= 25 && st.f0Hz <= 4500) {
          const normY = miniSpecFreqToNormY(st.f0Hz);
          const yF0Local = Math.max(
            1.5 * uiScale,
            Math.min(buildSpecH - 1.5 * uiScale, (1 - normY) * (buildSpecH - 1))
          );
          const yCenter = showcaseSpecTop + yF0Local;

          ctx.globalAlpha = 0.85;
          ctx.fillStyle = st.noteHex;
          ctx.fillRect(showcaseLeft, yCenter - buildKeylinePx * 0.5, buildTileSize, buildKeylinePx);

          ctx.globalAlpha = 0.96;
          ctx.beginPath();
          ctx.arc(showcaseFreqLabelX + showcaseDotRadius, yCenter, showcaseDotRadius, 0, Math.PI * 2);
          ctx.fill();

          ctx.globalAlpha = 0.92;
          ctx.fillStyle = '#ffffff';
          if (st.noteName) ctx.fillText(st.noteName, showcaseNoteNameX, yCenter);
          if (st.freqText) ctx.fillText(st.freqText, showcaseHzTextX, yCenter);
          ctx.globalAlpha = 1.0;
        }

        if (st.instrumentLabel) {
          ctx.globalAlpha = 0.92;
          ctx.fillStyle = '#ffffff';
          ctx.textBaseline = 'top';
          ctx.fillText(st.instrumentLabel, showcaseLeft, showcaseInstLabelTopY);
          ctx.globalAlpha = 1.0;
        }
      }

      // Mark active song mosaic tiles
      for (let i = 0; i < voices.length; i++) {
        const v = voices[i];
        if (v.startSec > t) break;
        if (t < v.tileReleaseSec) {
          const pIdx = patchIndexBySliceId.get(v.sliceKey);
          if (pIdx !== undefined) {
            currentlyActivePatchIndices.add(pIdx);
            tileDecaySecs[pIdx] = TILE_COLOR_DECAY_SEC;
          }
        }
      }

      // 1. Foreground Stage Video Grid + Flush Spectrograms + Chromatic f0 Bars
      for (let slotIdx = 0; slotIdx < stageSlotCount; slotIdx++) {
        const list = voicesBySlot[slotIdx];
        let activeVoice = null;
        for (let k = list.length - 1; k >= 0; k--) {
          const candV = list[k];
          if (candV.startSec <= t && t < candV.visualEndSec) {
            activeVoice = candV;
            break;
          }
        }
        if (!activeVoice) continue;

        const unitAlpha = evalSlotVisualAlpha(activeVoice, t, fadeInSec, fadeOutSec);
        if (unitAlpha <= 0.004) continue;

        const slotCol = slotIdx % stageCols;
        const slotRow = (slotIdx / stageCols) | 0;
        const slotLeft = stripLeft + slotCol * (tileSize + colGap);
        const videoTop = stackTopY + slotRow * (unitHeight + rowGap);
        const specTop = videoTop + tileSize;

        const clipFrames = await getSongClipFramesAt(activeVoice.cand.videoUrl, t);
        const maxClipTime = Math.max(
          activeVoice.trimIn,
          activeVoice.trimIn + activeVoice.bufferPlaySpan - 0.015
        );
        const clipTime = Math.min(
          maxClipTime,
          activeVoice.trimIn + (t - activeVoice.startSec) * activeVoice.playbackRate
        );
        const fIdx = Math.max(0, Math.min(clipFrames.length - 1, Math.floor(clipTime * fps)));

        ctx.globalAlpha = unitAlpha;
        ctx.drawImage(clipFrames[fIdx], slotLeft, videoTop, tileSize, tileSize);

        const specCanvas = specCache.get(activeVoice.specKey);
        if (specCanvas) {
          ctx.drawImage(specCanvas, slotLeft, specTop, tileSize, specH);
        }

        if (!activeVoice.isPerc && activeVoice.f0Hz >= 25 && activeVoice.f0Hz <= 4500) {
          const normY = miniSpecFreqToNormY(activeVoice.f0Hz);
          const yF0Local = Math.max(1.5 * uiScale, Math.min(specH - 1.5 * uiScale, (1 - normY) * (specH - 1)));
          ctx.globalAlpha = 0.85 * unitAlpha;
          ctx.fillStyle = activeVoice.noteHex;
          ctx.fillRect(slotLeft, specTop + yF0Local - keylinePx * 0.5, tileSize, keylinePx);
        }
        ctx.globalAlpha = 1.0;
      }

      // 2. Active/Fading Chromatic Mosaic Tiles
      for (let i = 0; i < mosaicPatches.length; i++) {
        const target = currentlyActivePatchIndices.has(i) ? 1.0 : 0.0;
        const cur = tileActiveValues[i];
        let next = 0.0;
        if (target >= 1.0) next = 1.0;
        else if (cur > 0.004) {
          next = Math.max(0.0, cur - dtFrame / Math.max(0.05, tileDecaySecs[i] || TILE_COLOR_DECAY_SEC));
        } else {
          tileDecaySecs[i] = TILE_COLOR_DECAY_SEC;
        }
        tileActiveValues[i] = next;
        if (next > 0.004) {
          const patch = mosaicPatches[i];
          const mixT = smoothstep(0.0, 1.0, next);
          ctx.globalAlpha = 1.0;
          ctx.drawImage(patch.idleCanvas, patch.px0, patch.py0);
          ctx.globalAlpha = mixT;
          ctx.drawImage(patch.activeCanvas, patch.px0, patch.py0);
          ctx.globalAlpha = 1.0;
        }
      }

      // 3. Fast Master End Fade to 100% Black
      if (t >= endFadeStartSec) {
        if (t >= endFadeCompleteSec) {
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, W, H);
        } else {
          const u = Math.max(0, Math.min(1, (endFadeCompleteSec - t) / END_FADE_SEC));
          const blackAlpha = 1 - u * u * (3 - 2 * u);
          ctx.globalAlpha = blackAlpha;
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, W, H);
          ctx.globalAlpha = 1.0;
        }
      }

      // Encode H.264 Frame with Queue Backpressure Control
      const vf = new VideoFrame(frameCanvas, {
        timestamp: Math.round((f * 1_000_000) / fps),
        duration: frameDurationUs
      });
      videoEncoder.encode(vf, { keyFrame: f % 60 === 0 });
      vf.close();

      while (videoEncoder.encodeQueueSize > 10) {
        await new Promise(r => setTimeout(r, 2));
      }

      if (f % 6 === 0 || f === totalFrames - 1) {
        const pct = 28 + ((f + 1) / totalFrames) * 70;
        report(`Encoding ${aspectSpec.label} MP4 (${f + 1}/${totalFrames})…`, pct);
        await new Promise(r => setTimeout(r, 0));
      }
    }

    report('Finalizing MP4…', 99);
    await videoEncoder.flush();
    videoEncoder.close();
    if (videoEncErr) throw videoEncErr;

    const mp4Bytes = muxer.finalize();
    const cleanStem =
      String(sessionName || 'everytone')
        .replace(/\.(mid|midi)$/i, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'everytone';
    const fileName = `${cleanStem}_${aspectSpec.slug}.mp4`;

    report('Complete', 100);
    return {
      blob: new Blob([mp4Bytes], { type: 'video/mp4' }),
      fileName,
      aspectRatio: aspectSpec.key,
      width: W,
      height: H,
      durationSec: Number(renderDurationSec.toFixed(2))
    };
  } finally {
    try {
      if (videoEncoder.state !== 'closed') videoEncoder.close();
    } catch {}
    if (handReader) handReader.close();
    for (const frames of clipFramesCache.values()) closeFrameBitmaps(frames);
    for (const frames of buildStepFrames) closeFrameBitmaps(frames);
    clipFramesCache.clear();
    rawMp4BytesCache.clear();
  }
}
