import { parseMidiFile } from './midi-parser.mjs';
import { createWebglStage } from './webgl-stage.mjs';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const CHROMATIC_COLORS = [
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
const PERC_NOTE_COLOR = '#8c95a4';

const ACCIDENTAL_SEMITONES = new Set([1, 3, 6, 8, 10]);
const MIN_MIDI = 24; // C1 (Start of 12-key Percussion Octave C1–B1; Tonal C2–G7 starts at 36)
const MAX_MIDI = 103; // G7

// Standard chromatic QWERTY layout (18 keys starting at baseOctaveMidi)
const QWERTY_MAP = [
  { code: 'KeyA', offset: 0 },
  { code: 'KeyW', offset: 1 },
  { code: 'KeyS', offset: 2 },
  { code: 'KeyE', offset: 3 },
  { code: 'KeyD', offset: 4 },
  { code: 'KeyF', offset: 5 },
  { code: 'KeyT', offset: 6 },
  { code: 'KeyG', offset: 7 },
  { code: 'KeyY', offset: 8 },
  { code: 'KeyH', offset: 9 },
  { code: 'KeyU', offset: 10 },
  { code: 'KeyJ', offset: 11 },
  { code: 'KeyK', offset: 12 },
  { code: 'KeyO', offset: 13 },
  { code: 'KeyL', offset: 14 },
  { code: 'KeyP', offset: 15 },
  { code: 'Semicolon', offset: 16 },
  { code: 'Quote', offset: 17 }
];

const MAX_CLIP_DUR = 2.50; // Universal hard cap on clip length (seconds)
const DEFAULT_UI_HOLD_SEC = 0.50; // Fixed simulated hold for mouse clicks & UI navigation

const state = {
  catalog: null,
  selectedMidi: 60, // Defaults to C4
  auditionIndex: 0,
  sampleDrawerOpen: false, // Collapsed by default for clean fullscreen stage + circle strip
  releaseSec: 0.40, // Permanent 0.40s universal release decay
  highpassHz: 80, // Permanent 80Hz master low-cut filter
  baseOctaveMidi: 60, // C4 (Z/X shifts QWERTY octave)
  sustainPedalDown: false,
  lastPlayedVideoId: null,
  lastPlayedSliceId: null,
  isStaticMode: false,
  assetBust: 0
};

// Track last-played slice per MIDI key for no-immediate-repeat randomization when 2+ clips are ON
const lastPlayedSliceByMidi = new Map();

function midiToName(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

function midiToShortLabel(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  if (pc === 0) return NOTE_NAMES[pc] + oct;
  return NOTE_NAMES[pc];
}

function getNoteColor(midi) {
  if (midi < 36) return PERC_NOTE_COLOR;
  const pc = ((midi % 12) + 12) % 12;
  return CHROMATIC_COLORS[pc];
}

function hexToRgb(hex) {
  const clean = String(hex || '#8c95a4').replace('#', '');
  const n = parseInt(clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function getNoteRgb(midi) {
  return hexToRgb(getNoteColor(midi));
}

function noteTintedSpecColor(norm, noteRgb) {
  const t = Math.max(0, Math.min(1, norm));
  if (t <= 0.015) return [3, 4, 6];

  const g = Math.pow(t, 1.12);
  const baseR = 3 + g * 232;
  const baseG = 4 + g * 231;
  const baseB = 6 + g * 230;

  if (t <= 0.40 || !noteRgb) {
    return [Math.round(baseR), Math.round(baseG), Math.round(baseB)];
  }

  const maxCh = Math.max(noteRgb[0], noteRgb[1], noteRgb[2], 1);
  const lift = 235 / maxCh;
  const tintR = Math.min(255, noteRgb[0] * lift * 0.82 + 45);
  const tintG = Math.min(255, noteRgb[1] * lift * 0.82 + 45);
  const tintB = Math.min(255, noteRgb[2] * lift * 0.82 + 45);

  const mix = Math.pow((t - 0.40) / 0.60, 1.25) * 0.30;
  return [
    Math.round(baseR * (1 - mix) + tintR * mix),
    Math.round(baseG * (1 - mix) + tintG * mix),
    Math.round(baseB * (1 - mix) + tintB * mix)
  ];
}

function midiToFreq(midi) {
  return (440 * Math.pow(2, (midi - 69) / 12)).toFixed(1);
}

function isPercussionSlice(video, slice) {
  return (
    video?.category === 'percussion' ||
    slice?.percBucket === 'kick' ||
    slice?.percBucket === 'snare' ||
    slice?.percBucket === 'hihat'
  );
}

// ============================================================================
// Web Audio Engine + Hold-to-Sustain / Key-Up Release Voice Manager
// ============================================================================
let audioCtx = null;
let masterBus = null;
let sampleHighpass = null;
const audioBufferCache = new Map();
const rawAudioBytesCache = new Map();

const activeVoices = new Map();
const sustainedVoicesPendingRelease = new Set();

function ensureAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextClass();

    const comp = audioCtx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.005;
    comp.release.value = 0.18;

    sampleHighpass = audioCtx.createBiquadFilter();
    sampleHighpass.type = 'highpass';
    sampleHighpass.frequency.value = state.highpassHz;
    sampleHighpass.Q.value = 0.707;

    sampleHighpass.connect(comp);
    comp.connect(audioCtx.destination);
    masterBus = comp;
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

function resolveAssetUrl(url) {
  if (!url) return url;
  if (/^(https?:|blob:|data:|\.)/.test(url)) return url;
  return url.startsWith('/') ? `.${url}` : `./${url}`;
}

function withBust(url) {
  const rel = resolveAssetUrl(url);
  if (!rel || !state.assetBust) return rel;
  return `${rel}${rel.includes('?') ? '&' : '?'}v=${state.assetBust}`;
}

async function prefetchRawAudioBytes(url) {
  const bustedUrl = withBust(url);
  if (!bustedUrl || audioBufferCache.has(bustedUrl) || rawAudioBytesCache.has(bustedUrl)) return;
  const p = fetch(bustedUrl)
    .then(r => (r.ok ? r.arrayBuffer() : null))
    .catch(() => null);
  rawAudioBytesCache.set(bustedUrl, p);
  await p;
}

async function loadAudioBuffer(url) {
  const bustedUrl = withBust(url);
  if (audioBufferCache.has(bustedUrl)) return audioBufferCache.get(bustedUrl);
  const ctx = ensureAudioContext();
  let arr = null;
  if (rawAudioBytesCache.has(bustedUrl)) {
    arr = await rawAudioBytesCache.get(bustedUrl);
    rawAudioBytesCache.delete(bustedUrl);
  }
  if (!arr) {
    const res = await fetch(bustedUrl);
    arr = await res.arrayBuffer();
  }
  const decoded = await ctx.decodeAudioData(arr);
  audioBufferCache.set(bustedUrl, decoded);
  return decoded;
}

// ============================================================================
// Fixed 3-Slot 1:1 Square Stage + Instant-Pop Tinted Spectrograms + f0 Stripe
// ============================================================================
const STAGE_SLOT_COUNT = 3;
const SPEC_MIN_FREQ = 45;
const SPEC_MAX_FREQ = 4200;
const SPEC_LOG_MIN = Math.log(SPEC_MIN_FREQ);
const SPEC_LOG_MAX = Math.log(SPEC_MAX_FREQ);

let stageSlotSeq = 0;
let currentStageTileSize = 290;
let currentMiniSpecH = 90;
let miniSpecAnimId = null;
let webglStage = null;
const miniSpecBitmapCache = new Map();

const stageSlots = [
  { occupied: false, seq: 0, token: null, sliceKey: null, videoEl: null, voice: null, miniBitmap: null },
  { occupied: false, seq: 0, token: null, sliceKey: null, videoEl: null, voice: null, miniBitmap: null },
  { occupied: false, seq: 0, token: null, sliceKey: null, videoEl: null, voice: null, miniBitmap: null }
];

function getActiveStageSliceIds() {
  const set = new Set();
  for (let i = 0; i < STAGE_SLOT_COUNT; i++) {
    if (stageSlots[i].occupied && stageSlots[i].sliceKey) {
      set.add(stageSlots[i].sliceKey);
    }
  }
  for (const v of activeVoices.values()) {
    if (!v.released && v.sliceKey) {
      set.add(v.sliceKey);
    }
  }
  return set;
}

function resolvePlayableSliceById(sliceId) {
  if (!sliceId || !state.catalog) return null;
  const keyMap = state.catalog.keyboardMap || {};
  for (const entry of Object.values(keyMap)) {
    const found = (entry.candidates || []).find(c => c.sliceId === sliceId);
    if (found) return found;
  }
  for (const v of state.catalog.videos || []) {
    if (v.deleted) continue;
    const s = (v.slices || []).find(sl => sl.id === sliceId && !sl.deleted);
    if (s) {
      const midi = Number.isFinite(s.manualMidi) ? Number(s.manualMidi) : Number(s.midi ?? 60);
      const rawDurSec = Math.min(MAX_CLIP_DUR, Number(s.rawDurSec ?? s.durSec ?? 1.8));
      const trimIn = Math.max(0, Number(s.trimIn ?? 0));
      const trimOut = Math.max(trimIn + 0.08, Math.min(rawDurSec, Number(s.trimOut ?? rawDurSec)));
      return {
        videoId: v.id,
        videoSlug: v.slug,
        sliceId: s.id,
        midi,
        playbackRate: 1.0,
        peakDb: s.peakDb ?? -20,
        videoUrl: s.videoUrl,
        audioUrl: s.audioUrl,
        rawDurSec,
        trimIn,
        trimOut,
        durSec: Math.max(0.08, trimOut - trimIn)
      };
    }
  }
  return null;
}

function updateStageTileSizes() {
  const stageEl = document.getElementById('videoStage');
  const grid = document.getElementById('polyVideoGrid');
  if (!stageEl || !grid) return;

  const gap = 24;
  const padX = Math.max(112, Math.round(stageEl.clientWidth * 0.14));
  const padY = Math.max(76, Math.round(stageEl.clientHeight * 0.12));
  const dotsRowAndGap = 58; // 36px lowered dots row + 22px gap below spectrograms

  const availW = Math.max(270, stageEl.clientWidth - padX - gap * (STAGE_SLOT_COUNT - 1));
  const availHForSlotUnit = Math.max(160, stageEl.clientHeight - padY - dotsRowAndGap);
  // Each slot unit height = side + 7 + 0.31 * side = 1.31 * side + 7
  const maxSideByH = Math.floor((availHForSlotUnit - 7) / 1.31);
  const side = Math.max(104, Math.floor(Math.min(maxSideByH, availW / STAGE_SLOT_COUNT)));
  const specH = Math.max(68, Math.round(side * 0.31)); // ~60% taller spectrogram
  const stripW = side * STAGE_SLOT_COUNT + gap * (STAGE_SLOT_COUNT - 1);
  const dotSize = Number(Math.max(6.2, Math.min(11.2, ((stripW - 11) / 80) * 0.74)).toFixed(2));

  currentStageTileSize = side;
  currentMiniSpecH = specH;

  stageEl.style.setProperty('--tile-size', `${side}px`);
  stageEl.style.setProperty('--spec-height', `${specH}px`);
  stageEl.style.setProperty('--strip-width', `${stripW}px`);
  stageEl.style.setProperty('--dot-size', `${dotSize}px`);

  webglStage?.resize();
}

window.addEventListener('resize', updateStageTileSizes);

function setSampleDrawerOpen(nextOpen) {
  const isOpen = Boolean(nextOpen);
  state.sampleDrawerOpen = isOpen;
  document.body.classList.toggle('settings-open', isOpen);

  const drawerEl = document.getElementById('sampleDrawer');
  const toggleBtn = document.getElementById('sampleDrawerToggleBtn');
  if (drawerEl) {
    drawerEl.classList.toggle('collapsed', !isOpen);
  }
  if (toggleBtn) {
    toggleBtn.classList.toggle('is-open', isOpen);
    toggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  }
  if (isOpen) {
    selectKeyForConfig(state.selectedMidi, false);
  }
}

function getSliceIdentityKey(slice) {
  return String(slice?.sliceId || slice?.id || slice?.videoUrl || '');
}

function allocateStageSlotIndex(sliceKey) {
  // 1. If this exact video clip is already occupying a slot, steal that slot!
  if (sliceKey) {
    for (let i = 0; i < STAGE_SLOT_COUNT; i++) {
      if (stageSlots[i].occupied && stageSlots[i].sliceKey === sliceKey) {
        return i;
      }
    }
  }
  // 2. Otherwise occupy the next open slot from left to right (0 -> 1 -> 2)
  for (let i = 0; i < STAGE_SLOT_COUNT; i++) {
    if (!stageSlots[i].occupied) return i;
  }
  // 3. Prefer stealing a slot whose clip has already finished playback and is only
  //    sitting frozen on its last frame because a key/MIDI note is still held down
  let oldestFrozenIdx = -1;
  for (let i = 0; i < STAGE_SLOT_COUNT; i++) {
    if (stageSlots[i].voice?.audioCompleted) {
      if (oldestFrozenIdx === -1 || stageSlots[i].seq < stageSlots[oldestFrozenIdx].seq) {
        oldestFrozenIdx = i;
      }
    }
  }
  if (oldestFrozenIdx !== -1) return oldestFrozenIdx;

  // 4. All 3 slots are actively mid-playback: steal the oldest active slot
  let oldestIdx = 0;
  for (let i = 1; i < STAGE_SLOT_COUNT; i++) {
    if (stageSlots[i].seq < stageSlots[oldestIdx].seq) {
      oldestIdx = i;
    }
  }
  return oldestIdx;
}

function clearSlotMiniSpec(slotIdx) {
  const grid = document.getElementById('polyVideoGrid');
  const canvas = grid?.querySelector(`.stage-slot-unit[data-slot="${slotIdx}"] .slot-mini-spec`);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function displaceStageSlotVoice(prevVoice, isSameClip = false) {
  if (!prevVoice) return;
  if (prevVoice.removeTimer) {
    clearTimeout(prevVoice.removeTimer);
    prevVoice.removeTimer = null;
  }
  if (prevVoice.naturalTimer) {
    clearTimeout(prevVoice.naturalTimer);
    prevVoice.naturalTimer = null;
  }
  if (prevVoice.gateTimer) {
    clearTimeout(prevVoice.gateTimer);
    prevVoice.gateTimer = null;
  }

  prevVoice.released = true;
  prevVoice.tileObj = null;

  if (prevVoice.triggerId) {
    if (activeVoices.get(prevVoice.triggerId) === prevVoice) {
      activeVoices.delete(prevVoice.triggerId);
    }
    sustainedVoicesPendingRelease.delete(prevVoice.triggerId);
  }
  if (prevVoice.midi !== null && !isMidiStillHeld(prevVoice.midi)) {
    setKeyActiveClass(prevVoice.midi, false);
  }

  if (!prevVoice.audioCompleted && prevVoice.gainNode && prevVoice.src && audioCtx) {
    const now = audioCtx.currentTime;
    const elapsed = prevVoice.startedAt ? Math.max(0, now - prevVoice.startedAt) : 0;
    const curVal = computeScheduledVoiceGainAt(prevVoice, elapsed);
    const fadeSec = isSameClip ? 0.016 : 0.18;
    try {
      prevVoice.gainNode.gain.cancelScheduledValues(now);
      prevVoice.gainNode.gain.setValueAtTime(Math.max(0.0001, curVal), now);
      prevVoice.gainNode.gain.linearRampToValueAtTime(0.0001, now + fadeSec);
      prevVoice.src.stop(now + fadeSec + 0.01);
    } catch {}
  }
  webglStage?.notifyActivity();
}

function createStageSquareTile(slice, playbackRate = 1.0) {
  const grid = document.getElementById('polyVideoGrid');
  if (!grid) return null;

  const sliceKey = getSliceIdentityKey(slice);
  const slotIdx = allocateStageSlotIndex(sliceKey);
  const unitEl = grid.querySelector(`.stage-slot-unit[data-slot="${slotIdx}"]`);
  const videoWrap = unitEl?.querySelector('.stage-slot-video');
  if (!unitEl || !videoWrap) return null;

  const prevSlot = stageSlots[slotIdx];
  if (prevSlot.occupied && prevSlot.voice) {
    displaceStageSlotVoice(prevSlot.voice, prevSlot.sliceKey === sliceKey);
  }

  if (prevSlot.videoEl) {
    try {
      prevSlot.videoEl.pause();
    } catch {}
  }
  videoWrap.innerHTML = '';
  clearSlotMiniSpec(slotIdx);

  const token = Symbol(`slot_${slotIdx}`);
  stageSlotSeq += 1;

  const videoEl = document.createElement('video');
  videoEl.src = withBust(slice.videoUrl);
  videoEl.muted = true;
  videoEl.playsInline = true;
  videoEl.addEventListener('ended', () => {
    try {
      videoEl.pause();
    } catch {}
  });
  videoWrap.appendChild(videoEl);
  unitEl.classList.add('is-occupied');

  stageSlots[slotIdx] = {
    occupied: true,
    seq: stageSlotSeq,
    token,
    sliceKey,
    videoEl,
    voice: null,
    miniBitmap: null
  };

  videoEl.playbackRate = Math.max(0.5, Math.min(2.0, playbackRate));
  videoEl.currentTime = Math.max(0, Number(slice.trimIn ?? 0));
  videoEl.play().catch(() => {});

  webglStage?.notifyActivity();

  return { slotIdx, token, tile: videoWrap, videoEl };
}

function removeStageTile(tileObj) {
  if (!tileObj || tileObj.slotIdx === undefined) return;
  const { slotIdx, token } = tileObj;
  const slotState = stageSlots[slotIdx];
  if (!slotState || slotState.token !== token) return;

  try {
    tileObj.videoEl?.pause();
  } catch {}

  const grid = document.getElementById('polyVideoGrid');
  const unitEl = grid?.querySelector(`.stage-slot-unit[data-slot="${slotIdx}"]`);
  const videoWrap = unitEl?.querySelector('.stage-slot-video');
  if (videoWrap) {
    videoWrap.innerHTML = '';
  }
  unitEl?.classList.remove('is-occupied');
  clearSlotMiniSpec(slotIdx);

  stageSlots[slotIdx] = {
    occupied: false,
    seq: 0,
    token: null,
    sliceKey: null,
    videoEl: null,
    voice: null,
    miniBitmap: null
  };

  webglStage?.notifyActivity();
}

function buildMiniSpectrogramBitmap(buffer, playbackRate = 1.0, trimIn = 0, bufferSpanSec = null, noteRgb = null) {
  const W = 256;
  const H = 104;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');

  const ch = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const effectiveSr = sr * playbackRate;

  const s0 = Math.max(0, Math.min(ch.length - 1, Math.floor(trimIn * sr)));
  const spanSamples = bufferSpanSec
    ? Math.max(fftSizeSpec, Math.floor(bufferSpanSec * sr))
    : Math.max(fftSizeSpec, ch.length - s0);
  const sEnd = Math.min(ch.length, s0 + spanSamples);
  const usableSpan = Math.max(1, sEnd - s0 - fftSizeSpec);

  const imgData = ctx.createImageData(W, H);
  const data = imgData.data;

  const real = new Float32Array(fftSizeSpec);
  const imag = new Float32Array(fftSizeSpec);
  const half = fftSizeSpec >> 1;
  const colMags = new Array(W);
  let globalMaxDb = -90;

  for (let x = 0; x < W; x++) {
    const startSample = s0 + Math.floor((x / W) * usableSpan);
    for (let i = 0; i < fftSizeSpec; i++) {
      real[i] = (ch[startSample + i] || 0) * hannSpec[i];
      imag[i] = 0;
    }
    fftInPlaceClient(real, imag);
    const dbArr = new Float32Array(half);
    for (let k = 1; k < half; k++) {
      const db = 20 * Math.log10(Math.hypot(real[k], imag[k]) + 1e-7);
      dbArr[k] = db;
      if (db > globalMaxDb) globalMaxDb = db;
    }
    colMags[x] = dbArr;
  }

  const floorDb = globalMaxDb - 54;
  for (let x = 0; x < W; x++) {
    const dbArr = colMags[x];
    for (let y = 0; y < H; y++) {
      const normY = 1 - y / (H - 1);
      const freq = Math.exp(SPEC_LOG_MIN + normY * (SPEC_LOG_MAX - SPEC_LOG_MIN));
      const exactBin = (freq * fftSizeSpec) / effectiveSr;
      const b0 = Math.max(1, Math.min(half - 2, Math.floor(exactBin)));
      const frac = exactBin - b0;
      const db = dbArr[b0] * (1 - frac) + dbArr[b0 + 1] * frac;
      const norm = (db - floorDb) / (globalMaxDb - floorDb + 1e-5);
      const [r, g, b] = noteTintedSpecColor(norm, noteRgb);
      const idx = (y * W + x) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
  return c;
}

function computeVoiceStripeAlpha(voice, now) {
  if (!voice) return 0;
  // Early user release
  if (voice.releaseStartCtxTime !== null) {
    const dt = Math.max(0, now - voice.releaseStartCtxTime);
    const rel = Math.max(0.025, voice.releaseDur || state.releaseSec);
    return Math.max(0, Math.min(1, 1 - dt / rel));
  }
  // Automatic forced end-of-clip release
  const elapsed = Math.max(0, now - voice.startedAt);
  const fStart = voice.forcedReleaseStartOffset ?? Math.max(0.012, voice.naturalDur - state.releaseSec);
  if (elapsed <= fStart) return 1;
  const fDur = Math.max(0.025, voice.forcedReleaseDur || state.releaseSec);
  return Math.max(0, Math.min(1, 1 - (elapsed - fStart) / fDur));
}

function drawSlotMiniSpecFrame(slotIdx, now) {
  const slot = stageSlots[slotIdx];
  if (!slot?.occupied || !slot.voice || !slot.miniBitmap) return;
  const grid = document.getElementById('polyVideoGrid');
  const canvas = grid?.querySelector(`.stage-slot-unit[data-slot="${slotIdx}"] .slot-mini-spec`);
  if (!canvas) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = currentStageTileSize;
  const cssH = currentMiniSpecH;
  const targetW = Math.round(cssW * dpr);
  const targetH = Math.round(cssH * dpr);

  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Full spectrogram pops in immediately and stays 100% visible until hard-cut with the video
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(slot.miniBitmap, 0, 0, cssW, cssH);

  if (slot.voice.isPerc) {
    // Percussive sound: no horizontal f0 line; thin 50% white vertical playhead synced to playback speed
    const elapsed = Math.max(0, now - slot.voice.startedAt);
    const progress = Math.max(0, Math.min(1, elapsed / Math.max(0.05, slot.voice.naturalDur)));
    const xPos = progress * (cssW - 1);
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(xPos, 0);
    ctx.lineTo(xPos, cssH);
    ctx.stroke();
    ctx.restore();
  } else {
    // Tonal sound: thin solid horizontal fundamental frequency stripe matching note color, fading out on release
    const f0Hz = slot.voice.f0Hz;
    const stripeAlpha = computeVoiceStripeAlpha(slot.voice, now);
    if (stripeAlpha > 0.005 && f0Hz >= SPEC_MIN_FREQ && f0Hz <= SPEC_MAX_FREQ) {
      const normY = (Math.log(f0Hz) - SPEC_LOG_MIN) / (SPEC_LOG_MAX - SPEC_LOG_MIN);
      const yF0 = (1 - normY) * (cssH - 1);
      ctx.save();
      ctx.globalAlpha = stripeAlpha;
      ctx.strokeStyle = slot.voice.noteColor || '#ffffff';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(0, yF0);
      ctx.lineTo(cssW, yF0);
      ctx.stroke();
      ctx.restore();
    }
  }
}

function attachSlotMiniSpectrogram(tileObj, slice, buffer, voice) {
  if (!tileObj || tileObj.slotIdx === undefined) return;
  const slotState = stageSlots[tileObj.slotIdx];
  if (!slotState || slotState.token !== tileObj.token) return;

  const rate = voice ? voice.playbackRate : 1.0;
  const tIn = voice?.trimIn ?? 0;
  const bSpan = voice?.bufferPlaySpan ?? Math.min(MAX_CLIP_DUR, buffer.duration);
  const midiTag = voice?.midi ?? 60;
  const noteRgb = voice?.isPerc ? null : getNoteRgb(midiTag);
  const cacheKey = `${slice.audioUrl}__m${midiTag}__${rate.toFixed(4)}__${tIn.toFixed(2)}__${bSpan.toFixed(2)}`;
  let bmp = miniSpecBitmapCache.get(cacheKey);
  if (!bmp) {
    bmp = buildMiniSpectrogramBitmap(buffer, rate, tIn, bSpan, noteRgb);
    miniSpecBitmapCache.set(cacheKey, bmp);
  }

  slotState.voice = voice;
  slotState.miniBitmap = bmp;

  // Render full spectrogram + f0 stripe immediately on this exact frame
  if (audioCtx) {
    drawSlotMiniSpecFrame(tileObj.slotIdx, audioCtx.currentTime);
  }
  ensureMiniSpecAnimLoop();
}

function ensureMiniSpecAnimLoop() {
  if (miniSpecAnimId) return;

  const tick = () => {
    if (!audioCtx) {
      miniSpecAnimId = null;
      return;
    }

    const now = audioCtx.currentTime;
    let anyActive = false;

    for (let i = 0; i < STAGE_SLOT_COUNT; i++) {
      const slot = stageSlots[i];
      if (!slot.occupied || !slot.voice || !slot.miniBitmap) continue;
      drawSlotMiniSpecFrame(i, now);
      if (!slot.voice.audioCompleted) {
        anyActive = true;
      }
    }

    if (anyActive) {
      miniSpecAnimId = requestAnimationFrame(tick);
    } else {
      miniSpecAnimId = null;
    }
  };

  miniSpecAnimId = requestAnimationFrame(tick);
}

function computeScheduledVoiceGainAt(voice, elapsedSec) {
  const pk = voice.peakGain || 0.85;
  if (elapsedSec <= 0) return 0.0002;
  if (elapsedSec < 0.006) return Math.max(0.0002, pk * (elapsedSec / 0.006));
  const fStart = voice.forcedReleaseStartOffset ?? Math.max(0.012, (voice.naturalDur || 1.0) - 0.4);
  if (elapsedSec <= fStart) return pk;
  const fDur = Math.max(0.02, voice.forcedReleaseDur || 0.4);
  const u = Math.max(0, Math.min(1, (elapsedSec - fStart) / fDur));
  if (u <= 0.35) {
    return pk * (1 - (u / 0.35) * (1 - 0.56));
  }
  if (u <= 0.72) {
    return pk * (0.56 - ((u - 0.35) / 0.37) * (0.56 - 0.18));
  }
  return Math.max(0.0002, pk * 0.18 * (1 - (u - 0.72) / 0.28));
}

async function startHeldVoice({
  triggerId,
  midi = null,
  slice = null,
  playbackRate = 1.0,
  velocity = 0.92
}) {
  if (activeVoices.has(triggerId)) {
    releaseHeldVoice(triggerId, 0.06);
  }

  const ctx = ensureAudioContext();
  if (midi !== null) setKeyActiveClass(midi, true);

  if (!slice) {
    if (midi !== null) {
      setTimeout(() => {
        if (!isMidiStillHeld(midi)) setKeyActiveClass(midi, false);
      }, 120);
    }
    return;
  }

  const estSpan = Math.min(MAX_CLIP_DUR, Number(slice.durSec || 1.8));
  const estPlayDur = Math.min(MAX_CLIP_DUR, estSpan / playbackRate);
  const effMidi = midi ?? slice.midi ?? 60;
  const isPerc = effMidi < 36;
  const f0Hz = isPerc ? null : 440 * Math.pow(2, (effMidi - 69) / 12);

  const voice = {
    triggerId,
    midi,
    isPerc,
    slice,
    sliceKey: getSliceIdentityKey(slice),
    playbackRate,
    tileObj: null,
    src: null,
    gainNode: null,
    peakGain: 0.85,
    trimIn: Math.max(0, Number(slice.trimIn ?? 0)),
    bufferPlaySpan: estSpan,
    startedAt: ctx.currentTime,
    naturalDur: estPlayDur,
    forcedReleaseStartOffset: Math.max(0.012, estPlayDur - Math.min(state.releaseSec, estPlayDur * 0.78)),
    forcedReleaseDur: Math.min(state.releaseSec, estPlayDur * 0.78),
    f0Hz,
    noteColor: getNoteColor(effMidi),
    naturalTimer: null,
    gateTimer: null,
    removeTimer: null,
    audioCompleted: false,
    released: false,
    releaseStartCtxTime: null,
    releaseDur: state.releaseSec
  };
  activeVoices.set(triggerId, voice);
  webglStage?.notifyActivity();

  try {
    const buffer = await loadAudioBuffer(slice.audioUrl);
    const tileObj = createStageSquareTile(slice, playbackRate);
    voice.tileObj = tileObj;

    const now = ctx.currentTime;
    const dbOffset = slice.peakDb !== undefined ? Math.max(0, Math.min(8, (-22 - slice.peakDb) * 0.35)) : 0;
    const boost = Math.pow(10, dbOffset / 20);
    const peakGain = Math.min(1.25, 0.86 * velocity * boost);

    const rawLimit = Math.min(MAX_CLIP_DUR, Number(slice.rawDurSec ?? buffer.duration), buffer.duration);
    const trimIn = Math.max(0, Math.min(Math.max(0, rawLimit - 0.08), Number(slice.trimIn ?? 0)));
    const trimOut = Math.max(trimIn + 0.08, Math.min(rawLimit, Number(slice.trimOut ?? rawLimit)));
    const unpitchedSpan = Math.max(0.08, trimOut - trimIn);

    // Universal 2.50s cap on real-time playback duration
    const playDur = Math.min(MAX_CLIP_DUR, unpitchedSpan / playbackRate);
    const bufferPlaySpan = Math.min(buffer.duration - trimIn, playDur * playbackRate);

    // Universal forced end-of-clip release decay (default 0.40s) so clip ALWAYS decays cleanly before its end
    const forcedRelDur = Math.min(state.releaseSec, playDur * 0.78);
    const forcedRelStart = Math.max(0.012, playDur - forcedRelDur);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.setValueAtTime(playbackRate, now);

    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.linearRampToValueAtTime(peakGain, now + 0.006);
    gainNode.gain.setValueAtTime(peakGain, now + forcedRelStart);
    gainNode.gain.linearRampToValueAtTime(peakGain * 0.56, now + forcedRelStart + forcedRelDur * 0.35);
    gainNode.gain.linearRampToValueAtTime(peakGain * 0.18, now + forcedRelStart + forcedRelDur * 0.72);
    gainNode.gain.linearRampToValueAtTime(0.0001, now + playDur);

    src.connect(gainNode);
    gainNode.connect(sampleHighpass);
    src.start(now, trimIn, bufferPlaySpan + 0.015);

    voice.src = src;
    voice.gainNode = gainNode;
    voice.peakGain = peakGain;
    voice.trimIn = trimIn;
    voice.bufferPlaySpan = bufferPlaySpan;
    voice.startedAt = now;
    voice.naturalDur = playDur;
    voice.forcedReleaseStartOffset = forcedRelStart;
    voice.forcedReleaseDur = forcedRelDur;

    attachSlotMiniSpectrogram(tileObj, slice, buffer, voice);

    if (voice.released) {
      applyVoiceReleaseRamp(voice, voice.releaseDur);
    } else {
      voice.naturalTimer = setTimeout(() => {
        voice.naturalTimer = null;
        if (!voice.released) {
          // Key / MIDI note is still held down after clip finishes:
          // stay frozen on the last frame in silence with the spectrogram visible until key-up (or slot steal)!
          voice.audioCompleted = true;
          const vid = voice.tileObj?.videoEl;
          if (vid) {
            try {
              vid.pause();
              const targetEnd = Math.max(trimIn, trimOut - 0.02);
              if (Number.isFinite(vid.duration) && vid.duration > 0) {
                vid.currentTime = Math.min(Math.max(0, vid.duration - 0.02), targetEnd);
              } else {
                vid.currentTime = targetEnd;
              }
            } catch {}
          }
          if (voice.tileObj && audioCtx) {
            drawSlotMiniSpecFrame(voice.tileObj.slotIdx, audioCtx.currentTime);
          }
        }
      }, Math.max(60, Math.round(playDur * 1000)));
    }
  } catch (err) {
    console.warn('Error starting voice:', err);
    if (voice.tileObj) removeStageTile(voice.tileObj);
    activeVoices.delete(triggerId);
    webglStage?.notifyActivity();
  }
}

function applyVoiceReleaseRamp(voice, customReleaseSec = null) {
  const ctx = ensureAudioContext();
  const now = ctx.currentTime;

  if (voice.gateTimer) {
    clearTimeout(voice.gateTimer);
    voice.gateTimer = null;
  }
  if (voice.naturalTimer) {
    clearTimeout(voice.naturalTimer);
    voice.naturalTimer = null;
  }
  if (voice.removeTimer) {
    clearTimeout(voice.removeTimer);
    voice.removeTimer = null;
  }

  voice.released = true;

  // If the clip already finished playing in silence while frozen on its last frame,
  // clear the frozen frame & spectrogram immediately on key-up!
  if (voice.audioCompleted || (voice.startedAt && voice.naturalDur && now - voice.startedAt >= voice.naturalDur)) {
    voice.audioCompleted = true;
    voice.releaseStartCtxTime = now;
    voice.releaseDur = 0;
    if (voice.tileObj) {
      removeStageTile(voice.tileObj);
    }
    return;
  }

  const requestedRel = customReleaseSec ?? state.releaseSec;
  const elapsed = voice.startedAt ? Math.max(0, now - voice.startedAt) : 0;
  const remainingNatural = voice.naturalDur ? Math.max(0.02, voice.naturalDur - elapsed) : requestedRel;
  const rel = Math.min(requestedRel, remainingNatural);

  voice.releaseStartCtxTime = now;
  voice.releaseDur = rel;

  if (voice.gainNode && voice.src) {
    const g = voice.gainNode.gain;
    const curVal = computeScheduledVoiceGainAt(voice, elapsed);
    g.cancelScheduledValues(now);
    g.setValueAtTime(curVal, now);
    g.linearRampToValueAtTime(curVal * 0.56, now + rel * 0.35);
    g.linearRampToValueAtTime(curVal * 0.18, now + rel * 0.72);
    g.linearRampToValueAtTime(0.0001, now + rel);
    try {
      voice.src.stop(now + rel + 0.015);
    } catch {}
  }

  if (voice.tileObj?.tile) {
    voice.removeTimer = setTimeout(() => {
      removeStageTile(voice.tileObj);
    }, Math.round(rel * 1000));
  }
}

function releaseHeldVoice(triggerId, customReleaseSec = null) {
  const voice = activeVoices.get(triggerId);
  if (!voice) return;

  if (state.sustainPedalDown && triggerId.startsWith('midi_')) {
    sustainedVoicesPendingRelease.add(triggerId);
    return;
  }

  activeVoices.delete(triggerId);
  if (voice.midi !== null && !isMidiStillHeld(voice.midi)) {
    setKeyActiveClass(voice.midi, false);
  }
  applyVoiceReleaseRamp(voice, customReleaseSec);
}

function isMidiStillHeld(midi) {
  for (const v of activeVoices.values()) {
    if (v.midi === midi && !v.released) return true;
  }
  return false;
}

function setKeyActiveClass(midi, active) {
  const el = document.querySelector(`.key-cell[data-midi="${midi}"]`);
  if (el) el.classList.toggle('active-play', active);
}

// ============================================================================
// Spectrogram FFT & Offscreen Renderer
// ============================================================================
const fftSizeSpec = 1024;
const hannSpec = new Float32Array(fftSizeSpec);
for (let i = 0; i < fftSizeSpec; i++) {
  hannSpec[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSizeSpec - 1)));
}

function fftInPlaceClient(real, imag) {
  const n = real.length;
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (i < j) {
      let tr = real[i]; real[i] = real[j]; real[j] = tr;
      let ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
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
      let wr = 1.0, wi = 0.0;
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

function magmaColor(norm) {
  const t = Math.max(0, Math.min(1, norm));
  if (t < 0.25) {
    const u = t / 0.25;
    return [Math.round(6 + u * 45), Math.round(8 + u * 14), Math.round(14 + u * 75)];
  } else if (t < 0.55) {
    const u = (t - 0.25) / 0.30;
    return [Math.round(51 + u * 135), Math.round(22 + u * 35), Math.round(89 + u * 35)];
  } else if (t < 0.82) {
    const u = (t - 0.55) / 0.27;
    return [Math.round(186 + u * 62), Math.round(57 + u * 115), Math.round(124 - u * 70)];
  } else {
    const u = (t - 0.82) / 0.18;
    return [250, Math.round(172 + u * 80), Math.round(54 + u * 165)];
  }
}

const spectrogramBitmapCache = new Map();

function buildSpectrogramOffscreen(
  buffer,
  f0Hz,
  f0Label,
  cssW = 520,
  cssH = 148,
  dpr = 1,
  playbackRate = 1.0,
  showHarmonics = true
) {
  const W = Math.max(200, Math.round(cssW));
  const H = Math.max(90, Math.round(cssH));

  const stftCanvas = document.createElement('canvas');
  stftCanvas.width = W;
  stftCanvas.height = H;
  const stftCtx = stftCanvas.getContext('2d');

  const ch = buffer.getChannelData(0);
  const effectiveSr = buffer.sampleRate * playbackRate;
  const minFreq = 55;
  const maxFreq = 4200;
  const logMin = Math.log(minFreq);
  const logMax = Math.log(maxFreq);

  const imgData = stftCtx.createImageData(W, H);
  const data = imgData.data;

  const real = new Float32Array(fftSizeSpec);
  const imag = new Float32Array(fftSizeSpec);
  const half = fftSizeSpec >> 1;
  const colMags = new Array(W);
  let globalMaxDb = -90;

  const maxSamples = Math.min(ch.length, Math.floor(MAX_CLIP_DUR * buffer.sampleRate));

  for (let x = 0; x < W; x++) {
    const startSample = Math.floor((x / W) * Math.max(1, maxSamples - fftSizeSpec));
    for (let i = 0; i < fftSizeSpec; i++) {
      real[i] = (ch[startSample + i] || 0) * hannSpec[i];
      imag[i] = 0;
    }
    fftInPlaceClient(real, imag);
    const dbArr = new Float32Array(half);
    for (let k = 1; k < half; k++) {
      const db = 20 * Math.log10(Math.hypot(real[k], imag[k]) + 1e-7);
      dbArr[k] = db;
      if (db > globalMaxDb) globalMaxDb = db;
    }
    colMags[x] = dbArr;
  }

  const floorDb = globalMaxDb - 58;
  for (let x = 0; x < W; x++) {
    const dbArr = colMags[x];
    for (let y = 0; y < H; y++) {
      const normY = 1 - y / (H - 1);
      const freq = Math.exp(logMin + normY * (logMax - logMin));
      const exactBin = (freq * fftSizeSpec) / effectiveSr;
      const b0 = Math.max(1, Math.min(half - 2, Math.floor(exactBin)));
      const frac = exactBin - b0;
      const db = dbArr[b0] * (1 - frac) + dbArr[b0 + 1] * frac;
      const norm = (db - floorDb) / (globalMaxDb - floorDb + 1e-5);
      const [r, g, b] = magmaColor(norm);
      const idx = (y * W + x) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }
  stftCtx.putImageData(imgData, 0, 0);

  const offCanvas = document.createElement('canvas');
  offCanvas.width = Math.round(W * dpr);
  offCanvas.height = Math.round(H * dpr);
  const ctx = offCanvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(stftCanvas, 0, 0, W, H);

  const gridFreqs = [80, 200, 440, 1000, 2000, 3500];
  ctx.font = '10px "SF Mono", Menlo, monospace';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 1;

  for (const gf of gridFreqs) {
    const y = H - 1 - ((Math.log(gf) - logMin) / (logMax - logMin)) * (H - 1);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
    ctx.fillText(`${gf}Hz`, 5, Math.max(9, y - 2));
  }

  if (showHarmonics && f0Hz >= minFreq && f0Hz <= maxFreq) {
    const yF0 = H - 1 - ((Math.log(f0Hz) - logMin) / (logMax - logMin)) * (H - 1);
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    ctx.moveTo(0, yF0);
    ctx.lineTo(W, yF0);
    ctx.stroke();

    const tagText = `f0: ${f0Label} (${f0Hz}Hz)`;
    ctx.font = 'bold 10px "SF Mono", Menlo, monospace';
    const tagW = Math.ceil(ctx.measureText(tagText).width) + 10;
    ctx.fillStyle = '#10b981';
    ctx.fillRect(W - tagW - 5, Math.max(2, yF0 - 15), tagW, 14);
    ctx.fillStyle = '#04130d';
    ctx.fillText(tagText, W - tagW, Math.max(12, yF0 - 4));

    ctx.strokeStyle = 'rgba(245, 158, 11, 0.72)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    for (let h = 2; h <= 4; h++) {
      const hf = f0Hz * h;
      if (hf <= maxFreq) {
        const yh = H - 1 - ((Math.log(hf) - logMin) / (logMax - logMin)) * (H - 1);
        ctx.beginPath();
        ctx.moveTo(0, yh);
        ctx.lineTo(W, yh);
        ctx.stroke();
        ctx.fillStyle = '#fbbf24';
        ctx.fillText(`${h}f0`, W - 26, Math.max(9, yh - 2));
      }
    }
    ctx.setLineDash([]);
  }

  return offCanvas;
}

// ============================================================================
// Piano Key & Multi-Candidate Sequential Round-Robin Trigger Helpers
// ============================================================================
function pickEnabledCandidateForMidi(midi, entry) {
  const enabledCands = (entry?.candidates || []).filter(c => c.enabled);
  if (enabledCands.length === 0) return null;
  if (enabledCands.length === 1) {
    lastPlayedSliceByMidi.set(midi, enabledCands[0].sliceId);
    return enabledCands[0];
  }
  const lastId = lastPlayedSliceByMidi.get(midi);
  const lastIdx = lastId ? enabledCands.findIndex(c => c.sliceId === lastId) : -1;
  const nextIdx = (lastIdx + 1) % enabledCands.length;
  const chosen = enabledCands[nextIdx];
  lastPlayedSliceByMidi.set(midi, chosen.sliceId);
  return chosen;
}

function startPianoKeyHold(triggerId, midi, velocity = 0.92, selectInDeck = true) {
  if (midi < MIN_MIDI || midi > MAX_MIDI) return;
  if (selectInDeck && state.selectedMidi !== midi) {
    selectKeyForConfig(midi, false);
  }

  const entry = state.catalog?.keyboardMap?.[midi];
  const cand = pickEnabledCandidateForMidi(midi, entry);
  if (!cand) {
    startHeldVoice({ triggerId, midi, slice: null, velocity });
    return;
  }

  state.lastPlayedVideoId = cand.videoId;
  state.lastPlayedSliceId = cand.sliceId;

  startHeldVoice({
    triggerId,
    midi,
    slice: cand,
    playbackRate: cand.playbackRate || 1.0,
    velocity
  });
}

function startCandidateHold(triggerId, midi, cand, idx = 0) {
  state.auditionIndex = idx;
  state.lastPlayedVideoId = cand.videoId;
  state.lastPlayedSliceId = cand.sliceId;
  if (cand.enabled) {
    lastPlayedSliceByMidi.set(midi, cand.sliceId);
  }

  document.querySelectorAll('.candidate-card').forEach((el, i) => {
    el.classList.toggle('audition-focus', i === idx);
  });

  startHeldVoice({
    triggerId,
    midi,
    slice: cand,
    playbackRate: cand.playbackRate || 1.0,
    velocity: 0.94
  });
}

function scheduleDefaultVoiceGate(triggerId, holdSec = DEFAULT_UI_HOLD_SEC) {
  const voice = activeVoices.get(triggerId);
  if (!voice) return;
  if (voice.gateTimer) clearTimeout(voice.gateTimer);
  voice.gateTimer = setTimeout(() => {
    if (activeVoices.get(triggerId) === voice) {
      releaseHeldVoice(triggerId);
    }
  }, Math.round(holdSec * 1000));
}

function triggerDefaultPianoGate(triggerId, midi, velocity = 0.92, selectInDeck = true) {
  startPianoKeyHold(triggerId, midi, velocity, selectInDeck);
  scheduleDefaultVoiceGate(triggerId, DEFAULT_UI_HOLD_SEC);
}

function triggerDefaultCandidateGate(triggerId, midi, cand, idx = 0) {
  startCandidateHold(triggerId, midi, cand, idx);
  scheduleDefaultVoiceGate(triggerId, DEFAULT_UI_HOLD_SEC);
}

function selectKeyForConfig(midi, shouldTapPreview = false) {
  const clamped = Math.max(MIN_MIDI, Math.min(MAX_MIDI, midi));
  state.selectedMidi = clamped;

  const entry = state.catalog?.keyboardMap?.[clamped];
  if (entry && entry.candidates?.length) {
    const firstEnabledIdx = entry.candidates.findIndex(c => c.enabled);
    state.auditionIndex = firstEnabledIdx >= 0 ? firstEnabledIdx : 0;
  } else {
    state.auditionIndex = 0;
  }

  document.querySelectorAll('.key-cell').forEach(el => {
    const m = Number(el.dataset.midi);
    el.classList.toggle('selected-key', m === clamped);
  });

  renderSelectedKeyDeck();

  if (shouldTapPreview) {
    triggerDefaultPianoGate('arrow_preview', clamped, 0.9, false);
  }
}

// ============================================================================
// Rendering: Pure Chromatic Circle Strip & Collapsible Thumbnail Sample Tray
// ============================================================================
function renderPianoKeyboard() {
  const container = document.getElementById('pianoKeyboard');
  if (!container) return;
  container.innerHTML = '';

  const keyMap = state.catalog?.keyboardMap || {};

  for (let midi = MIN_MIDI; midi <= MAX_MIDI; midi++) {
    const pc = ((midi % 12) + 12) % 12;
    const isAccidental = ACCIDENTAL_SEMITONES.has(pc);
    const isOctaveStart = pc === 0;
    const isPercKey = midi < 36;
    const isTonalStart = midi === 36;

    const entry = keyMap[midi];
    const candCount = entry?.candidateCount || 0;
    const enabledCount = entry?.enabledCount || 0;
    const isEmpty = enabledCount === 0;

    const cell = document.createElement('div');
    cell.className = [
      'key-cell',
      isPercKey ? 'perc-key' : 'tonal-key',
      isTonalStart ? 'tonal-start' : '',
      isAccidental ? 'accidental' : 'natural',
      isOctaveStart ? 'octave-start' : '',
      isEmpty ? 'empty-key' : 'configured-key',
      midi === state.selectedMidi ? 'selected-key' : '',
      isMidiStillHeld(midi) ? 'active-play' : ''
    ]
      .filter(Boolean)
      .join(' ');
    cell.dataset.midi = midi;
    cell.style.setProperty('--note-color', getNoteColor(midi));

    let dotClass = 'key-dot';
    if (enabledCount > 0) {
      dotClass = 'key-dot';
    } else if (candCount > 0) {
      dotClass = 'key-dot muted-dot';
    } else {
      dotClass = 'key-dot empty-dot';
    }

    cell.innerHTML = `<span class="${dotClass}"></span>`;

    const fullNoteName = midiToName(midi);
    const roleMeta = isPercKey
      ? entry?.percRole || 'Percussion'
      : `${midiToFreq(midi)} Hz`;

    if (enabledCount > 0) {
      cell.title = `${fullNoteName} · ${roleMeta} — ${enabledCount} / ${candCount} active`;
    } else if (candCount > 0) {
      cell.title = `${fullNoteName} · ${roleMeta} — Bypassed (${candCount})`;
    } else {
      cell.title = `${fullNoteName} (${roleMeta})`;
    }

    cell.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      selectKeyForConfig(midi, false);
      triggerDefaultPianoGate(`ui_key_${midi}`, midi, 0.92, false);
    });

    container.appendChild(cell);
  }
}

function getCandidatesForSelectedKey() {
  const entry = state.catalog?.keyboardMap?.[state.selectedMidi];
  return entry?.candidates || [];
}

function renderSelectedKeyDeck() {
  const midi = state.selectedMidi;
  const isPercKey = midi < 36;
  const noteName = midiToName(midi);
  const freqStr = midiToFreq(midi);
  const entry = state.catalog?.keyboardMap?.[midi];

  const noteTagEl = document.getElementById('selectedNoteTag');
  if (noteTagEl) {
    noteTagEl.textContent = noteName;
    noteTagEl.style.borderColor = getNoteColor(midi);
    noteTagEl.style.color = '#ffffff';
  }

  const grid = document.getElementById('candidatesGrid');
  grid.innerHTML = '';

  const candidates = getCandidatesForSelectedKey();
  if (candidates.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-key-state';
    const metaLabel = isPercKey ? entry?.percRole || 'Percussion' : `${freqStr} Hz`;
    emptyDiv.textContent = `${noteName} · ${metaLabel} — no samples`;
    grid.appendChild(emptyDiv);
    return;
  }

  candidates.forEach((cand, idx) => {
    const isEnabled = !!cand.enabled;
    const card = document.createElement('div');
    card.className = [
      'candidate-card',
      isEnabled ? 'is-enabled' : '',
      idx === state.auditionIndex ? 'audition-focus' : ''
    ]
      .filter(Boolean)
      .join(' ');

    card.innerHTML = `
      <div class="cand-thumb-wrap" title="Click to audition ${cand.videoSlug} (${noteName})">
        <img src="${withBust(cand.thumbUrl)}" alt="${cand.videoSlug}" loading="lazy" />
        <button
          class="toggle-on-btn ${isEnabled ? 'is-on' : 'is-off'}"
          type="button"
          aria-pressed="${isEnabled ? 'true' : 'false'}"
          title="${isEnabled ? 'Active — click to bypass' : 'Bypassed — click to enable'}"
        >
          <span class="transport-led"></span>
        </button>
        <button
          class="cand-inspect-btn trim-btn"
          type="button"
          title="Inspect clip"
          aria-label="Inspect clip"
        >
          <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
            <line x1="2.5" y1="4" x2="13.5" y2="4"></line>
            <circle cx="6" cy="4" r="1.4" fill="currentColor"></circle>
            <line x1="2.5" y1="8" x2="13.5" y2="8"></line>
            <circle cx="10.5" cy="8" r="1.4" fill="currentColor"></circle>
            <line x1="2.5" y1="12" x2="13.5" y2="12"></line>
            <circle cx="5" cy="12" r="1.4" fill="currentColor"></circle>
          </svg>
        </button>
      </div>
      <div class="cand-slug-title" title="${cand.videoSlug}">${cand.videoSlug}</div>
    `;

    card.addEventListener('mousedown', e => {
      if (e.button !== 0 || e.target.closest('button')) return;
      triggerDefaultCandidateGate(`ui_cand_${cand.sliceId}`, midi, cand, idx);
    });

    card.querySelector('.toggle-on-btn').addEventListener('click', async e => {
      e.stopPropagation();
      const nextEnabled = !isEnabled;
      if (nextEnabled) {
        triggerDefaultCandidateGate(`ui_cand_${cand.sliceId}`, midi, cand, idx);
      }
      await apiPost('/api/keyboard/toggle', {
        midi,
        sliceId: cand.sliceId,
        enabled: nextEnabled
      });
    });

    card.querySelector('.trim-btn').addEventListener('click', e => {
      e.stopPropagation();
      openTrimModal(cand.videoId, cand.sliceId, cand.playbackRate || 1.0);
    });

    grid.appendChild(card);
  });
}

// ============================================================================
// Universal Clip Inspector Overlay (Rename + Inline Reference Tone / Slot + Tall Spectrogram + Trim + Confirm Trash)
// ============================================================================
const trimState = {
  open: false,
  video: null,
  slice: null,
  playbackRate: 1.0,
  assignedMidi: 60,
  refMidi: 60,
  rawDur: 2.0,
  inSec: 0,
  outSec: 2.0,
  sliceAudioBuffer: null,
  previewRaf: null,
  previewAudioSrc: null,
  previewGainNode: null,
  previewStartCtxTime: 0,
  previewPlayDur: 0,
  refToneStopFn: null,
  refToneUiTimer: null,
  trashConfirmArmed: false,
  trashConfirmTimer: null,
  dragMode: null,
  dragStartX: 0,
  dragStartIn: 0,
  dragStartOut: 0
};

function stopReferenceTone(immediate = false) {
  if (trimState.refToneUiTimer) {
    clearTimeout(trimState.refToneUiTimer);
    trimState.refToneUiTimer = null;
  }
  const btn = document.getElementById('inspectorTestToneBtn');
  if (btn) btn.classList.remove('ringing');
  if (trimState.refToneStopFn) {
    const fn = trimState.refToneStopFn;
    trimState.refToneStopFn = null;
    fn(immediate);
  }
}

function playReferenceTone(midi = trimState.refMidi) {
  const clampedMidi = Math.max(MIN_MIDI, Math.min(MAX_MIDI, Math.round(Number(midi) || 60)));
  stopReferenceTone(false);

  const ctx = ensureAudioContext();
  const now = ctx.currentTime;
  const freq = 440 * Math.pow(2, (clampedMidi - 69) / 12);
  const dur = 0.95;

  const sineOsc = ctx.createOscillator();
  sineOsc.type = 'sine';
  sineOsc.frequency.setValueAtTime(freq, now);

  const triOsc = ctx.createOscillator();
  triOsc.type = 'triangle';
  triOsc.frequency.setValueAtTime(freq, now);

  const triFilter = ctx.createBiquadFilter();
  triFilter.type = 'lowpass';
  triFilter.frequency.setValueAtTime(Math.min(3600, freq * 3.2), now);

  const sineGain = ctx.createGain();
  sineGain.gain.setValueAtTime(0.84, now);

  const triGain = ctx.createGain();
  triGain.gain.setValueAtTime(0.16, now);

  const env = ctx.createGain();
  const peak = clampedMidi < 42 ? 0.28 : 0.21;
  env.gain.setValueAtTime(0.0001, now);
  env.gain.linearRampToValueAtTime(peak, now + 0.008);
  env.gain.exponentialRampToValueAtTime(peak * 0.52, now + 0.28);
  env.gain.exponentialRampToValueAtTime(0.0001, now + dur);

  sineOsc.connect(sineGain);
  sineGain.connect(env);
  triOsc.connect(triFilter);
  triFilter.connect(triGain);
  triGain.connect(env);
  env.connect(masterBus);

  sineOsc.start(now);
  triOsc.start(now);
  sineOsc.stop(now + dur + 0.03);
  triOsc.stop(now + dur + 0.03);

  const btn = document.getElementById('inspectorTestToneBtn');
  if (btn) btn.classList.add('ringing');

  let stopped = false;
  trimState.refToneStopFn = fast => {
    if (stopped) return;
    stopped = true;
    const t = ctx.currentTime;
    const fade = fast ? 0.015 : 0.035;
    try {
      env.gain.cancelScheduledValues(t);
      env.gain.setValueAtTime(Math.max(0.0001, env.gain.value || 0.05), t);
      env.gain.linearRampToValueAtTime(0.0001, t + fade);
      sineOsc.stop(t + fade + 0.01);
      triOsc.stop(t + fade + 0.01);
    } catch {}
  };

  trimState.refToneUiTimer = setTimeout(() => {
    trimState.refToneUiTimer = null;
    trimState.refToneStopFn = null;
    if (btn) btn.classList.remove('ringing');
  }, Math.round(dur * 1000));
}

function resetTrashConfirmUI() {
  trimState.trashConfirmArmed = false;
  if (trimState.trashConfirmTimer) {
    clearTimeout(trimState.trashConfirmTimer);
    trimState.trashConfirmTimer = null;
  }
  const trashBtn = document.getElementById('inspectorTrashClipBtn');
  if (trashBtn) {
    trashBtn.classList.remove('confirm-armed');
    trashBtn.textContent = 'Move Clip to Trash';
  }
}

function getMinTrimLen(rawDur = trimState.rawDur) {
  return Math.min(0.20, Math.max(0.08, rawDur * 0.5));
}

function stopTrimPreview() {
  if (trimState.previewRaf) {
    cancelAnimationFrame(trimState.previewRaf);
    trimState.previewRaf = null;
  }
  if (trimState.previewAudioSrc) {
    try {
      trimState.previewAudioSrc.stop();
    } catch {}
    try {
      trimState.previewAudioSrc.disconnect();
    } catch {}
    trimState.previewAudioSrc = null;
  }
  if (trimState.previewGainNode) {
    try {
      trimState.previewGainNode.disconnect();
    } catch {}
    trimState.previewGainNode = null;
  }
  const vid = document.getElementById('trimScrubVideo');
  if (vid) {
    try {
      vid.pause();
    } catch {}
  }
  const ph = document.getElementById('trimPlayhead');
  if (ph) ph.classList.remove('visible');
  const specPh = document.getElementById('inspectorSpecPlayhead');
  if (specPh) specPh.classList.remove('visible');
  const btn = document.getElementById('trimPreviewBtn');
  if (btn) btn.textContent = '▶ Preview (Space)';
}

function scrubTrimVideoTo(sec) {
  const vid = document.getElementById('trimScrubVideo');
  if (!vid) return;
  const maxT = Math.max(0.05, Math.min(MAX_CLIP_DUR, trimState.rawDur || MAX_CLIP_DUR));
  const clamped = Math.max(0, Math.min(maxT, sec));
  document.getElementById('trimScrubTimeReadout').textContent = `Frame @ ${clamped.toFixed(2)}s`;
  if (Math.abs(vid.currentTime - clamped) > 0.015) {
    try {
      vid.muted = true;
      vid.currentTime = clamped;
    } catch {}
  }
}

async function startTrimPreview() {
  const vid = document.getElementById('trimScrubVideo');
  if (!vid || !trimState.video || !trimState.slice) return;

  if (trimState.previewRaf || trimState.previewAudioSrc) {
    stopTrimPreview();
    return;
  }

  const sliceRef = trimState.slice;
  let buffer = trimState.sliceAudioBuffer;
  if (!buffer) {
    try {
      buffer = await loadAudioBuffer(sliceRef.audioUrl);
      if (!trimState.open || trimState.slice?.id !== sliceRef.id) return;
      trimState.sliceAudioBuffer = buffer;
    } catch {
      return;
    }
  }

  const ctx = ensureAudioContext();
  const now = ctx.currentTime;
  const rate = Math.max(0.25, Math.min(4.0, trimState.playbackRate || 1.0));
  const rawLimit = Math.min(MAX_CLIP_DUR, trimState.rawDur, buffer.duration);
  const inSec = Math.max(0, Math.min(Math.max(0, rawLimit - 0.08), trimState.inSec));
  const outSec = Math.max(inSec + 0.08, Math.min(rawLimit, trimState.outSec));
  const unpitchedSpan = Math.max(0.08, outSec - inSec);

  // Respect trimmed [inSec -> outSec] with universal 2.50s cap and 0.40s forced end-of-clip decay
  const playDur = Math.min(MAX_CLIP_DUR, unpitchedSpan / rate);
  const bufferPlaySpan = Math.min(buffer.duration - inSec, playDur * rate);
  const effectiveOutSec = inSec + bufferPlaySpan;

  const forcedRelDur = Math.min(state.releaseSec, playDur * 0.78);
  const forcedRelStart = Math.max(0.012, playDur - forcedRelDur);

  const dbOffset =
    sliceRef.peakDb !== undefined ? Math.max(0, Math.min(8, (-22 - sliceRef.peakDb) * 0.35)) : 0;
  const peakGain = Math.min(1.25, 0.88 * Math.pow(10, dbOffset / 20));

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.setValueAtTime(rate, now);

  const gainNode = ctx.createGain();
  gainNode.gain.setValueAtTime(0.0001, now);
  gainNode.gain.linearRampToValueAtTime(peakGain, now + 0.006);
  gainNode.gain.setValueAtTime(peakGain, now + forcedRelStart);
  gainNode.gain.linearRampToValueAtTime(peakGain * 0.56, now + forcedRelStart + forcedRelDur * 0.35);
  gainNode.gain.linearRampToValueAtTime(peakGain * 0.18, now + forcedRelStart + forcedRelDur * 0.72);
  gainNode.gain.linearRampToValueAtTime(0.0001, now + playDur);

  src.connect(gainNode);
  gainNode.connect(sampleHighpass);
  src.start(now, inSec, bufferPlaySpan + 0.015);

  trimState.previewAudioSrc = src;
  trimState.previewGainNode = gainNode;
  trimState.previewStartCtxTime = now;
  trimState.previewPlayDur = playDur;

  const ph = document.getElementById('trimPlayhead');
  const specPh = document.getElementById('inspectorSpecPlayhead');
  const btn = document.getElementById('trimPreviewBtn');
  btn.textContent = '⏹ Stop (Space)';

  vid.muted = true;
  vid.playbackRate = Math.max(0.25, Math.min(4.0, rate));
  try {
    vid.currentTime = inSec;
  } catch {}
  vid.play().catch(() => {});

  ph.classList.add('visible');
  ph.style.left = '0%';
  const rawSpan = Math.max(0.08, trimState.rawDur);
  const trimSpan = Math.max(0.05, outSec - inSec);

  const tick = () => {
    if (!trimState.open || !trimState.previewAudioSrc) {
      stopTrimPreview();
      return;
    }
    const elapsed = Math.max(0, ctx.currentTime - trimState.previewStartCtxTime);
    const curRate = Math.max(0.25, Math.min(4.0, trimState.playbackRate || rate));
    const bufTime = Math.min(effectiveOutSec, inSec + elapsed * curRate);

    document.getElementById('trimScrubTimeReadout').textContent = `Playing ${bufTime.toFixed(2)}s`;
    const pct = Math.max(0, Math.min(100, ((bufTime - inSec) / trimSpan) * 100));
    ph.style.left = `${pct.toFixed(1)}%`;

    if (specPh) {
      const specPct = Math.max(0, Math.min(100, (bufTime / rawSpan) * 100));
      specPh.classList.add('visible');
      specPh.style.left = `${specPct.toFixed(1)}%`;
    }

    if (elapsed >= trimState.previewPlayDur || bufTime >= effectiveOutSec - 0.005) {
      stopTrimPreview();
      scrubTrimVideoTo(inSec);
      return;
    }
    trimState.previewRaf = requestAnimationFrame(tick);
  };
  trimState.previewRaf = requestAnimationFrame(tick);
}

function renderInspectorSpectrogram() {
  const canvas = document.getElementById('inspectorSpectrogramCanvas');
  if (!canvas || !trimState.slice) return;

  const rect = canvas.parentElement.getBoundingClientRect();
  const cssW = Math.max(320, Math.round(rect.width || 600));
  const cssH = Math.max(180, Math.round(rect.height || 248));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }

  const ctx = canvas.getContext('2d');
  if (!trimState.sliceAudioBuffer) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#05070b';
    ctx.fillRect(0, 0, cssW, cssH);
    return;
  }

  const rate = trimState.playbackRate || 1.0;
  const slice = trimState.slice;
  const cand = findKeyboardCandidate(slice.id);
  const isPerc = cand ? cand.isPerc : isPercussionSlice(trimState.video, slice);
  const playedFreq = Number(((slice.freq || 261.6) * rate).toFixed(1));
  const f0Label = isPerc ? 'PERC' : (cand?.name || slice.name);
  const cacheKey = `insp__${slice.id}__${playedFreq}__${isPerc ? 0 : 1}__${cssW}x${cssH}__${dpr}`;

  let off = spectrogramBitmapCache.get(cacheKey);
  if (!off) {
    off = buildSpectrogramOffscreen(
      trimState.sliceAudioBuffer,
      playedFreq,
      f0Label,
      cssW,
      cssH,
      dpr,
      rate,
      !isPerc
    );
    spectrogramBitmapCache.set(cacheKey, off);
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(off, 0, 0);

  const rawSpan = Math.max(0.08, trimState.rawDur);
  const leftCut = Math.max(0, Math.min(cssW, (trimState.inSec / rawSpan) * cssW));
  const rightKeep = Math.max(0, Math.min(cssW, (trimState.outSec / rawSpan) * cssW));

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Draw Reference Tone horizontal guide when testing an alternate note (or tonal reference on a perc clip)
  const refMidi = trimState.refMidi;
  if (Number.isFinite(refMidi) && (refMidi !== trimState.assignedMidi || (isPerc && refMidi >= 36))) {
    const refFreq = Number(midiToFreq(refMidi));
    const minFreq = 55;
    const maxFreq = 4200;
    if (refFreq >= minFreq && refFreq <= maxFreq) {
      const logMin = Math.log(minFreq);
      const logMax = Math.log(maxFreq);
      const yRef = cssH - 1 - ((Math.log(refFreq) - logMin) / (logMax - logMin)) * (cssH - 1);
      ctx.save();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(0, yRef);
      ctx.lineTo(cssW, yRef);
      ctx.stroke();
      ctx.setLineDash([]);

      const refTag = `♪ Ref: ${midiToName(refMidi)} (${refFreq}Hz)`;
      ctx.font = 'bold 10px "SF Mono", Menlo, monospace';
      const tagW = Math.ceil(ctx.measureText(refTag).width) + 10;
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(52, Math.max(2, yRef - 15), tagW, 14);
      ctx.fillStyle = '#04121d';
      ctx.fillText(refTag, 57, Math.max(12, yRef - 4));
      ctx.restore();
    }
  }

  if (leftCut > 1) {
    ctx.fillStyle = 'rgba(3, 4, 7, 0.74)';
    ctx.fillRect(0, 0, leftCut, cssH);
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(leftCut, 0);
    ctx.lineTo(leftCut, cssH);
    ctx.stroke();
  }
  if (rightKeep < cssW - 1) {
    ctx.fillStyle = 'rgba(3, 4, 7, 0.74)';
    ctx.fillRect(rightKeep, 0, cssW - rightKeep, cssH);
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(rightKeep, 0);
    ctx.lineTo(rightKeep, cssH);
    ctx.stroke();
  }
}

function isTrimModified() {
  const s = trimState.slice;
  const persistedTrim = Boolean(
    s && (s.isTrimmed || Number.isFinite(s.trimIn) || Number.isFinite(s.trimOut))
  );
  return (
    persistedTrim ||
    trimState.inSec > 0.005 ||
    trimState.outSec < Math.max(0.08, trimState.rawDur - 0.005)
  );
}

function renderTrimHandlesUI() {
  const span = Math.max(0.08, trimState.rawDur);
  const leftPct = Math.max(0, Math.min(100, (trimState.inSec / span) * 100));
  const rightEdgePct = Math.max(0, Math.min(100, (trimState.outSec / span) * 100));
  const widthPct = Math.max(1.5, rightEdgePct - leftPct);

  document.getElementById('trimCurtainLeft').style.width = `${leftPct.toFixed(2)}%`;
  document.getElementById('trimCurtainRight').style.width = `${Math.max(0, 100 - rightEdgePct).toFixed(2)}%`;

  const box = document.getElementById('trimWindowBox');
  box.style.left = `${leftPct.toFixed(2)}%`;
  box.style.width = `${widthPct.toFixed(2)}%`;

  const len = Math.max(0.05, trimState.outSec - trimState.inSec);
  const spanMeta = document.getElementById('trimSpanMeta');
  if (spanMeta) {
    spanMeta.textContent = `${trimState.inSec.toFixed(2)}s – ${trimState.outSec.toFixed(2)}s · ${len.toFixed(2)}s`;
  }
  document.getElementById('trimHandleInTag').textContent = `IN ${trimState.inSec.toFixed(2)}s`;
  document.getElementById('trimHandleOutTag').textContent = `OUT ${trimState.outSec.toFixed(2)}s`;

  const resetBtn = document.getElementById('trimResetBtn');
  if (resetBtn) {
    resetBtn.classList.toggle('hidden', !isTrimModified());
  }

  renderTrimWaveformCanvas();
  if (trimState.sliceAudioBuffer) {
    renderInspectorSpectrogram();
  }
}

function renderTrimWaveformCanvas() {
  const canvas = document.getElementById('trimWaveformCanvas');
  if (!canvas || !trimState.slice) return;

  const rect = canvas.parentElement.getBoundingClientRect();
  const cssW = Math.max(320, Math.round(rect.width || 520));
  const cssH = Math.max(88, Math.round(rect.height || 108));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#05070b';
  ctx.fillRect(0, 0, cssW, cssH);

  const rawDur = Math.max(0.08, Math.min(MAX_CLIP_DUR, trimState.rawDur));
  const waveAreaH = cssH - 18;
  const midY = waveAreaH / 2;

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(cssW, midY);
  ctx.stroke();

  if (trimState.sliceAudioBuffer) {
    const ch = trimState.sliceAudioBuffer.getChannelData(0);
    const sr = trimState.sliceAudioBuffer.sampleRate;
    const maxSamples = Math.min(ch.length, Math.floor(rawDur * sr));
    let maxAbs = 0.05;
    for (let i = 0; i < maxSamples; i += 12) {
      const a = Math.abs(ch[i]);
      if (a > maxAbs) maxAbs = a;
    }

    for (let x = 0; x < cssW; x++) {
      const t0 = (x / cssW) * rawDur;
      const t1 = ((x + 1) / cssW) * rawDur;
      const s0 = Math.max(0, Math.floor(t0 * sr));
      const s1 = Math.min(maxSamples, Math.ceil(t1 * sr));
      if (s1 <= s0) continue;

      let localPeak = 0;
      const step = Math.max(1, Math.floor((s1 - s0) / 12));
      for (let s = s0; s < s1; s += step) {
        const av = Math.abs(ch[s]);
        if (av > localPeak) localPeak = av;
      }
      const insideTrim = t0 >= trimState.inSec - 0.002 && t0 <= trimState.outSec + 0.002;
      ctx.fillStyle = insideTrim ? '#38bdf8' : 'rgba(148, 163, 184, 0.35)';
      const amp = (localPeak / maxAbs) * (midY - 6);
      const h = Math.max(2, amp * 2);
      ctx.fillRect(x, midY - h / 2, 1, h);
    }
  }

  // Visualize forced end-of-clip release decay envelope inside [inSec, outSec]
  const rate = Math.max(0.25, Math.min(4.0, trimState.playbackRate || 1.0));
  const unpitchedSpan = Math.max(0.08, trimState.outSec - trimState.inSec);
  const playDur = Math.min(MAX_CLIP_DUR, unpitchedSpan / rate);
  const effectiveBufSpan = Math.min(unpitchedSpan, playDur * rate);
  const forcedRelDur = Math.min(state.releaseSec, playDur * 0.78);
  const relBufSpan = Math.min(effectiveBufSpan, forcedRelDur * rate);
  const effOut = trimState.inSec + effectiveBufSpan;
  const relStartBuf = Math.max(trimState.inSec, effOut - relBufSpan);

  const xIn = (trimState.inSec / rawDur) * cssW;
  const xRelStart = (relStartBuf / rawDur) * cssW;
  const xEffOut = (effOut / rawDur) * cssW;

  ctx.save();
  ctx.strokeStyle = 'rgba(245, 158, 11, 0.72)';
  ctx.lineWidth = 1.25;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(xIn, 7);
  ctx.lineTo(xRelStart, 7);
  ctx.lineTo(xEffOut, waveAreaH - 4);
  ctx.stroke();
  ctx.restore();

  // Time ruler along bottom (0.00s .. rawDur <= 2.50s)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.58)';
  ctx.fillRect(0, waveAreaH, cssW, 18);
  ctx.font = '10px "SF Mono", Menlo, monospace';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  const tickStep = rawDur <= 1.2 ? 0.25 : 0.5;
  for (let t = 0; t <= rawDur + 0.001; t += tickStep) {
    const x = (t / rawDur) * cssW;
    ctx.fillRect(Math.min(cssW - 1, x), waveAreaH, 1, 4);
    if (x < cssW - 34) {
      ctx.fillText(`${t.toFixed(tickStep < 0.5 ? 2 : 1)}s`, x + 3, cssH - 5);
    }
  }
  const endLabel = `${rawDur.toFixed(2)}s`;
  const endW = ctx.measureText(endLabel).width;
  ctx.fillText(endLabel, Math.max(4, cssW - endW - 5), cssH - 5);
}

const PERC_SLOT_ROLES = {
  24: 'Sub Kick',
  25: 'Deep Kick',
  26: 'Soft Thud',
  27: 'Metal Thump',
  28: 'Low Log',
  29: 'Warm Log',
  30: 'Wood Block',
  31: 'High Wood',
  32: 'Hollow Gong',
  33: 'Tin & Glass',
  34: 'Ping & Tick',
  35: 'Crisp Click'
};

function findKeyboardCandidate(sliceId) {
  if (!sliceId) return null;
  const km = state.catalog?.keyboardMap || {};
  for (const entry of Object.values(km)) {
    const found = (entry.candidates || []).find(c => c.sliceId === sliceId);
    if (found) return found;
  }
  return null;
}

function formatTuneReadout(cents, isUntouchedDsp) {
  const c = Math.round(Number(cents || 0));
  const rate = Math.pow(2, c / 1200).toFixed(2);
  const signCents = c > 0 ? `+${c}c` : `${c}c`;
  if (c === 0) return `0c · 1.00x (Orig)`;
  if (isUntouchedDsp) return `DSP ${signCents} · ${rate}x`;
  if (Math.abs(c) >= 100 && c % 100 === 0) {
    const st = c / 100;
    return `${st > 0 ? `+${st}` : st} st (${signCents}) · ${rate}x`;
  }
  return `${signCents} · ${rate}x`;
}

function updateInspectorRefUi() {
  const slotSelect = document.getElementById('inspectorSlotSelect');
  if (slotSelect && String(slotSelect.value) !== String(trimState.refMidi)) {
    slotSelect.value = String(trimState.refMidi);
  }
  const testToneBtn = document.getElementById('inspectorTestToneBtn');
  if (testToneBtn) {
    testToneBtn.textContent = `♪ ${midiToName(trimState.refMidi)}`;
    testToneBtn.title = `Play pure reference test tone for ${midiToName(trimState.refMidi)} (${midiToFreq(trimState.refMidi)} Hz)`;
  }
  const assignBtn = document.getElementById('inspectorAssignSlotBtn');
  if (assignBtn) {
    if (trimState.refMidi !== trimState.assignedMidi) {
      assignBtn.textContent = `Move → ${midiToName(trimState.refMidi)}`;
      assignBtn.classList.remove('hidden');
    } else {
      assignBtn.classList.add('hidden');
    }
  }
}

function syncInspectorFromCatalog(videoId, sliceId, shouldJumpKeyboard = true) {
  const freshVideo = state.catalog?.videos.find(v => v.id === videoId);
  const freshSlice = freshVideo?.slices?.find(s => s.id === sliceId && !s.deleted);
  if (!freshVideo || !freshSlice) return;

  if (trimState.sliceAudioBuffer && freshSlice.audioUrl) {
    audioBufferCache.set(withBust(freshSlice.audioUrl), trimState.sliceAudioBuffer);
  }

  const cand = findKeyboardCandidate(freshSlice.id);
  trimState.video = freshVideo;
  trimState.slice = freshSlice;
  trimState.playbackRate = cand?.playbackRate ?? 1.0;

  const assignedMidi = cand?.midi ?? freshSlice.manualMidi ?? freshSlice.midi ?? 60;
  trimState.assignedMidi = assignedMidi;
  trimState.refMidi = assignedMidi;

  const bufDur = trimState.sliceAudioBuffer
    ? Math.min(MAX_CLIP_DUR, trimState.sliceAudioBuffer.duration)
    : null;
  const nextRaw = Math.max(
    0.12,
    Number(
      Math.min(
        MAX_CLIP_DUR,
        bufDur ?? cand?.rawDurSec ?? freshSlice.rawDurSec ?? freshSlice.durSec ?? 2.0
      ).toFixed(2)
    )
  );
  trimState.rawDur = nextRaw;
  const minLen = getMinTrimLen(nextRaw);
  const savedIn = Number(cand?.trimIn ?? freshSlice.trimIn ?? 0);
  const savedOut = Number(cand?.trimOut ?? freshSlice.trimOut ?? nextRaw);
  trimState.inSec = Number(Math.max(0, Math.min(nextRaw - minLen, savedIn)).toFixed(2));
  trimState.outSec = Number(Math.max(trimState.inSec + minLen, Math.min(nextRaw, savedOut)).toFixed(2));

  if (shouldJumpKeyboard && cand && cand.midi >= MIN_MIDI && cand.midi <= MAX_MIDI) {
    selectKeyForConfig(cand.midi, false);
  }

  populateInspectorHeaderAndPeaks();
  renderTrimHandlesUI();
  renderInspectorSpectrogram();
}

function populateInspectorHeaderAndPeaks() {
  const video = trimState.video;
  const slice = trimState.slice;
  if (!video || !slice) return;

  const cand = findKeyboardCandidate(slice.id);
  const currentMidi = cand?.midi ?? slice.manualMidi ?? slice.midi ?? 60;
  trimState.assignedMidi = currentMidi;
  if (!Number.isFinite(trimState.refMidi) || trimState.refMidi < MIN_MIDI || trimState.refMidi > MAX_MIDI) {
    trimState.refMidi = currentMidi;
  }

  const dspMidi = cand?.dspMidi ?? slice.dspOriginal?.midi ?? slice.midi ?? currentMidi;
  const dspName =
    cand?.dspName ??
    (dspMidi < 36
      ? `${midiToName(dspMidi)} (${PERC_SLOT_ROLES[dspMidi] || 'Perc'})`
      : midiToName(dspMidi));
  const isOverridden =
    cand?.isOverridden ??
    Boolean(
      Number.isFinite(slice.manualMidi) ||
        Number.isFinite(slice.manualTuneCents) ||
        slice.dspOriginal
    );

  document.getElementById('inspectorSlugInput').value = video.slug || '';

  // Populate MIDI Note Slot selector (24 C1 .. 103 G7)
  const slotSelect = document.getElementById('inspectorSlotSelect');
  if (slotSelect) {
    slotSelect.innerHTML = '';
    const percGroup = document.createElement('optgroup');
    percGroup.label = 'Percussion Octave (C1–B1 · MIDI 24–35)';
    for (let m = 24; m <= 35; m++) {
      const opt = document.createElement('option');
      opt.value = String(m);
      const role = PERC_SLOT_ROLES[m] || 'Percussion';
      const curTag = m === currentMidi ? ' (Assigned)' : '';
      const dspTag = m === dspMidi ? ' ★ DSP' : '';
      opt.textContent = `${midiToName(m)} — ${role}${curTag}${dspTag}`;
      if (m === trimState.refMidi) opt.selected = true;
      percGroup.appendChild(opt);
    }
    slotSelect.appendChild(percGroup);

    const tonalGroup = document.createElement('optgroup');
    tonalGroup.label = 'Tonal Keys (C2–G7 · MIDI 36–103)';
    for (let m = 36; m <= MAX_MIDI; m++) {
      const opt = document.createElement('option');
      opt.value = String(m);
      const curTag = m === currentMidi ? ' (Assigned)' : '';
      const dspTag = m === dspMidi ? ' ★ DSP' : '';
      opt.textContent = `${midiToName(m)} · ${midiToFreq(m)} Hz${curTag}${dspTag}`;
      if (m === trimState.refMidi) opt.selected = true;
      tonalGroup.appendChild(opt);
    }
    slotSelect.appendChild(tonalGroup);
  }

  updateInspectorRefUi();

  // Show/hide "↺ Reset to DSP" button whenever slot or tuning was overridden
  const resetDspBtn = document.getElementById('inspectorResetDspBtn');
  if (resetDspBtn) {
    if (isOverridden) {
      resetDspBtn.textContent = `↺ Reset to DSP (${dspName})`;
      resetDspBtn.classList.remove('hidden');
    } else {
      resetDspBtn.classList.add('hidden');
    }
  }

  // Populate Re-Pitch controls
  const activeShiftCents =
    cand?.shiftCents ??
    Math.round(1200 * Math.log2(Math.max(0.25, trimState.playbackRate || 1.0)));
  const isUntouchedDsp =
    !Number.isFinite(slice.manualMidi) && !Number.isFinite(slice.manualTuneCents);

  const tuneSlider = document.getElementById('inspectorTuneSlider');
  if (tuneSlider) {
    tuneSlider.value = String(Math.max(-1200, Math.min(1200, activeShiftCents)));
  }
  const tuneReadout = document.getElementById('inspectorTuneReadout');
  if (tuneReadout) {
    tuneReadout.textContent = formatTuneReadout(activeShiftCents, isUntouchedDsp);
  }
  const zeroTuneBtn = document.getElementById('inspectorZeroTuneBtn');
  if (zeroTuneBtn) {
    zeroTuneBtn.classList.toggle('hidden', activeShiftCents === 0);
  }

  const specMeta = document.getElementById('inspectorSpecMeta');
  if (specMeta) {
    specMeta.textContent = `0.00s – ${trimState.rawDur.toFixed(2)}s`;
  }
}

async function openTrimModal(videoId, sliceId, playbackRate = 1.0) {
  const video = state.catalog?.videos.find(v => v.id === videoId);
  if (!video) return;
  const slice = (video.slices || []).find(s => s.id === sliceId && !s.deleted) || video.slices?.[0];
  if (!slice) return;

  stopTrimPreview();
  stopReferenceTone(true);
  resetTrashConfirmUI();

  const cand = findKeyboardCandidate(slice.id);
  const initMidi = cand?.midi ?? slice.manualMidi ?? slice.midi ?? 60;
  const initRaw = Math.max(
    0.12,
    Number(
      Math.min(MAX_CLIP_DUR, cand?.rawDurSec ?? slice.rawDurSec ?? slice.durSec ?? 2.0).toFixed(2)
    )
  );
  const minLen = getMinTrimLen(initRaw);
  const savedIn = Number(cand?.trimIn ?? slice.trimIn ?? 0);
  const savedOut = Number(cand?.trimOut ?? slice.trimOut ?? initRaw);

  trimState.open = true;
  trimState.video = video;
  trimState.slice = slice;
  trimState.playbackRate = playbackRate || cand?.playbackRate || 1.0;
  trimState.assignedMidi = initMidi;
  trimState.refMidi = initMidi;
  trimState.rawDur = initRaw;
  trimState.inSec = Number(Math.max(0, Math.min(initRaw - minLen, savedIn)).toFixed(2));
  trimState.outSec = Number(Math.max(trimState.inSec + minLen, Math.min(initRaw, savedOut)).toFixed(2));
  trimState.sliceAudioBuffer = null;

  populateInspectorHeaderAndPeaks();

  const vidEl = document.getElementById('trimScrubVideo');
  vidEl.src = withBust(slice.videoUrl);
  vidEl.style.transform = '';

  document.getElementById('trimModal').classList.remove('hidden');

  renderTrimHandlesUI();
  renderInspectorSpectrogram();

  vidEl.onloadedmetadata = () => {
    scrubTrimVideoTo(trimState.inSec);
  };
  scrubTrimVideoTo(trimState.inSec);

  try {
    const buf = await loadAudioBuffer(slice.audioUrl);
    if (trimState.open && trimState.slice?.id === slice.id) {
      trimState.sliceAudioBuffer = buf;
      const actualRaw = Math.max(0.12, Number(Math.min(MAX_CLIP_DUR, buf.duration).toFixed(2)));
      const wasFullOut = !Number.isFinite(slice.trimOut) && Math.abs(trimState.outSec - trimState.rawDur) < 0.04;
      trimState.rawDur = actualRaw;
      if (wasFullOut) {
        trimState.outSec = actualRaw;
      } else {
        trimState.outSec = Number(Math.min(actualRaw, trimState.outSec).toFixed(2));
      }
      const nextMin = getMinTrimLen(actualRaw);
      trimState.inSec = Number(Math.max(0, Math.min(trimState.outSec - nextMin, trimState.inSec)).toFixed(2));
      populateInspectorHeaderAndPeaks();
      renderTrimHandlesUI();
      renderInspectorSpectrogram();
    }
  } catch {}
}

function closeTrimModal() {
  stopTrimPreview();
  stopReferenceTone(false);
  resetTrashConfirmUI();
  trimState.open = false;
  document.getElementById('trimModal').classList.add('hidden');
}

// ============================================================================
// API & Event Bindings
// ============================================================================
async function apiPost(url, body) {
  if (state.isStaticMode) {
    if (url === '/api/keyboard/toggle' && body && state.catalog?.keyboardMap) {
      const entry = state.catalog.keyboardMap[body.midi];
      if (entry) {
        for (const c of entry.candidates || []) {
          if (c.sliceId === body.sliceId) {
            c.enabled = Boolean(body.enabled);
          }
        }
        entry.enabledSliceIds = (entry.candidates || []).filter(c => c.enabled).map(c => c.sliceId);
        entry.enabledCount = entry.enabledSliceIds.length;
        entry.primary = (entry.candidates || []).find(c => c.enabled) || null;
        entry.activeSliceId = entry.primary ? entry.primary.sliceId : null;
        entry.isCleared = entry.enabledCount === 0;
        refreshAllUI();
      }
    }
    return { ok: true };
  }

  const res = await fetch(resolveAssetUrl(url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (res.ok) {
    state.assetBust = Date.now();
    audioBufferCache.clear();
    rawAudioBytesCache.clear();
    spectrogramBitmapCache.clear();
    miniSpecBitmapCache.clear();
    state.catalog = await res.json();
    refreshAllUI();
  }
  return res;
}

function refreshAllUI() {
  renderPianoKeyboard();
  renderSelectedKeyDeck();
  webglStage?.syncCatalog(state.catalog);
}

function stepToAdjacentPopulatedKey(dir) {
  let m = state.selectedMidi + dir;
  while (m >= MIN_MIDI && m <= MAX_MIDI) {
    if ((state.catalog?.keyboardMap?.[m]?.candidateCount || 0) > 0) {
      selectKeyForConfig(m, true);
      return;
    }
    m += dir;
  }
}

// ============================================================================
// MIDI File Transport (Upload + Play / Pause / Restart + Offline 4:3 Render)
// ============================================================================
const midiPlayer = {
  fileName: '',
  parsed: null,
  playing: false,
  elapsedSec: 0,
  lastPerfMs: 0,
  nextEventIdx: 0,
  rafId: null,
  pedalDown: false,
  pendingPedalIds: new Set(),
  activeTriggerIds: new Set()
};

function formatClockSec(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const mins = Math.floor(s / 60);
  const rem = String(s % 60).padStart(2, '0');
  return `${mins}:${rem}`;
}

function updateMidiTransportUi() {
  const labelEl = document.getElementById('midiFileLabel');
  const playBtn = document.getElementById('midiPlayPauseBtn');
  const playIcon = document.getElementById('midiPlayPauseIcon');
  const restartBtn = document.getElementById('midiRestartBtn');

  const hasMidi = Boolean(midiPlayer.parsed);
  if (playBtn) {
    playBtn.disabled = !hasMidi;
    playBtn.classList.toggle('is-playing', midiPlayer.playing);
  }
  if (playIcon) {
    playIcon.textContent = midiPlayer.playing ? '❚❚' : '▶';
  }
  if (restartBtn) {
    restartBtn.disabled = !hasMidi;
  }
  if (labelEl) {
    if (!hasMidi) {
      labelEl.textContent = 'No MIDI loaded';
    } else {
      labelEl.textContent = `${midiPlayer.fileName} · ${formatClockSec(midiPlayer.elapsedSec)} / ${formatClockSec(midiPlayer.parsed.durationSec)}`;
    }
  }
}

function silenceAllMidiTransportVoices(releaseSec = null) {
  midiPlayer.pedalDown = false;
  midiPlayer.pendingPedalIds.clear();
  for (const tid of Array.from(midiPlayer.activeTriggerIds)) {
    midiPlayer.activeTriggerIds.delete(tid);
    releaseHeldVoice(tid, releaseSec);
  }
}

function seekMidiEventCursor(targetSec) {
  if (!midiPlayer.parsed) {
    midiPlayer.nextEventIdx = 0;
    return;
  }
  const evs = midiPlayer.parsed.events;
  let idx = 0;
  while (idx < evs.length && evs[idx].timeSec < targetSec - 1e-4) {
    idx++;
  }
  midiPlayer.nextEventIdx = idx;
}

function tickMidiTransport() {
  if (!midiPlayer.playing || !midiPlayer.parsed) {
    midiPlayer.rafId = null;
    return;
  }

  const nowMs = performance.now();
  const dt = Math.min(0.1, Math.max(0, (nowMs - midiPlayer.lastPerfMs) / 1000));
  midiPlayer.lastPerfMs = nowMs;
  midiPlayer.elapsedSec += dt;

  const evs = midiPlayer.parsed.events;
  while (
    midiPlayer.nextEventIdx < evs.length &&
    evs[midiPlayer.nextEventIdx].timeSec <= midiPlayer.elapsedSec
  ) {
    const ev = evs[midiPlayer.nextEventIdx++];
    if (ev.type === 'sustain') {
      midiPlayer.pedalDown = !!ev.pedalDown;
      if (!midiPlayer.pedalDown) {
        for (const tid of Array.from(midiPlayer.pendingPedalIds)) {
          midiPlayer.pendingPedalIds.delete(tid);
          midiPlayer.activeTriggerIds.delete(tid);
          releaseHeldVoice(tid);
        }
      }
    } else if (ev.type === 'noteOn') {
      const tid = `midifile_${ev.channel}_${ev.midi}`;
      midiPlayer.pendingPedalIds.delete(tid);
      midiPlayer.activeTriggerIds.add(tid);
      startPianoKeyHold(tid, ev.midi, ev.velocity, false);
    } else if (ev.type === 'noteOff') {
      const tid = `midifile_${ev.channel}_${ev.midi}`;
      if (midiPlayer.pedalDown && midiPlayer.activeTriggerIds.has(tid)) {
        midiPlayer.pendingPedalIds.add(tid);
      } else {
        midiPlayer.activeTriggerIds.delete(tid);
        releaseHeldVoice(tid);
      }
    }
  }

  updateMidiTransportUi();

  if (
    midiPlayer.nextEventIdx >= evs.length &&
    midiPlayer.elapsedSec >= midiPlayer.parsed.durationSec + 0.45
  ) {
    silenceAllMidiTransportVoices();
    midiPlayer.playing = false;
    midiPlayer.elapsedSec = midiPlayer.parsed.durationSec;
    midiPlayer.rafId = null;
    updateMidiTransportUi();
    return;
  }

  midiPlayer.rafId = requestAnimationFrame(tickMidiTransport);
}

function playMidiTransport() {
  if (!midiPlayer.parsed || midiPlayer.playing) return;
  ensureAudioContext();

  if (midiPlayer.elapsedSec >= midiPlayer.parsed.durationSec) {
    midiPlayer.elapsedSec = 0;
    midiPlayer.nextEventIdx = 0;
  } else {
    seekMidiEventCursor(midiPlayer.elapsedSec);
  }

  midiPlayer.playing = true;
  midiPlayer.lastPerfMs = performance.now();
  updateMidiTransportUi();
  midiPlayer.rafId = requestAnimationFrame(tickMidiTransport);
}

function pauseMidiTransport() {
  if (!midiPlayer.playing) return;
  midiPlayer.playing = false;
  if (midiPlayer.rafId) {
    cancelAnimationFrame(midiPlayer.rafId);
    midiPlayer.rafId = null;
  }
  silenceAllMidiTransportVoices(0.2);
  updateMidiTransportUi();
}

function restartMidiTransport() {
  if (!midiPlayer.parsed) return;
  const wasPlaying = midiPlayer.playing;
  if (midiPlayer.rafId) {
    cancelAnimationFrame(midiPlayer.rafId);
    midiPlayer.rafId = null;
  }
  midiPlayer.playing = false;
  silenceAllMidiTransportVoices(0.08);
  midiPlayer.elapsedSec = 0;
  midiPlayer.nextEventIdx = 0;
  updateMidiTransportUi();
  if (wasPlaying) {
    playMidiTransport();
  }
}

async function handleMidiFileSelected(file) {
  if (!file) return;
  pauseMidiTransport();
  const arrBuf = await file.arrayBuffer();
  const parsed = parseMidiFile(new Uint8Array(arrBuf));

  midiPlayer.fileName = file.name;
  midiPlayer.parsed = parsed;
  midiPlayer.elapsedSec = 0;
  midiPlayer.nextEventIdx = 0;

  updateMidiTransportUi();
}

function setupEventListeners() {
  window.addEventListener('blur', () => {
    for (const key of Array.from(activeVoices.keys())) {
      if (!key.startsWith('midifile_')) {
        releaseHeldVoice(key, 0.25);
      }
    }
  });

  const drawerToggleBtn = document.getElementById('sampleDrawerToggleBtn');
  if (drawerToggleBtn) {
    drawerToggleBtn.addEventListener('click', () => {
      setSampleDrawerOpen(!state.sampleDrawerOpen);
    });
  }

  const midiUploadBtn = document.getElementById('midiUploadBtn');
  const midiFileInput = document.getElementById('midiFileInput');
  const midiPlayPauseBtn = document.getElementById('midiPlayPauseBtn');
  const midiRestartBtn = document.getElementById('midiRestartBtn');

  if (midiUploadBtn && midiFileInput) {
    midiUploadBtn.addEventListener('click', () => midiFileInput.click());
    midiFileInput.addEventListener('change', async () => {
      const f = midiFileInput.files?.[0];
      if (f) {
        try {
          await handleMidiFileSelected(f);
        } catch (err) {
          const labelEl = document.getElementById('midiFileLabel');
          if (labelEl) labelEl.textContent = `Invalid MIDI: ${err.message}`;
        }
        midiFileInput.value = '';
      }
    });
  }

  if (midiPlayPauseBtn) {
    midiPlayPauseBtn.addEventListener('click', () => {
      if (midiPlayer.playing) pauseMidiTransport();
      else playMidiTransport();
    });
  }

  if (midiRestartBtn) {
    midiRestartBtn.addEventListener('click', () => {
      restartMidiTransport();
    });
  }

  document.querySelectorAll('.close-drawer-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.close === 'trimModal') closeTrimModal();
    });
  });
  document.querySelectorAll('.drawer-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', e => {
      if (e.target === backdrop && backdrop.id === 'trimModal') {
        closeTrimModal();
      }
    });
  });

  // Inspector Header Editable Object Name
  const inspectorSlugInput = document.getElementById('inspectorSlugInput');
  inspectorSlugInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') e.target.blur();
  });
  inspectorSlugInput.addEventListener('blur', async () => {
    if (!trimState.open || !trimState.video) return;
    const nextSlug = inspectorSlugInput.value.trim();
    if (nextSlug && nextSlug !== trimState.video.slug) {
      await apiPost('/api/video/rename', {
        videoId: trimState.video.id,
        slug: nextSlug
      });
      const freshVideo = state.catalog?.videos.find(v => v.id === trimState.video.id);
      const freshSlice = freshVideo?.slices?.find(s => s.id === trimState.slice?.id && !s.deleted);
      if (freshVideo) {
        trimState.video = freshVideo;
        if (freshSlice) {
          trimState.slice = freshSlice;
          const vidEl = document.getElementById('trimScrubVideo');
          vidEl.src = withBust(freshSlice.videoUrl);
          vidEl.style.transform = '';
        }
        populateInspectorHeaderAndPeaks();
        scrubTrimVideoTo(trimState.inSec);
      }
    }
  });

  // Inspector Video Rotate 90° Button
  const rotateBtn = document.getElementById('inspectorRotateBtn');
  rotateBtn.addEventListener('click', async () => {
    if (!trimState.open || !trimState.video) return;
    stopTrimPreview();
    rotateBtn.disabled = true;
    rotateBtn.textContent = '...';
    try {
      await apiPost('/api/video/rotate', {
        videoId: trimState.video.id,
        deltaDeg: 90
      });
      const freshVideo = state.catalog?.videos.find(v => v.id === trimState.video.id);
      const freshSlice = freshVideo?.slices?.find(s => s.id === trimState.slice?.id && !s.deleted);
      if (freshVideo) {
        trimState.video = freshVideo;
        if (freshSlice) {
          trimState.slice = freshSlice;
          const vidEl = document.getElementById('trimScrubVideo');
          vidEl.src = withBust(freshSlice.videoUrl);
          vidEl.style.transform = '';
          scrubTrimVideoTo(trimState.inSec);
        }
      }
    } finally {
      rotateBtn.disabled = false;
      rotateBtn.textContent = '↻ 90°';
    }
  });

  // Inspector Inline Note Reference & Slot Assignment (◀ / Select / ▶ + ♪ Tone + Move → Note)
  const setInspectorRefMidi = (nextMidi, shouldPlayTone = true) => {
    const clamped = Math.max(MIN_MIDI, Math.min(MAX_MIDI, Math.round(Number(nextMidi) || 60)));
    trimState.refMidi = clamped;
    updateInspectorRefUi();
    renderInspectorSpectrogram();
    if (shouldPlayTone) {
      playReferenceTone(clamped);
    }
  };

  const slotPrevBtn = document.getElementById('inspectorSlotPrevBtn');
  if (slotPrevBtn) {
    slotPrevBtn.addEventListener('click', () => {
      if (!trimState.open) return;
      setInspectorRefMidi(trimState.refMidi - 1, true);
    });
  }

  const slotNextBtn = document.getElementById('inspectorSlotNextBtn');
  if (slotNextBtn) {
    slotNextBtn.addEventListener('click', () => {
      if (!trimState.open) return;
      setInspectorRefMidi(trimState.refMidi + 1, true);
    });
  }

  const slotSelectEl = document.getElementById('inspectorSlotSelect');
  if (slotSelectEl) {
    slotSelectEl.addEventListener('change', () => {
      if (!trimState.open) return;
      const nextMidi = Number(slotSelectEl.value);
      if (!Number.isFinite(nextMidi)) return;
      setInspectorRefMidi(nextMidi, true);
    });
  }

  const testToneBtn = document.getElementById('inspectorTestToneBtn');
  if (testToneBtn) {
    testToneBtn.addEventListener('click', () => {
      if (!trimState.open) return;
      playReferenceTone(trimState.refMidi);
    });
  }

  const assignSlotBtn = document.getElementById('inspectorAssignSlotBtn');
  if (assignSlotBtn) {
    assignSlotBtn.addEventListener('click', async () => {
      if (!trimState.open || !trimState.video || !trimState.slice) return;
      const nextMidi = trimState.refMidi;
      if (!Number.isFinite(nextMidi) || nextMidi < MIN_MIDI || nextMidi > MAX_MIDI) return;
      stopTrimPreview();
      const vidId = trimState.video.id;
      const slId = trimState.slice.id;
      await apiPost('/api/slice/update', {
        videoId: vidId,
        sliceId: slId,
        assignMidi: nextMidi,
        manualTuneCents: 0
      });
      syncInspectorFromCatalog(vidId, slId, true);
    });
  }

  // Inspector "↺ Reset to DSP" Button
  const resetDspBtn = document.getElementById('inspectorResetDspBtn');
  if (resetDspBtn) {
    resetDspBtn.addEventListener('click', async () => {
      if (!trimState.open || !trimState.video || !trimState.slice) return;
      stopTrimPreview();
      const vidId = trimState.video.id;
      const slId = trimState.slice.id;
      await apiPost('/api/slice/update', {
        videoId: vidId,
        sliceId: slId,
        resetToDsp: true
      });
      syncInspectorFromCatalog(vidId, slId, true);
    });
  }

  // Inspector Re-Pitch / Fine-Tune Slider
  const applyManualTuneCents = async nextCents => {
    if (!trimState.open || !trimState.video || !trimState.slice) return;
    const clamped = Math.max(-1200, Math.min(1200, Math.round(Number(nextCents) || 0)));
    const vidId = trimState.video.id;
    const slId = trimState.slice.id;
    trimState.playbackRate = Number(Math.pow(2, clamped / 1200).toFixed(4));
    const vid = document.getElementById('trimScrubVideo');
    if (vid && !vid.paused) {
      vid.playbackRate = Math.max(0.25, Math.min(4.0, trimState.playbackRate));
    }
    await apiPost('/api/slice/update', {
      videoId: vidId,
      sliceId: slId,
      manualTuneCents: clamped
    });
    syncInspectorFromCatalog(vidId, slId, false);
  };

  const tuneSliderEl = document.getElementById('inspectorTuneSlider');
  if (tuneSliderEl) {
    tuneSliderEl.addEventListener('input', () => {
      if (!trimState.open || !trimState.slice) return;
      const c = Math.round(Number(tuneSliderEl.value) || 0);
      trimState.playbackRate = Number(Math.pow(2, c / 1200).toFixed(4));
      const readout = document.getElementById('inspectorTuneReadout');
      if (readout) readout.textContent = formatTuneReadout(c, false);
      const zeroBtn = document.getElementById('inspectorZeroTuneBtn');
      if (zeroBtn) zeroBtn.classList.toggle('hidden', c === 0);
      const vid = document.getElementById('trimScrubVideo');
      if (vid && !vid.paused) {
        vid.playbackRate = Math.max(0.25, Math.min(4.0, trimState.playbackRate));
      }
      if (trimState.previewAudioSrc && audioCtx) {
        trimState.previewAudioSrc.playbackRate.setValueAtTime(
          trimState.playbackRate,
          audioCtx.currentTime
        );
      }
      renderTrimWaveformCanvas();
      renderInspectorSpectrogram();
    });
    tuneSliderEl.addEventListener('change', () => {
      applyManualTuneCents(Number(tuneSliderEl.value) || 0);
    });
  }

  const zeroTuneBtn = document.getElementById('inspectorZeroTuneBtn');
  if (zeroTuneBtn) {
    zeroTuneBtn.addEventListener('click', () => {
      applyManualTuneCents(0);
    });
  }

  // Inspector Footer 2-Step Confirm Move Clip to Trash Button
  const trashClipBtn = document.getElementById('inspectorTrashClipBtn');
  if (trashClipBtn) {
    trashClipBtn.addEventListener('click', async () => {
      if (!trimState.open || !trimState.video || !trimState.slice) return;
      if (!trimState.trashConfirmArmed) {
        trimState.trashConfirmArmed = true;
        trashClipBtn.classList.add('confirm-armed');
        trashClipBtn.textContent = 'Confirm Move to _trash?';
        if (trimState.trashConfirmTimer) clearTimeout(trimState.trashConfirmTimer);
        trimState.trashConfirmTimer = setTimeout(() => {
          resetTrashConfirmUI();
        }, 3500);
        return;
      }
      resetTrashConfirmUI();
      stopTrimPreview();
      const vidId = trimState.video.id;
      const slId = trimState.slice.id;
      closeTrimModal();
      await apiPost('/api/slice/trash', { videoId: vidId, sliceId: slId });
    });
  }

  // ==========================================================================
  // Single-Clip Non-Destructive Sub-Trim Bindings (0.00s .. rawDur <= 2.50s)
  // ==========================================================================
  const beginTrimDrag = (mode, e) => {
    e.stopPropagation();
    e.preventDefault();
    stopTrimPreview();
    trimState.dragMode = mode;
    trimState.dragStartX = e.clientX;
    trimState.dragStartIn = trimState.inSec;
    trimState.dragStartOut = trimState.outSec;
  };

  document.getElementById('trimHandleIn').addEventListener('mousedown', e => beginTrimDrag('in', e));
  document.getElementById('trimHandleOut').addEventListener('mousedown', e => beginTrimDrag('out', e));
  document.getElementById('trimWindowBox').addEventListener('mousedown', e => beginTrimDrag('move', e));

  document.getElementById('trimTimelineStage').addEventListener('mousedown', e => {
    if (!trimState.open || !trimState.slice) return;
    if (e.target.closest('#trimWindowBox')) return;
    e.preventDefault();
    stopTrimPreview();

    const stageEl = document.getElementById('trimTimelineStage');
    const rect = stageEl.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    const rawDur = Math.max(0.12, Math.min(MAX_CLIP_DUR, trimState.rawDur));
    const minLen = getMinTrimLen(rawDur);
    const clickSec = Math.max(0, Math.min(rawDur, ratio * rawDur));

    if (clickSec < trimState.inSec) {
      const nextIn = Math.max(0, Math.min(trimState.outSec - minLen, clickSec));
      trimState.inSec = Number(nextIn.toFixed(2));
      trimState.dragMode = 'in';
      scrubTrimVideoTo(trimState.inSec);
    } else if (clickSec > trimState.outSec) {
      const nextOut = Math.min(rawDur, Math.max(trimState.inSec + minLen, clickSec));
      trimState.outSec = Number(nextOut.toFixed(2));
      trimState.dragMode = 'out';
      scrubTrimVideoTo(trimState.outSec);
    }
    trimState.dragStartX = e.clientX;
    trimState.dragStartIn = trimState.inSec;
    trimState.dragStartOut = trimState.outSec;
    renderTrimHandlesUI();
  });

  window.addEventListener('mousemove', e => {
    if (!trimState.open || !trimState.dragMode || !trimState.slice) return;
    const stageEl = document.getElementById('trimTimelineStage');
    const rect = stageEl.getBoundingClientRect();
    const rawDur = Math.max(0.12, Math.min(MAX_CLIP_DUR, trimState.rawDur));
    const minLen = getMinTrimLen(rawDur);
    const deltaSec = ((e.clientX - trimState.dragStartX) / Math.max(1, rect.width)) * rawDur;

    if (trimState.dragMode === 'in') {
      let nextIn = trimState.dragStartIn + deltaSec;
      nextIn = Math.max(0, Math.min(trimState.outSec - minLen, nextIn));
      trimState.inSec = Number(nextIn.toFixed(2));
      renderTrimHandlesUI();
      scrubTrimVideoTo(trimState.inSec);
    } else if (trimState.dragMode === 'out') {
      let nextOut = trimState.dragStartOut + deltaSec;
      nextOut = Math.max(trimState.inSec + minLen, Math.min(rawDur, nextOut));
      trimState.outSec = Number(nextOut.toFixed(2));
      renderTrimHandlesUI();
      scrubTrimVideoTo(trimState.outSec);
    } else if (trimState.dragMode === 'move') {
      const clipLen = Math.max(minLen, Math.min(rawDur, trimState.dragStartOut - trimState.dragStartIn));
      let nextIn = trimState.dragStartIn + deltaSec;
      nextIn = Math.max(0, Math.min(rawDur - clipLen, nextIn));
      trimState.inSec = Number(nextIn.toFixed(2));
      trimState.outSec = Number(Math.min(rawDur, trimState.inSec + clipLen).toFixed(2));
      renderTrimHandlesUI();
      scrubTrimVideoTo(trimState.inSec);
    }
  });

  window.addEventListener('mouseup', () => {
    if (trimState.dragMode) {
      trimState.dragMode = null;
    }
  });

  // "↺ Reset Full Sample" Button — restores full DSP-cropped sample [0.00s, rawDur]
  const trimResetBtn = document.getElementById('trimResetBtn');
  if (trimResetBtn) {
    trimResetBtn.addEventListener('click', async () => {
      if (!trimState.open || !trimState.video || !trimState.slice) return;
      stopTrimPreview();
      const vidId = trimState.video.id;
      const slId = trimState.slice.id;
      const hadSavedTrim = Boolean(
        trimState.slice.isTrimmed ||
          Number.isFinite(trimState.slice.trimIn) ||
          Number.isFinite(trimState.slice.trimOut)
      );
      trimState.inSec = 0;
      trimState.outSec = trimState.rawDur;
      renderTrimHandlesUI();
      scrubTrimVideoTo(0);

      if (hadSavedTrim) {
        await apiPost('/api/slice/update', {
          videoId: vidId,
          sliceId: slId,
          resetTrim: true
        });
        syncInspectorFromCatalog(vidId, slId, false);
      }
    });
  }

  document.getElementById('trimPreviewBtn').addEventListener('click', () => {
    startTrimPreview();
  });

  document.getElementById('trimSaveBtn').addEventListener('click', async () => {
    if (!trimState.video || !trimState.slice) return;
    stopTrimPreview();
    const btn = document.getElementById('trimSaveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    const savedVideoId = trimState.video.id;
    const savedSliceId = trimState.slice.id;
    const rawDur = Math.max(0.12, Math.min(MAX_CLIP_DUR, trimState.rawDur));
    const isFullRange =
      trimState.inSec <= 0.005 && trimState.outSec >= Math.max(0.08, rawDur - 0.005);

    const payload = isFullRange
      ? {
          videoId: savedVideoId,
          sliceId: savedSliceId,
          resetTrim: true
        }
      : {
          videoId: savedVideoId,
          sliceId: savedSliceId,
          trimIn: Number(trimState.inSec.toFixed(2)),
          trimOut: Number(trimState.outSec.toFixed(2))
        };

    try {
      await apiPost('/api/slice/update', payload);
      closeTrimModal();
    } finally {
      btn.disabled = false;
      btn.textContent = '✓ Save Trim';
    }
  });

  // QWERTY Keydown / Keyup (Hold to Sustain + Lift to Decay!)
  window.addEventListener('keydown', async e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.metaKey || e.ctrlKey) {
      return;
    }

    if (e.key === 'Escape') {
      if (trimState.open) closeTrimModal();
      return;
    }

    if (trimState.open) {
      if ((e.code === 'Space' || e.key === ' ') && !e.repeat) {
        e.preventDefault();
        startTrimPreview();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setInspectorRefMidi(trimState.refMidi - 1, true);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setInspectorRefMidi(trimState.refMidi + 1, true);
      }
      return;
    }

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (e.shiftKey) stepToAdjacentPopulatedKey(-1);
      else selectKeyForConfig(state.selectedMidi - 1, true);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (e.shiftKey) stepToAdjacentPopulatedKey(1);
      else selectKeyForConfig(state.selectedMidi + 1, true);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const cands = getCandidatesForSelectedKey();
      if (cands.length > 0) {
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        const nextIdx = (state.auditionIndex + delta + cands.length) % cands.length;
        triggerDefaultCandidateGate('arrow_cand', state.selectedMidi, cands[nextIdx], nextIdx);
      }
      return;
    }
    if (e.key === 'Enter') {
      const cands = getCandidatesForSelectedKey();
      const chosen = cands[state.auditionIndex];
      if (chosen) {
        e.preventDefault();
        const nextEnabled = !chosen.enabled;
        if (nextEnabled) {
          triggerDefaultCandidateGate(
            `ui_cand_${chosen.sliceId}`,
            state.selectedMidi,
            chosen,
            state.auditionIndex
          );
        }
        await apiPost('/api/keyboard/toggle', {
          midi: state.selectedMidi,
          sliceId: chosen.sliceId,
          enabled: nextEnabled
        });
      }
      return;
    }

    if (e.repeat) return;

    if (e.code === 'KeyZ') {
      state.baseOctaveMidi = Math.max(MIN_MIDI, state.baseOctaveMidi - 12);
      return;
    }
    if (e.code === 'KeyX') {
      state.baseOctaveMidi = Math.min(84, state.baseOctaveMidi + 12);
      return;
    }

    const mapped = QWERTY_MAP.find(q => q.code === e.code);
    if (mapped) {
      e.preventDefault();
      const midi = state.baseOctaveMidi + mapped.offset;
      startPianoKeyHold(`qwerty_${e.code}`, midi, 0.92, true);
    }
  });

  window.addEventListener('keyup', e => {
    const mapped = QWERTY_MAP.find(q => q.code === e.code);
    if (mapped) {
      releaseHeldVoice(`qwerty_${e.code}`);
    }
  });
}

