import * as THREE from './vendor/three.module.min.js';

// ============================================================================
// Three.js 3D Stage Canvas
// - Powered by THREE.Scene + THREE.PerspectiveCamera + THREE.InstancedBufferGeometry
// - Renders a chromatic note-color dot on every video tile in the 3D grid
// - Dynamically hides tiles from muted/disabled videos in the Video File Explorer
// - Click, click-and-hold, or click-and-drag across tiles to trigger samples
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
const PERC_HEX = '#8c95a4';

function hexToNormRgb(hex) {
  const clean = String(hex || PERC_HEX).replace('#', '');
  const n = parseInt(clean, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function getMidiColorHex(midi) {
  const m = Number.isFinite(midi) ? Math.round(midi) : 60;
  if (m < 36) return PERC_HEX;
  return CHROMATIC_HEX[((m % 12) + 12) % 12];
}

const TILE_VERT_SHADER = `
attribute vec3 iOffsetScale; // x: worldX, y: worldY, z: cellSize
attribute vec4 iUvRect;      // u0, v0, u1, v1
attribute vec2 iState;       // x: activeAmount, y: hoverAmount
attribute vec3 iNoteColor;   // r, g, b normalized note color

varying vec2 vUv;
varying vec2 vTileUv;
varying float vCellPx;
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
  vTileUv = uv;
  vCellPx = iOffsetScale.z;
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
varying vec2 vTileUv;
varying float vCellPx;
varying float vActive;
varying float vHover;
varying vec3 vNoteColor;

void main() {
  vec3 texRgb = texture2D(uAtlas, vUv).rgb;
  float luma = dot(texRgb, vec3(0.299, 0.587, 0.114));
  vec3 bwRgb = vec3(luma);

  // Idle state: moody monochrome B&W (~20% opacity, subtle lift on hover)
  float hoverAmt = clamp(vHover, 0.0, 1.0);
  float idleAlpha = mix(0.20, 0.42, hoverAmt);
  vec3 idleColor = mix(uBgColor, bwRgb, idleAlpha);

  // Active / playing state: full vivid color + brightness lift at 100% opacity
  vec3 activeColor = clamp(texRgb * 1.18 + 0.02, 0.0, 1.0);

  float t = smoothstep(0.0, 1.0, clamp(vActive, 0.0, 1.0));
  vec3 baseRgb = mix(idleColor, activeColor, t);

  // Crisp centered chromatic note-color dot on every tile
  vec2 deltaPx = (vTileUv - 0.5) * vCellPx;
  float distPx = length(deltaPx);
  float dotRadiusPx = clamp(vCellPx * 0.135, 2.1, 3.4);
  float dotMask = 1.0 - smoothstep(dotRadiusPx - 0.7, dotRadiusPx + 0.55, distPx);
  float dotAlpha = mix(0.84, 1.0, max(t, hoverAmt));
  vec3 finalRgb = mix(baseRgb, vNoteColor, dotMask * dotAlpha);

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

  const tileMesh = new THREE.Mesh(instGeo, material);
  tileMesh.frustumCulled = false;
  scene.add(tileMesh);

  let atlasManifest = null;
  let atlasBySliceId = new Map();
  let atlasImage = null;
  let textureReady = false;

  let items = [];
  let activeValues = new Float32Array(MAX_INSTANCES);

  let cssW = 1;
  let cssH = 1;
  let dpr = 1;
  let layoutSpec = {
    stripW: 0,
    topStripH: 0,
    betweenGap: 24,
    marginY: 28
  };
  let layout = {
    cols: 1,
    rows: 1,
    cell: 20,
    gap: 3,
    gridW: 20,
    gridH: 20,
    originX: 0,
    originY: 0,
    stackTopY: 28
  };

  let hoveredIdx = -1;
  let isPointerDragging = false;
  let activeDragSliceId = null;
  let activeDragStartedMs = 0;
  let draggedAcrossMultiple = false;
  let rafId = null;
  let lastFrameMs = 0;

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

      const [nr, ng, nb] = hexToNormRgb(it.colorHex);
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
    const betweenGap = topStripH > 0 ? Math.max(14, Number(layoutSpec.betweenGap) || 24) : 0;
    const marginY = Math.max(14, Number(layoutSpec.marginY) || 24);

    if (N === 0) {
      instGeo.instanceCount = 0;
      const stackTopY = Math.max(marginY, Math.round((cssH - topStripH) * 0.5));
      layout = {
        cols: 1,
        rows: 1,
        cell: 20,
        gap: 3,
        gridW: 0,
        gridH: 0,
        originX: 0,
        originY: stackTopY + topStripH + betweenGap,
        stackTopY
      };
      return layout;
    }

    const targetW = Math.max(
      180,
      Math.min(cssW - 32, Number(layoutSpec.stripW) > 0 ? Number(layoutSpec.stripW) : Math.round(cssW * 0.78))
    );
    const availH = Math.max(76, cssH - topStripH - betweenGap - marginY * 2);
    const gap = cssW < 900 ? 2 : 3;
    const maxCellPx = N < 80 ? 38 : 34;

    let bestCols = Math.max(1, Math.ceil(Math.sqrt(N * (targetW / Math.max(1, availH)))));
    let bestCell = 12;
    let bestScore = -1e9;

    for (let cols = 1; cols <= N; cols++) {
      const rows = Math.ceil(N / cols);
      const cellByW = (targetW - (cols - 1) * gap) / cols;
      const cellByH = (availH - (rows - 1) * gap) / rows;
      const cell = Math.min(maxCellPx, cellByW, cellByH);
      if (cell < 5) continue;

      const usedW = cols * cell + (cols - 1) * gap;
      const widthFill = usedW / Math.max(1, targetW);
      const lastRowCount = N - (rows - 1) * cols;
      const lastRowFill = lastRowCount / cols;

      // Strongly reward spanning the full 3-video strip width with crisp ~16..24px tiles & filled final row
      const score = widthFill * 46 + cell * 2.4 + lastRowFill * 5.2;
      if (score > bestScore) {
        bestScore = score;
        bestCols = cols;
        bestCell = cell;
      }
    }

    const rows = Math.ceil(N / bestCols);
    const gridW = bestCols * bestCell + (bestCols - 1) * gap;
    const gridH = rows * bestCell + (rows - 1) * gap;
    const totalStackH = topStripH + (topStripH > 0 ? betweenGap : 0) + gridH;
    const stackTopY = Math.max(12, Math.round((cssH - totalStackH) * 0.5));
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

    if (!catalog?.videos?.length) {
      items = atlasManifest.items
        .filter(it => !(isVideoDisabled && isVideoDisabled(it.videoId)))
        .map(it => ({
          ...it,
          colorHex: getMidiColorHex(it.midi ?? 60)
        }));
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
          const midi = Number.isFinite(s.manualMidi)
            ? Number(s.manualMidi)
            : Number(s.midi ?? uvEntry.midi ?? 60);
          nextItems.push({
            ...uvEntry,
            videoId: v.id,
            videoIndex: v.index,
            videoSlug: v.slug,
            midi,
            colorHex: getMidiColorHex(midi)
          });
        }
      }
      items = nextItems;
    }

    activeValues.fill(0);
    for (let i = 0; i < items.length && i < MAX_INSTANCES; i++) {
      activeValues[i] = prevActiveBySlice.get(items[i].sliceId) || 0;
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
    const dotR = Math.max(2.1, Math.min(3.4, cell * 0.135));

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
        ctx2d.filter = 'grayscale(1)';
        ctx2d.globalAlpha = i === hoveredIdx ? 0.42 : 0.20;
      }
      ctx2d.drawImage(atlasImage, sx, sy, sw, sh, x, y, cell, cell);

      ctx2d.filter = 'none';
      ctx2d.globalAlpha = activeValues[i] > 0.02 || i === hoveredIdx ? 1.0 : 0.84;
      ctx2d.fillStyle = it.colorHex || PERC_HEX;
      ctx2d.beginPath();
      ctx2d.arc(x + cell * 0.5, y + cell * 0.5, dotR, 0, Math.PI * 2);
      ctx2d.fill();
    }
    ctx2d.filter = 'none';
    ctx2d.globalAlpha = 1.0;
  }

  function stepAnimation(nowMs) {
    rafId = null;
    const dt = lastFrameMs > 0 ? Math.min(0.08, Math.max(0.004, (nowMs - lastFrameMs) / 1000)) : 0.016;
    lastFrameMs = nowMs;

    const activeSet = getActiveSliceIds ? getActiveSliceIds() : new Set();
    let needsMoreFrames = false;
    const N = Math.min(items.length, MAX_INSTANCES);

    for (let i = 0; i < N; i++) {
      const target = activeSet.has(items[i].sliceId) ? 1.0 : 0.0;
      const cur = activeValues[i];
      if (Math.abs(target - cur) > 0.004) {
        const speed = target > cur ? dt / 0.065 : dt / 0.20;
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
