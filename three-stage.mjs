import * as THREE from './vendor/three.module.min.js';
import { sortCatalogVideosInSidebarOrder } from './midi-timeline.mjs';

// ============================================================================
// Three.js 3D Stage Canvas
// - Powered by THREE.Scene + THREE.PerspectiveCamera + THREE.InstancedBufferGeometry
// - Compact 1px-gap B&W micro-thumbnail mosaic flush beneath the foreground film grid
// - Zero colored dots in idle; active/selected squares fill with chromatic hex at 85% max opacity and fade out
// - Percussion tiles use #8a8a8a gray fill on trigger & #e2e2e2 light gray when selected
// ============================================================================

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
const PERC_SELECT_HEX = '#e2e2e2';

function hexToNormRgb(hex) {
  const clean = String(hex || PERC_TRIGGER_HEX).replace('#', '');
  const n = parseInt(clean, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function getMidiColorHex(midi, isPerc = false) {
  if (isPerc) return PERC_TRIGGER_HEX;
  const m = Number.isFinite(midi) ? Math.round(midi) : 60;
  return CHROMATIC_HEX[((m % 12) + 12) % 12];
}

const TILE_VERT_SHADER = `
attribute vec3 iOffsetScale; // x: worldX, y: worldY, z: cellSize
attribute vec4 iUvRect;      // u0, v0, u1, v1
attribute vec2 iState;       // x: activeAmount, y: hoverAmount
attribute vec3 iNoteColor;   // r, g, b normalized chromatic / percussion hex color

varying vec2 vUv;
varying float vActive;
varying float vHover;
varying vec3 vNoteColor;

void main() {
  vec3 worldPos = vec3(
    position.x * iOffsetScale.z + iOffsetScale.x,
    position.y * iOffsetScale.z + iOffsetScale.y,
    position.z
  );
  // PlaneGeometry uv.y=1 is top (+0.5Y -> v0), uv.y=0 is bottom (-0.5Y -> v1)
  vUv = vec2(
    mix(iUvRect.x, iUvRect.z, uv.x),
    mix(iUvRect.w, iUvRect.y, uv.y)
  );
  vActive = iState.x;
  vHover = iState.y;
  vNoteColor = iNoteColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
}
`;

const TILE_FRAG_SHADER = `
precision highp float;

uniform sampler2D uAtlas;
uniform vec3 uBgColor;

varying vec2 vUv;
varying float vActive;
varying float vHover;
varying vec3 vNoteColor;

void main() {
  vec3 texRgb = texture2D(uAtlas, vUv).rgb;
  float luma = dot(texRgb, vec3(0.299, 0.587, 0.114));
  float crispLuma = clamp(pow(max(luma, 0.0), 0.88) * 1.08, 0.0, 1.0);
  vec3 bwRgb = vec3(crispLuma);

  // Idle state: crisp monochrome B&W with higher visibility, zero colored dots
  float hoverAmt = clamp(vHover, 0.0, 1.0);
  float idleAlpha = mix(0.42, 0.74, hoverAmt);
  vec3 idleColor = mix(uBgColor, bwRgb, idleAlpha);

  // Active / selected state: chromatic hex color at 85% max opacity over the square, fading out smoothly
  float t = smoothstep(0.0, 1.0, clamp(vActive, 0.0, 1.0));
  vec3 finalRgb = mix(idleColor, vNoteColor, t * 0.85);

  gl_FragColor = vec4(finalRgb, 1.0);
}
`;

export function createThreeStage({
  canvas,
  getActiveSliceIds,
  isVideoDisabled,
  onSliceEnter,
  onSliceLeave,
  formatTooltip
}) {
  if (!canvas) return null;

  const FOV_DEG = 36;
  const MAX_INSTANCES = 1024;

  let renderer = null;
  let ctx2d = null;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance'
    });
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.setClearColor(0x000000, 1);
  } catch (err) {
    console.warn('Three.js WebGLRenderer fallback to 2D:', err);
    renderer = null;
    ctx2d = canvas.getContext('2d');
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 1, 8000);

  const basePlane = new THREE.PlaneGeometry(1, 1);
  const instGeo = new THREE.InstancedBufferGeometry();
  instGeo.index = basePlane.index;
  instGeo.attributes.position = basePlane.attributes.position;
  instGeo.attributes.uv = basePlane.attributes.uv;

  const offsetScaleArray = new Float32Array(MAX_INSTANCES * 3);
  const uvRectArray = new Float32Array(MAX_INSTANCES * 4);
  const stateArray = new Float32Array(MAX_INSTANCES * 2);
  const noteColorArray = new Float32Array(MAX_INSTANCES * 3);

  const attrOffsetScale = new THREE.InstancedBufferAttribute(offsetScaleArray, 3);
  const attrUvRect = new THREE.InstancedBufferAttribute(uvRectArray, 4);
  const attrState = new THREE.InstancedBufferAttribute(stateArray, 2);
  const attrNoteColor = new THREE.InstancedBufferAttribute(noteColorArray, 3);
  attrOffsetScale.setUsage(THREE.DynamicDrawUsage);
  attrUvRect.setUsage(THREE.DynamicDrawUsage);
  attrState.setUsage(THREE.DynamicDrawUsage);
  attrNoteColor.setUsage(THREE.DynamicDrawUsage);

  instGeo.setAttribute('iOffsetScale', attrOffsetScale);
  instGeo.setAttribute('iUvRect', attrUvRect);
  instGeo.setAttribute('iState', attrState);
  instGeo.setAttribute('iNoteColor', attrNoteColor);
  instGeo.instanceCount = 0;

  const material = new THREE.ShaderMaterial({
    vertexShader: TILE_VERT_SHADER,
    fragmentShader: TILE_FRAG_SHADER,
    uniforms: {
      uAtlas: { value: null },
      uBgColor: { value: new THREE.Vector3(0, 0, 0) }
    },
    depthTest: false,
    depthWrite: false
  });

  const tileMesh = new THREE.Mesh(instGeo, material);
  tileMesh.frustumCulled = false;
  tileMesh.renderOrder = 0;
  scene.add(tileMesh);

  let atlasManifest = null;
  let atlasBySliceId = new Map();
  let atlasImage = null;
  let textureReady = false;

  let items = [];
  let activeValues = new Float32Array(MAX_INSTANCES);
  let poppedFlashUntilMs = new Float64Array(MAX_INSTANCES);
  let tileDecaySecs = new Float32Array(MAX_INSTANCES);
  tileDecaySecs.fill(0.12);
  let visibleCountLimit = null;
  let selectedSliceId = null;
  let fadeOutSec = 0.20;

  let cssW = 1;
  let cssH = 1;
  let dpr = 1;
  let layoutSpec = {
    stripW: 0,
    topStripH: 0,
    betweenGap: 16,
    marginY: 20,
    tileScale: 1.0,
    desiredCell: 0,
    splitHandVideo: false,
    splitGap: 1,
    videoPosition: 'right',
    handWidthPct: 50,
    handHeightPct: 23
  };
  let layout = {
    cols: 1,
    rows: 0,
    cell: 12,
    gap: 1,
    gridW: 0,
    gridH: 0,
    originX: 0,
    originY: 0,
    stackTopY: 24,
    handRect: null
  };

  let hoveredIdx = -1;
  let isPointerDragging = false;
  let activeDragSliceId = null;
  let activeDragStartedMs = 0;
  let draggedAcrossMultiple = false;
  let rafId = null;
  let lastFrameMs = 0;

  function syncNoteColors() {
    const N = Math.min(items.length, MAX_INSTANCES);
    for (let i = 0; i < N; i++) {
      const it = items[i];
      const hex = it.sliceId === selectedSliceId ? it.selectColorHex : it.triggerColorHex;
      const [nr, ng, nb] = hexToNormRgb(hex);
      const o3 = i * 3;
      noteColorArray[o3] = nr;
      noteColorArray[o3 + 1] = ng;
      noteColorArray[o3 + 2] = nb;
    }
    attrNoteColor.needsUpdate = true;
  }

  function getRenderedCount() {
    const N = Math.min(items.length, MAX_INSTANCES);
    if (visibleCountLimit === null || visibleCountLimit === undefined) return N;
    return Math.max(0, Math.min(N, Math.floor(visibleCountLimit)));
  }

  function syncInstanceTransformsAndUvs() {
    const N = Math.min(items.length, MAX_INSTANCES);
    instGeo.instanceCount = getRenderedCount();
    if (N === 0) return;

    const { cols, cell, gap, originX, originY } = layout;
    const stride = cell + gap;

    for (let i = 0; i < N; i++) {
      const it = items[i];
      const col = i % cols;
      const row = (i / cols) | 0;
      const sx = originX + col * stride;
      const sy = originY + row * stride;

      const wx = sx + cell * 0.5 - cssW * 0.5;
      const wy = cssH * 0.5 - (sy + cell * 0.5);

      const o3 = i * 3;
      offsetScaleArray[o3] = wx;
      offsetScaleArray[o3 + 1] = wy;
      offsetScaleArray[o3 + 2] = cell;

      const hex = it.sliceId === selectedSliceId ? it.selectColorHex : it.triggerColorHex;
      const [nr, ng, nb] = hexToNormRgb(hex);
      noteColorArray[o3] = nr;
      noteColorArray[o3 + 1] = ng;
      noteColorArray[o3 + 2] = nb;

      const o4 = i * 4;
      uvRectArray[o4] = it.u0;
      uvRectArray[o4 + 1] = it.v0;
      uvRectArray[o4 + 2] = it.u1;
      uvRectArray[o4 + 3] = it.v1;
    }

    attrOffsetScale.needsUpdate = true;
    attrUvRect.needsUpdate = true;
    attrNoteColor.needsUpdate = true;
  }

  function computeLayout() {
    const rect = canvas.getBoundingClientRect();
    cssW = Math.max(1, Math.round(rect.width || canvas.clientWidth || 1));
    cssH = Math.max(1, Math.round(rect.height || canvas.clientHeight || 1));
    dpr = Math.min(2, window.devicePixelRatio || 1);

    if (renderer) {
      renderer.setPixelRatio(dpr);
      renderer.setSize(cssW, cssH, false);
    } else {
      const tw = Math.max(1, Math.round(cssW * dpr));
      const th = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== tw || canvas.height !== th) {
        canvas.width = tw;
        canvas.height = th;
      }
    }

    const halfRad = THREE.MathUtils.degToRad(FOV_DEG * 0.5);
    const camZ = (cssH * 0.5) / Math.tan(halfRad);
    camera.aspect = cssW / Math.max(1, cssH);
    camera.position.set(0, 0, camZ);
    camera.lookAt(0, 0, 0);
    camera.near = Math.max(1, camZ * 0.05);
    camera.far = Math.max(2000, camZ * 4);
    camera.updateProjectionMatrix();

    const N = Math.min(items.length, MAX_INSTANCES);
    const topStripH = Math.max(0, Number(layoutSpec.topStripH) || 0);
    const betweenGap = topStripH > 0 ? Math.max(10, Number(layoutSpec.betweenGap) || 14) : 0;
    const marginY = Math.max(10, Number(layoutSpec.marginY) || 16);
    const gap = 1; // 1px margin between micro-thumbnails for ultra-compact cluster

    const fullStripW = Math.max(
      160,
      Math.min(cssW - 24, Number(layoutSpec.stripW) > 0 ? Math.round(Number(layoutSpec.stripW)) : Math.round(cssW * 0.80))
    );
    const stripLeft = Math.round((cssW - fullStripW) * 0.5);
    const splitHandVideo = Boolean(layoutSpec.splitHandVideo);
    const videoPos = String(layoutSpec.videoPosition || 'right').toLowerCase() === 'below' ? 'below' : 'right';
    const isBelowHand = splitHandVideo && videoPos === 'below';
    const isRightHand = splitHandVideo && !isBelowHand;
    const splitGap = gap; // Single-pixel 1px divider matching the internal 1px tile gap
    const rawWidthPct = Number(layoutSpec.handWidthPct ?? 50);
    const handWidthPct = Number.isFinite(rawWidthPct)
      ? Math.max(15, Math.min(80, Math.round(rawWidthPct)))
      : 50;
    const rawHeightPct = Number(layoutSpec.handHeightPct ?? 23);
    const handHeightPct = Number.isFinite(rawHeightPct)
      ? Math.max(10, Math.min(45, Math.round(rawHeightPct)))
      : 23;
    const fixedBelowHeightPx = Math.max(0, Math.round(Number(layoutSpec.fixedBelowHeightPx) || 0));
    const isFixedBelowKeyboard = isBelowHand && fixedBelowHeightPx > 0;
    const minSideW = Math.min(48, Math.floor((fullStripW - splitGap) * 0.45));
    const handW = isRightHand
      ? Math.max(
          minSideW,
          Math.min(
            fullStripW - splitGap - minSideW,
            Math.round((fullStripW - splitGap) * (handWidthPct / 100))
          )
        )
      : isBelowHand
        ? fullStripW
        : 0;
    const targetW = isRightHand ? Math.max(minSideW, fullStripW - splitGap - handW) : fullStripW;
    const rawAvailH = Math.max(32, cssH - topStripH - betweenGap - marginY * 2);
    const desiredBelowHandH = isBelowHand
      ? isFixedBelowKeyboard
        ? fixedBelowHeightPx
        : Math.max(24, Math.round(fullStripW * (handHeightPct / 100)))
      : 0;
    const minBelowMosaicH = isBelowHand
      ? Math.max(24, Math.min(64, Math.round(rawAvailH * 0.28)))
      : 0;
    const belowHandH = isBelowHand
      ? N > 0
        ? Math.min(desiredBelowHandH, Math.max(24, rawAvailH - splitGap - minBelowMosaicH))
        : Math.min(desiredBelowHandH, rawAvailH)
      : 0;
    const availH = isRightHand
      ? Math.min(rawAvailH, Math.max(32, Math.round(cssH * 0.34)))
      : isBelowHand
        ? Math.max(24, rawAvailH - (N > 0 ? splitGap + belowHandH : 0))
        : rawAvailH;

    if (N === 0) {
      instGeo.instanceCount = 0;
      const bottomRowH = isRightHand
        ? Math.min(availH, Math.max(24, Math.round(handW / 4.2)))
        : isBelowHand
          ? belowHandH
          : 0;
      const effBetween = topStripH > 0 && bottomRowH > 0 ? betweenGap : 0;
      const totalStackH = topStripH + effBetween + bottomRowH;
      const stackTopY = Math.max(marginY, Math.round((cssH - totalStackH) * 0.5));
      const bottomTopY = Math.round(stackTopY + topStripH + effBetween);
      layout = {
        cols: 1,
        rows: 0,
        cell: 12,
        gap,
        gridW: 0,
        gridH: 0,
        originX: stripLeft,
        originY: bottomTopY,
        stackTopY,
        handRect: isRightHand
          ? {
              x: stripLeft + fullStripW - handW,
              y: bottomTopY,
              w: handW,
              h: Math.max(2, Math.round(bottomRowH))
            }
          : isBelowHand
            ? {
                x: stripLeft,
                y: bottomTopY,
                w: fullStripW,
                h: Math.max(2, Math.round(bottomRowH))
              }
            : null
      };
      return layout;
    }

    const isPortraitStage = cssH > cssW * 1.12;
    const tileScale = Math.max(0.6, Math.min(2.5, Number(layoutSpec.tileScale) || 1.0));
    const mosaicRefW =
      isBelowHand && !isFixedBelowKeyboard
        ? isPortraitStage
          ? fullStripW * 0.96
          : fullStripW * 0.54
        : isRightHand
          ? fullStripW * 0.62
          : fullStripW;
    const baseIdealCellPx = Math.min(
      isPortraitStage ? 16.0 : 12.0,
      Math.max(isBelowHand && !isFixedBelowKeyboard && !isPortraitStage ? 5.6 : 6.2, mosaicRefW / 76)
    );
    const desiredCellPx =
      Number(layoutSpec.desiredCell) > 0 ? Number(layoutSpec.desiredCell) : baseIdealCellPx * tileScale;
    const maxCellPx = Math.max(14.0 * tileScale, desiredCellPx * 1.35);
    const minCellPx = splitHandVideo && !isFixedBelowKeyboard ? 2.5 : 3.2;

    let bestCols = N;
    let bestCell = desiredCellPx;

    // Only if N is ultra-tiny (1–3 tiles) and fits without stretching across targetW, center 1 compact row
    if (N <= 3 && N * desiredCellPx + (N - 1) * gap <= targetW) {
      bestCols = N;
      bestCell = Math.min(desiredCellPx, availH);
    } else {
      // Force-snap cols so cellByW = (targetW - (cols - 1) * gap) / cols makes gridW === targetW FLUSH!
      const minCols = Math.max(1, Math.min(N, Math.ceil((targetW + gap) / (maxCellPx + gap))));
      const maxCols = Math.min(N, Math.max(minCols, Math.floor((targetW + gap) / (minCellPx + gap))));

      let bestScore = -1e9;
      let foundFitting = false;
      for (let cols = minCols; cols <= maxCols; cols++) {
        const rows = Math.ceil(N / cols);
        const cellByW = (targetW - (cols - 1) * gap) / cols;
        if (cellByW < minCellPx - 0.01) continue;

        const neededH = rows * cellByW + (rows - 1) * gap;
        if (neededH > availH + 0.5) continue;

        foundFitting = true;
        const lastRowCount = N - (rows - 1) * cols;
        const lastRowFill = lastRowCount / cols;
        const orphanPenalty = rows > 1 && lastRowFill < 0.25 ? (0.25 - lastRowFill) * 22 : 0;
        const sizeCloseness =
          1.0 - Math.min(1.0, Math.abs(cellByW - desiredCellPx) / Math.max(3.2, desiredCellPx * 0.6));

        const score = sizeCloseness * 38 + lastRowFill * 9 - orphanPenalty;
        if (score > bestScore) {
          bestScore = score;
          bestCols = cols;
        }
      }

      if (!foundFitting) {
        bestCols = maxCols;
      }
      bestCell = (targetW - (bestCols - 1) * gap) / bestCols;
    }

    const rows = Math.ceil(N / bestCols);
    const gridW = bestCols * bestCell + (bestCols - 1) * gap;
    const gridH = rows * bestCell + (rows - 1) * gap;
    const bottomRowH = isBelowHand ? gridH + splitGap + belowHandH : gridH;
    const effBetween = topStripH > 0 ? betweenGap : 0;
    const totalStackH = topStripH + effBetween + bottomRowH;
    const stackTopY = Math.max(10, Math.round((cssH - totalStackH) * 0.5));
    const bottomTopY = Math.round(stackTopY + topStripH + effBetween);
    const originX = isRightHand
      ? stripLeft
      : (cssW - gridW) * 0.5;
    const originY = bottomTopY;
    const handX = isRightHand ? Math.round(stripLeft + targetW + splitGap) : stripLeft;
    const handY = isBelowHand ? Math.round(bottomTopY + gridH + splitGap) : bottomTopY;

    layout = {
      cols: bestCols,
      rows,
      cell: bestCell,
      gap,
      gridW,
      gridH,
      originX,
      originY,
      stackTopY,
      handRect: isRightHand
        ? {
            x: handX,
            y: handY,
            w: handW,
            h: Math.max(2, Math.round(gridH))
          }
        : isBelowHand
          ? {
              x: Math.round(originX),
              y: handY,
              w: Math.max(2, Math.round(gridW > 0 ? gridW : fullStripW)),
              h: Math.max(2, Math.round(belowHandH))
            }
          : null
    };

    syncInstanceTransformsAndUvs();
    return layout;
  }

  function rebuildItemsFromCatalog(catalog) {
    if (!atlasManifest) return;

    const prevActiveBySlice = new Map();
    for (let i = 0; i < items.length; i++) {
      if (activeValues[i] > 0.001) {
        prevActiveBySlice.set(items[i].sliceId, activeValues[i]);
      }
    }

    const assignedBySliceId = new Map();
    if (catalog?.keyboardMap) {
      for (const [midiStr, entry] of Object.entries(catalog.keyboardMap)) {
        const m = Number(midiStr);
        for (const c of entry?.candidates || []) {
          if (c?.sliceId) {
            assignedBySliceId.set(c.sliceId, {
              midi: Number.isFinite(m) ? m : Number(c.midi ?? 60),
              isPerc: Boolean(c.isPerc)
            });
          }
        }
      }
    }

    if (!catalog?.videos?.length) {
      items = atlasManifest.items
        .filter(it => !(isVideoDisabled && isVideoDisabled(it.videoId)))
        .map(it => {
          const midi = Number(it.midi ?? 60);
          const isPerc = Boolean(it.isPerc) || String(it.category || '').toLowerCase() === 'percussion';
          return {
            ...it,
            midi,
            isPerc,
            triggerColorHex: isPerc ? PERC_TRIGGER_HEX : getMidiColorHex(midi),
            selectColorHex: isPerc ? PERC_SELECT_HEX : getMidiColorHex(midi)
          };
        });
    } else {
      const activeVideos = sortCatalogVideosInSidebarOrder(
        catalog.videos.filter(v => !v.deleted && !(isVideoDisabled && isVideoDisabled(v.id)))
      );

      const nextItems = [];
      for (const v of activeVideos) {
        const slices = (v.slices || [])
          .filter(s => !s.deleted)
          .slice()
          .sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0) || (a.hitIndex ?? 0) - (b.hitIndex ?? 0));

        for (const s of slices) {
          const uvEntry = atlasBySliceId.get(s.id);
          if (!uvEntry) continue;
          const assigned = assignedBySliceId.get(s.id);
          const midi = assigned
            ? assigned.midi
            : Number.isFinite(s.manualMidi)
              ? Number(s.manualMidi)
              : Number(s.midi ?? uvEntry.midi ?? 60);
          const isPerc = assigned
            ? assigned.isPerc
            : v.category === 'percussion';

          nextItems.push({
            ...uvEntry,
            videoId: v.id,
            videoIndex: v.index,
            videoSlug: v.slug,
            category: v.category || 'other',
            groupName: v.groupName || v.slug,
            midi,
            isPerc,
            triggerColorHex: isPerc ? PERC_TRIGGER_HEX : getMidiColorHex(midi),
            selectColorHex: isPerc ? PERC_SELECT_HEX : getMidiColorHex(midi)
          });
        }
      }
      items = nextItems;
    }

    if (selectedSliceId && !items.some(it => it.sliceId === selectedSliceId)) {
      selectedSliceId = null;
    }

    activeValues.fill(0);
    poppedFlashUntilMs.fill(0);
    for (let i = 0; i < items.length && i < MAX_INSTANCES; i++) {
      const it = items[i];
      activeValues[i] =
        it.sliceId === selectedSliceId ? 1.0 : prevActiveBySlice.get(it.sliceId) || 0;
    }
    if (hoveredIdx >= items.length) hoveredIdx = -1;

    computeLayout();
    scheduleRender();
  }

  function drawFrameFallback2D() {
    if (!ctx2d) return;
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
    ctx2d.fillStyle = '#000000';
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);
    if (!atlasImage || !atlasManifest || items.length === 0) return;

    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { cols, cell, gap, originX, originY } = layout;
    const stride = cell + gap;
    const aw = atlasManifest.atlasWidth;
    const ah = atlasManifest.atlasHeight;

    // Pass 1: all square B&W micro-thumbnails
    const visCount = getRenderedCount();
    ctx2d.filter = 'grayscale(1) contrast(1.08)';
    for (let i = 0; i < visCount; i++) {
      const it = items[i];
      const col = i % cols;
      const row = (i / cols) | 0;
      const x = originX + col * stride;
      const y = originY + row * stride;
      const sx = it.u0 * aw;
      const sy = it.v0 * ah;
      const sw = (it.u1 - it.u0) * aw;
      const sh = (it.v1 - it.v0) * ah;
      ctx2d.globalAlpha = i === hoveredIdx ? 0.74 : 0.42;
      ctx2d.drawImage(atlasImage, sx, sy, sw, sh, x, y, cell, cell);
    }

    // Pass 2: chromatic hex square fill at 85% max opacity on active/selected tiles
    ctx2d.filter = 'none';
    for (let i = 0; i < visCount; i++) {
      const v = Math.max(0, Math.min(1, activeValues[i]));
      if (v <= 0.004) continue;
      const it = items[i];
      const col = i % cols;
      const row = (i / cols) | 0;
      const x = originX + col * stride;
      const y = originY + row * stride;
      const smooth = v * v * (3 - 2 * v);
      ctx2d.globalAlpha = smooth * 0.85;
      ctx2d.fillStyle =
        it.sliceId === selectedSliceId ? it.selectColorHex : it.triggerColorHex;
      ctx2d.fillRect(x, y, cell, cell);
    }
    ctx2d.globalAlpha = 1.0;
  }

  function stepAnimation(nowMs) {
    rafId = null;
    const dt = lastFrameMs > 0 ? Math.min(0.08, Math.max(0.004, (nowMs - lastFrameMs) / 1000)) : 0.016;
    lastFrameMs = nowMs;

    const activeSet = getActiveSliceIds ? getActiveSliceIds() : new Set();
    let needsMoreFrames = false;
    const N = Math.min(items.length, MAX_INSTANCES);
    // Snappy bottom mosaic decay: starts on note/slot end and dims fast (~0.12s), never fading in
    const TILE_COLOR_DECAY_SEC = 0.12;

    for (let i = 0; i < N; i++) {
      const isSelected = selectedSliceId !== null && items[i].sliceId === selectedSliceId;
      const isPoppedFlash = nowMs < poppedFlashUntilMs[i];
      if (isPoppedFlash) {
        needsMoreFrames = true;
      }
      const isNoteActive = isSelected || activeSet.has(items[i].sliceId);
      if (isNoteActive) {
        tileDecaySecs[i] = TILE_COLOR_DECAY_SEC;
      }
      const target = isNoteActive || isPoppedFlash ? 1.0 : 0.0;
      const cur = activeValues[i];
      if (target >= 1.0) {
        // Hard pop-on: bottom mosaic tile colors NEVER fade in
        activeValues[i] = 1.0;
      } else if (cur > 0.004) {
        const effDecay = Math.max(0.05, tileDecaySecs[i] || TILE_COLOR_DECAY_SEC);
        activeValues[i] = Math.max(0.0, cur - dt / effDecay);
        if (activeValues[i] > 0.004) {
          needsMoreFrames = true;
        }
      } else {
        activeValues[i] = 0.0;
        tileDecaySecs[i] = TILE_COLOR_DECAY_SEC;
      }

      const o2 = i * 2;
      stateArray[o2] = activeValues[i];
      stateArray[o2 + 1] = i === hoveredIdx ? 1.0 : 0.0;
    }

    instGeo.instanceCount = getRenderedCount();

    if (renderer) {
      if (textureReady) {
        attrState.needsUpdate = true;
      }
      renderer.render(scene, camera);
    } else {
      drawFrameFallback2D();
    }

    if (needsMoreFrames || activeSet.size > 0) {
      rafId = requestAnimationFrame(stepAnimation);
    } else {
      lastFrameMs = 0;
    }
  }

  function scheduleRender() {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(stepAnimation);
  }

  function hitTestIndex(clientX, clientY, snapGaps = false) {
    const N = getRenderedCount();
    if (N === 0) return -1;
    const rect = canvas.getBoundingClientRect();
    const lx = clientX - rect.left;
    const ly = clientY - rect.top;
    const { cols, rows, cell, gap, gridW, gridH, originX, originY } = layout;
    const stride = cell + gap;

    const relX = lx - originX;
    const relY = ly - originY;
    if (relX < 0 || relY < 0 || relX > gridW || relY > gridH) return -1;

    const col = Math.min(cols - 1, Math.floor(relX / stride));
    const row = Math.min(rows - 1, Math.floor(relY / stride));
    if (col < 0 || col >= cols || row < 0 || row >= rows) return -1;

    if (!snapGaps) {
      const inCellX = relX - col * stride;
      const inCellY = relY - row * stride;
      if (inCellX > cell || inCellY > cell) return -1;
    }

    const idx = row * cols + col;
    return idx >= 0 && idx < N ? idx : -1;
  }

  function endActiveDrag() {
    if (!isPointerDragging) return;
    isPointerDragging = false;
    if (activeDragSliceId !== null) {
      const heldSec = Math.max(0, (performance.now() - activeDragStartedMs) / 1000);
      if (onSliceLeave) {
        onSliceLeave(activeDragSliceId, heldSec, draggedAcrossMultiple);
      }
      activeDragSliceId = null;
    }
    draggedAcrossMultiple = false;
    scheduleRender();
  }

  canvas.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    isPointerDragging = true;
    draggedAcrossMultiple = false;

    const idx = hitTestIndex(e.clientX, e.clientY, true);
    hoveredIdx = idx;
    if (idx >= 0) {
      const item = items[idx];
      activeDragSliceId = item.sliceId;
      activeDragStartedMs = performance.now();
      if (onSliceEnter) onSliceEnter(item);
    } else {
      activeDragSliceId = null;
    }
    scheduleRender();
  });

  window.addEventListener('mousemove', e => {
    if (!isPointerDragging && e.target !== canvas) {
      if (hoveredIdx !== -1) {
        hoveredIdx = -1;
        canvas.style.cursor = 'default';
        canvas.title = '';
        scheduleRender();
      }
      return;
    }

    const idx = hitTestIndex(e.clientX, e.clientY, isPointerDragging);
    if (idx !== hoveredIdx) {
      hoveredIdx = idx;
      canvas.style.cursor = idx >= 0 ? 'pointer' : 'default';
      if (idx >= 0 && formatTooltip) {
        canvas.title = formatTooltip(items[idx]);
      } else {
        canvas.title = '';
      }
      scheduleRender();
    }

    if (isPointerDragging) {
      if (idx >= 0) {
        const nextItem = items[idx];
        if (nextItem.sliceId !== activeDragSliceId) {
          if (activeDragSliceId !== null) {
            draggedAcrossMultiple = true;
            const prevHeldSec = Math.max(0, (performance.now() - activeDragStartedMs) / 1000);
            if (onSliceLeave) onSliceLeave(activeDragSliceId, prevHeldSec, true);
          }
          activeDragSliceId = nextItem.sliceId;
          activeDragStartedMs = performance.now();
          if (onSliceEnter) onSliceEnter(nextItem);
          scheduleRender();
        }
      } else if (activeDragSliceId !== null) {
        draggedAcrossMultiple = true;
        const prevHeldSec = Math.max(0, (performance.now() - activeDragStartedMs) / 1000);
        if (onSliceLeave) onSliceLeave(activeDragSliceId, prevHeldSec, true);
        activeDragSliceId = null;
        scheduleRender();
      }
    }
  });

  window.addEventListener('mouseup', endActiveDrag);
  window.addEventListener('blur', endActiveDrag);

  async function loadAtlas(initialCatalog = null) {
    try {
      const res = await fetch(`./stage-atlas.json?t=${Date.now()}`, { cache: 'no-cache' });
      if (!res.ok) return;
      atlasManifest = await res.json();
      atlasBySliceId = new Map((atlasManifest.items || []).map(it => [it.sliceId, it]));
      const atlasVer = Date.parse(atlasManifest.generatedAt || atlasManifest.updatedAt || '') || Date.now();

      const img = new Image();
      img.decoding = 'async';
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = `./stage-atlas.jpg?v=${atlasVer}`;
      });
      atlasImage = img;

      if (renderer) {
        const tex = new THREE.Texture(img);
        tex.flipY = false;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.needsUpdate = true;
        material.uniforms.uAtlas.value = tex;
      }

      textureReady = true;
      rebuildItemsFromCatalog(initialCatalog);
    } catch (err) {
      console.warn('Could not load Three.js stage atlas:', err);
    }
  }

  return {
    scene,
    camera,
    renderer,
    loadAtlas,
    getAtlasAssets() {
      return { atlasManifest, atlasImage };
    },
    getItemCount() {
      return Math.min(items.length, MAX_INSTANCES);
    },
    getItems() {
      return items.slice(0, Math.min(items.length, MAX_INSTANCES));
    },
    setVisibleCount(nextCount = null) {
      if (nextCount === null || nextCount === undefined) {
        visibleCountLimit = null;
        poppedFlashUntilMs.fill(0);
      } else {
        visibleCountLimit = Math.max(0, Math.floor(Number(nextCount) || 0));
      }
      instGeo.instanceCount = getRenderedCount();
      scheduleRender();
    },
    pulseTileRange(fromIdx, toIdxExclusive, holdMs = 34, decaySec = 1.0) {
      const N = Math.min(items.length, MAX_INSTANCES);
      const i0 = Math.max(0, Math.floor(fromIdx));
      const i1 = Math.min(N, Math.floor(toIdxExclusive));
      if (i1 <= i0) return;
      const until = performance.now() + Math.max(16, holdMs);
      const effDecay = Math.max(0.05, Number(decaySec) || 1.0);
      for (let i = i0; i < i1; i++) {
        activeValues[i] = 1.0;
        poppedFlashUntilMs[i] = until;
        tileDecaySecs[i] = effDecay;
      }
      scheduleRender();
    },
    drawAtlasThumb(targetCtx, sliceId, dx, dy, dw, dh) {
      if (!targetCtx || !atlasImage || !atlasManifest || !sliceId) return false;
      const uvEntry = atlasBySliceId.get(sliceId);
      if (!uvEntry) return false;
      const aw = atlasManifest.atlasWidth;
      const ah = atlasManifest.atlasHeight;
      const sx = uvEntry.u0 * aw;
      const sy = uvEntry.v0 * ah;
      const sw = (uvEntry.u1 - uvEntry.u0) * aw;
      const sh = (uvEntry.v1 - uvEntry.v0) * ah;
      if (!(sw > 0 && sh > 0)) return false;
      try {
        targetCtx.drawImage(atlasImage, sx, sy, sw, sh, dx, dy, dw, dh);
        return true;
      } catch {
        return false;
      }
    },
    getLayout() {
      return { ...layout };
    },
    setSelectedSliceId(nextSliceId = null) {
      const normalized = nextSliceId ? String(nextSliceId) : null;
      if (selectedSliceId === normalized) return;
      selectedSliceId = normalized;
      syncNoteColors();
      scheduleRender();
    },
    getSelectedSliceId() {
      return selectedSliceId;
    },
    stepSelection(dCol = 0, dRow = 0) {
      const N = Math.min(items.length, MAX_INSTANCES);
      if (N === 0) return null;
      let curIdx = selectedSliceId ? items.findIndex(it => it.sliceId === selectedSliceId) : -1;
      if (curIdx < 0) curIdx = 0;

      const cols = Math.max(1, layout.cols || 1);
      let nextIdx = curIdx;
      if (dRow === 0) {
        nextIdx = Math.max(0, Math.min(N - 1, curIdx + dCol));
      } else {
        const curCol = curIdx % cols;
        const curRow = (curIdx / cols) | 0;
        const maxRow = ((N - 1) / cols) | 0;
        const targetRow = Math.max(0, Math.min(maxRow, curRow + dRow));
        nextIdx = Math.min(N - 1, targetRow * cols + curCol);
      }

      const chosen = items[nextIdx] || null;
      if (chosen) {
        selectedSliceId = chosen.sliceId;
        syncNoteColors();
        scheduleRender();
      }
      return chosen;
    },
    setFadeOutSec(nextSec = 0.2) {
      const n = Number(nextSec);
      fadeOutSec = Number.isFinite(n) ? Math.max(0.0, Math.min(2.0, n)) : 0.2;
    },
    syncCatalog(catalog) {
      rebuildItemsFromCatalog(catalog);
      return layout;
    },
    setStageLayoutSpec(nextSpec = {}) {
      layoutSpec = { ...layoutSpec, ...nextSpec };
      const res = computeLayout();
      scheduleRender();
      return res;
    },
    resize() {
      const res = computeLayout();
      scheduleRender();
      return res;
    },
    notifyActivity() {
      scheduleRender();
    }
  };
}