// ============================================================================
// Web MIDI Support (Full NoteOn + NoteOff + Sustain Pedal CC64!)
// ============================================================================
function initWebMIDI() {
  if (!navigator.requestMIDIAccess) return;
  navigator.requestMIDIAccess().then(
    midiAccess => {
      const bindInputs = () => {
        for (const input of midiAccess.inputs.values()) {
          input.onmidimessage = msg => {
            const [status, data1, data2] = msg.data;
            const cmd = status & 0xf0;
            if (cmd === 0x90 && data2 > 0) {
              sustainedVoicesPendingRelease.delete(`midi_${data1}`);
              startPianoKeyHold(`midi_${data1}`, data1, data2 / 127, true);
            } else if (cmd === 0x80 || (cmd === 0x90 && data2 === 0)) {
              releaseHeldVoice(`midi_${data1}`);
            } else if (cmd === 0xb0 && data1 === 64) {
              const down = data2 >= 64;
              state.sustainPedalDown = down;
              if (!down) {
                for (const tid of Array.from(sustainedVoicesPendingRelease)) {
                  sustainedVoicesPendingRelease.delete(tid);
                  releaseHeldVoice(tid);
                }
              }
            }
          };
        }
      };
      bindInputs();
      midiAccess.onstatechange = bindInputs;
    },
    () => {}
  );
}

