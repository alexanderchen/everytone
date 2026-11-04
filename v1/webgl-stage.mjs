// ============================================================================
// Compact Floating WebGL Sample Grid (Tier-1 Active Slices Grouped by Video)
// - Floats strictly above the bottom chromatic circle strip with tiny thumbnails
// - Idle: Very dim monochrome (B&W) start-frame thumbnails (~16% opacity)
// - Active / Playing: Full color + brighter while clip is playing/held
// - Interactive: Click, click-and-hold, or click-and-drag across cells to play
// ============================================================================

const VERT_SRC = `
attribute vec2 aPos;
attribute vec2 aUv;
attribute float aActive;
attribute float aHover;

uniform vec2 uViewport;

varying vec2 vUv;
varying float vActive;
varying float vHover;

void main() {
  vec2 clip = vec2(
    (aPos.x / max(1.0, uViewport.x)) * 2.0 - 1.0,
    1.0 - (aPos.y / max(1.0, uViewport.y)) * 2.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);
  vUv = aUv;
  vActive = aActive;
  vHover = aHover;
}
`;

const FRAG_SRC = `
precision mediump float;

uniform sampler2D uAtlas;
uniform vec3 uBgColor;

varying vec2 vUv;
varying float vActive;
varying float vHover;

void main() {
  vec3 texRgb = texture2D(uAtlas, vUv).rgb;
  float luma = dot(texRgb, vec3(0.299, 0.587, 0.114));
  vec3 bwRgb = vec3(luma);

  // Idle state: very dim monochrome B&W (~16% opacity, gentle lift to 36% on hover)
  float idleAlpha = mix(0.16, 0.36, clamp(vHover, 0.0, 1.0));
  vec3 idleColor = mix(uBgColor, bwRgb, idleAlpha);

  // Playing state: full color + brighter at 100% opacity
  vec3 activeColor = clamp(texRgb * 1.18 + 0.02, 0.0, 1.0);

  float t = smoothstep(0.0, 1.0, clamp(vActive, 0.0, 1.0));
  gl_FragColor = vec4(mix(idleColor, activeColor, t), 1.0);
}
`;

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`WebGL shader error: ${info}`);
  }
  return sh;
}

function createProgram(gl, vsSrc, fsSrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`WebGL program link error: ${info}`);
  }
  return prog;
}

