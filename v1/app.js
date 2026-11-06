import { parseMidiFile, encodeMidiFile } from './midi-parser.mjs';
import {
  resolveTransposedMidiNote as resolveTransposedMidiNoteShared,
  chooseStageSlot,
  planMidiTimeline
} from './midi-timeline.mjs';
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
const PERC_NOTE_COLOR = '#8a8a8a';

const STAGE_GRID_SPECS = {
  '3x1': { cols: 3, rows: 1, slots: 3 },
  '2x2': { cols: 2, rows: 2, slots: 4 },
  '3x2': { cols: 3, rows: 2, slots: 6 },
  '4x2': { cols: 4, rows: 2, slots: 8 },
  '3x3': { cols: 3, rows: 3, slots: 9 }
};
const MIN_STAGE_FADE_IN_SEC = 0.0;
const MAX_STAGE_FADE_IN_SEC = 1.0;
const MIN_STAGE_FADE_SEC = 0.0;
const MAX_STAGE_FADE_SEC = 2.0;
const MIN_STAGE_MAX_DISPLAY_SEC = 0.5;
const MAX_STAGE_MAX_DISPLAY_SEC = 2.0;
const MIN_STAGE_TILE_SCALE = 1.0;
const MAX_STAGE_TILE_SCALE = 2.5;
const MIN_STAGE_SPEC_SCALE = 0.75;
const MAX_STAGE_SPEC_SCALE = 4.5;

const ACCIDENTAL_SEMITONES = new Set([1, 3, 6, 8, 10]);
const TOUCH_LEFT_ACCIDENTALS = new Set([3, 8, 10]); // D#, G#, A# touch C#, F#, G#
const NATURAL_INDEX_BY_PC = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
const ACCIDENTAL_OFFSET_BY_PC = { 1: 0.5, 3: 1.5, 6: 3.5, 8: 4.5, 10: 5.5 };

const MIN_MIDI = 24; // C1 (Percussion Octave C1–B1; Tonal C2–G7 starts at 36)
const MAX_MIDI = 103; // G7
const MIN_BASE_OCTAVE_MIDI = 24; // C1
const TOP_KEYBOARD_MIDI_LIMIT = 108; // B7 is 107; maxStartMidi = 108 - visibleOctaves * 12
const MIN_VISIBLE_OCTAVES = 3;
const MAX_VISIBLE_OCTAVES = 6;

const PREFS_STORAGE_KEY = 'everytone_prefs_v2';
const CATEGORY_ORDER = ['strings', 'winds', 'keys', 'metal', 'glass', 'wood', 'toms', 'percussion'];

// Standard chromatic QWERTY layout (18 keys starting at qwertyOctaveMidi)
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
  selectionTarget: 'keyboard', // 'keyboard' | 'tile' | 'explorer' | 'blade'
  selectedTileSliceId: null, // Active selected tile sliceId when selectionTarget === 'tile'
  auditionIndex: 0,
  chromeCollapsed: false,
  noteSamplesExpanded: false, // Collapsed by default on load so playing is uncluttered
  stageGridMode: '3x1', // '3x1' | '2x2' | '3x2' | '4x2' | '3x3'
  stageTileScale: 1.0, // Bottom sample mosaic tile scale (1.0 = 100% up to 2.5 = 250%)
  stageSpecScale: 1.0, // Visual spectrogram height scale (0.75 = 75% up to 4.5 = 450%, ~2/3 of video height)
  stageFadeInSec: 0.0, // Optional visual fade-in / dissolve duration (0.0s = Off hard cut, up to 1.0s)
  stageFadeSec: 0.20, // Configurable visual fade-out duration (0.0s = Off hard cut, up to 2.0s)
  stageMaxDisplayEnabled: false, // When true, auto-fades displayed video after stageMaxDisplaySec even if held
  stageMaxDisplaySec: 1.0, // Configurable max visual display duration (0.5s to 2.0s)
  visibleOctaves: 6, // Responsively adjusts between 3 and 6 octaves based on keyboard width
  hasCustomKeyboardOctave: false,
  baseOctaveMidi: 36, // Leftmost visible octave of the bottom keyboard (e.g. C2 for C2–B7)
  qwertyOctaveMidi: 60, // Laptop QWERTY A..; octave root (defaults to middle C4)
  disabledVideoIds: new Set(),
  collapsedCategories: new Set(),
  videoGainOverrides: {}, // Per-video holistic gainDb persistence
  sliceToggleOverrides: {}, // Static-mode per-slice toggle persistence
  releaseSec: 0.40, // Permanent 0.40s universal audio release decay
  highpassHz: 80, // Permanent 80Hz master low-cut filter
  sustainPedalDown: false,
  lastPlayedVideoId: null,
  lastPlayedSliceId: null,
  isStaticMode: false,
  assetBust: 0
};

// Track last-played slice per MIDI key for round-robin rotation when 2+ clips are ON
const lastPlayedSliceByMidi = new Map();

// ============================================================================
// Persistent Preferences & Readable Group Name Helpers
// ============================================================================
function getDefaultStartMidiForOctaves(octaves) {
  if (octaves >= 5) return 36; // C2–B7 (6 oct) or C2–B6 (5 oct)
  if (octaves === 4) return 48; // C3–B6 (4 oct)
  return 60; // C4–B6 (3 oct)
}

function clampKeyboardStartMidi(raw, octaves = state.visibleOctaves) {
  const vis = Math.max(MIN_VISIBLE_OCTAVES, Math.min(MAX_VISIBLE_OCTAVES, Math.round(Number(octaves) || 5)));
  const maxStart = Math.max(MIN_BASE_OCTAVE_MIDI, TOP_KEYBOARD_MIDI_LIMIT - vis * 12);
  const n = Number(raw);
  if (!Number.isFinite(n)) return Math.min(maxStart, getDefaultStartMidiForOctaves(vis));
  const snapped = Math.round(n / 12) * 12;
  return Math.max(MIN_BASE_OCTAVE_MIDI, Math.min(maxStart, snapped));
}

function normalizeQwertyOctaveMidi(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 60;
  const snapped = Math.round(n / 12) * 12;
  return Math.max(24, Math.min(96, snapped));
}

function clampVideoGainDb(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-12, Math.min(12, Math.round(n)));
}

function normalizeStageGridMode(raw) {
  const key = String(raw || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(STAGE_GRID_SPECS, key) ? key : '3x1';
}

function clampStageFadeInSec(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0.001) return MIN_STAGE_FADE_IN_SEC;
  const stepped = Math.round(n * 20) / 20;
  return Math.max(MIN_STAGE_FADE_IN_SEC, Math.min(MAX_STAGE_FADE_IN_SEC, stepped));
}

function formatFadeInReadout(sec) {
  if (!Number.isFinite(sec) || sec <= 0.001) return 'Off';
  return Math.round(sec * 100) % 10 === 0 ? `${sec.toFixed(1)}s` : `${sec.toFixed(2)}s`;
}

function clampStageFadeSec(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.2;
  if (n <= 0.001) return 0.0;
  const stepped = Math.round(n * 20) / 20;
  return Math.max(MIN_STAGE_FADE_SEC, Math.min(MAX_STAGE_FADE_SEC, stepped));
}

function formatFadeSecReadout(sec) {
  if (!Number.isFinite(sec) || sec <= 0.001) return 'Off';
  return Math.round(sec * 100) % 10 === 0 ? `${sec.toFixed(1)}s` : `${sec.toFixed(2)}s`;
}

function clampStageMaxDisplaySec(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1.0;
  const stepped = Math.round(n * 10) / 10;
  return Math.max(MIN_STAGE_MAX_DISPLAY_SEC, Math.min(MAX_STAGE_MAX_DISPLAY_SEC, stepped));
}

function clampStageTileScale(raw) {
  let n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return MIN_STAGE_TILE_SCALE;
  if (n > 10) n = n / 100;
  const stepped = Math.round(n * 20) / 20;
  return Math.max(MIN_STAGE_TILE_SCALE, Math.min(MAX_STAGE_TILE_SCALE, stepped));
}

function clampStageSpecScale(raw) {
  let n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1.0;
  if (n > 10) n = n / 100;
  const stepped = Math.round(n * 20) / 20;
  return Math.max(MIN_STAGE_SPEC_SCALE, Math.min(MAX_STAGE_SPEC_SCALE, stepped));
}

function getStageSpecRatio(rows, rawSpecScale = state.stageSpecScale) {
  const baseRatio = rows >= 3 ? 0.13 : 0.145;
  const scale = clampStageSpecScale(rawSpecScale);
  if (scale <= 1.0) {
    return baseRatio * scale;
  }
  const t = (scale - 1.0) / (MAX_STAGE_SPEC_SCALE - 1.0);
  return baseRatio + t * (0.66 - baseRatio);
}

function getStageSpecKeylineWidth(rawSpecScale = state.stageSpecScale) {
  const scale = clampStageSpecScale(rawSpecScale);
  if (scale <= 1.0) return 1.0;
  const t = Math.min(1, (scale - 1.0) / (MAX_STAGE_SPEC_SCALE - 1.0));
  return 1.0 + t * 1.0;
}

function inferClientGroupName(videoOrSlug) {
  if (videoOrSlug && typeof videoOrSlug === 'object') {
    const explicit = String(videoOrSlug.groupName || '').trim();
    if (explicit) return explicit;
  }
  const slug = String(
    typeof videoOrSlug === 'object' ? videoOrSlug?.slug || '' : videoOrSlug || ''
  ).toLowerCase();
  if (!slug) return 'sample';
  if (/^wood-log-mallet-0[1-8]$/.test(slug)) return 'wood log 1';
  if (/^wood-log-mallet-(09|1[0-3])$/.test(slug)) return 'wood log 2';
  const stripped = slug
    .replace(/-?\d+$/, '')
    .replace(/-(blow|mallet|tube|frets|head|gong|shade|strike)$/, '');
  if (stripped.startsWith('wine-glass-tuned')) return 'tuned wine glass';
  if (stripped.startsWith('silver-bike-bell')) return 'silver bike bell';
  return stripped.replace(/-/g, ' ').trim() || slug.replace(/-/g, ' ');
}

function getVideoGroupName(videoOrId) {
  const video =
    typeof videoOrId === 'object'
      ? videoOrId
      : state.catalog?.videos?.find(v => v.id === videoOrId);
  if (!video) return 'sample';
  return inferClientGroupName(video);
}

function getVideoGroupKey(video) {
  const cat = String(video?.category || 'other').toLowerCase();
  const gName = getVideoGroupName(video).trim().toLowerCase();
  return `${cat}::${gName}`;
}

function getVideosInSameGroup(video) {
  if (!video) return [];
  const targetKey = getVideoGroupKey(video);
  return (state.catalog?.videos || [])
    .filter(v => !v.deleted && getVideoGroupKey(v) === targetKey)
    .slice()
    .sort((a, b) =>
      String(a.slug || '').localeCompare(String(b.slug || ''), undefined, {
        numeric: true,
        sensitivity: 'base'
      })
    );
}

let prefsHydrated = false;
let stageConfigSyncTimer = null;

function syncStageConfigToServer() {
  if (!prefsHydrated || state.isStaticMode || !state.catalog) return;
  if (stageConfigSyncTimer) clearTimeout(stageConfigSyncTimer);
  stageConfigSyncTimer = setTimeout(() => {
    stageConfigSyncTimer = null;
    fetch('./api/stage-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stageGridMode: state.stageGridMode,
        stageTileScale: state.stageTileScale,
        stageSpecScale: state.stageSpecScale,
        stageFadeInSec: state.stageFadeInSec,
        stageFadeSec: state.stageFadeSec,
        stageMaxDisplayEnabled: state.stageMaxDisplayEnabled,
        stageMaxDisplaySec: state.stageMaxDisplaySec,
        midiTransposeOctaves: clampMidiTransposeOctaves(midiPlayer.transposeOctaves)
      })
    }).catch(() => {});
  }, 80);
}

function clampMidiTransposeOctaves(raw) {
  const n = Math.round(Number(raw) || 0);
  return Math.max(-4, Math.min(4, n));
}

function loadPrefsFromStorage() {
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) {
      return {
        hasSavedPrefs: false,
        hasSavedDisabledVideos: false,
        disabledVideoIds: [],
        videoGains: {},
        sliceToggles: {},
        chromeCollapsed: false,
        noteSamplesExpanded: false,
        stageGridMode: '3x1',
        stageTileScale: 1.0,
        stageSpecScale: 1.0,
        stageFadeInSec: 0.0,
        stageFadeSec: 0.2,
        stageMaxDisplayEnabled: false,
        stageMaxDisplaySec: 1.0,
        midiTransposeOctaves: 0,
        hasCustomKeyboardOctave: false,
        baseOctaveMidi: 36,
        qwertyOctaveMidi: 60
      };
    }
    const parsed = JSON.parse(raw);
    return {
      hasSavedPrefs: true,
      hasSavedDisabledVideos: Array.isArray(parsed?.disabledVideoIds),
      disabledVideoIds: Array.isArray(parsed?.disabledVideoIds)
        ? parsed.disabledVideoIds.map(String)
        : [],
      videoGains:
        parsed?.videoGains && typeof parsed.videoGains === 'object' ? parsed.videoGains : {},
      sliceToggles:
        parsed?.sliceToggles && typeof parsed.sliceToggles === 'object' ? parsed.sliceToggles : {},
      chromeCollapsed: Boolean(parsed?.chromeCollapsed ?? parsed?.explorerCollapsed),
      noteSamplesExpanded: Boolean(parsed?.noteSamplesExpanded),
      stageGridMode: normalizeStageGridMode(parsed?.stageGridMode),
      stageTileScale: clampStageTileScale(parsed?.stageTileScale ?? 1.0),
      stageSpecScale: clampStageSpecScale(parsed?.stageSpecScale ?? 1.0),
      stageFadeInSec: clampStageFadeInSec(parsed?.stageFadeInSec ?? 0.0),
      stageFadeSec: clampStageFadeSec(parsed?.stageFadeSec ?? 0.2),
      stageMaxDisplayEnabled: Boolean(parsed?.stageMaxDisplayEnabled),
      stageMaxDisplaySec: clampStageMaxDisplaySec(parsed?.stageMaxDisplaySec ?? 1.0),
      midiTransposeOctaves: clampMidiTransposeOctaves(parsed?.midiTransposeOctaves ?? 0),
      hasCustomKeyboardOctave: Boolean(parsed?.hasCustomKeyboardOctave),
      baseOctaveMidi: Number(parsed?.baseOctaveMidi ?? 36),
      qwertyOctaveMidi: normalizeQwertyOctaveMidi(parsed?.qwertyOctaveMidi ?? 60)
    };
  } catch {
    return {
      hasSavedPrefs: false,
      hasSavedDisabledVideos: false,
      disabledVideoIds: [],
      videoGains: {},
      sliceToggles: {},
      chromeCollapsed: false,
      noteSamplesExpanded: false,
      stageGridMode: '3x1',
      stageTileScale: 1.0,
      stageSpecScale: 1.0,
      stageFadeInSec: 0.0,
      stageFadeSec: 0.2,
      stageMaxDisplayEnabled: false,
      stageMaxDisplaySec: 1.0,
      midiTransposeOctaves: 0,
      hasCustomKeyboardOctave: false,
      baseOctaveMidi: 36,
      qwertyOctaveMidi: 60
    };
  }
}

function savePrefsToStorage() {
  if (!prefsHydrated) return;
  try {
    const payload = {
      disabledVideoIds: Array.from(state.disabledVideoIds),
      videoGains: state.videoGainOverrides,
      sliceToggles: state.sliceToggleOverrides,
      chromeCollapsed: state.chromeCollapsed,
      noteSamplesExpanded: state.noteSamplesExpanded,
      stageGridMode: state.stageGridMode,
      stageTileScale: state.stageTileScale,
      stageSpecScale: state.stageSpecScale,
      stageFadeInSec: state.stageFadeInSec,
      stageFadeSec: state.stageFadeSec,
      stageMaxDisplayEnabled: state.stageMaxDisplayEnabled,
      stageMaxDisplaySec: state.stageMaxDisplaySec,
      midiTransposeOctaves: clampMidiTransposeOctaves(midiPlayer.transposeOctaves),
      hasCustomKeyboardOctave: state.hasCustomKeyboardOctave,
      baseOctaveMidi: state.baseOctaveMidi,
      qwertyOctaveMidi: state.qwertyOctaveMidi
    };
    window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(payload));
  } catch {}
  syncStageConfigToServer();
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

function computeSpecDbBounds(colMags, minBin, maxBin, globalMaxDb, baseRangeDb) {
  const BINS = 128;
  const span = 72;
  const histMin = globalMaxDb - span;
  const counts = new Uint32Array(BINS);
  let total = 0;
  const stepX = colMags.length > 256 ? 2 : 1;
  for (let x = 0; x < colMags.length; x += stepX) {
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
  if (total === 0) {
    return { ceilDb: globalMaxDb, floorDb: globalMaxDb - baseRangeDb };
  }
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
  // Normalized 50% harmonic boost: soften sharp transient spikes while guarding pure #000000 black floor
  const headroomTrim = Math.min(8.5, Math.max(0, globalMaxDb - p99Db));
  const ceilDb = globalMaxDb - 0.5 * headroomTrim;
  const rawFloor = ceilDb - baseRangeDb;
  const noiseGuardFloor = medianDb + 5.0;
  const floorDb = Math.min(ceilDb - 18, Math.max(rawFloor, 0.5 * (noiseGuardFloor + rawFloor)));
  return { ceilDb, floorDb };
}

function grayScreenSpecPixel(norm) {
  const t = Math.max(0, Math.min(1, norm));
  if (t <= 0.035) return [0, 0, 0, 0];
  const u = (t - 0.035) / 0.965;
  const toe = Math.min(1, u / 0.04);
  const curved = Math.max(0, Math.min(1, Math.pow(u, 0.865) * toe));
  const alpha = Math.max(0, Math.min(250, Math.round(curved * 250)));
  return [247, 248, 250, alpha];
}

function midiToFreq(midi) {
  return (440 * Math.pow(2, (midi - 69) / 12)).toFixed(1);
}

function isPercussionSlice(video) {
  return video?.category === 'percussion';
}

// ============================================================================
// Web Audio Engine + Hold-to-Sustain / Key-Up Release Voice Manager
// ============================================================================
let audioCtx = null;
let masterBus = null;
let sampleHighpass = null;
const audioBufferCache = new Map();
const rawAudioBytesCache = new Map();
const videoBlobUrlCache = new Map();
const videoBlobPendingCache = new Map();

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

function clearVideoBlobCache() {
  for (const objUrl of videoBlobUrlCache.values()) {
    try {
      URL.revokeObjectURL(objUrl);
    } catch {}
  }
  videoBlobUrlCache.clear();
  videoBlobPendingCache.clear();
}

async function warmVideoBlobUrl(url) {
  const bustedUrl = withBust(url);
  if (!bustedUrl || videoBlobUrlCache.has(bustedUrl) || videoBlobPendingCache.has(bustedUrl)) return;
  const p = fetch(bustedUrl)
    .then(r => (r.ok ? r.blob() : null))
    .then(blob => {
      videoBlobPendingCache.delete(bustedUrl);
      if (!blob) return null;
      if (withBust(url) !== bustedUrl) return null;
      const objUrl = URL.createObjectURL(blob);
      videoBlobUrlCache.set(bustedUrl, objUrl);
      return objUrl;
    })
    .catch(() => {
      videoBlobPendingCache.delete(bustedUrl);
      return null;
    });
  videoBlobPendingCache.set(bustedUrl, p);
  await p;
}

function getCachedOrWarmVideoSrc(url) {
  const bustedUrl = withBust(url);
  if (!bustedUrl) return '';
  if (videoBlobUrlCache.has(bustedUrl)) {
    return videoBlobUrlCache.get(bustedUrl);
  }
  warmVideoBlobUrl(url);
  return bustedUrl;
}

// ============================================================================
// Three.js 3D Stage + Configurable Foreground Grid (3×1, 2×2, 3×2, 3×3) + Fade-Out
// ============================================================================
const MAX_STAGE_SLOTS = 9;

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

function createEmptyStageSlot(prev = null) {
  return {
    occupied: false,
    fadingOut: false,
    alpha: 0,
    appliedOpacity: 0,
    createdMs: 0,
    canPaintVideoFrame: false,
    hasPaintedVideoFrame: false,
    firstFrameMs: null,
    fadeOutStartMs: null,
    fadeOutFromAlpha: 0,
    fadeOutDurMs: 0,
    needsCanvasResizeRedraw: false,
    seq: 0,
    lastSeq: prev?.seq || prev?.lastSeq || 0,
    token: null,
    sliceKey: null,
    videoId: null,
    videoSlug: null,
    lastVideoId: prev?.videoId || prev?.lastVideoId || null,
    lastVideoSlug: prev?.videoSlug || prev?.lastVideoSlug || null,
    videoEl: null,
    voice: null,
    miniBitmap: null
  };
}

const stageSlots = Array.from({ length: MAX_STAGE_SLOTS }, () => createEmptyStageSlot());

function getActiveStageGridSpec() {
  return STAGE_GRID_SPECS[state.stageGridMode] || STAGE_GRID_SPECS['3x1'];
}

function getActiveStageSlotCount() {
  return getActiveStageGridSpec().slots;
}

function syncStageConfigUI() {
  const mode = normalizeStageGridMode(state.stageGridMode);
  const tileScale = clampStageTileScale(state.stageTileScale);
  const specScale = clampStageSpecScale(state.stageSpecScale);
  const fadeInSec = clampStageFadeInSec(state.stageFadeInSec);
  const fadeSec = clampStageFadeSec(state.stageFadeSec);
  const maxEnabled = Boolean(state.stageMaxDisplayEnabled);
  const maxSec = clampStageMaxDisplaySec(state.stageMaxDisplaySec);

  document.querySelectorAll('.stage-grid-pill[data-grid-mode]').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.gridMode === mode);
  });

  const tileScalePct = Math.round(tileScale * 100);
  const tileScaleSlider = document.getElementById('stageTileScaleSlider');
  if (tileScaleSlider && document.activeElement !== tileScaleSlider) {
    tileScaleSlider.value = String(tileScalePct);
  }
  const tileScaleReadout = document.getElementById('stageTileScaleReadout');
  if (tileScaleReadout) {
    tileScaleReadout.textContent = `${tileScalePct}%`;
  }

  const specScalePct = Math.round(specScale * 100);
  const specScaleSlider = document.getElementById('stageSpecScaleSlider');
  if (specScaleSlider && document.activeElement !== specScaleSlider) {
    specScaleSlider.value = String(specScalePct);
  }
  const specScaleReadout = document.getElementById('stageSpecScaleReadout');
  if (specScaleReadout) {
    specScaleReadout.textContent = `${specScalePct}%`;
  }

  const fadeInSlider = document.getElementById('stageFadeInSlider');
  if (fadeInSlider && document.activeElement !== fadeInSlider) {
    fadeInSlider.value = fadeInSec.toFixed(2);
  }
  const fadeInReadout = document.getElementById('stageFadeInReadout');
  if (fadeInReadout) {
    fadeInReadout.textContent = formatFadeInReadout(fadeInSec);
  }

  const fadeSlider = document.getElementById('stageFadeSlider');
  if (fadeSlider && document.activeElement !== fadeSlider) {
    fadeSlider.value = fadeSec.toFixed(2);
  }
  const fadeReadout = document.getElementById('stageFadeReadout');
  if (fadeReadout) {
    fadeReadout.textContent = formatFadeSecReadout(fadeSec);
  }

  const maxToggle = document.getElementById('stageMaxDisplayToggle');
  if (maxToggle) {
    maxToggle.checked = maxEnabled;
  }
  const maxSliderRow = document.getElementById('stageMaxDisplaySliderRow');
  if (maxSliderRow) {
    maxSliderRow.classList.toggle('hidden', !maxEnabled);
  }
  const maxSlider = document.getElementById('stageMaxDisplaySlider');
  if (maxSlider && document.activeElement !== maxSlider) {
    maxSlider.value = maxSec.toFixed(1);
  }
  const maxReadout = document.getElementById('stageMaxDisplayReadout');
  if (maxReadout) {
    maxReadout.textContent = maxEnabled ? `${maxSec.toFixed(1)}s` : 'Off';
  }

  const stageEl = document.getElementById('videoStage');
  if (stageEl) {
    stageEl.style.setProperty('--stage-fade-in-sec', `${fadeInSec.toFixed(2)}s`);
    stageEl.style.setProperty('--stage-fade-sec', `${fadeSec.toFixed(2)}s`);
  }
  threeStage?.setFadeOutSec?.(fadeSec);

  const slotCount = getActiveStageSlotCount();
  const grid = document.getElementById('polyVideoGrid');
  if (grid) {
    for (let i = 0; i < MAX_STAGE_SLOTS; i++) {
      const unitEl = grid.querySelector(`.stage-slot-unit[data-slot="${i}"]`);
      if (!unitEl) continue;
      if (i < slotCount) {
        unitEl.classList.remove('hidden');
      } else {
        if (stageSlots[i]?.occupied) {
          if (stageSlots[i].voice) {
            displaceStageSlotVoice(stageSlots[i].voice, false);
          }
          removeStageTile({
            slotIdx: i,
            token: stageSlots[i].token,
            videoEl: stageSlots[i].videoEl
          });
        }
        unitEl.classList.add('hidden');
      }
    }
  }
}

