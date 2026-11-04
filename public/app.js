import { parseMidiFile } from './midi-parser.mjs';
import { createThreeStage } from './three-stage.mjs';

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
const TOUCH_LEFT_ACCIDENTALS = new Set([3, 8, 10]); // D#, G#, A# touch C#, F#, G#
const NATURAL_INDEX_BY_PC = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
const ACCIDENTAL_OFFSET_BY_PC = { 1: 0.5, 3: 1.5, 6: 3.5, 8: 4.5, 10: 5.5 };

const MIN_MIDI = 24; // C1 (Percussion Octave C1–B1; Tonal C2–G7 starts at 36)
const MAX_MIDI = 103; // G7
const MIN_BASE_OCTAVE_MIDI = 24; // C1–B3
const MAX_BASE_OCTAVE_MIDI = 72; // C5–B7
const VISIBLE_OCTAVES = 3; // 36 chromatic keys (21 natural keys wide)

const PREFS_STORAGE_KEY = 'everytone_prefs_v2';
const CATEGORY_ORDER = ['strings', 'winds', 'keys', 'metal', 'glass', 'wood', 'toms', 'percussion'];

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
  chromeCollapsed: false,
  disabledVideoIds: new Set(),
  collapsedCategories: new Set(),
  videoGainOverrides: {}, // Per-video holistic gainDb persistence
  sliceToggleOverrides: {}, // Static-mode per-slice toggle persistence
  releaseSec: 0.40, // Permanent 0.40s universal audio release decay
  highpassHz: 80, // Permanent 80Hz master low-cut filter
  baseOctaveMidi: 60, // C4 (Z/X shifts visible 3-octave keyboard & QWERTY octave)
  sustainPedalDown: false,
  lastPlayedVideoId: null,
  lastPlayedSliceId: null,
  isStaticMode: false,
  assetBust: 0
};

// Track last-played slice per MIDI key for round-robin rotation when 2+ clips are ON
const lastPlayedSliceByMidi = new Map();

// ============================================================================
// Persistent Preferences (Cross-Reload Video Switch, Gain & Panel State)
// ============================================================================
function normalizeBaseOctaveMidi(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 60;
  const snapped = Math.round(n / 12) * 12;
  return Math.max(MIN_BASE_OCTAVE_MIDI, Math.min(MAX_BASE_OCTAVE_MIDI, snapped));
}

function clampVideoGainDb(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-12, Math.min(12, Math.round(n)));
}

function loadPrefsFromStorage() {
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) {
      return {
        hasSavedDisabledVideos: false,
        disabledVideoIds: [],
        videoGains: {},
        sliceToggles: {},
        chromeCollapsed: false,
        baseOctaveMidi: 60
      };
    }
    const parsed = JSON.parse(raw);
    return {
      hasSavedDisabledVideos: Array.isArray(parsed?.disabledVideoIds),
      disabledVideoIds: Array.isArray(parsed?.disabledVideoIds)
        ? parsed.disabledVideoIds.map(String)
        : [],
      videoGains:
        parsed?.videoGains && typeof parsed.videoGains === 'object' ? parsed.videoGains : {},
      sliceToggles:
        parsed?.sliceToggles && typeof parsed.sliceToggles === 'object' ? parsed.sliceToggles : {},
      chromeCollapsed: Boolean(parsed?.chromeCollapsed ?? parsed?.explorerCollapsed),
      baseOctaveMidi: normalizeBaseOctaveMidi(parsed?.baseOctaveMidi ?? 60)
    };
  } catch {
    return {
      hasSavedDisabledVideos: false,
      disabledVideoIds: [],
      videoGains: {},
      sliceToggles: {},
      chromeCollapsed: false,
      baseOctaveMidi: 60
    };
  }
}

function savePrefsToStorage() {
  try {
    const payload = {
      disabledVideoIds: Array.from(state.disabledVideoIds),
      videoGains: state.videoGainOverrides,
      sliceToggles: state.sliceToggleOverrides,
      chromeCollapsed: state.chromeCollapsed,
      baseOctaveMidi: state.baseOctaveMidi
    };
    window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(payload));
  } catch {}
}

function isVideoDisabled(videoId) {
  return Boolean(videoId && state.disabledVideoIds.has(videoId));
}

function getVideoGainDb(videoId) {
  if (!videoId) return 0;
  if (Object.prototype.hasOwnProperty.call(state.videoGainOverrides, videoId)) {
    return clampVideoGainDb(state.videoGainOverrides[videoId]);
  }
  const v = state.catalog?.videos?.find(item => item.id === videoId);
  return clampVideoGainDb(v?.gainDb ?? 0);
}

function formatSignedDb(db) {
  const n = clampVideoGainDb(db);
  return n > 0 ? `+${n} dB` : `${n} dB`;
}

function getVisibleCandidatesForMidi(midi) {
  const entry = state.catalog?.keyboardMap?.[midi];
  if (!entry?.candidates?.length) return [];
  return entry.candidates.filter(c => !isVideoDisabled(c.videoId));
}