export function createWebglStage({
  canvas,
  dockSelector = '.keyboard-dock',
  getActiveSliceIds,
  onSliceEnter,
  onSliceLeave,
  formatTooltip
}) {
  if (!canvas) return null;

  let gl = null;
  let ctx2d = null;
  try {
    gl =
      canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance'
      }) ||
      canvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance'
      });
  } catch {}

  let program = null;
  let vbo = null;
  let atlasTex = null;
  let locPos = -1;
  let locUv = -1;
  let locActive = -1;
  let locHover = -1;
  let uViewportLoc = null;
  let uAtlasLoc = null;
  let uBgColorLoc = null;

  if (gl) {
    try {
      program = createProgram(gl, VERT_SRC, FRAG_SRC);
      vbo = gl.createBuffer();
      locPos = gl.getAttribLocation(program, 'aPos');
      locUv = gl.getAttribLocation(program, 'aUv');
      locActive = gl.getAttribLocation(program, 'aActive');
      locHover = gl.getAttribLocation(program, 'aHover');
      uViewportLoc = gl.getUniformLocation(program, 'uViewport');
      uAtlasLoc = gl.getUniformLocation(program, 'uAtlas');
      uBgColorLoc = gl.getUniformLocation(program, 'uBgColor');
    } catch (err) {
      console.warn('WebGL setup fallback to 2D:', err);
      gl = null;
    }
  }
  if (!gl) {
    ctx2d = canvas.getContext('2d');
  }

  let atlasManifest = null;
  let atlasBySliceId = new Map();
  let atlasImage = null;
  let textureReady = false;

  // Ordered visible Tier-1 items (grouped by source video)
  let items = [];
  let activeValues = new Float32Array(0);
  let vertexData = new Float32Array(0); // 6 verts * 6 floats (x, y, u, v, active, hover)

  let cssW = 1;
  let cssH = 1;
  let dpr = 1;
  let layout = {
    cols: 1,
    rows: 1,
    cell: 16,
    gap: 2,
    gridW: 16,
    gridH: 16,
    originX: 0,
    originY: 0
  };

  let hoveredIdx = -1;
  let isPointerDragging = false;
  let activeDragSliceId = null;
  let activeDragStartedMs = 0;
  let draggedAcrossMultiple = false;
  let rafId = null;
  let lastFrameMs = 0;

  function computeLayout() {
    const stageRect = canvas.getBoundingClientRect();
    cssW = Math.max(1, Math.round(stageRect.width || canvas.clientWidth || 1));
    cssH = Math.max(1, Math.round(stageRect.height || canvas.clientHeight || 1));
    dpr = Math.min(2, window.devicePixelRatio || 1);

    const targetW = Math.max(1, Math.round(cssW * dpr));
    const targetH = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const N = items.length;
    if (N === 0) {
      layout = { cols: 1, rows: 1, cell: 16, gap: 2, gridW: 16, gridH: 16, originX: 0, originY: 0 };
      return;
    }

    // Measure exact top & width of the chromatic color dot strip so the grid ALWAYS floats strictly above it
    const dockEl = dockSelector ? document.querySelector(dockSelector) : null;
    const dockRect = dockEl ? dockEl.getBoundingClientRect() : null;
    const dockTopY =
      dockRect && dockRect.height > 0 ? Math.max(80, dockRect.top - stageRect.top) : Math.max(80, cssH - 84);
    const dockW = dockRect && dockRect.width > 0 ? dockRect.width : cssW * 0.72;

    const topPad = Math.max(24, Math.round(dockTopY * 0.09));
    const bottomGap = Math.max(24, Math.round(dockTopY * 0.07));
    const zoneH = Math.max(72, dockTopY - topPad - bottomGap);

    // Compact floating mosaic with very small thumbnails (~12-16px)
    const availW = Math.max(120, Math.min(Math.round(dockW * 0.74), Math.round(cssW * 0.56)));
    const availH = Math.max(64, Math.round(zoneH * 0.68));
    const gap = 2;
    const maxCellPx = 16;
    const targetAspect = Math.max(1.8, Math.min(2.5, availW / Math.max(1, availH)));

    let bestCols = 32;
    let bestCell = 10;
    let bestScore = -1e9;

    for (let cols = 10; cols <= N; cols++) {
      const rows = Math.ceil(N / cols);
      const maxCellW = (availW - (cols - 1) * gap) / cols;
      const maxCellH = (availH - (rows - 1) * gap) / rows;
      const cell = Math.min(maxCellPx, Math.floor(Math.min(maxCellW, maxCellH)));
      if (cell < 5) continue;

      const lastRowCount = N - (rows - 1) * cols;
      const lastRowFill = lastRowCount / cols;
      const aspectDiff = Math.abs(cols / rows - targetAspect);
      const score = cell * 10 + lastRowFill * 2.5 - aspectDiff * 1.2;

      if (score > bestScore) {
        bestScore = score;
        bestCols = cols;
        bestCell = cell;
      }
    }

    const rows = Math.ceil(N / bestCols);
    const gridW = bestCols * bestCell + (bestCols - 1) * gap;
    const gridH = rows * bestCell + (rows - 1) * gap;
    const originX = Math.round((cssW - gridW) * 0.5);
    const originY = Math.round(topPad + (zoneH - gridH) * 0.5);

    layout = {
      cols: bestCols,
      rows,
      cell: bestCell,
      gap,
      gridW,
      gridH,
      originX,
      originY
    };
  }

  function rebuildItemsFromCatalog(catalog) {
    if (!atlasManifest) return;

    if (!catalog?.videos?.length) {
      items = atlasManifest.items.slice();
    } else {
      const activeVideos = catalog.videos
        .filter(v => !v.deleted)
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
          nextItems.push({
            ...uvEntry,
            videoId: v.id,
            videoIndex: v.index,
            videoSlug: v.slug,
            midi: Number.isFinite(s.manualMidi) ? Number(s.manualMidi) : Number(s.midi ?? uvEntry.midi ?? 60)
          });
        }
      }
      items = nextItems;
    }

    const prevMap = new Map();
    if (activeValues.length === items.length) {
      for (let i = 0; i < items.length; i++) {
        prevMap.set(items[i].sliceId, activeValues[i]);
      }
    }
    activeValues = new Float32Array(items.length);
    for (let i = 0; i < items.length; i++) {
      activeValues[i] = prevMap.get(items[i].sliceId) || 0;
    }
    vertexData = new Float32Array(items.length * 6 * 6);
    if (hoveredIdx >= items.length) hoveredIdx = -1;

    computeLayout();
    scheduleRender();
  }

  function buildVertexBuffer() {
    const N = items.length;
    if (N === 0) return;
    const { cols, cell, gap, originX, originY } = layout;
    const stride = cell + gap;

    let ptr = 0;
    for (let i = 0; i < N; i++) {
      const item = items[i];
      const col = i % cols;
      const row = (i / cols) | 0;
      const x0 = originX + col * stride;
      const y0 = originY + row * stride;
      const x1 = x0 + cell;
      const y1 = y0 + cell;

      const u0 = item.u0;
      const v0 = item.v0;
      const u1 = item.u1;
      const v1 = item.v1;
      const act = activeValues[i];
      const hov = i === hoveredIdx ? 1.0 : 0.0;

      // Tri 1: TL, TR, BL
      vertexData[ptr++] = x0; vertexData[ptr++] = y0; vertexData[ptr++] = u0; vertexData[ptr++] = v0; vertexData[ptr++] = act; vertexData[ptr++] = hov;
      vertexData[ptr++] = x1; vertexData[ptr++] = y0; vertexData[ptr++] = u1; vertexData[ptr++] = v0; vertexData[ptr++] = act; vertexData[ptr++] = hov;
      vertexData[ptr++] = x0; vertexData[ptr++] = y1; vertexData[ptr++] = u0; vertexData[ptr++] = v1; vertexData[ptr++] = act; vertexData[ptr++] = hov;

      // Tri 2: TR, BR, BL
      vertexData[ptr++] = x1; vertexData[ptr++] = y0; vertexData[ptr++] = u1; vertexData[ptr++] = v0; vertexData[ptr++] = act; vertexData[ptr++] = hov;
      vertexData[ptr++] = x1; vertexData[ptr++] = y1; vertexData[ptr++] = u1; vertexData[ptr++] = v1; vertexData[ptr++] = act; vertexData[ptr++] = hov;
      vertexData[ptr++] = x0; vertexData[ptr++] = y1; vertexData[ptr++] = u0; vertexData[ptr++] = v1; vertexData[ptr++] = act; vertexData[ptr++] = hov;
    }
  }

  function drawFrameWebGL() {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(3 / 255, 4 / 255, 6 / 255, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (!textureReady || items.length === 0) return;

    buildVertexBuffer();

    gl.useProgram(program);
    gl.uniform2f(uViewportLoc, cssW, cssH);
    gl.uniform3f(uBgColorLoc, 3 / 255, 4 / 255, 6 / 255);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.uniform1i(uAtlasLoc, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.DYNAMIC_DRAW);

    const FSIZE = 4;
    const STRIDE_BYTES = 6 * FSIZE;
    gl.enableVertexAttribArray(locPos);
    gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, STRIDE_BYTES, 0);

    gl.enableVertexAttribArray(locUv);
    gl.vertexAttribPointer(locUv, 2, gl.FLOAT, false, STRIDE_BYTES, 2 * FSIZE);

    gl.enableVertexAttribArray(locActive);
    gl.vertexAttribPointer(locActive, 1, gl.FLOAT, false, STRIDE_BYTES, 4 * FSIZE);

    gl.enableVertexAttribArray(locHover);
    gl.vertexAttribPointer(locHover, 1, gl.FLOAT, false, STRIDE_BYTES, 5 * FSIZE);

    gl.drawArrays(gl.TRIANGLES, 0, items.length * 6);
  }

  function drawFrameFallback2D() {
    if (!ctx2d) return;
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
    ctx2d.fillStyle = '#030406';
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);
    if (!atlasImage || !atlasManifest || items.length === 0) return;

    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { cols, cell, gap, originX, originY } = layout;
    const stride = cell + gap;
    const aw = atlasManifest.atlasWidth;
    const ah = atlasManifest.atlasHeight;

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
      const act = activeValues[i];
      if (act > 0.02) {
        ctx2d.filter = 'brightness(1.18)';
        ctx2d.globalAlpha = 1.0;
      } else {
        ctx2d.filter = 'grayscale(1)';
        ctx2d.globalAlpha = i === hoveredIdx ? 0.36 : 0.16;
      }
      ctx2d.drawImage(atlasImage, sx, sy, sw, sh, x, y, cell, cell);
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

    for (let i = 0; i < items.length; i++) {
      const target = activeSet.has(items[i].sliceId) ? 1.0 : 0.0;
      const cur = activeValues[i];
      if (Math.abs(target - cur) > 0.004) {
        const speed = target > cur ? dt / 0.065 : dt / 0.18;
        activeValues[i] = target > cur ? Math.min(1.0, cur + speed) : Math.max(0.0, cur - speed);
        if (Math.abs(target - activeValues[i]) > 0.004) {
          needsMoreFrames = true;
        }
      } else {
        activeValues[i] = target;
      }
    }

    if (gl) drawFrameWebGL();
    else drawFrameFallback2D();

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
    if (items.length === 0) return -1;
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
    return idx >= 0 && idx < items.length ? idx : -1;
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

  // Pointer interaction: hover + click + click-and-drag strumming across cells
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
      if (onSliceEnter) {
        onSliceEnter(item);
      }
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
            if (onSliceLeave) {
              onSliceLeave(activeDragSliceId, prevHeldSec, true);
            }
          }
          activeDragSliceId = nextItem.sliceId;
          activeDragStartedMs = performance.now();
          if (onSliceEnter) {
            onSliceEnter(nextItem);
          }
          scheduleRender();
        }
      } else if (activeDragSliceId !== null) {
        draggedAcrossMultiple = true;
        const prevHeldSec = Math.max(0, (performance.now() - activeDragStartedMs) / 1000);
        if (onSliceLeave) {
          onSliceLeave(activeDragSliceId, prevHeldSec, true);
        }
        activeDragSliceId = null;
        scheduleRender();
      }
    }
  });

  window.addEventListener('mouseup', () => {
    endActiveDrag();
  });

  window.addEventListener('blur', () => {
    endActiveDrag();
  });

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

      if (gl) {
        atlasTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, atlasTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }

      textureReady = true;
      rebuildItemsFromCatalog(initialCatalog);
    } catch (err) {
      console.warn('Could not load WebGL stage atlas:', err);
    }
  }

  return {
    loadAtlas,
    syncCatalog(catalog) {
      rebuildItemsFromCatalog(catalog);
    },
    resize() {
      computeLayout();
      scheduleRender();
    },
    notifyActivity() {
      scheduleRender();
    }
  };
}