function setStageGridMode(nextMode, persist = true) {
  const normalized = normalizeStageGridMode(nextMode);
  state.stageGridMode = normalized;
  syncStageConfigUI();
  updateStageTileSizes();
  replanCurrentMidiTimeline();
  if (persist) savePrefsToStorage();
}

function setStageTileScale(nextScale, persist = true) {
  const clamped = clampStageTileScale(nextScale);
  state.stageTileScale = clamped;
  syncStageConfigUI();
  updateStageTileSizes();
  if (persist) savePrefsToStorage();
}

function setStageSpecScale(nextScale, persist = true) {
  const clamped = clampStageSpecScale(nextScale);
  state.stageSpecScale = clamped;
  syncStageConfigUI();
  updateStageTileSizes();
  if (persist) savePrefsToStorage();
}

function setStageFadeInSec(nextSec, persist = true) {
  const clamped = clampStageFadeInSec(nextSec);
  state.stageFadeInSec = clamped;
  syncStageConfigUI();
  replanCurrentMidiTimeline();
  if (persist) savePrefsToStorage();
}

function setStageFadeSec(nextSec, persist = true) {
  const clamped = clampStageFadeSec(nextSec);
  state.stageFadeSec = clamped;
  syncStageConfigUI();
  replanCurrentMidiTimeline();
  if (persist) savePrefsToStorage();
}

function expireVoiceVisualDisplay(voice) {
  if (!voice) return;
  if (voice.maxDisplayTimer) {
    clearTimeout(voice.maxDisplayTimer);
    voice.maxDisplayTimer = null;
  }
  if (voice.released || voice.visualTimedOut) return;
  voice.visualTimedOut = true;

  if (voice.tileObj) {
    const tileToFade = voice.tileObj;
    voice.tileObj = null;
    fadeOutStageTile(tileToFade);
  } else {
    threeStage?.notifyActivity();
  }
}

function scheduleVoiceMaxDisplayTimeout(voice) {
  if (!voice) return;
  if (voice.maxDisplayTimer) {
    clearTimeout(voice.maxDisplayTimer);
    voice.maxDisplayTimer = null;
  }
  if (
    !state.stageMaxDisplayEnabled ||
    voice.released ||
    voice.visualTimedOut ||
    (!voice.tileObj && !voice.src)
  ) {
    return;
  }
  const maxSec = clampStageMaxDisplaySec(state.stageMaxDisplaySec);
  const elapsedSec = audioCtx && voice.startedAt ? Math.max(0, audioCtx.currentTime - voice.startedAt) : 0;
  const remainMs = Math.round((maxSec - elapsedSec) * 1000);
  if (remainMs <= 0) {
    expireVoiceVisualDisplay(voice);
  } else {
    voice.maxDisplayTimer = setTimeout(() => {
      voice.maxDisplayTimer = null;
      expireVoiceVisualDisplay(voice);
    }, remainMs);
  }
}

function rescheduleActiveVoiceDisplayTimers() {
  for (const voice of activeVoices.values()) {
    scheduleVoiceMaxDisplayTimeout(voice);
  }
}

function setStageMaxDisplayEnabled(enabled, persist = true) {
  state.stageMaxDisplayEnabled = Boolean(enabled);
  syncStageConfigUI();
  rescheduleActiveVoiceDisplayTimers();
  replanCurrentMidiTimeline();
  if (persist) savePrefsToStorage();
}

function setStageMaxDisplaySec(nextSec, persist = true) {
  state.stageMaxDisplaySec = clampStageMaxDisplaySec(nextSec);
  syncStageConfigUI();
  rescheduleActiveVoiceDisplayTimers();
  replanCurrentMidiTimeline();
  if (persist) savePrefsToStorage();
}

