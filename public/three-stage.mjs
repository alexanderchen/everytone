import * as THREE from './vendor/three.module.min.js';

// ============================================================================
// Three.js 3D Stage Canvas
// - Powered by THREE.Scene + THREE.PerspectiveCamera + THREE.InstancedBufferGeometry
// - Compact 1px-gap B&W micro-thumbnail mosaic flush beneath the foreground film grid
// - Zero colored dots in idle; crisp outer stroke border when playing or selected
// - Percussion tiles use grayish border on trigger (#8a8a8a) & light gray when selected (#e2e2e2)
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

function getMidiColorHex(midi) {
  const m = Number.isFinite(midi) ? Math.round(midi) : 60;
  if (m < 36) return PERC_TRIGGER_HEX;
  return CHROMATIC_HEX[((m % 12) + 12) % 12];
}

const TILE_VERT_SHADER = `
attribute vec3 iOffsetScale; // x: worldX, y: worldY, z: cellSize
attribute vec4 iUvRect;      // u0, v0, u1, v1
attribute vec2 iState;       // x: activeAmount, y: hoverAmount
attribute vec3 iNoteColor;   // r, g, b normalized border color

varying vec2 vUv;
varying float vActive;
varying float vHover;

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

void main() {
  vec3 texRgb = texture2D(uAtlas, vUv).rgb;
  float luma = dot(texRgb, vec3(0.299, 0.587, 0.114));
  float crispLuma = clamp(pow(max(luma, 0.0), 0.88) * 1.08, 0.0, 1.0);
  vec3 bwRgb = vec3(crispLuma);

  // Idle state: crisp monochrome B&W with higher visibility, zero colored dots
  float hoverAmt = clamp(vHover, 0.0, 1.0);
  float idleAlpha = mix(0.42, 0.74, hoverAmt);
  vec3 idleColor = mix(uBgColor, bwRgb, idleAlpha);

  // Active / selected state: vivid full-color thumbnail at 100% opacity
  vec3 activeColor = clamp(texRgb * 1.18 + 0.02, 0.0, 1.0);

  float t = smoothstep(0.0, 1.0, clamp(vActive, 0.0, 1.0));
  vec3 finalRgb = mix(idleColor, activeColor, t);

  gl_FragColor = vec4(finalRgb, 1.0);
}
`;

const BORDER_VERT_SHADER = `
attribute vec3 iOffsetScale; // x: worldX, y: worldY, z: cellSize
attribute vec2 iState;       // x: activeAmount, y: hoverAmount
attribute vec3 iNoteColor;   // r, g, b normalized border color

varying vec2 vLocalPx;
varying float vCellPx;
varying float vActive;
varying vec3 vNoteColor;

void main() {
  if (iState.x <= 0.005) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vLocalPx = vec2(0.0);
    vCellPx = 1.0;
    vActive = 0.0;
    vNoteColor = vec3(0.0);
    return;
  }

  float outStrokePx = 2.0;
  float quadSize = iOffsetScale.z + outStrokePx * 2.0;
  vec3 worldPos = vec3(
    position.x * quadSize + iOffsetScale.x,
    position.y * quadSize + iOffsetScale.y,
    position.z
  );
  vLocalPx = position.xy * quadSize;
  vCellPx = iOffsetScale.z;
  vActive = iState.x;
  vNoteColor = iNoteColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
}
`;