// ============================================================================
// Pitch & Chromatic Color Helpers
// ============================================================================
function midiToName(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

function getNoteColor(midi) {
  if (midi < 36) return PERC_NOTE_COLOR;
  const pc = ((midi % 12) + 12) % 12;
  return CHROMATIC_COLORS[pc];
}

function grayScreenSpecPixel(norm) {
  const t = Math.max(0, Math.min(1, norm));
  if (t <= 0.025) return [0, 0, 0, 0];
  const g = Math.pow((t - 0.025) / 0.975, 1.15);
  const alpha = Math.max(0, Math.min(244, Math.round(g * 244)));
  return [238, 240, 244, alpha];
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
// Three.js 3D Stage + 3 Foreground Slots (0.20s Fade-Out) + Grayscale Screen Spectrograms
// ============================================================================
const STAGE_SLOT_COUNT = 3;
const STAGE_FADE_OUT_MS = 200; // 0.20s smooth visual fade-out on note release

// Cropped low-rumble (< 130 Hz) + Mel-like perceptual frequency warp
const SPEC_MIN_FREQ = 130;
const SPEC_MAX_FREQ = 4800;
const MINI_SPEC_MAX_FREQ = 2800; // Tighter upper bound on flush stage spectrograms so harmonics hug the video edge
const SPEC_WARP_HZ = 160;
const SPEC_WARP_MIN = Math.log(1 + SPEC_MIN_FREQ / SPEC_WARP_HZ);
const SPEC_WARP_MAX = Math.log(1 + SPEC_MAX_FREQ / SPEC_WARP_HZ);
const MINI_WARP_MAX = Math.log(1 + MINI_SPEC_MAX_FREQ / SPEC_WARP_HZ);

function specFreqToNormY(freq) {
  const f = Math.max(SPEC_MIN_FREQ, Math.min(SPEC_MAX_FREQ, freq));
  return (Math.log(1 + f / SPEC_WARP_HZ) - SPEC_WARP_MIN) / (SPEC_WARP_MAX - SPEC_WARP_MIN);
}

function specNormYToFreq(normY) {
  const u = Math.max(0, Math.min(1, normY));
  return SPEC_WARP_HZ * (Math.exp(SPEC_WARP_MIN + u * (SPEC_WARP_MAX - SPEC_WARP_MIN)) - 1);
}

function miniSpecFreqToNormY(freq) {
  const f = Math.max(SPEC_MIN_FREQ, Math.min(MINI_SPEC_MAX_FREQ, freq));
  return (Math.log(1 + f / SPEC_WARP_HZ) - SPEC_WARP_MIN) / (MINI_WARP_MAX - SPEC_WARP_MIN);
}

function miniSpecNormYToFreq(normY) {
  const u = Math.max(0, Math.min(1, normY));
  return SPEC_WARP_HZ * (Math.exp(SPEC_WARP_MIN + u * (MINI_WARP_MAX - SPEC_WARP_MIN)) - 1);
}

let stageSlotSeq = 0;
let currentStageTileSize = 260;
let currentMiniSpecH = 80;
let miniSpecAnimId = null;
let threeStage = null;
const miniSpecBitmapCache = new Map();

const stageSlots = [
  { occupied: false, fadingOut: false, fadeTimer: null, seq: 0, token: null, sliceKey: null, videoEl: null, voice: null, miniBitmap: null },
  { occupied: false, fadingOut: false, fadeTimer: null, seq: 0, token: null, sliceKey: null, videoEl: null, voice: null, miniBitmap: null },
  { occupied: false, fadingOut: false, fadeTimer: null, seq: 0, token: null, sliceKey: null, videoEl: null, voice: null, miniBitmap: null }
];

function getActiveStageSliceIds() {
  const set = new Set();
  for (let i = 0; i < STAGE_SLOT_COUNT; i++) {
    if (stageSlots[i].occupied && !stageSlots[i].fadingOut && stageSlots[i].sliceKey) {
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
    if (found) {
      if (isVideoDisabled(found.videoId)) return null;
      return found;
    }
  }
  for (const v of state.catalog.videos || []) {
    if (v.deleted || isVideoDisabled(v.id)) continue;
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

  const stageW = Math.max(320, stageEl.clientWidth);
  const stageH = Math.max(260, stageEl.clientHeight);
  const gap = stageW < 920 ? 14 : 20;
  const specRatio = 0.155; // ~50% as tall as before, flush directly beneath each video
  const marginY = Math.max(20, Math.round(stageH * 0.045));
  const betweenGap = Math.max(18, Math.round(stageH * 0.028));

  // Reserve ~58% of vertical stage space for the 3-up videos + flush spectrograms,
  // leaving ~42% strictly below for the wide non-overlapping 3D grid of tiles/dots
  const usableH = Math.max(220, stageH - marginY * 2 - betweenGap);
  const topBudgetH = Math.floor(usableH * 0.58);
  const maxSideByH = Math.floor(topBudgetH / (1 + specRatio));

  const padX = Math.max(56, Math.round(stageW * 0.11));
  const availW = Math.max(240, stageW - padX * 2 - gap * (STAGE_SLOT_COUNT - 1));
  const side = Math.max(96, Math.min(316, Math.floor(Math.min(maxSideByH, availW / STAGE_SLOT_COUNT))));
  const specH = Math.max(26, Math.round(side * specRatio));
  const stripW = side * STAGE_SLOT_COUNT + gap * (STAGE_SLOT_COUNT - 1);
  const topStripH = side + specH;

  currentStageTileSize = side;
  currentMiniSpecH = specH;

  stageEl.style.setProperty('--tile-size', `${side}px`);
  stageEl.style.setProperty('--spec-height', `${specH}px`);
  stageEl.style.setProperty('--slot-gap', `${gap}px`);
  stageEl.style.setProperty('--strip-width', `${stripW}px`);

  const gridLayout = threeStage?.setStageLayoutSpec({
    stripW,
    topStripH,
    betweenGap,
    marginY
  });
  const stripTop = gridLayout?.stackTopY ?? marginY;
  stageEl.style.setProperty('--strip-top', `${stripTop}px`);
}

window.addEventListener('resize', updateStageTileSizes);

function getSliceIdentityKey(slice) {
  return String(slice?.sliceId || slice?.id || slice?.videoUrl || '');
}

function allocateStageSlotIndex(sliceKey) {
  // 1. Re-triggering the same sample overrides its own slot (including if currently fading out)
  if (sliceKey) {
    for (let i = 0; i < STAGE_SLOT_COUNT; i++) {
      if (stageSlots[i].occupied && stageSlots[i].sliceKey === sliceKey) {
        return i;
      }
    }
  }
  // 2. Empty slot
  for (let i = 0; i < STAGE_SLOT_COUNT; i++) {
    if (!stageSlots[i].occupied) return i;
  }
  // 3. Interrupt a slot that is already fading out
  let oldestFadingIdx = -1;
  for (let i = 0; i < STAGE_SLOT_COUNT; i++) {
    if (stageSlots[i].fadingOut) {
      if (oldestFadingIdx === -1 || stageSlots[i].seq < stageSlots[oldestFadingIdx].seq) {
        oldestFadingIdx = i;
      }
    }
  }
  if (oldestFadingIdx !== -1) return oldestFadingIdx;

  // 4. Steal oldest frozen freeze-frame slot
  let oldestFrozenIdx = -1;
  for (let i = 0; i < STAGE_SLOT_COUNT; i++) {
    if (stageSlots[i].voice?.audioCompleted) {
      if (oldestFrozenIdx === -1 || stageSlots[i].seq < stageSlots[oldestFrozenIdx].seq) {
        oldestFrozenIdx = i;
      }
    }
  }
  if (oldestFrozenIdx !== -1) return oldestFrozenIdx;

  // 5. Steal oldest playing slot
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
  threeStage?.notifyActivity();
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
  if (prevSlot.fadeTimer) {
    clearTimeout(prevSlot.fadeTimer);
    prevSlot.fadeTimer = null;
  }
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

  // Interrupt any ongoing fade-out and pop on immediately at 100% opacity
  unitEl.classList.remove('is-fading-out');
  unitEl.classList.add('is-occupied');

  stageSlots[slotIdx] = {
    occupied: true,
    fadingOut: false,
    fadeTimer: null,
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

  threeStage?.notifyActivity();

  return { slotIdx, token, tile: videoWrap, videoEl };
}

function fadeOutStageTile(tileObj) {
  if (!tileObj || tileObj.slotIdx === undefined) return;
  const { slotIdx, token } = tileObj;
  const slotState = stageSlots[slotIdx];
  if (!slotState || slotState.token !== token) return;
  if (slotState.fadingOut) return;

  slotState.fadingOut = true;
  const grid = document.getElementById('polyVideoGrid');
  const unitEl = grid?.querySelector(`.stage-slot-unit[data-slot="${slotIdx}"]`);
  if (unitEl) {
    // Do NOT pause videoEl: if frozen at end frame, stays frozen; if still playing, keeps playing while fading out!
    unitEl.classList.add('is-fading-out');
  }

  threeStage?.notifyActivity();
  ensureMiniSpecAnimLoop();

  slotState.fadeTimer = setTimeout(() => {
    removeStageTile(tileObj);
  }, STAGE_FADE_OUT_MS + 10);
}

function removeStageTile(tileObj) {
  if (!tileObj || tileObj.slotIdx === undefined) return;
  const { slotIdx, token } = tileObj;
  const slotState = stageSlots[slotIdx];
  if (!slotState || slotState.token !== token) return;

  if (slotState.fadeTimer) {
    clearTimeout(slotState.fadeTimer);
    slotState.fadeTimer = null;
  }

  try {
    tileObj.videoEl?.pause();
  } catch {}

  const grid = document.getElementById('polyVideoGrid');
  const unitEl = grid?.querySelector(`.stage-slot-unit[data-slot="${slotIdx}"]`);
  const videoWrap = unitEl?.querySelector('.stage-slot-video');
  if (videoWrap) {
    videoWrap.innerHTML = '';
  }
  unitEl?.classList.remove('is-occupied', 'is-fading-out');
  clearSlotMiniSpec(slotIdx);

  stageSlots[slotIdx] = {
    occupied: false,
    fadingOut: false,
    fadeTimer: null,
    seq: 0,
    token: null,
    sliceKey: null,
    videoEl: null,
    voice: null,
    miniBitmap: null
  };

  threeStage?.notifyActivity();
}

function buildMiniSpectrogramBitmap(buffer, playbackRate = 1.0, trimIn = 0, bufferSpanSec = null) {
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
  const minBin = Math.max(1, Math.floor((SPEC_MIN_FREQ * fftSizeSpec) / effectiveSr));
  const maxBin = Math.min(half - 1, Math.ceil((MINI_SPEC_MAX_FREQ * fftSizeSpec) / effectiveSr));
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
      if (k >= minBin && k <= maxBin && db > globalMaxDb) {
        globalMaxDb = db;
      }
    }
    colMags[x] = dbArr;
  }

  const floorDb = globalMaxDb - 44;
  for (let x = 0; x < W; x++) {
    const dbArr = colMags[x];
    for (let y = 0; y < H; y++) {
      const normY = 1 - y / (H - 1);
      const freq = miniSpecNormYToFreq(normY);
      const exactBin = (freq * fftSizeSpec) / effectiveSr;
      const b0 = Math.max(1, Math.min(half - 2, Math.floor(exactBin)));
      const frac = exactBin - b0;
      const db = dbArr[b0] * (1 - frac) + dbArr[b0 + 1] * frac;
      const norm = (db - floorDb) / (globalMaxDb - floorDb + 1e-5);
      const [r, g, b, a] = grayScreenSpecPixel(norm);
      const idx = (y * W + x) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = a;
    }
  }
  ctx.putImageData(imgData, 0, 0);
  return c;
}

function computeVoiceStripeAlpha(voice, now) {
  if (!voice) return 0;
  if (voice.releaseStartCtxTime !== null) {
    const dt = Math.max(0, now - voice.releaseStartCtxTime);
    const rel = Math.max(0.025, voice.releaseDur || state.releaseSec);
    return Math.max(0, Math.min(1, 1 - dt / rel));
  }
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
  ctx.clearRect(0, 0, cssW, cssH);

  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(slot.miniBitmap, 0, 0, cssW, cssH);

  if (slot.voice.isPerc) {
    const elapsed = Math.max(0, now - slot.voice.startedAt);
    const progress = Math.max(0, Math.min(1, elapsed / Math.max(0.05, slot.voice.naturalDur)));
    const xPos = progress * (cssW - 1);
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(xPos, 0);
    ctx.lineTo(xPos, cssH);
    ctx.stroke();
    ctx.restore();
  } else {
    const f0Hz = slot.voice.f0Hz;
    const stripeAlpha = computeVoiceStripeAlpha(slot.voice, now);
    if (stripeAlpha > 0.005 && f0Hz >= 50 && f0Hz <= MINI_SPEC_MAX_FREQ * 1.15) {
      const normY = miniSpecFreqToNormY(f0Hz);
      const yF0 = Math.max(2, Math.min(cssH - 2, (1 - normY) * (cssH - 1)));
      ctx.save();
      ctx.globalAlpha = stripeAlpha;
      ctx.strokeStyle = slot.voice.noteColor || '#ffffff';
      ctx.lineWidth = 2.0;
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
  const cacheKey = `${slice.audioUrl}__gray__${rate.toFixed(4)}__${tIn.toFixed(2)}__${bSpan.toFixed(2)}`;
  let bmp = miniSpecBitmapCache.get(cacheKey);
  if (!bmp) {
    bmp = buildMiniSpectrogramBitmap(buffer, rate, tIn, bSpan);
    miniSpecBitmapCache.set(cacheKey, bmp);
  }

  slotState.voice = voice;
  slotState.miniBitmap = bmp;

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
      if (!slot.voice.audioCompleted || slot.fadingOut) {
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

  if (!slice || isVideoDisabled(slice.videoId)) {
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
  threeStage?.notifyActivity();

  try {
    const buffer = await loadAudioBuffer(slice.audioUrl);
    if (voice.released || isVideoDisabled(slice.videoId)) {
      activeVoices.delete(triggerId);
      if (midi !== null && !isMidiStillHeld(midi)) setKeyActiveClass(midi, false);
      threeStage?.notifyActivity();
      return;
    }

    const tileObj = createStageSquareTile(slice, playbackRate);
    voice.tileObj = tileObj;

    const now = ctx.currentTime;
    const gainDb = getVideoGainDb(slice.videoId);
    const peakGain = Math.min(1.85, 0.86 * velocity * Math.pow(10, gainDb / 20));

    const rawLimit = Math.min(MAX_CLIP_DUR, Number(slice.rawDurSec ?? buffer.duration), buffer.duration);
    const trimIn = Math.max(0, Math.min(Math.max(0, rawLimit - 0.08), Number(slice.trimIn ?? 0)));
    const trimOut = Math.max(trimIn + 0.08, Math.min(rawLimit, Number(slice.trimOut ?? rawLimit)));
    const unpitchedSpan = Math.max(0.08, trimOut - trimIn);

    const playDur = Math.min(MAX_CLIP_DUR, unpitchedSpan / playbackRate);
    const bufferPlaySpan = Math.min(buffer.duration - trimIn, playDur * playbackRate);

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
    threeStage?.notifyActivity();
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

  if (voice.audioCompleted || (voice.startedAt && voice.naturalDur && now - voice.startedAt >= voice.naturalDur)) {
    voice.audioCompleted = true;
    voice.releaseStartCtxTime = now;
    voice.releaseDur = 0.2;
    if (voice.tileObj) {
      fadeOutStageTile(voice.tileObj);
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

  // Immediately begin smooth 0.20s visual fade-out while video continues playing!
  if (voice.tileObj) {
    fadeOutStageTile(voice.tileObj);
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
  const el = document.querySelector(`.wf-key[data-midi="${midi}"]`);
  if (el) el.classList.toggle('active-play', active);
}

// ============================================================================
// Spectrogram FFT & Offscreen Renderer (2048-pt FFT for Crisp Mid/Low Resolution)
// ============================================================================
const fftSizeSpec = 2048;
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

function grayInspectorColor(norm) {
  const t = Math.max(0, Math.min(1, norm));
  if (t <= 0.02) return [0, 0, 0];
  const g = Math.pow((t - 0.02) / 0.98, 1.12);
  const v = Math.round(g * 244);
  return [v, v, v];
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

  const imgData = stftCtx.createImageData(W, H);
  const data = imgData.data;

  const real = new Float32Array(fftSizeSpec);
  const imag = new Float32Array(fftSizeSpec);
  const half = fftSizeSpec >> 1;
  const minBin = Math.max(1, Math.floor((SPEC_MIN_FREQ * fftSizeSpec) / effectiveSr));
  const maxBin = Math.min(half - 1, Math.ceil((SPEC_MAX_FREQ * fftSizeSpec) / effectiveSr));
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
      if (k >= minBin && k <= maxBin && db > globalMaxDb) {
        globalMaxDb = db;
      }
    }
    colMags[x] = dbArr;
  }

  const floorDb = globalMaxDb - 52;
  for (let x = 0; x < W; x++) {
    const dbArr = colMags[x];
    for (let y = 0; y < H; y++) {
      const normY = 1 - y / (H - 1);
      const freq = specNormYToFreq(normY);
      const exactBin = (freq * fftSizeSpec) / effectiveSr;
      const b0 = Math.max(1, Math.min(half - 2, Math.floor(exactBin)));
      const frac = exactBin - b0;
      const db = dbArr[b0] * (1 - frac) + dbArr[b0 + 1] * frac;
      const norm = (db - floorDb) / (globalMaxDb - floorDb + 1e-5);
      const [r, g, b] = grayInspectorColor(norm);
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

  const gridFreqs = [150, 300, 600, 1200, 2400, 4200];
  ctx.font = '10.5px "Google Sans", -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 1;

  for (const gf of gridFreqs) {
    const y = H - 1 - specFreqToNormY(gf) * (H - 1);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
    ctx.fillText(`${gf}Hz`, 5, Math.max(10, y - 4));
  }

  if (showHarmonics && f0Hz >= 50 && f0Hz <= SPEC_MAX_FREQ) {
    const yF0 = Math.max(2, Math.min(H - 2, H - 1 - specFreqToNormY(f0Hz) * (H - 1)));
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 1.85;
    ctx.beginPath();
    ctx.moveTo(0, yF0);
    ctx.lineTo(W, yF0);
    ctx.stroke();

    const tagText = `f0: ${f0Label} (${f0Hz}Hz)`;
    ctx.font = '600 10.5px "Google Sans", -apple-system, BlinkMacSystemFont, sans-serif';
    const tagW = Math.ceil(ctx.measureText(tagText).width) + 12;
    ctx.fillStyle = '#22c55e';
    ctx.fillRect(W - tagW - 5, Math.max(2, yF0 - 16), tagW, 15);
    ctx.fillStyle = '#04130d';
    ctx.fillText(tagText, W - tagW, Math.max(13, yF0 - 5));

    ctx.strokeStyle = 'rgba(245, 158, 11, 0.72)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    for (let h = 2; h <= 4; h++) {
      const hf = f0Hz * h;
      if (hf >= SPEC_MIN_FREQ && hf <= SPEC_MAX_FREQ) {
        const yh = H - 1 - specFreqToNormY(hf) * (H - 1);
        ctx.beginPath();
        ctx.moveTo(0, yh);
        ctx.lineTo(W, yh);
        ctx.stroke();
        ctx.fillStyle = '#fbbf24';
        ctx.fillText(`${h}f0`, W - 30, Math.max(10, yh - 3));
      }
    }
    ctx.setLineDash([]);
  }

  return offCanvas;
}

// ============================================================================
// Unified Hamburger Toggle: Left Video File Explorer + Bottom Transport Dock
// ============================================================================
function setChromeCollapsed(nextCollapsed) {
  state.chromeCollapsed = Boolean(nextCollapsed);
  savePrefsToStorage();

  const explorerEl = document.getElementById('fileExplorer');
  const dockEl = document.getElementById('transportDock');
  const toggleBtn = document.getElementById('chromeToggleBtn');

  if (explorerEl) {
    explorerEl.classList.toggle('collapsed', state.chromeCollapsed);
  }
  if (dockEl) {
    dockEl.classList.toggle('collapsed', state.chromeCollapsed);
  }
  if (toggleBtn) {
    toggleBtn.classList.toggle('is-collapsed', state.chromeCollapsed);
    toggleBtn.setAttribute('aria-expanded', state.chromeCollapsed ? 'false' : 'true');
  }

  requestAnimationFrame(() => updateStageTileSizes());
  setTimeout(() => updateStageTileSizes(), 235);
}

function setVideosEnabled(videoIds, enabled) {
  if (!Array.isArray(videoIds) || videoIds.length === 0) return;
  const isEn = Boolean(enabled);
  const idSet = new Set(videoIds.map(String));

  for (const id of idSet) {
    if (isEn) state.disabledVideoIds.delete(id);
    else state.disabledVideoIds.add(id);
  }

  for (const v of state.catalog?.videos || []) {
    if (idSet.has(v.id)) {
      v.enabled = isEn;
    }
  }

  // If videos were muted, cleanly fade out any voices currently playing from them
  if (!isEn) {
    for (const [trigId, voice] of Array.from(activeVoices.entries())) {
      if (voice.slice?.videoId && idSet.has(voice.slice.videoId)) {
        releaseHeldVoice(trigId, 0.08);
      }
    }
  }

  savePrefsToStorage();
  refreshAllUI();

  if (!state.isStaticMode) {
    fetch('./api/video/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoIds: Array.from(idSet), enabled: isEn })
    }).catch(() => {});
  }
}

function renderFileExplorer() {
  const listEl = document.getElementById('explorerList');
  const countEl = document.getElementById('explorerActiveCount');
  if (!listEl) return;

  const prevScrollTop = listEl.scrollTop;
  const activeVideos = (state.catalog?.videos || [])
    .filter(v => !v.deleted)
    .slice()
    .sort((a, b) => String(a.slug || '').localeCompare(String(b.slug || '')));

  const enabledTotal = activeVideos.filter(v => !isVideoDisabled(v.id)).length;
  if (countEl) {
    countEl.textContent = `${enabledTotal}/${activeVideos.length}`;
  }

  const byCat = new Map();
  for (const v of activeVideos) {
    const cat = String(v.category || 'other').toLowerCase();
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(v);
  }

  const orderedCats = [
    ...CATEGORY_ORDER.filter(c => byCat.has(c)),
    ...Array.from(byCat.keys())
      .filter(c => !CATEGORY_ORDER.includes(c))
      .sort()
  ];

  listEl.innerHTML = '';

  for (const cat of orderedCats) {
    const catVideos = byCat.get(cat) || [];
    if (catVideos.length === 0) continue;

    const enabledInCat = catVideos.filter(v => !isVideoDisabled(v.id)).length;
    const isCollapsed = state.collapsedCategories.has(cat);

    const groupEl = document.createElement('div');
    groupEl.className = `explorer-cat-group${isCollapsed ? ' is-collapsed' : ''}`;
    groupEl.dataset.category = cat;

    const headerEl = document.createElement('div');
    headerEl.className = 'explorer-cat-header';

    let catSwitchClass = 'ui-switch';
    if (enabledInCat === catVideos.length) {
      catSwitchClass = 'ui-switch is-on';
    } else if (enabledInCat > 0) {
      catSwitchClass = 'ui-switch is-partial';
    }

    headerEl.innerHTML = `
      <div class="explorer-cat-left">
        <span class="explorer-cat-caret">▾</span>
        <span class="explorer-cat-name">${cat}</span>
        <span class="explorer-cat-count">${enabledInCat}/${catVideos.length}</span>
      </div>
      <button
        type="button"
        class="${catSwitchClass}"
        role="switch"
        aria-checked="${enabledInCat > 0 ? 'true' : 'false'}"
        title="${enabledInCat > 0 ? `Mute all ${cat} videos` : `Enable all ${cat} videos`}"
      ></button>
    `;

    headerEl.addEventListener('click', e => {
      if (e.target.closest('.ui-switch')) return;
      if (state.collapsedCategories.has(cat)) state.collapsedCategories.delete(cat);
      else state.collapsedCategories.add(cat);
      groupEl.classList.toggle('is-collapsed', state.collapsedCategories.has(cat));
    });

    const catSwitchBtn = headerEl.querySelector('.ui-switch');
    catSwitchBtn.addEventListener('click', e => {
      e.stopPropagation();
      const nextEnabled = enabledInCat === 0;
      setVideosEnabled(
        catVideos.map(v => v.id),
        nextEnabled
      );
    });

    const itemsEl = document.createElement('div');
    itemsEl.className = 'explorer-cat-items';

    for (const v of catVideos) {
      const muted = isVideoDisabled(v.id);
      const sliceCount = (v.slices || []).filter(s => !s.deleted).length;
      const gainDb = getVideoGainDb(v.id);
      const gainTagHtml =
        gainDb !== 0
          ? `<span class="explorer-gain-tag" title="Holistic video volume: ${formatSignedDb(gainDb)}">${gainDb > 0 ? `+${gainDb}` : gainDb}dB</span>`
          : '';

      const rowEl = document.createElement('div');
      rowEl.className = `explorer-video-row${muted ? ' is-muted' : ''}`;
      rowEl.dataset.videoId = v.id;
      rowEl.title = `${v.slug} (${sliceCount} sample${sliceCount === 1 ? '' : 's'}${gainDb !== 0 ? ` · ${formatSignedDb(gainDb)}` : ''}) — click to inspect`;

      rowEl.innerHTML = `
        <span class="explorer-video-label">${v.slug}</span>
        ${gainTagHtml}
        <span class="explorer-video-meta">${sliceCount}</span>
        <button
          type="button"
          class="ui-switch${muted ? '' : ' is-on'}"
          role="switch"
          aria-checked="${muted ? 'false' : 'true'}"
          title="${muted ? `Enable ${v.slug}` : `Mute ${v.slug}`}"
        ></button>
      `;

      const switchBtn = rowEl.querySelector('.ui-switch');
      switchBtn.addEventListener('click', e => {
        e.stopPropagation();
        setVideosEnabled([v.id], muted);
      });

      rowEl.addEventListener('click', e => {
        if (e.target.closest('.ui-switch')) return;
        e.stopPropagation();
        openVideoInspectorModal(v.id);
      });

      itemsEl.appendChild(rowEl);
    }

    groupEl.appendChild(headerEl);
    groupEl.appendChild(itemsEl);
    listEl.appendChild(groupEl);
  }

  listEl.scrollTop = prevScrollTop;
}

// ============================================================================
// Piano Key & Multi-Candidate Sequential Round-Robin Trigger Helpers
// ============================================================================
function pickEnabledCandidateForMidi(midi) {
  const enabledCands = getVisibleCandidatesForMidi(midi).filter(c => c.enabled);
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

  const cand = pickEnabledCandidateForMidi(midi);
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

  const visCands = getVisibleCandidatesForMidi(clamped);
  if (visCands.length > 0) {
    const firstEnabledIdx = visCands.findIndex(c => c.enabled);
    state.auditionIndex = firstEnabledIdx >= 0 ? firstEnabledIdx : 0;
  } else {
    state.auditionIndex = 0;
  }

  document.querySelectorAll('.wf-key').forEach(el => {
    const m = Number(el.dataset.midi);
    el.classList.toggle('selected-key', m === clamped);
  });

  renderSelectedKeyDeck();

  if (shouldTapPreview) {
    triggerDefaultPianoGate('arrow_preview', clamped, 0.9, false);
  }
}

// ============================================================================
// Wireframe Keyline Chromatic Keyboard (Decluttered: No Dots, No Note Labels)
// ============================================================================
let wfKeyboardDragActive = false;
let wfKeyboardDragMidi = null;
let wfKeyboardDragStartMs = 0;

function shiftKeyboardOctave(deltaOctaves) {
  const nextBase = normalizeBaseOctaveMidi(state.baseOctaveMidi + deltaOctaves * 12);
  if (nextBase === state.baseOctaveMidi) return;
  state.baseOctaveMidi = nextBase;
  savePrefsToStorage();
  renderPianoKeyboard();
}

function renderPianoKeyboard() {
  const container = document.getElementById('pianoKeyboard');
  if (!container) return;
  container.innerHTML = '';

  const startMidi = normalizeBaseOctaveMidi(state.baseOctaveMidi);
  const endMidi = startMidi + VISIBLE_OCTAVES * 12 - 1;

  const rangeLabel = document.getElementById('octaveRangeLabel');
  if (rangeLabel) {
    rangeLabel.textContent = `${midiToName(startMidi)}–${midiToName(endMidi)}`;
  }
  const octDownBtn = document.getElementById('octDownBtn');
  if (octDownBtn) octDownBtn.disabled = startMidi <= MIN_BASE_OCTAVE_MIDI;
  const octUpBtn = document.getElementById('octUpBtn');
  if (octUpBtn) octUpBtn.disabled = startMidi >= MAX_BASE_OCTAVE_MIDI;

  const totalNaturals = VISIBLE_OCTAVES * 7; // 21 equal-width units
  const totalW = Math.round(container.clientWidth || 0);
  const unitWidthPct = 100 / totalNaturals;
  const xEdgePx = u => Math.round((u / totalNaturals) * totalW);
  const keyMap = state.catalog?.keyboardMap || {};

  for (let i = 0; i < VISIBLE_OCTAVES * 12; i++) {
    const midi = startMidi + i;
    const octIdx = Math.floor(i / 12);
    const pc = i % 12;
    const isAccidental = ACCIDENTAL_SEMITONES.has(pc);
    const inRange = midi >= MIN_MIDI && midi <= MAX_MIDI;

    const visCands = inRange ? getVisibleCandidatesForMidi(midi) : [];
    const candCount = visCands.length;
    const enabledCount = visCands.filter(c => c.enabled).length;

    const leftUnits = isAccidental
      ? octIdx * 7 + ACCIDENTAL_OFFSET_BY_PC[pc]
      : octIdx * 7 + NATURAL_INDEX_BY_PC[pc];

    const isFirstNatural = !isAccidental && i === 0;

    const keyEl = document.createElement('div');
    keyEl.className = [
      'wf-key',
      isAccidental ? 'accidental' : 'natural',
      isAccidental && TOUCH_LEFT_ACCIDENTALS.has(pc) ? 'touch-left' : '',
      isFirstNatural ? 'first-natural' : '',
      midi === state.selectedMidi ? 'selected-key' : '',
      isMidiStillHeld(midi) ? 'active-play' : ''
    ]
      .filter(Boolean)
      .join(' ');

    keyEl.dataset.midi = String(midi);
    if (totalW > 0) {
      const leftPx = xEdgePx(leftUnits);
      const rightPx = xEdgePx(leftUnits + 1);
      keyEl.style.left = `${leftPx}px`;
      keyEl.style.width = `${Math.max(1, rightPx - leftPx)}px`;
    } else {
      keyEl.style.left = `${(leftUnits * unitWidthPct).toFixed(4)}%`;
      keyEl.style.width = `${unitWidthPct.toFixed(4)}%`;
    }
    keyEl.style.setProperty('--note-color', getNoteColor(midi));

    const fullNoteName = midiToName(midi);
    const entry = keyMap[midi];
    const roleMeta = midi < 36 ? entry?.percRole || 'Percussion' : `${midiToFreq(midi)} Hz`;

    if (!inRange) {
      keyEl.title = `${fullNoteName} (out of range)`;
    } else if (enabledCount > 0) {
      keyEl.title = `${fullNoteName} · ${roleMeta} — ${enabledCount} / ${candCount} active`;
    } else if (candCount > 0) {
      keyEl.title = `${fullNoteName} · ${roleMeta} — Bypassed (${candCount})`;
    } else {
      keyEl.title = `${fullNoteName} (${roleMeta})`;
    }

    container.appendChild(keyEl);
  }
}

// ============================================================================
// Center Bottom Zone: Single-Note Sample Controls (Decluttered Strip)
// ============================================================================
function getCandidatesForSelectedKey() {
  return getVisibleCandidatesForMidi(state.selectedMidi);
}

function renderSelectedKeyDeck() {
  const midi = state.selectedMidi;
  const isPercKey = midi < 36;
  const noteName = midiToName(midi);
  const freqStr = midiToFreq(midi);
  const entry = state.catalog?.keyboardMap?.[midi];

  const grid = document.getElementById('candidatesGrid');
  if (!grid) return;
  grid.innerHTML = '';

  const candidates = getCandidatesForSelectedKey();
  if (state.auditionIndex >= candidates.length) {
    state.auditionIndex = 0;
  }

  if (candidates.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-key-state';
    const metaLabel = isPercKey ? entry?.percRole || 'Percussion' : `${freqStr} Hz`;
    emptyDiv.textContent = `${noteName} · ${metaLabel} — no active video samples`;
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
      <div class="cand-thumb-wrap" title="Click to inspect sample (${cand.videoSlug} · ${noteName})">
        <img src="${withBust(cand.thumbUrl)}" alt="${cand.videoSlug}" loading="lazy" />
      </div>
      <div class="cand-slug-title" title="${cand.videoSlug}">${cand.videoSlug}</div>
      <button
        class="ui-switch${isEnabled ? ' is-on' : ''}"
        type="button"
        role="switch"
        aria-checked="${isEnabled ? 'true' : 'false'}"
        title="${isEnabled ? `Mute sample (${cand.videoSlug})` : `Enable sample (${cand.videoSlug})`}"
      ></button>
    `;

    const switchBtn = card.querySelector('.ui-switch');
    switchBtn.addEventListener('click', async e => {
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

    card.addEventListener('click', e => {
      if (e.target.closest('.ui-switch')) return;
      state.auditionIndex = idx;
      document.querySelectorAll('.candidate-card').forEach((el, i) => {
        el.classList.toggle('audition-focus', i === idx);
      });
      openTrimModal(cand.videoId, cand.sliceId, cand.playbackRate || 1.0);
    });

    grid.appendChild(card);
  });
}

// ============================================================================
// Video File Inspector Overlay (Holistic Per-Video Integer dB Volume + Rename + Slices)
// ============================================================================
const videoInspState = {
  open: false,
  video: null,
  selectedSliceId: null,
  previewRaf: null,
  previewAudioSrc: null,
  previewGainNode: null,
  previewStartCtxTime: 0,
  previewPlayDur: 0,
  trashConfirmArmed: false,
  trashConfirmTimer: null
};

function resetVideoTrashConfirmUI() {
  videoInspState.trashConfirmArmed = false;
  if (videoInspState.trashConfirmTimer) {
    clearTimeout(videoInspState.trashConfirmTimer);
    videoInspState.trashConfirmTimer = null;
  }
  const trashBtn = document.getElementById('videoInspTrashBtn');
  if (trashBtn) {
    trashBtn.classList.remove('confirm-armed');
    trashBtn.textContent = 'Move Video to Trash';
  }
}

function stopVideoInspPreview() {
  if (videoInspState.previewRaf) {
    cancelAnimationFrame(videoInspState.previewRaf);
    videoInspState.previewRaf = null;
  }
  if (videoInspState.previewAudioSrc) {
    try {
      videoInspState.previewAudioSrc.stop();
    } catch {}
    try {
      videoInspState.previewAudioSrc.disconnect();
    } catch {}
    videoInspState.previewAudioSrc = null;
  }
  if (videoInspState.previewGainNode) {
    try {
      videoInspState.previewGainNode.disconnect();
    } catch {}
    videoInspState.previewGainNode = null;
  }
  const vid = document.getElementById('videoInspPreviewVideo');
  if (vid) {
    try {
      vid.pause();
    } catch {}
  }
  const btn = document.getElementById('videoInspPreviewBtn');
  if (btn) btn.textContent = '▶ Preview (Space)';
}

function getActiveVideoSlices(video) {
  return (video?.slices || []).filter(s => !s.deleted);
}

function selectVideoInspSlice(slice, shouldPlay = false) {
  if (!videoInspState.video || !slice) return;
  stopVideoInspPreview();
  videoInspState.selectedSliceId = slice.id;

  const slices = getActiveVideoSlices(videoInspState.video);
  const idx = Math.max(0, slices.findIndex(s => s.id === slice.id));
  const cand = findKeyboardCandidate(slice.id);
  const midi = cand?.midi ?? slice.manualMidi ?? slice.midi ?? 60;
  const noteName = cand?.isPerc || isPercussionSlice(videoInspState.video, slice) ? 'PERC' : midiToName(midi);

  const readoutEl = document.getElementById('videoInspTimeReadout');
  if (readoutEl) {
    readoutEl.textContent = `Sample #${idx + 1} · ${noteName}`;
  }

  const vidEl = document.getElementById('videoInspPreviewVideo');
  if (vidEl && slice.videoUrl) {
    const nextSrc = withBust(slice.videoUrl);
    if (vidEl.getAttribute('data-slice-id') !== slice.id) {
      vidEl.setAttribute('data-slice-id', slice.id);
      vidEl.src = nextSrc;
      vidEl.muted = true;
      vidEl.onloadedmetadata = () => {
        try {
          vidEl.currentTime = Number(cand?.trimIn ?? slice.trimIn ?? 0);
        } catch {}
      };
    } else {
      try {
        vidEl.currentTime = Number(cand?.trimIn ?? slice.trimIn ?? 0);
      } catch {}
    }
  }

  document.querySelectorAll('#videoInspSlicesList .video-slice-row').forEach(row => {
    row.classList.toggle('is-selected', row.dataset.sliceId === slice.id);
  });

  if (shouldPlay) {
    startVideoInspPreview(true);
  }
}

async function startVideoInspPreview(forceRestart = false) {
  const vid = document.getElementById('videoInspPreviewVideo');
  const video = videoInspState.video;
  if (!vid || !video) return;

  if (!forceRestart && (videoInspState.previewRaf || videoInspState.previewAudioSrc)) {
    stopVideoInspPreview();
    return;
  }
  stopVideoInspPreview();

  const slices = getActiveVideoSlices(video);
  const slice = slices.find(s => s.id === videoInspState.selectedSliceId) || slices[0];
  if (!slice) return;

  let buffer;
  try {
    buffer = await loadAudioBuffer(slice.audioUrl);
    if (!videoInspState.open || videoInspState.video?.id !== video.id) return;
  } catch {
    return;
  }

  const cand = findKeyboardCandidate(slice.id);
  const rate = Math.max(0.25, Math.min(4.0, cand?.playbackRate || 1.0));
  const rawLimit = Math.min(MAX_CLIP_DUR, buffer.duration);
  const savedIn = Number(cand?.trimIn ?? slice.trimIn ?? 0);
  const savedOut = Number(cand?.trimOut ?? slice.trimOut ?? rawLimit);
  const inSec = Math.max(0, Math.min(Math.max(0, rawLimit - 0.08), savedIn));
  const outSec = Math.max(inSec + 0.08, Math.min(rawLimit, savedOut));
  const unpitchedSpan = Math.max(0.08, outSec - inSec);

  const playDur = Math.min(MAX_CLIP_DUR, unpitchedSpan / rate);
  const bufferPlaySpan = Math.min(buffer.duration - inSec, playDur * rate);
  const effectiveOutSec = inSec + bufferPlaySpan;

  const forcedRelDur = Math.min(state.releaseSec, playDur * 0.78);
  const forcedRelStart = Math.max(0.012, playDur - forcedRelDur);

  const ctx = ensureAudioContext();
  const now = ctx.currentTime;
  const gainDb = getVideoGainDb(video.id);
  const peakGain = Math.min(1.85, 0.88 * Math.pow(10, gainDb / 20));

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

  videoInspState.previewAudioSrc = src;
  videoInspState.previewGainNode = gainNode;
  videoInspState.previewStartCtxTime = now;
  videoInspState.previewPlayDur = playDur;

  const btn = document.getElementById('videoInspPreviewBtn');
  if (btn) btn.textContent = '⏹ Stop (Space)';

  vid.muted = true;
  vid.playbackRate = rate;
  try {
    vid.currentTime = inSec;
  } catch {}
  vid.play().catch(() => {});

  const tick = () => {
    if (!videoInspState.open || !videoInspState.previewAudioSrc) {
      stopVideoInspPreview();
      return;
    }
    const elapsed = Math.max(0, ctx.currentTime - videoInspState.previewStartCtxTime);
    const bufTime = Math.min(effectiveOutSec, inSec + elapsed * rate);
    if (elapsed >= videoInspState.previewPlayDur || bufTime >= effectiveOutSec - 0.005) {
      stopVideoInspPreview();
      try {
        vid.currentTime = inSec;
      } catch {}
      return;
    }
    videoInspState.previewRaf = requestAnimationFrame(tick);
  };
  videoInspState.previewRaf = requestAnimationFrame(tick);
}

function updateVideoGainUiOnly(videoId) {
  const gainDb = getVideoGainDb(videoId);
  const readoutEl = document.getElementById('videoGainReadout');
  const sliderEl = document.getElementById('videoGainSlider');
  const zeroBtn = document.getElementById('videoGainZeroBtn');

  if (readoutEl) readoutEl.textContent = formatSignedDb(gainDb);
  if (sliderEl) sliderEl.value = String(gainDb);
  if (zeroBtn) zeroBtn.classList.toggle('hidden', gainDb === 0);
}

function setVideoGainDb(videoId, nextGainDb, persistServer = true) {
  if (!videoId) return;
  const clamped = clampVideoGainDb(nextGainDb);
  state.videoGainOverrides[videoId] = clamped;

  const video = state.catalog?.videos?.find(v => v.id === videoId);
  if (video) {
    video.gainDb = clamped;
  }

  savePrefsToStorage();
  renderFileExplorer();

  if (videoInspState.open && videoInspState.video?.id === videoId) {
    updateVideoGainUiOnly(videoId);
  }
  if (trimState.open && trimState.video?.id === videoId) {
    populateInspectorHeaderAndPeaks();
  }

  if (persistServer && !state.isStaticMode) {
    fetch('./api/video/gain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, gainDb: clamped })
    }).catch(() => {});
  }
}

function renderVideoInspectorModal() {
  const video = videoInspState.video;
  if (!video) return;

  const slugInput = document.getElementById('videoInspSlugInput');
  if (slugInput) {
    slugInput.value = video.slug || '';
    slugInput.readOnly = Boolean(state.isStaticMode);
  }

  const slices = getActiveVideoSlices(video);
  const metaPill = document.getElementById('videoInspMetaPill');
  if (metaPill) {
    const cat = String(video.category || 'other').toUpperCase();
    metaPill.textContent = `${cat} · ${slices.length} SAMPLE${slices.length === 1 ? '' : 'S'}`;
  }

  updateVideoGainUiOnly(video.id);

  const listEl = document.getElementById('videoInspSlicesList');
  if (listEl) {
    listEl.innerHTML = '';
    slices.forEach((slice, idx) => {
      const cand = findKeyboardCandidate(slice.id);
      const midi = cand?.midi ?? slice.manualMidi ?? slice.midi ?? 60;
      const isPerc = cand ? cand.isPerc : isPercussionSlice(video, slice);
      const noteColor = isPerc ? PERC_NOTE_COLOR : getNoteColor(midi);
      const noteLabel = isPerc ? `PERC (${midiToName(midi)})` : midiToName(midi);
      const dur = Number(cand?.durSec ?? slice.durSec ?? slice.rawDurSec ?? 1.0).toFixed(2);
      const shiftCents = cand?.shiftCents ?? 0;
      const shiftLabel = shiftCents === 0 ? '0c' : shiftCents > 0 ? `+${shiftCents}c` : `${shiftCents}c`;

      const row = document.createElement('div');
      row.className = `video-slice-row${slice.id === videoInspState.selectedSliceId ? ' is-selected' : ''}`;
      row.dataset.sliceId = slice.id;

      row.innerHTML = `
        <div class="video-slice-left">
          <span class="video-slice-dot" style="background:${noteColor}"></span>
          <span class="video-slice-title">Sample #${idx + 1} · ${noteLabel}</span>
          <span class="video-slice-meta">${dur}s · ${shiftLabel}</span>
        </div>
        ${
          state.isStaticMode
            ? ''
            : `<button type="button" class="video-slice-open-btn" title="Open Individual Sample Inspector">Sample ›</button>`
        }
      `;

      const openBtn = row.querySelector('.video-slice-open-btn');
      if (openBtn) {
        openBtn.addEventListener('click', e => {
          e.stopPropagation();
          const vidId = video.id;
          const slId = slice.id;
          const rate = cand?.playbackRate || 1.0;
          closeVideoInspectorModal();
          openTrimModal(vidId, slId, rate);
        });
      }

      row.addEventListener('click', () => {
        selectVideoInspSlice(slice, true);
      });

      listEl.appendChild(row);
    });
  }

  const chosen = slices.find(s => s.id === videoInspState.selectedSliceId) || slices[0];
  if (chosen) {
    selectVideoInspSlice(chosen, false);
  }
}

function openVideoInspectorModal(videoId, preferredSliceId = null) {
  const video = state.catalog?.videos?.find(v => v.id === videoId && !v.deleted);
  if (!video) return;

  if (trimState.open) {
    closeTrimModal();
  }
  stopVideoInspPreview();
  resetVideoTrashConfirmUI();

  const slices = getActiveVideoSlices(video);
  const initialSlice =
    (preferredSliceId && slices.find(s => s.id === preferredSliceId)) || slices[0] || null;

  videoInspState.open = true;
  videoInspState.video = video;
  videoInspState.selectedSliceId = initialSlice ? initialSlice.id : null;

  const vidEl = document.getElementById('videoInspPreviewVideo');
  if (vidEl) {
    vidEl.removeAttribute('data-slice-id');
    vidEl.style.transform = '';
  }

  renderVideoInspectorModal();
  document.getElementById('videoInspectorModal')?.classList.remove('hidden');
}

function closeVideoInspectorModal() {
  stopVideoInspPreview();
  resetVideoTrashConfirmUI();
  videoInspState.open = false;
  document.getElementById('videoInspectorModal')?.classList.add('hidden');
}

// ============================================================================
// Individual Sample Inspector Overlay (Cookie-Crumb Header + Pitch Slot + Spectrogram + Trim)
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

  const playDur = Math.min(MAX_CLIP_DUR, unpitchedSpan / rate);
  const bufferPlaySpan = Math.min(buffer.duration - inSec, playDur * rate);
  const effectiveOutSec = inSec + bufferPlaySpan;

  const forcedRelDur = Math.min(state.releaseSec, playDur * 0.78);
  const forcedRelStart = Math.max(0.012, playDur - forcedRelDur);

  const gainDb = getVideoGainDb(trimState.video.id);
  const peakGain = Math.min(1.85, 0.88 * Math.pow(10, gainDb / 20));

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
    ctx.fillStyle = '#000000';
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

  const refMidi = trimState.refMidi;
  if (Number.isFinite(refMidi) && (refMidi !== trimState.assignedMidi || (isPerc && refMidi >= 36))) {
    const refFreq = Number(midiToFreq(refMidi));
    if (refFreq >= SPEC_MIN_FREQ && refFreq <= SPEC_MAX_FREQ) {
      const yRef = cssH - 1 - specFreqToNormY(refFreq) * (cssH - 1);
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
      ctx.font = '600 10.5px "Google Sans", -apple-system, BlinkMacSystemFont, sans-serif';
      const tagW = Math.ceil(ctx.measureText(refTag).width) + 10;
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(52, Math.max(2, yRef - 15), tagW, 14);
      ctx.fillStyle = '#04121d';
      ctx.fillText(refTag, 57, Math.max(12, yRef - 4));
      ctx.restore();
    }
  }

  if (leftCut > 1) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.76)';
    ctx.fillRect(0, 0, leftCut, cssH);
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(leftCut, 0);
    ctx.lineTo(leftCut, cssH);
    ctx.stroke();
  }
  if (rightKeep < cssW - 1) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.76)';
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
  return (
    trimState.inSec > 0.005 ||
    trimState.outSec < Math.max(0.08, trimState.rawDur - 0.015)
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
  ctx.fillStyle = '#000000';
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
      ctx.fillStyle = insideTrim ? '#22c55e' : 'rgba(142, 142, 142, 0.35)';
      const amp = (localPeak / maxAbs) * (midY - 6);
      const h = Math.max(2, amp * 2);
      ctx.fillRect(x, midY - h / 2, 1, h);
    }
  }

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

  ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.fillRect(0, waveAreaH, cssW, 18);
  ctx.font = '10.5px "Google Sans", -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  const endLabel = `${rawDur.toFixed(2)}s`;
  const endW = ctx.measureText(endLabel).width;
  const tickStep = rawDur <= 1.2 ? 0.25 : 0.5;
  for (let t = 0; t <= rawDur + 0.001; t += tickStep) {
    const x = (t / rawDur) * cssW;
    ctx.fillRect(Math.min(cssW - 1, x), waveAreaH, 1, 4);
    const tickLabel = `${t.toFixed(tickStep < 0.5 ? 2 : 1)}s`;
    const tickW = ctx.measureText(tickLabel).width;
    if (x + tickW + 14 < cssW - endW - 6) {
      ctx.fillText(tickLabel, x + 3, cssH - 5);
    }
  }
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

  const parentBtn = document.getElementById('sampleInspParentBtn');
  if (parentBtn) {
    const gainDb = getVideoGainDb(video.id);
    parentBtn.textContent = gainDb ? `${video.slug} (${formatSignedDb(gainDb)})` : video.slug;
  }
  const sliceLabelEl = document.getElementById('sampleInspSliceLabel');
  if (sliceLabelEl) {
    const activeSlices = getActiveVideoSlices(video);
    const sliceIdx = Math.max(0, activeSlices.findIndex(s => s.id === slice.id));
    sliceLabelEl.textContent = `Sample #${sliceIdx + 1}`;
  }

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

  const resetDspBtn = document.getElementById('inspectorResetDspBtn');
  if (resetDspBtn) {
    if (isOverridden) {
      resetDspBtn.textContent = `↺ Reset to DSP (${dspName})`;
      resetDspBtn.classList.remove('hidden');
    } else {
      resetDspBtn.classList.add('hidden');
    }
  }

  const activeShiftCents = Math.max(
    -100,
    Math.min(
      100,
      cand?.shiftCents ??
        Math.round(1200 * Math.log2(Math.max(0.25, trimState.playbackRate || 1.0)))
    )
  );
  const isUntouchedDsp =
    !Number.isFinite(slice.manualMidi) && !Number.isFinite(slice.manualTuneCents);

  const tuneSlider = document.getElementById('inspectorTuneSlider');
  if (tuneSlider) {
    tuneSlider.value = String(activeShiftCents);
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

  if (videoInspState.open) {
    closeVideoInspectorModal();
  }

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
// API & State Refresh
// ============================================================================
function applySliceToggleLocally(midi, sliceId, enabled) {
  const isEn = Boolean(enabled);
  state.sliceToggleOverrides[sliceId] = isEn;
  savePrefsToStorage();

  const entry = state.catalog?.keyboardMap?.[midi];
  if (entry) {
    for (const c of entry.candidates || []) {
      if (c.sliceId === sliceId) {
        c.enabled = isEn;
      }
    }
    entry.enabledSliceIds = (entry.candidates || []).filter(c => c.enabled).map(c => c.sliceId);
    entry.enabledCount = entry.enabledSliceIds.length;
    entry.primary = (entry.candidates || []).find(c => c.enabled) || null;
    entry.activeSliceId = entry.primary ? entry.primary.sliceId : null;
    entry.isCleared = entry.enabledCount === 0;
  }
}

async function apiPost(url, body) {
  if (url === '/api/keyboard/toggle' && body) {
    applySliceToggleLocally(body.midi, body.sliceId, body.enabled);
    if (state.isStaticMode) {
      refreshAllUI();
      return { ok: true };
    }
    const res = await fetch(resolveAssetUrl(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.ok) {
      state.catalog = await res.json();
    }
    refreshAllUI();
    return res;
  }

  if (state.isStaticMode) return { ok: true };

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
  renderFileExplorer();
  renderPianoKeyboard();
  renderSelectedKeyDeck();
  threeStage?.syncCatalog(state.catalog);
  updateStageTileSizes();
}

function stepToAdjacentPopulatedKey(dir) {
  let m = state.selectedMidi + dir;
  while (m >= MIN_MIDI && m <= MAX_MIDI) {
    if (getVisibleCandidatesForMidi(m).length > 0) {
      selectKeyForConfig(m, true);
      return;
    }
    m += dir;
  }
}

// ============================================================================
// Left Bottom Zone: MIDI File Transport & Scrubbable Play Bar
// ============================================================================
const midiPlayer = {
  fileName: '',
  parsed: null,
  playing: false,
  scrubbing: false,
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
  const scrubTrack = document.getElementById('midiScrubTrack');
  const scrubFill = document.getElementById('midiScrubFill');
  const scrubThumb = document.getElementById('midiScrubThumb');
  const timeReadout = document.getElementById('midiTimeReadout');

  const hasMidi = Boolean(midiPlayer.parsed);
  if (playBtn) {
    playBtn.disabled = !hasMidi;
    playBtn.classList.toggle('is-playing', midiPlayer.playing);
  }
  if (playIcon) {
    playIcon.textContent = midiPlayer.playing ? '❚❚' : '▶';
  }
  if (scrubTrack) {
    scrubTrack.classList.toggle('is-disabled', !hasMidi);
    scrubTrack.classList.toggle('is-scrubbing', midiPlayer.scrubbing);
  }

  const dur = hasMidi ? Math.max(0.01, Number(midiPlayer.parsed.durationSec || 0.01)) : 1;
  const clampedElapsed = hasMidi ? Math.max(0, Math.min(dur, midiPlayer.elapsedSec)) : 0;
  const pct = hasMidi ? (clampedElapsed / dur) * 100 : 0;

  if (scrubFill) scrubFill.style.width = `${pct.toFixed(2)}%`;
  if (scrubThumb) scrubThumb.style.left = `${pct.toFixed(2)}%`;

  if (labelEl) {
    labelEl.textContent = hasMidi ? midiPlayer.fileName : 'No MIDI loaded';
    labelEl.title = hasMidi ? midiPlayer.fileName : '';
  }
  if (timeReadout) {
    timeReadout.textContent = hasMidi
      ? `${formatClockSec(clampedElapsed)} / ${formatClockSec(dur)}`
      : '0:00';
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

function seekMidiTransportTo(targetSec) {
  if (!midiPlayer.parsed) return;
  const dur = Math.max(0, Number(midiPlayer.parsed.durationSec || 0));
  const clamped = Math.max(0, Math.min(dur, targetSec));
  silenceAllMidiTransportVoices(0.06);
  midiPlayer.elapsedSec = clamped;
  midiPlayer.lastPerfMs = performance.now();
  seekMidiEventCursor(clamped);
  updateMidiTransportUi();
}

function tickMidiTransport() {
  if (!midiPlayer.playing || !midiPlayer.parsed) {
    midiPlayer.rafId = null;
    return;
  }

  const nowMs = performance.now();
  const dt = Math.min(0.1, Math.max(0, (nowMs - midiPlayer.lastPerfMs) / 1000));
  midiPlayer.lastPerfMs = nowMs;

  if (!midiPlayer.scrubbing) {
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
  }

  midiPlayer.rafId = requestAnimationFrame(tickMidiTransport);
}

function playMidiTransport() {
  if (!midiPlayer.parsed || midiPlayer.playing) return;
  ensureAudioContext();

  if (midiPlayer.elapsedSec >= midiPlayer.parsed.durationSec - 0.02) {
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

// ============================================================================
// Event Bindings
// ============================================================================
function setupEventListeners() {
  window.addEventListener('blur', () => {
    for (const key of Array.from(activeVoices.keys())) {
      if (!key.startsWith('midifile_')) {
        releaseHeldVoice(key, 0.25);
      }
    }
    wfKeyboardDragActive = false;
    wfKeyboardDragMidi = null;
  });

  // Unified Far Top-Left Hamburger Toggle (Sidebar + Bottom Transport Together)
  const chromeToggleBtn = document.getElementById('chromeToggleBtn');
  if (chromeToggleBtn) {
    chromeToggleBtn.addEventListener('click', () => {
      setChromeCollapsed(!state.chromeCollapsed);
    });
  }

  // Wireframe Keyboard Octave Step Buttons + Click/Drag Glissando
  const octDownBtn = document.getElementById('octDownBtn');
  if (octDownBtn) {
    octDownBtn.addEventListener('click', () => shiftKeyboardOctave(-1));
  }
  const octUpBtn = document.getElementById('octUpBtn');
  if (octUpBtn) {
    octUpBtn.addEventListener('click', () => shiftKeyboardOctave(1));
  }

  const pianoKeyboardEl = document.getElementById('pianoKeyboard');
  if (pianoKeyboardEl) {
    pianoKeyboardEl.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      const keyEl = e.target.closest('.wf-key');
      if (!keyEl) return;
      e.preventDefault();
      const midi = Number(keyEl.dataset.midi);
      if (!Number.isFinite(midi) || midi < MIN_MIDI || midi > MAX_MIDI) return;

      wfKeyboardDragActive = true;
      wfKeyboardDragMidi = midi;
      wfKeyboardDragStartMs = performance.now();
      selectKeyForConfig(midi, false);
      startPianoKeyHold('ui_wf_drag', midi, 0.92, false);
    });

    window.addEventListener('mousemove', e => {
      if (!wfKeyboardDragActive) return;
      const elUnder = document.elementFromPoint(e.clientX, e.clientY);
      const keyEl = elUnder?.closest?.('.wf-key');
      if (!keyEl) {
        if (wfKeyboardDragMidi !== null) {
          releaseHeldVoice('ui_wf_drag', 0.14);
          wfKeyboardDragMidi = null;
        }
        return;
      }
      const nextMidi = Number(keyEl.dataset.midi);
      if (!Number.isFinite(nextMidi) || nextMidi < MIN_MIDI || nextMidi > MAX_MIDI) return;
      if (nextMidi !== wfKeyboardDragMidi) {
        wfKeyboardDragMidi = nextMidi;
        wfKeyboardDragStartMs = performance.now();
        selectKeyForConfig(nextMidi, false);
        startPianoKeyHold('ui_wf_drag', nextMidi, 0.92, false);
      }
    });

    window.addEventListener('mouseup', () => {
      if (!wfKeyboardDragActive) return;
      wfKeyboardDragActive = false;
      if (wfKeyboardDragMidi !== null) {
        const heldSec = Math.max(0, (performance.now() - wfKeyboardDragStartMs) / 1000);
        if (heldSec < 0.26) {
          scheduleDefaultVoiceGate('ui_wf_drag', 0.26 - heldSec);
        } else {
          releaseHeldVoice('ui_wf_drag');
        }
        wfKeyboardDragMidi = null;
      }
    });
  }

  // MIDI Transport Load + Play/Pause + Scrub Bar
  const midiUploadBtn = document.getElementById('midiUploadBtn');
  const midiFileInput = document.getElementById('midiFileInput');
  const midiPlayPauseBtn = document.getElementById('midiPlayPauseBtn');
  const midiScrubTrack = document.getElementById('midiScrubTrack');

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

  if (midiScrubTrack) {
    const scrubFromPointer = clientX => {
      if (!midiPlayer.parsed) return;
      const rail = midiScrubTrack.querySelector('.scrub-rail') || midiScrubTrack;
      const rect = rail.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      seekMidiTransportTo(ratio * (midiPlayer.parsed.durationSec || 0));
    };

    midiScrubTrack.addEventListener('mousedown', e => {
      if (e.button !== 0 || !midiPlayer.parsed) return;
      e.preventDefault();
      midiPlayer.scrubbing = true;
      scrubFromPointer(e.clientX);
    });

    window.addEventListener('mousemove', e => {
      if (!midiPlayer.scrubbing) return;
      scrubFromPointer(e.clientX);
    });

    window.addEventListener('mouseup', () => {
      if (!midiPlayer.scrubbing) return;
      midiPlayer.scrubbing = false;
      midiPlayer.lastPerfMs = performance.now();
      updateMidiTransportUi();
    });
  }

  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.close === 'trimModal') closeTrimModal();
      if (btn.dataset.close === 'videoInspectorModal') closeVideoInspectorModal();
    });
  });
  document.querySelectorAll('.drawer-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', e => {
      if (e.target !== backdrop) return;
      if (backdrop.id === 'trimModal') closeTrimModal();
      if (backdrop.id === 'videoInspectorModal') closeVideoInspectorModal();
    });
  });

  // Video File Inspector Controls (Rename, Rotate, Preview, Holistic Volume dB, Trash)
  const videoInspSlugInput = document.getElementById('videoInspSlugInput');
  if (videoInspSlugInput) {
    videoInspSlugInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') e.target.blur();
    });
    videoInspSlugInput.addEventListener('blur', async () => {
      if (!videoInspState.open || !videoInspState.video || state.isStaticMode) return;
      const nextSlug = videoInspSlugInput.value.trim();
      if (nextSlug && nextSlug !== videoInspState.video.slug) {
        stopVideoInspPreview();
        const vidId = videoInspState.video.id;
        await apiPost('/api/video/rename', {
          videoId: vidId,
          slug: nextSlug
        });
        const freshVideo = state.catalog?.videos.find(v => v.id === vidId && !v.deleted);
        if (freshVideo) {
          videoInspState.video = freshVideo;
          const vidEl = document.getElementById('videoInspPreviewVideo');
          if (vidEl) vidEl.removeAttribute('data-slice-id');
          renderVideoInspectorModal();
        }
      }
    });
  }

  const videoInspRotateBtn = document.getElementById('videoInspRotateBtn');
  if (videoInspRotateBtn) {
    videoInspRotateBtn.addEventListener('click', async () => {
      if (!videoInspState.open || !videoInspState.video || state.isStaticMode) return;
      stopVideoInspPreview();
      videoInspRotateBtn.disabled = true;
      videoInspRotateBtn.textContent = '...';
      try {
        const vidId = videoInspState.video.id;
        await apiPost('/api/video/rotate', {
          videoId: vidId,
          deltaDeg: 90
        });
        const freshVideo = state.catalog?.videos.find(v => v.id === vidId && !v.deleted);
        if (freshVideo) {
          videoInspState.video = freshVideo;
          const vidEl = document.getElementById('videoInspPreviewVideo');
          if (vidEl) vidEl.removeAttribute('data-slice-id');
          renderVideoInspectorModal();
        }
      } finally {
        videoInspRotateBtn.disabled = false;
        videoInspRotateBtn.textContent = '↻ 90°';
      }
    });
  }

  const videoInspPreviewBtn = document.getElementById('videoInspPreviewBtn');
  if (videoInspPreviewBtn) {
    videoInspPreviewBtn.addEventListener('click', () => {
      startVideoInspPreview(false);
    });
  }

  const videoGainMinusBtn = document.getElementById('videoGainMinusBtn');
  if (videoGainMinusBtn) {
    videoGainMinusBtn.addEventListener('click', () => {
      if (!videoInspState.open || !videoInspState.video) return;
      const vidId = videoInspState.video.id;
      setVideoGainDb(vidId, getVideoGainDb(vidId) - 1, true);
    });
  }

  const videoGainPlusBtn = document.getElementById('videoGainPlusBtn');
  if (videoGainPlusBtn) {
    videoGainPlusBtn.addEventListener('click', () => {
      if (!videoInspState.open || !videoInspState.video) return;
      const vidId = videoInspState.video.id;
      setVideoGainDb(vidId, getVideoGainDb(vidId) + 1, true);
    });
  }

  const videoGainSlider = document.getElementById('videoGainSlider');
  if (videoGainSlider) {
    videoGainSlider.addEventListener('input', () => {
      if (!videoInspState.open || !videoInspState.video) return;
      setVideoGainDb(videoInspState.video.id, Number(videoGainSlider.value) || 0, false);
    });
    videoGainSlider.addEventListener('change', () => {
      if (!videoInspState.open || !videoInspState.video) return;
      setVideoGainDb(videoInspState.video.id, Number(videoGainSlider.value) || 0, true);
    });
  }

  const videoGainZeroBtn = document.getElementById('videoGainZeroBtn');
  if (videoGainZeroBtn) {
    videoGainZeroBtn.addEventListener('click', () => {
      if (!videoInspState.open || !videoInspState.video) return;
      setVideoGainDb(videoInspState.video.id, 0, true);
    });
  }

  const videoInspTrashBtn = document.getElementById('videoInspTrashBtn');
  if (videoInspTrashBtn) {
    videoInspTrashBtn.addEventListener('click', async () => {
      if (!videoInspState.open || !videoInspState.video || state.isStaticMode) return;
      if (!videoInspState.trashConfirmArmed) {
        videoInspState.trashConfirmArmed = true;
        videoInspTrashBtn.classList.add('confirm-armed');
        videoInspTrashBtn.textContent = 'Confirm Move Video to _trash?';
        if (videoInspState.trashConfirmTimer) clearTimeout(videoInspState.trashConfirmTimer);
        videoInspState.trashConfirmTimer = setTimeout(() => {
          resetVideoTrashConfirmUI();
        }, 3500);
        return;
      }
      resetVideoTrashConfirmUI();
      stopVideoInspPreview();
      const vidId = videoInspState.video.id;
      closeVideoInspectorModal();
      await apiPost('/api/video/trash', { videoId: vidId });
    });
  }

  // Sample Inspector Parent Video Breadcrumb Link -> Opens Video File Inspector
  const sampleInspParentBtn = document.getElementById('sampleInspParentBtn');
  if (sampleInspParentBtn) {
    sampleInspParentBtn.addEventListener('click', () => {
      if (!trimState.open || !trimState.video) return;
      const vidId = trimState.video.id;
      const slId = trimState.slice?.id || null;
      closeTrimModal();
      openVideoInspectorModal(vidId, slId);
    });
  }

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

  // Inspector Inline Note Reference & Slot Assignment
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

  // Inspector Re-Pitch / Fine-Tune Slider (Strictly Clamped to ±1 Semitone / ±100 Cents)
  const applyManualTuneCents = async nextCents => {
    if (!trimState.open || !trimState.video || !trimState.slice) return;
    const clamped = Math.max(-100, Math.min(100, Math.round(Number(nextCents) || 0)));
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
      const c = Math.max(-100, Math.min(100, Math.round(Number(tuneSliderEl.value) || 0)));
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

  // Single-Clip Non-Destructive Sub-Trim Bindings
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

  // QWERTY Keydown / Keyup (Hold to Sustain + Z/X Octave Shift!)
  window.addEventListener('keydown', async e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.metaKey || e.ctrlKey) {
      return;
    }

    if (e.key === 'Escape') {
      if (trimState.open) closeTrimModal();
      if (videoInspState.open) closeVideoInspectorModal();
      return;
    }

    if (videoInspState.open) {
      if ((e.code === 'Space' || e.key === ' ') && !e.repeat) {
        e.preventDefault();
        startVideoInspPreview(false);
      }
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
      e.preventDefault();
      shiftKeyboardOctave(-1);
      return;
    }
    if (e.code === 'KeyX') {
      e.preventDefault();
      shiftKeyboardOctave(1);
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
  const prefs = loadPrefsFromStorage();
  state.chromeCollapsed = Boolean(prefs.chromeCollapsed);
  state.collapsedCategories = new Set(CATEGORY_ORDER);
  state.videoGainOverrides = prefs.videoGains || {};
  state.sliceToggleOverrides = prefs.sliceToggles || {};
  state.baseOctaveMidi = normalizeBaseOctaveMidi(prefs.baseOctaveMidi ?? 60);

  setChromeCollapsed(state.chromeCollapsed);
  updateMidiTransportUi();

  const threeCanvas = document.getElementById('threeStageCanvas');
  if (threeCanvas) {
    const MIN_SCRUB_HOLD_SEC = 0.18;
    threeStage = createThreeStage({
      canvas: threeCanvas,
      getActiveSliceIds: getActiveStageSliceIds,
      isVideoDisabled: id => isVideoDisabled(id),
      formatTooltip: item => `${item.videoSlug} · ${midiToName(item.midi ?? 60)}`,
      onSliceEnter: item => {
        const cand = resolvePlayableSliceById(item.sliceId);
        if (!cand) return;
        state.lastPlayedVideoId = cand.videoId;
        state.lastPlayedSliceId = cand.sliceId;
        if (cand.midi >= MIN_MIDI && cand.midi <= MAX_MIDI && state.selectedMidi !== cand.midi) {
          selectKeyForConfig(cand.midi, false);
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
  const kbEl = document.getElementById('pianoKeyboard');
  if (kbEl && typeof ResizeObserver !== 'undefined') {
    let lastKbW = 0;
    new ResizeObserver(() => {
      const nextW = Math.round(kbEl.clientWidth || 0);
      if (nextW > 0 && nextW !== lastKbW) {
        lastKbW = nextW;
        renderPianoKeyboard();
      }
    }).observe(kbEl);
  }
  setupEventListeners();
  initWebMIDI();

  const atlasPromise = threeStage ? threeStage.loadAtlas() : Promise.resolve();

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

  // Restore persistent per-video enabled/disabled switch states across reloads
  const validVideos = (state.catalog?.videos || []).filter(v => !v.deleted);
  const validIdSet = new Set(validVideos.map(v => v.id));
  const catalogDisabled = new Set(validVideos.filter(v => v.enabled === false).map(v => v.id));

  // Always start with ALL categories collapsed on every page load
  const allCats = new Set(CATEGORY_ORDER);
  for (const v of validVideos) {
    allCats.add(String(v.category || 'other').toLowerCase());
  }
  state.collapsedCategories = allCats;

  // Sync holistic per-video gainDb between catalog and saved overrides
  for (const v of validVideos) {
    const catGain = clampVideoGainDb(v.gainDb ?? 0);
    if (state.isStaticMode && Object.prototype.hasOwnProperty.call(state.videoGainOverrides, v.id)) {
      v.gainDb = clampVideoGainDb(state.videoGainOverrides[v.id]);
    } else {
      v.gainDb = catGain;
      state.videoGainOverrides[v.id] = catGain;
    }
  }

  if (prefs.hasSavedDisabledVideos) {
    state.disabledVideoIds = new Set(prefs.disabledVideoIds.filter(id => validIdSet.has(id)));
    for (const v of validVideos) {
      v.enabled = !state.disabledVideoIds.has(v.id);
    }
    if (!state.isStaticMode) {
      const toDisable = Array.from(state.disabledVideoIds).filter(id => !catalogDisabled.has(id));
      const toEnable = Array.from(catalogDisabled).filter(id => !state.disabledVideoIds.has(id));
      if (toDisable.length > 0) {
        fetch('./api/video/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoIds: toDisable, enabled: false })
        }).catch(() => {});
      }
      if (toEnable.length > 0) {
        fetch('./api/video/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoIds: toEnable, enabled: true })
        }).catch(() => {});
      }
    }
  } else {
    state.disabledVideoIds = catalogDisabled;
    savePrefsToStorage();
  }

  // In static mode, also restore saved per-slice toggles across reloads
  if (state.isStaticMode && state.catalog?.keyboardMap) {
    for (const entry of Object.values(state.catalog.keyboardMap)) {
      let changed = false;
      for (const c of entry.candidates || []) {
        if (Object.prototype.hasOwnProperty.call(state.sliceToggleOverrides, c.sliceId)) {
          c.enabled = Boolean(state.sliceToggleOverrides[c.sliceId]);
          changed = true;
        }
      }
      if (changed) {
        entry.enabledSliceIds = (entry.candidates || []).filter(c => c.enabled).map(c => c.sliceId);
        entry.enabledCount = entry.enabledSliceIds.length;
        entry.primary = (entry.candidates || []).find(c => c.enabled) || null;
        entry.activeSliceId = entry.primary ? entry.primary.sliceId : null;
        entry.isCleared = entry.enabledCount === 0;
      }
    }
  }

  if (!state.catalog?.keyboardMap?.[60]) {
    const firstKey = Object.keys(state.catalog?.keyboardMap || {})
      .map(Number)
      .sort((a, b) => a - b)[0];
    if (firstKey) state.selectedMidi = firstKey;
  }

  await atlasPromise;
  refreshAllUI();
  updateStageTileSizes();

  // In static web mode, quietly background-warm enabled scale audio bytes
  if (state.isStaticMode && state.catalog?.keyboardMap) {
    setTimeout(async () => {
      const urls = [];
      const entries = Object.values(state.catalog.keyboardMap).sort(
        (a, b) => Math.abs((a.targetMidi || 60) - 60) - Math.abs((b.targetMidi || 60) - 60)
      );
      for (const entry of entries) {
        for (const c of entry.candidates || []) {
          if (c.enabled && !isVideoDisabled(c.videoId) && c.audioUrl) urls.push(c.audioUrl);
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