function getActiveStageSliceIds() {
  const set = new Set();
  const slotCount = getActiveStageSlotCount();
  for (let i = 0; i < slotCount; i++) {
    if (stageSlots[i].occupied && !stageSlots[i].fadingOut && stageSlots[i].sliceKey) {
      set.add(stageSlots[i].sliceKey);
    }
  }
  for (const v of activeVoices.values()) {
    if (!v.released && !v.visualTimedOut && v.sliceKey) {
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

function solveMosaicFlushPreview(targetW, availH, tileCount, desiredCellPx, gap = 1) {
  if (tileCount <= 0) return { cols: 1, rows: 0, cell: desiredCellPx, gridH: 0 };
  if (tileCount <= 3 && tileCount * desiredCellPx + (tileCount - 1) * gap <= targetW) {
    const cell = Math.min(desiredCellPx, availH);
    return { cols: tileCount, rows: 1, cell, gridH: cell };
  }
  const maxCellPx = Math.max(14.0, desiredCellPx * 1.35);
  const minCellPx = 4.5;
  const minCols = Math.max(1, Math.min(tileCount, Math.ceil((targetW + gap) / (maxCellPx + gap))));
  const maxCols = Math.min(tileCount, Math.max(minCols, Math.floor((targetW + gap) / (minCellPx + gap))));

  let bestCols = maxCols;
  let bestScore = -1e9;
  let foundFitting = false;
  for (let cols = minCols; cols <= maxCols; cols++) {
    const rows = Math.ceil(tileCount / cols);
    const cellByW = (targetW - (cols - 1) * gap) / cols;
    if (cellByW < minCellPx - 0.01) continue;
    const neededH = rows * cellByW + (rows - 1) * gap;
    if (neededH > availH + 0.5) continue;

    foundFitting = true;
    const lastRowCount = tileCount - (rows - 1) * cols;
    const lastRowFill = lastRowCount / cols;
    const orphanPenalty = rows > 1 && lastRowFill < 0.25 ? (0.25 - lastRowFill) * 22 : 0;
    const sizeCloseness =
      1.0 - Math.min(1.0, Math.abs(cellByW - desiredCellPx) / Math.max(4.0, desiredCellPx * 0.6));
    const score = sizeCloseness * 38 + lastRowFill * 9 - orphanPenalty;
    if (score > bestScore) {
      bestScore = score;
      bestCols = cols;
    }
  }
  if (!foundFitting) bestCols = maxCols;
  const bestCell = (targetW - (bestCols - 1) * gap) / bestCols;
  const rows = Math.ceil(tileCount / bestCols);
  return {
    cols: bestCols,
    rows,
    cell: bestCell,
    gridH: rows * bestCell + (rows - 1) * gap
  };
}

function updateStageTileSizes() {
  const stageEl = document.getElementById('videoStage');
  const grid = document.getElementById('polyVideoGrid');
  if (!stageEl || !grid) return;

  const { cols, rows } = getActiveStageGridSpec();
  const tileScale = clampStageTileScale(state.stageTileScale);
  const stageW = Math.max(320, stageEl.clientWidth);
  const stageH = Math.max(240, stageEl.clientHeight);
  const gap = stageW < 920 ? 12 : rows >= 3 ? 14 : rows === 2 ? 16 : 20;
  const rowGap = rows > 1 ? (rows >= 3 ? 8 : 10) : 0;
  const specRatio = getStageSpecRatio(rows, state.stageSpecScale); // Flush spectrogram directly beneath each video

  const activeTiles = threeStage?.getItemCount?.() ?? 439;
  const marginY = Math.max(12, Math.round(stageH * (rows >= 3 ? 0.024 : 0.034)));
  const betweenGap = activeTiles > 0 ? Math.max(12, Math.round(stageH * (rows >= 3 ? 0.014 : 0.020))) : 0;

  // Step 1: Compute natural 100%-baseline main video grid dimensions
  const baseReserveH =
    activeTiles > 0
      ? rows >= 3
        ? 54
        : rows === 2
          ? 64
          : 76
      : 0;

  const baseAvailTopH = Math.max(
    140,
    stageH - marginY * 2 - betweenGap - baseReserveH - (rows - 1) * rowGap
  );
  const baseMaxSideByH = Math.floor(baseAvailTopH / (rows * (1 + specRatio)));

  const padX = Math.max(32, Math.round(stageW * 0.065));
  const availW = Math.max(200, stageW - padX * 2 - gap * (cols - 1));
  const maxCap = rows === 1 ? 388 : cols >= 4 ? 304 : rows === 2 ? 348 : 284;
  const baseSide = Math.max(68, Math.min(maxCap, Math.floor(Math.min(baseMaxSideByH, availW / cols))));
  const baseStripW = baseSide * cols + gap * (cols - 1);
  const baseCell100 = Math.min(12.0, Math.max(7.5, baseStripW / 76));
  const desiredCell = baseCell100 * tileScale;

  // Step 2: Keep main grid size untouched whenever vertical room permits; only yield gentle vertical room
  // if scaling tiles up (105%–250%) genuinely achieves larger flush mosaic squares without overlap.
  let side = baseSide;
  if (activeTiles > 0 && tileScale > 1.01) {
    const minAllowedSide = Math.max(68, Math.round(baseSide * 0.68));
    let bestAchievedCell = -1;
    for (let s = baseSide; s >= minAllowedSide; s -= 2) {
      const candSpecH = Math.max(14, Math.round(s * specRatio));
      const candStripW = s * cols + gap * (cols - 1);
      const candTopH = rows * (s + candSpecH) + (rows - 1) * rowGap;
      const availMosaicH = stageH - marginY * 2 - betweenGap - candTopH;
      if (availMosaicH < 32) continue;
      const m = solveMosaicFlushPreview(candStripW, availMosaicH, activeTiles, desiredCell, 1);
      const effectiveGain = Math.min(m.cell, desiredCell);
      if (effectiveGain > bestAchievedCell + 0.08) {
        bestAchievedCell = effectiveGain;
        side = s;
      }
      if (m.cell >= desiredCell * 0.96) break;
    }
  }

  const specH = Math.max(14, Math.round(side * specRatio));
  const stripW = side * cols + gap * (cols - 1);
  const topStripH = rows * (side + specH) + (rows - 1) * rowGap;

  currentStageTileSize = side;
  currentMiniSpecH = specH;

  stageEl.style.setProperty('--stage-cols', String(cols));
  stageEl.style.setProperty('--stage-rows', String(rows));
  stageEl.style.setProperty('--tile-size', `${side}px`);
  stageEl.style.setProperty('--spec-height', `${specH}px`);
  stageEl.style.setProperty('--slot-gap', `${gap}px`);
  stageEl.style.setProperty('--row-gap', `${rowGap}px`);
  stageEl.style.setProperty('--strip-width', `${stripW}px`);

  const gridLayout = threeStage?.setStageLayoutSpec({
    stripW,
    topStripH,
    betweenGap,
    marginY,
    tileScale,
    desiredCell
  });
  const stripTop = gridLayout?.stackTopY ?? marginY;
  stageEl.style.setProperty('--strip-top', `${stripTop}px`);

  let anyOccupied = false;
  for (let i = 0; i < MAX_STAGE_SLOTS; i++) {
    if (stageSlots[i]?.occupied) {
      stageSlots[i].needsCanvasResizeRedraw = true;
      anyOccupied = true;
    }
  }
  if (anyOccupied) {
    ensureMiniSpecAnimLoop();
  }
}

window.addEventListener('resize', updateStageTileSizes);

function getSliceIdentityKey(slice) {
  return String(slice?.sliceId || slice?.id || slice?.videoUrl || '');
}

function getSliceInstrumentGroupKey(sliceOrSlot) {
  if (!sliceOrSlot) return '';
  if (sliceOrSlot.videoId && state.catalog?.videos) {
    const v = state.catalog.videos.find(item => item.id === sliceOrSlot.videoId);
    if (v) return getVideoGroupKey(v);
  }
  if (sliceOrSlot.videoSlug) {
    return `other::${inferClientGroupName(sliceOrSlot.videoSlug).trim().toLowerCase()}`;
  }
  return '';
}

function getSlotRememberedGroupKey(slot) {
  if (!slot) return '';
  return getSliceInstrumentGroupKey({
    videoId: slot.videoId || slot.lastVideoId,
    videoSlug: slot.videoSlug || slot.lastVideoSlug
  });
}

function allocateStageSlotIndex(sliceKey, groupKey = '') {
  const slotCount = getActiveStageSlotCount();
  const views = new Array(slotCount);
  for (let i = 0; i < slotCount; i++) {
    const sl = stageSlots[i];
    views[i] = {
      occupied: Boolean(sl.occupied),
      fadingOut: Boolean(sl.occupied && sl.fadingOut),
      audioCompleted: Boolean(sl.occupied && sl.voice?.audioCompleted),
      seq: sl.seq || 0,
      lastSeq: sl.lastSeq || 0,
      sliceKey: sl.sliceKey || '',
      groupKey: sl.occupied ? getSliceInstrumentGroupKey(sl) : '',
      rememberedGroupKey: getSlotRememberedGroupKey(sl)
    };
  }
  return chooseStageSlot(views, slotCount, { sliceKey, groupKey });
}

function displaceStageSlotVoice(prevVoice, isSameClip = false) {
  if (!prevVoice || prevVoice.visualTimedOut) return;
  if (prevVoice.maxDisplayTimer) {
    clearTimeout(prevVoice.maxDisplayTimer);
    prevVoice.maxDisplayTimer = null;
  }
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

function clearSlotVideoCanvas(slotIdx) {
  const grid = document.getElementById('polyVideoGrid');
  const canvas = grid?.querySelector(`.stage-slot-unit[data-slot="${slotIdx}"] .slot-video-canvas`);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawSlotVideoFrame(slotIdx, vid) {
  if (!vid || vid.readyState < 2 || !(vid.videoWidth > 0) || !(vid.videoHeight > 0)) return false;
  const grid = document.getElementById('polyVideoGrid');
  const canvas = grid?.querySelector(`.stage-slot-unit[data-slot="${slotIdx}"] .slot-video-canvas`);
  if (!canvas) return false;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = currentStageTileSize;
  const cssH = currentStageTileSize;
  const targetW = Math.max(1, Math.round(cssW * dpr));
  const targetH = Math.max(1, Math.round(cssH * dpr));

  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  const vw = vid.videoWidth;
  const vh = vid.videoHeight;
  const sSide = Math.min(vw, vh);
  const sx = (vw - sSide) * 0.5;
  const sy = (vh - sSide) * 0.5;

  try {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(vid, sx, sy, sSide, sSide, 0, 0, cssW, cssH);
    return true;
  } catch {
    return false;
  }
}

function disposeFeederVideo(videoEl) {
  if (!videoEl) return;
  try {
    videoEl.pause();
  } catch {}
  try {
    videoEl.removeAttribute('src');
    videoEl.load();
  } catch {}
  try {
    videoEl.remove();
  } catch {}
}

function clearSlotMiniSpec(slotIdx) {
  const grid = document.getElementById('polyVideoGrid');
  const canvas = grid?.querySelector(`.stage-slot-unit[data-slot="${slotIdx}"] .slot-mini-spec`);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function applySlotUnitOpacity(slotIdx, slotRecord, nextAlpha) {
  const clamped = Math.max(0, Math.min(1, nextAlpha));
  slotRecord.alpha = clamped;
  const shouldWrite =
    Math.abs(clamped - slotRecord.appliedOpacity) > 0.0005 ||
    (clamped === 0 && slotRecord.appliedOpacity !== 0) ||
    (clamped === 1 && slotRecord.appliedOpacity !== 1);
  if (!shouldWrite) return;
  slotRecord.appliedOpacity = clamped;
  const grid = document.getElementById('polyVideoGrid');
  const unitEl = grid?.querySelector(`.stage-slot-unit[data-slot="${slotIdx}"]`);
  if (unitEl) {
    unitEl.style.opacity = clamped <= 0.0005 ? '0' : clamped >= 0.9995 ? '1' : clamped.toFixed(4);
  }
}

function createStageSquareTile(slice, playbackRate = 1.0, forcedSlotIdx = null) {
  const grid = document.getElementById('polyVideoGrid');
  if (!grid) return null;

  const sliceKey = getSliceIdentityKey(slice);
  const groupKey = getSliceInstrumentGroupKey(slice);
  const slotCount = getActiveStageSlotCount();
  const slotIdx =
    Number.isInteger(forcedSlotIdx) && forcedSlotIdx >= 0 && forcedSlotIdx < slotCount
      ? forcedSlotIdx
      : allocateStageSlotIndex(sliceKey, groupKey);
  const unitEl = grid.querySelector(`.stage-slot-unit[data-slot="${slotIdx}"]`);
  const videoWrap = unitEl?.querySelector('.stage-slot-video');
  if (!unitEl || !videoWrap) return null;

  const prevSlot = stageSlots[slotIdx];
  if (prevSlot.occupied && prevSlot.voice) {
    const isSameClip = Boolean(sliceKey && prevSlot.sliceKey === sliceKey);
    if (prevSlot.fadingOut && !isSameClip) {
      // Slot was already on its fade/decay trajectory: let its release audio finish naturally
      prevSlot.voice.tileObj = null;
    } else {
      displaceStageSlotVoice(prevSlot.voice, isSameClip);
    }
  }

  disposeFeederVideo(prevSlot.videoEl);
  videoWrap.querySelectorAll('video').forEach(v => disposeFeederVideo(v));
  clearSlotVideoCanvas(slotIdx);
  clearSlotMiniSpec(slotIdx);

  // Strict 1-clip-per-slot: deterministically reset opacity to 0 before mounting new feeder video
  unitEl.style.opacity = '0';

  const token = Symbol(`slot_${slotIdx}`);
  stageSlotSeq += 1;

  const trimIn = Math.max(0, Number(slice.trimIn ?? 0));
  const needsTrimSeek = trimIn > 0.005;

  const videoEl = document.createElement('video');
  videoEl.className = 'slot-feeder-video';
  videoEl.muted = true;
  videoEl.playsInline = true;
  videoEl.preload = 'auto';
  videoEl.src = getCachedOrWarmVideoSrc(slice.videoUrl);
  videoEl.addEventListener('ended', () => {
    try {
      videoEl.pause();
    } catch {}
  });
  videoWrap.appendChild(videoEl);

  const slotRecord = {
    occupied: true,
    fadingOut: false,
    alpha: 0,
    appliedOpacity: 0,
    createdMs: performance.now(),
    canPaintVideoFrame: !needsTrimSeek,
    hasPaintedVideoFrame: false,
    firstFrameMs: null,
    fadeOutStartMs: null,
    fadeOutFromAlpha: 0,
    fadeOutDurMs: 0,
    needsCanvasResizeRedraw: false,
    seq: stageSlotSeq,
    lastSeq: stageSlotSeq,
    token,
    sliceKey,
    videoId: slice?.videoId || null,
    videoSlug: slice?.videoSlug || null,
    lastVideoId: slice?.videoId || prevSlot.videoId || prevSlot.lastVideoId || null,
    lastVideoSlug: slice?.videoSlug || prevSlot.videoSlug || prevSlot.lastVideoSlug || null,
    videoEl,
    voice: null,
    miniBitmap: null
  };
  stageSlots[slotIdx] = slotRecord;

  videoEl.playbackRate = Math.max(0.5, Math.min(2.0, playbackRate));

  const wakeStageLoop = () => {
    if (stageSlots[slotIdx] !== slotRecord) return;
    ensureMiniSpecAnimLoop();
  };

  if (needsTrimSeek) {
    const startTrimSeek = () => {
      if (stageSlots[slotIdx] !== slotRecord) return;
      videoEl.addEventListener(
        'seeked',
        () => {
          if (stageSlots[slotIdx] !== slotRecord) return;
          slotRecord.canPaintVideoFrame = true;
          videoEl.play().catch(() => {});
          wakeStageLoop();
        },
        { once: true }
      );
      try {
        videoEl.currentTime = trimIn;
      } catch {
        slotRecord.canPaintVideoFrame = true;
        videoEl.play().catch(() => {});
        wakeStageLoop();
      }
    };
    if (videoEl.readyState >= 1) {
      startTrimSeek();
    } else {
      videoEl.addEventListener('loadedmetadata', startTrimSeek, { once: true });
    }
  } else {
    videoEl.play().catch(() => {});
  }

  if (typeof videoEl.requestVideoFrameCallback === 'function') {
    videoEl.requestVideoFrameCallback(() => wakeStageLoop());
  } else {
    videoEl.addEventListener('loadeddata', wakeStageLoop, { once: true });
  }

  threeStage?.notifyActivity();
  ensureMiniSpecAnimLoop();

  return { slotIdx, token, tile: videoWrap, videoEl };
}

function fadeOutStageTile(tileObj) {
  if (!tileObj || tileObj.slotIdx === undefined) return;
  const { slotIdx, token } = tileObj;
  const slotState = stageSlots[slotIdx];
  if (!slotState || slotState.token !== token) return;
  if (slotState.fadingOut) return;

  const fadeOutSec = clampStageFadeSec(state.stageFadeSec);
  if (fadeOutSec <= 0.002) {
    removeStageTile(tileObj);
    return;
  }

  const fadeInSec = clampStageFadeInSec(state.stageFadeInSec);
  const fullFadeMs = Math.max(50, fadeOutSec * 1000);

  if (!slotState.hasPaintedVideoFrame) {
    if (fadeInSec > 0.002) {
      // Released before even starting fade-in above 0: remove silently with zero flash
      removeStageTile(tileObj);
      return;
    }
    // Fade in is Off (0.0s) on a very short staccato hit whose first frame arrives in a few ms
    slotState.fadingOut = true;
    slotState.fadeOutFromAlpha = 1.0;
    slotState.fadeOutStartMs = performance.now();
    slotState.fadeOutDurMs = fullFadeMs;
  } else {
    const startAlpha = slotState.alpha;
    if (startAlpha <= 0.003) {
      removeStageTile(tileObj);
      return;
    }
    slotState.fadingOut = true;
    slotState.fadeOutFromAlpha = startAlpha;
    slotState.fadeOutStartMs = performance.now();
    slotState.fadeOutDurMs = Math.max(60, fullFadeMs * Math.sqrt(startAlpha));
  }

  threeStage?.notifyActivity();
  ensureMiniSpecAnimLoop();
}

function removeStageTile(tileObj) {
  if (!tileObj || tileObj.slotIdx === undefined) return;
  const { slotIdx, token } = tileObj;
  const slotState = stageSlots[slotIdx];
  if (!slotState || slotState.token !== token) return;

  disposeFeederVideo(slotState.videoEl || tileObj.videoEl);

  const grid = document.getElementById('polyVideoGrid');
  const unitEl = grid?.querySelector(`.stage-slot-unit[data-slot="${slotIdx}"]`);
  if (unitEl) {
    unitEl.style.opacity = '0';
  }
  clearSlotVideoCanvas(slotIdx);
  clearSlotMiniSpec(slotIdx);

  stageSlots[slotIdx] = createEmptyStageSlot(slotState);

  threeStage?.notifyActivity();
}

function buildMiniSpectrogramBitmap(buffer, playbackRate = 1.0, trimIn = 0, bufferSpanSec = null) {
  const W = 256;
  const H = 256;
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

  const { ceilDb, floorDb } = computeSpecDbBounds(colMags, minBin, maxBin, globalMaxDb, 44);
  const denom = Math.max(1e-5, ceilDb - floorDb);
  for (let x = 0; x < W; x++) {
    const dbArr = colMags[x];
    for (let y = 0; y < H; y++) {
      const normY = 1 - y / (H - 1);
      const freq = miniSpecNormYToFreq(normY);
      const exactBin = (freq * fftSizeSpec) / effectiveSr;
      const b0 = Math.max(1, Math.min(half - 2, Math.floor(exactBin)));
      const frac = exactBin - b0;
      const db = dbArr[b0] * (1 - frac) + dbArr[b0 + 1] * frac;
      const norm = (db - floorDb) / denom;
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
      const keylineWidth = getStageSpecKeylineWidth(state.stageSpecScale);
      const normY = miniSpecFreqToNormY(f0Hz);
      const rawYF0 = Math.max(1.5, Math.min(cssH - 1.5, (1 - normY) * (cssH - 1)));
      const yF0 =
        dpr === 1
          ? keylineWidth < 1.5
            ? Math.floor(rawYF0) + 0.5
            : Math.round(rawYF0)
          : rawYF0;
      ctx.save();
      ctx.globalAlpha = stripeAlpha * 0.85;
      ctx.strokeStyle = slot.voice.noteColor || '#ffffff';
      ctx.lineWidth = keylineWidth;
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
    const nowPerfMs = performance.now();
    const audioNow = audioCtx ? audioCtx.currentTime : 0;
    const fadeInSec = clampStageFadeInSec(state.stageFadeInSec);
    const fadeInMs = fadeInSec * 1000;
    let anyActive = false;

    const slotCount = getActiveStageSlotCount();
    for (let i = 0; i < slotCount; i++) {
      const slot = stageSlots[i];
      if (!slot.occupied) continue;

      const vid = slot.videoEl;
      const shouldBlitVideo =
        vid &&
        slot.canPaintVideoFrame &&
        vid.readyState >= 2 &&
        vid.videoWidth > 0 &&
        !vid.seeking &&
        (!slot.voice?.audioCompleted || !slot.hasPaintedVideoFrame || slot.needsCanvasResizeRedraw);

      if (shouldBlitVideo) {
        if (drawSlotVideoFrame(i, vid)) {
          slot.needsCanvasResizeRedraw = false;
          if (!slot.hasPaintedVideoFrame) {
            slot.hasPaintedVideoFrame = true;
            slot.firstFrameMs = nowPerfMs;
          }
        }
      }

      if (slot.voice && slot.miniBitmap && audioCtx) {
        drawSlotMiniSpecFrame(i, audioNow);
      }

      if (!slot.hasPaintedVideoFrame) {
        applySlotUnitOpacity(i, slot, 0);
        if (nowPerfMs - slot.createdMs > 400) {
          if (slot.fadingOut) {
            removeStageTile({ slotIdx: i, token: slot.token, videoEl: slot.videoEl });
            continue;
          }
          slot.hasPaintedVideoFrame = true;
          slot.firstFrameMs = nowPerfMs;
        } else {
          anyActive = true;
          continue;
        }
      }

      let nextAlpha = 1.0;
      if (!slot.fadingOut) {
        if (fadeInMs <= 2) {
          nextAlpha = 1.0;
        } else {
          const uIn = Math.max(0, Math.min(1, (nowPerfMs - slot.firstFrameMs) / fadeInMs));
          nextAlpha = uIn * uIn * (3 - 2 * uIn);
          if (uIn < 1) {
            anyActive = true;
          }
        }
      } else {
        const uOut = Math.max(
          0,
          Math.min(1, (nowPerfMs - slot.fadeOutStartMs) / Math.max(40, slot.fadeOutDurMs))
        );
        nextAlpha = slot.fadeOutFromAlpha * Math.pow(1 - uOut, 1.5);
        if (uOut >= 1 || nextAlpha <= 0.002) {
          removeStageTile({ slotIdx: i, token: slot.token, videoEl: slot.videoEl });
          continue;
        }
        anyActive = true;
      }

      applySlotUnitOpacity(i, slot, nextAlpha);

      if (!slot.voice || !slot.voice.audioCompleted) {
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
  velocity = 0.92,
  forcedSlotIdx = null
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
    maxDisplayTimer: null,
    visualTimedOut: false,
    audioCompleted: false,
    released: false,
    releaseStartCtxTime: null,
    releaseDur: state.releaseSec
  };
  activeVoices.set(triggerId, voice);

  // Claim stage slot synchronously BEFORE async audio decode so simultaneous chord notes
  // always claim slots in deterministic event order across cold and warm runs.
  const tileObj = createStageSquareTile(slice, playbackRate, forcedSlotIdx);
  voice.tileObj = tileObj;
  if (tileObj && stageSlots[tileObj.slotIdx]?.token === tileObj.token) {
    stageSlots[tileObj.slotIdx].voice = voice;
  }
  threeStage?.notifyActivity();

  try {
    const buffer = await loadAudioBuffer(slice.audioUrl);
    if (voice.released || isVideoDisabled(slice.videoId)) {
      if (voice.tileObj) {
        removeStageTile(voice.tileObj);
        voice.tileObj = null;
      }
      if (activeVoices.get(triggerId) === voice) {
        activeVoices.delete(triggerId);
      }
      if (midi !== null && !isMidiStillHeld(midi)) setKeyActiveClass(midi, false);
      threeStage?.notifyActivity();
      return;
    }

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
      scheduleVoiceMaxDisplayTimeout(voice);
      voice.naturalTimer = setTimeout(() => {
        voice.naturalTimer = null;
        if (!voice.released) {
          voice.audioCompleted = true;
          const vid = voice.tileObj?.videoEl;
          if (vid) {
            try {
              vid.pause();
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
    if (voice.maxDisplayTimer) {
      clearTimeout(voice.maxDisplayTimer);
      voice.maxDisplayTimer = null;
    }
    if (voice.tileObj) removeStageTile(voice.tileObj);
    if (activeVoices.get(triggerId) === voice) {
      activeVoices.delete(triggerId);
    }
    threeStage?.notifyActivity();
  }
}

function applyVoiceReleaseRamp(voice, customReleaseSec = null) {
  const ctx = ensureAudioContext();
  const now = ctx.currentTime;

  if (voice.maxDisplayTimer) {
    clearTimeout(voice.maxDisplayTimer);
    voice.maxDisplayTimer = null;
  }
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
    voice.releaseDur = clampStageFadeSec(state.stageFadeSec);
    if (voice.tileObj) {
      fadeOutStageTile(voice.tileObj);
    } else {
      threeStage?.notifyActivity();
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

  // Immediately begin smooth visual fade-out while video continues playing!
  if (voice.tileObj) {
    fadeOutStageTile(voice.tileObj);
  } else {
    threeStage?.notifyActivity();
  }
}

function releaseHeldVoice(triggerId, customReleaseSec = null) {
  if (triggerId && !String(triggerId).startsWith('midifile_')) {
    recordLiveNoteOff(triggerId);
  }
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
  if (t <= 0.03) return [0, 0, 0];
  const u = (t - 0.03) / 0.97;
  const toe = Math.min(1, u / 0.04);
  const curved = Math.max(0, Math.min(1, Math.pow(u, 0.85) * toe));
  const v = Math.max(0, Math.min(255, Math.round(curved * 250)));
  return [v, v, v];
}

const spectrogramBitmapCache = new Map();
const bladeRowSpecCache = new Map();

function buildSpectrogramOffscreen(
  buffer,
  f0Hz,
  f0Label,
  cssW = 360,
  cssH = 136,
  dpr = 1,
  playbackRate = 1.0,
  showHarmonics = true,
  noteColor = '#ffffff',
  rawDurSec = null
) {
  const W = Math.max(160, Math.round(cssW));
  const H = Math.max(80, Math.round(cssH));

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

  const clipSpanSec = rawDurSec
    ? Math.min(MAX_CLIP_DUR, rawDurSec)
    : Math.min(MAX_CLIP_DUR, buffer.duration);
  const maxSamples = Math.min(ch.length, Math.floor(clipSpanSec * buffer.sampleRate));

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

  const { ceilDb, floorDb } = computeSpecDbBounds(colMags, minBin, maxBin, globalMaxDb, 52);
  const denom = Math.max(1e-5, ceilDb - floorDb);
  for (let x = 0; x < W; x++) {
    const dbArr = colMags[x];
    for (let y = 0; y < H; y++) {
      const normY = 1 - y / (H - 1);
      const freq = specNormYToFreq(normY);
      const exactBin = (freq * fftSizeSpec) / effectiveSr;
      const b0 = Math.max(1, Math.min(half - 2, Math.floor(exactBin)));
      const frac = exactBin - b0;
      const db = dbArr[b0] * (1 - frac) + dbArr[b0 + 1] * frac;
      const norm = (db - floorDb) / denom;
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

  if (showHarmonics && f0Hz >= 50 && f0Hz <= SPEC_MAX_FREQ) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    for (let h = 2; h <= 3; h++) {
      const hf = f0Hz * h;
      if (hf >= SPEC_MIN_FREQ && hf <= SPEC_MAX_FREQ) {
        const yh = H - 1 - specFreqToNormY(hf) * (H - 1);
        ctx.beginPath();
        ctx.moveTo(0, yh);
        ctx.lineTo(W, yh);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);

    const yF0 = Math.max(2, Math.min(H - 3, H - 1 - specFreqToNormY(f0Hz) * (H - 1)));
    ctx.strokeStyle = noteColor;
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    ctx.moveTo(0, yF0);
    ctx.lineTo(W, yF0);
    ctx.stroke();

    const tagText = `${f0Hz} Hz`;
    ctx.font = '600 9.5px "Google Sans", -apple-system, BlinkMacSystemFont, sans-serif';
    const tagW = Math.ceil(ctx.measureText(tagText).width) + 10;
    const tagY = Math.max(3, Math.min(H - 17, yF0 - 15));
    ctx.fillStyle = 'rgba(0, 0, 0, 0.84)';
    ctx.fillRect(W - tagW - 5, tagY, tagW, 14);
    ctx.strokeStyle = noteColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(W - tagW - 5 + 0.5, tagY + 0.5, tagW - 1, 13);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(tagText, W - tagW, tagY + 10.5);
  }

  return offCanvas;
}

// ============================================================================
// Unified Hamburger Toggle: Left Video File Explorer + Bottom Transport Dock
// ============================================================================
function setChromeCollapsed(nextCollapsed) {
  state.chromeCollapsed = Boolean(nextCollapsed);
  if (state.chromeCollapsed) {
    if (typeof closeInspectorBlade === 'function') closeInspectorBlade();
    if (typeof closeMidiBrowserPopover === 'function') closeMidiBrowserPopover();
  }
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

function buildOrderedExplorerModel() {
  const activeVideos = (state.catalog?.videos || []).filter(v => !v.deleted);
  const byCat = new Map();
  for (const v of activeVideos) {
    const cat = String(v.category || 'other').toLowerCase();
    if (!byCat.has(cat)) byCat.set(cat, new Map());
    const catMap = byCat.get(cat);
    const gName = getVideoGroupName(v);
    const gKey = gName.trim().toLowerCase();
    if (!catMap.has(gKey)) {
      catMap.set(gKey, {
        key: `${cat}::${gKey}`,
        cat,
        name: gName,
        videos: []
      });
    }
    catMap.get(gKey).videos.push(v);
  }

  let totalGroups = 0;
  let enabledGroups = 0;
  for (const catMap of byCat.values()) {
    for (const grp of catMap.values()) {
      totalGroups++;
      if (grp.videos.some(v => !isVideoDisabled(v.id))) {
        enabledGroups++;
      }
    }
  }

  const orderedCats = [
    ...CATEGORY_ORDER.filter(c => byCat.has(c)),
    ...Array.from(byCat.keys())
      .filter(c => !CATEGORY_ORDER.includes(c))
      .sort()
  ];

  const categories = [];
  for (const cat of orderedCats) {
    const catMap = byCat.get(cat);
    if (!catMap || catMap.size === 0) continue;
    const groups = Array.from(catMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    );
    for (const grp of groups) {
      grp.videos.sort((a, b) =>
        String(a.slug || '').localeCompare(String(b.slug || ''), undefined, {
          numeric: true,
          sensitivity: 'base'
        })
      );
    }
    categories.push({
      cat,
      groups,
      videos: groups.flatMap(g => g.videos)
    });
  }

  return { categories, totalGroups, enabledGroups };
}

function getVisibleExplorerNavItems() {
  const { categories } = buildOrderedExplorerModel();
  const items = [];
  for (const c of categories) {
    items.push({
      type: 'cat',
      cat: c.cat,
      videoIds: c.videos.map(v => v.id)
    });
    if (!state.collapsedCategories.has(c.cat)) {
      for (const grp of c.groups) {
        items.push({
          type: 'group',
          cat: c.cat,
          groupKey: grp.key,
          name: grp.name,
          videoId: grp.videos[0].id,
          videoIds: grp.videos.map(v => v.id)
        });
      }
    }
  }
  return items;
}

function syncExplorerHighlightClasses() {
  const listEl = document.getElementById('explorerList');
  if (!listEl) return;

  const isExplorerCursor = state.selectionTarget === 'explorer';
  const focus = typeof bladeState !== 'undefined' ? bladeState.explorerFocus : null;
  const openGroupKey =
    typeof bladeState !== 'undefined' && bladeState.open ? bladeState.groupKey : null;

  listEl.querySelectorAll('.explorer-cat-group').forEach(groupEl => {
    const cat = groupEl.dataset.category;
    const headerEl = groupEl.querySelector('.explorer-cat-header');
    if (headerEl) {
      headerEl.classList.toggle(
        'is-cursor-focus',
        Boolean(isExplorerCursor && focus?.type === 'cat' && focus.cat === cat)
      );
    }
  });

  listEl.querySelectorAll('.explorer-video-row').forEach(rowEl => {
    const gKey = rowEl.dataset.groupKey;
    rowEl.classList.toggle('is-blade-open', Boolean(openGroupKey && gKey === openGroupKey));
    rowEl.classList.toggle(
      'is-cursor-focus',
      Boolean(isExplorerCursor && focus?.type === 'group' && focus.groupKey === gKey)
    );
  });
}

function renderFileExplorer() {
  const listEl = document.getElementById('explorerList');
  if (!listEl) return;

  const prevScrollTop = listEl.scrollTop;
  const { categories } = buildOrderedExplorerModel();

  listEl.innerHTML = '';

  for (const { cat, groups, videos: catVideos } of categories) {
    const enabledVidsInCat = catVideos.filter(v => !isVideoDisabled(v.id)).length;
    const isCollapsed = state.collapsedCategories.has(cat);

    const groupEl = document.createElement('div');
    groupEl.className = `explorer-cat-group${isCollapsed ? ' is-collapsed' : ''}`;
    groupEl.dataset.category = cat;

    const headerEl = document.createElement('div');
    headerEl.className = 'explorer-cat-header';

    const catSwitchClass = enabledVidsInCat > 0 ? 'ui-switch is-on' : 'ui-switch';

    headerEl.innerHTML = `
      <div class="explorer-cat-left">
        <span class="explorer-cat-caret">▾</span>
        <span class="explorer-cat-name">${cat}</span>
        <span class="explorer-cat-count">${groups.length}</span>
      </div>
      <button
        type="button"
        class="${catSwitchClass}"
        role="switch"
        aria-checked="${enabledVidsInCat > 0 ? 'true' : 'false'}"
        title="${enabledVidsInCat > 0 ? `Mute all ${cat} groups` : `Enable all ${cat} groups`}"
      ></button>
    `;

    headerEl.addEventListener('click', e => {
      if (e.target.closest('.ui-switch')) return;
      const willCollapse = !state.collapsedCategories.has(cat);
      if (willCollapse) state.collapsedCategories.add(cat);
      else state.collapsedCategories.delete(cat);
      groupEl.classList.toggle('is-collapsed', willCollapse);
      bladeState.explorerFocus = { type: 'cat', cat };
      if (willCollapse && bladeState.open && bladeState.groupKey?.startsWith(`${cat}::`)) {
        closeInspectorBlade({ keepExplorerFocus: true });
      }
      setSelectionFocus('explorer');
    });

    const catSwitchBtn = headerEl.querySelector('.ui-switch');
    catSwitchBtn.addEventListener('click', e => {
      e.stopPropagation();
      const nextEnabled = enabledVidsInCat === 0;
      setVideosEnabled(
        catVideos.map(v => v.id),
        nextEnabled
      );
    });

    const itemsEl = document.createElement('div');
    itemsEl.className = 'explorer-cat-items';

    for (const grp of groups) {
      const grpVideos = grp.videos;
      const enabledCount = grpVideos.filter(v => !isVideoDisabled(v.id)).length;
      const allMuted = enabledCount === 0;
      const sliceCount = grpVideos.reduce(
        (sum, v) => sum + (v.slices || []).filter(s => !s.deleted).length,
        0
      );

      const nonZeroGains = grpVideos.map(v => getVideoGainDb(v.id)).filter(g => g !== 0);
      let gainTagHtml = '';
      if (nonZeroGains.length > 0) {
        const allSameGain =
          nonZeroGains.length === grpVideos.length &&
          nonZeroGains.every(g => g === nonZeroGains[0]);
        const badgeTxt = allSameGain
          ? `${nonZeroGains[0] > 0 ? `+${nonZeroGains[0]}` : nonZeroGains[0]}dB`
          : '±dB';
        gainTagHtml = `<span class="explorer-gain-tag" title="Custom volume trim active">${badgeTxt}</span>`;
      }

      const grpSwitchClass = enabledCount > 0 ? 'ui-switch is-on' : 'ui-switch';

      const rowEl = document.createElement('div');
      rowEl.className = `explorer-video-row${allMuted ? ' is-muted' : ''}`;
      rowEl.dataset.groupKey = grp.key;
      rowEl.dataset.videoId = grpVideos[0].id;
      const vidCountMeta =
        grpVideos.length > 1 ? `${grpVideos.length} videos · ` : '';
      rowEl.title = `${grp.name} (${vidCountMeta}${sliceCount} sample${sliceCount === 1 ? '' : 's'}) — click to open/close inspector`;

      rowEl.innerHTML = `
        <span class="explorer-video-label">${grp.name}</span>
        ${gainTagHtml}
        <span class="explorer-video-meta">${sliceCount}</span>
        <button
          type="button"
          class="${grpSwitchClass}"
          role="switch"
          aria-checked="${enabledCount > 0 ? 'true' : 'false'}"
          title="${enabledCount > 0 ? `Mute ${grp.name}` : `Enable ${grp.name}`}"
        ></button>
      `;

      const switchBtn = rowEl.querySelector('.ui-switch');
      switchBtn.addEventListener('click', e => {
        e.stopPropagation();
        setVideosEnabled(
          grpVideos.map(v => v.id),
          enabledCount === 0
        );
      });

      rowEl.addEventListener('click', e => {
        if (e.target.closest('.ui-switch')) return;
        e.stopPropagation();
        bladeState.explorerFocus = {
          type: 'group',
          cat,
          groupKey: grp.key,
          videoId: grpVideos[0].id
        };
        if (bladeState.open && bladeState.groupKey === grp.key) {
          closeInspectorBlade({ keepExplorerFocus: true });
          setSelectionFocus('explorer');
          return;
        }
        openInspectorBlade(grpVideos[0].id, {
          expandedSliceId: null,
          autoPlay: false,
          focusTarget: 'explorer'
        });
      });

      itemsEl.appendChild(rowEl);
    }

    groupEl.appendChild(headerEl);
    groupEl.appendChild(itemsEl);
    listEl.appendChild(groupEl);
  }

  listEl.scrollTop = prevScrollTop;
  syncExplorerHighlightClasses();
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

function syncActiveCandidateHighlightUI(scrollActive = false) {
  const activeSliceId = lastPlayedSliceByMidi.get(state.selectedMidi) || null;
  const cands = getVisibleCandidatesForMidi(state.selectedMidi);
  if (activeSliceId && cands.length > 0) {
    const matchIdx = cands.findIndex(c => c.sliceId === activeSliceId);
    if (matchIdx >= 0) {
      state.auditionIndex = matchIdx;
    }
  }

  const grid = document.getElementById('candidatesGrid');
  if (!grid) return;
  let activeCardEl = null;
  grid.querySelectorAll('.candidate-card').forEach(el => {
    const isMatch = Boolean(activeSliceId && el.dataset.sliceId === activeSliceId);
    el.classList.toggle('is-active-sample', isMatch);
    if (isMatch) activeCardEl = el;
  });

  if (scrollActive && activeCardEl && state.noteSamplesExpanded) {
    activeCardEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

function startPianoKeyHold(triggerId, midi, velocity = 0.92, selectInDeck = true) {
  if (midi < MIN_MIDI || midi > MAX_MIDI) return;
  if (triggerId && !String(triggerId).startsWith('midifile_')) {
    recordLiveNoteOn(triggerId, midi, velocity);
  }
  if (selectInDeck && state.selectedMidi !== midi) {
    selectKeyForConfig(midi, false, Boolean(bladeState?.open));
  }

  const cand = pickEnabledCandidateForMidi(midi);
  if (!cand) {
    startHeldVoice({ triggerId, midi, slice: null, velocity });
    return;
  }

  state.lastPlayedVideoId = cand.videoId;
  state.lastPlayedSliceId = cand.sliceId;
  if (midi === state.selectedMidi) {
    syncActiveCandidateHighlightUI(true);
  }

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
  if (midi === state.selectedMidi) {
    syncActiveCandidateHighlightUI(true);
  }

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

function setNoteSamplesExpanded(nextExpanded) {
  state.noteSamplesExpanded = Boolean(nextExpanded);
  savePrefsToStorage();
  const drawerEl = document.getElementById('noteSamplesDrawer');
  const toggleBtn = document.getElementById('noteSamplesToggleBtn');
  if (drawerEl) {
    drawerEl.classList.toggle('collapsed', !state.noteSamplesExpanded);
  }
  if (toggleBtn) {
    toggleBtn.classList.toggle('is-open', state.noteSamplesExpanded);
    toggleBtn.setAttribute('aria-expanded', state.noteSamplesExpanded ? 'true' : 'false');
  }
  requestAnimationFrame(() => updateStageTileSizes());
  setTimeout(() => updateStageTileSizes(), 220);
}

function updateSelectedNoteChipUI() {
  const midi = state.selectedMidi;
  const noteName = midiToName(midi);
  const noteColor = getNoteColor(midi);

  const selDot = document.getElementById('selectedNoteDot');
  const selLabel = document.getElementById('selectedNoteLabel');
  const selBtn = document.getElementById('noteSamplesToggleBtn');

  if (selDot) selDot.style.background = noteColor;
  if (selLabel) selLabel.textContent = noteName;
  if (selBtn) {
    selBtn.title = state.noteSamplesExpanded
      ? `Collapse samples for ${noteName}`
      : `Edit samples for ${noteName}`;
  }
}

function setSelectionFocus(target, sliceId = null) {
  const validTargets = new Set(['keyboard', 'tile', 'explorer', 'blade']);
  state.selectionTarget = validTargets.has(target) ? target : 'keyboard';
  state.selectedTileSliceId =
    state.selectionTarget === 'tile' && sliceId ? String(sliceId) : null;
  threeStage?.setSelectedSliceId?.(state.selectedTileSliceId);

  document.querySelectorAll('.wf-key').forEach(el => {
    const m = Number(el.dataset.midi);
    el.classList.toggle(
      'selected-key',
      state.selectionTarget === 'keyboard' && m === state.selectedMidi
    );
  });
  syncExplorerHighlightClasses();
}

function stepTileSelection(dCol, dRow) {
  const nextItem = threeStage?.stepSelection?.(dCol, dRow);
  if (!nextItem) return;
  setSelectionFocus('tile', nextItem.sliceId);
  const cand = resolvePlayableSliceById(nextItem.sliceId);
  if (!cand) return;
  state.lastPlayedVideoId = cand.videoId;
  state.lastPlayedSliceId = cand.sliceId;
  if (cand.enabled) {
    lastPlayedSliceByMidi.set(cand.midi, cand.sliceId);
  }
  if (cand.midi >= MIN_MIDI && cand.midi <= MAX_MIDI) {
    selectKeyForConfig(cand.midi, false, true);
  }
  if (cand.midi === state.selectedMidi) {
    syncActiveCandidateHighlightUI(true);
  }
  startHeldVoice({
    triggerId: 'tile_cursor_preview',
    midi: cand.midi,
    slice: cand,
    playbackRate: cand.playbackRate || 1.0,
    velocity: 0.92
  });
  scheduleDefaultVoiceGate('tile_cursor_preview', DEFAULT_UI_HOLD_SEC);
}

function selectKeyForConfig(midi, shouldTapPreview = false, keepTileFocus = false) {
  const clamped = Math.max(MIN_MIDI, Math.min(MAX_MIDI, midi));
  state.selectedMidi = clamped;
  if (!keepTileFocus) {
    state.selectionTarget = 'keyboard';
    state.selectedTileSliceId = null;
    threeStage?.setSelectedSliceId?.(null);
    syncExplorerHighlightClasses();
  }

  const visCands = getVisibleCandidatesForMidi(clamped);
  if (visCands.length > 0) {
    const firstEnabledIdx = visCands.findIndex(c => c.enabled);
    state.auditionIndex = firstEnabledIdx >= 0 ? firstEnabledIdx : 0;
  } else {
    state.auditionIndex = 0;
  }

  // If stepping with arrows moves outside visible keyboard range, scroll octave window to follow
  const visSpan = state.visibleOctaves * 12;
  if (!keepTileFocus && clamped < state.baseOctaveMidi) {
    state.baseOctaveMidi = clampKeyboardStartMidi(Math.floor(clamped / 12) * 12, state.visibleOctaves);
    renderPianoKeyboard();
  } else if (!keepTileFocus && clamped >= state.baseOctaveMidi + visSpan) {
    state.baseOctaveMidi = clampKeyboardStartMidi(
      Math.floor(clamped / 12) * 12 - (state.visibleOctaves - 1) * 12,
      state.visibleOctaves
    );
    renderPianoKeyboard();
  } else {
    document.querySelectorAll('.wf-key').forEach(el => {
      const m = Number(el.dataset.midi);
      el.classList.toggle(
        'selected-key',
        state.selectionTarget === 'keyboard' && m === clamped
      );
    });
  }

  renderSelectedKeyDeck();

  if (shouldTapPreview) {
    triggerDefaultPianoGate('arrow_preview', clamped, 0.9, false);
  }
}

// ============================================================================
// Responsive 3–6 Octave Wireframe Keyline Chromatic Keyboard
// ============================================================================
let wfKeyboardDragActive = false;
let wfKeyboardDragMidi = null;
let wfKeyboardDragStartMs = 0;

function computeResponsiveOctaveCount(widthPx) {
  if (!Number.isFinite(widthPx) || widthPx <= 0) return state.visibleOctaves || 5;
  // ~158px per octave (~22.5px per natural key) cleanly scales between 3 and 6 octaves
  const fit = Math.floor(widthPx / 158);
  return Math.max(MIN_VISIBLE_OCTAVES, Math.min(MAX_VISIBLE_OCTAVES, fit));
}

function shiftKeyboardOctave(deltaOctaves) {
  const nextBase = clampKeyboardStartMidi(
    state.baseOctaveMidi + deltaOctaves * 12,
    state.visibleOctaves
  );
  const nextQwerty = normalizeQwertyOctaveMidi(state.qwertyOctaveMidi + deltaOctaves * 12);
  if (nextBase === state.baseOctaveMidi && nextQwerty === state.qwertyOctaveMidi) return;

  state.hasCustomKeyboardOctave = true;
  state.baseOctaveMidi = nextBase;
  state.qwertyOctaveMidi = Math.max(
    nextBase,
    Math.min(nextBase + (state.visibleOctaves - 1) * 12, nextQwerty)
  );
  savePrefsToStorage();
  renderPianoKeyboard();
}

function renderPianoKeyboard() {
  const container = document.getElementById('pianoKeyboard');
  if (!container) return;

  const totalW = Math.round(container.clientWidth || 0);
  if (totalW > 0) {
    const nextOctaves = computeResponsiveOctaveCount(totalW);
    if (nextOctaves !== state.visibleOctaves) {
      state.visibleOctaves = nextOctaves;
      if (!state.hasCustomKeyboardOctave) {
        state.baseOctaveMidi = getDefaultStartMidiForOctaves(nextOctaves);
      } else {
        state.baseOctaveMidi = clampKeyboardStartMidi(state.baseOctaveMidi, nextOctaves);
      }
    }
  }

  container.innerHTML = '';

  const visOctaves = state.visibleOctaves;
  const maxStartMidi = Math.max(MIN_BASE_OCTAVE_MIDI, TOP_KEYBOARD_MIDI_LIMIT - visOctaves * 12);
  const startMidi = clampKeyboardStartMidi(state.baseOctaveMidi, visOctaves);
  state.baseOctaveMidi = startMidi;
  const endMidi = startMidi + visOctaves * 12 - 1;

  const rangeLabel = document.getElementById('octaveRangeLabel');
  if (rangeLabel) {
    rangeLabel.textContent = `${midiToName(startMidi)}–${midiToName(endMidi)}`;
  }
  const octDownBtn = document.getElementById('octDownBtn');
  if (octDownBtn) octDownBtn.disabled = startMidi <= MIN_BASE_OCTAVE_MIDI;
  const octUpBtn = document.getElementById('octUpBtn');
  if (octUpBtn) octUpBtn.disabled = startMidi >= maxStartMidi;

  const totalNaturals = visOctaves * 7;
  const unitWidthPct = 100 / totalNaturals;
  const xEdgePx = u => Math.round((u / totalNaturals) * totalW);
  const keyMap = state.catalog?.keyboardMap || {};

  for (let i = 0; i < visOctaves * 12; i++) {
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
      state.selectionTarget === 'keyboard' && midi === state.selectedMidi ? 'selected-key' : '',
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
    if (!inRange) {
      keyEl.title = `${fullNoteName} (out of range)`;
    } else if (midi < 36 && candCount > 0) {
      keyEl.title = `${fullNoteName} · ${getVideoGroupName(visCands[0].videoId)}`;
    } else {
      keyEl.title = fullNoteName;
    }

    container.appendChild(keyEl);
  }
}

// ============================================================================
// Collapsible Single-Note Sample Controls
// ============================================================================
function getCandidatesForSelectedKey() {
  return getVisibleCandidatesForMidi(state.selectedMidi);
}

function renderSelectedKeyDeck() {
  updateSelectedNoteChipUI();

  const midi = state.selectedMidi;
  const noteName = midiToName(midi);

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
    emptyDiv.textContent = `${noteName} — no active video samples`;
    grid.appendChild(emptyDiv);
    return;
  }

  const activeSliceId = lastPlayedSliceByMidi.get(midi) || null;

  candidates.forEach((cand, idx) => {
    const isEnabled = !!cand.enabled;
    const isActiveSample = Boolean(activeSliceId && cand.sliceId === activeSliceId);
    const readableGroup = getVideoGroupName(cand.videoId) || cand.groupName || cand.videoSlug;
    const card = document.createElement('div');
    card.dataset.sliceId = cand.sliceId;
    card.className = [
      'candidate-card',
      isEnabled ? 'is-enabled' : '',
      isActiveSample ? 'is-active-sample' : ''
    ]
      .filter(Boolean)
      .join(' ');

    card.innerHTML = `
      <div class="cand-thumb-wrap" title="Click to inspect sample (${readableGroup} · ${cand.videoSlug} · ${noteName})">
        <img src="${withBust(cand.thumbUrl)}" alt="${readableGroup}" loading="lazy" />
      </div>
      <div class="cand-slug-title" title="${readableGroup} (${cand.videoSlug})">${readableGroup}</div>
      <button
        class="ui-switch${isEnabled ? ' is-on' : ''}"
        type="button"
        role="switch"
        aria-checked="${isEnabled ? 'true' : 'false'}"
        title="${isEnabled ? `Mute sample (${readableGroup})` : `Enable sample (${readableGroup})`}"
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
      if (isEnabled) {
        lastPlayedSliceByMidi.set(midi, cand.sliceId);
        syncActiveCandidateHighlightUI(false);
      }
      openInspectorBlade(cand.videoId, {
        expandedSliceId: cand.sliceId,
        playbackRate: cand.playbackRate || 1.0,
        autoPlay: true,
        scrollIntoView: true,
        focusTarget: 'blade'
      });
    });

    grid.appendChild(card);
  });
}

// ============================================================================
// Unified Flush Instrument + Sample Sidebar Blade (#inspectorBlade)
// ============================================================================
const TRASH_ICON_SVG = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11"/><path d="M6 4V2.6c0-.33.27-.6.6-.6h2.8c.33 0 .6.27.6.6V4"/><path d="M4.2 4l.6 9.1c.03.5.45.9.95.9h4.5c.5 0 .92-.4.95-.9L11.8 4"/><path d="M6.8 6.8v4.5"/><path d="M9.2 6.8v4.5"/></svg>`;

const bladeState = {
  open: false,
  groupKey: null,
  groupVideos: [],
  explorerFocus: null, // { type: 'cat', cat } | { type: 'group', cat, groupKey, videoId }
  expandedVideoId: null,
  expandedSliceId: null,
  video: null,
  slice: null,
  playbackRate: 1.0,
  assignedMidi: 60,
  rawDur: 2.0,
  inSec: 0,
  outSec: 2.0,
  sliceAudioBuffer: null,
  sharedVideoEl: null,
  previewRaf: null,
  previewAudioSrc: null,
  previewGainNode: null,
  previewStartCtxTime: 0,
  previewPlayDur: 0,
  refToneStopFn: null,
  refToneUiTimer: null,
  trashArmedVideoId: null,
  trashVideoTimer: null,
  trashSliceArmed: false,
  trashSliceTimer: null,
  dragMode: null,
  dragMoved: false,
  dragStartX: 0,
  dragStartIn: 0,
  dragStartOut: 0,
  renderGen: 0
};

function getActiveVideoSlices(video) {
  return (video?.slices || []).filter(s => !s.deleted);
}

function findKeyboardCandidate(sliceId) {
  if (!sliceId) return null;
  const km = state.catalog?.keyboardMap || {};
  for (const entry of Object.values(km)) {
    const found = (entry.candidates || []).find(c => c.sliceId === sliceId);
    if (found) return found;
  }
  return null;
}

function formatTuneReadout(cents) {
  const c = Math.round(Number(cents || 0));
  if (c === 0) return '0 st';
  const val = Math.max(0.1, Math.abs(c) / 100).toFixed(1);
  return `${c > 0 ? `+${val}` : `-${val}`} st`;
}

function getMinTrimLen(rawDur = bladeState.rawDur) {
  return Math.min(0.20, Math.max(0.08, rawDur * 0.5));
}

function getSharedBladeVideoEl() {
  if (!bladeState.sharedVideoEl) {
    const v = document.createElement('video');
    v.playsInline = true;
    v.preload = 'auto';
    v.muted = true;
    bladeState.sharedVideoEl = v;
  }
  return bladeState.sharedVideoEl;
}

function releaseSharedBladeVideo() {
  const v = bladeState.sharedVideoEl;
  if (!v) return;
  try {
    v.pause();
  } catch {}
  v.onloadedmetadata = null;
  v.removeAttribute('data-slice-id');
  if (v.parentNode) {
    v.parentNode.removeChild(v);
  }
  if (v.getAttribute('src')) {
    v.removeAttribute('src');
    try {
      v.load();
    } catch {}
  }
}

function getBladeOrderedSamples() {
  const list = [];
  let globalIdx = 0;
  for (const v of bladeState.groupVideos || []) {
    const slices = getActiveVideoSlices(v);
    slices.forEach((slice, localIdx) => {
      list.push({ video: v, slice, localIdx, globalIdx: globalIdx++ });
    });
  }
  return list;
}

function resetBladeTrashConfirmUI() {
  bladeState.trashArmedVideoId = null;
  if (bladeState.trashVideoTimer) {
    clearTimeout(bladeState.trashVideoTimer);
    bladeState.trashVideoTimer = null;
  }
  bladeState.trashSliceArmed = false;
  if (bladeState.trashSliceTimer) {
    clearTimeout(bladeState.trashSliceTimer);
    bladeState.trashSliceTimer = null;
  }
  document.querySelectorAll('#bladeScroll .video-card-trash-btn').forEach(btn => {
    btn.classList.remove('confirm-armed');
    btn.innerHTML = TRASH_ICON_SVG;
  });
  const clipTrashBtn = document.getElementById('bladeTrashSliceBtn');
  if (clipTrashBtn) {
    clipTrashBtn.classList.remove('confirm-armed');
    clipTrashBtn.innerHTML = TRASH_ICON_SVG;
  }
}

function stopReferenceTone(immediate = false) {
  if (bladeState.refToneUiTimer) {
    clearTimeout(bladeState.refToneUiTimer);
    bladeState.refToneUiTimer = null;
  }
  const btn = document.getElementById('bladeTestToneBtn');
  if (btn) btn.classList.remove('ringing');
  if (bladeState.refToneStopFn) {
    const fn = bladeState.refToneStopFn;
    bladeState.refToneStopFn = null;
    fn(immediate);
  }
}

function playReferenceTone(midi = bladeState.assignedMidi) {
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

  const btn = document.getElementById('bladeTestToneBtn');
  if (btn) btn.classList.add('ringing');

  let stopped = false;
  bladeState.refToneStopFn = fast => {
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

  bladeState.refToneUiTimer = setTimeout(() => {
    bladeState.refToneUiTimer = null;
    bladeState.refToneStopFn = null;
    if (btn) btn.classList.remove('ringing');
  }, Math.round(dur * 1000));
}

function stopBladePreview() {
  if (bladeState.previewRaf) {
    cancelAnimationFrame(bladeState.previewRaf);
    bladeState.previewRaf = null;
  }
  if (bladeState.previewAudioSrc) {
    try {
      bladeState.previewAudioSrc.stop();
    } catch {}
    try {
      bladeState.previewAudioSrc.disconnect();
    } catch {}
    bladeState.previewAudioSrc = null;
  }
  if (bladeState.previewGainNode) {
    try {
      bladeState.previewGainNode.disconnect();
    } catch {}
    bladeState.previewGainNode = null;
  }
  const vid = bladeState.sharedVideoEl;
  if (vid && vid.parentNode) {
    try {
      vid.pause();
    } catch {}
  }
  const specPh = document.getElementById('bladeSpecPlayhead');
  if (specPh) specPh.classList.remove('visible');
  const btn = document.getElementById('bladePreviewBtn');
  if (btn) btn.textContent = '▶ Preview';
}

function scrubBladeVideoTo(sec) {
  const vid = bladeState.sharedVideoEl;
  if (!vid || !vid.parentNode) return;
  const maxT = Math.max(0.05, Math.min(MAX_CLIP_DUR, bladeState.rawDur || MAX_CLIP_DUR));
  const clamped = Math.max(0, Math.min(maxT, sec));
  if (Math.abs(vid.currentTime - clamped) > 0.015) {
    try {
      vid.muted = true;
      vid.currentTime = clamped;
    } catch {}
  }
}

async function startBladePreview(forceRestart = false, explicitTarget = null) {
  if (!forceRestart && (bladeState.previewRaf || bladeState.previewAudioSrc)) {
    stopBladePreview();
    return;
  }
  stopBladePreview();

  let targetVideo = explicitTarget?.video || bladeState.video;
  let targetSlice = explicitTarget?.slice || bladeState.slice;
  if (!targetSlice) {
    const first = getBladeOrderedSamples()[0];
    if (!first) return;
    targetVideo = first.video;
    targetSlice = first.slice;
  }
  if (!targetVideo || !targetSlice) return;

  const isExpandedSlice = bladeState.expandedSliceId === targetSlice.id;
  let buffer = isExpandedSlice ? bladeState.sliceAudioBuffer : null;
  if (!buffer) {
    try {
      buffer = await loadAudioBuffer(targetSlice.audioUrl);
      if (!bladeState.open) return;
      if (isExpandedSlice && bladeState.slice?.id === targetSlice.id) {
        bladeState.sliceAudioBuffer = buffer;
      }
    } catch {
      return;
    }
  }

  const cand = findKeyboardCandidate(targetSlice.id);
  const rate = Math.max(
    0.25,
    Math.min(4.0, isExpandedSlice ? bladeState.playbackRate || 1.0 : cand?.playbackRate || 1.0)
  );
  const rawLimit = Math.min(
    MAX_CLIP_DUR,
    isExpandedSlice ? bladeState.rawDur : buffer.duration,
    buffer.duration
  );
  const savedIn = isExpandedSlice
    ? bladeState.inSec
    : Number(cand?.trimIn ?? targetSlice.trimIn ?? 0);
  const savedOut = isExpandedSlice
    ? bladeState.outSec
    : Number(cand?.trimOut ?? targetSlice.trimOut ?? rawLimit);
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
  const gainDb = getVideoGainDb(targetVideo.id);
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

  bladeState.previewAudioSrc = src;
  bladeState.previewGainNode = gainNode;
  bladeState.previewStartCtxTime = now;
  bladeState.previewPlayDur = playDur;

  if (!isExpandedSlice) {
    const tickAudioOnly = () => {
      if (!bladeState.open || !bladeState.previewAudioSrc) {
        stopBladePreview();
        return;
      }
      if (ctx.currentTime - bladeState.previewStartCtxTime >= bladeState.previewPlayDur) {
        stopBladePreview();
        return;
      }
      bladeState.previewRaf = requestAnimationFrame(tickAudioOnly);
    };
    bladeState.previewRaf = requestAnimationFrame(tickAudioOnly);
    return;
  }

  const btn = document.getElementById('bladePreviewBtn');
  if (btn) btn.textContent = '⏹ Stop';

  const vid = bladeState.sharedVideoEl;
  if (vid && vid.parentNode) {
    vid.muted = true;
    vid.playbackRate = rate;
    try {
      vid.currentTime = inSec;
    } catch {}
    vid.play().catch(() => {});
  }

  const specPh = document.getElementById('bladeSpecPlayhead');
  const trimSpan = Math.max(0.05, outSec - inSec);

  const tick = () => {
    if (!bladeState.open || !bladeState.previewAudioSrc || bladeState.expandedSliceId !== targetSlice.id) {
      stopBladePreview();
      return;
    }
    const elapsed = Math.max(0, ctx.currentTime - bladeState.previewStartCtxTime);
    const curRate = Math.max(0.25, Math.min(4.0, bladeState.playbackRate || rate));
    const bufTime = Math.min(effectiveOutSec, inSec + elapsed * curRate);

    if (specPh) {
      const pct = Math.max(0, Math.min(100, ((bufTime - inSec) / trimSpan) * 100));
      specPh.classList.add('visible');
      specPh.style.left = `${pct.toFixed(1)}%`;
    }

    if (elapsed >= bladeState.previewPlayDur || bufTime >= effectiveOutSec - 0.005) {
      stopBladePreview();
      scrubBladeVideoTo(inSec);
      return;
    }
    bladeState.previewRaf = requestAnimationFrame(tick);
  };
  bladeState.previewRaf = requestAnimationFrame(tick);
}

// --- Inline Row Spectrogram Builder & Async Render Queue ---
function buildBladeRowSpecBitmap(buffer, playbackRate = 1.0) {
  const W = 256;
  const H = 96;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');

  const ch = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const effectiveSr = sr * playbackRate;
  const maxSamples = Math.min(ch.length, Math.floor(MAX_CLIP_DUR * sr));
  const usableSpan = Math.max(1, maxSamples - fftSizeSpec);

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
    const startSample = Math.floor((x / W) * usableSpan);
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

  const { ceilDb, floorDb } = computeSpecDbBounds(colMags, minBin, maxBin, globalMaxDb, 48);
  const denom = Math.max(1e-5, ceilDb - floorDb);
  for (let x = 0; x < W; x++) {
    const dbArr = colMags[x];
    for (let y = 0; y < H; y++) {
      const normY = 1 - y / (H - 1);
      const freq = miniSpecNormYToFreq(normY);
      const exactBin = (freq * fftSizeSpec) / effectiveSr;
      const b0 = Math.max(1, Math.min(half - 2, Math.floor(exactBin)));
      const frac = exactBin - b0;
      const db = dbArr[b0] * (1 - frac) + dbArr[b0 + 1] * frac;
      const norm = (db - floorDb) / denom;
      const [r, g, b] = grayInspectorColor(norm);
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

function paintBladeRowSpecCanvas(canvas, bmp, meta) {
  if (!canvas || !canvas.isConnected) return;
  const rect = canvas.parentElement?.getBoundingClientRect();
  const cssW = Math.max(180, Math.round(rect?.width || 360));
  const cssH = Math.max(36, Math.round(rect?.height || 48));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, cssW, cssH);

  if (bmp) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(bmp, 0, 0, cssW, cssH);
  }

  if (!meta.isPerc && meta.f0Hz >= 50 && meta.f0Hz <= MINI_SPEC_MAX_FREQ * 1.15) {
    const normY = miniSpecFreqToNormY(meta.f0Hz);
    const yF0 = Math.max(1.5, Math.min(cssH - 1.5, (1 - normY) * (cssH - 1)));
    ctx.save();
    ctx.globalAlpha = meta.isEnabled ? 0.9 : 0.45;
    ctx.strokeStyle = meta.noteColor || '#ffffff';
    ctx.lineWidth = 1.35;
    ctx.beginPath();
    ctx.moveTo(0, yF0);
    ctx.lineTo(cssW, yF0);
    ctx.stroke();
    ctx.restore();
  }

  const rawSpan = Math.max(0.08, meta.rawDur || 1.0);
  const leftCut = Math.max(0, Math.min(cssW, ((meta.trimIn || 0) / rawSpan) * cssW));
  const rightKeep = Math.max(0, Math.min(cssW, ((meta.trimOut ?? rawSpan) / rawSpan) * cssW));

  if (leftCut > 1) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.76)';
    ctx.fillRect(0, 0, leftCut, cssH);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.68)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(leftCut + 0.5, 0);
    ctx.lineTo(leftCut + 0.5, cssH);
    ctx.stroke();
  }
  if (rightKeep < cssW - 1) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.76)';
    ctx.fillRect(rightKeep, 0, cssW - rightKeep, cssH);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.68)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rightKeep - 0.5, 0);
    ctx.lineTo(rightKeep - 0.5, cssH);
    ctx.stroke();
  }
}

async function queueBladeRowSpectrograms(gen, jobs) {
  const pending = [];
  for (const job of jobs) {
    if (!bladeState.open || bladeState.renderGen !== gen) return;
    const cacheKey = `${withBust(job.audioUrl)}__${job.rate.toFixed(4)}`;
    const cachedBmp = bladeRowSpecCache.get(cacheKey);
    if (cachedBmp) {
      paintBladeRowSpecCanvas(job.canvas, cachedBmp, job.meta);
    } else {
      paintBladeRowSpecCanvas(job.canvas, null, job.meta);
      pending.push({ ...job, cacheKey });
    }
  }

  for (let i = 0; i < pending.length; i++) {
    if (!bladeState.open || bladeState.renderGen !== gen) return;
    const item = pending[i];
    try {
      const buf = await loadAudioBuffer(item.audioUrl);
      if (!bladeState.open || bladeState.renderGen !== gen) return;
      let bmp = bladeRowSpecCache.get(item.cacheKey);
      if (!bmp) {
        bmp = buildBladeRowSpecBitmap(buf, item.rate);
        bladeRowSpecCache.set(item.cacheKey, bmp);
      }
      const actualRaw = Math.max(0.12, Math.min(MAX_CLIP_DUR, buf.duration));
      if (!item.meta.hasExplicitTrimOut) {
        item.meta.trimOut = actualRaw;
      }
      item.meta.rawDur = actualRaw;
      paintBladeRowSpecCanvas(item.canvas, bmp, item.meta);
    } catch {}
    if (i % 2 === 1) {
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  }
}

// --- Expanded Sample Unified Spectrogram + Trim UI ---
function isBladeTrimModified() {
  return (
    bladeState.inSec > 0.005 ||
    bladeState.outSec < Math.max(0.08, bladeState.rawDur - 0.015)
  );
}

function renderBladeExpandedSpectrogram() {
  const canvas = document.getElementById('bladeExpSpecCanvas');
  if (!canvas || !bladeState.slice) return;

  const rect = canvas.parentElement?.getBoundingClientRect();
  const cssW = Math.max(200, Math.round(rect?.width || 330));
  const cssH = Math.max(100, Math.round(rect?.height || 136));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }

  const ctx = canvas.getContext('2d');
  if (!bladeState.sliceAudioBuffer) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, cssW, cssH);
    return;
  }

  const rate = bladeState.playbackRate || 1.0;
  const slice = bladeState.slice;
  const cand = findKeyboardCandidate(slice.id);
  const isPerc = cand ? cand.isPerc : isPercussionSlice(bladeState.video, slice);
  const assignedMidi = bladeState.assignedMidi;
  const noteColor = isPerc ? PERC_NOTE_COLOR : getNoteColor(assignedMidi);
  const targetFreq = Number((440 * Math.pow(2, (assignedMidi - 69) / 12)).toFixed(1));
  const f0Label = isPerc ? 'PERC' : midiToName(assignedMidi);
  const rawSpan = Math.max(0.08, bladeState.rawDur);
  const cacheKey = `bladeExp__${slice.id}__${rate.toFixed(4)}__${targetFreq}__${isPerc ? 0 : 1}__${noteColor}__${rawSpan.toFixed(2)}__${cssW}x${cssH}__${dpr}`;

  let off = spectrogramBitmapCache.get(cacheKey);
  if (!off) {
    off = buildSpectrogramOffscreen(
      bladeState.sliceAudioBuffer,
      targetFreq,
      f0Label,
      cssW,
      cssH,
      dpr,
      rate,
      !isPerc,
      noteColor,
      rawSpan
    );
    spectrogramBitmapCache.set(cacheKey, off);
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(off, 0, 0);
}

function renderBladeTrimHandlesUI() {
  const stageEl = document.getElementById('bladeExpSpecStage');
  if (!stageEl || !bladeState.slice) return;

  const span = Math.max(0.08, bladeState.rawDur);
  const leftPct = Math.max(0, Math.min(100, (bladeState.inSec / span) * 100));
  const rightEdgePct = Math.max(0, Math.min(100, (bladeState.outSec / span) * 100));
  const widthPct = Math.max(1.5, rightEdgePct - leftPct);
  const modified = isBladeTrimModified();

  stageEl.classList.toggle('is-trimmed', modified);

  const curtainL = document.getElementById('bladeTrimCurtainLeft');
  const curtainR = document.getElementById('bladeTrimCurtainRight');
  const winBox = document.getElementById('bladeTrimWindow');
  const resetBtn = document.getElementById('bladeTrimResetBtn');

  if (curtainL) curtainL.style.width = `${leftPct.toFixed(2)}%`;
  if (curtainR) curtainR.style.width = `${Math.max(0, 100 - rightEdgePct).toFixed(2)}%`;
  if (winBox) {
    winBox.style.left = `${leftPct.toFixed(2)}%`;
    winBox.style.width = `${widthPct.toFixed(2)}%`;
  }
  if (resetBtn) {
    resetBtn.classList.toggle('hidden', !modified);
  }

  if (bladeState.sliceAudioBuffer) {
    renderBladeExpandedSpectrogram();
  }
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

  if (bladeState.open) {
    const card = document.querySelector(`#bladeScroll .blade-video-card[data-video-id="${videoId}"]`);
    if (card) {
      const readoutEl = card.querySelector('.video-gain-readout');
      const sliderEl = card.querySelector('.video-gain-slider');
      const zeroBtn = card.querySelector('.video-gain-zero-btn');
      if (readoutEl) readoutEl.textContent = formatSignedDb(clamped);
      if (sliderEl) sliderEl.value = String(clamped);
      if (zeroBtn) zeroBtn.classList.toggle('hidden', clamped === 0);
    }
  }

  if (persistServer && !state.isStaticMode) {
    fetch('./api/video/gain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, gainDb: clamped })
    }).catch(() => {});
  }
}

function updateBladeHeaderUi() {
  const vids = bladeState.groupVideos || [];
  if (vids.length === 0) return;
  const firstVid = vids[0];
  const groupName = getVideoGroupName(firstVid);

  const titleEl = document.getElementById('bladeGroupTitle');
  if (titleEl) titleEl.textContent = groupName;

  const grpSwitch = document.getElementById('bladeGroupSwitch');
  if (grpSwitch) {
    const enabledCount = vids.filter(v => !isVideoDisabled(v.id)).length;
    grpSwitch.className = enabledCount > 0 ? 'ui-switch is-on' : 'ui-switch';
    grpSwitch.setAttribute('aria-checked', enabledCount > 0 ? 'true' : 'false');
  }
}

function syncExpandedSliceStateFromCatalog(video, slice, fallbackRate = 1.0) {
  const cand = findKeyboardCandidate(slice.id);
  const currentMidi = cand?.midi ?? slice.manualMidi ?? slice.midi ?? 60;
  const bufDur =
    bladeState.slice?.id === slice.id && bladeState.sliceAudioBuffer
      ? Math.min(MAX_CLIP_DUR, bladeState.sliceAudioBuffer.duration)
      : null;
  const initRaw = Math.max(
    0.12,
    Number(
      Math.min(
        MAX_CLIP_DUR,
        bufDur ?? cand?.rawDurSec ?? slice.rawDurSec ?? slice.durSec ?? 2.0
      ).toFixed(2)
    )
  );
  const minLen = getMinTrimLen(initRaw);
  const savedIn = Number(cand?.trimIn ?? slice.trimIn ?? 0);
  const savedOut = Number(cand?.trimOut ?? slice.trimOut ?? initRaw);

  bladeState.video = video;
  bladeState.slice = slice;
  bladeState.expandedVideoId = video.id;
  bladeState.expandedSliceId = slice.id;
  bladeState.playbackRate = cand?.playbackRate ?? fallbackRate ?? 1.0;
  bladeState.assignedMidi = currentMidi;
  bladeState.rawDur = initRaw;
  bladeState.inSec = Number(Math.max(0, Math.min(initRaw - minLen, savedIn)).toFixed(2));
  bladeState.outSec = Number(Math.max(bladeState.inSec + minLen, Math.min(initRaw, savedOut)).toFixed(2));
}

function buildExpandedSampleEditorDOM(video, slice) {
  const cand = findKeyboardCandidate(slice.id);
  const currentMidi = bladeState.assignedMidi;
  const isPerc = cand ? cand.isPerc : isPercussionSlice(video, slice);
  const noteColor = isPerc ? PERC_NOTE_COLOR : getNoteColor(currentMidi);
  const noteName = midiToName(currentMidi);
  const isSampleEnabled = cand ? Boolean(cand.enabled) : true;

  const activeShiftCents = Math.max(
    -100,
    Math.min(
      100,
      cand?.shiftCents ??
        Math.round(1200 * Math.log2(Math.max(0.25, bladeState.playbackRate || 1.0)))
    )
  );

  const noteBadgeHtml = isPerc
    ? `<span class="blade-note-pill-static"><span class="blade-sample-dot" style="background:${noteColor}"></span><span>${noteName}</span></span>`
    : `<button id="bladeTestToneBtn" type="button" class="blade-note-tone-btn" title="Play ${noteName} reference tone (${midiToFreq(currentMidi)} Hz)"><span class="blade-sample-dot" style="background:${noteColor}"></span><span>♪ ${noteName}</span></button>`;

  const wrap = document.createElement('div');
  wrap.className = 'blade-expanded-editor';

  wrap.innerHTML = `
    <div class="blade-exp-top-bar" title="Click header to collapse sample">
      <div class="blade-exp-title-left">
        ${noteBadgeHtml}
        <button id="bladePreviewBtn" type="button" class="blade-preview-btn" title="Preview sample (Space)">▶ Preview</button>
      </div>
      <div class="blade-exp-top-right">
        <button
          id="bladeSampleSwitch"
          type="button"
          class="ui-switch${isSampleEnabled ? ' is-on' : ''}"
          role="switch"
          aria-checked="${isSampleEnabled ? 'true' : 'false'}"
          title="${isSampleEnabled ? 'Mute sample on keyboard (Enter)' : 'Enable sample on keyboard (Enter)'}"
        ></button>
      </div>
    </div>

    <div class="blade-exp-stage-row">
      <div class="blade-exp-video-box" id="bladeExpVideoBox" title="Click to preview sample (Space)"></div>

      <div class="blade-exp-spec-stage" id="bladeExpSpecStage">
        <canvas class="blade-exp-spec-canvas" id="bladeExpSpecCanvas" width="340" height="136"></canvas>
        <div class="blade-trim-curtain left" id="bladeTrimCurtainLeft"></div>
        <div class="blade-trim-curtain right" id="bladeTrimCurtainRight"></div>
        <div class="blade-trim-window" id="bladeTrimWindow" title="Click to preview, or drag to slide trim window">
          <div class="blade-trim-handle in-handle" id="bladeTrimHandleIn" title="Drag start point">
            <span class="blade-handle-grip"></span>
          </div>
          <div class="blade-spec-playhead" id="bladeSpecPlayhead"></div>
          <div class="blade-trim-handle out-handle" id="bladeTrimHandleOut" title="Drag end point">
            <span class="blade-handle-grip"></span>
          </div>
        </div>
      </div>
    </div>

    <div class="blade-exp-controls">
      <div class="blade-ctrl-row">
        <div class="blade-tune-group local-only-btn">
          <span class="peaks-mini-label">Re-Pitch</span>
          <input
            id="bladeTuneSlider"
            type="range"
            min="-100"
            max="100"
            step="1"
            value="${activeShiftCents}"
            class="inspector-tune-slider"
            title="Fine-tune sample (−1.0 to +1.0 st, double-click for 0 st)"
          />
          <span class="inspector-tune-readout" id="bladeTuneReadout">${formatTuneReadout(activeShiftCents)}</span>
        </div>

        <div class="blade-trim-actions-right">
          <button
            id="bladeTrimResetBtn"
            type="button"
            class="nudge-btn local-only-btn hidden"
            title="Restore full sample length"
          >↺ Trim</button>
          <button
            id="bladeTrashSliceBtn"
            type="button"
            class="icon-trash-btn local-only-btn"
            title="Move sample clip to _trash/"
            aria-label="Trash sample"
          >${TRASH_ICON_SVG}</button>
        </div>
      </div>
    </div>
  `;

  // Mount single shared <video> element without reloading if already bound to this slice
  const videoBox = wrap.querySelector('#bladeExpVideoBox');
  const vidEl = getSharedBladeVideoEl();
  const nextSrc = withBust(slice.videoUrl);
  if (vidEl.getAttribute('data-slice-id') !== slice.id) {
    vidEl.setAttribute('data-slice-id', slice.id);
    vidEl.src = nextSrc;
    vidEl.onloadedmetadata = () => {
      if (bladeState.expandedSliceId === slice.id && !bladeState.previewAudioSrc) {
        scrubBladeVideoTo(bladeState.inSec);
      }
    };
  }
  videoBox.insertBefore(vidEl, videoBox.firstChild);

  // Wire Expanded Sample Events
  const topBar = wrap.querySelector('.blade-exp-top-bar');
  topBar.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    e.stopPropagation();
    expandBladeSample(null, null, { focusTarget: 'explorer' });
  });

  const testToneBtn = wrap.querySelector('#bladeTestToneBtn');
  if (testToneBtn) {
    testToneBtn.addEventListener('click', e => {
      e.stopPropagation();
      setSelectionFocus('blade');
      playReferenceTone(currentMidi);
    });
  }

  wrap.querySelector('#bladePreviewBtn').addEventListener('click', e => {
    e.stopPropagation();
    setSelectionFocus('blade');
    startBladePreview(false);
  });

  videoBox.addEventListener('click', e => {
    e.stopPropagation();
    setSelectionFocus('blade');
    startBladePreview(false);
  });

  const sampleSwitch = wrap.querySelector('#bladeSampleSwitch');
  sampleSwitch.addEventListener('click', async e => {
    e.stopPropagation();
    setSelectionFocus('blade');
    const nextEn = !isSampleEnabled;
    if (nextEn && cand) {
      triggerDefaultCandidateGate(`ui_blade_${slice.id}`, currentMidi, cand, 0);
    }
    await apiPost('/api/keyboard/toggle', {
      midi: currentMidi,
      sliceId: slice.id,
      enabled: nextEn
    });
  });

  const applyBladeManualTune = async nextCents => {
    if (state.isStaticMode || !bladeState.video || !bladeState.slice) return;
    const clamped = Math.max(-100, Math.min(100, Math.round(Number(nextCents) || 0)));
    bladeState.playbackRate = Number(Math.pow(2, clamped / 1200).toFixed(4));
    await apiPost('/api/slice/update', {
      videoId: video.id,
      sliceId: slice.id,
      manualTuneCents: clamped
    });
  };

  const tuneSlider = wrap.querySelector('#bladeTuneSlider');
  tuneSlider.addEventListener('input', () => {
    const c = Math.max(-100, Math.min(100, Math.round(Number(tuneSlider.value) || 0)));
    bladeState.playbackRate = Number(Math.pow(2, c / 1200).toFixed(4));
    const readout = document.getElementById('bladeTuneReadout');
    if (readout) readout.textContent = formatTuneReadout(c);
    if (vidEl && !vidEl.paused) {
      vidEl.playbackRate = Math.max(0.25, Math.min(4.0, bladeState.playbackRate));
    }
    if (bladeState.previewAudioSrc && audioCtx) {
      bladeState.previewAudioSrc.playbackRate.setValueAtTime(
        bladeState.playbackRate,
        audioCtx.currentTime
      );
    }
    renderBladeExpandedSpectrogram();
  });
  tuneSlider.addEventListener('change', () => {
    applyBladeManualTune(Number(tuneSlider.value) || 0);
  });
  tuneSlider.addEventListener('dblclick', e => {
    e.stopPropagation();
    tuneSlider.value = '0';
    const readout = document.getElementById('bladeTuneReadout');
    if (readout) readout.textContent = formatTuneReadout(0);
    applyBladeManualTune(0);
  });

  wrap.querySelector('#bladeTrimResetBtn').addEventListener('click', async e => {
    e.stopPropagation();
    if (state.isStaticMode) return;
    stopBladePreview();
    const hadSavedTrim = Boolean(
      slice.isTrimmed || Number.isFinite(slice.trimIn) || Number.isFinite(slice.trimOut)
    );
    bladeState.inSec = 0;
    bladeState.outSec = bladeState.rawDur;
    renderBladeTrimHandlesUI();
    scrubBladeVideoTo(0);
    if (hadSavedTrim) {
      await apiPost('/api/slice/update', {
        videoId: video.id,
        sliceId: slice.id,
        resetTrim: true
      });
    }
  });

  const trashSliceBtn = wrap.querySelector('#bladeTrashSliceBtn');
  trashSliceBtn.addEventListener('click', async e => {
    e.stopPropagation();
    if (state.isStaticMode) return;
    if (!bladeState.trashSliceArmed) {
      bladeState.trashSliceArmed = true;
      trashSliceBtn.classList.add('confirm-armed');
      trashSliceBtn.textContent = 'Delete?';
      if (bladeState.trashSliceTimer) clearTimeout(bladeState.trashSliceTimer);
      bladeState.trashSliceTimer = setTimeout(() => resetBladeTrashConfirmUI(), 3500);
      return;
    }
    const orderedBefore = getBladeOrderedSamples();
    const curPos = orderedBefore.findIndex(item => item.slice.id === slice.id);
    const nextNeighbor =
      orderedBefore[curPos + 1]?.slice.id || orderedBefore[curPos - 1]?.slice.id || null;
    resetBladeTrashConfirmUI();
    stopBladePreview();
    bladeState.expandedSliceId = nextNeighbor;
    await apiPost('/api/slice/trash', { videoId: video.id, sliceId: slice.id });
  });

  // Unified Spectrogram [ IN ... OUT ] Drag Handles
  const beginSpecTrimDrag = (mode, e) => {
    if (state.isStaticMode) return;
    e.stopPropagation();
    e.preventDefault();
    setSelectionFocus('blade');
    stopBladePreview();
    bladeState.dragMode = mode;
    bladeState.dragMoved = false;
    bladeState.dragStartX = e.clientX;
    bladeState.dragStartIn = bladeState.inSec;
    bladeState.dragStartOut = bladeState.outSec;
    wrap.querySelector('#bladeExpSpecStage')?.classList.add('is-dragging');
  };

  wrap.querySelector('#bladeTrimHandleIn').addEventListener('mousedown', e => beginSpecTrimDrag('in', e));
  wrap.querySelector('#bladeTrimHandleOut').addEventListener('mousedown', e => beginSpecTrimDrag('out', e));
  wrap.querySelector('#bladeTrimWindow').addEventListener('mousedown', e => {
    if (state.isStaticMode) {
      e.stopPropagation();
      startBladePreview(false);
      return;
    }
    beginSpecTrimDrag('move', e);
  });

  wrap.querySelector('#bladeExpSpecStage').addEventListener('mousedown', e => {
    if (e.target.closest('#bladeTrimWindow')) return;
    e.stopPropagation();
    e.preventDefault();
    setSelectionFocus('blade');
    if (state.isStaticMode) {
      startBladePreview(false);
      return;
    }
    stopBladePreview();
    const stageEl = wrap.querySelector('#bladeExpSpecStage');
    const rect = stageEl.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    const rawDur = Math.max(0.12, Math.min(MAX_CLIP_DUR, bladeState.rawDur));
    const minLen = getMinTrimLen(rawDur);
    const clickSec = Math.max(0, Math.min(rawDur, ratio * rawDur));

    if (clickSec < bladeState.inSec) {
      bladeState.inSec = Number(Math.max(0, Math.min(bladeState.outSec - minLen, clickSec)).toFixed(2));
      bladeState.dragMode = 'in';
      scrubBladeVideoTo(bladeState.inSec);
    } else if (clickSec > bladeState.outSec) {
      bladeState.outSec = Number(Math.min(rawDur, Math.max(bladeState.inSec + minLen, clickSec)).toFixed(2));
      bladeState.dragMode = 'out';
      scrubBladeVideoTo(bladeState.outSec);
    }
    bladeState.dragMoved = true;
    bladeState.dragStartX = e.clientX;
    bladeState.dragStartIn = bladeState.inSec;
    bladeState.dragStartOut = bladeState.outSec;
    stageEl.classList.add('is-dragging');
    renderBladeTrimHandlesUI();
  });

  return wrap;
}

async function hydrateExpandedSliceAudio(slice) {
  if (!slice) return;
  try {
    const buf = await loadAudioBuffer(slice.audioUrl);
    if (!bladeState.open || bladeState.expandedSliceId !== slice.id) return;
    bladeState.sliceAudioBuffer = buf;
    const actualRaw = Math.max(0.12, Number(Math.min(MAX_CLIP_DUR, buf.duration).toFixed(2)));
    const wasFullOut =
      !Number.isFinite(slice.trimOut) && Math.abs(bladeState.outSec - bladeState.rawDur) < 0.04;
    bladeState.rawDur = actualRaw;
    bladeState.outSec = wasFullOut
      ? actualRaw
      : Number(Math.min(actualRaw, bladeState.outSec).toFixed(2));
    const nextMin = getMinTrimLen(actualRaw);
    bladeState.inSec = Number(
      Math.max(0, Math.min(bladeState.outSec - nextMin, bladeState.inSec)).toFixed(2)
    );
    renderBladeTrimHandlesUI();
    renderBladeExpandedSpectrogram();
  } catch {}
}

function renderInspectorBlade({ preserveScroll = true } = {}) {
  const scrollEl = document.getElementById('bladeScroll');
  if (!scrollEl || !bladeState.open) return;

  const prevScrollTop = preserveScroll ? scrollEl.scrollTop : 0;
  const gen = ++bladeState.renderGen;

  updateBladeHeaderUi();

  // Detach shared video cleanly before rebuilding DOM so it isn't GC'd/reset if same slice stays expanded
  if (bladeState.sharedVideoEl && bladeState.sharedVideoEl.parentNode) {
    bladeState.sharedVideoEl.parentNode.removeChild(bladeState.sharedVideoEl);
  }

  scrollEl.innerHTML = '';
  const specJobs = [];

  for (const v of bladeState.groupVideos || []) {
    const slices = getActiveVideoSlices(v);
    const muted = isVideoDisabled(v.id);
    const gainDb = getVideoGainDb(v.id);

    const card = document.createElement('div');
    card.className = `blade-video-card${muted ? ' is-muted' : ''}`;
    card.dataset.videoId = v.id;

    card.innerHTML = `
      <div class="blade-video-head">
        <div class="blade-video-head-left">
          <span class="inspector-slug-label" title="${v.slug || ''}">${v.slug || ''}</span>
        </div>
        <div class="blade-video-head-right">
          <div class="blade-vol-inline" title="Volume for ${v.slug} (−12 dB to +12 dB)">
            <span class="video-gain-tag">Vol</span>
            <input
              type="range"
              min="-12"
              max="12"
              step="1"
              value="${gainDb}"
              class="video-gain-slider"
            />
            <span class="video-gain-readout">${formatSignedDb(gainDb)}</span>
            <button type="button" class="nudge-btn video-gain-zero-btn${gainDb === 0 ? ' hidden' : ''}" title="Reset volume to 0 dB">0dB</button>
          </div>
          <button
            type="button"
            class="icon-trash-btn local-only-btn video-card-trash-btn"
            title="Move ${v.slug} to _trash/"
            aria-label="Trash video ${v.slug}"
          >${TRASH_ICON_SVG}</button>
          <button
            type="button"
            class="ui-switch${muted ? '' : ' is-on'} video-card-switch"
            role="switch"
            aria-checked="${muted ? 'false' : 'true'}"
            title="${muted ? `Enable ${v.slug}` : `Mute ${v.slug}`}"
          ></button>
        </div>
      </div>
      <div class="blade-samples-list"></div>
    `;

    const gainSlider = card.querySelector('.video-gain-slider');
    const zeroBtn = card.querySelector('.video-gain-zero-btn');
    gainSlider.addEventListener('input', () => {
      setVideoGainDb(v.id, Number(gainSlider.value) || 0, false);
    });
    gainSlider.addEventListener('change', () => {
      setVideoGainDb(v.id, Number(gainSlider.value) || 0, true);
    });
    zeroBtn.addEventListener('click', e => {
      e.stopPropagation();
      setVideoGainDb(v.id, 0, true);
    });

    const cardSwitch = card.querySelector('.video-card-switch');
    cardSwitch.addEventListener('click', e => {
      e.stopPropagation();
      setVideosEnabled([v.id], isVideoDisabled(v.id));
    });

    const trashBtn = card.querySelector('.video-card-trash-btn');
    trashBtn.addEventListener('click', async e => {
      e.stopPropagation();
      if (state.isStaticMode) return;
      if (bladeState.trashArmedVideoId !== v.id) {
        resetBladeTrashConfirmUI();
        bladeState.trashArmedVideoId = v.id;
        trashBtn.classList.add('confirm-armed');
        trashBtn.textContent = 'Delete?';
        bladeState.trashVideoTimer = setTimeout(() => resetBladeTrashConfirmUI(), 3500);
        return;
      }
      resetBladeTrashConfirmUI();
      stopBladePreview();
      const remainingOther = (bladeState.groupVideos || []).find(other => other.id !== v.id);
      await apiPost('/api/video/trash', { videoId: v.id });
      if (remainingOther) {
        const freshOther = state.catalog?.videos?.find(
          item => item.id === remainingOther.id && !item.deleted
        );
        if (freshOther) {
          openInspectorBlade(freshOther.id, { expandedSliceId: null, autoPlay: false });
          return;
        }
      }
      closeInspectorBlade();
    });

    const samplesListEl = card.querySelector('.blade-samples-list');
    if (slices.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'blade-empty-slices';
      emptyEl.textContent = 'No extracted samples in this video';
      samplesListEl.appendChild(emptyEl);
    } else {
      slices.forEach(slice => {
        const isExpanded = bladeState.expandedSliceId === slice.id;
        const cand = findKeyboardCandidate(slice.id);
        const midi = cand?.midi ?? slice.manualMidi ?? slice.midi ?? 60;
        const isPerc = cand ? cand.isPerc : isPercussionSlice(v, slice);
        const noteColor = isPerc ? PERC_NOTE_COLOR : getNoteColor(midi);
        const noteLabel = midiToName(midi);
        const isSampleEnabled = cand ? Boolean(cand.enabled) : true;
        const rate = cand?.playbackRate || 1.0;
        const rawDur = Math.max(
          0.12,
          Math.min(MAX_CLIP_DUR, Number(cand?.rawDurSec ?? slice.rawDurSec ?? slice.durSec ?? 1.5))
        );
        const trimIn = Math.max(0, Number(cand?.trimIn ?? slice.trimIn ?? 0));
        const hasExplicitTrimOut = Number.isFinite(cand?.trimOut) || Number.isFinite(slice.trimOut);
        const trimOut = Math.max(trimIn + 0.08, Math.min(rawDur, Number(cand?.trimOut ?? slice.trimOut ?? rawDur)));

        const sampleCard = document.createElement('div');
        sampleCard.className = [
          'blade-sample-card',
          isExpanded ? 'is-expanded' : '',
          !isSampleEnabled ? 'is-sample-muted' : ''
        ]
          .filter(Boolean)
          .join(' ');
        sampleCard.dataset.sliceId = slice.id;
        sampleCard.dataset.videoId = v.id;

        if (isExpanded) {
          sampleCard.appendChild(buildExpandedSampleEditorDOM(v, slice));
        } else {
          const thumbSrc = withBust(cand?.thumbUrl || slice.thumbUrl || v.thumbUrl);
          sampleCard.innerHTML = `
            <div class="blade-sample-row-main" title="Click to expand &amp; preview sample (${noteLabel})">
              <img class="blade-sample-thumb" src="${thumbSrc}" alt="${noteLabel}" loading="lazy" />
              <div class="blade-row-spec-wrap">
                <canvas class="blade-row-spec-canvas" width="320" height="48"></canvas>
                <div class="blade-row-meta-pill">
                  <span class="blade-sample-dot" style="background:${noteColor}"></span>
                  <span class="blade-row-note">${noteLabel}</span>
                </div>
              </div>
              <button
                type="button"
                class="ui-switch${isSampleEnabled ? ' is-on' : ''} blade-row-switch"
                role="switch"
                aria-checked="${isSampleEnabled ? 'true' : 'false'}"
                title="${isSampleEnabled ? `Mute sample (${noteLabel})` : `Enable sample (${noteLabel})`}"
              ></button>
            </div>
          `;

          const rowSwitch = sampleCard.querySelector('.blade-row-switch');
          rowSwitch.addEventListener('click', async e => {
            e.stopPropagation();
            const nextEn = !isSampleEnabled;
            if (nextEn && cand) {
              triggerDefaultCandidateGate(`ui_blade_row_${slice.id}`, midi, cand, 0);
            }
            await apiPost('/api/keyboard/toggle', {
              midi,
              sliceId: slice.id,
              enabled: nextEn
            });
          });

          const rowMain = sampleCard.querySelector('.blade-sample-row-main');
          rowMain.addEventListener('click', e => {
            if (e.target.closest('.blade-row-switch')) return;
            e.stopPropagation();
            expandBladeSample(v.id, slice.id, {
              autoPlay: true,
              scrollIntoView: true,
              focusTarget: 'blade'
            });
          });

          const canvas = sampleCard.querySelector('.blade-row-spec-canvas');
          const f0Hz = isPerc ? 0 : 440 * Math.pow(2, (midi - 69) / 12);
          specJobs.push({
            canvas,
            audioUrl: slice.audioUrl,
            rate,
            meta: {
              isPerc,
              f0Hz,
              noteColor,
              isEnabled: isSampleEnabled,
              rawDur,
              trimIn,
              trimOut,
              hasExplicitTrimOut
            }
          });
        }

        samplesListEl.appendChild(sampleCard);
      });
    }

    scrollEl.appendChild(card);
  }

  scrollEl.scrollTop = prevScrollTop;

  if (bladeState.expandedSliceId && bladeState.slice) {
    renderBladeTrimHandlesUI();
    if (bladeState.sliceAudioBuffer) {
      renderBladeExpandedSpectrogram();
    } else {
      hydrateExpandedSliceAudio(bladeState.slice);
    }
  }

  requestAnimationFrame(() => {
    queueBladeRowSpectrograms(gen, specJobs);
  });
}

function expandBladeSample(
  videoId,
  sliceId,
  { autoPlay = false, scrollIntoView = false, focusTarget = 'blade', playbackRate = 1.0 } = {}
) {
  stopBladePreview();
  stopReferenceTone(true);
  resetBladeTrashConfirmUI();

  if (!sliceId) {
    bladeState.expandedSliceId = null;
    bladeState.expandedVideoId = null;
    bladeState.slice = null;
    bladeState.sliceAudioBuffer = null;
    releaseSharedBladeVideo();
    setSelectionFocus(focusTarget);
    renderInspectorBlade({ preserveScroll: true });
    return;
  }

  const video =
    (bladeState.groupVideos || []).find(v => v.id === videoId) ||
    state.catalog?.videos?.find(v => v.id === videoId && !v.deleted);
  const slice = video ? getActiveVideoSlices(video).find(s => s.id === sliceId) : null;
  if (!video || !slice) return;

  if (bladeState.slice?.id !== slice.id) {
    bladeState.sliceAudioBuffer = null;
  }
  syncExpandedSliceStateFromCatalog(video, slice, playbackRate);

  if (bladeState.assignedMidi >= MIN_MIDI && bladeState.assignedMidi <= MAX_MIDI) {
    selectKeyForConfig(bladeState.assignedMidi, false, true);
  }
  setSelectionFocus(focusTarget);
  renderInspectorBlade({ preserveScroll: true });

  if (scrollIntoView) {
    requestAnimationFrame(() => {
      const cardEl = document.querySelector(
        `#bladeScroll .blade-sample-card[data-slice-id="${slice.id}"]`
      );
      cardEl?.scrollIntoView({ block: 'nearest' });
    });
  }

  if (autoPlay) {
    startBladePreview(true);
  } else {
    scrubBladeVideoTo(bladeState.inSec);
  }
}

function openInspectorBlade(
  videoId,
  {
    expandedSliceId = null,
    playbackRate = 1.0,
    autoPlay = false,
    scrollIntoView = false,
    focusTarget = 'explorer'
  } = {}
) {
  const video = state.catalog?.videos?.find(v => v.id === videoId && !v.deleted);
  if (!video) return;

  stopBladePreview();
  stopReferenceTone(true);
  resetBladeTrashConfirmUI();

  const groupVideos = getVideosInSameGroup(video);
  const nextGroupKey = getVideoGroupKey(video);
  const switchingGroup = !bladeState.open || bladeState.groupKey !== nextGroupKey;

  bladeState.open = true;
  bladeState.groupKey = nextGroupKey;
  bladeState.groupVideos = groupVideos.length > 0 ? groupVideos : [video];

  const cat = String(video.category || 'other').toLowerCase();
  bladeState.explorerFocus = {
    type: 'group',
    cat,
    groupKey: nextGroupKey,
    videoId: bladeState.groupVideos[0].id
  };

  // Ensure the parent category in #fileExplorer is expanded so the flush connection is visible
  if (state.collapsedCategories.has(cat)) {
    state.collapsedCategories.delete(cat);
    renderFileExplorer();
  }

  if (expandedSliceId) {
    let foundVideo = video;
    let foundSlice = null;
    for (const gv of bladeState.groupVideos) {
      const s = getActiveVideoSlices(gv).find(item => item.id === expandedSliceId);
      if (s) {
        foundVideo = gv;
        foundSlice = s;
        break;
      }
    }
    if (foundSlice) {
      bladeState.sliceAudioBuffer = null;
      syncExpandedSliceStateFromCatalog(foundVideo, foundSlice, playbackRate);
      if (bladeState.assignedMidi >= MIN_MIDI && bladeState.assignedMidi <= MAX_MIDI) {
        selectKeyForConfig(bladeState.assignedMidi, false, true);
      }
    } else {
      bladeState.expandedSliceId = null;
      bladeState.expandedVideoId = null;
      bladeState.slice = null;
      bladeState.sliceAudioBuffer = null;
      releaseSharedBladeVideo();
    }
  } else {
    bladeState.expandedSliceId = null;
    bladeState.expandedVideoId = null;
    bladeState.video = bladeState.groupVideos[0] || video;
    bladeState.slice = null;
    bladeState.sliceAudioBuffer = null;
    releaseSharedBladeVideo();
  }

  document.getElementById('inspectorBlade')?.classList.remove('hidden');
  setSelectionFocus(focusTarget);
  renderInspectorBlade({ preserveScroll: !switchingGroup });

  if (scrollIntoView && bladeState.expandedSliceId) {
    requestAnimationFrame(() => {
      const cardEl = document.querySelector(
        `#bladeScroll .blade-sample-card[data-slice-id="${bladeState.expandedSliceId}"]`
      );
      cardEl?.scrollIntoView({ block: 'nearest' });
    });
  }

  if (autoPlay && bladeState.slice) {
    startBladePreview(true);
  }
}

function closeInspectorBlade({ keepExplorerFocus = false } = {}) {
  if (!bladeState.open) {
    if (!keepExplorerFocus && (state.selectionTarget === 'blade' || state.selectionTarget === 'explorer')) {
      setSelectionFocus('keyboard');
    }
    return;
  }
  stopBladePreview();
  stopReferenceTone(true);
  resetBladeTrashConfirmUI();
  releaseSharedBladeVideo();
  bladeState.open = false;
  bladeState.groupKey = null;
  bladeState.groupVideos = [];
  bladeState.expandedSliceId = null;
  bladeState.expandedVideoId = null;
  bladeState.slice = null;
  bladeState.sliceAudioBuffer = null;
  bladeState.dragMode = null;
  bladeState.renderGen++;

  document.getElementById('inspectorBlade')?.classList.add('hidden');

  if (keepExplorerFocus) {
    syncExplorerHighlightClasses();
  } else if (state.selectionTarget === 'blade' || state.selectionTarget === 'explorer') {
    setSelectionFocus('keyboard');
  } else {
    syncExplorerHighlightClasses();
  }
}

function refreshBladeIfOpen() {
  if (!bladeState.open || !bladeState.groupKey) return;
  const freshGroupVideos = (state.catalog?.videos || [])
    .filter(v => !v.deleted && getVideoGroupKey(v) === bladeState.groupKey)
    .sort((a, b) =>
      String(a.slug || '').localeCompare(String(b.slug || ''), undefined, {
        numeric: true,
        sensitivity: 'base'
      })
    );
  if (freshGroupVideos.length === 0) {
    closeInspectorBlade();
    return;
  }
  bladeState.groupVideos = freshGroupVideos;

  if (bladeState.expandedSliceId) {
    let foundV = null;
    let foundS = null;
    for (const gv of freshGroupVideos) {
      const s = getActiveVideoSlices(gv).find(item => item.id === bladeState.expandedSliceId);
      if (s) {
        foundV = gv;
        foundS = s;
        break;
      }
    }
    if (foundV && foundS) {
      syncExpandedSliceStateFromCatalog(foundV, foundS, bladeState.playbackRate);
    } else {
      bladeState.expandedSliceId = null;
      bladeState.expandedVideoId = null;
      bladeState.slice = null;
      bladeState.sliceAudioBuffer = null;
      releaseSharedBladeVideo();
    }
  }
  renderInspectorBlade({ preserveScroll: true });
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
  replanCurrentMidiTimeline();
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
    const isMetadataOnlySliceUpdate =
      url === '/api/slice/update' &&
      body &&
      body.assignMidi === undefined &&
      body.resetToDsp === undefined &&
      body.overrideFreq === undefined;
    if (!isMetadataOnlySliceUpdate) {
      state.assetBust = Date.now();
      audioBufferCache.clear();
      rawAudioBytesCache.clear();
      clearVideoBlobCache();
      spectrogramBitmapCache.clear();
      bladeRowSpecCache.clear();
    }
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
  refreshBladeIfOpen();
  threeStage?.syncCatalog(state.catalog);
  syncStageConfigUI();
  updateStageTileSizes();
  replanCurrentMidiTimeline();
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
// Left Bottom Zone: MIDI File Transport, Recorder, ./midi/ Browser & Scrub Bar
// ============================================================================
const MIN_MIDI_TRANSPOSE_OCTAVES = -4;
const MAX_MIDI_TRANSPOSE_OCTAVES = 4;

const midiPlayer = {
  fileName: '',
  parsed: null,
  transposeOctaves: 0,
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

const midiRecorder = {
  state: 'idle', // 'idle' | 'armed' | 'recording'
  startPerfMs: 0,
  events: [],
  openTriggers: new Map(), // triggerId -> { midi, channel }
  uiTimer: null,
  saving: false
};

let midiLibraryFiles = [];
let midiBrowserOpen = false;

function formatClockSec(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const mins = Math.floor(s / 60);
  const rem = String(s % 60).padStart(2, '0');
  return `${mins}:${rem}`;
}

function uint8ToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function parseRecordedTakeMeta(fileName, fallbackMtimeMs = 0) {
  const m = /^rec_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-(\d+))?\.(?:mid|midi)$/i.exec(
    String(fileName || '')
  );
  let dateObj = null;
  let suffixNum = null;
  if (m) {
    dateObj = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6])
    );
    if (m[7]) suffixNum = Number(m[7]);
  } else if (fallbackMtimeMs > 0) {
    dateObj = new Date(fallbackMtimeMs);
  }
  if (!dateObj || Number.isNaN(dateObj.getTime())) {
    return { isRecording: false, dateHeader: 'MIDI Files', shortTitle: String(fileName || '') };
  }

  const now = new Date();
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

  const monthDay = dateObj.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(dateObj.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {})
  });
  let dateHeader = monthDay;
  if (sameDay(dateObj, now)) {
    dateHeader = `Today · ${monthDay}`;
  } else if (sameDay(dateObj, yesterday)) {
    dateHeader = `Yesterday · ${monthDay}`;
  }

  const timeLabel = dateObj.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  });
  const shortTitle = suffixNum ? `${timeLabel} (#${suffixNum})` : timeLabel;
  return { isRecording: true, dateHeader, shortTitle };
}

function formatMidiDisplayLabel(fileName) {
  const raw = String(fileName || '').trim();
  if (!raw) return 'MIDI Files';
  if (/^rec_/i.test(raw)) {
    const meta = parseRecordedTakeMeta(raw);
    if (meta.isRecording) return `Take · ${meta.shortTitle}`;
  }
  return raw.replace(/\.(mid|midi)$/i, '');
}

function resetDeterministicPlaybackState() {
  silenceAllMidiTransportVoices(0.04);
  lastPlayedSliceByMidi.clear();
  state.lastPlayedVideoId = null;
  state.lastPlayedSliceId = null;
  stageSlotSeq = 0;

  const grid = document.getElementById('polyVideoGrid');
  for (let i = 0; i < MAX_STAGE_SLOTS; i++) {
    const prev = stageSlots[i];
    if (prev?.voice && prev.voice.tileObj?.slotIdx === i) {
      prev.voice.tileObj = null;
    }
    if (prev?.videoEl) {
      disposeFeederVideo(prev.videoEl);
    }
    const unitEl = grid?.querySelector(`.stage-slot-unit[data-slot="${i}"]`);
    if (unitEl) {
      unitEl.querySelectorAll('video').forEach(v => disposeFeederVideo(v));
      unitEl.style.opacity = '0';
    }
    clearSlotVideoCanvas(i);
    clearSlotMiniSpec(i);
    stageSlots[i] = createEmptyStageSlot();
  }

  threeStage?.notifyActivity();
  syncActiveCandidateHighlightUI(false);
}

function resetUnoccupiedStageSlotMemory() {
  let anyOccupied = false;
  for (let i = 0; i < MAX_STAGE_SLOTS; i++) {
    if (stageSlots[i]?.occupied) {
      anyOccupied = true;
    } else {
      stageSlots[i] = createEmptyStageSlot();
    }
  }
  if (!anyOccupied) {
    stageSlotSeq = 0;
  }
}

function replanCurrentMidiTimeline() {
  if (!midiPlayer.parsed || !state.catalog?.keyboardMap) return;
  planMidiTimeline({
    parsed: midiPlayer.parsed,
    keyboardMap: state.catalog.keyboardMap,
    isVideoDisabled: videoId => isVideoDisabled(videoId),
    getGroupKey: cand => getSliceInstrumentGroupKey(cand),
    getVideoGainDb: videoId => getVideoGainDb(videoId),
    stageSlotCount: getActiveStageSlotCount(),
    fadeInSec: clampStageFadeInSec(state.stageFadeInSec),
    fadeOutSec: clampStageFadeSec(state.stageFadeSec),
    maxDisplaySec: state.stageMaxDisplayEnabled
      ? clampStageMaxDisplaySec(state.stageMaxDisplaySec)
      : null,
    transposeOctaves: Math.round(midiPlayer.transposeOctaves || 0),
    releaseSec: state.releaseSec
  });
}

function rewindAndResetMidiTransport() {
  if (midiRecorder.state === 'recording') return;
  if (midiRecorder.state === 'armed') {
    cancelMidiRecording();
  }
  if (midiPlayer.playing) {
    pauseMidiTransport();
  }
  midiPlayer.elapsedSec = 0;
  midiPlayer.nextEventIdx = 0;
  midiPlayer.pedalDown = false;
  resetDeterministicPlaybackState();
  replanCurrentMidiTimeline();
  updateMidiTransportUi();
}

function resolveTransposedMidiNote(ev) {
  return resolveTransposedMidiNoteShared(ev, midiPlayer.transposeOctaves);
}

function shiftMidiTransposeOctave(deltaOctaves) {
  const next = Math.max(
    MIN_MIDI_TRANSPOSE_OCTAVES,
    Math.min(MAX_MIDI_TRANSPOSE_OCTAVES, Math.round((midiPlayer.transposeOctaves || 0) + deltaOctaves))
  );
  if (next === midiPlayer.transposeOctaves) return;
  if (midiPlayer.playing || midiPlayer.activeTriggerIds.size > 0) {
    silenceAllMidiTransportVoices(0.08);
  }
  midiPlayer.transposeOctaves = next;
  replanCurrentMidiTimeline();
  savePrefsToStorage();
  updateMidiTransportUi();
  warmActiveMidiSlicesInBackground();
}

function updateMidiTransportUi() {
  const labelEl = document.getElementById('midiFileLabel');
  const resetBtn = document.getElementById('midiResetBtn');
  const playBtn = document.getElementById('midiPlayPauseBtn');
  const playIcon = document.getElementById('midiPlayPauseIcon');
  const recBtn = document.getElementById('midiRecordBtn');
  const scrubTrack = document.getElementById('midiScrubTrack');
  const scrubFill = document.getElementById('midiScrubFill');
  const scrubThumb = document.getElementById('midiScrubThumb');
  const timeReadout = document.getElementById('midiTimeReadout');
  const octDownBtn = document.getElementById('midiOctDownBtn');
  const octUpBtn = document.getElementById('midiOctUpBtn');
  const octReadout = document.getElementById('midiOctReadout');

  const isArmed = midiRecorder.state === 'armed';
  const isRecording = midiRecorder.state === 'recording';
  const hasMidi = Boolean(midiPlayer.parsed);

  if (resetBtn) {
    resetBtn.disabled = isRecording;
  }
  if (playBtn) {
    playBtn.disabled = !hasMidi || isRecording;
    playBtn.classList.toggle('is-playing', midiPlayer.playing);
  }
  if (playIcon) {
    playIcon.textContent = midiPlayer.playing ? '❚❚' : '▶';
  }
  if (recBtn) {
    recBtn.disabled = midiRecorder.saving;
    recBtn.classList.toggle('is-armed', isArmed);
    recBtn.classList.toggle('is-recording', isRecording);
    recBtn.title = isRecording
      ? 'Stop recording & save .mid to ./midi/'
      : isArmed
        ? 'Armed — press any note to start at 0:00 (click to cancel)'
        : 'Record MIDI take (starts on first note pressed)';
  }
  if (scrubTrack) {
    scrubTrack.classList.toggle('is-disabled', !hasMidi || isRecording || isArmed);
    scrubTrack.classList.toggle('is-scrubbing', midiPlayer.scrubbing);
  }

  const oct = Math.round(midiPlayer.transposeOctaves || 0);
  if (octDownBtn) {
    octDownBtn.disabled = oct <= MIN_MIDI_TRANSPOSE_OCTAVES || isRecording;
  }
  if (octUpBtn) {
    octUpBtn.disabled = oct >= MAX_MIDI_TRANSPOSE_OCTAVES || isRecording;
  }
  if (octReadout) {
    octReadout.textContent = oct > 0 ? `+${oct} oct` : `${oct} oct`;
    octReadout.classList.toggle('is-shifted', oct !== 0);
  }

  const dur = hasMidi ? Math.max(0.01, Number(midiPlayer.parsed.durationSec || 0.01)) : 1;
  const clampedElapsed = hasMidi ? Math.max(0, Math.min(dur, midiPlayer.elapsedSec)) : 0;
  const pct = hasMidi && !isRecording && !isArmed ? (clampedElapsed / dur) * 100 : 0;

  if (scrubFill) scrubFill.style.width = `${pct.toFixed(2)}%`;
  if (scrubThumb) scrubThumb.style.left = `${pct.toFixed(2)}%`;

  if (labelEl) {
    if (isRecording) {
      labelEl.textContent = 'Recording…';
      labelEl.title = 'Recording live MIDI take';
    } else if (isArmed) {
      labelEl.textContent = 'Play a note…';
      labelEl.title = 'Armed: first note pressed becomes 0:00 of the MIDI take';
    } else if (hasMidi) {
      labelEl.textContent = formatMidiDisplayLabel(midiPlayer.fileName);
      labelEl.title = midiPlayer.fileName;
    } else {
      labelEl.textContent = 'MIDI Files';
      labelEl.title = 'Browse ./midi/ files';
    }
  }
  if (timeReadout) {
    timeReadout.classList.toggle('is-recording', isRecording || isArmed);
    if (isRecording) {
      const recSec = Math.max(0, (performance.now() - midiRecorder.startPerfMs) / 1000);
      timeReadout.textContent = `● ${formatClockSec(recSec)}`;
    } else if (isArmed) {
      timeReadout.textContent = 'Arm…';
    } else {
      timeReadout.textContent = hasMidi
        ? `${formatClockSec(clampedElapsed)} / ${formatClockSec(dur)}`
        : '0:00';
    }
  }
}

// --- Live Zero-Latency MIDI Take Recorder (Anchored to First Note = 0:00) ---
function clearMidiRecorderTimer() {
  if (midiRecorder.uiTimer) {
    clearInterval(midiRecorder.uiTimer);
    midiRecorder.uiTimer = null;
  }
}

function armMidiRecording() {
  if (midiRecorder.saving) return;
  closeMidiBrowserPopover();
  if (midiPlayer.playing) {
    pauseMidiTransport();
  }
  clearMidiRecorderTimer();
  // Reset round-robin & empty slot memory so live recorded audio matches 0:00 playback 100%
  lastPlayedSliceByMidi.clear();
  resetUnoccupiedStageSlotMemory();
  syncActiveCandidateHighlightUI(false);

  midiRecorder.state = 'armed';
  midiRecorder.startPerfMs = 0;
  midiRecorder.events = [];
  midiRecorder.openTriggers.clear();
  ensureAudioContext();
  updateMidiTransportUi();
}

function cancelMidiRecording() {
  clearMidiRecorderTimer();
  midiRecorder.state = 'idle';
  midiRecorder.startPerfMs = 0;
  midiRecorder.events = [];
  midiRecorder.openTriggers.clear();
  updateMidiTransportUi();
}

function beginMidiRecordingClock(nowMs) {
  resetUnoccupiedStageSlotMemory();
  midiRecorder.state = 'recording';
  midiRecorder.startPerfMs = nowMs;
  midiRecorder.events = [];
  midiRecorder.openTriggers.clear();
  if (state.sustainPedalDown) {
    midiRecorder.events.push({
      timeSec: 0,
      type: 'sustain',
      pedalDown: true,
      channel: 0
    });
  }
  clearMidiRecorderTimer();
  midiRecorder.uiTimer = setInterval(() => {
    if (midiRecorder.state === 'recording') {
      updateMidiTransportUi();
    }
  }, 200);
  updateMidiTransportUi();
}

function recordLiveNoteOn(triggerId, midi, velocity = 0.92) {
  if (midiRecorder.state !== 'armed' && midiRecorder.state !== 'recording') return;
  if (!Number.isFinite(midi) || midi < 0 || midi > 127) return;

  const nowMs = performance.now();
  if (midiRecorder.state === 'armed') {
    beginMidiRecordingClock(nowMs);
  }
  const timeSec = Math.max(0, (nowMs - midiRecorder.startPerfMs) / 1000);
  const key = String(triggerId || `live_${midi}`);

  // If the same trigger (e.g. mouse glissando drag) slides directly to a new key, close prior note first
  const prev = midiRecorder.openTriggers.get(key);
  if (prev) {
    midiRecorder.events.push({
      timeSec,
      type: 'noteOff',
      midi: prev.midi,
      velocity: 0,
      channel: prev.channel || 0
    });
  }

  midiRecorder.openTriggers.set(key, { midi, channel: 0 });
  midiRecorder.events.push({
    timeSec,
    type: 'noteOn',
    midi,
    velocity: Math.max(0.02, Math.min(1, Number(velocity ?? 0.92))),
    channel: 0
  });
}

function recordLiveNoteOff(triggerId) {
  if (midiRecorder.state !== 'recording') return;
  const key = String(triggerId || '');
  const open = midiRecorder.openTriggers.get(key);
  if (!open) return;
  midiRecorder.openTriggers.delete(key);
  const timeSec = Math.max(0, (performance.now() - midiRecorder.startPerfMs) / 1000);
  midiRecorder.events.push({
    timeSec,
    type: 'noteOff',
    midi: open.midi,
    velocity: 0,
    channel: open.channel || 0
  });
}

function recordLiveSustainPedal(pedalDown) {
  if (midiRecorder.state !== 'recording') return;
  const timeSec = Math.max(0, (performance.now() - midiRecorder.startPerfMs) / 1000);
  midiRecorder.events.push({
    timeSec,
    type: 'sustain',
    pedalDown: Boolean(pedalDown),
    channel: 0
  });
}

async function stopAndSaveMidiRecording() {
  if (midiRecorder.state === 'armed') {
    cancelMidiRecording();
    return;
  }
  if (midiRecorder.state !== 'recording' || midiRecorder.saving) return;

  clearMidiRecorderTimer();
  const stopSec = Math.max(0.05, (performance.now() - midiRecorder.startPerfMs) / 1000);

  for (const [, open] of midiRecorder.openTriggers.entries()) {
    midiRecorder.events.push({
      timeSec: stopSec,
      type: 'noteOff',
      midi: open.midi,
      velocity: 0,
      channel: open.channel || 0
    });
  }
  midiRecorder.openTriggers.clear();

  if (state.sustainPedalDown) {
    midiRecorder.events.push({
      timeSec: stopSec,
      type: 'sustain',
      pedalDown: false,
      channel: 0
    });
  }

  const capturedEvents = midiRecorder.events.slice();
  midiRecorder.state = 'idle';
  midiRecorder.events = [];

  if (capturedEvents.length === 0) {
    updateMidiTransportUi();
    return;
  }

  midiRecorder.saving = true;
  updateMidiTransportUi();

  try {
    const midiBytes = encodeMidiFile(capturedEvents);
    const parsed = parseMidiFile(midiBytes);

    const pad = n => String(n).padStart(2, '0');
    const d = new Date();
    let savedName =
      `rec_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
      `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.mid`;

    if (!state.isStaticMode) {
      const res = await fetch('./api/midi/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64: uint8ToBase64(midiBytes) })
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.file?.name) savedName = data.file.name;
        if (Array.isArray(data?.files)) midiLibraryFiles = data.files;
      }
    } else {
      const blobUrl = URL.createObjectURL(new Blob([midiBytes], { type: 'audio/midi' }));
      midiLibraryFiles = [
        {
          name: savedName,
          url: blobUrl,
          mtimeMs: Date.now(),
          size: midiBytes.length,
          isRecording: true
        },
        ...midiLibraryFiles
      ];
    }

    // Play back recorded takes at exact recorded pitch (0 oct transpose) & deterministic 0:00 state
    midiPlayer.transposeOctaves = 0;
    savePrefsToStorage();
    midiPlayer.fileName = savedName;
    midiPlayer.parsed = parsed;
    midiPlayer.elapsedSec = 0;
    midiPlayer.nextEventIdx = 0;
    resetDeterministicPlaybackState();
    replanCurrentMidiTimeline();
    warmActiveMidiSlicesInBackground();
    if (midiBrowserOpen) renderMidiBrowserPopover();
  } catch (err) {
    console.error('Failed to save MIDI recording:', err);
  } finally {
    midiRecorder.saving = false;
    updateMidiTransportUi();
  }
}

function toggleMidiRecording() {
  if (midiRecorder.state === 'idle') {
    armMidiRecording();
  } else {
    stopAndSaveMidiRecording();
  }
}

// --- Lightweight ./midi/ File Browser Popover ---
async function fetchMidiLibraryList() {
  try {
    const url = state.isStaticMode ? './midi/index.json' : './api/midi/list';
    const res = await fetch(url);
    if (!res.ok) return midiLibraryFiles;
    const data = await res.json();
    if (Array.isArray(data?.files)) {
      midiLibraryFiles = data.files;
    } else if (Array.isArray(data)) {
      midiLibraryFiles = data;
    }
    if (midiBrowserOpen) renderMidiBrowserPopover();
  } catch {}
  return midiLibraryFiles;
}

async function loadMidiFromLibraryEntry(entry) {
  if (!entry?.url) return;
  if (midiRecorder.state === 'recording') {
    await stopAndSaveMidiRecording();
  } else if (midiRecorder.state === 'armed') {
    cancelMidiRecording();
  }
  pauseMidiTransport();
  const res = await fetch(entry.url);
  if (!res.ok) throw new Error(`Failed to load ${entry.name}`);
  const arrBuf = await res.arrayBuffer();
  const parsed = parseMidiFile(new Uint8Array(arrBuf));

  midiPlayer.fileName = entry.name;
  midiPlayer.parsed = parsed;
  midiPlayer.elapsedSec = 0;
  midiPlayer.nextEventIdx = 0;
  resetDeterministicPlaybackState();
  replanCurrentMidiTimeline();
  updateMidiTransportUi();
  warmActiveMidiSlicesInBackground();
}

function positionMidiBrowserPopover() {
  const pop = document.getElementById('midiBrowserPopover');
  const btn = document.getElementById('midiBrowserToggleBtn');
  if (!pop || !btn) return;
  const rect = btn.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - 286, Math.round(rect.left)));
  const bottom = Math.max(12, Math.round(window.innerHeight - rect.top + 8));
  pop.style.left = `${left}px`;
  pop.style.bottom = `${bottom}px`;
}

function closeMidiBrowserPopover() {
  midiBrowserOpen = false;
  const pop = document.getElementById('midiBrowserPopover');
  const btn = document.getElementById('midiBrowserToggleBtn');
  if (pop) pop.classList.add('hidden');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

async function openMidiBrowserPopover() {
  const pop = document.getElementById('midiBrowserPopover');
  const btn = document.getElementById('midiBrowserToggleBtn');
  if (!pop || !btn) return;
  midiBrowserOpen = true;
  pop.classList.remove('hidden');
  btn.setAttribute('aria-expanded', 'true');
  positionMidiBrowserPopover();
  renderMidiBrowserPopover();
  await fetchMidiLibraryList();
}

function toggleMidiBrowserPopover() {
  if (midiBrowserOpen) closeMidiBrowserPopover();
  else openMidiBrowserPopover();
}

function renderMidiBrowserPopover() {
  const listEl = document.getElementById('midiBrowserList');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (!midiLibraryFiles.length) {
    const empty = document.createElement('div');
    empty.className = 'midi-pop-empty';
    empty.textContent = 'No .mid files in ./midi/ yet';
    listEl.appendChild(empty);
    return;
  }

  const groups = [];
  const groupByTitle = new Map();
  const addItemToGroup = (headerTitle, entry, displayTitle) => {
    let g = groupByTitle.get(headerTitle);
    if (!g) {
      g = { title: headerTitle, items: [] };
      groupByTitle.set(headerTitle, g);
      groups.push(g);
    }
    g.items.push({ entry, displayTitle });
  };

  for (const entry of midiLibraryFiles) {
    const isRec = Boolean(entry.isRecording || /^rec_/i.test(entry.name));
    if (isRec) {
      const meta = parseRecordedTakeMeta(entry.name, entry.mtimeMs);
      addItemToGroup(meta.dateHeader, entry, meta.shortTitle);
    }
  }
  for (const entry of midiLibraryFiles) {
    const isRec = Boolean(entry.isRecording || /^rec_/i.test(entry.name));
    if (!isRec) {
      addItemToGroup('MIDI Files', entry, entry.name.replace(/\.(mid|midi)$/i, ''));
    }
  }

  for (const group of groups) {
    const hdr = document.createElement('div');
    hdr.className = 'midi-pop-group-hdr';
    hdr.textContent = group.title;
    listEl.appendChild(hdr);

    for (const { entry, displayTitle } of group.items) {
      const row = document.createElement('div');
      row.className = 'midi-pop-row';
      if (midiPlayer.fileName && midiPlayer.fileName === entry.name) {
        row.classList.add('is-active');
      }
      row.title = entry.name;

      const main = document.createElement('div');
      main.className = 'midi-pop-row-main';

      const dot = document.createElement('span');
      dot.className = 'midi-pop-dot';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'midi-pop-title';
      titleSpan.textContent = displayTitle;

      main.appendChild(dot);
      main.appendChild(titleSpan);
      row.appendChild(main);

      if (!state.isStaticMode) {
        const trashBtn = document.createElement('button');
        trashBtn.type = 'button';
        trashBtn.className = 'midi-pop-trash-btn local-only-btn';
        trashBtn.title = `Move ${entry.name} to _trash/midi/`;
        trashBtn.innerHTML = TRASH_ICON_SVG;

        let confirmTimer = null;
        trashBtn.addEventListener('click', async e => {
          e.stopPropagation();
          if (!trashBtn.classList.contains('confirm-armed')) {
            trashBtn.classList.add('confirm-armed');
            trashBtn.textContent = 'Delete?';
            confirmTimer = setTimeout(() => {
              trashBtn.classList.remove('confirm-armed');
              trashBtn.innerHTML = TRASH_ICON_SVG;
            }, 3200);
            return;
          }
          if (confirmTimer) clearTimeout(confirmTimer);
          trashBtn.disabled = true;
          try {
            const res = await fetch('./api/midi/trash', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: entry.name })
            });
            if (res.ok) {
              const data = await res.json();
              if (Array.isArray(data?.files)) {
                midiLibraryFiles = data.files;
              } else {
                midiLibraryFiles = midiLibraryFiles.filter(f => f.name !== entry.name);
              }
              if (midiPlayer.fileName === entry.name) {
                pauseMidiTransport();
                midiPlayer.fileName = '';
                midiPlayer.parsed = null;
                midiPlayer.elapsedSec = 0;
                midiPlayer.nextEventIdx = 0;
                updateMidiTransportUi();
              }
              renderMidiBrowserPopover();
            }
          } catch {}
        });
        row.appendChild(trashBtn);
      }

      row.addEventListener('click', async () => {
        try {
          await loadMidiFromLibraryEntry(entry);
          closeMidiBrowserPopover();
        } catch (err) {
          console.error(err);
        }
      });

      listEl.appendChild(row);
    }
  }
}

function startPlannedMidiEventVoice(triggerId, ev) {
  const playedMidi =
    ev.plannedMidi !== undefined && ev.plannedMidi !== null
      ? ev.plannedMidi
      : resolveTransposedMidiNote(ev);
  if (playedMidi === null || playedMidi < MIN_MIDI || playedMidi > MAX_MIDI) return;

  const cand = ev.plannedSlice ?? null;
  if (!cand || !cand.enabled || isVideoDisabled(cand.videoId)) {
    startHeldVoice({ triggerId, midi: playedMidi, slice: null, velocity: ev.velocity ?? 0.9 });
    return;
  }

  state.lastPlayedVideoId = cand.videoId;
  state.lastPlayedSliceId = cand.sliceId;
  lastPlayedSliceByMidi.set(playedMidi, cand.sliceId);
  if (playedMidi === state.selectedMidi) {
    syncActiveCandidateHighlightUI(true);
  }

  startHeldVoice({
    triggerId,
    midi: playedMidi,
    slice: cand,
    playbackRate: cand.playbackRate || 1.0,
    velocity: ev.velocity ?? 0.9,
    forcedSlotIdx: Number.isInteger(ev.plannedSlotIdx) ? ev.plannedSlotIdx : null
  });
}

function silenceAllMidiTransportVoices(releaseSec = null) {
  midiPlayer.pedalDown = false;
  midiPlayer.pendingPedalIds.clear();
  for (const tid of Array.from(midiPlayer.activeTriggerIds)) {
    midiPlayer.activeTriggerIds.delete(tid);
    releaseHeldVoice(tid, releaseSec);
  }
}

function seekMidiEventCursor(targetSec, { afterInclusive = false } = {}) {
  if (!midiPlayer.parsed) {
    midiPlayer.nextEventIdx = 0;
    midiPlayer.pedalDown = false;
    return;
  }
  const evs = midiPlayer.parsed.events;
  let idx = 0;
  let pedal = false;
  while (
    idx < evs.length &&
    (afterInclusive ? evs[idx].timeSec <= targetSec + 1e-5 : evs[idx].timeSec < targetSec - 1e-4)
  ) {
    if (evs[idx].type === 'sustain') {
      pedal = !!evs[idx].pedalDown;
    }
    idx++;
  }
  midiPlayer.pedalDown = pedal;
  midiPlayer.nextEventIdx = idx;
}

function seekMidiTransportTo(targetSec) {
  if (!midiPlayer.parsed) return;
  const dur = Math.max(0, Number(midiPlayer.parsed.durationSec || 0));
  const clamped = Math.max(0, Math.min(dur, targetSec));
  silenceAllMidiTransportVoices(0.06);
  midiPlayer.elapsedSec = clamped;
  midiPlayer.lastPerfMs = performance.now();
  if (clamped <= 0.002) {
    midiPlayer.elapsedSec = 0;
    midiPlayer.nextEventIdx = 0;
    midiPlayer.pedalDown = false;
    resetDeterministicPlaybackState();
  } else {
    seekMidiEventCursor(clamped, { afterInclusive: false });
  }
  updateMidiTransportUi();
}

const SCRUB_AUDITION_GATE_SEC = 0.32;

function scrubMidiTransportBetween(fromSec, toSec) {
  if (!midiPlayer.parsed) return;
  const dur = Math.max(0, Number(midiPlayer.parsed.durationSec || 0));
  const clampedTo = Math.max(0, Math.min(dur, toSec));
  const evs = midiPlayer.parsed.events || [];
  if (!evs.length || Math.abs(clampedTo - fromSec) <= 1e-5) return;

  const forward = clampedTo > fromSec;
  const latestBySlot = new Map();

  if (forward) {
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      if (ev.timeSec <= fromSec) continue;
      if (ev.timeSec > clampedTo) break;
      if (ev.type !== 'noteOn') continue;
      const playedMidi =
        ev.plannedMidi !== undefined && ev.plannedMidi !== null
          ? ev.plannedMidi
          : resolveTransposedMidiNote(ev);
      if (playedMidi === null) continue;
      const slotKey = Number.isInteger(ev.plannedSlotIdx)
        ? `slot_${ev.plannedSlotIdx}`
        : `midi_${playedMidi}`;
      latestBySlot.delete(slotKey);
      latestBySlot.set(slotKey, ev);
    }
  } else {
    for (let i = evs.length - 1; i >= 0; i--) {
      const ev = evs[i];
      if (ev.timeSec >= fromSec) continue;
      if (ev.timeSec < clampedTo) break;
      if (ev.type !== 'noteOn') continue;
      const playedMidi =
        ev.plannedMidi !== undefined && ev.plannedMidi !== null
          ? ev.plannedMidi
          : resolveTransposedMidiNote(ev);
      if (playedMidi === null) continue;
      const slotKey = Number.isInteger(ev.plannedSlotIdx)
        ? `slot_${ev.plannedSlotIdx}`
        : `midi_${playedMidi}`;
      latestBySlot.delete(slotKey);
      latestBySlot.set(slotKey, ev);
    }
  }

  for (const [slotKey, ev] of latestBySlot.entries()) {
    const tid = `midiscrub_${slotKey}`;
    startPlannedMidiEventVoice(tid, ev);
    scheduleDefaultVoiceGate(tid, SCRUB_AUDITION_GATE_SEC);
  }

  midiPlayer.elapsedSec = clampedTo;
  midiPlayer.lastPerfMs = performance.now();
  seekMidiEventCursor(clampedTo, { afterInclusive: true });
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
        const playedMidi =
          ev.plannedMidi !== undefined && ev.plannedMidi !== null
            ? ev.plannedMidi
            : resolveTransposedMidiNote(ev);
        if (playedMidi !== null) {
          const tid = `midifile_${ev.channel}_${ev.midi}`;
          midiPlayer.pendingPedalIds.delete(tid);
          midiPlayer.activeTriggerIds.add(tid);
          startPlannedMidiEventVoice(tid, ev);
        }
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
  if (!midiPlayer.parsed || midiPlayer.playing || midiRecorder.state === 'recording') return;
  if (midiRecorder.state === 'armed') {
    cancelMidiRecording();
  }
  closeMidiBrowserPopover();
  ensureAudioContext();
  replanCurrentMidiTimeline();

  const atEnd = midiPlayer.elapsedSec >= midiPlayer.parsed.durationSec - 0.02;
  const atStart = midiPlayer.elapsedSec <= 0.005;
  if (atEnd || atStart) {
    midiPlayer.elapsedSec = 0;
    midiPlayer.nextEventIdx = 0;
    midiPlayer.pedalDown = false;
    resetDeterministicPlaybackState();
  } else {
    seekMidiEventCursor(midiPlayer.elapsedSec, { afterInclusive: false });
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

function warmActiveMidiSlicesInBackground() {
  if (!midiPlayer.parsed || !state.catalog?.keyboardMap) return;
  const usedMidis = new Set();
  for (const ev of midiPlayer.parsed.events || []) {
    if (ev.type === 'noteOn') {
      const m = resolveTransposedMidiNote(ev);
      if (m !== null) usedMidis.add(m);
    }
  }
  const cands = [];
  for (const m of usedMidis) {
    const entry = state.catalog.keyboardMap[m];
    for (const c of entry?.candidates || []) {
      if (c.enabled && !isVideoDisabled(c.videoId)) {
        cands.push(c);
      }
    }
  }
  let cursor = 0;
  const worker = async () => {
    while (cursor < cands.length) {
      const c = cands[cursor++];
      await Promise.all([
        c.audioUrl
          ? audioCtx
            ? loadAudioBuffer(c.audioUrl).catch(() => {})
            : prefetchRawAudioBytes(c.audioUrl)
          : Promise.resolve(),
        c.videoUrl ? warmVideoBlobUrl(c.videoUrl) : Promise.resolve()
      ]);
    }
  };
  Promise.all([worker(), worker(), worker(), worker()]).catch(() => {});
}

async function handleMidiFileSelected(file) {
  if (!file) return;
  if (midiRecorder.state === 'armed') cancelMidiRecording();
  pauseMidiTransport();
  const arrBuf = await file.arrayBuffer();
  const bytes = new Uint8Array(arrBuf);
  const parsed = parseMidiFile(bytes);

  let savedName = file.name;
  if (!state.isStaticMode) {
    try {
      const res = await fetch('./api/midi/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, base64: uint8ToBase64(bytes) })
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.file?.name) savedName = data.file.name;
        if (Array.isArray(data?.files)) midiLibraryFiles = data.files;
      }
    } catch {}
  }

  midiPlayer.fileName = savedName;
  midiPlayer.parsed = parsed;
  midiPlayer.elapsedSec = 0;
  midiPlayer.nextEventIdx = 0;
  resetDeterministicPlaybackState();
  replanCurrentMidiTimeline();

  closeMidiBrowserPopover();
  updateMidiTransportUi();
  warmActiveMidiSlicesInBackground();
}

// ============================================================================
// Event Bindings
// ============================================================================
function setupEventListeners() {
  window.addEventListener('pagehide', () => savePrefsToStorage());
  window.addEventListener('beforeunload', () => savePrefsToStorage());

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

  // Discreet Stage Grid Mode (3×1, 2×2, 3×2, 4×2, 3×3), Mosaic Tile Size (100%–250%) & Visual Fade-Out
  document.querySelectorAll('.stage-grid-pill[data-grid-mode]').forEach(pill => {
    pill.addEventListener('click', () => {
      const mode = pill.dataset.gridMode;
      if (mode) setStageGridMode(mode, true);
    });
  });
  const stageTileScaleSlider = document.getElementById('stageTileScaleSlider');
  if (stageTileScaleSlider) {
    stageTileScaleSlider.addEventListener('input', () => {
      setStageTileScale(Number(stageTileScaleSlider.value) / 100, true);
    });
    stageTileScaleSlider.addEventListener('change', () => {
      setStageTileScale(Number(stageTileScaleSlider.value) / 100, true);
    });
  }
  const stageSpecScaleSlider = document.getElementById('stageSpecScaleSlider');
  if (stageSpecScaleSlider) {
    stageSpecScaleSlider.addEventListener('input', () => {
      setStageSpecScale(Number(stageSpecScaleSlider.value) / 100, true);
    });
    stageSpecScaleSlider.addEventListener('change', () => {
      setStageSpecScale(Number(stageSpecScaleSlider.value) / 100, true);
    });
  }
  const stageFadeInSlider = document.getElementById('stageFadeInSlider');
  if (stageFadeInSlider) {
    stageFadeInSlider.addEventListener('input', () => {
      setStageFadeInSec(Number(stageFadeInSlider.value), true);
    });
    stageFadeInSlider.addEventListener('change', () => {
      setStageFadeInSec(Number(stageFadeInSlider.value), true);
    });
  }
  const stageFadeSlider = document.getElementById('stageFadeSlider');
  if (stageFadeSlider) {
    stageFadeSlider.addEventListener('input', () => {
      setStageFadeSec(Number(stageFadeSlider.value), true);
    });
    stageFadeSlider.addEventListener('change', () => {
      setStageFadeSec(Number(stageFadeSlider.value), true);
    });
  }
  const stageMaxDisplayToggle = document.getElementById('stageMaxDisplayToggle');
  if (stageMaxDisplayToggle) {
    stageMaxDisplayToggle.addEventListener('change', () => {
      setStageMaxDisplayEnabled(stageMaxDisplayToggle.checked, true);
    });
  }
  const stageMaxDisplaySlider = document.getElementById('stageMaxDisplaySlider');
  if (stageMaxDisplaySlider) {
    stageMaxDisplaySlider.addEventListener('input', () => {
      setStageMaxDisplaySec(Number(stageMaxDisplaySlider.value), true);
    });
    stageMaxDisplaySlider.addEventListener('change', () => {
      setStageMaxDisplaySec(Number(stageMaxDisplaySlider.value), true);
    });
  }

  // Collapsible Per-Note Sample Drawer Toggle (Left of Keyboard + Drawer Hide Button)
  const noteSamplesToggleBtn = document.getElementById('noteSamplesToggleBtn');
  if (noteSamplesToggleBtn) {
    noteSamplesToggleBtn.addEventListener('click', () => {
      setSelectionFocus('keyboard');
      setNoteSamplesExpanded(!state.noteSamplesExpanded);
    });
  }
  const collapseNoteSamplesBtn = document.getElementById('collapseNoteSamplesBtn');
  if (collapseNoteSamplesBtn) {
    collapseNoteSamplesBtn.addEventListener('click', () => {
      setNoteSamplesExpanded(false);
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

  // MIDI Transport: ./midi/ Browser + Reset/Rewind + Play/Pause + Record + Scrub Bar
  const midiBrowserToggleBtn = document.getElementById('midiBrowserToggleBtn');
  const midiImportExternalBtn = document.getElementById('midiImportExternalBtn');
  const midiFileInput = document.getElementById('midiFileInput');
  const midiResetBtn = document.getElementById('midiResetBtn');
  const midiPlayPauseBtn = document.getElementById('midiPlayPauseBtn');
  const midiRecordBtn = document.getElementById('midiRecordBtn');
  const midiScrubTrack = document.getElementById('midiScrubTrack');

  if (midiBrowserToggleBtn) {
    midiBrowserToggleBtn.addEventListener('click', e => {
      e.stopPropagation();
      toggleMidiBrowserPopover();
    });
  }

  if (midiImportExternalBtn && midiFileInput) {
    midiImportExternalBtn.addEventListener('click', () => {
      midiFileInput.click();
    });
  }

  if (midiFileInput) {
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

  if (midiResetBtn) {
    midiResetBtn.addEventListener('click', () => {
      rewindAndResetMidiTransport();
    });
  }

  if (midiPlayPauseBtn) {
    midiPlayPauseBtn.addEventListener('click', () => {
      if (midiPlayer.playing) pauseMidiTransport();
      else playMidiTransport();
    });
  }

  if (midiRecordBtn) {
    midiRecordBtn.addEventListener('click', () => {
      toggleMidiRecording();
    });
  }

  document.addEventListener('mousedown', e => {
    if (!midiBrowserOpen) return;
    const t = e.target;
    if (t.closest('#midiBrowserPopover') || t.closest('#midiBrowserToggleBtn')) return;
    closeMidiBrowserPopover();
  });

  window.addEventListener('resize', () => {
    if (midiBrowserOpen) positionMidiBrowserPopover();
  });

  const midiOctDownBtn = document.getElementById('midiOctDownBtn');
  if (midiOctDownBtn) {
    midiOctDownBtn.addEventListener('click', () => shiftMidiTransposeOctave(-1));
  }
  const midiOctUpBtn = document.getElementById('midiOctUpBtn');
  if (midiOctUpBtn) {
    midiOctUpBtn.addEventListener('click', () => shiftMidiTransposeOctave(1));
  }

  if (midiScrubTrack) {
    let scrubDownX = 0;
    let scrubDragging = false;
    let scrubPrevSec = 0;
    let scrubLatestSec = 0;
    let scrubRafId = null;

    const pointerXToMidiSec = clientX => {
      if (!midiPlayer.parsed) return 0;
      const rail = midiScrubTrack.querySelector('.scrub-rail') || midiScrubTrack;
      const rect = rail.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      return ratio * (midiPlayer.parsed.durationSec || 0);
    };

    const flushScrubAuditionFrame = () => {
      scrubRafId = null;
      if (!midiPlayer.parsed) return;
      const fromSec = scrubPrevSec;
      const toSec = scrubLatestSec;
      scrubPrevSec = toSec;
      if (Math.abs(toSec - fromSec) > 1e-5) {
        scrubMidiTransportBetween(fromSec, toSec);
      }
    };

    midiScrubTrack.addEventListener('mousedown', e => {
      if (e.button !== 0 || !midiPlayer.parsed) return;
      e.preventDefault();
      ensureAudioContext();
      replanCurrentMidiTimeline();

      const rail = midiScrubTrack.querySelector('.scrub-rail') || midiScrubTrack;
      const rect = rail.getBoundingClientRect();
      const dur = Math.max(0.01, Number(midiPlayer.parsed.durationSec || 0.01));
      const curThumbX = rect.left + Math.max(0, Math.min(1, midiPlayer.elapsedSec / dur)) * rect.width;
      const grabbedNearPlayhead = Math.abs(e.clientX - curThumbX) <= 10;

      midiPlayer.scrubbing = true;
      scrubDownX = e.clientX;
      scrubDragging = grabbedNearPlayhead;

      if (grabbedNearPlayhead) {
        silenceAllMidiTransportVoices(0.06);
        scrubPrevSec = midiPlayer.elapsedSec;
        scrubLatestSec = pointerXToMidiSec(e.clientX);
        midiPlayer.elapsedSec = scrubLatestSec;
        updateMidiTransportUi();
        if (!scrubRafId) {
          scrubRafId = requestAnimationFrame(flushScrubAuditionFrame);
        }
      } else {
        const targetSec = pointerXToMidiSec(e.clientX);
        scrubPrevSec = targetSec;
        scrubLatestSec = targetSec;
        // Single click away from playhead jumps cleanly without firing notes across the gap
        seekMidiTransportTo(targetSec);
      }
    });

    window.addEventListener('mousemove', e => {
      if (!midiPlayer.scrubbing || !midiPlayer.parsed) return;
      if (!scrubDragging && Math.abs(e.clientX - scrubDownX) < 2) return;
      scrubDragging = true;

      scrubLatestSec = pointerXToMidiSec(e.clientX);
      midiPlayer.elapsedSec = scrubLatestSec;
      updateMidiTransportUi();

      if (!scrubRafId) {
        scrubRafId = requestAnimationFrame(flushScrubAuditionFrame);
      }
    });

    window.addEventListener('mouseup', () => {
      if (!midiPlayer.scrubbing) return;
      if (scrubRafId) {
        cancelAnimationFrame(scrubRafId);
        flushScrubAuditionFrame();
      }
      midiPlayer.scrubbing = false;
      scrubDragging = false;
      midiPlayer.lastPerfMs = performance.now();
      updateMidiTransportUi();
    });
  }

  // Unified Flush Inspector Blade Header Controls & Outside-Click Auto-Close
  const bladeCloseBtn = document.getElementById('bladeCloseBtn');
  if (bladeCloseBtn) {
    bladeCloseBtn.addEventListener('click', () => {
      closeInspectorBlade();
    });
  }

  const bladeGroupSwitch = document.getElementById('bladeGroupSwitch');
  if (bladeGroupSwitch) {
    bladeGroupSwitch.addEventListener('click', () => {
      if (!bladeState.open) return;
      const vids = bladeState.groupVideos || [];
      if (vids.length === 0) return;
      const anyEnabled = vids.some(v => !isVideoDisabled(v.id));
      setVideosEnabled(
        vids.map(v => v.id),
        !anyEnabled
      );
    });
  }

  document.addEventListener('mousedown', e => {
    if (!bladeState.open) return;
    const t = e.target;
    if (
      t.closest('#inspectorBlade') ||
      t.closest('#fileExplorer') ||
      t.closest('.candidate-card')
    ) {
      return;
    }
    closeInspectorBlade();
  });

  // Unified Spectrogram [ IN ... OUT ] Sub-Trim Pointer Drag & Auto-Persist
  const persistBladeTrimIfChanged = async () => {
    if (!bladeState.video || !bladeState.slice || state.isStaticMode) return;
    const savedVideoId = bladeState.video.id;
    const savedSliceId = bladeState.slice.id;
    const rawDur = Math.max(0.12, Math.min(MAX_CLIP_DUR, bladeState.rawDur));
    const curSavedIn = Number(bladeState.slice.trimIn ?? 0);
    const curSavedOut = Number(bladeState.slice.trimOut ?? rawDur);
    if (
      Math.abs(bladeState.inSec - curSavedIn) < 0.005 &&
      Math.abs(bladeState.outSec - curSavedOut) < 0.005
    ) {
      return;
    }
    const isFullRange =
      bladeState.inSec <= 0.005 && bladeState.outSec >= Math.max(0.08, rawDur - 0.005);
    const payload = isFullRange
      ? { videoId: savedVideoId, sliceId: savedSliceId, resetTrim: true }
      : {
          videoId: savedVideoId,
          sliceId: savedSliceId,
          trimIn: Number(bladeState.inSec.toFixed(2)),
          trimOut: Number(bladeState.outSec.toFixed(2))
        };
    await apiPost('/api/slice/update', payload);
  };

  window.addEventListener('mousemove', e => {
    if (!bladeState.open || !bladeState.dragMode || !bladeState.slice) return;
    const stageEl = document.getElementById('bladeExpSpecStage');
    if (!stageEl) return;
    const deltaPx = e.clientX - bladeState.dragStartX;
    if (!bladeState.dragMoved && Math.abs(deltaPx) < 3) return;
    bladeState.dragMoved = true;

    const rect = stageEl.getBoundingClientRect();
    const rawDur = Math.max(0.12, Math.min(MAX_CLIP_DUR, bladeState.rawDur));
    const minLen = getMinTrimLen(rawDur);
    const deltaSec = (deltaPx / Math.max(1, rect.width)) * rawDur;

    if (bladeState.dragMode === 'in') {
      const nextIn = Math.max(0, Math.min(bladeState.outSec - minLen, bladeState.dragStartIn + deltaSec));
      bladeState.inSec = Number(nextIn.toFixed(2));
      renderBladeTrimHandlesUI();
      scrubBladeVideoTo(bladeState.inSec);
    } else if (bladeState.dragMode === 'out') {
      const nextOut = Math.max(
        bladeState.inSec + minLen,
        Math.min(rawDur, bladeState.dragStartOut + deltaSec)
      );
      bladeState.outSec = Number(nextOut.toFixed(2));
      renderBladeTrimHandlesUI();
      scrubBladeVideoTo(bladeState.outSec);
    } else if (bladeState.dragMode === 'move') {
      const clipLen = Math.max(
        minLen,
        Math.min(rawDur, bladeState.dragStartOut - bladeState.dragStartIn)
      );
      const nextIn = Math.max(0, Math.min(rawDur - clipLen, bladeState.dragStartIn + deltaSec));
      bladeState.inSec = Number(nextIn.toFixed(2));
      bladeState.outSec = Number(Math.min(rawDur, bladeState.inSec + clipLen).toFixed(2));
      renderBladeTrimHandlesUI();
      scrubBladeVideoTo(bladeState.inSec);
    }
  });

  window.addEventListener('mouseup', () => {
    if (!bladeState.dragMode) return;
    document.getElementById('bladeExpSpecStage')?.classList.remove('is-dragging');
    const wasClickWithoutDrag = bladeState.dragMode === 'move' && !bladeState.dragMoved;
    const didMove = bladeState.dragMoved;
    bladeState.dragMode = null;
    bladeState.dragMoved = false;
    if (wasClickWithoutDrag) {
      startBladePreview(false);
    } else if (didMove) {
      persistBladeTrimIfChanged();
    }
  });

  const scrollExplorerCursorIntoView = () => {
    const el = document.querySelector(
      '#explorerList .explorer-video-row.is-cursor-focus, #explorerList .explorer-cat-header.is-cursor-focus'
    );
    el?.scrollIntoView({ block: 'nearest' });
  };

  const resolveExplorerFocusIdx = items => {
    if (!bladeState.explorerFocus || items.length === 0) return 0;
    const f = bladeState.explorerFocus;
    const found = items.findIndex(it =>
      f.type === 'group'
        ? it.type === 'group' && it.groupKey === f.groupKey
        : it.type === 'cat' && it.cat === f.cat
    );
    return found >= 0 ? found : 0;
  };

  // QWERTY Keydown / Keyup + Full Cursor-Key Navigation ('explorer' | 'blade' | 'tile' | 'keyboard')
  window.addEventListener('keydown', async e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.metaKey || e.ctrlKey) {
      return;
    }

    if (e.key === 'Escape') {
      if (midiBrowserOpen) {
        e.preventDefault();
        closeMidiBrowserPopover();
        return;
      }
      if (midiRecorder.state === 'armed') {
        e.preventDefault();
        cancelMidiRecording();
        return;
      }
      if (bladeState.open) {
        e.preventDefault();
        closeInspectorBlade();
        return;
      }
      if (state.selectionTarget === 'explorer') {
        e.preventDefault();
        setSelectionFocus('keyboard');
        return;
      }
      return;
    }

    // 1. Left Sidebar ('explorer') Cursor Navigation
    if (state.selectionTarget === 'explorer') {
      const items = getVisibleExplorerNavItems();
      if (items.length > 0) {
        const curIdx = resolveExplorerFocusIdx(items);
        const curItem = items[curIdx];

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const dir = e.key === 'ArrowDown' ? 1 : -1;
          const nextIdx = Math.max(0, Math.min(items.length - 1, curIdx + dir));
          const nextItem = items[nextIdx];
          bladeState.explorerFocus =
            nextItem.type === 'group'
              ? {
                  type: 'group',
                  cat: nextItem.cat,
                  groupKey: nextItem.groupKey,
                  videoId: nextItem.videoId
                }
              : { type: 'cat', cat: nextItem.cat };

          if (nextItem.type === 'group') {
            openInspectorBlade(nextItem.videoId, {
              expandedSliceId: null,
              autoPlay: false,
              focusTarget: 'explorer'
            });
          } else {
            closeInspectorBlade({ keepExplorerFocus: true });
            setSelectionFocus('explorer');
          }
          requestAnimationFrame(scrollExplorerCursorIntoView);
          return;
        }

        if (e.key === 'ArrowRight') {
          e.preventDefault();
          if (curItem.type === 'cat') {
            if (state.collapsedCategories.has(curItem.cat)) {
              state.collapsedCategories.delete(curItem.cat);
              renderFileExplorer();
              requestAnimationFrame(scrollExplorerCursorIntoView);
            } else {
              const updated = getVisibleExplorerNavItems();
              const freshIdx = resolveExplorerFocusIdx(updated);
              const child = updated[freshIdx + 1];
              if (child && child.type === 'group' && child.cat === curItem.cat) {
                bladeState.explorerFocus = {
                  type: 'group',
                  cat: child.cat,
                  groupKey: child.groupKey,
                  videoId: child.videoId
                };
                openInspectorBlade(child.videoId, {
                  expandedSliceId: null,
                  autoPlay: false,
                  focusTarget: 'explorer'
                });
                requestAnimationFrame(scrollExplorerCursorIntoView);
              }
            }
          } else if (curItem.type === 'group') {
            if (!bladeState.open || bladeState.groupKey !== curItem.groupKey) {
              openInspectorBlade(curItem.videoId, {
                expandedSliceId: null,
                autoPlay: false,
                focusTarget: 'blade'
              });
            }
            const first = getBladeOrderedSamples()[0];
            if (first) {
              expandBladeSample(first.video.id, first.slice.id, {
                autoPlay: true,
                scrollIntoView: true,
                focusTarget: 'blade'
              });
            } else {
              setSelectionFocus('blade');
            }
          }
          return;
        }

        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          if (curItem.type === 'group') {
            bladeState.explorerFocus = { type: 'cat', cat: curItem.cat };
            closeInspectorBlade({ keepExplorerFocus: true });
            setSelectionFocus('explorer');
            requestAnimationFrame(scrollExplorerCursorIntoView);
          } else if (curItem.type === 'cat' && !state.collapsedCategories.has(curItem.cat)) {
            state.collapsedCategories.add(curItem.cat);
            if (bladeState.open && bladeState.groupKey?.startsWith(`${curItem.cat}::`)) {
              closeInspectorBlade({ keepExplorerFocus: true });
            }
            renderFileExplorer();
            setSelectionFocus('explorer');
            requestAnimationFrame(scrollExplorerCursorIntoView);
          }
          return;
        }

        if ((e.code === 'Space' || e.key === ' ') && !e.repeat) {
          e.preventDefault();
          if (curItem.type === 'group') {
            if (!bladeState.open || bladeState.groupKey !== curItem.groupKey) {
              openInspectorBlade(curItem.videoId, {
                expandedSliceId: null,
                autoPlay: false,
                focusTarget: 'explorer'
              });
            }
            startBladePreview(false);
          } else if (curItem.type === 'cat') {
            if (state.collapsedCategories.has(curItem.cat)) {
              state.collapsedCategories.delete(curItem.cat);
            } else {
              state.collapsedCategories.add(curItem.cat);
            }
            renderFileExplorer();
          }
          return;
        }

        if (e.key === 'Enter' && !e.repeat) {
          e.preventDefault();
          const anyEnabled = curItem.videoIds.some(id => !isVideoDisabled(id));
          setVideosEnabled(curItem.videoIds, !anyEnabled);
          return;
        }
      }
    }

    // 2. Inspector Blade ('blade') Sample Cursor Navigation
    if (state.selectionTarget === 'blade' && bladeState.open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const ordered = getBladeOrderedSamples();
        if (ordered.length > 0) {
          const curIdx = ordered.findIndex(item => item.slice.id === bladeState.expandedSliceId);
          const nextIdx =
            curIdx < 0
              ? e.key === 'ArrowDown'
                ? 0
                : ordered.length - 1
              : Math.max(0, Math.min(ordered.length - 1, curIdx + (e.key === 'ArrowDown' ? 1 : -1)));
          if (nextIdx !== curIdx) {
            const target = ordered[nextIdx];
            expandBladeSample(target.video.id, target.slice.id, {
              autoPlay: true,
              scrollIntoView: true,
              focusTarget: 'blade'
            });
          }
        }
        return;
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        expandBladeSample(null, null, { focusTarget: 'explorer' });
        requestAnimationFrame(scrollExplorerCursorIntoView);
        return;
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (!bladeState.expandedSliceId) {
          const first = getBladeOrderedSamples()[0];
          if (first) {
            expandBladeSample(first.video.id, first.slice.id, {
              autoPlay: true,
              scrollIntoView: true,
              focusTarget: 'blade'
            });
          }
        }
        return;
      }

      if ((e.code === 'Space' || e.key === ' ') && !e.repeat) {
        e.preventDefault();
        startBladePreview(false);
        return;
      }

      if (e.key === 'Enter' && !e.repeat) {
        e.preventDefault();
        if (bladeState.slice) {
          const cand = findKeyboardCandidate(bladeState.slice.id);
          const curEn = cand ? Boolean(cand.enabled) : true;
          const nextEn = !curEn;
          if (nextEn && cand) {
            triggerDefaultCandidateGate('ui_blade_enter', bladeState.assignedMidi, cand, 0);
          }
          await apiPost('/api/keyboard/toggle', {
            midi: bladeState.assignedMidi,
            sliceId: bladeState.slice.id,
            enabled: nextEn
          });
        }
        return;
      }
    }

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (state.selectionTarget === 'tile') {
        stepTileSelection(-1, 0);
      } else if (e.shiftKey) {
        stepToAdjacentPopulatedKey(-1);
      } else {
        selectKeyForConfig(state.selectedMidi - 1, true);
      }
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (state.selectionTarget === 'tile') {
        stepTileSelection(1, 0);
      } else if (e.shiftKey) {
        stepToAdjacentPopulatedKey(1);
      } else {
        selectKeyForConfig(state.selectedMidi + 1, true);
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      if (state.selectionTarget === 'tile') {
        e.preventDefault();
        stepTileSelection(0, -1);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      if (state.selectionTarget === 'tile') {
        e.preventDefault();
        stepTileSelection(0, 1);
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
      const midi = state.qwertyOctaveMidi + mapped.offset;
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
              if (state.sustainPedalDown !== down) {
                recordLiveSustainPedal(down);
              }
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
  state.noteSamplesExpanded = Boolean(prefs.noteSamplesExpanded);
  state.selectionTarget = 'keyboard';
  state.selectedTileSliceId = null;
  state.stageGridMode = normalizeStageGridMode(prefs.stageGridMode);
  state.stageTileScale = clampStageTileScale(prefs.stageTileScale ?? 1.0);
  state.stageSpecScale = clampStageSpecScale(prefs.stageSpecScale ?? 1.0);
  state.stageFadeInSec = clampStageFadeInSec(prefs.stageFadeInSec ?? 0.0);
  state.stageFadeSec = clampStageFadeSec(prefs.stageFadeSec ?? 0.2);
  state.stageMaxDisplayEnabled = Boolean(prefs.stageMaxDisplayEnabled);
  state.stageMaxDisplaySec = clampStageMaxDisplaySec(prefs.stageMaxDisplaySec ?? 1.0);
  midiPlayer.transposeOctaves = clampMidiTransposeOctaves(prefs.midiTransposeOctaves ?? 0);
  if (prefs.hasSavedDisabledVideos) {
    state.disabledVideoIds = new Set(prefs.disabledVideoIds);
  }
  state.collapsedCategories = new Set(CATEGORY_ORDER);
  state.videoGainOverrides = prefs.videoGains || {};
  state.sliceToggleOverrides = prefs.sliceToggles || {};
  state.hasCustomKeyboardOctave = Boolean(prefs.hasCustomKeyboardOctave);
  state.qwertyOctaveMidi = normalizeQwertyOctaveMidi(prefs.qwertyOctaveMidi ?? 60);
  state.baseOctaveMidi = state.hasCustomKeyboardOctave
    ? clampKeyboardStartMidi(prefs.baseOctaveMidi, state.visibleOctaves)
    : getDefaultStartMidiForOctaves(state.visibleOctaves);

  setChromeCollapsed(state.chromeCollapsed);
  setNoteSamplesExpanded(state.noteSamplesExpanded);
  updateMidiTransportUi();
  prefsHydrated = true;

  const threeCanvas = document.getElementById('threeStageCanvas');
  if (threeCanvas) {
    const MIN_SCRUB_HOLD_SEC = 0.18;
    threeStage = createThreeStage({
      canvas: threeCanvas,
      getActiveSliceIds: getActiveStageSliceIds,
      isVideoDisabled: id => isVideoDisabled(id),
      formatTooltip: item =>
        `${getVideoGroupName(item.videoId) || item.videoSlug} · ${midiToName(item.midi ?? 60)}`,
      onSliceEnter: item => {
        setSelectionFocus('tile', item.sliceId);
        const cand = resolvePlayableSliceById(item.sliceId);
        if (!cand) return;
        state.lastPlayedVideoId = cand.videoId;
        state.lastPlayedSliceId = cand.sliceId;
        if (cand.enabled) {
          lastPlayedSliceByMidi.set(cand.midi, cand.sliceId);
        }
        if (cand.midi >= MIN_MIDI && cand.midi <= MAX_MIDI && state.selectedMidi !== cand.midi) {
          selectKeyForConfig(cand.midi, false, true);
        }
        if (cand.midi === state.selectedMidi) {
          syncActiveCandidateHighlightUI(true);
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

  syncStageConfigUI();
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

  // Hydrate curated stageConfig defaults for first-time visitors with no saved localStorage prefs
  if (!prefs.hasSavedPrefs && state.catalog?.stageConfig) {
    const sc = state.catalog.stageConfig;
    if (sc.stageGridMode !== undefined) state.stageGridMode = normalizeStageGridMode(sc.stageGridMode);
    if (sc.stageTileScale !== undefined) state.stageTileScale = clampStageTileScale(sc.stageTileScale);
    if (sc.stageSpecScale !== undefined) state.stageSpecScale = clampStageSpecScale(sc.stageSpecScale);
    if (sc.stageFadeInSec !== undefined) state.stageFadeInSec = clampStageFadeInSec(sc.stageFadeInSec);
    if (sc.stageFadeSec !== undefined) state.stageFadeSec = clampStageFadeSec(sc.stageFadeSec);
    if (sc.stageMaxDisplayEnabled !== undefined) {
      state.stageMaxDisplayEnabled = Boolean(sc.stageMaxDisplayEnabled);
    }
    if (sc.stageMaxDisplaySec !== undefined) {
      state.stageMaxDisplaySec = clampStageMaxDisplaySec(sc.stageMaxDisplaySec);
    }
    if (sc.midiTransposeOctaves !== undefined) {
      midiPlayer.transposeOctaves = clampMidiTransposeOctaves(sc.midiTransposeOctaves);
    }
    syncStageConfigUI();
    updateStageTileSizes();
    updateMidiTransportUi();
  }

  fetchMidiLibraryList();

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

  // Sync holistic per-video gainDb & groupName from catalog
  for (const v of validVideos) {
    const catGain = clampVideoGainDb(v.gainDb ?? 0);
    if (state.isStaticMode && Object.prototype.hasOwnProperty.call(state.videoGainOverrides, v.id)) {
      v.gainDb = clampVideoGainDb(state.videoGainOverrides[v.id]);
    } else {
      v.gainDb = catGain;
      state.videoGainOverrides[v.id] = catGain;
    }

    v.groupName = String(v.groupName || '').trim() || inferClientGroupName(v.slug);
  }

  if (state.isStaticMode && prefs.hasSavedDisabledVideos) {
    state.disabledVideoIds = new Set(prefs.disabledVideoIds.filter(id => validIdSet.has(id)));
    for (const v of validVideos) {
      v.enabled = !state.disabledVideoIds.has(v.id);
    }
  } else {
    state.disabledVideoIds = catalogDisabled;
    for (const v of validVideos) {
      v.enabled = !state.disabledVideoIds.has(v.id);
    }
  }

  prefsHydrated = true;
  savePrefsToStorage();

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
  syncStageConfigUI();
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