const BORDER_FRAG_SHADER = `
precision highp float;

varying vec2 vLocalPx;
varying float vCellPx;
varying float vActive;
varying vec3 vNoteColor;

void main() {
  float halfCell = vCellPx * 0.5;
  float maxCoord = max(abs(vLocalPx.x), abs(vLocalPx.y));
  // Strictly outside the inner cell square (2px outer stroke ring)
  if (maxCoord < halfCell - 0.15) {
    discard;
  }
  float alpha = smoothstep(0.0, 0.35, clamp(vActive, 0.0, 1.0));
  gl_FragColor = vec4(vNoteColor, alpha);
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
  const MAX_INSTANCES = 600;

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

  const borderMaterial = new THREE.ShaderMaterial({
    vertexShader: BORDER_VERT_SHADER,
    fragmentShader: BORDER_FRAG_SHADER,
    transparent: true,
    depthTest: false,
    depthWrite: false
  });

  const tileMesh = new THREE.Mesh(instGeo, material);
  tileMesh.frustumCulled = false;
  tileMesh.renderOrder = 0;
  scene.add(tileMesh);

  const borderMesh = new THREE.Mesh(instGeo, borderMaterial);
  borderMesh.frustumCulled = false;
  borderMesh.renderOrder = 1;
  scene.add(borderMesh);

  let atlasManifest = null;
  let atlasBySliceId = new Map();
  let atlasImage = null;
  let textureReady = false;

  let items = [];
  let activeValues = new Float32Array(MAX_INSTANCES);
  let selectedSliceId = null;
  let fadeOutSec = 0.20;

  let cssW = 1;
  let cssH = 1;
  let dpr = 1;
  let layoutSpec = {
    stripW: 0,
    topStripH: 0,
    betweenGap: 16,
    marginY: 20
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
    stackTopY: 24
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

  function syncInstanceTransformsAndUvs() {
    const N = Math.min(items.length, MAX_INSTANCES);
    instGeo.instanceCount = N;
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

    if (N === 0) {
      instGeo.instanceCount = 0;
      const stackTopY = Math.max(marginY, Math.round((cssH - topStripH) * 0.5));
      layout = {
        cols: 1,
        rows: 0,
        cell: 12,
        gap,
        gridW: 0,
        gridH: 0,
        originX: 0,
        originY: stackTopY + topStripH,
        stackTopY
      };
      return layout;
    }

    const targetW = Math.max(
      160,
      Math.min(cssW - 24, Number(layoutSpec.stripW) > 0 ? Number(layoutSpec.stripW) : Math.round(cssW * 0.80))
    );
    const availH = Math.max(32, cssH - topStripH - betweenGap - marginY * 2);
    const maxCellPx = 14.0;
    const idealCellPx = Math.min(12.0, Math.max(7.5, targetW / 76));

    let bestCols = N;
    let bestCell = idealCellPx;

    // Only if N is very small (all tiles fit on 1 row without exceeding maxCellPx), center 1 compact row
    if (N * maxCellPx + (N - 1) * gap <= targetW) {
      bestCols = N;
      bestCell = Math.min(maxCellPx, availH);
    } else {
      // Otherwise choose cols so cell = (targetW - (cols - 1) * gap) / cols makes gridW === targetW FLUSH!
      let bestScore = -1e9;
      const minCols = Math.max(10, Math.ceil((targetW + gap) / (maxCellPx + gap)));
      const maxCols = Math.min(N, Math.max(minCols + 1, Math.floor((targetW + gap) / (4.5 + gap))));

      for (let cols = minCols; cols <= maxCols; cols++) {
        const rows = Math.ceil(N / cols);
        const cellByW = (targetW - (cols - 1) * gap) / cols;
        if (cellByW < 4.5 || cellByW > maxCellPx + 0.01) continue;

        const neededH = rows * cellByW + (rows - 1) * gap;
        const fitsH = neededH <= availH;
        const overflowPenalty = fitsH ? 0 : (neededH - availH) * 4.0;

        const lastRowCount = N - (rows - 1) * cols;
        const lastRowFill = lastRowCount / cols;
        const sizeCloseness = 1.0 - Math.min(1.0, Math.abs(cellByW - idealCellPx) / 7.0);

        const score = sizeCloseness * 28 + lastRowFill * 9 - rows * 1.35 - overflowPenalty;
        if (score > bestScore) {
          bestScore = score;
          bestCols = cols;
          bestCell = fitsH ? cellByW : Math.max(4.0, Math.min(cellByW, (availH - (rows - 1) * gap) / rows));
        }
      }
    }

    const rows = Math.ceil(N / bestCols);
    const gridW = bestCols * bestCell + (bestCols - 1) * gap;
    const gridH = rows * bestCell + (rows - 1) * gap;
    const totalStackH = topStripH + (topStripH > 0 ? betweenGap : 0) + gridH;
    const stackTopY = Math.max(10, Math.round((cssH - totalStackH) * 0.5));
    const originX = (cssW - gridW) * 0.5;
    const originY = stackTopY + topStripH + (topStripH > 0 ? betweenGap : 0);

    layout = {
      cols: bestCols,
      rows,
      cell: bestCell,
      gap,
      gridW,
      gridH,
      originX,
      originY,
      stackTopY
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
              isPerc: m < 36 || Boolean(c.isPerc)
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
          const isPerc = midi < 36 || String(it.category || '').toLowerCase() === 'percussion';
          return {
            ...it,
            midi,
            isPerc,
            triggerColorHex: isPerc ? PERC_TRIGGER_HEX : getMidiColorHex(midi),
            selectColorHex: isPerc ? PERC_SELECT_HEX : getMidiColorHex(midi)
          };
        });
    } else {
      const activeVideos = catalog.videos
        .filter(v => !v.deleted && !(isVideoDisabled && isVideoDisabled(v.id)))
        .slice()
        .sort((a, b) => (a.index || 0) - (b.index || 0));

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
            : v.category === 'percussion' || Boolean(s.percBucket) || midi < 36;

          nextItems.push({
            ...uvEntry,
            videoId: v.id,
            videoIndex: v.index,
            videoSlug: v.slug,
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

    // Pass 1: all square thumbnails (idle B&W, active/selected vivid color)
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const col = i % cols;
      const row = (i / cols) | 0;
      const x = originX + col * stride;
      const y = originY + row * stride;
      const sx = it.u0 * aw;
      const sy = it.v0 * ah;
      const sw = (it.u1 - it.u0) * aw;
      const sh = (it.v1 - it.v0) * ah;
      if (activeValues[i] > 0.02) {
        ctx2d.filter = 'brightness(1.18)';
        ctx2d.globalAlpha = 1.0;
      } else {
        ctx2d.filter = 'grayscale(1) contrast(1.08)';
        ctx2d.globalAlpha = i === hoveredIdx ? 0.74 : 0.42;
      }
      ctx2d.drawImage(atlasImage, sx, sy, sw, sh, x, y, cell, cell);
    }

    // Pass 2: outer 2px stroke border on active/selected tiles
    ctx2d.filter = 'none';
    ctx2d.lineWidth = 2;
    for (let i = 0; i < items.length; i++) {
      if (activeValues[i] <= 0.01) continue;
      const it = items[i];
      const col = i % cols;
      const row = (i / cols) | 0;
      const x = originX + col * stride;
      const y = originY + row * stride;
      ctx2d.globalAlpha = Math.min(1, activeValues[i] / 0.35);
      ctx2d.strokeStyle =
        it.sliceId === selectedSliceId ? it.selectColorHex : it.triggerColorHex;
      ctx2d.strokeRect(x - 1, y - 1, cell + 2, cell + 2);
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
    const decayTime = Math.max(0.18, Number(fadeOutSec) || 0.20);

    for (let i = 0; i < N; i++) {
      const isSelected = selectedSliceId !== null && items[i].sliceId === selectedSliceId;
      const target = isSelected || activeSet.has(items[i].sliceId) ? 1.0 : 0.0;
      const cur = activeValues[i];
      if (isSelected) {
        activeValues[i] = 1.0;
      } else if (Math.abs(target - cur) > 0.004) {
        const speed = target > cur ? dt / 0.055 : dt / decayTime;
        activeValues[i] = target > cur ? Math.min(1.0, cur + speed) : Math.max(0.0, cur - speed);
        if (Math.abs(target - activeValues[i]) > 0.004) {
          needsMoreFrames = true;
        }
      } else {
        activeValues[i] = target;
      }

      const o2 = i * 2;
      stateArray[o2] = activeValues[i];
      stateArray[o2 + 1] = i === hoveredIdx ? 1.0 : 0.0;
    }

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
    const N = Math.min(items.length, MAX_INSTANCES);
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
      const res = await fetch('./stage-atlas.json');
      if (!res.ok) return;
      atlasManifest = await res.json();
      atlasBySliceId = new Map((atlasManifest.items || []).map(it => [it.sliceId, it]));

      const img = new Image();
      img.decoding = 'async';
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = './stage-atlas.jpg';
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
    getItemCount() {
      return Math.min(items.length, MAX_INSTANCES);
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
      fadeOutSec = Math.max(0.18, Math.min(1.2, Number(nextSec) || 0.2));
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