// ============================================================================
// Boot
// ============================================================================
async function init() {
  const bgCanvas = document.getElementById('webglStageBg');
  if (bgCanvas) {
    const MIN_SCRUB_HOLD_SEC = 0.18;
    webglStage = createWebglStage({
      canvas: bgCanvas,
      dockSelector: '.keyboard-dock',
      getActiveSliceIds: getActiveStageSliceIds,
      formatTooltip: item => `${item.videoSlug} · ${midiToName(item.midi ?? 60)}`,
      onSliceEnter: item => {
        const cand = resolvePlayableSliceById(item.sliceId);
        if (!cand) return;
        state.lastPlayedVideoId = cand.videoId;
        state.lastPlayedSliceId = cand.sliceId;
        if (cand.midi >= MIN_MIDI && cand.midi <= MAX_MIDI && state.selectedMidi !== cand.midi) {
          if (state.sampleDrawerOpen) {
            selectKeyForConfig(cand.midi, false);
          } else {
            state.selectedMidi = cand.midi;
          }
        }
        startHeldVoice({
          triggerId: `bg_${item.sliceId}`,
          midi: cand.midi,
          slice: cand,
          playbackRate: cand.playbackRate || 1.0,
          velocity: 0.92
        });
      },
      onSliceLeave: (sliceId, heldSec = 0, wasScrub = false) => {
        const trigId = `bg_${sliceId}`;
        const minHold = wasScrub ? MIN_SCRUB_HOLD_SEC : DEFAULT_UI_HOLD_SEC;
        if (heldSec < minHold) {
          scheduleDefaultVoiceGate(trigId, minHold - heldSec);
        } else {
          releaseHeldVoice(trigId);
        }
      }
    });
  }

  updateStageTileSizes();
  const stageEl = document.getElementById('videoStage');
  if (stageEl && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => updateStageTileSizes()).observe(stageEl);
  }
  setupEventListeners();
  initWebMIDI();

  const atlasPromise = webglStage ? webglStage.loadAtlas() : Promise.resolve();

  let loadedFromLocalServer = false;
  const isLocalHost =
    window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  if (isLocalHost) {
    try {
      const res = await fetch('./api/catalog');
      if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
        state.catalog = await res.json();
        loadedFromLocalServer = true;
      }
    } catch {}
  }

  if (!loadedFromLocalServer) {
    state.isStaticMode = true;
    document.body.classList.add('static-mode');
    const staticRes = await fetch('./catalog.json');
    state.catalog = await staticRes.json();
  }

  if (!state.catalog?.keyboardMap?.[60]) {
    const firstKey = Object.keys(state.catalog?.keyboardMap || {}).map(Number).sort((a, b) => a - b)[0];
    if (firstKey) state.selectedMidi = firstKey;
  }

  await atlasPromise;
  refreshAllUI();
  updateStageTileSizes();

  // In static web mode, quietly background-warm enabled scale audio bytes (without opening AudioContext before gesture)
  if (state.isStaticMode && state.catalog?.keyboardMap) {
    setTimeout(async () => {
      const urls = [];
      // Prioritize central octaves (C3..C6) first, then outer octaves
      const entries = Object.values(state.catalog.keyboardMap).sort(
        (a, b) => Math.abs((a.targetMidi || 60) - 60) - Math.abs((b.targetMidi || 60) - 60)
      );
      for (const entry of entries) {
        for (const c of entry.candidates || []) {
          if (c.enabled && c.audioUrl) urls.push(c.audioUrl);
        }
      }
      let cursor = 0;
      const worker = async () => {
        while (cursor < urls.length) {
          const u = urls[cursor++];
          await prefetchRawAudioBytes(u);
        }
      };
      await Promise.all([worker(), worker(), worker()]);
    }, 350);
  }
}

init();
