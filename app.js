import { parseMidiFile, encodeMidiFile } from './midi-parser.mjs';
import {
  resolveTransposedMidiNote as resolveTransposedMidiNoteShared,
  chooseStageSlot,
  planMidiTimeline,
  clampBuildFullSec,
  clampBuildMaxFps,
  normalizeBuildRampUp,
  normalizeBuildSound,
  BUILD_TAP_BASE_GAIN,
  synthesizeBuildTapPcm,
  planIntroBuild
} from './midi-timeline.mjs';
import { createThreeStage } from './three-stage.mjs';
import {
  BROWSER_ASPECT_SPECS,
  normalizeBrowserAspectRatio,
  isBrowserOfflineExportSupported,
  renderMidiSessionInBrowserToMp4
} from './browser-offline-render.mjs';

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
const MIN_STAGE_MIN_DISPLAY_SEC = 0.0;
const MAX_STAGE_MIN_DISPLAY_SEC = 2.0;
const MIN_STAGE_MAX_DISPLAY_SEC = 0.2;
const MAX_STAGE_MAX_DISPLAY_SEC = 6.0;
const MIN_STAGE_TILE_SCALE = 0.6;
const MAX_STAGE_TILE_SCALE = 2.5;
const MIN_STAGE_SPEC_SCALE = 0.75;
const MAX_STAGE_SPEC_SCALE = 4.5;

const ACCIDENTAL_SEMITONES = new Set([1, 3, 6, 8, 10]);
const TOUCH_LEFT_ACCIDENTALS = new Set([3, 8, 10]); // D#, G#, A# touch C#, F#, G#
const NATURAL_INDEX_BY_PC = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
const ACCIDENTAL_OFFSET_BY_PC = { 1: 0.5, 3: 1.5, 6: 3.5, 8: 4.5, 10: 5.5 };

const MIN_MIDI = 12; // C0 (Percussion Octaves C0–B1 coexist with Low Piano A0–B1)
const MAX_MIDI = 108; // C8 (Full 88-key grand piano top C8)
const MIN_BASE_OCTAVE_MIDI = 12; // C0
const TOP_KEYBOARD_MIDI_LIMIT = 108; // B7 is 107; maxStartMidi = 108 - visibleOctaves * 12
const MIN_VISIBLE_OCTAVES = 2;
const MAX_VISIBLE_OCTAVES = 4;

const PREFS_STORAGE_KEY = 'everytone_prefs_v2';
const LITE_PREFS_STORAGE_KEY = 'everytone_lite_prefs_v1';
const IS_LITE_BUILD =
  typeof document !== 'undefined' &&
  (Boolean(document.querySelector('meta[name="everytone-lite"][content="true"]')) ||
    new URLSearchParams(window.location.search).get('lite') === '1');
if (IS_LITE_BUILD && typeof document !== 'undefined') {
  document.body?.classList.add('lite-mode', 'lite-splash-active');
}
const CATEGORY_ORDER = [
  'strings',
  'winds',
  'keys',
  'animals',
  'metal',
  'glass',
  'wood',
  'toms',
  'percussion'
];

// Standard chromatic QWERTY layout (18 keys starting at qwertyOctaveMidi)
const QWERTY_MAP = [
  { code: 'KeyA', offset: 0 },
  { code: 'KeyW', offset: 1 },
  { code: 'KeyS', offset: 2 },
  { code: 'KeyE', offset: 3 },
  { code: 'KeyD', offset: 4 },
  { code: 'KeyF', offset: 5 },
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

const MAX_CLIP_DUR = 6.00; // Universal hard cap on clip length (seconds)
const DEFAULT_UI_HOLD_SEC = 0.50; // Fixed simulated hold for mouse clicks & UI navigation
const DEFAULT_UNIFORM_VELOCITY = 0.90; // Default fixed MIDI velocity when velocity sensitivity is OFF

const state = {
  catalog: null,
  selectedMidi: 60, // Defaults to C4
  selectionTarget: 'keyboard', // 'keyboard' | 'tile' | 'explorer' | 'blade'
  selectedTileSliceId: null, // Active selected tile sliceId when selectionTarget === 'tile'
  auditionIndex: 0,
  chromeCollapsed: false,
  sessionsCollapsed: false,
  presetsCollapsed: false,
  rollCollapsed: false,
  keysCollapsed: false,
  noteSamplesExpanded: false, // Collapsed by default on load so playing is uncluttered
  stageGridMode: '3x1', // '3x1' | '2x2' | '3x2' | '4x2' | '3x3'
  stageTileScale: 1.0, // Bottom sample mosaic tile scale (1.0 = 100% up to 2.5 = 250%)
  stageSpecScale: 1.0, // Visual spectrogram height scale (0.75 = 75% up to 4.5 = 450%, ~2/3 of video height)
  stageFadeInSec: 0.0, // Optional visual fade-in / dissolve duration (0.0s = Off hard cut, up to 1.0s)
  stageFadeSec: 0.20, // Configurable visual fade-out duration (0.0s = Off hard cut, up to 2.0s)
  stageMinDisplaySec: 0.70, // Minimum visual display duration before ramp-down begins (0.0s Off to 2.0s)
  stageMaxDisplaySec: 1.00, // Always-on maximum visual display duration before ramp-down begins (0.2s to 2.5s)
  stageSettingsTab: 'layout', // Active settings tab: 'layout' | 'motion' | 'camera' | 'build'
  stageShowVideo: true, // Show/hide B&W hand video strip (live webcam or session MP4)
  stageVideoPosition: 'right', // 'right' (right of sample tiles) | 'below' (full-width below sample tiles)
  stageVideoWidthPct: 50, // Hand video share of the bottom cluster width when 'right' (15% .. 80%, default 50%)
  stageVideoHeightPct: 23, // Hand video height as % of strip width when 'below' (10% .. 45%, default 23%)
  stageVideoCropX: 50, // Horizontal pan position 0% (Left) .. 50% (Center) .. 100% (Right)
  stageVideoCropY: 50, // Vertical pan position 0% (Top) .. 50% (Center) .. 100% (Bottom)
  stageVideoZoom: 1.0, // Hand video zoom scale (1.00 = 100% .. 2.50 = 250%)
  stageVideoBrightness: 1.0, // Overall B&W hand video brightness/dimmer (0.10 = 10% .. 100%)
  stageBuildRampUp: true, // When true, starts slower and ramps up; when false, builds linearly at constant speed
  stageBuildFullSec: 5.0, // Fixed total seconds for the whole build (1.0s .. 25.0s)
  stageBuildMaxFps: 12, // Max showcase image flash rate during build (2 .. 15 fps)
  stageBuildSound: true, // Play audio during build animation (true = Sound, false = Silent)
  visibleOctaves: 3, // Responsively adjusts between 2 and 4 octaves based on keyboard width
  hasCustomKeyboardOctave: false,
  baseOctaveMidi: 48, // Leftmost visible octave of the bottom keyboard (e.g. C3 for C3–B5)
  qwertyOctaveMidi: 60, // Laptop QWERTY A..; octave root (defaults to middle C4)
  disabledVideoIds: new Set(),
  soloGroupKey: null,
  soloVideoIds: new Set(),
  collapsedCategories: new Set(),
  videoGainOverrides: {}, // Per-video holistic gainDb persistence
  sliceToggleOverrides: {}, // Static-mode per-slice toggle persistence
  releaseSec: 0.40, // Permanent 0.40s universal audio release decay
  highpassHz: 26, // Master sub-26Hz DC/rumble cut preserving A0 (27.5 Hz) bass piano fundamentals
  velocitySensitive: false, // Default OFF: ignore MIDI key velocity and play at uniform velocity
  sustainPedalDown: false,
  lastPlayedVideoId: null,
  lastPlayedSliceId: null,
  isStaticMode: false,
  isLiteMode: IS_LITE_BUILD,
  liteSplashActive: IS_LITE_BUILD,
  defaultCatalogGridMode: '3x1',
  assetBust: 0
};

// Track last-played slice per MIDI key for round-robin rotation when 2+ clips are ON
const lastPlayedSliceByMidi = new Map();

// ============================================================================
// Persistent Preferences & Readable Group Name Helpers
// ============================================================================
function getDefaultStartMidiForOctaves(octaves) {
  if (octaves >= 3) return 48; // C3–B6 (4 oct) or C3–B5 (3 oct)
  return 60; // C4–B5 (2 oct) or C4–B4 (1 oct)
}

function clampKeyboardStartMidi(raw, octaves = state.visibleOctaves) {
  const minOct = state.isLiteMode ? 1 : MIN_VISIBLE_OCTAVES;
  const vis = Math.max(minOct, Math.min(MAX_VISIBLE_OCTAVES, Math.round(Number(octaves) || 3)));
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
  return Math.max(12, Math.min(96, snapped));
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

function clampStageMinDisplaySec(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.7;
  if (n <= 0.001) return 0.0;
  const stepped = Math.round(n * 10) / 10;
  return Math.max(MIN_STAGE_MIN_DISPLAY_SEC, Math.min(MAX_STAGE_MIN_DISPLAY_SEC, stepped));
}

function formatMinDisplayReadout(sec) {
  if (!Number.isFinite(sec) || sec <= 0.001) return 'Off';
  return `${sec.toFixed(1)}s`;
}

function clampStageMaxDisplaySec(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1.0;
  const stepped = Math.round(n * 10) / 10;
  return Math.max(MIN_STAGE_MAX_DISPLAY_SEC, Math.min(MAX_STAGE_MAX_DISPLAY_SEC, stepped));
}

function normalizeStageSettingsTab(raw) {
  const t = String(raw || '').toLowerCase();
  return t === 'motion' || t === 'camera' || t === 'build' ? t : 'layout';
}

function normalizeStageVideoPosition(raw) {
  return String(raw || '').trim().toLowerCase() === 'below' ? 'below' : 'right';
}

function clampStageVideoWidthPct(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.max(15, Math.min(80, Math.round(n)));
}

function clampStageVideoHeightPct(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 23;
  return Math.max(10, Math.min(45, Math.round(n)));
}

function clampStageVideoCropY(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function clampStageVideoCropX(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function clampStageVideoZoom(raw) {
  let n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1.0;
  if (n > 5) n = n / 100;
  const stepped = Math.round(n * 20) / 20;
  return Math.max(1.0, Math.min(2.5, stepped));
}

function clampStageVideoBrightness(raw) {
  let n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1.0;
  if (n > 2.5) n = n / 100;
  const stepped = Math.round(n * 20) / 20;
  return Math.max(0.1, Math.min(1.0, stepped));
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
    if (explicit) {
      const low = explicit.toLowerCase();
      if (low === 'wood log 1' || low === 'wood log 2') return 'wood log';
      if (low === 'silver bike bell') return 'bike bell';
      return explicit;
    }
  }
  const slug = String(
    typeof videoOrSlug === 'object' ? videoOrSlug?.slug || '' : videoOrSlug || ''
  ).toLowerCase();
  if (!slug) return 'sample';
  if (/^wood-log-mallet-\d+$/.test(slug)) return 'wood log';
  const stripped = slug
    .replace(/-?\d+$/, '')
    .replace(/-(blow|mallet|tube|frets|head|gong|shade|strike)$/, '');
  if (stripped.startsWith('wine-glass-tuned')) return 'tuned wine glass';
  if (stripped.startsWith('silver-bike-bell')) return 'bike bell';
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
  if (!prefsHydrated || state.isStaticMode || state.isLiteMode || !state.catalog) return;
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
        stageMinDisplaySec: clampStageMinDisplaySec(state.stageMinDisplaySec),
        stageMaxDisplaySec: clampStageMaxDisplaySec(state.stageMaxDisplaySec),
        stageShowVideo: state.stageShowVideo,
        stageVideoPosition: normalizeStageVideoPosition(state.stageVideoPosition),
        stageVideoWidthPct: clampStageVideoWidthPct(state.stageVideoWidthPct),
        stageVideoHeightPct: clampStageVideoHeightPct(state.stageVideoHeightPct),
        stageVideoCropX: clampStageVideoCropX(state.stageVideoCropX),
        stageVideoCropY: clampStageVideoCropY(state.stageVideoCropY),
        stageVideoZoom: clampStageVideoZoom(state.stageVideoZoom),
        stageVideoBrightness: clampStageVideoBrightness(state.stageVideoBrightness),
        stageBuildRampUp: normalizeBuildRampUp(state.stageBuildRampUp),
        stageBuildFullSec: clampBuildFullSec(state.stageBuildFullSec),
        stageBuildMaxFps: clampBuildMaxFps(state.stageBuildMaxFps),
        stageBuildSound: normalizeBuildSound(state.stageBuildSound),
        velocitySensitive: Boolean(state.velocitySensitive),
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
  const storageKey = state.isLiteMode ? LITE_PREFS_STORAGE_KEY : PREFS_STORAGE_KEY;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return {
        hasSavedPrefs: false,
        hasSavedDisabledVideos: false,
        disabledVideoIds: [],
        videoGains: {},
        sliceToggles: {},
        chromeCollapsed: false,
        sessionsCollapsed: false,
        presetsCollapsed: false,
        rollCollapsed: false,
        keysCollapsed: false,
        noteSamplesExpanded: false,
        stageSettingsTab: 'layout',
        stageGridMode: '3x1',
        stageTileScale: 1.0,
        stageSpecScale: 1.0,
        stageFadeInSec: 0.0,
        stageFadeSec: 0.2,
        stageMinDisplaySec: 0.7,
        stageMaxDisplaySec: 1.0,
        stageShowVideo: true,
        stageVideoPosition: 'right',
        stageVideoWidthPct: 50,
        stageVideoHeightPct: 23,
        stageVideoCropX: 50,
        stageVideoCropY: 50,
        stageVideoZoom: 1.0,
        stageVideoBrightness: 1.0,
        stageBuildRampUp: true,
        stageBuildFullSec: 5.0,
        stageBuildMaxFps: 12,
        stageBuildSound: true,
        velocitySensitive: false,
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
      sessionsCollapsed: Boolean(parsed?.sessionsCollapsed),
      presetsCollapsed: Boolean(parsed?.presetsCollapsed),
      rollCollapsed: Boolean(parsed?.rollCollapsed),
      keysCollapsed: Boolean(parsed?.keysCollapsed),
      noteSamplesExpanded: Boolean(parsed?.noteSamplesExpanded),
      stageSettingsTab: normalizeStageSettingsTab(parsed?.stageSettingsTab),
      stageGridMode: normalizeStageGridMode(parsed?.stageGridMode),
      stageTileScale: clampStageTileScale(parsed?.stageTileScale ?? 1.0),
      stageSpecScale: clampStageSpecScale(parsed?.stageSpecScale ?? 1.0),
      stageFadeInSec: clampStageFadeInSec(parsed?.stageFadeInSec ?? 0.0),
      stageFadeSec: clampStageFadeSec(parsed?.stageFadeSec ?? 0.2),
      stageMinDisplaySec: clampStageMinDisplaySec(parsed?.stageMinDisplaySec ?? 0.7),
      stageMaxDisplaySec: clampStageMaxDisplaySec(parsed?.stageMaxDisplaySec ?? 1.0),
      stageShowVideo: parsed?.stageShowVideo !== undefined ? Boolean(parsed.stageShowVideo) : true,
      stageVideoPosition: normalizeStageVideoPosition(parsed?.stageVideoPosition ?? 'right'),
      stageVideoWidthPct: clampStageVideoWidthPct(parsed?.stageVideoWidthPct ?? 50),
      stageVideoHeightPct: clampStageVideoHeightPct(parsed?.stageVideoHeightPct ?? 23),
      stageVideoCropX: clampStageVideoCropX(parsed?.stageVideoCropX ?? 50),
      stageVideoCropY: clampStageVideoCropY(parsed?.stageVideoCropY ?? 50),
      stageVideoZoom: clampStageVideoZoom(parsed?.stageVideoZoom ?? 1.0),
      stageVideoBrightness: clampStageVideoBrightness(parsed?.stageVideoBrightness ?? 1.0),
      stageBuildRampUp: normalizeBuildRampUp(parsed?.stageBuildRampUp ?? true),
      stageBuildFullSec: clampBuildFullSec(parsed?.stageBuildFullSec ?? 5.0),
      stageBuildMaxFps: clampBuildMaxFps(parsed?.stageBuildMaxFps ?? 12),
      stageBuildSound: normalizeBuildSound(parsed?.stageBuildSound ?? true),
      velocitySensitive: Boolean(parsed?.velocitySensitive ?? false),
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
      sessionsCollapsed: false,
      presetsCollapsed: false,
      rollCollapsed: false,
      keysCollapsed: false,
      noteSamplesExpanded: false,
      stageSettingsTab: 'layout',
      stageGridMode: '3x1',
      stageTileScale: 1.0,
      stageSpecScale: 1.0,
      stageFadeInSec: 0.0,
      stageFadeSec: 0.2,
      stageMinDisplaySec: 0.7,
      stageMaxDisplaySec: 1.0,
      stageShowVideo: true,
      stageVideoPosition: 'right',
      stageVideoWidthPct: 50,
      stageVideoHeightPct: 23,
      stageVideoCropX: 50,
      stageVideoCropY: 50,
      stageVideoZoom: 1.0,
      stageVideoBrightness: 1.0,
      stageBuildRampUp: true,
      stageBuildFullSec: 5.0,
      stageBuildMaxFps: 12,
      stageBuildSound: true,
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
      sessionsCollapsed: state.sessionsCollapsed,
      presetsCollapsed: state.presetsCollapsed,
      rollCollapsed: state.rollCollapsed,
      keysCollapsed: state.keysCollapsed,
      noteSamplesExpanded: state.noteSamplesExpanded,
      stageSettingsTab: normalizeStageSettingsTab(state.stageSettingsTab),
      stageGridMode: state.stageGridMode,
      stageTileScale: state.stageTileScale,
      stageSpecScale: state.stageSpecScale,
      stageFadeInSec: state.stageFadeInSec,
      stageFadeSec: state.stageFadeSec,
      stageMinDisplaySec: clampStageMinDisplaySec(state.stageMinDisplaySec),
      stageMaxDisplaySec: clampStageMaxDisplaySec(state.stageMaxDisplaySec),
      stageShowVideo: state.stageShowVideo,
      stageVideoPosition: normalizeStageVideoPosition(state.stageVideoPosition),
      stageVideoWidthPct: clampStageVideoWidthPct(state.stageVideoWidthPct),
      stageVideoHeightPct: clampStageVideoHeightPct(state.stageVideoHeightPct),
      stageVideoCropX: clampStageVideoCropX(state.stageVideoCropX),
      stageVideoCropY: clampStageVideoCropY(state.stageVideoCropY),
      stageVideoZoom: clampStageVideoZoom(state.stageVideoZoom),
      stageVideoBrightness: clampStageVideoBrightness(state.stageVideoBrightness),
      stageBuildRampUp: normalizeBuildRampUp(state.stageBuildRampUp),
      stageBuildFullSec: clampBuildFullSec(state.stageBuildFullSec),
      stageBuildMaxFps: clampBuildMaxFps(state.stageBuildMaxFps),
      stageBuildSound: normalizeBuildSound(state.stageBuildSound),
      velocitySensitive: Boolean(state.velocitySensitive),
      midiTransposeOctaves: clampMidiTransposeOctaves(midiPlayer.transposeOctaves),
      hasCustomKeyboardOctave: state.hasCustomKeyboardOctave,
      baseOctaveMidi: state.baseOctaveMidi,
      qwertyOctaveMidi: state.qwertyOctaveMidi
    };
    const storageKey = state.isLiteMode ? LITE_PREFS_STORAGE_KEY : PREFS_STORAGE_KEY;
    window.localStorage.setItem(storageKey, JSON.stringify(payload));
  } catch {}
  syncStageConfigToServer();
  syncLiteResetButtonUI();
  if (!state.isLiteMode && typeof updatePresetDockUi === 'function') {
    updatePresetDockUi();
  }
}

function hasLiteUserCustomizations() {
  if (!state.isLiteMode || !state.catalog) return false;
  if (state.disabledVideoIds.size > 0) return true;
  if (state.soloVideoIds.size > 0) return true;
  for (const val of Object.values(state.sliceToggleOverrides || {})) {
    if (val === false) return true;
  }
  if (
    normalizeStageGridMode(state.stageGridMode) !==
    normalizeStageGridMode(state.defaultCatalogGridMode)
  ) {
    return true;
  }
  return false;
}

function syncLiteResetButtonUI() {
  if (!state.isLiteMode) return;
  const btn = document.getElementById('liteResetMutesBtn');
  if (!btn) return;
  btn.disabled = !hasLiteUserCustomizations();
}

function resetLiteUserCustomizations() {
  if (!state.isLiteMode || !state.catalog) return;
  state.disabledVideoIds.clear();
  state.soloGroupKey = null;
  state.soloVideoIds.clear();
  state.sliceToggleOverrides = {};

  for (const v of state.catalog.videos || []) {
    if (!v.deleted) v.enabled = true;
  }
  if (state.catalog.keyboardMap) {
    for (const entry of Object.values(state.catalog.keyboardMap)) {
      for (const c of entry.candidates || []) {
        c.enabled = true;
      }
      entry.enabledSliceIds = (entry.candidates || []).map(c => c.sliceId);
      entry.enabledCount = entry.enabledSliceIds.length;
      entry.primary = (entry.candidates || [])[0] || null;
      entry.activeSliceId = entry.primary ? entry.primary.sliceId : null;
      entry.isCleared = entry.enabledCount === 0;
    }
  }

  state.stageGridMode = normalizeStageGridMode(state.defaultCatalogGridMode);
  savePrefsToStorage();
  refreshAllUI();
}

function resolveEffectiveVelocity(rawVelocity = DEFAULT_UNIFORM_VELOCITY) {
  if (!state.velocitySensitive) return DEFAULT_UNIFORM_VELOCITY;
  return Math.max(0.02, Math.min(1, Number(rawVelocity ?? DEFAULT_UNIFORM_VELOCITY)));
}

function syncVelocityToggleUI() {
  const btn = document.getElementById('velocityToggleBtn');
  if (!btn) return;
  const isOn = Boolean(state.velocitySensitive);
  btn.classList.toggle('is-active', isOn);
  btn.setAttribute('aria-pressed', isOn ? 'true' : 'false');
  btn.title = isOn
    ? 'MIDI velocity sensitivity ON — click to ignore MIDI velocity and use fixed uniform velocity'
    : 'MIDI velocity sensitivity OFF (fixed uniform velocity) — click to enable dynamic velocity';
}

function isVideoMutedUnderlying(videoId) {
  return Boolean(videoId && state.disabledVideoIds.has(videoId));
}

function isVideoDisabled(videoId) {
  if (!videoId) return false;
  if (state.soloVideoIds.size > 0) {
    return !state.soloVideoIds.has(videoId);
  }
  return state.disabledVideoIds.has(videoId);
}

function setInstrumentSolo(groupKey = null, videoIds = []) {
  if (!groupKey || !Array.isArray(videoIds) || videoIds.length === 0) {
    if (state.soloVideoIds.size === 0 && !state.soloGroupKey) return;
    state.soloGroupKey = null;
    state.soloVideoIds.clear();
    refreshAllUI();
    return;
  }
  state.soloGroupKey = String(groupKey);
  state.soloVideoIds = new Set(videoIds.map(String));
  for (const [trigId, voice] of Array.from(activeVoices.entries())) {
    if (voice.slice?.videoId && !state.soloVideoIds.has(voice.slice.videoId)) {
      releaseHeldVoice(trigId, 0.08);
    }
  }
  refreshAllUI();
}

function toggleInstrumentSolo(groupKey, videoIds) {
  if (state.soloGroupKey && state.soloGroupKey === groupKey) {
    setInstrumentSolo(null, []);
  } else {
    setInstrumentSolo(groupKey, videoIds);
  }
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

function getNoteColor(midi, isPerc = false) {
  if (isPerc) return PERC_NOTE_COLOR;
  const pc = ((midi % 12) + 12) % 12;
  return CHROMATIC_COLORS[pc];
}

function isKeyPercussionOnly(midi) {
  const cands = getVisibleCandidatesForMidi(midi);
  return cands.length > 0 && cands.every(c => Boolean(c.isPerc));
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
  return bustedUrl;
}

// ============================================================================
// Three.js 3D Stage + Configurable Foreground Grid (3×1, 2×2, 3×2, 3×3) + Fade-Out
// ============================================================================
const MAX_STAGE_SLOTS = 9;

// Blade expanded spectrogram covers full A0..C8 (26..4800 Hz); flush stage mini-spectrograms crop < 130 Hz rumble
const SPEC_MIN_FREQ = 26;
const SPEC_MAX_FREQ = 4800;
const MINI_SPEC_MIN_FREQ = 130;
const MINI_SPEC_MAX_FREQ = 2800; // Tighter upper bound on flush stage spectrograms so harmonics hug the video edge
const SPEC_WARP_HZ = 160;
const SPEC_WARP_MIN = Math.log(1 + SPEC_MIN_FREQ / SPEC_WARP_HZ);
const SPEC_WARP_MAX = Math.log(1 + SPEC_MAX_FREQ / SPEC_WARP_HZ);
const MINI_WARP_MIN = Math.log(1 + MINI_SPEC_MIN_FREQ / SPEC_WARP_HZ);
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
  const f = Math.max(MINI_SPEC_MIN_FREQ, Math.min(MINI_SPEC_MAX_FREQ, freq));
  return (Math.log(1 + f / SPEC_WARP_HZ) - MINI_WARP_MIN) / (MINI_WARP_MAX - MINI_WARP_MIN);
}

function miniSpecNormYToFreq(normY) {
  const u = Math.max(0, Math.min(1, normY));
  return SPEC_WARP_HZ * (Math.exp(MINI_WARP_MIN + u * (MINI_WARP_MAX - MINI_WARP_MIN)) - 1);
}

let stageSlotSeq = 0;
let currentStageTileSize = 260;
let currentMiniSpecH = 80;
let currentBuildTileSize = 360;
let currentBuildSpecH = 112;
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
    trimIn: 0,
    trimOut: MAX_CLIP_DUR,
    hasTrimOutCap: false,
    canPaintVideoFrame: false,
    hasPaintedVideoFrame: false,
    firstFrameMs: null,
    fadeOutStartMs: null,
    fadeOutFromAlpha: 0,
    fadeOutDurMs: 0,
    needsCanvasResizeRedraw: false,
    lastDrawnStripeAlpha: -1,
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
  const minSec = clampStageMinDisplaySec(state.stageMinDisplaySec);
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

  const minSlider = document.getElementById('stageMinDisplaySlider');
  if (minSlider && document.activeElement !== minSlider) {
    minSlider.value = minSec.toFixed(1);
  }
  const minReadout = document.getElementById('stageMinDisplayReadout');
  if (minReadout) {
    minReadout.textContent = formatMinDisplayReadout(minSec);
  }

  const maxSlider = document.getElementById('stageMaxDisplaySlider');
  if (maxSlider && document.activeElement !== maxSlider) {
    maxSlider.value = maxSec.toFixed(1);
  }
  const maxReadout = document.getElementById('stageMaxDisplayReadout');
  if (maxReadout) {
    maxReadout.textContent = `${maxSec.toFixed(1)}s`;
  }

  const activeTab = normalizeStageSettingsTab(state.stageSettingsTab);
  document.querySelectorAll('.stage-cfg-tab[data-cfg-tab]').forEach(tabBtn => {
    const isAct = tabBtn.dataset.cfgTab === activeTab;
    tabBtn.classList.toggle('is-active', isAct);
    tabBtn.setAttribute('aria-selected', isAct ? 'true' : 'false');
  });
  document.querySelectorAll('.stage-cfg-panel[data-cfg-panel]').forEach(panelEl => {
    panelEl.classList.toggle('hidden', panelEl.dataset.cfgPanel !== activeTab);
  });

  const showVideo = Boolean(state.stageShowVideo);
  const vidPos = normalizeStageVideoPosition(state.stageVideoPosition);
  const vidWidthPct = clampStageVideoWidthPct(state.stageVideoWidthPct);
  const vidHeightPct = clampStageVideoHeightPct(state.stageVideoHeightPct);
  const cropX = clampStageVideoCropX(state.stageVideoCropX);
  const cropY = clampStageVideoCropY(state.stageVideoCropY);
  const vidZoom = clampStageVideoZoom(state.stageVideoZoom);
  const vidZoomPct = Math.round(vidZoom * 100);
  const vidBright = clampStageVideoBrightness(state.stageVideoBrightness);
  const vidBrightPct = Math.round(vidBright * 100);
  const showVideoToggle = document.getElementById('stageShowVideoToggle');
  if (showVideoToggle) {
    showVideoToggle.checked = showVideo;
  }
  const showVideoReadout = document.getElementById('stageShowVideoReadout');
  if (showVideoReadout) {
    showVideoReadout.textContent = showVideo ? 'On' : 'Off';
  }
  const videoPositionRow = document.getElementById('stageVideoPositionRow');
  if (videoPositionRow) {
    videoPositionRow.classList.toggle('hidden', !showVideo);
  }
  document.querySelectorAll('.stage-grid-pill[data-video-pos]').forEach(btn => {
    const isAct = btn.dataset.videoPos === vidPos;
    btn.classList.toggle('is-active', isAct);
    btn.setAttribute('aria-pressed', isAct ? 'true' : 'false');
  });
  const videoWidthRow = document.getElementById('stageVideoWidthRow');
  if (videoWidthRow) {
    videoWidthRow.classList.toggle('hidden', !showVideo || vidPos === 'below');
  }
  const videoWidthSlider = document.getElementById('stageVideoWidthSlider');
  if (videoWidthSlider && document.activeElement !== videoWidthSlider) {
    videoWidthSlider.value = String(vidWidthPct);
  }
  const videoWidthReadout = document.getElementById('stageVideoWidthReadout');
  if (videoWidthReadout) {
    videoWidthReadout.textContent = `${vidWidthPct}%`;
  }
  const videoHeightRow = document.getElementById('stageVideoHeightRow');
  if (videoHeightRow) {
    videoHeightRow.classList.toggle('hidden', !showVideo || vidPos !== 'below');
  }
  const videoHeightSlider = document.getElementById('stageVideoHeightSlider');
  if (videoHeightSlider && document.activeElement !== videoHeightSlider) {
    videoHeightSlider.value = String(vidHeightPct);
  }
  const videoHeightReadout = document.getElementById('stageVideoHeightReadout');
  if (videoHeightReadout) {
    videoHeightReadout.textContent = `${vidHeightPct}%`;
  }
  const videoBrightnessRow = document.getElementById('stageVideoBrightnessRow');
  if (videoBrightnessRow) {
    videoBrightnessRow.classList.toggle('hidden', !showVideo);
  }
  const videoBrightnessSlider = document.getElementById('stageVideoBrightnessSlider');
  if (videoBrightnessSlider && document.activeElement !== videoBrightnessSlider) {
    videoBrightnessSlider.value = String(vidBrightPct);
  }
  const videoBrightnessReadout = document.getElementById('stageVideoBrightnessReadout');
  if (videoBrightnessReadout) {
    videoBrightnessReadout.textContent = `${vidBrightPct}%`;
  }
  const videoZoomRow = document.getElementById('stageVideoZoomRow');
  if (videoZoomRow) {
    videoZoomRow.classList.toggle('hidden', !showVideo);
  }
  const videoZoomSlider = document.getElementById('stageVideoZoomSlider');
  if (videoZoomSlider && document.activeElement !== videoZoomSlider) {
    videoZoomSlider.value = String(vidZoomPct);
  }
  const videoZoomReadout = document.getElementById('stageVideoZoomReadout');
  if (videoZoomReadout) {
    videoZoomReadout.textContent = `${vidZoomPct}%`;
  }
  const videoPanXRow = document.getElementById('stageVideoPanXRow');
  if (videoPanXRow) {
    videoPanXRow.classList.toggle('hidden', !showVideo);
  }
  const videoPanXSlider = document.getElementById('stageVideoPanXSlider');
  if (videoPanXSlider && document.activeElement !== videoPanXSlider) {
    videoPanXSlider.value = String(cropX);
  }
  const videoPanXReadout = document.getElementById('stageVideoPanXReadout');
  if (videoPanXReadout) {
    videoPanXReadout.textContent = `${cropX}%`;
  }
  const videoPosSliderRow = document.getElementById('stageVideoPosSliderRow');
  if (videoPosSliderRow) {
    videoPosSliderRow.classList.toggle('hidden', !showVideo);
  }
  const videoPosSlider = document.getElementById('stageVideoPosSlider');
  if (videoPosSlider && document.activeElement !== videoPosSlider) {
    videoPosSlider.value = String(cropY);
  }
  const videoPosReadout = document.getElementById('stageVideoPosReadout');
  if (videoPosReadout) {
    videoPosReadout.textContent = `${cropY}%`;
  }
  applyHandVideoFramingStyles();

  const buildRampUp = normalizeBuildRampUp(state.stageBuildRampUp);
  const buildSound = normalizeBuildSound(state.stageBuildSound);
  const buildFullSec = clampBuildFullSec(state.stageBuildFullSec);
  const buildMaxFps = clampBuildMaxFps(state.stageBuildMaxFps);

  const buildRampUpToggle = document.getElementById('stageBuildRampUpToggle');
  if (buildRampUpToggle) {
    buildRampUpToggle.checked = buildRampUp;
  }
  const buildRampUpReadout = document.getElementById('stageBuildRampUpReadout');
  if (buildRampUpReadout) {
    buildRampUpReadout.textContent = buildRampUp ? 'On' : 'Off';
  }
  document.querySelectorAll('.stage-grid-pill[data-build-sound]').forEach(btn => {
    const isOn = btn.dataset.buildSound === 'on' ? buildSound : !buildSound;
    btn.classList.toggle('is-active', isOn);
    btn.setAttribute('aria-pressed', isOn ? 'true' : 'false');
  });

  const buildDurSlider = document.getElementById('stageBuildDurationSlider');
  if (buildDurSlider && document.activeElement !== buildDurSlider) {
    buildDurSlider.value = buildFullSec.toFixed(1);
  }
  const buildDurReadout = document.getElementById('stageBuildDurationReadout');
  if (buildDurReadout) {
    buildDurReadout.textContent = `${buildFullSec.toFixed(1)}s`;
  }
  const buildMaxFpsSlider = document.getElementById('stageBuildMaxFpsSlider');
  if (buildMaxFpsSlider && document.activeElement !== buildMaxFpsSlider) {
    buildMaxFpsSlider.value = String(buildMaxFps);
  }
  const buildMaxFpsReadout = document.getElementById('stageBuildMaxFpsReadout');
  if (buildMaxFpsReadout) {
    buildMaxFpsReadout.textContent = `${buildMaxFps} fps`;
  }
  syncBuildPreviewButtonUI();

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
  if (voice.visualTimedOut) return;
  voice.visualTimedOut = true;

  let actualVisualFadeSec = clampStageFadeSec(state.stageFadeSec);
  if (voice.tileObj) {
    const tileToFade = voice.tileObj;
    voice.tileObj = null;
    actualVisualFadeSec = fadeOutStageTile(tileToFade);
  } else {
    threeStage?.notifyActivity();
  }
  startVoiceAudioFadeOut(voice, actualVisualFadeSec);
}

function scheduleVoiceVisualDisplayTimer(voice) {
  if (!voice) return;
  if (voice.maxDisplayTimer) {
    clearTimeout(voice.maxDisplayTimer);
    voice.maxDisplayTimer = null;
  }
  if (voice.visualTimedOut) {
    return;
  }
  const minSec = clampStageMinDisplaySec(state.stageMinDisplaySec);
  const maxSec = Math.max(minSec, clampStageMaxDisplaySec(state.stageMaxDisplaySec));
  const nowPerfMs = performance.now();
  const startPerfMs = voice.visualStartPerfMs ?? nowPerfMs;
  const maxCutoffMs = startPerfMs + maxSec * 1000;
  const targetFadeMs = voice.released
    ? Math.min(maxCutoffMs, Math.max(voice.releasedPerfMs ?? nowPerfMs, startPerfMs + minSec * 1000))
    : maxCutoffMs;
  const remainMs = Math.round(targetFadeMs - nowPerfMs);
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
  for (let i = 0; i < MAX_STAGE_SLOTS; i++) {
    const slotVoice = stageSlots[i]?.voice;
    if (slotVoice) {
      scheduleVoiceVisualDisplayTimer(slotVoice);
    }
  }
  for (const voice of activeVoices.values()) {
    scheduleVoiceVisualDisplayTimer(voice);
  }
}

function setStageMinDisplaySec(nextSec, persist = true) {
  state.stageMinDisplaySec = clampStageMinDisplaySec(nextSec);
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

function applyHandVideoFramingStyles() {
  const handVideoEl = document.getElementById('stageHandVideo');
  if (!handVideoEl) return;
  const cropX = clampStageVideoCropX(state.stageVideoCropX);
  const cropY = clampStageVideoCropY(state.stageVideoCropY);
  const zoom = clampStageVideoZoom(state.stageVideoZoom);
  const vidBright = clampStageVideoBrightness(state.stageVideoBrightness);
  handVideoEl.style.width = `${(zoom * 100).toFixed(2)}%`;
  handVideoEl.style.height = `${(zoom * 100).toFixed(2)}%`;
  handVideoEl.style.left = `${((1 - zoom) * cropX).toFixed(3)}%`;
  handVideoEl.style.top = `${((1 - zoom) * cropY).toFixed(3)}%`;
  handVideoEl.style.objectPosition = `${cropX}% ${cropY}%`;
  handVideoEl.style.filter = `grayscale(1) contrast(1.06) brightness(${vidBright.toFixed(2)})`;
}

function setStageSettingsTab(nextTab, persist = true) {
  state.stageSettingsTab = normalizeStageSettingsTab(nextTab);
  syncStageConfigUI();
  if (persist) savePrefsToStorage();
}

function setStageShowVideo(enabled, persist = true) {
  state.stageShowVideo = Boolean(enabled);
  syncStageConfigUI();
  syncHandVideoDisplay();
  updateStageTileSizes();
  if (persist) savePrefsToStorage();
}

function setStageVideoPosition(nextPos, persist = true) {
  state.stageVideoPosition = normalizeStageVideoPosition(nextPos);
  syncStageConfigUI();
  updateStageTileSizes();
  if (persist) savePrefsToStorage();
}

function setStageVideoWidthPct(nextPct, persist = true) {
  state.stageVideoWidthPct = clampStageVideoWidthPct(nextPct);
  syncStageConfigUI();
  updateStageTileSizes();
  if (persist) savePrefsToStorage();
}

function setStageVideoHeightPct(nextPct, persist = true) {
  state.stageVideoHeightPct = clampStageVideoHeightPct(nextPct);
  syncStageConfigUI();
  updateStageTileSizes();
  if (persist) savePrefsToStorage();
}

function setStageVideoCropX(nextPct, persist = true) {
  state.stageVideoCropX = clampStageVideoCropX(nextPct);
  syncStageConfigUI();
  if (persist) savePrefsToStorage();
}

function setStageVideoCropY(nextPct, persist = true) {
  state.stageVideoCropY = clampStageVideoCropY(nextPct);
  syncStageConfigUI();
  if (persist) savePrefsToStorage();
}

function setStageVideoZoom(nextZoom, persist = true) {
  state.stageVideoZoom = clampStageVideoZoom(nextZoom);
  syncStageConfigUI();
  if (persist) savePrefsToStorage();
}

function setStageVideoBrightness(nextVal, persist = true) {
  state.stageVideoBrightness = clampStageVideoBrightness(nextVal);
  syncStageConfigUI();
  if (persist) savePrefsToStorage();
}

function setStageBuildRampUp(enabled, persist = true) {
  const norm = normalizeBuildRampUp(enabled);
  if (state.stageBuildRampUp === norm) return;
  if (buildPreviewState.running) {
    stopIntroBuildPreview();
  }
  state.stageBuildRampUp = norm;
  syncStageConfigUI();
  if (persist) savePrefsToStorage();
}

function setStageBuildSound(nextSound, persist = true) {
  const norm = normalizeBuildSound(nextSound);
  state.stageBuildSound = norm;
  if (!norm && buildPreviewState.running && audioCtx) {
    const now = audioCtx.currentTime;
    for (const node of buildPreviewState.audioNodes) {
      try {
        if (node.gainNode) {
          node.gainNode.gain.cancelScheduledValues(now);
          node.gainNode.gain.setValueAtTime(0.0001, now);
        }
        if (node.src) node.src.stop(now + 0.01);
      } catch {}
    }
    buildPreviewState.audioNodes = [];
  }
  syncStageConfigUI();
  if (persist) savePrefsToStorage();
}

function setStageBuildDurationSec(nextSec, persist = true) {
  state.stageBuildFullSec = clampBuildFullSec(nextSec);
  syncStageConfigUI();
  if (persist) savePrefsToStorage();
}

function setStageBuildMaxFps(nextFps, persist = true) {
  state.stageBuildMaxFps = clampBuildMaxFps(nextFps);
  syncStageConfigUI();
  if (persist) savePrefsToStorage();
}

// ============================================================================
// Intro Build Animation Simulator (Live Preview in Browser matching Offline Render)
// ============================================================================
let buildPreviewSeq = 0;
const buildPreviewState = {
  running: false,
  token: 0,
  rafId: null,
  plan: null,
  startCtxTime: 0,
  scheduledUpToIdx: 0,
  visibleCount: 0,
  showcaseIdx: 0,
  drawnThumbStepIdx: -1,
  activeVidSlotIdx: -1,
  audioNodes: [],
  vidPool: []
};

function computeCurrentIntroBuildPlan() {
  const rawItems = threeStage?.getItems?.() || [];
  if (!rawItems.length) {
    return {
      rampUp: normalizeBuildRampUp(state.stageBuildRampUp),
      buildSound: normalizeBuildSound(state.stageBuildSound),
      steps: [],
      showcaseSteps: [],
      tilesCompleteSec: 0,
      handFadeStartSec: null,
      handFadeEndSec: null,
      totalBuildSec: 0
    };
  }
  const enriched = [];
  for (let i = 0; i < rawItems.length; i++) {
    const it = rawItems[i];
    const cand = resolvePlayableSliceById(it.sliceId);
    if (!cand) continue;
    const instName =
      getVideoGroupName(it.videoId || cand.videoId) ||
      inferClientGroupName(it.videoSlug || cand.videoSlug) ||
      '';
    enriched.push({
      ...it,
      groupKey: getSliceInstrumentGroupKey(it),
      instrumentName: instName.trim().toLowerCase(),
      cand
    });
  }
  return planIntroBuild({
    items: enriched,
    fullDurationSec: state.stageBuildFullSec,
    rampUp: state.stageBuildRampUp,
    buildSound: state.stageBuildSound,
    maxFps: state.stageBuildMaxFps,
    hasHandVideo: shouldShowHandVideoStrip() || Boolean(state.isLiteMode),
    getVideoGainDb
  });
}

function syncBuildPreviewButtonUI(progressText = null) {
  const btn = document.getElementById('stageBuildPlayBtn');
  const icon = document.getElementById('stageBuildPlayIcon');
  const label = document.getElementById('stageBuildPlayLabel');
  const meta = document.getElementById('stageBuildPlayMeta');
  if (!btn) return;

  const isPlaying = Boolean(buildPreviewState.running);
  btn.classList.toggle('is-playing', isPlaying);
  if (icon) icon.textContent = isPlaying ? '■' : '▶';
  if (label) label.textContent = isPlaying ? 'Stop build' : 'Play build';
  if (meta) {
    if (progressText !== null) {
      meta.textContent = progressText;
    } else if (!isPlaying) {
      const plan = computeCurrentIntroBuildPlan();
      meta.textContent = plan.totalBuildSec > 0 ? `${plan.totalBuildSec.toFixed(1)}s` : '';
    }
  }
}

function disposeBuildPreviewVidPool() {
  for (const slot of buildPreviewState.vidPool) {
    if (slot?.el) {
      disposeFeederVideo(slot.el);
    }
  }
  buildPreviewState.vidPool = [];
  buildPreviewState.activeVidSlotIdx = -1;
}

function stopIntroBuildPreview() {
  if (!buildPreviewState.running) return;
  buildPreviewState.running = false;
  buildPreviewState.token = ++buildPreviewSeq;
  if (buildPreviewState.rafId !== null) {
    cancelAnimationFrame(buildPreviewState.rafId);
    buildPreviewState.rafId = null;
  }

  const now = audioCtx ? audioCtx.currentTime : 0;
  for (const node of buildPreviewState.audioNodes) {
    try {
      if (node.gainNode && audioCtx) {
        node.gainNode.gain.cancelScheduledValues(now);
        node.gainNode.gain.setValueAtTime(0.0001, now);
      }
      if (node.src) node.src.stop(now + 0.01);
    } catch {}
  }
  buildPreviewState.audioNodes = [];
  disposeBuildPreviewVidPool();

  const showcaseEl = document.getElementById('stageBuildShowcase');
  if (showcaseEl) showcaseEl.classList.add('hidden');
  const freqLabelEl = document.getElementById('stageBuildFreqLabel');
  if (freqLabelEl) freqLabelEl.style.opacity = '0';
  const noteNameEl = document.getElementById('stageBuildNoteName');
  if (noteNameEl) noteNameEl.textContent = '';
  const freqValEl = document.getElementById('stageBuildFreqVal');
  if (freqValEl) freqValEl.textContent = '';
  const instLabelEl = document.getElementById('stageBuildInstLabel');
  if (instLabelEl) instLabelEl.textContent = '';

  const polyGridEl = document.getElementById('polyVideoGrid');
  if (polyGridEl) polyGridEl.classList.remove('hidden');

  const handWrapEl = document.getElementById('stageHandVideoWrap');
  const handVideoEl = document.getElementById('stageHandVideo');
  if (handWrapEl) {
    handWrapEl.style.opacity = '';
    handWrapEl.style.removeProperty('--hand-build-keyline-opacity');
  }
  if (handVideoEl) {
    handVideoEl.style.opacity = '';
  }
  const stagePianoWrapEl = document.getElementById('stagePianoWrap');
  if (stagePianoWrapEl) {
    stagePianoWrapEl.style.opacity = '';
  }
  if (hasSessionHandVideoStrip()) {
    requestHandVideoSeek(midiPlayer.elapsedSec);
  }

  threeStage?.setVisibleCount?.(null);
  syncBuildPreviewButtonUI();
}

function createBuildPoolVideoSlot() {
  const el = document.createElement('video');
  el.muted = true;
  el.playsInline = true;
  el.preload = 'auto';
  el.style.position = 'fixed';
  el.style.left = '-9999px';
  el.style.top = '-9999px';
  el.style.width = '2px';
  el.style.height = '2px';
  el.style.opacity = '0';
  el.style.pointerEvents = 'none';
  document.body.appendChild(el);
  return {
    el,
    stepIdx: -1,
    ready: false,
    playing: false
  };
}

function assignBuildPoolSlotToStep(poolSlot, step) {
  if (!poolSlot || !step?.cand?.videoUrl) return;
  if (poolSlot.stepIdx === step.idx) return;
  poolSlot.stepIdx = step.idx;
  poolSlot.ready = false;
  poolSlot.playing = false;
  const el = poolSlot.el;
  try {
    el.pause();
  } catch {}
  const src = getCachedOrWarmVideoSrc(step.cand.videoUrl);
  el.onloadeddata = () => {
    if (poolSlot.stepIdx !== step.idx) return;
    const tTarget = Math.max(0, Number(step.trimIn) || 0);
    if (tTarget > 0.01) {
      el.onseeked = () => {
        if (poolSlot.stepIdx === step.idx) poolSlot.ready = true;
      };
      try {
        el.currentTime = tTarget;
      } catch {
        poolSlot.ready = true;
      }
    } else {
      poolSlot.ready = true;
    }
  };
  el.src = src;
  el.load();
}

function maintainBuildVideoPool(steps, currentIdx) {
  if (!buildPreviewState.vidPool.length) return;
  // Find up to 2 upcoming longer/cluster-hold steps (or step 0) to pre-decode & pre-seek
  const targets = [];
  for (let i = currentIdx; i < steps.length && targets.length < 2; i++) {
    const st = steps[i];
    if (i === currentIdx || st.durSec >= 0.11 || st.isClusterHold) {
      targets.push(st);
    }
  }
  for (const tgt of targets) {
    if (buildPreviewState.vidPool.some(s => s.stepIdx === tgt.idx)) continue;
    const freeSlot = buildPreviewState.vidPool.find(
      s => s.stepIdx < currentIdx || !targets.some(t => t.idx === s.stepIdx)
    );
    if (freeSlot) {
      assignBuildPoolSlotToStep(freeSlot, tgt);
    }
  }
}

function drawBuildShowcaseFrame(step, elapsedSec) {
  const vidCanvas = document.getElementById('stageBuildVideoCanvas');
  const specCanvas = document.getElementById('stageBuildSpecCanvas');
  const freqLabelEl = document.getElementById('stageBuildFreqLabel');
  const noteDotEl = document.getElementById('stageBuildNoteDot');
  const noteNameEl = document.getElementById('stageBuildNoteName');
  const freqValEl = document.getElementById('stageBuildFreqVal');
  const instLabelEl = document.getElementById('stageBuildInstLabel');
  if (!vidCanvas || !specCanvas || !step) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssSide = currentBuildTileSize;
  const cssSpecH = currentBuildSpecH;
  const targetSide = Math.max(1, Math.round(cssSide * dpr));
  const targetSpecH = Math.max(1, Math.round(cssSpecH * dpr));

  if (vidCanvas.width !== targetSide || vidCanvas.height !== targetSide) {
    vidCanvas.width = targetSide;
    vidCanvas.height = targetSide;
    buildPreviewState.drawnThumbStepIdx = -1;
  }
  if (specCanvas.width !== targetSide || specCanvas.height !== targetSpecH) {
    specCanvas.width = targetSide;
    specCanvas.height = targetSpecH;
  }

  // 1. Draw square video frame (live pre-warmed <video> when ready, instant full-color atlas fallback at t=0ms)
  let drewLiveVideo = false;
  const matchingVidSlot = buildPreviewState.vidPool.find(s => s.stepIdx === step.idx);
  if (matchingVidSlot && matchingVidSlot.el.readyState >= 2 && matchingVidSlot.el.videoWidth > 0) {
    const vid = matchingVidSlot.el;
    if (!matchingVidSlot.playing) {
      matchingVidSlot.playing = true;
      try {
        vid.playbackRate = Math.max(0.25, Math.min(4.0, step.playbackRate || 1.0));
        vid.play().catch(() => {});
      } catch {}
    }
    if (!vid.seeking) {
      const vw = vid.videoWidth;
      const vh = vid.videoHeight;
      const sSide = Math.min(vw, vh);
      const sx = (vw - sSide) * 0.5;
      const sy = (vh - sSide) * 0.5;
      try {
        const vCtx = vidCanvas.getContext('2d');
        vCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        vCtx.imageSmoothingEnabled = true;
        vCtx.drawImage(vid, sx, sy, sSide, sSide, 0, 0, cssSide, cssSide);
        drewLiveVideo = true;
      } catch {}
    }
  }
  if (!drewLiveVideo && buildPreviewState.drawnThumbStepIdx !== step.idx) {
    const vCtx = vidCanvas.getContext('2d');
    vCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    vCtx.fillStyle = '#000000';
    vCtx.fillRect(0, 0, cssSide, cssSide);
    vCtx.imageSmoothingEnabled = true;
    threeStage?.drawAtlasThumb?.(vCtx, step.sliceId, 0, 0, cssSide, cssSide);
    buildPreviewState.drawnThumbStepIdx = step.idx;
  }

  // 2. Draw flush neutral grayscale spectrogram + colored f0 stripe + right-hanging non-bold white Hz label
  const sCtx = specCanvas.getContext('2d');
  sCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sCtx.fillStyle = '#000000';
  sCtx.fillRect(0, 0, cssSide, cssSpecH);

  const bustedAudioUrl = withBust(step.cand?.audioUrl);
  const audioBuf = bustedAudioUrl ? audioBufferCache.get(bustedAudioUrl) : null;
  if (audioBuf) {
    const bSpan = Math.max(
      0.04,
      Math.min(audioBuf.duration - step.trimIn, step.naturalDur * step.playbackRate)
    );
    const cacheKey = `${step.cand.audioUrl}__gray__${step.playbackRate.toFixed(4)}__${step.trimIn.toFixed(2)}__${bSpan.toFixed(2)}`;
    let bmp = miniSpecBitmapCache.get(cacheKey);
    if (!bmp) {
      bmp = buildMiniSpectrogramBitmap(audioBuf, step.playbackRate, step.trimIn, bSpan);
      miniSpecBitmapCache.set(cacheKey, bmp);
    }
    sCtx.imageSmoothingEnabled = true;
    sCtx.drawImage(bmp, 0, 0, cssSide, cssSpecH);
  }

  if (!step.isPerc && step.f0Hz >= 25 && step.f0Hz <= 4500) {
    const keylineWidth = 1.5; // Fixed build spectrogram keyline, independent of song stageSpecScale
    const normY = miniSpecFreqToNormY(step.f0Hz);
    const rawYF0 = Math.max(1.5, Math.min(cssSpecH - 1.5, (1 - normY) * (cssSpecH - 1)));
    const yF0 =
      dpr === 1
        ? keylineWidth < 1.5
          ? Math.floor(rawYF0) + 0.5
          : Math.round(rawYF0)
        : rawYF0;
    const noteHex = getNoteColor(step.midi);
    sCtx.save();
    sCtx.globalAlpha = 0.85;
    sCtx.strokeStyle = noteHex;
    sCtx.lineWidth = keylineWidth;
    sCtx.beginPath();
    sCtx.moveTo(0, yF0);
    sCtx.lineTo(cssSide, yF0);
    sCtx.stroke();
    sCtx.restore();

    if (freqLabelEl) {
      if (noteDotEl) {
        noteDotEl.style.backgroundColor = noteHex;
      }
      if (noteNameEl && noteNameEl.textContent !== (step.noteName || '')) {
        noteNameEl.textContent = step.noteName || '';
      }
      if (freqValEl && freqValEl.textContent !== step.freqText) {
        freqValEl.textContent = step.freqText;
      }
      freqLabelEl.style.top = `${rawYF0.toFixed(1)}px`;
      freqLabelEl.style.opacity = '1';
    }
  } else if (freqLabelEl) {
    freqLabelEl.style.opacity = '0';
  }

  if (instLabelEl) {
    const instTxt = step.instrumentLabel || '';
    if (instLabelEl.textContent !== instTxt) {
      instLabelEl.textContent = instTxt;
    }
    instLabelEl.style.opacity = instTxt ? '1' : '0';
  }
}

let cachedBuildTapBuffer = null;
let cachedBuildTapSr = 0;

function getBuildTapAudioBuffer(ctx) {
  if (!ctx) return null;
  if (cachedBuildTapBuffer && cachedBuildTapSr === ctx.sampleRate) {
    return cachedBuildTapBuffer;
  }
  const pcm = synthesizeBuildTapPcm(ctx.sampleRate);
  const buf = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
  buf.getChannelData(0).set(pcm);
  cachedBuildTapBuffer = buf;
  cachedBuildTapSr = ctx.sampleRate;
  return buf;
}

function scheduleBuildAudioStepsAhead(ctx, nowCtx) {
  const { plan, startCtxTime } = buildPreviewState;
  const audioSteps = plan?.showcaseSteps || plan?.steps || [];
  if (!audioSteps.length) return;
  const elapsed = nowCtx - startCtxTime;
  const horizonSec = elapsed + 0.18;

  // Prune finished audio nodes
  if (buildPreviewState.audioNodes.length > 48) {
    buildPreviewState.audioNodes = buildPreviewState.audioNodes.filter(n => n.endCtx > nowCtx);
  }

  const tapBuffer = state.stageBuildSound ? getBuildTapAudioBuffer(ctx) : null;

  while (
    buildPreviewState.scheduledUpToIdx < audioSteps.length &&
    audioSteps[buildPreviewState.scheduledUpToIdx].startSec <= horizonSec
  ) {
    const step = audioSteps[buildPreviewState.scheduledUpToIdx++];
    if (!state.stageBuildSound) continue;

    const absStart = startCtxTime + step.startSec;
    const startWhen = Math.max(nowCtx, absStart);
    const lateSec = Math.max(0, startWhen - absStart);

    // 1. Gentle playful soft-tap (pitch-modulated subtly by step frequency) synced to showcase frame changes
    if (tapBuffer && lateSec < 0.025) {
      const tapSrc = ctx.createBufferSource();
      tapSrc.buffer = tapBuffer;
      const tRate = Number(step.tapRate) > 0 ? Number(step.tapRate) : 1.0;
      tapSrc.playbackRate.setValueAtTime(tRate, startWhen);
      const tapGainNode = ctx.createGain();
      tapGainNode.gain.setValueAtTime(step.tapGain ?? BUILD_TAP_BASE_GAIN, startWhen);
      tapSrc.connect(tapGainNode);
      tapGainNode.connect(sampleHighpass);
      tapSrc.start(startWhen);
      buildPreviewState.audioNodes.push({
        src: tapSrc,
        gainNode: tapGainNode,
        endCtx: startWhen + tapBuffer.duration / tRate + 0.02
      });
    }

    // 2. Subtle -10.5 dB sample audio texture underneath
    const bustedUrl = withBust(step.cand?.audioUrl);
    const buffer = bustedUrl ? audioBufferCache.get(bustedUrl) : null;
    if (!buffer) continue;

    const absEnd = startCtxTime + step.audioEndSec;
    if (absEnd <= nowCtx + 0.006) continue;

    const offsetInBuf = Math.min(
      Math.max(0, buffer.duration - 0.02),
      step.trimIn + lateSec * step.playbackRate
    );
    const playSpan = Math.max(
      0.02,
      Math.min(buffer.duration - offsetInBuf, (step.audioEndSec - step.startSec - lateSec) * step.playbackRate + 0.015)
    );

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.setValueAtTime(step.playbackRate, startWhen);

    const gainNode = ctx.createGain();
    const pk = step.peakGain;
    const relStartAbs = absStart + step.relStartOffset;
    const relDur = Math.max(0.015, step.relDur);

    gainNode.gain.setValueAtTime(0.0001, startWhen);
    gainNode.gain.linearRampToValueAtTime(pk, Math.max(startWhen + 0.003, absStart + 0.004));
    if (relStartAbs > startWhen + 0.004) {
      gainNode.gain.setValueAtTime(pk, relStartAbs);
    }
    const r0 = Math.max(startWhen + 0.005, relStartAbs);
    gainNode.gain.linearRampToValueAtTime(pk * 0.52, r0 + relDur * 0.38);
    gainNode.gain.linearRampToValueAtTime(pk * 0.16, r0 + relDur * 0.74);
    gainNode.gain.linearRampToValueAtTime(0.0001, r0 + relDur);

    src.connect(gainNode);
    gainNode.connect(sampleHighpass);
    src.start(startWhen, offsetInBuf, playSpan);

    buildPreviewState.audioNodes.push({ src, gainNode, endCtx: r0 + relDur + 0.02 });
  }
}

async function toggleIntroBuildPreview() {
  if (buildPreviewState.running) {
    stopIntroBuildPreview();
    return;
  }

  if (midiPlayer.playing) {
    pauseMidiTransport();
  }
  if (midiRecorder.state === 'armed') {
    cancelMidiRecording();
  }
  for (const tid of Array.from(activeVoices.keys())) {
    releaseHeldVoice(tid, 0.05);
  }
  for (let i = 0; i < MAX_STAGE_SLOTS; i++) {
    if (stageSlots[i]?.occupied) {
      removeStageTile({
        slotIdx: i,
        token: stageSlots[i].token,
        videoEl: stageSlots[i].videoEl
      });
    }
  }

  const ctx = ensureAudioContext();
  const plan = computeCurrentIntroBuildPlan();
  if (!plan.steps.length) return;
  const showcaseSteps = plan.showcaseSteps?.length ? plan.showcaseSteps : plan.steps;

  const myToken = ++buildPreviewSeq;
  buildPreviewState.running = true;
  buildPreviewState.token = myToken;
  buildPreviewState.plan = plan;
  buildPreviewState.scheduledUpToIdx = 0;
  buildPreviewState.visibleCount = 0;
  buildPreviewState.showcaseIdx = 0;
  buildPreviewState.drawnThumbStepIdx = -1;
  buildPreviewState.audioNodes = [];
  disposeBuildPreviewVidPool();
  buildPreviewState.vidPool = [createBuildPoolVideoSlot(), createBuildPoolVideoSlot()];

  const polyGridEl = document.getElementById('polyVideoGrid');
  if (polyGridEl) polyGridEl.classList.add('hidden');
  const handWrapEl = document.getElementById('stageHandVideoWrap');
  const handVideoEl = document.getElementById('stageHandVideo');
  if (hasSessionHandVideoStrip()) {
    pauseSessionHandVideoPlayback();
    requestHandVideoSeek(0);
  }
  if (handWrapEl) {
    handWrapEl.style.opacity = '';
    handWrapEl.style.removeProperty('--hand-build-keyline-opacity');
  }
  if (handVideoEl) {
    // Camera stays OFF (showing solid #080808 stageHandVideoWrap) while tiles build, ramping in over last ~0.2s
    handVideoEl.style.opacity = '0';
  }
  const stagePianoWrapEl = document.getElementById('stagePianoWrap');
  if (state.isLiteMode && stagePianoWrapEl) {
    stagePianoWrapEl.style.opacity = '0';
  }
  const showcaseEl = document.getElementById('stageBuildShowcase');
  if (showcaseEl) {
    showcaseEl.classList.add('hidden');
  }
  threeStage?.setVisibleCount?.(0);
  syncBuildPreviewButtonUI(`0/${plan.steps.length}`);

  maintainBuildVideoPool(showcaseSteps, 0);

  // Warm initial batch of showcase audio buffers (~30-60ms on localhost) for spectrograms + optional sound
  const initialWarmCount = Math.min(32, showcaseSteps.length);
  await Promise.all(
    showcaseSteps.slice(0, initialWarmCount).map(st =>
      st.cand?.audioUrl ? loadAudioBuffer(st.cand.audioUrl).catch(() => null) : Promise.resolve(null)
    )
  );
  if (!buildPreviewState.running || buildPreviewState.token !== myToken) return;

  // Rolling background audio decode + video blob warmer ahead of the showcase playhead
  let prefetchCursor = initialWarmCount;
  const runRollingPrefetch = async () => {
    while (
      buildPreviewState.running &&
      buildPreviewState.token === myToken &&
      prefetchCursor < showcaseSteps.length
    ) {
      if (prefetchCursor > buildPreviewState.showcaseIdx + 64) {
        await new Promise(r => setTimeout(r, 30));
        continue;
      }
      const st = showcaseSteps[prefetchCursor++];
      if (st?.cand?.audioUrl) {
        await loadAudioBuffer(st.cand.audioUrl).catch(() => null);
      }
      if (st && (st.durSec >= 0.11 || st.isClusterHold) && st.cand?.videoUrl) {
        warmVideoBlobUrl(st.cand.videoUrl);
      }
    }
  };
  runRollingPrefetch();
  runRollingPrefetch();
  runRollingPrefetch();
  runRollingPrefetch();

  if (showcaseEl) {
    showcaseEl.classList.remove('hidden');
  }
  buildPreviewState.startCtxTime = ctx.currentTime + 0.03;
  scheduleBuildAudioStepsAhead(ctx, ctx.currentTime);

  const tick = () => {
    if (!buildPreviewState.running || buildPreviewState.token !== myToken) return;
    const nowCtx = ctx.currentTime;
    const elapsed = Math.max(0, nowCtx - buildPreviewState.startCtxTime);
    const steps = plan.steps;

    scheduleBuildAudioStepsAhead(ctx, nowCtx);

    // Advance bottom mosaic popped tiles (hard cut -> chromatic flash -> ~1.0s trail decay to grey)
    let nextVis = buildPreviewState.visibleCount;
    while (nextVis < steps.length && steps[nextVis].endSec <= elapsed) {
      nextVis++;
    }
    if (nextVis > buildPreviewState.visibleCount) {
      const prevVis = buildPreviewState.visibleCount;
      buildPreviewState.visibleCount = nextVis;
      threeStage?.setVisibleCount?.(nextVis);
      threeStage?.pulseTileRange?.(prevVis, nextVis, 36, 1.0);
    }

    if (
      plan.handFadeStartSec !== null &&
      plan.handFadeEndSec !== null &&
      ((shouldShowHandVideoStrip() && handVideoEl) || (state.isLiteMode && stagePianoWrapEl))
    ) {
      let fadeAlpha = '1';
      if (elapsed <= plan.handFadeStartSec) {
        fadeAlpha = '0';
      } else if (elapsed < plan.handFadeEndSec) {
        const u = Math.max(
          0,
          Math.min(
            1,
            (elapsed - plan.handFadeStartSec) /
              Math.max(0.02, plan.handFadeEndSec - plan.handFadeStartSec)
          )
        );
        const smooth = u * u * (3 - 2 * u);
        fadeAlpha = smooth.toFixed(4);
      }
      if (shouldShowHandVideoStrip() && handVideoEl) {
        handVideoEl.style.opacity = fadeAlpha;
      }
      if (state.isLiteMode && stagePianoWrapEl) {
        stagePianoWrapEl.style.opacity = fadeAlpha;
      }
    }

    if (elapsed < plan.tilesCompleteSec) {
      let sIdx = buildPreviewState.showcaseIdx;
      while (sIdx + 1 < showcaseSteps.length && showcaseSteps[sIdx].endSec <= elapsed) {
        sIdx++;
      }
      buildPreviewState.showcaseIdx = sIdx;
      maintainBuildVideoPool(showcaseSteps, sIdx);
      drawBuildShowcaseFrame(showcaseSteps[sIdx], elapsed);
      const dispTileNum = Math.min(steps.length, Math.max(1, buildPreviewState.visibleCount + 1));
      syncBuildPreviewButtonUI(`${dispTileNum}/${steps.length}`);
    } else {
      if (showcaseEl && !showcaseEl.classList.contains('hidden')) {
        showcaseEl.classList.add('hidden');
      }
      syncBuildPreviewButtonUI(`${steps.length}/${steps.length}`);
    }

    if (elapsed >= plan.totalBuildSec) {
      stopIntroBuildPreview();
      return;
    }

    buildPreviewState.rafId = requestAnimationFrame(tick);
  };

  buildPreviewState.rafId = requestAnimationFrame(tick);
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

function solveMosaicFlushPreview(targetW, availH, tileCount, desiredCellPx, gap = 1, minCellPx = 4.5) {
  if (tileCount <= 0) return { cols: 1, rows: 0, cell: desiredCellPx, gridH: 0 };
  if (tileCount <= 3 && tileCount * desiredCellPx + (tileCount - 1) * gap <= targetW) {
    const cell = Math.min(desiredCellPx, availH);
    return { cols: tileCount, rows: 1, cell, gridH: cell };
  }
  const maxCellPx = Math.max(14.0, desiredCellPx * 1.35);
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

function hasSessionHandVideoStrip() {
  return Boolean(
    state.stageShowVideo &&
      midiPlayer.parsed &&
      midiPlayer.hasVideo &&
      midiPlayer.videoUrl
  );
}

function shouldShowHandVideoStrip() {
  if (!state.stageShowVideo) return false;
  if (midiPlayer.parsed) {
    return Boolean(midiPlayer.hasVideo && midiPlayer.videoUrl);
  }
  return Boolean(webcamState.enabled && webcamState.stream);
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
  const rowGap = rows > 1 ? (rows >= 3 ? 16 : 20) : 0;
  const specRatio = getStageSpecRatio(rows, state.stageSpecScale); // Flush spectrogram directly beneath each video

  const hasStagePianoBelow = Boolean(state.isLiteMode);
  const splitHandVideo = hasStagePianoBelow ? true : shouldShowHandVideoStrip();
  const videoPosition = hasStagePianoBelow ? 'below' : normalizeStageVideoPosition(state.stageVideoPosition);
  const isBelowHand = splitHandVideo && videoPosition === 'below';
  const isRightHand = splitHandVideo && !isBelowHand;
  const handWidthPct = clampStageVideoWidthPct(state.stageVideoWidthPct);
  const handHeightPct = clampStageVideoHeightPct(state.stageVideoHeightPct);
  const stagePianoH = hasStagePianoBelow ? Math.max(50, Math.min(70, Math.round(stageH * 0.08))) : 0;
  const splitGap = 1; // Single-pixel 1px divider between hand video / stage keyboard and mosaic cluster
  const activeTiles = threeStage?.getItemCount?.() ?? 439;
  const marginY = Math.max(12, Math.round(stageH * (rows >= 3 ? 0.024 : 0.034)));
  const betweenGap =
    activeTiles > 0 || splitHandVideo
      ? Math.max(22, Math.round(stageH * (rows >= 3 ? 0.022 : 0.028)))
      : 0;

  const padX = Math.max(32, Math.round(stageW * 0.065));
  const availW = Math.max(200, stageW - padX * 2 - gap * (cols - 1));
  const maxCap = rows === 1 ? 388 : cols >= 4 ? 304 : rows === 2 ? 348 : 284;

  // Step 1: Compute natural 100%-baseline main video grid dimensions
  const rawReserveH =
    activeTiles > 0
      ? rows >= 3
        ? 54
        : rows === 2
          ? 64
          : 76
      : isRightHand
        ? 64
        : 0;
  const estStripW = Math.min(availW + gap * (cols - 1), maxCap * cols + gap * (cols - 1));
  const estBelowHandH = isBelowHand
    ? hasStagePianoBelow
      ? stagePianoH
      : Math.min(Math.round(stageH * 0.28), Math.max(36, Math.round(estStripW * (handHeightPct / 100))))
    : 0;
  const baseReserveH = isBelowHand
    ? rawReserveH + (activeTiles > 0 ? splitGap : 0) + estBelowHandH
    : rawReserveH;

  const baseAvailTopH = Math.max(
    140,
    stageH - marginY * 2 - betweenGap - baseReserveH - (rows - 1) * rowGap
  );
  const baseMaxSideByH = Math.floor(baseAvailTopH / (rows * (1 + specRatio)));

  const isPortraitStage = stageH > stageW * 1.12;
  const baseSide = Math.max(68, Math.min(maxCap, Math.floor(Math.min(baseMaxSideByH, availW / cols))));
  const baseStripW = baseSide * cols + gap * (cols - 1);
  const mosaicRefW =
    isBelowHand && !hasStagePianoBelow
      ? isPortraitStage
        ? baseStripW * 0.96
        : baseStripW * 0.54
      : isRightHand
        ? baseStripW * 0.62
        : baseStripW;
  const baseCell100 = Math.min(
    isPortraitStage ? 16.0 : 12.0,
    Math.max(isBelowHand && !hasStagePianoBelow && !isPortraitStage ? 5.6 : 6.2, mosaicRefW / 76)
  );
  const desiredCell = baseCell100 * tileScale;

  // Step 2: Keep main grid size untouched whenever vertical room permits; only yield gentle vertical room
  // if scaling tiles up or split hand-video mode achieves larger flush mosaic squares without overlap.
  let side = baseSide;
  if (activeTiles > 0 && (tileScale > 1.01 || splitHandVideo)) {
    const minAllowedSide = Math.max(68, Math.round(baseSide * (splitHandVideo ? 0.84 : 0.68)));
    let bestAchievedCell = -1;
    for (let s = baseSide; s >= minAllowedSide; s -= 2) {
      const candSpecH = Math.max(14, Math.round(s * specRatio));
      const candStripW = s * cols + gap * (cols - 1);
      const minSideW = Math.min(48, Math.floor((candStripW - splitGap) * 0.45));
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
      const rawAvailMosaicH = stageH - marginY * 2 - betweenGap - candTopH;
      const candBelowHandH = isBelowHand
        ? Math.min(
            hasStagePianoBelow
              ? stagePianoH
              : Math.max(24, Math.round(candStripW * (handHeightPct / 100))),
            Math.max(24, rawAvailMosaicH - splitGap - Math.max(24, Math.min(64, Math.round(rawAvailMosaicH * 0.28))))
          )
        : 0;
      const availMosaicH = isRightHand
        ? Math.min(rawAvailMosaicH, Math.max(32, Math.round(stageH * 0.34)))
        : isBelowHand
          ? rawAvailMosaicH - splitGap - candBelowHandH
          : rawAvailMosaicH;
      if (availMosaicH < (isBelowHand ? 24 : 32)) continue;
      const m = solveMosaicFlushPreview(
        candMosaicW,
        availMosaicH,
        activeTiles,
        desiredCell,
        1,
        splitHandVideo && !hasStagePianoBelow ? 2.5 : 3.2
      );
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
    desiredCell,
    splitHandVideo,
    splitGap,
    videoPosition,
    handWidthPct,
    handHeightPct,
    fixedBelowHeightPx: stagePianoH
  });
  const stripTop = gridLayout?.stackTopY ?? marginY;

  // Responsive Intro Build Showcase sizing: fixed tall spectrogram ratio (ignoring song stageSpecScale),
  // gently sizing down the square video to fit cleanly floating above the camera/mosaic cluster
  const shortStageDim = Math.min(stageW, stageH);
  const buildScaleRef = shortStageDim / 1080;
  const buildSpecRatio = 0.475; // Fixed front-build spectrogram height ratio (~30% taller, independent of song spec setting)
  const clusterOriginY =
    gridLayout?.originY !== undefined ? gridLayout.originY : Math.max(200, stageH - marginY);
  const buildFontPx = Math.max(14, Math.min(23, Math.round(shortStageDim * 0.0193 * 2) / 2));
  const buildDotPx = Math.max(7, Math.round(buildFontPx * 0.56));
  const buildDotGapPx = Math.max(5, Math.round(buildFontPx * 0.42));
  const buildNoteSlotW = Math.max(25, Math.round(buildFontPx * 2.0));
  const buildLabelGapX = Math.max(8, Math.round(buildFontPx * 0.68));
  const buildInstGapY = Math.max(7, Math.round(buildFontPx * 0.60));
  const instLabelReserveH = buildInstGapY + Math.round(buildFontPx * 1.15);

  const targetBuildSideByScreen = Math.min(stageW * 0.50, shortStageDim * 0.395);
  const minVertBreathing = Math.max(
    Math.round(52 * buildScaleRef),
    Math.round(clusterOriginY * 0.20)
  );
  const maxBuildUnitByAbove = Math.max(
    Math.round(110 * buildScaleRef),
    clusterOriginY - minVertBreathing - instLabelReserveH
  );
  const maxBuildSideByAbove = maxBuildUnitByAbove / (1 + buildSpecRatio);
  const rightLabelReserveW = buildLabelGapX + buildDotPx + buildDotGapPx + buildNoteSlotW + Math.round(buildFontPx * 5.6) + 20;
  const maxBuildSideByWidth = Math.max(
    Math.round(110 * buildScaleRef),
    stageW - rightLabelReserveW * 2
  );
  const rawBuildSide = Math.max(
    Math.round(96 * buildScaleRef),
    Math.min(targetBuildSideByScreen, maxBuildSideByAbove, maxBuildSideByWidth)
  );
  const buildSide = Math.max(68, Math.floor(rawBuildSide / 2) * 2);
  const buildSpecH = Math.max(Math.round(18 * buildScaleRef), Math.round(buildSide * buildSpecRatio));
  currentBuildTileSize = buildSide;
  currentBuildSpecH = buildSpecH;

  const totalBuildVisualH = buildSide + buildSpecH + instLabelReserveH;
  const minBuildTop = Math.max(14, Math.round(shortStageDim * 0.025));
  const maxBuildTop = Math.max(
    minBuildTop,
    Math.floor(clusterOriginY - totalBuildVisualH - Math.max(14, Math.round(16 * buildScaleRef)))
  );
  const fgZoneTop = Math.min(stripTop, maxBuildTop);
  const fgZoneBottom = Math.max(fgZoneTop + totalBuildVisualH, clusterOriginY - betweenGap);
  const showcaseTop = Math.max(
    minBuildTop,
    Math.min(maxBuildTop, Math.round(fgZoneTop + (fgZoneBottom - fgZoneTop - totalBuildVisualH) * 0.5))
  );

  stageEl.style.setProperty('--strip-top', `${stripTop}px`);
  stageEl.style.setProperty('--build-tile-size', `${buildSide}px`);
  stageEl.style.setProperty('--build-spec-height', `${buildSpecH}px`);
  stageEl.style.setProperty('--build-showcase-top', `${showcaseTop}px`);
  stageEl.style.setProperty('--build-font-size', `${buildFontPx}px`);
  stageEl.style.setProperty('--build-dot-size', `${buildDotPx}px`);
  stageEl.style.setProperty('--build-dot-gap', `${buildDotGapPx}px`);
  stageEl.style.setProperty('--build-note-slot-w', `${buildNoteSlotW}px`);
  stageEl.style.setProperty('--build-label-gap-x', `${buildLabelGapX}px`);
  stageEl.style.setProperty('--build-inst-gap-y', `${buildInstGapY}px`);

  const handWrapEl = document.getElementById('stageHandVideoWrap');
  const stagePianoWrapEl = document.getElementById('stagePianoWrap');
  if (handWrapEl) {
    if (!hasStagePianoBelow && splitHandVideo && gridLayout?.handRect) {
      handWrapEl.classList.remove('hidden');
      handWrapEl.style.left = `${gridLayout.handRect.x}px`;
      handWrapEl.style.top = `${gridLayout.handRect.y}px`;
      handWrapEl.style.width = `${gridLayout.handRect.w}px`;
      handWrapEl.style.height = `${gridLayout.handRect.h}px`;
      applyHandVideoFramingStyles();
    } else {
      handWrapEl.classList.add('hidden');
    }
  }
  if (stagePianoWrapEl) {
    if (hasStagePianoBelow && gridLayout?.handRect) {
      stagePianoWrapEl.classList.remove('hidden');
      stagePianoWrapEl.style.left = `${gridLayout.handRect.x}px`;
      stagePianoWrapEl.style.top = `${gridLayout.handRect.y}px`;
      stagePianoWrapEl.style.width = `${gridLayout.handRect.w}px`;
      stagePianoWrapEl.style.height = `${gridLayout.handRect.h}px`;
    } else {
      stagePianoWrapEl.classList.add('hidden');
    }
  }

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

const detachedRingingVoices = new Set();

function isTransportTriggerId(triggerId) {
  const s = String(triggerId || '');
  return s.startsWith('midifile_') || s.startsWith('midiscrub_');
}

function hasActiveLivePerformVoice() {
  for (const [tid, v] of activeVoices.entries()) {
    if (!isTransportTriggerId(tid) && !v.audioCompleted) {
      return true;
    }
  }
  return false;
}

function allocateStageSlotIndex(sliceKey, groupKey = '') {
  const slotCount = getActiveStageSlotCount();
  const views = new Array(slotCount);
  for (let i = 0; i < slotCount; i++) {
    const sl = stageSlots[i];
    const sv = sl.voice;
    views[i] = {
      occupied: Boolean(sl.occupied),
      fadingOut: Boolean(sl.occupied && sl.fadingOut),
      audioCompleted: Boolean(sl.occupied && sv?.audioCompleted),
      liveHeld: Boolean(sl.occupied && sv && !sv.released && !isTransportTriggerId(sv.triggerId)),
      seq: sl.seq || 0,
      lastSeq: sl.lastSeq || 0,
      sliceKey: sl.sliceKey || '',
      groupKey: sl.occupied ? getSliceInstrumentGroupKey(sl) : '',
      rememberedGroupKey: getSlotRememberedGroupKey(sl)
    };
  }
  return chooseStageSlot(views, slotCount, { sliceKey, groupKey });
}

function computeLiveVoiceCurrentGain(voice, now) {
  const elapsed = voice.startedAt ? Math.max(0, now - voice.startedAt) : 0;
  const baseVal = computeScheduledVoiceGainAt(voice, elapsed);
  if (voice.audioFadeStarted && voice.releaseStartCtxTime !== null) {
    const dt = Math.max(0, now - voice.releaseStartCtxTime);
    const rel = Math.max(0.02, voice.releaseDur || 0.2);
    const u = Math.max(0, Math.min(1, dt / rel));
    const g0 = voice.fadeStartGainVal ?? baseVal;
    if (u <= 0.35) return g0 * (1 - (u / 0.35) * (1 - 0.56));
    if (u <= 0.72) return g0 * (0.56 - ((u - 0.35) / 0.37) * (0.56 - 0.18));
    return Math.max(0.0001, g0 * 0.18 * (1 - (u - 0.72) / 0.28));
  }
  return baseVal;
}

function displaceStageSlotVoice(prevVoice, isSameClip = false) {
  if (!prevVoice) return;
  if (prevVoice.removeTimer) {
    clearTimeout(prevVoice.removeTimer);
    prevVoice.removeTimer = null;
  }
  prevVoice.tileObj = null;

  // When displaced by a different sample/instrument, detach only the visual tile and let the voice keep ringing!
  if (!isSameClip) {
    if (!prevVoice.audioCompleted) {
      detachedRingingVoices.add(prevVoice);
    }
    threeStage?.notifyActivity();
    return;
  }

  // Re-triggering the exact same sample clip onto itself: fast 16ms crossfade to prevent flanging
  if (prevVoice.maxDisplayTimer) {
    clearTimeout(prevVoice.maxDisplayTimer);
    prevVoice.maxDisplayTimer = null;
  }
  if (prevVoice.naturalTimer) {
    clearTimeout(prevVoice.naturalTimer);
    prevVoice.naturalTimer = null;
  }
  if (prevVoice.gateTimer) {
    clearTimeout(prevVoice.gateTimer);
    prevVoice.gateTimer = null;
  }

  prevVoice.visualTimedOut = true;
  prevVoice.released = true;
  detachedRingingVoices.delete(prevVoice);

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
    const curVal = Math.max(0.0001, computeLiveVoiceCurrentGain(prevVoice, now));
    const remSec =
      prevVoice.audioFadeStarted && prevVoice.releaseStartCtxTime !== null
        ? Math.max(0.016, prevVoice.releaseStartCtxTime + (prevVoice.releaseDur || 0.2) - now)
        : Math.max(0.016, (prevVoice.naturalDur || 1.0) - elapsed);
    const fadeSec = Math.min(0.016, remSec);
    prevVoice.audioFadeStarted = true;
    prevVoice.fadeStartGainVal = curVal;
    prevVoice.releaseStartCtxTime = now;
    prevVoice.releaseDur = fadeSec;
    try {
      prevVoice.gainNode.gain.cancelScheduledValues(now);
      prevVoice.gainNode.gain.setValueAtTime(curVal, now);
      prevVoice.gainNode.gain.linearRampToValueAtTime(0.0001, now + fadeSec);
      prevVoice.src.stop(now + fadeSec + 0.01);
    } catch {}
    prevVoice.naturalTimer = setTimeout(() => {
      prevVoice.naturalTimer = null;
      prevVoice.audioCompleted = true;
      detachedRingingVoices.delete(prevVoice);
    }, Math.max(20, Math.round(fadeSec * 1000)));
  } else {
    prevVoice.audioFadeStarted = true;
    prevVoice.pendingAudioFadeSec = 0.016;
  }
  threeStage?.notifyActivity();
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
    displaceStageSlotVoice(prevSlot.voice, isSameClip);
  }

  disposeFeederVideo(prevSlot.videoEl);
  videoWrap.querySelectorAll('video').forEach(v => disposeFeederVideo(v));
  clearSlotMiniSpec(slotIdx);

  // Strict 1-clip-per-slot: deterministically reset opacity to 0 until first frame is ready
  unitEl.style.opacity = '0';

  const token = Symbol(`slot_${slotIdx}`);
  stageSlotSeq += 1;

  const trimIn = Math.max(0, Number(slice.trimIn ?? 0));
  const rawLimit = Math.min(MAX_CLIP_DUR, Number(slice.rawDurSec ?? slice.durSec ?? MAX_CLIP_DUR));
  const trimOut = Math.max(trimIn + 0.08, Math.min(rawLimit, Number(slice.trimOut ?? rawLimit)));
  const hasTrimOutCap = trimOut < rawLimit - 0.02;
  const needsTrimSeek = trimIn > 0.005;

  const videoEl = document.createElement('video');
  videoEl.className = 'slot-stage-video';
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
    trimIn,
    trimOut,
    hasTrimOutCap,
    canPaintVideoFrame: !needsTrimSeek,
    hasPaintedVideoFrame: false,
    firstFrameMs: null,
    fadeOutStartMs: null,
    fadeOutFromAlpha: 0,
    fadeOutDurMs: 0,
    needsCanvasResizeRedraw: false,
    lastDrawnStripeAlpha: -1,
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

  videoEl.addEventListener('loadeddata', wakeStageLoop, { once: true });
  videoEl.addEventListener('playing', wakeStageLoop, { once: true });
  if (typeof videoEl.requestVideoFrameCallback === 'function') {
    videoEl.requestVideoFrameCallback(() => wakeStageLoop());
  }

  threeStage?.notifyActivity();
  ensureMiniSpecAnimLoop();

  return { slotIdx, token, tile: videoWrap, videoEl };
}

function fadeOutStageTile(tileObj) {
  if (!tileObj || tileObj.slotIdx === undefined) return 0;
  const { slotIdx, token } = tileObj;
  const slotState = stageSlots[slotIdx];
  if (!slotState || slotState.token !== token) return 0;
  if (slotState.fadingOut) return Math.max(0, (slotState.fadeOutDurMs || 0) / 1000);

  const fadeOutSec = clampStageFadeSec(state.stageFadeSec);
  if (fadeOutSec <= 0.002) {
    removeStageTile(tileObj);
    return 0;
  }

  const fadeInSec = clampStageFadeInSec(state.stageFadeInSec);
  const fullFadeMs = Math.max(50, fadeOutSec * 1000);

  if (!slotState.hasPaintedVideoFrame) {
    if (fadeInSec > 0.002) {
      // Released before even starting fade-in above 0: remove silently with zero flash
      removeStageTile(tileObj);
      return 0;
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
      return 0;
    }
    slotState.fadingOut = true;
    slotState.fadeOutFromAlpha = startAlpha;
    slotState.fadeOutStartMs = performance.now();
    slotState.fadeOutDurMs = Math.max(60, fullFadeMs * Math.sqrt(startAlpha));
  }

  threeStage?.notifyActivity();
  ensureMiniSpecAnimLoop();
  return slotState.fadeOutDurMs / 1000;
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
  const minBin = Math.max(1, Math.floor((MINI_SPEC_MIN_FREQ * fftSizeSpec) / effectiveSr));
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

function drawSlotMiniSpecFrame(slotIdx, now, forceRedraw = false) {
  const slot = stageSlots[slotIdx];
  if (!slot?.occupied || !slot.voice || !slot.miniBitmap) return;
  const stripeAlpha = slot.voice.isPerc ? 0 : 1.0;
  if (
    !forceRedraw &&
    !slot.needsCanvasResizeRedraw &&
    slot.lastDrawnStripeAlpha >= 0 &&
    Math.abs(stripeAlpha - slot.lastDrawnStripeAlpha) < 0.004
  ) {
    return;
  }

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

  if (!slot.voice.isPerc) {
    const f0Hz = slot.voice.f0Hz;
    if (stripeAlpha > 0.005 && f0Hz >= 25 && f0Hz <= 4500) {
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
  slot.lastDrawnStripeAlpha = stripeAlpha;
  slot.needsCanvasResizeRedraw = false;
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
  slotState.lastDrawnStripeAlpha = -1;

  if (audioCtx) {
    drawSlotMiniSpecFrame(tileObj.slotIdx, audioCtx.currentTime, true);
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
      if (
        vid &&
        !vid.paused &&
        slot.hasTrimOutCap &&
        Number.isFinite(slot.trimOut) &&
        vid.currentTime >= slot.trimOut - 0.015
      ) {
        try {
          vid.pause();
        } catch {}
      }

      if (
        !slot.hasPaintedVideoFrame &&
        vid &&
        slot.canPaintVideoFrame &&
        vid.readyState >= 2 &&
        vid.videoWidth > 0 &&
        !vid.seeking
      ) {
        slot.hasPaintedVideoFrame = true;
        slot.firstFrameMs = nowPerfMs;
      }

      if (slot.voice && slot.miniBitmap && audioCtx) {
        drawSlotMiniSpecFrame(i, audioNow);
      }

      if (!slot.hasPaintedVideoFrame) {
        applySlotUnitOpacity(i, slot, 0);
        if (nowPerfMs - slot.createdMs > 280) {
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

      const stripeAnimating =
        Boolean(slot.voice && !slot.voice.isPerc && slot.voice.audioFadeStarted && !slot.voice.audioCompleted);
      const waitingOnTrimCap = Boolean(vid && !vid.paused && slot.hasTrimOutCap);
      if (stripeAnimating || waitingOnTrimCap) {
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
  const isPerc =
    slice?.isPerc !== undefined
      ? Boolean(slice.isPerc)
      : isPercussionSlice(state.catalog?.videos?.find(v => v.id === slice?.videoId));
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
    forcedReleaseStartOffset: Math.max(0.012, estPlayDur - Math.min(0.04, estPlayDur * 0.25)),
    forcedReleaseDur: Math.min(0.04, estPlayDur * 0.25),
    f0Hz,
    noteColor: getNoteColor(effMidi, isPerc),
    naturalTimer: null,
    gateTimer: null,
    removeTimer: null,
    maxDisplayTimer: null,
    visualStartPerfMs: performance.now(),
    releasedPerfMs: null,
    visualTimedOut: false,
    audioCompleted: false,
    audioFadeStarted: false,
    pendingAudioFadeSec: null,
    fadeStartGainVal: null,
    released: false,
    releaseStartCtxTime: null,
    releaseDur: clampStageFadeSec(state.stageFadeSec)
  };
  activeVoices.set(triggerId, voice);

  // Claim stage slot synchronously BEFORE async audio decode so simultaneous chord notes
  // always claim slots in deterministic event order across cold and warm runs.
  const tileObj = createStageSquareTile(slice, playbackRate, forcedSlotIdx);
  voice.tileObj = tileObj;
  if (tileObj && stageSlots[tileObj.slotIdx]?.token === tileObj.token) {
    stageSlots[tileObj.slotIdx].voice = voice;
    voice.visualStartPerfMs = stageSlots[tileObj.slotIdx].createdMs;
  }
  scheduleVoiceVisualDisplayTimer(voice);
  threeStage?.notifyActivity();

  try {
    const buffer = await loadAudioBuffer(slice.audioUrl);
    if (isVideoDisabled(slice.videoId)) {
      if (voice.maxDisplayTimer) {
        clearTimeout(voice.maxDisplayTimer);
        voice.maxDisplayTimer = null;
      }
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
    const effVelocity = resolveEffectiveVelocity(velocity);
    const peakGain = Math.min(1.85, 0.86 * effVelocity * Math.pow(10, gainDb / 20));

    const rawLimit = Math.min(MAX_CLIP_DUR, Number(slice.rawDurSec ?? buffer.duration), buffer.duration);
    const trimIn = Math.max(0, Math.min(Math.max(0, rawLimit - 0.08), Number(slice.trimIn ?? 0)));
    const trimOut = Math.max(trimIn + 0.08, Math.min(rawLimit, Number(slice.trimOut ?? rawLimit)));
    const unpitchedSpan = Math.max(0.08, trimOut - trimIn);

    const playDur = Math.min(MAX_CLIP_DUR, unpitchedSpan / playbackRate);
    const bufferPlaySpan = Math.min(buffer.duration - trimIn, playDur * playbackRate);

    const forcedRelDur = Math.min(0.04, playDur * 0.25);
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

    if (voice.pendingAudioFadeSec !== null || voice.visualTimedOut) {
      voice.audioFadeStarted = false;
      startVoiceAudioFadeOut(voice, voice.pendingAudioFadeSec);
      voice.pendingAudioFadeSec = null;
    } else {
      scheduleVoiceVisualDisplayTimer(voice);
      voice.naturalTimer = setTimeout(() => {
        voice.naturalTimer = null;
        detachedRingingVoices.delete(voice);
        if (!voice.audioFadeStarted) {
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

function startVoiceAudioFadeOut(voice, requestedFadeSec = null) {
  if (!voice || voice.audioFadeStarted) return;
  if (voice.naturalTimer) {
    clearTimeout(voice.naturalTimer);
    voice.naturalTimer = null;
  }
  const fadeFloorSec = 0.025;
  const targetSec = Math.max(
    fadeFloorSec,
    requestedFadeSec !== null && Number.isFinite(requestedFadeSec)
      ? requestedFadeSec
      : clampStageFadeSec(state.stageFadeSec)
  );
  if (!audioCtx || !voice.gainNode || !voice.src) {
    voice.pendingAudioFadeSec = targetSec;
    return;
  }

  const now = audioCtx.currentTime;
  if (
    voice.audioCompleted ||
    (voice.startedAt && voice.naturalDur && now - voice.startedAt >= voice.naturalDur)
  ) {
    voice.audioCompleted = true;
    voice.audioFadeStarted = true;
    voice.releaseStartCtxTime = now;
    voice.releaseDur = fadeFloorSec;
    return;
  }

  voice.audioFadeStarted = true;
  const elapsed = voice.startedAt ? Math.max(0, now - voice.startedAt) : 0;
  const remainingNatural = voice.naturalDur ? Math.max(0.02, voice.naturalDur - elapsed) : targetSec;
  const rel = Math.min(targetSec, remainingNatural);

  const curVal = Math.max(0.0001, computeScheduledVoiceGainAt(voice, elapsed));
  voice.fadeStartGainVal = curVal;
  voice.releaseStartCtxTime = now;
  voice.releaseDur = rel;

  const g = voice.gainNode.gain;
  try {
    g.cancelScheduledValues(now);
    g.setValueAtTime(curVal, now);
    g.linearRampToValueAtTime(curVal * 0.56, now + rel * 0.35);
    g.linearRampToValueAtTime(curVal * 0.18, now + rel * 0.72);
    g.linearRampToValueAtTime(0.0001, now + rel);
    voice.src.stop(now + rel + 0.015);
  } catch {}

  voice.naturalTimer = setTimeout(() => {
    voice.naturalTimer = null;
    voice.audioCompleted = true;
    detachedRingingVoices.delete(voice);
    if (voice.tileObj && audioCtx) {
      drawSlotMiniSpecFrame(voice.tileObj.slotIdx, audioCtx.currentTime, true);
    }
  }, Math.max(25, Math.round(rel * 1000)));
  ensureMiniSpecAnimLoop();
}

function applyVoiceReleaseRamp(voice, customReleaseSec = null) {
  if (voice.gateTimer) {
    clearTimeout(voice.gateTimer);
    voice.gateTimer = null;
  }
  if (voice.removeTimer) {
    clearTimeout(voice.removeTimer);
    voice.removeTimer = null;
  }

  if (!voice.released) {
    voice.released = true;
    voice.releasedPerfMs = performance.now();
  } else if (!voice.releasedPerfMs) {
    voice.releasedPerfMs = performance.now();
  }

  // Explicit quick-stop / pause / retrigger override: ramp audio & visual out immediately
  if (customReleaseSec !== null && Number.isFinite(customReleaseSec)) {
    if (voice.maxDisplayTimer) {
      clearTimeout(voice.maxDisplayTimer);
      voice.maxDisplayTimer = null;
    }
    voice.visualTimedOut = true;
    if (voice.tileObj) {
      const tileToStop = voice.tileObj;
      voice.tileObj = null;
      if (customReleaseSec <= 0.08) {
        removeStageTile(tileToStop);
      } else {
        fadeOutStageTile(tileToStop);
      }
    }
    startVoiceAudioFadeOut(voice, customReleaseSec);
    return;
  }

  // Normal musical note-off: sustain audio + video together up to Min/Max display, then fade together!
  scheduleVoiceVisualDisplayTimer(voice);
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

  if (showHarmonics && f0Hz >= 25 && f0Hz <= SPEC_MAX_FREQ) {
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

function setSessionsCollapsed(nextCollapsed) {
  state.sessionsCollapsed = Boolean(nextCollapsed);
  if (state.sessionsCollapsed && typeof closeMidiBrowserPopover === 'function') {
    closeMidiBrowserPopover();
  }
  if (state.sessionsCollapsed && !browserExportState.rendering && typeof closeMidiExportPopover === 'function') {
    closeMidiExportPopover();
  }
  const zoneEl = document.getElementById('midiTransportZone');
  const btnEl = document.getElementById('sessionsCollapseBtn');
  if (zoneEl) zoneEl.classList.toggle('is-collapsed', state.sessionsCollapsed);
  if (btnEl) btnEl.setAttribute('aria-expanded', state.sessionsCollapsed ? 'false' : 'true');
  savePrefsToStorage();
  requestAnimationFrame(() => {
    if (!state.keysCollapsed) renderPianoKeyboard();
    drawMidiRollCanvas();
  });
  setTimeout(() => {
    if (!state.keysCollapsed) renderPianoKeyboard();
    drawMidiRollCanvas();
  }, 200);
}

function setPresetsCollapsed(nextCollapsed) {
  state.presetsCollapsed = Boolean(nextCollapsed);
  if (state.presetsCollapsed && typeof closePresetPopover === 'function') {
    closePresetPopover();
  }
  const zoneEl = document.getElementById('presetZone');
  const btnEl = document.getElementById('presetsCollapseBtn');
  if (zoneEl) zoneEl.classList.toggle('is-collapsed', state.presetsCollapsed);
  if (btnEl) btnEl.setAttribute('aria-expanded', state.presetsCollapsed ? 'false' : 'true');
  savePrefsToStorage();
  requestAnimationFrame(() => {
    if (!state.keysCollapsed) renderPianoKeyboard();
    drawMidiRollCanvas();
  });
  setTimeout(() => {
    if (!state.keysCollapsed) renderPianoKeyboard();
    drawMidiRollCanvas();
  }, 200);
}

function setRollCollapsed(nextCollapsed) {
  state.rollCollapsed = Boolean(nextCollapsed);
  const zoneEl = document.getElementById('midiRollZone');
  const btnEl = document.getElementById('rollCollapseBtn');
  if (zoneEl) zoneEl.classList.toggle('is-collapsed', state.rollCollapsed);
  if (btnEl) btnEl.setAttribute('aria-expanded', state.rollCollapsed ? 'false' : 'true');
  savePrefsToStorage();
  updateMidiTransportUi();
  requestAnimationFrame(() => {
    if (!state.keysCollapsed) renderPianoKeyboard();
    drawMidiRollCanvas();
  });
  setTimeout(() => {
    if (!state.keysCollapsed) renderPianoKeyboard();
    drawMidiRollCanvas();
  }, 200);
}

function setKeysCollapsed(nextCollapsed) {
  state.keysCollapsed = Boolean(nextCollapsed);
  if (state.keysCollapsed && state.noteSamplesExpanded && typeof setNoteSamplesExpanded === 'function') {
    setNoteSamplesExpanded(false);
  }
  const zoneEl = document.getElementById('keysDockZone');
  const btnEl = document.getElementById('keysCollapseBtn');
  if (zoneEl) zoneEl.classList.toggle('is-collapsed', state.keysCollapsed);
  if (btnEl) btnEl.setAttribute('aria-expanded', state.keysCollapsed ? 'false' : 'true');
  savePrefsToStorage();
  requestAnimationFrame(() => {
    if (!state.keysCollapsed) renderPianoKeyboard();
    drawMidiRollCanvas();
  });
  setTimeout(() => {
    if (!state.keysCollapsed) renderPianoKeyboard();
    drawMidiRollCanvas();
  }, 200);
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

  if (!state.isStaticMode && !state.isLiteMode) {
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
      const underlyingEnabledCount = grpVideos.filter(v => !isVideoMutedUnderlying(v.id)).length;
      const allMuted = underlyingEnabledCount === 0;
      const hasAnySolo = state.soloVideoIds.size > 0;
      const isThisSoloed = Boolean(hasAnySolo && state.soloGroupKey === grp.key);
      const isUnsoloedDim = Boolean(hasAnySolo && !isThisSoloed);
      const sliceCount = grpVideos.reduce(
        (sum, v) => sum + (v.slices || []).filter(s => !s.deleted).length,
        0
      );

      const grpSwitchClass = underlyingEnabledCount > 0 ? 'ui-switch is-on' : 'ui-switch';

      const rowEl = document.createElement('div');
      rowEl.className = [
        'explorer-video-row',
        allMuted && !isThisSoloed ? 'is-muted' : '',
        isUnsoloedDim ? 'is-unsoloed-dim' : ''
      ]
        .filter(Boolean)
        .join(' ');
      rowEl.dataset.groupKey = grp.key;
      rowEl.dataset.videoId = grpVideos[0].id;
      const vidCountMeta =
        grpVideos.length > 1 ? `${grpVideos.length} videos · ` : '';
      rowEl.title = `${grp.name} (${vidCountMeta}${sliceCount} sample${sliceCount === 1 ? '' : 's'}) — click to open/close inspector`;

      rowEl.innerHTML = `
        <span class="explorer-video-label">${grp.name}</span>
        ${isThisSoloed ? `<button type="button" class="explorer-solo-badge" title="Exit Solo for ${grp.name}">SOLO</button>` : ''}
        <span class="explorer-video-meta">${sliceCount}</span>
        <button
          type="button"
          class="${grpSwitchClass}"
          role="switch"
          aria-checked="${underlyingEnabledCount > 0 ? 'true' : 'false'}"
          title="${underlyingEnabledCount > 0 ? `Mute ${grp.name}` : `Enable ${grp.name}`}"
        ></button>
      `;

      const soloBadgeBtn = rowEl.querySelector('.explorer-solo-badge');
      if (soloBadgeBtn) {
        soloBadgeBtn.addEventListener('click', e => {
          e.stopPropagation();
          setInstrumentSolo(null, []);
        });
      }

      const switchBtn = rowEl.querySelector('.ui-switch');
      switchBtn.addEventListener('click', e => {
        e.stopPropagation();
        setVideosEnabled(
          grpVideos.map(v => v.id),
          underlyingEnabledCount === 0
        );
      });

      rowEl.addEventListener('click', e => {
        if (e.target.closest('.ui-switch') || e.target.closest('.explorer-solo-badge')) return;
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
  if (state.liteSplashActive) return;
  if (midi < MIN_MIDI || midi > MAX_MIDI) return;
  if (buildPreviewState.running && triggerId && !String(triggerId).startsWith('midifile_')) {
    stopIntroBuildPreview();
  }
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
  const noteColor = getNoteColor(midi, isKeyPercussionOnly(midi));

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
  const minOct = state.isLiteMode ? 1 : MIN_VISIBLE_OCTAVES;
  if (!Number.isFinite(widthPx) || widthPx <= 0) {
    return state.visibleOctaves || (state.isLiteMode ? 2 : 3);
  }
  if (state.isLiteMode) {
    // Stage keyboard flush under the sample mosaic: 1 oct when compact, 2 oct default, up to 3–4 oct on wide screens
    if (widthPx < 300) return 1;
    if (widthPx < 640) return 2;
    if (widthPx < 940) return 3;
    return 4;
  }
  // ~236px per octave keeps 2–3 generous, comfortable octaves while prioritizing transport & preset real estate
  const fit = Math.floor(widthPx / 236);
  return Math.max(minOct, Math.min(MAX_VISIBLE_OCTAVES, fit));
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
  const includeTopC8 = startMidi + visOctaves * 12 === TOP_KEYBOARD_MIDI_LIMIT && MAX_MIDI >= 108;
  const endMidi = startMidi + visOctaves * 12 - 1 + (includeTopC8 ? 1 : 0);

  const rangeLabel = document.getElementById('octaveRangeLabel');
  if (rangeLabel) {
    rangeLabel.textContent = `${midiToName(startMidi)}–${midiToName(endMidi)}`;
  }
  const octDownBtn = document.getElementById('octDownBtn');
  if (octDownBtn) octDownBtn.disabled = startMidi <= MIN_BASE_OCTAVE_MIDI;
  const octUpBtn = document.getElementById('octUpBtn');
  if (octUpBtn) octUpBtn.disabled = startMidi >= maxStartMidi;

  const totalNaturals = visOctaves * 7 + (includeTopC8 ? 1 : 0);
  const unitWidthPct = 100 / totalNaturals;
  const xEdgePx = u => Math.round((u / totalNaturals) * totalW);
  const keyMap = state.catalog?.keyboardMap || {};
  const totalSemis = visOctaves * 12 + (includeTopC8 ? 1 : 0);

  for (let i = 0; i < totalSemis; i++) {
    const midi = startMidi + i;
    const octIdx = Math.floor(i / 12);
    const pc = i % 12;
    const isAccidental = ACCIDENTAL_SEMITONES.has(pc);
    const inRange = midi >= MIN_MIDI && midi <= MAX_MIDI;

    const visCands = inRange ? getVisibleCandidatesForMidi(midi) : [];
    const candCount = visCands.length;
    const isPercOnlyKey = candCount > 0 && visCands.every(c => Boolean(c.isPerc));

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
    keyEl.style.setProperty('--note-color', getNoteColor(midi, isPercOnlyKey));

    const fullNoteName = midiToName(midi);
    if (!inRange) {
      keyEl.title = `${fullNoteName} (out of range)`;
    } else if (candCount > 0 && visCands.some(c => Boolean(c.isPerc))) {
      const groupNames = [...new Set(visCands.map(c => getVideoGroupName(c.videoId)).filter(Boolean))];
      keyEl.title = `${fullNoteName} · ${groupNames.join(' + ')}`;
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
      <div class="cand-thumb-wrap" title="Click to inspect sample (${readableGroup} · ${noteName})">
        <img src="${withBust(cand.thumbUrl)}" alt="${readableGroup}" loading="lazy" />
      </div>
      <div class="cand-slug-title" title="${readableGroup}">${readableGroup}</div>
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
const TRASH_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM8 9h8v10H8V9zm7.5-5l-1-1h-5l-1 1H5v2h14V4h-3.5z"/></svg>`;
const PENCIL_ICON_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 0 0 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z"/></svg>`;
const COPY_ICON_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`;
const CHECK_ICON_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
const BLADE_PLAY_ICON_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
const BLADE_STOP_ICON_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M6 6h12v12H6z"/></svg>`;
const PLAY_ICON_SVG = `<svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
const PAUSE_ICON_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;

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
  testToneMidi: null,
  copyIdTimer: null,
  rawDur: 2.0,
  inSec: 0,
  outSec: 2.0,
  sliceAudioBuffer: null,
  sliceAudioBufferSliceId: null,
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

function evictTrashedSlicesClientState(sliceIds) {
  const ids = (Array.isArray(sliceIds) ? sliceIds : [sliceIds]).map(String).filter(Boolean);
  if (ids.length === 0) return;
  const idSet = new Set(ids);

  // 1. Immediately fade out & stop any ringing live/preview voices playing a deleted sample
  for (const [trigId, voice] of Array.from(activeVoices.entries())) {
    const vSid = String(voice?.slice?.sliceId || voice?.slice?.id || voice?.sliceKey || '');
    if (vSid && idSet.has(vSid)) {
      releaseHeldVoice(trigId, 0.025);
    }
  }

  // 2. Evict any stage video slot still holding or freezing on the deleted sample
  for (let i = 0; i < MAX_STAGE_SLOTS; i++) {
    const sl = stageSlots[i];
    if (sl?.occupied && sl.sliceKey && idSet.has(String(sl.sliceKey))) {
      removeStageTile({ slotIdx: i, token: sl.token, videoEl: sl.videoEl });
    }
  }

  // 3. Purge round-robin & selection pointers so no key or UI badge points to the deleted sample
  for (const [midiKey, sid] of Array.from(lastPlayedSliceByMidi.entries())) {
    if (idSet.has(String(sid))) {
      lastPlayedSliceByMidi.delete(midiKey);
    }
  }
  if (state.lastPlayedSliceId && idSet.has(String(state.lastPlayedSliceId))) {
    state.lastPlayedSliceId = null;
  }
  if (state.selectedTileSliceId && idSet.has(String(state.selectedTileSliceId))) {
    state.selectedTileSliceId = null;
    threeStage?.setSelectedSliceId?.(null);
  }
  for (const sid of idSet) {
    delete state.sliceToggleOverrides[sid];
  }

  // 4. Purge expanded blade audio buffer if it belonged to the deleted sample
  if (bladeState.sliceAudioBufferSliceId && idSet.has(String(bladeState.sliceAudioBufferSliceId))) {
    bladeState.sliceAudioBuffer = null;
    bladeState.sliceAudioBufferSliceId = null;
  }
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
  const raw = [];
  for (const v of bladeState.groupVideos || []) {
    const slices = getActiveVideoSlices(v);
    slices.forEach((slice, localIdx) => {
      const cand = findKeyboardCandidate(slice.id);
      const midi = Number(cand?.midi ?? slice.manualMidi ?? slice.midi ?? 60);
      const exactMidi = Number(cand?.exactMidi ?? slice.exactMidi ?? midi);
      raw.push({ video: v, slice, localIdx, midi, exactMidi });
    });
  }
  raw.sort((a, b) => {
    if (a.midi !== b.midi) return a.midi - b.midi;
    if (Math.abs(a.exactMidi - b.exactMidi) > 0.001) return a.exactMidi - b.exactMidi;
    const slugCmp = String(a.video.slug || '').localeCompare(String(b.video.slug || ''), undefined, {
      numeric: true,
      sensitivity: 'base'
    });
    if (slugCmp !== 0) return slugCmp;
    return (a.slice.hitIndex || 0) - (b.slice.hitIndex || 0);
  });
  return raw.map((item, globalIdx) => ({ ...item, globalIdx }));
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
  const grpTrashBtn = document.getElementById('bladeTrashGroupBtn');
  if (grpTrashBtn) {
    grpTrashBtn.classList.remove('confirm-armed');
    grpTrashBtn.innerHTML = TRASH_ICON_SVG;
  }
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

function playReferenceTone(midi = bladeState.testToneMidi ?? bladeState.assignedMidi) {
  const clampedMidi = Math.max(MIN_MIDI, Math.min(MAX_MIDI, Math.round(Number(midi) || 60)));
  stopReferenceTone(false);

  const ctx = ensureAudioContext();
  const now = ctx.currentTime;
  const freq = 440 * Math.pow(2, (clampedMidi - 69) / 12);
  const dur = 0.92;

  // Clear, harmonic-rich pure Triangle wave so low and mid pitches are easy to match by ear
  const triOsc = ctx.createOscillator();
  triOsc.type = 'triangle';
  triOsc.frequency.setValueAtTime(freq, now);

  const triFilter = ctx.createBiquadFilter();
  triFilter.type = 'lowpass';
  triFilter.frequency.setValueAtTime(Math.min(6800, Math.max(2200, freq * 7.5)), now);

  const env = ctx.createGain();
  const peak = clampedMidi < 45 ? 0.34 : 0.26;
  env.gain.setValueAtTime(0.0001, now);
  env.gain.linearRampToValueAtTime(peak, now + 0.007);
  env.gain.exponentialRampToValueAtTime(peak * 0.56, now + 0.30);
  env.gain.exponentialRampToValueAtTime(0.0001, now + dur);

  triOsc.connect(triFilter);
  triFilter.connect(env);
  env.connect(masterBus);

  triOsc.start(now);
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
      triOsc.stop(t + fade + 0.01);
    } catch {}
  };

  bladeState.refToneUiTimer = setTimeout(() => {
    bladeState.refToneUiTimer = null;
    bladeState.refToneStopFn = null;
    if (btn) btn.classList.remove('ringing');
  }, Math.round(dur * 1000));
}

function triggerContextualTestTone() {
  if (bladeState.open && bladeState.slice) {
    const cand = findKeyboardCandidate(bladeState.slice.id);
    const isPerc = cand ? cand.isPerc : isPercussionSlice(bladeState.video, bladeState.slice);
    const m = isPerc ? 60 : bladeState.testToneMidi ?? bladeState.assignedMidi;
    playReferenceTone(m);
    return;
  }
  if (bladeState.open) {
    const first = getBladeOrderedSamples()[0];
    if (first) {
      playReferenceTone(first.midi >= MIN_MIDI ? first.midi : 60);
      return;
    }
  }
  playReferenceTone(state.selectedMidi >= MIN_MIDI ? state.selectedMidi : 60);
}

function syncBladeToneProbeBarUI() {
  if (!bladeState.open || !bladeState.slice) return;
  const currentMidi = bladeState.assignedMidi;
  const probeMidi = Number.isFinite(bladeState.testToneMidi) ? bladeState.testToneMidi : currentMidi;
  const isProbing = probeMidi !== currentMidi;
  const probeName = midiToName(probeMidi);
  const probeFreq = midiToFreq(probeMidi);
  const probeColor = getNoteColor(probeMidi);

  const toneBtn = document.getElementById('bladeTestToneBtn');
  const toneDot = document.getElementById('bladeTestToneDot');
  const toneLabel = document.getElementById('bladeTestToneLabel');
  const prevBtn = document.getElementById('bladeTonePrevBtn');
  const nextBtn = document.getElementById('bladeToneNextBtn');
  const assignBtn = document.getElementById('bladeAssignToneMidiBtn');
  const cancelProbeBtn = document.getElementById('bladeCancelToneProbeBtn');

  if (toneDot) toneDot.style.background = probeColor;
  if (toneLabel) {
    toneLabel.textContent = probeName;
  }
  if (toneBtn) {
    toneBtn.title = isProbing
      ? `Play ${probeName} (${probeFreq} Hz) triangle test tone — currently assigned to ${midiToName(currentMidi)} (T)`
      : `Play ${probeName} (${probeFreq} Hz) triangle test tone (T)`;
    toneBtn.classList.toggle('is-probing', isProbing);
  }
  if (prevBtn) prevBtn.disabled = probeMidi <= MIN_MIDI;
  if (nextBtn) nextBtn.disabled = probeMidi >= MAX_MIDI;
  if (assignBtn) {
    assignBtn.classList.toggle('hidden', !isProbing || state.isStaticMode);
    assignBtn.textContent = `Set ${probeName}`;
    assignBtn.title = `Move this sample to ${probeName} / MIDI ${probeMidi} (Shift+Enter)`;
  }
  if (cancelProbeBtn) {
    cancelProbeBtn.classList.toggle('hidden', !isProbing);
  }
  renderBladeExpandedSpectrogram();
}

function setBladeTestToneMidi(nextMidi, shouldPlay = true) {
  const clamped = Math.max(MIN_MIDI, Math.min(MAX_MIDI, Math.round(Number(nextMidi) || 60)));
  if (bladeState.open && bladeState.slice) {
    bladeState.testToneMidi = clamped;
    syncBladeToneProbeBarUI();
  }
  if (shouldPlay) {
    playReferenceTone(clamped);
  }
}

function stepBladeTestToneMidi(deltaSemitones) {
  if (!bladeState.open || !bladeState.slice) return;
  const base = Number.isFinite(bladeState.testToneMidi)
    ? bladeState.testToneMidi
    : bladeState.assignedMidi >= MIN_MIDI
      ? bladeState.assignedMidi
      : 60;
  setBladeTestToneMidi(base + deltaSemitones, true);
}

async function commitBladeTestToneMidi() {
  if (state.isStaticMode || !bladeState.open || !bladeState.video || !bladeState.slice) return;
  const targetMidi = Number(bladeState.testToneMidi);
  if (!Number.isFinite(targetMidi) || targetMidi === bladeState.assignedMidi) return;
  stopBladePreview();
  stopReferenceTone(true);
  const vidId = bladeState.video.id;
  const slId = bladeState.slice.id;
  bladeState.assignedMidi = targetMidi;
  bladeState.testToneMidi = targetMidi;
  await apiPost('/api/slice/update', {
    videoId: vidId,
    sliceId: slId,
    assignMidi: targetMidi
  });
  if (bladeState.open && bladeState.expandedSliceId === slId) {
    selectKeyForConfig(targetMidi, false, true);
    requestAnimationFrame(() => {
      const cardEl = document.querySelector(`#bladeScroll .blade-sample-card[data-slice-id="${slId}"]`);
      cardEl?.scrollIntoView({ block: 'nearest' });
    });
  }
}

async function copyExpandedSampleReference() {
  if (!bladeState.open || !bladeState.video || !bladeState.slice) return;
  const groupName = getVideoGroupName(bladeState.video);
  const midi = bladeState.assignedMidi;
  const noteName = midiToName(midi);
  const text = `${groupName} · ${bladeState.slice.id} (${noteName} / MIDI ${midi})`;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {}
    ta.remove();
  }
  const btn = document.getElementById('bladeCopyIdBtn');
  if (btn) {
    btn.classList.add('is-copied');
    btn.innerHTML = CHECK_ICON_SVG;
    if (bladeState.copyIdTimer) clearTimeout(bladeState.copyIdTimer);
    bladeState.copyIdTimer = setTimeout(() => {
      bladeState.copyIdTimer = null;
      const freshBtn = document.getElementById('bladeCopyIdBtn');
      if (freshBtn) {
        freshBtn.classList.remove('is-copied');
        freshBtn.innerHTML = COPY_ICON_SVG;
      }
    }, 1200);
  }
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
  if (btn) {
    btn.classList.remove('is-playing');
    btn.innerHTML = BLADE_PLAY_ICON_SVG;
  }
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
  let buffer =
    isExpandedSlice && bladeState.sliceAudioBufferSliceId === targetSlice.id
      ? bladeState.sliceAudioBuffer
      : null;
  if (!buffer) {
    try {
      buffer = await loadAudioBuffer(targetSlice.audioUrl);
      if (!bladeState.open) return;
      // Abort if the user switched or deleted the target sample while audio was decoding
      if (isExpandedSlice && bladeState.expandedSliceId !== targetSlice.id) return;
      if (isExpandedSlice && bladeState.slice?.id === targetSlice.id) {
        bladeState.sliceAudioBuffer = buffer;
        bladeState.sliceAudioBufferSliceId = targetSlice.id;
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
  if (btn) {
    btn.classList.add('is-playing');
    btn.innerHTML = BLADE_STOP_ICON_SVG;
  }

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
  const minBin = Math.max(1, Math.floor((MINI_SPEC_MIN_FREQ * fftSizeSpec) / effectiveSr));
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

  if (!meta.isPerc && meta.f0Hz >= 25 && meta.f0Hz <= 4500) {
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
  if (
    !bladeState.sliceAudioBuffer ||
    bladeState.sliceAudioBufferSliceId !== bladeState.slice.id
  ) {
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

  // If auditioning a candidate test tone pitch (via [ / ] or Alt-click), draw a crisp dashed frequency guide line
  const probeMidi = bladeState.testToneMidi;
  if (
    !isPerc &&
    Number.isFinite(probeMidi) &&
    probeMidi !== assignedMidi &&
    probeMidi >= MIN_MIDI &&
    probeMidi <= MAX_MIDI
  ) {
    const probeFreq = Number((440 * Math.pow(2, (probeMidi - 69) / 12)).toFixed(1));
    if (probeFreq >= 25 && probeFreq <= SPEC_MAX_FREQ) {
      const probeColor = getNoteColor(probeMidi);
      const yProbe = Math.max(2, Math.min(cssH - 3, cssH - 1 - specFreqToNormY(probeFreq) * (cssH - 1)));
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.strokeStyle = probeColor;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(0, yProbe);
      ctx.lineTo(cssW, yProbe);
      ctx.stroke();
      ctx.setLineDash([]);

      const tagText = `♪ ${midiToName(probeMidi)} · ${probeFreq} Hz`;
      ctx.font = '600 9.5px "Google Sans", -apple-system, BlinkMacSystemFont, sans-serif';
      const tagW = Math.ceil(ctx.measureText(tagText).width) + 10;
      const tagY = Math.max(3, Math.min(cssH - 17, yProbe - 15));
      ctx.fillStyle = 'rgba(0, 0, 0, 0.88)';
      ctx.fillRect(6, tagY, tagW, 14);
      ctx.strokeStyle = probeColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(6.5, tagY + 0.5, tagW - 1, 13);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(tagText, 11, tagY + 10.5);
      ctx.restore();
    }
  }
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

  if (
    bladeState.sliceAudioBuffer &&
    bladeState.sliceAudioBufferSliceId === bladeState.slice.id
  ) {
    renderBladeExpandedSpectrogram();
  }
}

function setGroupGainDb(videoIds, nextGainDb, persistServer = true) {
  const ids = (Array.isArray(videoIds) ? videoIds : [videoIds]).filter(Boolean);
  if (ids.length === 0) return;
  const clamped = clampVideoGainDb(nextGainDb);
  const idSet = new Set(ids);

  for (const id of ids) {
    state.videoGainOverrides[id] = clamped;
  }
  for (const v of state.catalog?.videos || []) {
    if (idSet.has(v.id)) {
      v.gainDb = clamped;
    }
  }

  savePrefsToStorage();
  replanCurrentMidiTimeline();

  if (bladeState.open) {
    updateBladeHeaderUi();
  }

  if (persistServer && !state.isStaticMode) {
    fetch('./api/video/gain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoIds: ids, gainDb: clamped })
    }).catch(() => {});
  }
}

function setVideoGainDb(videoId, nextGainDb, persistServer = true) {
  if (!videoId) return;
  setGroupGainDb([videoId], nextGainDb, persistServer);
}

function updateBladeHeaderUi() {
  const vids = bladeState.groupVideos || [];
  if (vids.length === 0) return;
  const firstVid = vids[0];
  const groupName = getVideoGroupName(firstVid);

  const titleEl = document.getElementById('bladeGroupTitle');
  if (titleEl) titleEl.textContent = groupName;

  const gainDb = getVideoGainDb(firstVid.id);
  const volSlider = document.getElementById('bladeGroupVolSlider');
  const volReadout = document.getElementById('bladeGroupVolReadout');
  const volDecBtn = document.getElementById('bladeGroupVolDecBtn');
  const volIncBtn = document.getElementById('bladeGroupVolIncBtn');
  if (volSlider && document.activeElement !== volSlider) {
    volSlider.value = String(gainDb);
  }
  if (volReadout) volReadout.textContent = formatSignedDb(gainDb);
  if (volDecBtn) volDecBtn.disabled = gainDb <= -12;
  if (volIncBtn) volIncBtn.disabled = gainDb >= 12;

  const soloBtn = document.getElementById('bladeGroupSoloBtn');
  if (soloBtn) {
    const isSoloed = Boolean(state.soloGroupKey && state.soloGroupKey === bladeState.groupKey);
    soloBtn.classList.toggle('is-active', isSoloed);
    soloBtn.setAttribute('aria-pressed', isSoloed ? 'true' : 'false');
    soloBtn.title = isSoloed
      ? `Exit Solo for ${groupName} — restore all other instruments (Alt+S)`
      : `Temporarily solo ${groupName} — mutes all other instruments while respecting individual sample mutes (Alt+S)`;
  }

  const grpSwitch = document.getElementById('bladeGroupSwitch');
  if (grpSwitch) {
    const enabledCount = vids.filter(v => !isVideoMutedUnderlying(v.id)).length;
    grpSwitch.className = enabledCount > 0 ? 'ui-switch is-on' : 'ui-switch';
    grpSwitch.setAttribute('aria-checked', enabledCount > 0 ? 'true' : 'false');
  }
}

function syncExpandedSliceStateFromCatalog(video, slice, fallbackRate = 1.0) {
  if (bladeState.sliceAudioBufferSliceId !== slice.id) {
    bladeState.sliceAudioBuffer = null;
    bladeState.sliceAudioBufferSliceId = null;
  }
  const cand = findKeyboardCandidate(slice.id);
  const currentMidi = cand?.midi ?? slice.manualMidi ?? slice.midi ?? 60;
  const bufDur =
    bladeState.sliceAudioBufferSliceId === slice.id && bladeState.sliceAudioBuffer
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

  const switchingSlice = bladeState.slice?.id !== slice.id;
  bladeState.video = video;
  bladeState.slice = slice;
  bladeState.expandedVideoId = video.id;
  bladeState.expandedSliceId = slice.id;
  bladeState.playbackRate = cand?.playbackRate ?? fallbackRate ?? 1.0;
  bladeState.assignedMidi = currentMidi;
  if (switchingSlice || !Number.isFinite(bladeState.testToneMidi)) {
    bladeState.testToneMidi = currentMidi;
  }
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

  const probeMidi = Number.isFinite(bladeState.testToneMidi) ? bladeState.testToneMidi : currentMidi;
  const isProbing = !isPerc && probeMidi !== currentMidi;
  const probeColor = isPerc ? PERC_NOTE_COLOR : getNoteColor(probeMidi);
  const probeName = midiToName(probeMidi);

  const noteBadgeHtml =
    isPerc || state.isLiteMode
      ? `<span class="blade-note-pill-static"><span class="blade-sample-dot" style="background:${noteColor}"></span><span>${isPerc ? noteName : `${noteName} · ${midiToFreq(currentMidi)} Hz`}</span></span>`
      : `<div class="blade-tone-stepper">
        <button id="bladeTonePrevBtn" type="button" class="blade-tone-step-btn" ${probeMidi <= MIN_MIDI ? 'disabled' : ''} title="Step test tone down 1 semitone ([ or Shift+[ for octave)">−</button>
        <button id="bladeTestToneBtn" type="button" class="blade-note-tone-btn${isProbing ? ' is-probing' : ''}" title="${isProbing ? `Play ${probeName} (${midiToFreq(probeMidi)} Hz) triangle test tone — currently assigned to ${noteName} (T)` : `Play ${probeName} (${midiToFreq(probeMidi)} Hz) triangle test tone (T)`}">
          <span class="blade-sample-dot" id="bladeTestToneDot" style="background:${probeColor}"></span>
          <span id="bladeTestToneLabel">${probeName}</span>
        </button>
        <button id="bladeToneNextBtn" type="button" class="blade-tone-step-btn" ${probeMidi >= MAX_MIDI ? 'disabled' : ''} title="Step test tone up 1 semitone (] or Shift+] for octave)">+</button>
      </div>
      <button id="bladeAssignToneMidiBtn" type="button" class="blade-assign-midi-btn local-only-btn${isProbing ? '' : ' hidden'}" title="Move this sample to ${probeName} (Shift+Enter)">Set ${probeName}</button>
      <button id="bladeCancelToneProbeBtn" type="button" class="blade-cancel-probe-btn${isProbing ? '' : ' hidden'}" title="Reset test tone back to ${noteName}">✕</button>`;

  const wrap = document.createElement('div');
  wrap.className = 'blade-expanded-editor';

  wrap.innerHTML = `
    <div class="blade-exp-top-bar" title="Click header to collapse sample">
      <div class="blade-exp-title-left">
        <button id="bladePreviewBtn" type="button" class="blade-preview-icon-btn" title="Preview / Stop sample (Space)" aria-label="Preview sample">${BLADE_PLAY_ICON_SVG}</button>
        ${noteBadgeHtml}
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

      <div class="blade-exp-spec-stage" id="bladeExpSpecStage" title="${isPerc ? 'Drag handles to trim sample' : 'Drag handles to trim · Option/Alt-click vertically to audition frequency'}">
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
            id="bladeCopyIdBtn"
            type="button"
            class="icon-copy-btn"
            title="Copy sample ID &amp; note (${slice.id} · ${noteName}) to clipboard (C)"
            aria-label="Copy sample ID"
          >${COPY_ICON_SVG}</button>
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
      playReferenceTone(bladeState.testToneMidi ?? currentMidi);
    });
  }
  const tonePrevBtn = wrap.querySelector('#bladeTonePrevBtn');
  if (tonePrevBtn) {
    tonePrevBtn.addEventListener('click', e => {
      e.stopPropagation();
      setSelectionFocus('blade');
      stepBladeTestToneMidi(e.shiftKey ? -12 : -1);
    });
  }
  const toneNextBtn = wrap.querySelector('#bladeToneNextBtn');
  if (toneNextBtn) {
    toneNextBtn.addEventListener('click', e => {
      e.stopPropagation();
      setSelectionFocus('blade');
      stepBladeTestToneMidi(e.shiftKey ? 12 : 1);
    });
  }
  const assignMidiBtn = wrap.querySelector('#bladeAssignToneMidiBtn');
  if (assignMidiBtn) {
    assignMidiBtn.addEventListener('click', async e => {
      e.stopPropagation();
      setSelectionFocus('blade');
      await commitBladeTestToneMidi();
    });
  }
  const cancelProbeBtn = wrap.querySelector('#bladeCancelToneProbeBtn');
  if (cancelProbeBtn) {
    cancelProbeBtn.addEventListener('click', e => {
      e.stopPropagation();
      setSelectionFocus('blade');
      bladeState.testToneMidi = bladeState.assignedMidi;
      syncBladeToneProbeBarUI();
    });
  }

  const copyIdBtn = wrap.querySelector('#bladeCopyIdBtn');
  if (copyIdBtn) {
    copyIdBtn.addEventListener('click', e => {
      e.stopPropagation();
      setSelectionFocus('blade');
      copyExpandedSampleReference();
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
    stopReferenceTone(true);
    evictTrashedSlicesClientState([slice.id]);
    bladeState.slice = null;
    bladeState.sliceAudioBuffer = null;
    bladeState.sliceAudioBufferSliceId = null;
    bladeState.playbackRate = 1.0;
    bladeState.expandedSliceId = nextNeighbor;
    if (!nextNeighbor) {
      releaseSharedBladeVideo();
    }
    await apiPost('/api/slice/trash', { videoId: video.id, sliceId: slice.id });
    if (bladeState.open && bladeState.slice && bladeState.expandedSliceId) {
      if (bladeState.assignedMidi >= MIN_MIDI && bladeState.assignedMidi <= MAX_MIDI) {
        selectKeyForConfig(bladeState.assignedMidi, false, true);
      }
      scrubBladeVideoTo(bladeState.inSec);
    }
  });

  // Unified Spectrogram [ IN ... OUT ] Drag Handles
  const beginSpecTrimDrag = (mode, e) => {
    if (state.isStaticMode || state.isLiteMode) return;
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

  const probeSpecFrequencyAtClientY = clientY => {
    const stageEl = wrap.querySelector('#bladeExpSpecStage');
    if (!stageEl || isPerc || state.isLiteMode) return;
    const rect = stageEl.getBoundingClientRect();
    const normY = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / Math.max(1, rect.height)));
    const freq = specNormYToFreq(normY);
    const nearestMidi = Math.max(MIN_MIDI, Math.min(MAX_MIDI, Math.round(69 + 12 * Math.log2(freq / 440))));
    setSelectionFocus('blade');
    setBladeTestToneMidi(nearestMidi, true);
  };

  wrap.querySelector('#bladeTrimHandleIn').addEventListener('mousedown', e => beginSpecTrimDrag('in', e));
  wrap.querySelector('#bladeTrimHandleOut').addEventListener('mousedown', e => beginSpecTrimDrag('out', e));
  wrap.querySelector('#bladeTrimWindow').addEventListener('mousedown', e => {
    if (e.altKey && !isPerc && !state.isLiteMode) {
      e.stopPropagation();
      e.preventDefault();
      probeSpecFrequencyAtClientY(e.clientY);
      return;
    }
    if (state.isStaticMode || state.isLiteMode) {
      e.stopPropagation();
      startBladePreview(false);
      return;
    }
    beginSpecTrimDrag('move', e);
  });

  wrap.querySelector('#bladeExpSpecStage').addEventListener('mousedown', e => {
    if (e.altKey && !isPerc && !state.isLiteMode) {
      e.stopPropagation();
      e.preventDefault();
      probeSpecFrequencyAtClientY(e.clientY);
      return;
    }
    if (e.target.closest('#bladeTrimWindow')) return;
    e.stopPropagation();
    e.preventDefault();
    setSelectionFocus('blade');
    if (state.isStaticMode || state.isLiteMode) {
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
    bladeState.sliceAudioBufferSliceId = slice.id;
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

  const vids = bladeState.groupVideos || [];
  const allMuted = vids.length > 0 && vids.every(v => isVideoDisabled(v.id));
  scrollEl.classList.toggle('is-instrument-muted', allMuted);
  scrollEl.innerHTML = '';

  const orderedSamples = getBladeOrderedSamples();
  const specJobs = [];

  if (orderedSamples.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'blade-empty-slices';
    emptyEl.textContent = 'No extracted samples in this instrument';
    scrollEl.appendChild(emptyEl);
  } else {
    orderedSamples.forEach(({ video: v, slice }) => {
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

      scrollEl.appendChild(sampleCard);
    });
  }

  scrollEl.scrollTop = prevScrollTop;

  if (bladeState.expandedSliceId && bladeState.slice) {
    renderBladeTrimHandlesUI();
    if (
      bladeState.sliceAudioBuffer &&
      bladeState.sliceAudioBufferSliceId === bladeState.slice.id
    ) {
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
    bladeState.sliceAudioBufferSliceId = null;
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
    bladeState.sliceAudioBufferSliceId = null;
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
      bladeState.sliceAudioBufferSliceId = null;
      syncExpandedSliceStateFromCatalog(foundVideo, foundSlice, playbackRate);
      if (bladeState.assignedMidi >= MIN_MIDI && bladeState.assignedMidi <= MAX_MIDI) {
        selectKeyForConfig(bladeState.assignedMidi, false, true);
      }
    } else {
      bladeState.expandedSliceId = null;
      bladeState.expandedVideoId = null;
      bladeState.slice = null;
      bladeState.sliceAudioBuffer = null;
      bladeState.sliceAudioBufferSliceId = null;
      releaseSharedBladeVideo();
    }
  } else {
    bladeState.expandedSliceId = null;
    bladeState.expandedVideoId = null;
    bladeState.video = bladeState.groupVideos[0] || video;
    bladeState.slice = null;
    bladeState.sliceAudioBuffer = null;
    bladeState.sliceAudioBufferSliceId = null;
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
  bladeState.sliceAudioBufferSliceId = null;
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
      const keepRate = bladeState.slice?.id === foundS.id ? bladeState.playbackRate : 1.0;
      syncExpandedSliceStateFromCatalog(foundV, foundS, keepRate);
    } else {
      bladeState.expandedSliceId = null;
      bladeState.expandedVideoId = null;
      bladeState.slice = null;
      bladeState.sliceAudioBuffer = null;
      bladeState.sliceAudioBufferSliceId = null;
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
    if (state.isStaticMode || state.isLiteMode) {
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

  if (state.isStaticMode || state.isLiteMode) return { ok: true };

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
    if (!isMetadataOnlySliceUpdate) {
      state.assetBust = Date.parse(state.catalog?.updatedAt || '') || Date.now();
    }
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
  syncLiteResetButtonUI();
  if (!state.isLiteMode) {
    updatePresetDockUi();
  }
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
// Presets Zone (Right of MIDI Transport: Default + Named Mute & Stage Presets)
// ============================================================================
const presetState = {
  activePresetId: 'default',
  presets: [],
  popoverOpen: false,
  creatingNew: false,
  busy: false
};

function captureCurrentPresetSnapshot() {
  const validVideos = (state.catalog?.videos || []).filter(v => !v.deleted);
  const disabledVideoIds = validVideos
    .filter(v => state.disabledVideoIds.has(v.id))
    .map(v => v.id)
    .sort();

  const enabledByMidi = {};
  const selectedByMidi = {};
  const clearedSet = new Set(
    Array.isArray(state.catalog?.keyboardConfig?.clearedMidis)
      ? state.catalog.keyboardConfig.clearedMidis.map(Number).filter(Number.isFinite)
      : []
  );

  const km = state.catalog?.keyboardMap || {};
  for (const [midiStr, entry] of Object.entries(km)) {
    const m = Number(midiStr);
    if (!Number.isFinite(m)) continue;
    const enabledIds = (entry?.candidates || [])
      .filter(c => Boolean(c.enabled))
      .map(c => String(c.sliceId))
      .sort();
    enabledByMidi[String(m)] = enabledIds;
    if (entry?.isCleared || enabledIds.length === 0) {
      if (entry?.candidateCount > 0 && enabledIds.length === 0) {
        clearedSet.add(m);
      }
    } else {
      clearedSet.delete(m);
    }
    const selId =
      state.catalog?.keyboardConfig?.selectedByMidi?.[m] ||
      entry?.activeSliceId ||
      entry?.primary?.sliceId ||
      '';
    if (selId) {
      selectedByMidi[String(m)] = String(selId);
    }
  }

  const stageConfig = {
    stageGridMode: normalizeStageGridMode(state.stageGridMode),
    stageTileScale: clampStageTileScale(state.stageTileScale),
    stageSpecScale: clampStageSpecScale(state.stageSpecScale),
    stageFadeInSec: clampStageFadeInSec(state.stageFadeInSec),
    stageFadeSec: clampStageFadeSec(state.stageFadeSec),
    stageMinDisplaySec: clampStageMinDisplaySec(state.stageMinDisplaySec),
    stageMaxDisplaySec: clampStageMaxDisplaySec(state.stageMaxDisplaySec),
    stageShowVideo: Boolean(state.stageShowVideo),
    stageVideoPosition: normalizeStageVideoPosition(state.stageVideoPosition),
    stageVideoWidthPct: clampStageVideoWidthPct(state.stageVideoWidthPct),
    stageVideoHeightPct: clampStageVideoHeightPct(state.stageVideoHeightPct),
    stageVideoCropX: clampStageVideoCropX(state.stageVideoCropX),
    stageVideoCropY: clampStageVideoCropY(state.stageVideoCropY),
    stageVideoZoom: clampStageVideoZoom(state.stageVideoZoom),
    stageVideoBrightness: clampStageVideoBrightness(state.stageVideoBrightness),
    stageBuildRampUp: normalizeBuildRampUp(state.stageBuildRampUp),
    stageBuildFullSec: clampBuildFullSec(state.stageBuildFullSec),
    stageBuildMaxFps: clampBuildMaxFps(state.stageBuildMaxFps),
    stageBuildSound: normalizeBuildSound(state.stageBuildSound)
  };

  return {
    disabledVideoIds,
    keyboardConfig: {
      selectedByMidi,
      enabledByMidi,
      clearedMidis: Array.from(clearedSet).sort((a, b) => a - b)
    },
    stageConfig
  };
}

function canonicalizePresetSnapshotForCompare(snap) {
  if (!snap || typeof snap !== 'object') return '';
  const validVideos = new Set(
    (state.catalog?.videos || []).filter(v => !v.deleted).map(v => v.id)
  );
  const validSlices = new Set();
  for (const v of state.catalog?.videos || []) {
    if (v.deleted) continue;
    for (const s of v.slices || []) {
      if (!s.deleted) validSlices.add(s.id);
    }
  }

  const dis = Array.from(
    new Set(
      (snap.disabledVideoIds || [])
        .map(String)
        .filter(id => (validVideos.size ? validVideos.has(id) : true))
    )
  ).sort();

  const enMap = {};
  const rawEn = snap.keyboardConfig?.enabledByMidi || {};
  const kmKeys = Object.keys(state.catalog?.keyboardMap || {}).sort((a, b) => Number(a) - Number(b));
  const allMidiKeys = kmKeys.length ? kmKeys : Object.keys(rawEn).sort((a, b) => Number(a) - Number(b));

  for (const k of allMidiKeys) {
    const arr = Array.isArray(rawEn[k]) ? rawEn[k] : [];
    enMap[String(k)] = Array.from(
      new Set(
        arr.map(String).filter(id => (validSlices.size ? validSlices.has(id) : true))
      )
    ).sort();
  }

  const sc = snap.stageConfig || {};
  const normSc = {
    stageGridMode: normalizeStageGridMode(sc.stageGridMode ?? '3x1'),
    stageTileScale: clampStageTileScale(sc.stageTileScale ?? 1.0),
    stageSpecScale: clampStageSpecScale(sc.stageSpecScale ?? 1.0),
    stageFadeInSec: clampStageFadeInSec(sc.stageFadeInSec ?? 0.0),
    stageFadeSec: clampStageFadeSec(sc.stageFadeSec ?? 0.2),
    stageMinDisplaySec: clampStageMinDisplaySec(sc.stageMinDisplaySec ?? 0.7),
    stageMaxDisplaySec: clampStageMaxDisplaySec(sc.stageMaxDisplaySec ?? 1.0),
    stageShowVideo: sc.stageShowVideo !== undefined ? Boolean(sc.stageShowVideo) : true,
    stageVideoPosition: normalizeStageVideoPosition(sc.stageVideoPosition ?? 'right'),
    stageVideoWidthPct: clampStageVideoWidthPct(sc.stageVideoWidthPct ?? 50),
    stageVideoHeightPct: clampStageVideoHeightPct(sc.stageVideoHeightPct ?? 23),
    stageVideoCropX: clampStageVideoCropX(sc.stageVideoCropX ?? 50),
    stageVideoCropY: clampStageVideoCropY(sc.stageVideoCropY ?? 50),
    stageVideoZoom: clampStageVideoZoom(sc.stageVideoZoom ?? 1.0),
    stageVideoBrightness: clampStageVideoBrightness(sc.stageVideoBrightness ?? 1.0),
    stageBuildRampUp: normalizeBuildRampUp(sc.stageBuildRampUp ?? true),
    stageBuildFullSec: clampBuildFullSec(sc.stageBuildFullSec ?? 5.0),
    stageBuildMaxFps: clampBuildMaxFps(sc.stageBuildMaxFps ?? 12),
    stageBuildSound: normalizeBuildSound(sc.stageBuildSound ?? true)
  };

  return JSON.stringify({ dis, enMap, normSc });
}

function getActivePresetEntry() {
  return (
    presetState.presets.find(p => p.id === presetState.activePresetId) ||
    presetState.presets.find(p => p.id === 'default') ||
    null
  );
}

function isCurrentPresetDirty() {
  if (!state.catalog || !presetState.presets.length) return false;
  const active = getActivePresetEntry();
  if (!active?.snapshot) return false;
  return (
    canonicalizePresetSnapshotForCompare(captureCurrentPresetSnapshot()) !==
    canonicalizePresetSnapshotForCompare(active.snapshot)
  );
}

function updatePresetDockUi() {
  const toggleBtn = document.getElementById('presetBrowserToggleBtn');
  const nameEl = document.getElementById('presetNameLabel');
  const dirtyDot = document.getElementById('presetDirtyDot');
  const saveBtn = document.getElementById('presetSaveBtn');
  const saveAsBtn = document.getElementById('presetSaveAsBtn');
  const revertBtn = document.getElementById('presetRevertBtn');

  const active = getActivePresetEntry();
  const activeName = active?.name || 'Default';
  const dirty = isCurrentPresetDirty();

  if (toggleBtn) {
    toggleBtn.classList.toggle('is-open', presetState.popoverOpen);
    toggleBtn.classList.toggle('has-session', Boolean(active && active.id !== 'default'));
  }
  if (nameEl) {
    nameEl.textContent = activeName;
    nameEl.title = dirty ? `${activeName} (unsaved changes)` : activeName;
  }
  if (dirtyDot) {
    dirtyDot.classList.toggle('hidden', !dirty);
  }
  const tabDirtyDot = document.getElementById('presetsTabDirtyDot');
  if (tabDirtyDot) {
    tabDirtyDot.classList.toggle('hidden', !dirty);
  }
  if (saveBtn) {
    saveBtn.disabled = !dirty || presetState.busy || state.isStaticMode;
    saveBtn.title = `Save changes into "${activeName}"`;
  }
  if (saveAsBtn) {
    saveAsBtn.disabled = presetState.busy || state.isStaticMode;
  }
  if (revertBtn) {
    revertBtn.classList.toggle('hidden', !dirty || presetState.busy);
    revertBtn.title = `Revert unsaved changes back to "${activeName}"`;
  }
}

function hydrateClientFromPresetCatalog(nextCatalog) {
  if (!nextCatalog) return;
  // Preserve system-global per-video volume gains untouched across preset switches
  for (const v of nextCatalog.videos || []) {
    if (v.deleted) continue;
    if (Object.prototype.hasOwnProperty.call(state.videoGainOverrides, v.id)) {
      v.gainDb = clampVideoGainDb(state.videoGainOverrides[v.id]);
    } else {
      state.videoGainOverrides[v.id] = clampVideoGainDb(v.gainDb ?? 0);
    }
    v.groupName = String(v.groupName || '').trim() || inferClientGroupName(v.slug);
  }

  state.catalog = nextCatalog;
  const validVideos = (nextCatalog.videos || []).filter(v => !v.deleted);
  state.disabledVideoIds = new Set(validVideos.filter(v => v.enabled === false).map(v => v.id));

  // Sync local sliceToggleOverrides from catalog.keyboardMap
  const nextSliceOverrides = {};
  for (const entry of Object.values(nextCatalog.keyboardMap || {})) {
    for (const c of entry?.candidates || []) {
      nextSliceOverrides[c.sliceId] = Boolean(c.enabled);
    }
  }
  state.sliceToggleOverrides = nextSliceOverrides;

  const sc = nextCatalog.stageConfig || {};
  if (sc.stageGridMode !== undefined) state.stageGridMode = normalizeStageGridMode(sc.stageGridMode);
  if (sc.stageTileScale !== undefined) state.stageTileScale = clampStageTileScale(sc.stageTileScale);
  if (sc.stageSpecScale !== undefined) state.stageSpecScale = clampStageSpecScale(sc.stageSpecScale);
  if (sc.stageFadeInSec !== undefined) state.stageFadeInSec = clampStageFadeInSec(sc.stageFadeInSec);
  if (sc.stageFadeSec !== undefined) state.stageFadeSec = clampStageFadeSec(sc.stageFadeSec);
  if (sc.stageMinDisplaySec !== undefined) {
    state.stageMinDisplaySec = clampStageMinDisplaySec(sc.stageMinDisplaySec);
  }
  if (sc.stageMaxDisplaySec !== undefined) {
    state.stageMaxDisplaySec = clampStageMaxDisplaySec(sc.stageMaxDisplaySec);
  }
  if (sc.stageShowVideo !== undefined) state.stageShowVideo = Boolean(sc.stageShowVideo);
  if (sc.stageVideoPosition !== undefined) {
    state.stageVideoPosition = normalizeStageVideoPosition(sc.stageVideoPosition);
  }
  if (sc.stageVideoWidthPct !== undefined) {
    state.stageVideoWidthPct = clampStageVideoWidthPct(sc.stageVideoWidthPct);
  }
  if (sc.stageVideoHeightPct !== undefined) {
    state.stageVideoHeightPct = clampStageVideoHeightPct(sc.stageVideoHeightPct);
  }
  if (sc.stageVideoCropX !== undefined) {
    state.stageVideoCropX = clampStageVideoCropX(sc.stageVideoCropX);
  }
  if (sc.stageVideoCropY !== undefined) {
    state.stageVideoCropY = clampStageVideoCropY(sc.stageVideoCropY);
  }
  if (sc.stageVideoZoom !== undefined) {
    state.stageVideoZoom = clampStageVideoZoom(sc.stageVideoZoom);
  }
  if (sc.stageVideoBrightness !== undefined) {
    state.stageVideoBrightness = clampStageVideoBrightness(sc.stageVideoBrightness);
  }
  if (sc.stageBuildRampUp !== undefined) {
    state.stageBuildRampUp = normalizeBuildRampUp(sc.stageBuildRampUp);
  }
  if (sc.stageBuildFullSec !== undefined) {
    state.stageBuildFullSec = clampBuildFullSec(sc.stageBuildFullSec);
  }
  if (sc.stageBuildMaxFps !== undefined) {
    state.stageBuildMaxFps = clampBuildMaxFps(sc.stageBuildMaxFps);
  }
  if (sc.stageBuildSound !== undefined) {
    state.stageBuildSound = normalizeBuildSound(sc.stageBuildSound);
  }

  savePrefsToStorage();
  refreshAllUI();
  warmActiveMidiSlicesInBackground();
}

async function fetchPresetsFromServer() {
  if (state.isStaticMode) {
    presetState.activePresetId = 'default';
    presetState.presets = [
      {
        id: 'default',
        name: 'Default',
        isDefault: true,
        snapshot: captureCurrentPresetSnapshot()
      }
    ];
    updatePresetDockUi();
    return;
  }
  try {
    const res = await fetch('./api/presets');
    if (!res.ok) return;
    const store = await res.json();
    if (Array.isArray(store?.presets)) {
      presetState.presets = store.presets;
      presetState.activePresetId = store.activePresetId || 'default';
    }
    updatePresetDockUi();
    if (presetState.popoverOpen) renderPresetPopover();
  } catch {}
}

async function saveCurrentPreset({ createNew = false, name = '' } = {}) {
  if (presetState.busy || state.isStaticMode) return;
  presetState.busy = true;
  updatePresetDockUi();
  try {
    const snapshot = captureCurrentPresetSnapshot();
    const res = await fetch('./api/presets/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: presetState.activePresetId || 'default',
        name: String(name || '').trim(),
        createNew: Boolean(createNew),
        snapshot
      })
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.presetsStore?.presets) {
        presetState.presets = data.presetsStore.presets;
        presetState.activePresetId = data.presetsStore.activePresetId || 'default';
      }
      if (data?.catalog) {
        hydrateClientFromPresetCatalog(data.catalog);
      }
      presetState.creatingNew = false;
      if (presetState.popoverOpen) renderPresetPopover();
    }
  } catch (err) {
    console.error('Failed to save preset:', err);
  } finally {
    presetState.busy = false;
    updatePresetDockUi();
  }
}

async function applyPresetById(presetId) {
  if (!presetId || presetState.busy || state.isStaticMode) return;
  presetState.busy = true;
  updatePresetDockUi();
  try {
    const res = await fetch('./api/presets/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: presetId })
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.presetsStore?.presets) {
        presetState.presets = data.presetsStore.presets;
        presetState.activePresetId = data.presetsStore.activePresetId || presetId;
      }
      if (data?.catalog) {
        hydrateClientFromPresetCatalog(data.catalog);
      }
      if (presetState.popoverOpen) renderPresetPopover();
    }
  } catch (err) {
    console.error('Failed to apply preset:', err);
  } finally {
    presetState.busy = false;
    updatePresetDockUi();
  }
}

async function revertCurrentPresetChanges() {
  const active = getActivePresetEntry();
  if (!active) return;
  await applyPresetById(active.id);
}

function positionPresetPopover() {
  const pop = document.getElementById('presetPopover');
  const btn = document.getElementById('presetBrowserToggleBtn');
  if (!pop || !btn) return;
  const rect = btn.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - 258, Math.round(rect.left)));
  const bottom = Math.max(12, Math.round(window.innerHeight - rect.top + 8));
  pop.style.left = `${left}px`;
  pop.style.bottom = `${bottom}px`;
}

function syncPresetPopoverFormUi() {
  const newBtn = document.getElementById('presetPopoverNewBtn');
  const form = document.getElementById('presetNewForm');
  const input = document.getElementById('presetNewNameInput');
  if (newBtn) newBtn.classList.toggle('hidden', presetState.creatingNew);
  if (form) form.classList.toggle('hidden', !presetState.creatingNew);
  if (presetState.creatingNew && input) {
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }
}

function closePresetPopover() {
  presetState.popoverOpen = false;
  presetState.creatingNew = false;
  const pop = document.getElementById('presetPopover');
  const btn = document.getElementById('presetBrowserToggleBtn');
  if (pop) pop.classList.add('hidden');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  syncPresetPopoverFormUi();
  updatePresetDockUi();
}

async function openPresetPopover({ startCreatingNew = false } = {}) {
  closeMidiBrowserPopover();
  const pop = document.getElementById('presetPopover');
  const btn = document.getElementById('presetBrowserToggleBtn');
  const input = document.getElementById('presetNewNameInput');
  if (!pop || !btn) return;
  presetState.popoverOpen = true;
  presetState.creatingNew = Boolean(startCreatingNew);
  if (startCreatingNew && input) {
    input.value = '';
  }
  btn.setAttribute('aria-expanded', 'true');
  pop.classList.remove('hidden');
  positionPresetPopover();
  syncPresetPopoverFormUi();
  renderPresetPopover();
  updatePresetDockUi();
  await fetchPresetsFromServer();
}

function renderPresetPopover() {
  const listEl = document.getElementById('presetPopoverList');
  if (!listEl) return;
  listEl.innerHTML = '';

  const hdr = document.createElement('div');
  hdr.className = 'midi-pop-group-hdr';
  hdr.textContent = 'Presets (Mutes & Stage)';
  listEl.appendChild(hdr);

  const presets = presetState.presets || [];
  if (!presets.length) {
    const empty = document.createElement('div');
    empty.className = 'midi-pop-empty';
    empty.textContent = 'No presets saved yet';
    listEl.appendChild(empty);
    return;
  }

  for (const p of presets) {
    const isActive = p.id === presetState.activePresetId;
    const row = document.createElement('div');
    row.className = `midi-pop-row${isActive ? ' is-active' : ''}`;

    const main = document.createElement('div');
    main.className = 'midi-pop-row-main';

    const dot = document.createElement('span');
    dot.className = 'midi-pop-dot';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'midi-pop-title';
    titleSpan.textContent = p.name || 'Preset';

    main.appendChild(dot);
    main.appendChild(titleSpan);
    if (p.id === 'default' || p.isDefault) {
      const tag = document.createElement('span');
      tag.className = 'preset-default-tag';
      tag.textContent = 'go-to';
      main.appendChild(tag);
    }
    row.appendChild(main);

    if (!state.isStaticMode && p.id !== 'default' && !p.isDefault) {
      const trashBtn = document.createElement('button');
      trashBtn.type = 'button';
      trashBtn.className = 'midi-pop-trash-btn local-only-btn';
      trashBtn.title = `Delete preset "${p.name}"`;
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
          const res = await fetch('./api/presets/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: p.id })
          });
          if (res.ok) {
            const data = await res.json();
            if (data?.presetsStore?.presets) {
              presetState.presets = data.presetsStore.presets;
              presetState.activePresetId = data.presetsStore.activePresetId || 'default';
            }
            if (data?.catalog) {
              hydrateClientFromPresetCatalog(data.catalog);
            }
            renderPresetPopover();
            updatePresetDockUi();
          }
        } catch {}
      });
      row.appendChild(trashBtn);
    }

    row.addEventListener('click', async () => {
      await applyPresetById(p.id);
      closePresetPopover();
    });

    listEl.appendChild(row);
  }
}

// ============================================================================
// Left Bottom Zone: MIDI File Transport, Recorder, Overdub & Scrub Bar
// ============================================================================
const MIN_MIDI_TRANSPOSE_OCTAVES = -4;
const MAX_MIDI_TRANSPOSE_OCTAVES = 4;

const midiPlayer = {
  fileName: '',
  parsed: null,
  rawBytes: null,
  hasVideo: false,
  videoUrl: '',
  videoLeadOffsetSec: 0,
  transposeOctaves: 0,
  playing: false,
  scrubbing: false,
  elapsedSec: 0,
  lastPerfMs: 0,
  nextEventIdx: 0,
  rafId: null,
  pedalDown: false,
  pedalDownChannels: new Set(),
  pendingPedalIds: new Set(),
  activeTriggerIds: new Set()
};

const midiRecorder = {
  state: 'idle', // 'idle' | 'armed' | 'recording'
  mode: 'fresh', // 'fresh' | 'overdub'
  overdubChannel: 1,
  baseDurationSec: 0,
  workingDubFileName: '', // In-session working overdub .mid file (updated in place within current sitting)
  undoSnapshot: null, // Single-step undo: { bytes: Uint8Array } before latest overdub pass
  startPerfMs: 0,
  events: [],
  openTriggers: new Map(), // triggerId -> { midi, channel }
  uiTimer: null,
  saving: false,
  savingLabel: '',
  mediaRecorder: null,
  videoStopPromise: null,
  videoPreRollStartMs: 0,
  videoLeadSec: 0
};

const webcamState = {
  enabled: false,
  stream: null,
  busy: false
};

const browserExportState = {
  popoverOpen: false,
  aspectRatio: '9:16',
  includeBuild: !IS_LITE_BUILD,
  rendering: false,
  percent: 0,
  statusText: '',
  abortController: null
};

let activeHandSourceKey = 'none';
let pendingHandVideoSeekSec = null;
let handVideoListenersBound = false;

const SESSION_CAM_BADGE_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>`;

function bindHandVideoElementListeners() {
  if (handVideoListenersBound) return;
  const handVideoEl = document.getElementById('stageHandVideo');
  if (!handVideoEl) return;
  handVideoListenersBound = true;

  handVideoEl.addEventListener('loadedmetadata', () => {
    if (!activeHandSourceKey.startsWith('url:')) return;
    const target =
      pendingHandVideoSeekSec !== null
        ? pendingHandVideoSeekSec
        : Math.max(0, midiPlayer.elapsedSec + (midiPlayer.videoLeadOffsetSec || 0));
    pendingHandVideoSeekSec = null;
    const clamped =
      Number.isFinite(handVideoEl.duration) && handVideoEl.duration > 0
        ? Math.min(Math.max(0, handVideoEl.duration - 0.01), target)
        : target;
    try {
      handVideoEl.currentTime = clamped;
    } catch {}
    if (midiPlayer.playing && !midiPlayer.scrubbing) {
      handVideoEl.play().catch(() => {});
    }
  });

  handVideoEl.addEventListener('seeked', () => {
    if (pendingHandVideoSeekSec === null || !activeHandSourceKey.startsWith('url:')) return;
    const nextSec = pendingHandVideoSeekSec;
    pendingHandVideoSeekSec = null;
    const clamped =
      Number.isFinite(handVideoEl.duration) && handVideoEl.duration > 0
        ? Math.min(Math.max(0, handVideoEl.duration - 0.01), nextSec)
        : nextSec;
    if (Math.abs(handVideoEl.currentTime - clamped) > 0.008) {
      try {
        handVideoEl.currentTime = clamped;
      } catch {}
    }
  });
}

function requestHandVideoSeek(rawMidiSec) {
  if (!midiPlayer.parsed || !midiPlayer.hasVideo || !state.stageShowVideo) return;
  if (!activeHandSourceKey.startsWith('url:')) return;
  const handVideoEl = document.getElementById('stageHandVideo');
  if (!handVideoEl) return;
  const target = Math.max(0, Number(rawMidiSec || 0) + (midiPlayer.videoLeadOffsetSec || 0));
  if (handVideoEl.readyState < 1 || handVideoEl.seeking) {
    pendingHandVideoSeekSec = target;
    return;
  }
  const clamped =
    Number.isFinite(handVideoEl.duration) && handVideoEl.duration > 0
      ? Math.min(Math.max(0, handVideoEl.duration - 0.01), target)
      : target;
  pendingHandVideoSeekSec = null;
  if (Math.abs(handVideoEl.currentTime - clamped) > 0.008) {
    try {
      handVideoEl.currentTime = clamped;
    } catch {}
  }
}

function pauseSessionHandVideoPlayback() {
  if (!activeHandSourceKey.startsWith('url:')) return;
  const handVideoEl = document.getElementById('stageHandVideo');
  if (!handVideoEl) return;
  handVideoEl.pause();
  if (handVideoEl.playbackRate !== 1) handVideoEl.playbackRate = 1;
}

function resumeSessionHandVideoPlayback() {
  if (!midiPlayer.parsed || !midiPlayer.hasVideo || !state.stageShowVideo) return;
  if (!activeHandSourceKey.startsWith('url:')) return;
  const handVideoEl = document.getElementById('stageHandVideo');
  if (!handVideoEl) return;
  handVideoEl.muted = true;
  handVideoEl.playbackRate = 1;
  requestHandVideoSeek(midiPlayer.elapsedSec);
  if (handVideoEl.readyState >= 1) {
    handVideoEl.play().catch(() => {});
  }
}

function syncPlayingHandVideoClock() {
  if (!midiPlayer.playing || midiPlayer.scrubbing || !midiPlayer.hasVideo || !state.stageShowVideo) {
    return;
  }
  if (!activeHandSourceKey.startsWith('url:')) return;
  const handVideoEl = document.getElementById('stageHandVideo');
  if (!handVideoEl || handVideoEl.readyState < 2) return;

  const target = Math.max(0, midiPlayer.elapsedSec + (midiPlayer.videoLeadOffsetSec || 0));
  const dur = Number(handVideoEl.duration);
  if (Number.isFinite(dur) && dur > 0 && target >= dur - 0.02) {
    if (!handVideoEl.paused) handVideoEl.pause();
    if (handVideoEl.playbackRate !== 1) handVideoEl.playbackRate = 1;
    return;
  }

  if (handVideoEl.paused && !handVideoEl.seeking) {
    handVideoEl.play().catch(() => {});
  }

  const err = target - handVideoEl.currentTime;
  if (Math.abs(err) > 0.085) {
    if (handVideoEl.playbackRate !== 1) handVideoEl.playbackRate = 1;
    if (!handVideoEl.seeking) {
      try {
        handVideoEl.currentTime = target;
      } catch {}
    }
  } else if (Math.abs(err) > 0.018) {
    const rate = Math.max(0.96, Math.min(1.04, 1 + err * 0.85));
    if (Math.abs(handVideoEl.playbackRate - rate) > 0.004) {
      handVideoEl.playbackRate = rate;
    }
  } else if (handVideoEl.playbackRate !== 1) {
    handVideoEl.playbackRate = 1;
  }
}

function syncHandVideoDisplay() {
  bindHandVideoElementListeners();
  const handVideoEl = document.getElementById('stageHandVideo');
  if (!handVideoEl) return;

  handVideoEl.muted = true;
  applyHandVideoFramingStyles();

  if (midiPlayer.parsed) {
    // Session Loaded Mode: never display live webcam; only display recorded session MP4 if enabled
    if (state.stageShowVideo && midiPlayer.hasVideo && midiPlayer.videoUrl) {
      const targetKey = `url:${midiPlayer.videoUrl}`;
      if (activeHandSourceKey !== targetKey) {
        handVideoEl.pause();
        handVideoEl.srcObject = null;
        pendingHandVideoSeekSec = Math.max(
          0,
          midiPlayer.elapsedSec + (midiPlayer.videoLeadOffsetSec || 0)
        );
        handVideoEl.src = midiPlayer.videoUrl;
        handVideoEl.playbackRate = 1;
        activeHandSourceKey = targetKey;
        handVideoEl.load();
      } else {
        requestHandVideoSeek(midiPlayer.elapsedSec);
        if (midiPlayer.playing && !midiPlayer.scrubbing) {
          handVideoEl.play().catch(() => {});
        } else {
          handVideoEl.pause();
        }
      }
    } else if (activeHandSourceKey !== 'none') {
      handVideoEl.pause();
      handVideoEl.srcObject = null;
      handVideoEl.removeAttribute('src');
      handVideoEl.load();
      pendingHandVideoSeekSec = null;
      activeHandSourceKey = 'none';
    }
  } else {
    // Live Mode: show live webcam feed when enabled & Show Video is ON
    if (state.stageShowVideo && webcamState.enabled && webcamState.stream) {
      if (activeHandSourceKey !== 'live' || handVideoEl.srcObject !== webcamState.stream) {
        handVideoEl.pause();
        handVideoEl.removeAttribute('src');
        pendingHandVideoSeekSec = null;
        handVideoEl.srcObject = webcamState.stream;
        handVideoEl.playbackRate = 1;
        activeHandSourceKey = 'live';
        handVideoEl.play().catch(() => {});
      } else if (handVideoEl.paused) {
        handVideoEl.play().catch(() => {});
      }
    } else if (activeHandSourceKey !== 'none') {
      handVideoEl.pause();
      handVideoEl.srcObject = null;
      handVideoEl.removeAttribute('src');
      handVideoEl.load();
      pendingHandVideoSeekSec = null;
      activeHandSourceKey = 'none';
    }
  }

  updateStageTileSizes();
}

async function enableLiveWebcam() {
  if (webcamState.busy || webcamState.enabled) return;
  if (!navigator.mediaDevices?.getUserMedia) return;
  webcamState.busy = true;
  updateMidiTransportUi();
  try {
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        audio: false
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    // Strictly enforce zero audio capture
    for (const at of stream.getAudioTracks()) {
      at.stop();
      stream.removeTrack(at);
    }
    for (const vt of stream.getVideoTracks()) {
      vt.addEventListener('ended', () => {
        if (webcamState.stream === stream) {
          disableLiveWebcam();
        }
      });
    }
    webcamState.stream = stream;
    webcamState.enabled = true;
  } catch (err) {
    console.warn('Webcam unavailable or permission denied:', err);
    webcamState.stream = null;
    webcamState.enabled = false;
  } finally {
    webcamState.busy = false;
    syncHandVideoDisplay();
    updateMidiTransportUi();
  }
}

function disableLiveWebcam() {
  if (midiRecorder.state === 'recording') return;
  if (midiRecorder.state === 'armed') {
    abortPreRollVideoRecorder();
  }
  if (webcamState.stream) {
    for (const track of webcamState.stream.getTracks()) {
      try {
        track.stop();
      } catch {}
    }
    webcamState.stream = null;
  }
  webcamState.enabled = false;
  syncHandVideoDisplay();
  updateMidiTransportUi();
}

function toggleLiveWebcam() {
  if (midiRecorder.state === 'recording' || webcamState.busy) return;
  if (webcamState.enabled) disableLiveWebcam();
  else enableLiveWebcam();
}

function pickSupportedVideoRecorderMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp8',
    'video/webm;codecs=vp9',
    'video/webm'
  ];
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {}
  }
  return '';
}

function startPreRollVideoRecorder() {
  abortPreRollVideoRecorder();
  if (!webcamState.enabled || !webcamState.stream || typeof MediaRecorder === 'undefined') return;
  const videoTracks = webcamState.stream
    .getVideoTracks()
    .filter(t => t.readyState === 'live');
  if (!videoTracks.length) return;

  try {
    const videoOnlyStream = new MediaStream(videoTracks);
    const mimeType = pickSupportedVideoRecorderMimeType();
    const opts = { videoBitsPerSecond: 8_000_000 };
    if (mimeType) opts.mimeType = mimeType;

    const mr = new MediaRecorder(videoOnlyStream, opts);
    const chunks = [];
    mr.ondataavailable = e => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    const stopPromise = new Promise(resolve => {
      mr.onstop = () => {
        if (!chunks.length) {
          resolve(null);
          return;
        }
        resolve(new Blob(chunks, { type: mr.mimeType || mimeType || 'video/mp4' }));
      };
      mr.onerror = () => resolve(null);
    });

    mr.start(250);
    midiRecorder.mediaRecorder = mr;
    midiRecorder.videoStopPromise = stopPromise;
    midiRecorder.videoPreRollStartMs = performance.now();
    midiRecorder.videoLeadSec = 0;
  } catch (err) {
    console.warn('Could not start MediaRecorder for webcam:', err);
    midiRecorder.mediaRecorder = null;
    midiRecorder.videoStopPromise = null;
    midiRecorder.videoPreRollStartMs = 0;
    midiRecorder.videoLeadSec = 0;
  }
}

function abortPreRollVideoRecorder() {
  const mr = midiRecorder.mediaRecorder;
  midiRecorder.mediaRecorder = null;
  midiRecorder.videoStopPromise = null;
  midiRecorder.videoPreRollStartMs = 0;
  midiRecorder.videoLeadSec = 0;
  if (mr && mr.state !== 'inactive') {
    try {
      mr.ondataavailable = null;
      mr.onstop = null;
      mr.stop();
    } catch {}
  }
}

async function finalizeVideoRecorderBlob() {
  const mr = midiRecorder.mediaRecorder;
  const stopPromise = midiRecorder.videoStopPromise;
  midiRecorder.mediaRecorder = null;
  midiRecorder.videoStopPromise = null;
  if (!mr || !stopPromise) return null;
  if (mr.state !== 'inactive') {
    try {
      mr.stop();
    } catch {
      return null;
    }
  }
  try {
    return await stopPromise;
  } catch {
    return null;
  }
}

function resetOverdubSessionTracking() {
  midiRecorder.mode = 'fresh';
  midiRecorder.overdubChannel = 1;
  midiRecorder.baseDurationSec = 0;
  midiRecorder.workingDubFileName = '';
  midiRecorder.undoSnapshot = null;
}

function pickOverdubMidiChannel(parsed) {
  const sustainChannels = new Set();
  for (const ev of parsed?.events || []) {
    if (ev.type === 'sustain') {
      sustainChannels.add(Number(ev.channel || 0));
    }
  }
  const candidates = [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];
  for (const ch of candidates) {
    if (!sustainChannels.has(ch)) return ch;
  }
  return 1;
}

function unloadMidiSession({ silent = false } = {}) {
  if (midiRecorder.state === 'recording') return;
  if (midiRecorder.state === 'armed') {
    cancelMidiRecording();
  }
  if (midiPlayer.playing) {
    pauseMidiTransport();
  }
  silenceAllMidiTransportVoices(0.06);
  resetOverdubSessionTracking();
  midiPlayer.fileName = '';
  midiPlayer.parsed = null;
  midiPlayer.rawBytes = null;
  midiPlayer.hasVideo = false;
  midiPlayer.videoUrl = '';
  midiPlayer.videoLeadOffsetSec = 0;
  midiPlayer.elapsedSec = 0;
  midiPlayer.nextEventIdx = 0;
  midiPlayer.pedalDown = false;
  midiPlayer.pedalDownChannels.clear();
  invalidateMidiRollCache();
  syncHandVideoDisplay();
  if (!silent) {
    updateMidiTransportUi();
    if (midiBrowserOpen) renderMidiBrowserPopover();
  }
}

let midiLibraryFiles = [];
let midiBrowserOpen = false;
let midiInlineRenaming = false;

async function renameMidiSession(oldName, newName) {
  if (state.isStaticMode || !oldName) return null;
  const trimmed = String(newName || '').trim();
  if (!trimmed) return null;
  const res = await fetch('./api/midi/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldName, newName: trimmed })
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (Array.isArray(data?.files)) {
    midiLibraryFiles = data.files;
  }
  const updated = data?.file || null;
  if (updated?.name && midiPlayer.fileName === oldName) {
    midiPlayer.fileName = updated.name;
    if (updated.hasVideo && updated.videoUrl) {
      midiPlayer.hasVideo = true;
      midiPlayer.videoUrl = updated.videoUrl;
      syncHandVideoDisplay();
    }
    updateMidiTransportUi();
  }
  if (midiBrowserOpen) {
    renderMidiBrowserPopover();
  }
  return updated;
}

function getEditableSessionStem(fileName) {
  const raw = String(fileName || '').trim();
  if (!raw) return '';
  if (/^rec_/i.test(raw)) {
    const meta = parseRecordedTakeMeta(raw);
    if (meta.isRecording) return `Take ${meta.shortTitle}`;
  }
  return raw.replace(/\.(mid|midi)$/i, '');
}

function openMidiInlineRename() {
  if (state.isStaticMode || !midiPlayer.fileName || !midiPlayer.parsed) return;
  closeMidiBrowserPopover();
  midiInlineRenaming = true;
  const form = document.getElementById('midiRenameForm');
  const input = document.getElementById('midiRenameInput');
  if (form && input) {
    input.value = getEditableSessionStem(midiPlayer.fileName);
    updateMidiTransportUi();
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }
}

function closeMidiInlineRename() {
  if (!midiInlineRenaming) return;
  midiInlineRenaming = false;
  updateMidiTransportUi();
}

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

const MIDI_ROLL_PAD_X = 6;
const MIDI_ROLL_PAD_Y = 8;

const midiRollCache = {
  parsedRef: null,
  transposeOctaves: 0,
  spans: []
};

function invalidateMidiRollCache() {
  midiRollCache.parsedRef = null;
  midiRollCache.spans = [];
}

function buildRollNoteSpansFromEvents(events, durationSec, transposeOctaves = 0, openEndSec = null) {
  const spans = [];
  if (!Array.isArray(events) || events.length === 0) return spans;

  const activeByKey = new Map();
  const pedalChannels = new Set();
  const pendingPedalKeys = new Set();
  const totalDur = Math.max(0.05, Number(durationSec || 0.05));

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const ch = Number(ev.channel || 0);
    const tSec = Math.max(0, Number(ev.timeSec || 0));

    if (ev.type === 'sustain') {
      if (ev.pedalDown) {
        pedalChannels.add(ch);
      } else {
        pedalChannels.delete(ch);
        const prefix = `${ch}_`;
        for (const k of Array.from(pendingPedalKeys)) {
          if (!k.startsWith(prefix)) continue;
          pendingPedalKeys.delete(k);
          const sp = activeByKey.get(k);
          if (sp) {
            sp.endSec = Math.max(sp.startSec + 0.035, tSec);
            activeByKey.delete(k);
          }
        }
      }
      continue;
    }

    const rawMidi = Number(ev.midi);
    if (!Number.isFinite(rawMidi)) continue;
    const key = `${ch}_${rawMidi}`;

    if (ev.type === 'noteOn') {
      const prev = activeByKey.get(key);
      if (prev) {
        prev.endSec = Math.max(prev.startSec + 0.03, tSec);
        activeByKey.delete(key);
        pendingPedalKeys.delete(key);
      }
      const playedMidi =
        ev.plannedMidi !== undefined && ev.plannedMidi !== null
          ? ev.plannedMidi
          : resolveTransposedMidiNoteShared(ev, transposeOctaves);
      if (playedMidi === null || playedMidi < 0 || playedMidi > 127) continue;

      const isPerc =
        ch === 9 || Boolean(ev.plannedSlice?.isPerc) || isKeyPercussionOnly(playedMidi);
      const span = {
        midi: playedMidi,
        startSec: tSec,
        endSec: totalDur,
        color: getNoteColor(playedMidi, isPerc),
        isPerc
      };
      activeByKey.set(key, span);
      spans.push(span);
    } else if (ev.type === 'noteOff') {
      const sp = activeByKey.get(key);
      if (!sp) continue;
      if (pedalChannels.has(ch)) {
        pendingPedalKeys.add(key);
      } else {
        sp.endSec = Math.max(sp.startSec + 0.035, tSec);
        activeByKey.delete(key);
      }
    }
  }

  const fallbackEnd = openEndSec !== null ? Math.max(0.05, openEndSec) : totalDur;
  for (const sp of activeByKey.values()) {
    sp.endSec = Math.max(sp.startSec + 0.04, fallbackEnd);
  }
  return spans;
}

function ensureMidiRollSpans() {
  if (!midiPlayer.parsed) {
    midiRollCache.parsedRef = null;
    midiRollCache.spans = [];
    return midiRollCache.spans;
  }
  const oct = Math.round(midiPlayer.transposeOctaves || 0);
  if (midiRollCache.parsedRef === midiPlayer.parsed && midiRollCache.transposeOctaves === oct) {
    return midiRollCache.spans;
  }
  midiRollCache.parsedRef = midiPlayer.parsed;
  midiRollCache.transposeOctaves = oct;
  midiRollCache.spans = buildRollNoteSpansFromEvents(
    midiPlayer.parsed.events || [],
    Math.max(0.05, Number(midiPlayer.parsed.durationSec || 0.05)),
    oct,
    null
  );
  return midiRollCache.spans;
}

function chooseRollGridStepSec(viewDurSec, usableW) {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
  for (const s of steps) {
    const count = viewDurSec / s;
    if (usableW / Math.max(1e-3, count) >= 42) {
      return s;
    }
  }
  return 120;
}

function drawMidiRollCanvas() {
  if (state.rollCollapsed) return;
  const canvas = document.getElementById('midiRollCanvas');
  const hintEl = document.getElementById('midiRollEmptyHint');
  if (!canvas) return;

  const rect = canvas.parentElement?.getBoundingClientRect();
  const cssW = Math.max(1, Math.round(rect?.width || canvas.clientWidth || 1));
  const cssH = Math.max(1, Math.round(rect?.height || canvas.clientHeight || 1));
  if (cssW <= 2 || cssH <= 2) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const targetW = Math.round(cssW * dpr);
  const targetH = Math.round(cssH * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, cssW, cssH);

  const isArmed = midiRecorder.state === 'armed';
  const isRecording = midiRecorder.state === 'recording';
  const isOverdub = (isArmed || isRecording) && midiRecorder.mode === 'overdub';
  const hasMidi = Boolean(midiPlayer.parsed);

  const usableW = Math.max(1, cssW - MIDI_ROLL_PAD_X * 2);
  const usableH = Math.max(1, cssH - MIDI_ROLL_PAD_Y * 2);

  // Empty / Armed-fresh state (before first note is struck)
  if (!hasMidi && !isRecording) {
    if (hintEl) {
      hintEl.classList.remove('hidden');
      hintEl.textContent = isArmed
        ? 'Armed · strike a note to record'
        : state.isLiteMode
          ? 'Record or load a .mid file'
          : 'No session loaded';
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    const midY = Math.round(cssH * 0.5) + 0.5;
    ctx.beginPath();
    ctx.moveTo(MIDI_ROLL_PAD_X, midY);
    ctx.lineTo(cssW - MIDI_ROLL_PAD_X, midY);
    ctx.stroke();
    return;
  }

  if (hintEl) {
    hintEl.classList.add('hidden');
  }

  let viewDur = 1;
  let curSec = 0;
  let spans = [];

  if (isRecording && !isOverdub) {
    const recSec = Math.max(0, (performance.now() - midiRecorder.startPerfMs) / 1000);
    curSec = recSec;
    viewDur = Math.max(4.0, recSec * 1.08);
    spans = buildRollNoteSpansFromEvents(midiRecorder.events, viewDur, 0, recSec);
  } else if (hasMidi) {
    viewDur = Math.max(0.05, Number(midiPlayer.parsed.durationSec || 0.05));
    curSec = Math.max(0, Math.min(viewDur, midiPlayer.elapsedSec));
    const baseSpans = ensureMidiRollSpans();
    if (isRecording && isOverdub && midiRecorder.events.length > 0) {
      const oct = Math.round(midiPlayer.transposeOctaves || 0);
      const dubSpans = buildRollNoteSpansFromEvents(midiRecorder.events, viewDur, oct, curSec);
      spans = baseSpans.concat(dubSpans);
    } else {
      spans = baseSpans;
    }
  }

  // Subtle vertical time gridlines
  const stepSec = chooseRollGridStepSec(viewDur, usableW);
  ctx.lineWidth = 1;
  for (let t = stepSec, idx = 1; t < viewDur - 1e-4; t += stepSec, idx++) {
    const gx = Math.round(MIDI_ROLL_PAD_X + (t / viewDur) * usableW) + 0.5;
    ctx.strokeStyle = idx % 4 === 0 ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.055)';
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, cssH);
    ctx.stroke();
  }

  // Auto-fitted vertical pitch bounds (minimum 14-semitone window so sparse phrases stay balanced)
  if (spans.length > 0) {
    let minM = 127;
    let maxM = 0;
    for (let i = 0; i < spans.length; i++) {
      const m = spans[i].midi;
      if (m < minM) minM = m;
      if (m > maxM) maxM = m;
    }
    if (maxM - minM < 14) {
      const center = Math.round((minM + maxM) * 0.5);
      minM = Math.max(0, center - 7);
      maxM = Math.min(127, minM + 14);
    } else {
      minM = Math.max(0, minM - 1);
      maxM = Math.min(127, maxM + 1);
    }

    const pitchSpan = Math.max(1, maxM - minM + 1);
    const barH = Math.max(2.4, Math.min(6.0, (usableH / pitchSpan) * 0.84));
    const yTravel = Math.max(0, usableH - barH);
    const highlightActive = midiPlayer.playing || midiPlayer.scrubbing || isRecording;

    ctx.save();
    for (let i = 0; i < spans.length; i++) {
      const sp = spans[i];
      const x0 = MIDI_ROLL_PAD_X + (sp.startSec / viewDur) * usableW;
      const x1 = MIDI_ROLL_PAD_X + (Math.min(viewDur, sp.endSec) / viewDur) * usableW;
      const w = Math.max(2.0, x1 - x0);
      const normPitch = maxM > minM ? (sp.midi - minM) / (maxM - minM) : 0.5;
      const y = MIDI_ROLL_PAD_Y + (1 - normPitch) * yTravel;

      const isCrossed =
        highlightActive && curSec >= sp.startSec - 0.015 && curSec <= sp.endSec + 0.03;

      ctx.globalAlpha = isCrossed ? 1.0 : 0.46;
      ctx.fillStyle = sp.color;
      ctx.fillRect(x0, y, w, barH);

      if (isCrossed && barH >= 3.2) {
        ctx.globalAlpha = 0.32;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x0, y, w, 1);
      }
    }
    ctx.restore();
  }

  // Crisp playhead line + subtle top/bottom scrubber ticks
  const phX = MIDI_ROLL_PAD_X + Math.max(0, Math.min(1, curSec / viewDur)) * usableW;
  const phColor = isRecording ? '#f87171' : '#ffffff';
  ctx.save();
  ctx.strokeStyle = phColor;
  ctx.fillStyle = phColor;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(phX, 0);
  ctx.lineTo(phX, cssH);
  ctx.stroke();

  ctx.fillRect(phX - 2.5, 0, 5, 2.5);
  ctx.fillRect(phX - 2.5, cssH - 2.5, 5, 2.5);
  ctx.restore();
}

function replanCurrentMidiTimeline() {
  invalidateMidiRollCache();
  if (!midiPlayer.parsed || !state.catalog?.keyboardMap) {
    drawMidiRollCanvas();
    return;
  }
  planMidiTimeline({
    parsed: midiPlayer.parsed,
    keyboardMap: state.catalog.keyboardMap,
    isVideoDisabled: videoId => isVideoDisabled(videoId),
    getGroupKey: cand => getSliceInstrumentGroupKey(cand),
    getVideoGainDb: videoId => getVideoGainDb(videoId),
    stageSlotCount: getActiveStageSlotCount(),
    fadeInSec: clampStageFadeInSec(state.stageFadeInSec),
    fadeOutSec: clampStageFadeSec(state.stageFadeSec),
    minDisplaySec: clampStageMinDisplaySec(state.stageMinDisplaySec),
    maxDisplaySec: clampStageMaxDisplaySec(state.stageMaxDisplaySec),
    transposeOctaves: Math.round(midiPlayer.transposeOctaves || 0),
    velocitySensitive: Boolean(state.velocitySensitive),
    releaseSec: state.releaseSec
  });
  ensureMidiRollSpans();
  drawMidiRollCanvas();
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
  midiPlayer.pedalDownChannels.clear();
  resetDeterministicPlaybackState();
  replanCurrentMidiTimeline();
  requestHandVideoSeek(0);
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
  const browserBtn = document.getElementById('midiBrowserToggleBtn');
  const liteLoadBtn = document.getElementById('midiLiteLoadBtn');
  const liteFileLabelEl = document.getElementById('midiLiteFileLabel');
  const downloadMidBtn = document.getElementById('midiDownloadMidBtn');
  const loadedCamBadge = document.getElementById('midiLoadedCamBadge');
  const clearBtn = document.getElementById('midiClearBtn');
  const renameBtn = document.getElementById('midiRenameBtn');
  const renameForm = document.getElementById('midiRenameForm');
  const labelEl = document.getElementById('midiFileLabel');
  const camBtn = document.getElementById('midiCamToggleBtn');
  const resetBtn = document.getElementById('midiResetBtn');
  const playBtn = document.getElementById('midiPlayPauseBtn');
  const playIcon = document.getElementById('midiPlayPauseIcon');
  const recBtn = document.getElementById('midiRecordBtn');
  const cancelRecBtn = document.getElementById('midiCancelRecBtn');
  const undoBtn = document.getElementById('midiUndoBtn');
  const sessionsTabDot = document.getElementById('sessionsTabDot');
  const rollTabDot = document.getElementById('rollTabDot');
  const rollCanvas = document.getElementById('midiRollCanvas');
  const timeReadout = document.getElementById('midiTimeReadout');
  const octDownBtn = document.getElementById('midiOctDownBtn');
  const octUpBtn = document.getElementById('midiOctUpBtn');
  const octReadout = document.getElementById('midiOctReadout');

  const isArmed = midiRecorder.state === 'armed';
  const isRecording = midiRecorder.state === 'recording';
  const isOverdub = (isArmed || isRecording) && midiRecorder.mode === 'overdub';
  const hasMidi = Boolean(midiPlayer.parsed);

  if (!hasMidi || isRecording || isArmed) {
    midiInlineRenaming = false;
  }

  if (browserBtn) {
    browserBtn.classList.toggle('hidden', midiInlineRenaming);
    browserBtn.classList.toggle('has-session', hasMidi && !(isRecording && !isOverdub) && !(isArmed && !isOverdub));
    browserBtn.classList.toggle('is-open', midiBrowserOpen);
  }
  if (liteLoadBtn) {
    liteLoadBtn.disabled = isRecording || isArmed || midiRecorder.saving;
    liteLoadBtn.classList.toggle('has-session', hasMidi && !isRecording && !isArmed);
  }
  if (downloadMidBtn) {
    downloadMidBtn.disabled = !(hasMidi && !isRecording && !isArmed && !midiRecorder.saving);
  }
  if (renameForm) {
    renameForm.classList.toggle('hidden', !midiInlineRenaming);
  }
  if (loadedCamBadge) {
    loadedCamBadge.classList.toggle(
      'hidden',
      !(hasMidi && midiPlayer.hasVideo && (isOverdub || (!isRecording && !isArmed)))
    );
  }
  if (renameBtn) {
    const showRename = !state.isStaticMode && hasMidi && !midiInlineRenaming && !isRecording && !isArmed && !midiRecorder.saving;
    renameBtn.classList.toggle('hidden', !showRename);
  }
  if (clearBtn) {
    clearBtn.classList.toggle('hidden', !hasMidi || midiInlineRenaming || isRecording || isArmed || midiRecorder.saving);
  }
  if (camBtn) {
    camBtn.disabled = isRecording || isArmed || midiRecorder.saving || webcamState.busy;
    camBtn.classList.toggle('is-active', webcamState.enabled && !hasMidi);
    camBtn.setAttribute('aria-pressed', webcamState.enabled && !hasMidi ? 'true' : 'false');
    camBtn.title = hasMidi
      ? 'Webcam is only used for initial base takes (ignored during overdubs)'
      : webcamState.enabled
        ? 'Webcam ON (click to turn camera OFF)'
        : 'Turn live webcam ON for synced hand video recording (video-only)';
  }
  if (resetBtn) {
    resetBtn.disabled = !hasMidi || isRecording;
  }
  if (playBtn) {
    playBtn.disabled = !hasMidi || (isRecording && !isOverdub);
    playBtn.classList.toggle('is-playing', midiPlayer.playing);
  }
  const exportBtn = document.getElementById('midiExportVideoBtn');
  if (exportBtn) {
    const canExport = (hasMidi && !isRecording && !isArmed && !midiRecorder.saving) || browserExportState.rendering;
    exportBtn.disabled = !canExport;
    exportBtn.classList.toggle('is-open', browserExportState.popoverOpen);
    exportBtn.classList.toggle('is-rendering', browserExportState.rendering);
    exportBtn.setAttribute('aria-expanded', browserExportState.popoverOpen ? 'true' : 'false');
  }
  if (playIcon) {
    const wantHtml = midiPlayer.playing ? PAUSE_ICON_SVG : PLAY_ICON_SVG;
    if (playIcon.dataset.iconState !== (midiPlayer.playing ? 'pause' : 'play')) {
      playIcon.dataset.iconState = midiPlayer.playing ? 'pause' : 'play';
      playIcon.innerHTML = wantHtml;
    }
  }
  if (recBtn) {
    recBtn.disabled = midiRecorder.saving;
    recBtn.classList.toggle('is-armed', isArmed);
    recBtn.classList.toggle('is-recording', isRecording);
    recBtn.title = isRecording
      ? state.isLiteMode
        ? 'Stop recording (R)'
        : isOverdub
          ? 'Punch out & commit overdub pass (R)'
          : webcamState.enabled
            ? 'Stop recording & save synced .mid + .mp4 session (R)'
            : 'Stop recording & save .mid session (R)'
      : isArmed
        ? isOverdub
          ? 'Overdub armed — press Play or strike any note to start overdubbing (R to cancel)'
          : 'Armed — press any note to start at 0:00 (R to cancel)'
        : state.isLiteMode
          ? hasMidi
            ? 'Replace current recording with a new take (R)'
            : 'Record live MIDI performance (R)'
          : hasMidi
            ? midiPlayer.playing
              ? 'Punch in live MIDI overdub onto current session (R)'
              : 'Arm MIDI overdub onto loaded session (R)'
            : webcamState.enabled
              ? 'Record live MIDI + webcam hand video session (R)'
              : 'Record live MIDI session (R)';
  }
  if (cancelRecBtn) {
    const canCancelRec = (isRecording || isArmed) && !midiRecorder.saving;
    cancelRecBtn.classList.toggle('hidden', !canCancelRec);
    cancelRecBtn.title = isOverdub
      ? 'Cancel & discard current overdub pass (Esc)'
      : 'Cancel & discard current recording (Esc)';
  }
  if (sessionsTabDot) {
    const showDot = isRecording || isArmed || midiPlayer.playing;
    sessionsTabDot.classList.toggle('hidden', !showDot);
    sessionsTabDot.classList.toggle('is-rec', isRecording || isArmed);
  }
  if (rollTabDot) {
    const showRollDot = state.rollCollapsed && (hasMidi || isRecording || isArmed);
    rollTabDot.classList.toggle('hidden', !showRollDot);
    rollTabDot.classList.toggle('is-rec', isRecording || isArmed);
  }
  if (undoBtn) {
    const canUndo = Boolean(hasMidi && midiRecorder.undoSnapshot && !isRecording && !isArmed && !midiRecorder.saving);
    undoBtn.classList.toggle('hidden', !canUndo);
  }
  if (rollCanvas) {
    const canScrubRoll = hasMidi && !isRecording && !(isArmed && !isOverdub);
    rollCanvas.classList.toggle('is-disabled', !canScrubRoll);
    rollCanvas.classList.toggle('is-scrubbing', Boolean(midiPlayer.scrubbing));
  }

  const oct = Math.round(midiPlayer.transposeOctaves || 0);
  if (octDownBtn) {
    octDownBtn.disabled = !hasMidi || oct <= MIN_MIDI_TRANSPOSE_OCTAVES || isRecording;
  }
  if (octUpBtn) {
    octUpBtn.disabled = !hasMidi || oct >= MAX_MIDI_TRANSPOSE_OCTAVES || isRecording;
  }
  if (octReadout) {
    octReadout.textContent = oct > 0 ? `+${oct} oct` : `${oct} oct`;
    octReadout.classList.toggle('is-shifted', hasMidi && oct !== 0);
  }

  const dur = hasMidi ? Math.max(0.01, Number(midiPlayer.parsed.durationSec || 0.01)) : 1;
  const clampedElapsed = hasMidi ? Math.max(0, Math.min(dur, midiPlayer.elapsedSec)) : 0;

  if (labelEl) {
    if (midiRecorder.saving) {
      labelEl.textContent = midiRecorder.savingLabel || 'Saving…';
      labelEl.title = 'Saving recorded session';
    } else if (isRecording) {
      labelEl.textContent = isOverdub
        ? 'Overdubbing…'
        : webcamState.enabled
          ? 'Rec MIDI + Cam…'
          : 'Recording…';
      labelEl.title = isOverdub ? 'Recording MIDI overdub pass' : 'Recording live session';
    } else if (isArmed) {
      labelEl.textContent = isOverdub ? 'Overdub armed…' : 'Play a note…';
      labelEl.title = isOverdub
        ? 'Press Play or play any note to start overdubbing'
        : 'Armed: first note pressed becomes 0:00 of the session';
    } else if (hasMidi) {
      labelEl.textContent = formatMidiDisplayLabel(midiPlayer.fileName);
      labelEl.title = midiPlayer.fileName;
    } else {
      labelEl.textContent = 'Live · Sessions';
      labelEl.title = 'Live Mode — click to browse saved sessions & ./midi/ files';
    }
  }
  if (liteFileLabelEl) {
    if (isRecording) {
      liteFileLabelEl.textContent = 'Recording…';
      liteLoadBtn.title = 'Recording live MIDI';
    } else if (isArmed) {
      liteFileLabelEl.textContent = 'Play a note…';
      liteLoadBtn.title = 'Armed — first note starts at 0:00';
    } else if (hasMidi) {
      const disp =
        midiPlayer.fileName === 'Recording'
          ? 'Current recording'
          : formatMidiDisplayLabel(midiPlayer.fileName);
      liteFileLabelEl.textContent = disp;
      liteLoadBtn.title = `${disp} — click to replace with a .mid file`;
    } else {
      liteFileLabelEl.textContent = 'Load .mid…';
      liteLoadBtn.title = 'Load a .mid file from your computer';
    }
  }
  if (timeReadout) {
    timeReadout.classList.toggle('is-recording', isRecording || isArmed);
    if (isRecording) {
      if (isOverdub) {
        timeReadout.textContent = `● ${formatClockSec(clampedElapsed)} / ${formatClockSec(dur)}`;
      } else {
        const recSec = Math.max(0, (performance.now() - midiRecorder.startPerfMs) / 1000);
        timeReadout.textContent = `● ${formatClockSec(recSec)}`;
      }
    } else if (isArmed) {
      timeReadout.textContent = isOverdub ? `● ${formatClockSec(clampedElapsed)}` : 'Arm…';
    } else {
      timeReadout.textContent = hasMidi
        ? `${formatClockSec(clampedElapsed)} / ${formatClockSec(dur)}`
        : 'Live';
    }
  }

  drawMidiRollCanvas();
}

// --- Live Zero-Latency MIDI + Optional Webcam Session Recorder (Anchored to First Note = 0:00) ---
function clearMidiRecorderTimer() {
  if (midiRecorder.uiTimer) {
    clearInterval(midiRecorder.uiTimer);
    midiRecorder.uiTimer = null;
  }
  if (midiRecorder.rollRafId) {
    cancelAnimationFrame(midiRecorder.rollRafId);
    midiRecorder.rollRafId = null;
  }
}

function tickFreshMidiRecordingRoll() {
  if (midiRecorder.state !== 'recording' || midiRecorder.mode === 'overdub') {
    midiRecorder.rollRafId = null;
    return;
  }
  drawMidiRollCanvas();
  midiRecorder.rollRafId = requestAnimationFrame(tickFreshMidiRecordingRoll);
}

function beginOverdubRecordingPass() {
  midiRecorder.mode = 'overdub';
  midiRecorder.state = 'recording';
  midiRecorder.startPerfMs = performance.now();
  midiRecorder.events = [];
  midiRecorder.openTriggers.clear();
  const ch = midiRecorder.overdubChannel || 1;
  const curSec = Math.max(0, Math.min(midiRecorder.baseDurationSec, midiPlayer.elapsedSec));
  if (state.sustainPedalDown) {
    midiRecorder.events.push({
      timeSec: curSec,
      type: 'sustain',
      pedalDown: true,
      channel: ch
    });
  }
  clearMidiRecorderTimer();
  midiRecorder.uiTimer = setInterval(() => {
    if (midiRecorder.state === 'recording') {
      updateMidiTransportUi();
    }
  }, 150);
  updateMidiTransportUi();
}

function armMidiRecording() {
  if (midiRecorder.saving) return;
  closeMidiBrowserPopover();
  closePresetPopover();
  closeLiteReplaceConfirmPopover();

  if (state.isLiteMode && midiPlayer.parsed) {
    unloadMidiSession({ silent: true });
  }

  // Overdub mode when a MIDI file / live session is already loaded (webcam completely ignored)
  if (!state.isLiteMode && midiPlayer.parsed) {
    clearMidiRecorderTimer();
    abortPreRollVideoRecorder();
    midiRecorder.mode = 'overdub';
    midiRecorder.overdubChannel = pickOverdubMidiChannel(midiPlayer.parsed);
    midiRecorder.baseDurationSec = Math.max(0.1, Number(midiPlayer.parsed.durationSec || 0.1));
    midiRecorder.events = [];
    midiRecorder.openTriggers.clear();
    ensureAudioContext();

    if (midiPlayer.playing) {
      // Live punch-in mid-playback!
      beginOverdubRecordingPass();
    } else {
      if (midiPlayer.elapsedSec >= midiRecorder.baseDurationSec - 0.02) {
        seekMidiTransportTo(0);
      }
      midiRecorder.state = 'armed';
      updateMidiTransportUi();
    }
    return;
  }

  // Fresh base-layer recording (no session loaded)
  clearMidiRecorderTimer();
  lastPlayedSliceByMidi.clear();
  resetUnoccupiedStageSlotMemory();
  syncActiveCandidateHighlightUI(false);

  midiRecorder.mode = 'fresh';
  midiRecorder.overdubChannel = 0;
  midiRecorder.baseDurationSec = 0;
  midiRecorder.state = 'armed';
  midiRecorder.startPerfMs = 0;
  midiRecorder.events = [];
  midiRecorder.openTriggers.clear();
  startPreRollVideoRecorder();
  ensureAudioContext();
  syncHandVideoDisplay();
  updateMidiTransportUi();
}

function cancelMidiRecording() {
  clearMidiRecorderTimer();
  abortPreRollVideoRecorder();
  midiRecorder.state = 'idle';
  midiRecorder.mode = 'fresh';
  midiRecorder.startPerfMs = 0;
  midiRecorder.events = [];
  midiRecorder.openTriggers.clear();
  updateMidiTransportUi();
}

function discardActiveMidiRecording() {
  if (midiRecorder.state !== 'armed' && midiRecorder.state !== 'recording') return;
  const wasOverdub = midiRecorder.mode === 'overdub';
  clearMidiRecorderTimer();
  abortPreRollVideoRecorder();
  midiRecorder.state = 'idle';
  midiRecorder.mode = 'fresh';
  midiRecorder.startPerfMs = 0;
  midiRecorder.events = [];
  midiRecorder.openTriggers.clear();
  if (wasOverdub && midiPlayer.playing) {
    pauseMidiTransport();
  }
  syncHandVideoDisplay();
  updateMidiTransportUi();
}

function beginMidiRecordingClock(nowMs) {
  resetUnoccupiedStageSlotMemory();
  midiRecorder.state = 'recording';
  midiRecorder.startPerfMs = nowMs;
  midiRecorder.videoLeadSec = midiRecorder.mediaRecorder
    ? Math.max(0, (nowMs - midiRecorder.videoPreRollStartMs) / 1000)
    : 0;
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
  midiRecorder.rollRafId = requestAnimationFrame(tickFreshMidiRecordingRoll);
  updateMidiTransportUi();
}

function getCurrentRecordEventTimeSec(nowMs) {
  if (midiRecorder.mode === 'overdub') {
    return Math.max(0, Math.min(midiRecorder.baseDurationSec, midiPlayer.elapsedSec));
  }
  return Math.max(0, (nowMs - midiRecorder.startPerfMs) / 1000);
}

function recordLiveNoteOn(triggerId, midi, velocity = 0.92) {
  if (midiRecorder.state !== 'armed' && midiRecorder.state !== 'recording') return;
  if (!Number.isFinite(midi) || midi < 0 || midi > 127) return;

  const nowMs = performance.now();
  if (midiRecorder.state === 'armed') {
    if (midiRecorder.mode === 'overdub') {
      if (!midiPlayer.playing) {
        playMidiTransport({ keepArmedOverdub: true });
      }
      beginOverdubRecordingPass();
    } else {
      beginMidiRecordingClock(nowMs);
    }
  }

  const timeSec = getCurrentRecordEventTimeSec(nowMs);
  const recChannel = midiRecorder.mode === 'overdub' ? midiRecorder.overdubChannel || 1 : 0;
  const octShift =
    midiRecorder.mode === 'overdub' && recChannel !== 9
      ? Math.round(midiPlayer.transposeOctaves || 0)
      : 0;
  const storedMidi = Math.max(0, Math.min(127, Math.round(midi - octShift * 12)));
  const key = String(triggerId || `live_${midi}`);

  // If the same trigger (e.g. mouse glissando drag) slides directly to a new key, close prior note first
  const prev = midiRecorder.openTriggers.get(key);
  if (prev) {
    midiRecorder.events.push({
      timeSec,
      type: 'noteOff',
      midi: prev.midi,
      velocity: 0,
      channel: prev.channel ?? recChannel
    });
  }

  midiRecorder.openTriggers.set(key, { midi: storedMidi, channel: recChannel });
  midiRecorder.events.push({
    timeSec,
    type: 'noteOn',
    midi: storedMidi,
    velocity: resolveEffectiveVelocity(velocity),
    channel: recChannel
  });
}

function recordLiveNoteOff(triggerId) {
  if (midiRecorder.state !== 'recording') return;
  const key = String(triggerId || '');
  const open = midiRecorder.openTriggers.get(key);
  if (!open) return;
  midiRecorder.openTriggers.delete(key);
  const timeSec = getCurrentRecordEventTimeSec(performance.now());
  midiRecorder.events.push({
    timeSec,
    type: 'noteOff',
    midi: open.midi,
    velocity: 0,
    channel: open.channel ?? 0
  });
}

function recordLiveSustainPedal(pedalDown) {
  if (midiRecorder.state !== 'recording') return;
  const timeSec = getCurrentRecordEventTimeSec(performance.now());
  const recChannel = midiRecorder.mode === 'overdub' ? midiRecorder.overdubChannel || 1 : 0;
  midiRecorder.events.push({
    timeSec,
    type: 'sustain',
    pedalDown: Boolean(pedalDown),
    channel: recChannel
  });
}

function buildOverdubStemName(sourceFileName) {
  const cleanBase = String(sourceFileName || 'session')
    .replace(/\.(mid|midi)$/i, '')
    .replace(/_dub_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d+)?$/i, '');
  const pad = n => String(n).padStart(2, '0');
  const d = new Date();
  const stamp =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
    `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `${cleanBase}_dub_${stamp}.mid`;
}

async function stopAndSaveMidiRecording({ reachedEnd = false } = {}) {
  if (midiRecorder.state === 'armed') {
    cancelMidiRecording();
    return;
  }
  if (midiRecorder.state !== 'recording' || midiRecorder.saving) return;

  clearMidiRecorderTimer();
  const wasOverdub = midiRecorder.mode === 'overdub' && Boolean(midiPlayer.parsed);

  if (wasOverdub) {
    const baseDur = Math.max(0.1, Number(midiRecorder.baseDurationSec || midiPlayer.parsed.durationSec || 0.1));
    const stopSec = reachedEnd
      ? baseDur
      : Math.max(0.01, Math.min(baseDur, midiPlayer.elapsedSec));
    const recChannel = midiRecorder.overdubChannel || 1;

    if (midiPlayer.playing) {
      midiPlayer.playing = false;
      if (midiPlayer.rafId) {
        cancelAnimationFrame(midiPlayer.rafId);
        midiPlayer.rafId = null;
      }
      pauseSessionHandVideoPlayback();
      silenceAllMidiTransportVoices(0.12);
    }

    for (const [, open] of midiRecorder.openTriggers.entries()) {
      midiRecorder.events.push({
        timeSec: stopSec,
        type: 'noteOff',
        midi: open.midi,
        velocity: 0,
        channel: open.channel ?? recChannel
      });
    }
    midiRecorder.openTriggers.clear();

    if (state.sustainPedalDown) {
      midiRecorder.events.push({
        timeSec: stopSec,
        type: 'sustain',
        pedalDown: false,
        channel: recChannel
      });
    }

    const capturedEvents = midiRecorder.events.slice();
    midiRecorder.state = 'idle';
    midiRecorder.mode = 'fresh';
    midiRecorder.events = [];

    if (capturedEvents.length === 0) {
      requestHandVideoSeek(midiPlayer.elapsedSec);
      updateMidiTransportUi();
      return;
    }

    midiRecorder.saving = true;
    midiRecorder.savingLabel = 'Overdubbing…';
    updateMidiTransportUi();

    try {
      const priorBytes = encodeMidiFile(midiPlayer.parsed.events || []);
      const clampedNewEvents = capturedEvents.map(ev => ({
        ...ev,
        timeSec: Math.max(0, Math.min(baseDur, Number(ev.timeSec || 0)))
      }));
      const mergedEvents = [...(midiPlayer.parsed.events || []), ...clampedNewEvents];
      const mergedBytes = encodeMidiFile(mergedEvents);
      const nextParsed = parseMidiFile(mergedBytes);
      // Lock session length to the original performance duration
      nextParsed.durationSec = baseDur;

      let targetName = midiRecorder.workingDubFileName;
      let savedHasVideo = midiPlayer.hasVideo;
      let savedVideoUrl = midiPlayer.videoUrl;

      if (!state.isStaticMode) {
        const isFirstDubInSitting = !targetName;
        const payload = isFirstDubInSitting
          ? {
              fileName: buildOverdubStemName(midiPlayer.fileName),
              base64: uint8ToBase64(mergedBytes),
              ...(midiPlayer.hasVideo && midiPlayer.fileName
                ? { cloneVideoFrom: midiPlayer.fileName }
                : {})
            }
          : {
              overwriteName: targetName,
              base64: uint8ToBase64(mergedBytes)
            };

        const res = await fetch('./api/midi/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.file?.name) {
            targetName = data.file.name;
            midiRecorder.workingDubFileName = targetName;
          }
          if (data?.file?.hasVideo && data.file.videoUrl) {
            savedHasVideo = true;
            savedVideoUrl = data.file.videoUrl;
          }
          if (Array.isArray(data?.files)) midiLibraryFiles = data.files;
        }
      } else if (!targetName) {
        targetName = buildOverdubStemName(midiPlayer.fileName);
        midiRecorder.workingDubFileName = targetName;
      }

      // Single-step undo holds only the state immediately prior to this latest overdub pass
      midiRecorder.undoSnapshot = { bytes: priorBytes, baseDurationSec: baseDur };

      midiPlayer.fileName = targetName || midiPlayer.fileName;
      midiPlayer.parsed = nextParsed;
      midiPlayer.hasVideo = savedHasVideo;
      midiPlayer.videoUrl = savedVideoUrl;
      midiPlayer.elapsedSec = reachedEnd ? baseDur : stopSec;
      seekMidiEventCursor(midiPlayer.elapsedSec, { afterInclusive: true });
      replanCurrentMidiTimeline();
      syncHandVideoDisplay();
      requestHandVideoSeek(midiPlayer.elapsedSec);
      warmActiveMidiSlicesInBackground();
      if (midiBrowserOpen) renderMidiBrowserPopover();
    } catch (err) {
      console.error('Failed to save MIDI overdub:', err);
    } finally {
      midiRecorder.saving = false;
      midiRecorder.savingLabel = '';
      updateMidiTransportUi();
    }
    return;
  }

  // Fresh recording save flow
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
  const capturedVideoLeadSec = midiRecorder.videoLeadSec || 0;
  midiRecorder.state = 'idle';
  midiRecorder.mode = 'fresh';
  midiRecorder.events = [];
  midiRecorder.videoLeadSec = 0;

  if (capturedEvents.length === 0) {
    abortPreRollVideoRecorder();
    updateMidiTransportUi();
    return;
  }

  midiRecorder.saving = true;
  midiRecorder.savingLabel = 'Saving…';
  updateMidiTransportUi();

  try {
    const videoBlobPromise = state.isLiteMode ? Promise.resolve(null) : finalizeVideoRecorderBlob();
    const midiBytes = encodeMidiFile(capturedEvents);
    const parsed = parseMidiFile(midiBytes);

    if (state.isLiteMode) {
      midiRecorder.workingDubFileName = '';
      midiRecorder.undoSnapshot = null;
      midiPlayer.transposeOctaves = 0;
      midiPlayer.fileName = 'Recording';
      midiPlayer.rawBytes = midiBytes;
      midiPlayer.parsed = parsed;
      midiPlayer.hasVideo = false;
      midiPlayer.videoUrl = '';
      midiPlayer.videoLeadOffsetSec = 0;
      midiPlayer.elapsedSec = 0;
      midiPlayer.nextEventIdx = 0;
      resetDeterministicPlaybackState();
      replanCurrentMidiTimeline();
      syncHandVideoDisplay();
      warmActiveMidiSlicesInBackground();
      return;
    }

    const pad = n => String(n).padStart(2, '0');
    const d = new Date();
    let savedName =
      `rec_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
      `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.mid`;
    let savedHasVideo = false;
    let savedVideoUrl = '';
    let savedVideoLeadOffsetSec = 0;

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

      const videoBlob = await videoBlobPromise;
      if (videoBlob && videoBlob.size > 0) {
        midiRecorder.savingLabel = 'Syncing video…';
        updateMidiTransportUi();
        const qs = new URLSearchParams({
          midiName: savedName,
          leadSec: capturedVideoLeadSec.toFixed(4),
          durationSec: stopSec.toFixed(3)
        });
        const vRes = await fetch(`./api/midi/save-video?${qs.toString()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: videoBlob
        });
        if (vRes.ok) {
          const vData = await vRes.json();
          if (vData?.file?.hasVideo && vData.file.videoUrl) {
            savedHasVideo = true;
            savedVideoUrl = `${vData.file.videoUrl}?v=${Date.now()}`;
            savedVideoLeadOffsetSec = 0;
          }
          if (Array.isArray(vData?.files)) midiLibraryFiles = vData.files;
        }
      }
    } else {
      const blobUrl = URL.createObjectURL(new Blob([midiBytes], { type: 'audio/midi' }));
      const videoBlob = await videoBlobPromise;
      if (videoBlob && videoBlob.size > 0) {
        savedHasVideo = true;
        savedVideoUrl = URL.createObjectURL(videoBlob);
        savedVideoLeadOffsetSec = capturedVideoLeadSec;
      }
      midiLibraryFiles = [
        {
          name: savedName,
          url: blobUrl,
          mtimeMs: Date.now(),
          size: midiBytes.length,
          isRecording: true,
          hasVideo: savedHasVideo,
          videoUrl: savedVideoUrl || null,
          videoLeadOffsetSec: savedVideoLeadOffsetSec
        },
        ...midiLibraryFiles
      ];
    }

    // Fresh recorded session starts its own in-session overdub lineage if overdubbed right away
    midiRecorder.workingDubFileName = savedName;
    midiRecorder.undoSnapshot = null;

    midiPlayer.transposeOctaves = 0;
    savePrefsToStorage();
    midiPlayer.fileName = savedName;
    midiPlayer.rawBytes = midiBytes;
    midiPlayer.parsed = parsed;
    midiPlayer.hasVideo = savedHasVideo;
    midiPlayer.videoUrl = savedVideoUrl;
    midiPlayer.videoLeadOffsetSec = savedVideoLeadOffsetSec;
    midiPlayer.elapsedSec = 0;
    midiPlayer.nextEventIdx = 0;
    resetDeterministicPlaybackState();
    replanCurrentMidiTimeline();
    syncHandVideoDisplay();
    warmActiveMidiSlicesInBackground();
    if (midiBrowserOpen) renderMidiBrowserPopover();
  } catch (err) {
    console.error('Failed to save MIDI recording:', err);
  } finally {
    midiRecorder.saving = false;
    midiRecorder.savingLabel = '';
    updateMidiTransportUi();
  }
}

async function undoLastMidiOverdub() {
  if (!midiPlayer.parsed || !midiRecorder.undoSnapshot || midiRecorder.saving) return;
  if (midiRecorder.state !== 'idle') return;
  if (midiPlayer.playing) {
    pauseMidiTransport();
  }

  const snap = midiRecorder.undoSnapshot;
  midiRecorder.undoSnapshot = null;
  midiRecorder.saving = true;
  midiRecorder.savingLabel = 'Undoing…';
  updateMidiTransportUi();

  try {
    const restoredParsed = parseMidiFile(snap.bytes);
    if (Number.isFinite(snap.baseDurationSec) && snap.baseDurationSec > 0) {
      restoredParsed.durationSec = snap.baseDurationSec;
    }

    if (!state.isStaticMode && midiRecorder.workingDubFileName) {
      const res = await fetch('./api/midi/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          overwriteName: midiRecorder.workingDubFileName,
          base64: uint8ToBase64(snap.bytes)
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data?.files)) midiLibraryFiles = data.files;
      }
    }

    midiPlayer.parsed = restoredParsed;
    midiPlayer.elapsedSec = Math.min(restoredParsed.durationSec, midiPlayer.elapsedSec);
    seekMidiEventCursor(midiPlayer.elapsedSec, { afterInclusive: false });
    replanCurrentMidiTimeline();
    requestHandVideoSeek(midiPlayer.elapsedSec);
    warmActiveMidiSlicesInBackground();
    if (midiBrowserOpen) renderMidiBrowserPopover();
  } catch (err) {
    console.error('Failed to undo MIDI overdub:', err);
  } finally {
    midiRecorder.saving = false;
    midiRecorder.savingLabel = '';
    updateMidiTransportUi();
  }
}

const liteReplaceConfirmState = {
  open: false,
  anchorEl: null,
  onConfirm: null
};

function positionLiteReplaceConfirmPopover() {
  const pop = document.getElementById('liteReplaceConfirmPopover');
  const btn = liteReplaceConfirmState.anchorEl;
  if (!pop || !btn) return;
  const rect = btn.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - 236, Math.round(rect.left)));
  const bottom = Math.max(12, Math.round(window.innerHeight - rect.top + 8));
  pop.style.left = `${left}px`;
  pop.style.bottom = `${bottom}px`;
}

function closeLiteReplaceConfirmPopover() {
  liteReplaceConfirmState.open = false;
  liteReplaceConfirmState.anchorEl = null;
  liteReplaceConfirmState.onConfirm = null;
  const pop = document.getElementById('liteReplaceConfirmPopover');
  if (pop) pop.classList.add('hidden');
}

function openLiteReplaceConfirmPopover(anchorEl, msg, onConfirm) {
  closeMidiBrowserPopover();
  closePresetPopover();
  if (!browserExportState.rendering) closeMidiExportPopover();
  liteReplaceConfirmState.open = true;
  liteReplaceConfirmState.anchorEl = anchorEl;
  liteReplaceConfirmState.onConfirm = onConfirm;
  const msgEl = document.getElementById('liteReplaceConfirmMsg');
  if (msgEl) msgEl.textContent = msg || 'Replace current recording?';
  const pop = document.getElementById('liteReplaceConfirmPopover');
  if (pop) {
    pop.classList.remove('hidden');
    positionLiteReplaceConfirmPopover();
  }
}

function downloadCurrentMidiBytes() {
  if (!midiPlayer.parsed) return;
  const bytes = midiPlayer.rawBytes || encodeMidiFile(midiPlayer.parsed.events || []);
  const rawName = String(midiPlayer.fileName || '').trim();
  const stem =
    !rawName || rawName === 'Recording'
      ? 'everytone_recording'
      : rawName.replace(/\.(mid|midi)$/i, '');
  const blob = new Blob([bytes], { type: 'audio/midi' });
  const dlUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = dlUrl;
  a.download = `${stem}.mid`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(dlUrl), 30_000);
}

function toggleMidiRecording() {
  if (midiRecorder.state === 'idle') {
    if (state.isLiteMode && midiPlayer.parsed) {
      const recBtn = document.getElementById('midiRecordBtn');
      openLiteReplaceConfirmPopover(recBtn, 'Replace current recording?', () => {
        unloadMidiSession({ silent: true });
        armMidiRecording();
      });
      return;
    }
    armMidiRecording();
  } else {
    stopAndSaveMidiRecording();
  }
}

// --- Lightweight ./midi/ File Browser Popover ---
async function fetchMidiLibraryList() {
  if (state.isLiteMode) return midiLibraryFiles;
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

  resetOverdubSessionTracking();
  midiPlayer.fileName = entry.name;
  midiPlayer.parsed = parsed;
  midiPlayer.hasVideo = Boolean(entry.hasVideo && entry.videoUrl);
  midiPlayer.videoUrl = entry.hasVideo && entry.videoUrl ? entry.videoUrl : '';
  midiPlayer.videoLeadOffsetSec = Number(entry.videoLeadOffsetSec || 0);
  midiPlayer.elapsedSec = 0;
  midiPlayer.nextEventIdx = 0;
  midiPlayer.pedalDownChannels.clear();
  resetDeterministicPlaybackState();
  replanCurrentMidiTimeline();
  syncHandVideoDisplay();
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

function positionMidiExportPopover() {
  const pop = document.getElementById('midiExportPopover');
  const btn = document.getElementById('midiExportVideoBtn');
  if (!pop || !btn) return;
  const rect = btn.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - 272, Math.round(rect.left - 80)));
  const bottom = Math.max(12, Math.round(window.innerHeight - rect.top + 8));
  pop.style.left = `${left}px`;
  pop.style.bottom = `${bottom}px`;
}

function syncMidiExportPopoverUi() {
  const resLabel = document.getElementById('midiExportResLabel');
  const spec =
    BROWSER_ASPECT_SPECS[normalizeBrowserAspectRatio(browserExportState.aspectRatio)] ||
    BROWSER_ASPECT_SPECS['9:16'];
  if (resLabel) {
    resLabel.textContent = `${spec.width}×${spec.height}`;
  }
  document.querySelectorAll('.stage-grid-pill[data-export-aspect]').forEach(btn => {
    const isAct = btn.dataset.exportAspect === spec.key;
    btn.classList.toggle('is-active', isAct);
    btn.disabled = browserExportState.rendering;
  });

  const buildToggle = document.getElementById('midiExportBuildToggle');
  if (buildToggle) {
    buildToggle.checked = Boolean(browserExportState.includeBuild);
    buildToggle.disabled = browserExportState.rendering;
  }
  const buildReadout = document.getElementById('midiExportBuildReadout');
  if (buildReadout) {
    buildReadout.textContent = browserExportState.includeBuild ? 'On' : 'Off';
  }

  const progWrap = document.getElementById('midiExportProgressWrap');
  const progFill = document.getElementById('midiExportProgressFill');
  const statusEl = document.getElementById('midiExportStatusText');
  const pctEl = document.getElementById('midiExportPctText');
  const startBtn = document.getElementById('midiExportStartBtn');
  const cancelBtn = document.getElementById('midiExportCancelBtn');

  const showStatus = browserExportState.rendering || Boolean(browserExportState.statusText);
  if (progWrap) progWrap.classList.toggle('hidden', !showStatus);
  if (progFill) progFill.style.width = `${Math.max(0, Math.min(100, browserExportState.percent))}%`;
  if (statusEl) statusEl.textContent = browserExportState.statusText || '';
  if (pctEl) {
    pctEl.textContent = browserExportState.rendering ? `${browserExportState.percent}%` : '';
  }
  if (startBtn) {
    startBtn.disabled =
      browserExportState.rendering || !midiPlayer.parsed || !isBrowserOfflineExportSupported();
    startBtn.textContent = browserExportState.rendering
      ? `Rendering ${spec.label}…`
      : `Render & Download ${spec.label} MP4`;
  }
  if (cancelBtn) {
    cancelBtn.classList.toggle('hidden', !browserExportState.rendering);
  }
}

function closeMidiExportPopover() {
  browserExportState.popoverOpen = false;
  const pop = document.getElementById('midiExportPopover');
  if (pop) pop.classList.add('hidden');
  updateMidiTransportUi();
}

function openMidiExportPopover() {
  if (!midiPlayer.parsed && !browserExportState.rendering) return;
  closeMidiBrowserPopover();
  closePresetPopover();
  browserExportState.popoverOpen = true;
  const pop = document.getElementById('midiExportPopover');
  if (pop) {
    pop.classList.remove('hidden');
    positionMidiExportPopover();
  }
  if (!browserExportState.rendering && !isBrowserOfflineExportSupported()) {
    browserExportState.statusText = 'WebCodecs MP4 export requires modern Chrome/Safari/Edge.';
  }
  syncMidiExportPopoverUi();
  updateMidiTransportUi();
}

async function runBrowserMp4Export() {
  if (browserExportState.rendering || !midiPlayer.parsed || !state.catalog) return;
  if (midiPlayer.playing) {
    pauseMidiTransport();
  }

  const ac = new AbortController();
  browserExportState.rendering = true;
  browserExportState.percent = 1;
  browserExportState.statusText = 'Starting offline render…';
  browserExportState.abortController = ac;
  syncMidiExportPopoverUi();
  updateMidiTransportUi();

  try {
    const atlasAssets = threeStage?.getAtlasAssets?.() || {};
    const res = await renderMidiSessionInBrowserToMp4({
      parsedMidi: midiPlayer.parsed,
      sessionName: midiPlayer.fileName || 'everytone_session',
      aspectRatio: browserExportState.aspectRatio,
      fps: 30,
      catalog: state.catalog,
      keyboardMap: state.catalog.keyboardMap || {},
      isVideoDisabled: videoId => isVideoDisabled(videoId),
      getGroupKey: cand => getSliceInstrumentGroupKey(cand),
      getVideoGainDb: videoId => getVideoGainDb(videoId),
      loadAudioBuffer: url => loadAudioBuffer(url),
      resolveMediaUrl: url => withBust(url),
      atlasManifest: atlasAssets.atlasManifest || null,
      atlasImage: atlasAssets.atlasImage || null,
      gridMode: normalizeStageGridMode(state.stageGridMode),
      tileScale: clampStageTileScale(state.stageTileScale),
      specScale: clampStageSpecScale(state.stageSpecScale),
      fadeInSec: clampStageFadeInSec(state.stageFadeInSec),
      fadeOutSec: clampStageFadeSec(state.stageFadeSec),
      minDisplaySec: clampStageMinDisplaySec(state.stageMinDisplaySec),
      maxDisplaySec: clampStageMaxDisplaySec(state.stageMaxDisplaySec),
      transposeOctaves: Math.round(midiPlayer.transposeOctaves || 0),
      velocitySensitive: Boolean(state.velocitySensitive),
      showHandVideo: Boolean(state.stageShowVideo && midiPlayer.hasVideo && midiPlayer.videoUrl),
      handVideoUrl: midiPlayer.hasVideo ? midiPlayer.videoUrl : '',
      handVideoLeadOffsetSec: Number(midiPlayer.videoLeadOffsetSec || 0),
      videoPosition: normalizeStageVideoPosition(state.stageVideoPosition),
      videoWidthPct: clampStageVideoWidthPct(state.stageVideoWidthPct),
      videoHeightPct: clampStageVideoHeightPct(state.stageVideoHeightPct),
      videoCropX: clampStageVideoCropX(state.stageVideoCropX),
      videoCropY: clampStageVideoCropY(state.stageVideoCropY),
      videoZoom: clampStageVideoZoom(state.stageVideoZoom),
      videoBrightness: clampStageVideoBrightness(state.stageVideoBrightness),
      includeBuild: Boolean(browserExportState.includeBuild),
      buildFullSec: clampBuildFullSec(state.stageBuildFullSec),
      buildMaxFps: clampBuildMaxFps(state.stageBuildMaxFps),
      buildRampUp: normalizeBuildRampUp(state.stageBuildRampUp),
      buildSound: normalizeBuildSound(state.stageBuildSound),
      signal: ac.signal,
      onProgress: ({ phase, percent }) => {
        browserExportState.percent = percent;
        browserExportState.statusText = phase;
        syncMidiExportPopoverUi();
      }
    });

    const dlUrl = URL.createObjectURL(res.blob);
    const a = document.createElement('a');
    a.href = dlUrl;
    a.download = res.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(dlUrl), 45_000);

    browserExportState.percent = 100;
    browserExportState.statusText = `Downloaded ${res.fileName} (${res.durationSec}s)`;
  } catch (err) {
    if (err?.name === 'AbortError') {
      browserExportState.percent = 0;
      browserExportState.statusText = 'Export cancelled';
    } else {
      console.error('Browser MP4 export failed:', err);
      browserExportState.statusText = `Error: ${err?.message || 'Export failed'}`;
    }
  } finally {
    browserExportState.rendering = false;
    browserExportState.abortController = null;
    syncMidiExportPopoverUi();
    updateMidiTransportUi();
  }
}

async function openMidiBrowserPopover() {
  closePresetPopover();
  if (!browserExportState.rendering) closeMidiExportPopover();
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
    const isNamed = Boolean(entry.isNamedSession);
    if (isNamed) {
      addItemToGroup('Named Sessions', entry, entry.name.replace(/\.(mid|midi)$/i, ''));
    }
  }
  for (const entry of midiLibraryFiles) {
    const isNamed = Boolean(entry.isNamedSession);
    const isRec = !isNamed && Boolean(entry.isRecording || /^rec_/i.test(entry.name));
    if (isRec) {
      const meta = parseRecordedTakeMeta(entry.name, entry.mtimeMs);
      addItemToGroup(meta.dateHeader, entry, meta.shortTitle);
    }
  }
  for (const entry of midiLibraryFiles) {
    const isNamed = Boolean(entry.isNamedSession);
    const isRec = !isNamed && Boolean(entry.isRecording || /^rec_/i.test(entry.name));
    if (!isNamed && !isRec) {
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
      if (entry.hasVideo) {
        const camBadge = document.createElement('span');
        camBadge.className = 'midi-pop-cam-badge';
        camBadge.title = 'Includes synced hand video (.mp4)';
        camBadge.innerHTML = SESSION_CAM_BADGE_SVG;
        main.appendChild(camBadge);
      }
      row.appendChild(main);

      if (!state.isStaticMode) {
        const renamePopBtn = document.createElement('button');
        renamePopBtn.type = 'button';
        renamePopBtn.className = 'midi-pop-rename-btn local-only-btn';
        renamePopBtn.title = `Rename ${entry.name}`;
        renamePopBtn.innerHTML = PENCIL_ICON_SVG;
        renamePopBtn.addEventListener('click', e => {
          e.stopPropagation();
          const input = document.createElement('input');
          input.type = 'text';
          input.maxLength = 64;
          input.className = 'midi-pop-rename-input';
          input.value = getEditableSessionStem(entry.name);
          titleSpan.replaceWith(input);
          renamePopBtn.classList.add('hidden');
          input.focus();
          input.select();

          let done = false;
          const finish = async commit => {
            if (done) return;
            done = true;
            if (commit) {
              const nextVal = input.value.trim();
              if (nextVal && nextVal !== displayTitle) {
                await renameMidiSession(entry.name, nextVal);
                return;
              }
            }
            renderMidiBrowserPopover();
          };
          input.addEventListener('click', ev => ev.stopPropagation());
          input.addEventListener('keydown', ev => {
            ev.stopPropagation();
            if (ev.key === 'Enter') {
              ev.preventDefault();
              finish(true);
            } else if (ev.key === 'Escape') {
              ev.preventDefault();
              finish(false);
            }
          });
          input.addEventListener('blur', () => finish(true));
        });
        row.appendChild(renamePopBtn);

        const trashBtn = document.createElement('button');
        trashBtn.type = 'button';
        trashBtn.className = 'midi-pop-trash-btn local-only-btn';
        trashBtn.title = entry.hasVideo
          ? `Move session (${entry.name} + .mp4) to _trash/midi/`
          : `Move ${entry.name} to _trash/midi/`;
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
                unloadMidiSession({ silent: true });
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

  const isLiveOrOverdubSession =
    ((midiRecorder.state === 'armed' || midiRecorder.state === 'recording') &&
      midiRecorder.mode === 'overdub') ||
    hasActiveLivePerformVoice();

  startHeldVoice({
    triggerId,
    midi: playedMidi,
    slice: cand,
    playbackRate: cand.playbackRate || 1.0,
    velocity: ev.velocity ?? 0.9,
    forcedSlotIdx:
      !isLiveOrOverdubSession && Number.isInteger(ev.plannedSlotIdx) ? ev.plannedSlotIdx : null
  });
}

function silenceAllMidiTransportVoices(releaseSec = null) {
  midiPlayer.pedalDown = false;
  midiPlayer.pedalDownChannels.clear();
  midiPlayer.pendingPedalIds.clear();
  for (const tid of Array.from(midiPlayer.activeTriggerIds)) {
    midiPlayer.activeTriggerIds.delete(tid);
    releaseHeldVoice(tid, releaseSec);
  }
  if (releaseSec !== null && Number.isFinite(releaseSec)) {
    for (let i = 0; i < MAX_STAGE_SLOTS; i++) {
      const sv = stageSlots[i]?.voice;
      if (
        sv &&
        !sv.audioCompleted &&
        (String(sv.triggerId || '').startsWith('midifile_') ||
          String(sv.triggerId || '').startsWith('midiscrub_'))
      ) {
        applyVoiceReleaseRamp(sv, releaseSec);
      }
    }
    for (const dv of Array.from(detachedRingingVoices)) {
      if (dv.audioCompleted) {
        detachedRingingVoices.delete(dv);
        continue;
      }
      if (isTransportTriggerId(dv.triggerId)) {
        applyVoiceReleaseRamp(dv, releaseSec);
      }
    }
  }
}

function seekMidiEventCursor(targetSec, { afterInclusive = false } = {}) {
  if (!midiPlayer.parsed) {
    midiPlayer.nextEventIdx = 0;
    midiPlayer.pedalDown = false;
    midiPlayer.pedalDownChannels.clear();
    return;
  }
  const evs = midiPlayer.parsed.events;
  let idx = 0;
  const pedalCh = new Set();
  while (
    idx < evs.length &&
    (afterInclusive ? evs[idx].timeSec <= targetSec + 1e-5 : evs[idx].timeSec < targetSec - 1e-4)
  ) {
    if (evs[idx].type === 'sustain') {
      const ch = Number(evs[idx].channel || 0);
      if (evs[idx].pedalDown) pedalCh.add(ch);
      else pedalCh.delete(ch);
    }
    idx++;
  }
  midiPlayer.pedalDownChannels = pedalCh;
  midiPlayer.pedalDown = pedalCh.size > 0;
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
    midiPlayer.pedalDownChannels.clear();
    resetDeterministicPlaybackState();
  } else {
    seekMidiEventCursor(clamped, { afterInclusive: false });
  }
  requestHandVideoSeek(midiPlayer.elapsedSec);
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
  requestHandVideoSeek(clampedTo);
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
      const ch = Number(ev.channel || 0);
      if (ev.type === 'sustain') {
        if (ev.pedalDown) {
          midiPlayer.pedalDownChannels.add(ch);
        } else {
          midiPlayer.pedalDownChannels.delete(ch);
          const prefix = `midifile_${ch}_`;
          for (const tid of Array.from(midiPlayer.pendingPedalIds)) {
            if (!tid.startsWith(prefix)) continue;
            midiPlayer.pendingPedalIds.delete(tid);
            midiPlayer.activeTriggerIds.delete(tid);
            releaseHeldVoice(tid);
          }
        }
        midiPlayer.pedalDown = midiPlayer.pedalDownChannels.size > 0;
      } else if (ev.type === 'noteOn') {
        const playedMidi =
          ev.plannedMidi !== undefined && ev.plannedMidi !== null
            ? ev.plannedMidi
            : resolveTransposedMidiNote(ev);
        if (playedMidi !== null) {
          const tid = `midifile_${ch}_${ev.midi}`;
          midiPlayer.pendingPedalIds.delete(tid);
          midiPlayer.activeTriggerIds.add(tid);
          startPlannedMidiEventVoice(tid, ev);
        }
      } else if (ev.type === 'noteOff') {
        const tid = `midifile_${ch}_${ev.midi}`;
        if (midiPlayer.pedalDownChannels.has(ch) && midiPlayer.activeTriggerIds.has(tid)) {
          midiPlayer.pendingPedalIds.add(tid);
        } else {
          midiPlayer.activeTriggerIds.delete(tid);
          releaseHeldVoice(tid);
        }
      }
    }

    // Fixed-length overdub auto-stop: never record past the original performance length
    if (
      midiRecorder.state === 'recording' &&
      midiRecorder.mode === 'overdub' &&
      midiPlayer.elapsedSec >= midiRecorder.baseDurationSec
    ) {
      midiPlayer.elapsedSec = midiRecorder.baseDurationSec;
      stopAndSaveMidiRecording({ reachedEnd: true });
      return;
    }

    syncPlayingHandVideoClock();
    updateMidiTransportUi();

    if (
      midiPlayer.nextEventIdx >= evs.length &&
      midiPlayer.elapsedSec >= midiPlayer.parsed.durationSec + 0.45
    ) {
      silenceAllMidiTransportVoices();
      midiPlayer.playing = false;
      midiPlayer.elapsedSec = midiPlayer.parsed.durationSec;
      midiPlayer.rafId = null;
      pauseSessionHandVideoPlayback();
      requestHandVideoSeek(midiPlayer.elapsedSec);
      updateMidiTransportUi();
      return;
    }
  }

  midiPlayer.rafId = requestAnimationFrame(tickMidiTransport);
}

function playMidiTransport({ keepArmedOverdub = false } = {}) {
  if (!midiPlayer.parsed || midiPlayer.playing || midiRecorder.state === 'recording') return;
  if (buildPreviewState.running) {
    stopIntroBuildPreview();
  }
  if (midiRecorder.state === 'armed' && midiRecorder.mode !== 'overdub') {
    cancelMidiRecording();
  }
  closeMidiBrowserPopover();
  closePresetPopover();
  ensureAudioContext();
  replanCurrentMidiTimeline();

  const atEnd = midiPlayer.elapsedSec >= midiPlayer.parsed.durationSec - 0.02;
  const atStart = midiPlayer.elapsedSec <= 0.005;
  if (atEnd || atStart) {
    midiPlayer.elapsedSec = 0;
    midiPlayer.nextEventIdx = 0;
    midiPlayer.pedalDown = false;
    midiPlayer.pedalDownChannels.clear();
    resetDeterministicPlaybackState();
  } else {
    seekMidiEventCursor(midiPlayer.elapsedSec, { afterInclusive: false });
  }

  midiPlayer.playing = true;
  midiPlayer.lastPerfMs = performance.now();
  resumeSessionHandVideoPlayback();
  if (midiRecorder.state === 'armed' && midiRecorder.mode === 'overdub' && !keepArmedOverdub) {
    beginOverdubRecordingPass();
  }
  updateMidiTransportUi();
  midiPlayer.rafId = requestAnimationFrame(tickMidiTransport);
}

function pauseMidiTransport() {
  if (midiRecorder.state === 'recording' && midiRecorder.mode === 'overdub') {
    stopAndSaveMidiRecording();
    return;
  }
  if (!midiPlayer.playing) return;
  midiPlayer.playing = false;
  if (midiPlayer.rafId) {
    cancelAnimationFrame(midiPlayer.rafId);
    midiPlayer.rafId = null;
  }
  pauseSessionHandVideoPlayback();
  requestHandVideoSeek(midiPlayer.elapsedSec);
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
  if (midiRecorder.state === 'recording') {
    await stopAndSaveMidiRecording();
  } else if (midiRecorder.state === 'armed') {
    cancelMidiRecording();
  }
  pauseMidiTransport();
  const arrBuf = await file.arrayBuffer();
  const bytes = new Uint8Array(arrBuf);
  const parsed = parseMidiFile(bytes);

  let savedName = file.name;
  if (!state.isStaticMode && !state.isLiteMode) {
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

  resetOverdubSessionTracking();
  midiPlayer.fileName = savedName;
  midiPlayer.rawBytes = bytes;
  midiPlayer.parsed = parsed;
  midiPlayer.hasVideo = false;
  midiPlayer.videoUrl = '';
  midiPlayer.videoLeadOffsetSec = 0;
  midiPlayer.elapsedSec = 0;
  midiPlayer.nextEventIdx = 0;
  midiPlayer.pedalDown = false;
  midiPlayer.pedalDownChannels.clear();
  resetDeterministicPlaybackState();
  replanCurrentMidiTimeline();
  syncHandVideoDisplay();

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
      if (state.isLiteMode && buildPreviewState.running) {
        stopIntroBuildPreview();
      }
      setChromeCollapsed(!state.chromeCollapsed);
    });
  }

  const liteStartBtn = document.getElementById('liteStartBtn');
  if (liteStartBtn) {
    liteStartBtn.addEventListener('click', () => {
      dismissLiteSplashAndStartBuild();
    });
  }

  const liteResetMutesBtn = document.getElementById('liteResetMutesBtn');
  if (liteResetMutesBtn) {
    liteResetMutesBtn.addEventListener('click', () => {
      resetLiteUserCustomizations();
    });
  }

  // Tabbed Stage & Camera Config Footer (Layout | Motion | Camera)
  document.querySelectorAll('.stage-cfg-tab[data-cfg-tab]').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      const tab = tabBtn.dataset.cfgTab;
      if (tab) setStageSettingsTab(tab, true);
    });
  });

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
    stageTileScaleSlider.addEventListener('dblclick', () => {
      setStageTileScale(1.0, true);
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
  const stageMinDisplaySlider = document.getElementById('stageMinDisplaySlider');
  if (stageMinDisplaySlider) {
    stageMinDisplaySlider.addEventListener('input', () => {
      setStageMinDisplaySec(Number(stageMinDisplaySlider.value), true);
    });
    stageMinDisplaySlider.addEventListener('change', () => {
      setStageMinDisplaySec(Number(stageMinDisplaySlider.value), true);
    });
    stageMinDisplaySlider.addEventListener('dblclick', () => {
      setStageMinDisplaySec(0.7, true);
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
    stageMaxDisplaySlider.addEventListener('dblclick', () => {
      setStageMaxDisplaySec(1.0, true);
    });
  }
  const stageShowVideoToggle = document.getElementById('stageShowVideoToggle');
  if (stageShowVideoToggle) {
    stageShowVideoToggle.addEventListener('change', () => {
      setStageShowVideo(stageShowVideoToggle.checked, true);
    });
  }
  document.querySelectorAll('.stage-grid-pill[data-video-pos]').forEach(btn => {
    btn.addEventListener('click', () => {
      const pos = btn.dataset.videoPos;
      if (pos) setStageVideoPosition(pos, true);
    });
  });
  const stageVideoWidthSlider = document.getElementById('stageVideoWidthSlider');
  if (stageVideoWidthSlider) {
    stageVideoWidthSlider.addEventListener('input', () => {
      setStageVideoWidthPct(Number(stageVideoWidthSlider.value), true);
    });
    stageVideoWidthSlider.addEventListener('change', () => {
      setStageVideoWidthPct(Number(stageVideoWidthSlider.value), true);
    });
    stageVideoWidthSlider.addEventListener('dblclick', () => {
      setStageVideoWidthPct(50, true);
    });
  }
  const stageVideoHeightSlider = document.getElementById('stageVideoHeightSlider');
  if (stageVideoHeightSlider) {
    stageVideoHeightSlider.addEventListener('input', () => {
      setStageVideoHeightPct(Number(stageVideoHeightSlider.value), true);
    });
    stageVideoHeightSlider.addEventListener('change', () => {
      setStageVideoHeightPct(Number(stageVideoHeightSlider.value), true);
    });
    stageVideoHeightSlider.addEventListener('dblclick', () => {
      setStageVideoHeightPct(23, true);
    });
  }
  const stageVideoBrightnessSlider = document.getElementById('stageVideoBrightnessSlider');
  if (stageVideoBrightnessSlider) {
    stageVideoBrightnessSlider.addEventListener('input', () => {
      setStageVideoBrightness(Number(stageVideoBrightnessSlider.value), true);
    });
    stageVideoBrightnessSlider.addEventListener('change', () => {
      setStageVideoBrightness(Number(stageVideoBrightnessSlider.value), true);
    });
    stageVideoBrightnessSlider.addEventListener('dblclick', () => {
      setStageVideoBrightness(1.0, true);
    });
  }
  const stageVideoZoomSlider = document.getElementById('stageVideoZoomSlider');
  if (stageVideoZoomSlider) {
    stageVideoZoomSlider.addEventListener('input', () => {
      setStageVideoZoom(Number(stageVideoZoomSlider.value) / 100, true);
    });
    stageVideoZoomSlider.addEventListener('change', () => {
      setStageVideoZoom(Number(stageVideoZoomSlider.value) / 100, true);
    });
    stageVideoZoomSlider.addEventListener('dblclick', () => {
      setStageVideoZoom(1.0, true);
    });
  }
  const stageVideoPanXSlider = document.getElementById('stageVideoPanXSlider');
  if (stageVideoPanXSlider) {
    stageVideoPanXSlider.addEventListener('input', () => {
      setStageVideoCropX(Number(stageVideoPanXSlider.value), true);
    });
    stageVideoPanXSlider.addEventListener('change', () => {
      setStageVideoCropX(Number(stageVideoPanXSlider.value), true);
    });
    stageVideoPanXSlider.addEventListener('dblclick', () => {
      setStageVideoCropX(50, true);
    });
  }
  const stageVideoPosSlider = document.getElementById('stageVideoPosSlider');
  if (stageVideoPosSlider) {
    stageVideoPosSlider.addEventListener('input', () => {
      setStageVideoCropY(Number(stageVideoPosSlider.value), true);
    });
    stageVideoPosSlider.addEventListener('change', () => {
      setStageVideoCropY(Number(stageVideoPosSlider.value), true);
    });
    stageVideoPosSlider.addEventListener('dblclick', () => {
      setStageVideoCropY(50, true);
    });
  }
  const stageBuildPlayBtn = document.getElementById('stageBuildPlayBtn');
  if (stageBuildPlayBtn) {
    stageBuildPlayBtn.addEventListener('click', () => {
      toggleIntroBuildPreview();
    });
  }
  const stageBuildRampUpToggle = document.getElementById('stageBuildRampUpToggle');
  if (stageBuildRampUpToggle) {
    stageBuildRampUpToggle.addEventListener('change', () => {
      setStageBuildRampUp(stageBuildRampUpToggle.checked, true);
    });
  }
  document.querySelectorAll('.stage-grid-pill[data-build-sound]').forEach(btn => {
    btn.addEventListener('click', () => {
      setStageBuildSound(btn.dataset.buildSound === 'on', true);
    });
  });
  const stageBuildDurationSlider = document.getElementById('stageBuildDurationSlider');
  if (stageBuildDurationSlider) {
    stageBuildDurationSlider.addEventListener('input', () => {
      setStageBuildDurationSec(Number(stageBuildDurationSlider.value), true);
    });
    stageBuildDurationSlider.addEventListener('change', () => {
      setStageBuildDurationSec(Number(stageBuildDurationSlider.value), true);
    });
    stageBuildDurationSlider.addEventListener('dblclick', () => {
      setStageBuildDurationSec(5.0, true);
    });
  }
  const stageBuildMaxFpsSlider = document.getElementById('stageBuildMaxFpsSlider');
  if (stageBuildMaxFpsSlider) {
    stageBuildMaxFpsSlider.addEventListener('input', () => {
      setStageBuildMaxFps(Number(stageBuildMaxFpsSlider.value), true);
    });
    stageBuildMaxFpsSlider.addEventListener('change', () => {
      setStageBuildMaxFps(Number(stageBuildMaxFpsSlider.value), true);
    });
    stageBuildMaxFpsSlider.addEventListener('dblclick', () => {
      setStageBuildMaxFps(12, true);
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
  const velocityToggleBtn = document.getElementById('velocityToggleBtn');
  if (velocityToggleBtn) {
    velocityToggleBtn.addEventListener('click', () => {
      state.velocitySensitive = !state.velocitySensitive;
      syncVelocityToggleUI();
      replanCurrentMidiTimeline();
      savePrefsToStorage();
    });
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

      // Option/Alt-click any piano key to hear its pure triangle reference tone (and probe it in an open sample!)
      if (e.altKey) {
        if (bladeState.open && bladeState.slice && midi >= MIN_MIDI) {
          setSelectionFocus('blade');
          setBladeTestToneMidi(midi, true);
        } else {
          selectKeyForConfig(midi, false);
          playReferenceTone(midi);
        }
        return;
      }

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

  // MIDI Transport: ./midi/ Browser + Clear + Webcam + Record + Reset/Rewind + Play/Pause + Scrub Bar
  const midiBrowserToggleBtn = document.getElementById('midiBrowserToggleBtn');
  const midiRenameBtn = document.getElementById('midiRenameBtn');
  const midiRenameForm = document.getElementById('midiRenameForm');
  const midiRenameInput = document.getElementById('midiRenameInput');
  const midiRenameCancelBtn = document.getElementById('midiRenameCancelBtn');
  const midiClearBtn = document.getElementById('midiClearBtn');
  const midiCamToggleBtn = document.getElementById('midiCamToggleBtn');
  const midiImportExternalBtn = document.getElementById('midiImportExternalBtn');
  const midiFileInput = document.getElementById('midiFileInput');
  const midiResetBtn = document.getElementById('midiResetBtn');
  const midiPlayPauseBtn = document.getElementById('midiPlayPauseBtn');
  const midiRecordBtn = document.getElementById('midiRecordBtn');
  const midiRollCanvas = document.getElementById('midiRollCanvas');

  if (midiBrowserToggleBtn) {
    midiBrowserToggleBtn.addEventListener('click', e => {
      e.stopPropagation();
      toggleMidiBrowserPopover();
    });
  }

  if (midiClearBtn) {
    midiClearBtn.addEventListener('click', () => {
      unloadMidiSession();
    });
  }

  if (midiRenameBtn) {
    midiRenameBtn.addEventListener('click', e => {
      e.stopPropagation();
      openMidiInlineRename();
    });
  }

  if (midiRenameCancelBtn) {
    midiRenameCancelBtn.addEventListener('click', e => {
      e.stopPropagation();
      closeMidiInlineRename();
    });
  }

  if (midiRenameInput) {
    midiRenameInput.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMidiInlineRename();
      }
    });
  }

  if (midiRenameForm) {
    midiRenameForm.addEventListener('submit', async e => {
      e.preventDefault();
      if (!midiPlayer.fileName || !midiRenameInput) {
        closeMidiInlineRename();
        return;
      }
      const nextVal = midiRenameInput.value.trim();
      closeMidiInlineRename();
      if (nextVal) {
        await renameMidiSession(midiPlayer.fileName, nextVal);
      }
    });
  }

  if (midiCamToggleBtn) {
    midiCamToggleBtn.addEventListener('click', () => {
      toggleLiveWebcam();
    });
  }

  if (midiImportExternalBtn && midiFileInput) {
    midiImportExternalBtn.addEventListener('click', () => {
      midiFileInput.click();
    });
  }

  const midiLiteLoadBtn = document.getElementById('midiLiteLoadBtn');
  if (midiLiteLoadBtn && midiFileInput) {
    midiLiteLoadBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (midiRecorder.state === 'recording' || midiRecorder.state === 'armed') return;
      if (state.isLiteMode && midiPlayer.parsed) {
        openLiteReplaceConfirmPopover(midiLiteLoadBtn, 'Replace current recording?', () => {
          midiFileInput.click();
        });
        return;
      }
      midiFileInput.click();
    });
  }

  const midiDownloadMidBtn = document.getElementById('midiDownloadMidBtn');
  if (midiDownloadMidBtn) {
    midiDownloadMidBtn.addEventListener('click', () => {
      downloadCurrentMidiBytes();
    });
  }

  const liteReplaceConfirmYesBtn = document.getElementById('liteReplaceConfirmYesBtn');
  if (liteReplaceConfirmYesBtn) {
    liteReplaceConfirmYesBtn.addEventListener('click', () => {
      const fn = liteReplaceConfirmState.onConfirm;
      closeLiteReplaceConfirmPopover();
      if (typeof fn === 'function') fn();
    });
  }

  const liteReplaceConfirmNoBtn = document.getElementById('liteReplaceConfirmNoBtn');
  if (liteReplaceConfirmNoBtn) {
    liteReplaceConfirmNoBtn.addEventListener('click', () => {
      closeLiteReplaceConfirmPopover();
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

  const midiCancelRecBtn = document.getElementById('midiCancelRecBtn');
  if (midiCancelRecBtn) {
    midiCancelRecBtn.addEventListener('click', () => {
      discardActiveMidiRecording();
    });
  }

  const midiUndoBtn = document.getElementById('midiUndoBtn');
  if (midiUndoBtn) {
    midiUndoBtn.addEventListener('click', () => {
      undoLastMidiOverdub();
    });
  }

  const sessionsCollapseBtn = document.getElementById('sessionsCollapseBtn');
  if (sessionsCollapseBtn) {
    sessionsCollapseBtn.addEventListener('click', () => {
      setSessionsCollapsed(!state.sessionsCollapsed);
    });
  }

  const presetsCollapseBtn = document.getElementById('presetsCollapseBtn');
  if (presetsCollapseBtn) {
    presetsCollapseBtn.addEventListener('click', () => {
      setPresetsCollapsed(!state.presetsCollapsed);
    });
  }

  const rollCollapseBtn = document.getElementById('rollCollapseBtn');
  if (rollCollapseBtn) {
    rollCollapseBtn.addEventListener('click', () => {
      setRollCollapsed(!state.rollCollapsed);
    });
  }

  const keysCollapseBtn = document.getElementById('keysCollapseBtn');
  if (keysCollapseBtn) {
    keysCollapseBtn.addEventListener('click', () => {
      setKeysCollapsed(!state.keysCollapsed);
    });
  }

  // Preset Dock & Popover Controls
  const presetBrowserToggleBtn = document.getElementById('presetBrowserToggleBtn');
  const presetSaveBtn = document.getElementById('presetSaveBtn');
  const presetSaveAsBtn = document.getElementById('presetSaveAsBtn');
  const presetRevertBtn = document.getElementById('presetRevertBtn');
  const presetPopoverNewBtn = document.getElementById('presetPopoverNewBtn');
  const presetNewForm = document.getElementById('presetNewForm');
  const presetNewNameInput = document.getElementById('presetNewNameInput');
  const presetNewCancelBtn = document.getElementById('presetNewCancelBtn');

  if (presetBrowserToggleBtn) {
    presetBrowserToggleBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (presetState.popoverOpen) closePresetPopover();
      else openPresetPopover();
    });
  }
  if (presetSaveBtn) {
    presetSaveBtn.addEventListener('click', () => {
      saveCurrentPreset({ createNew: false });
    });
  }
  if (presetSaveAsBtn) {
    presetSaveAsBtn.addEventListener('click', e => {
      e.stopPropagation();
      openPresetPopover({ startCreatingNew: true });
    });
  }
  if (presetRevertBtn) {
    presetRevertBtn.addEventListener('click', () => {
      revertCurrentPresetChanges();
    });
  }
  if (presetPopoverNewBtn) {
    presetPopoverNewBtn.addEventListener('click', () => {
      presetState.creatingNew = true;
      if (presetNewNameInput) presetNewNameInput.value = '';
      syncPresetPopoverFormUi();
    });
  }
  if (presetNewCancelBtn) {
    presetNewCancelBtn.addEventListener('click', () => {
      presetState.creatingNew = false;
      syncPresetPopoverFormUi();
    });
  }
  if (presetNewForm) {
    presetNewForm.addEventListener('submit', async e => {
      e.preventDefault();
      const rawName = presetNewNameInput?.value || '';
      await saveCurrentPreset({ createNew: true, name: rawName });
      closePresetPopover();
    });
  }
  if (presetNewNameInput) {
    presetNewNameInput.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        presetState.creatingNew = false;
        syncPresetPopoverFormUi();
      }
    });
  }

  document.addEventListener('mousedown', e => {
    const t = e.target;
    if (midiBrowserOpen) {
      if (!t.closest('#midiBrowserPopover') && !t.closest('#midiBrowserToggleBtn')) {
        closeMidiBrowserPopover();
      }
    }
    if (presetState.popoverOpen) {
      if (
        !t.closest('#presetPopover') &&
        !t.closest('#presetBrowserToggleBtn') &&
        !t.closest('#presetSaveAsBtn')
      ) {
        closePresetPopover();
      }
    }
    if (browserExportState.popoverOpen && !browserExportState.rendering) {
      if (!t.closest('#midiExportPopover') && !t.closest('#midiExportVideoBtn')) {
        closeMidiExportPopover();
      }
    }
    if (liteReplaceConfirmState.open) {
      if (
        !t.closest('#liteReplaceConfirmPopover') &&
        !t.closest('#midiRecordBtn') &&
        !t.closest('#midiLiteLoadBtn')
      ) {
        closeLiteReplaceConfirmPopover();
      }
    }
  });

  window.addEventListener('resize', () => {
    if (midiBrowserOpen) positionMidiBrowserPopover();
    if (presetState.popoverOpen) positionPresetPopover();
    if (browserExportState.popoverOpen) positionMidiExportPopover();
    if (liteReplaceConfirmState.open) positionLiteReplaceConfirmPopover();
  });

  const midiExportVideoBtn = document.getElementById('midiExportVideoBtn');
  if (midiExportVideoBtn) {
    midiExportVideoBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (browserExportState.popoverOpen) closeMidiExportPopover();
      else openMidiExportPopover();
    });
  }
  document.querySelectorAll('.stage-grid-pill[data-export-aspect]').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.exportAspect;
      if (!next || browserExportState.rendering) return;
      browserExportState.aspectRatio = normalizeBrowserAspectRatio(next);
      browserExportState.statusText = '';
      syncMidiExportPopoverUi();
    });
  });
  const midiExportBuildToggle = document.getElementById('midiExportBuildToggle');
  if (midiExportBuildToggle) {
    midiExportBuildToggle.addEventListener('change', () => {
      if (browserExportState.rendering) return;
      browserExportState.includeBuild = midiExportBuildToggle.checked;
      browserExportState.statusText = '';
      syncMidiExportPopoverUi();
    });
  }
  const midiExportStartBtn = document.getElementById('midiExportStartBtn');
  if (midiExportStartBtn) {
    midiExportStartBtn.addEventListener('click', () => {
      runBrowserMp4Export();
    });
  }
  const midiExportCancelBtn = document.getElementById('midiExportCancelBtn');
  if (midiExportCancelBtn) {
    midiExportCancelBtn.addEventListener('click', () => {
      browserExportState.abortController?.abort();
    });
  }

  const midiOctDownBtn = document.getElementById('midiOctDownBtn');
  if (midiOctDownBtn) {
    midiOctDownBtn.addEventListener('click', () => shiftMidiTransposeOctave(-1));
  }
  const midiOctUpBtn = document.getElementById('midiOctUpBtn');
  if (midiOctUpBtn) {
    midiOctUpBtn.addEventListener('click', () => shiftMidiTransposeOctave(1));
  }

  if (midiRollCanvas) {
    let scrubDownX = 0;
    let scrubDragging = false;
    let scrubPrevSec = 0;
    let scrubLatestSec = 0;
    let scrubRafId = null;

    const canScrubRollNow = () =>
      Boolean(midiPlayer.parsed) &&
      midiRecorder.state !== 'recording' &&
      !(midiRecorder.state === 'armed' && midiRecorder.mode !== 'overdub');

    const pointerXToMidiSec = clientX => {
      if (!midiPlayer.parsed) return 0;
      const rect = midiRollCanvas.getBoundingClientRect();
      const usableW = Math.max(1, rect.width - MIDI_ROLL_PAD_X * 2);
      const ratio = Math.max(
        0,
        Math.min(1, (clientX - rect.left - MIDI_ROLL_PAD_X) / usableW)
      );
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

    midiRollCanvas.addEventListener('mousedown', e => {
      if (e.button !== 0 || !canScrubRollNow()) return;
      e.preventDefault();
      ensureAudioContext();
      replanCurrentMidiTimeline();

      const rect = midiRollCanvas.getBoundingClientRect();
      const usableW = Math.max(1, rect.width - MIDI_ROLL_PAD_X * 2);
      const dur = Math.max(0.01, Number(midiPlayer.parsed.durationSec || 0.01));
      const curThumbX =
        rect.left +
        MIDI_ROLL_PAD_X +
        Math.max(0, Math.min(1, midiPlayer.elapsedSec / dur)) * usableW;
      const grabbedNearPlayhead = Math.abs(e.clientX - curThumbX) <= 10;

      midiPlayer.scrubbing = true;
      pauseSessionHandVideoPlayback();
      scrubDownX = e.clientX;
      scrubDragging = grabbedNearPlayhead;

      if (grabbedNearPlayhead) {
        silenceAllMidiTransportVoices(0.06);
        scrubPrevSec = midiPlayer.elapsedSec;
        scrubLatestSec = pointerXToMidiSec(e.clientX);
        midiPlayer.elapsedSec = scrubLatestSec;
        requestHandVideoSeek(scrubLatestSec);
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
      requestHandVideoSeek(scrubLatestSec);
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
      requestHandVideoSeek(midiPlayer.elapsedSec);
      if (midiPlayer.playing) {
        resumeSessionHandVideoPlayback();
      }
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

  const bladeTrashGroupBtn = document.getElementById('bladeTrashGroupBtn');
  if (bladeTrashGroupBtn) {
    bladeTrashGroupBtn.addEventListener('click', async e => {
      e.stopPropagation();
      if (state.isStaticMode || !bladeState.open) return;
      const vids = bladeState.groupVideos || [];
      if (!vids.length) return;
      if (bladeState.trashArmedVideoId !== '__group__') {
        resetBladeTrashConfirmUI();
        bladeState.trashArmedVideoId = '__group__';
        bladeTrashGroupBtn.classList.add('confirm-armed');
        bladeTrashGroupBtn.textContent = 'Delete?';
        bladeState.trashVideoTimer = setTimeout(() => resetBladeTrashConfirmUI(), 3500);
        return;
      }
      resetBladeTrashConfirmUI();
      stopBladePreview();
      stopReferenceTone(true);
      const allGroupSliceIds = vids.flatMap(v => (v.slices || []).map(s => s.id));
      evictTrashedSlicesClientState(allGroupSliceIds);
      if (state.soloGroupKey && state.soloGroupKey === bladeState.groupKey) {
        setInstrumentSolo(null, []);
      }
      for (const v of vids) {
        await apiPost('/api/video/trash', { videoId: v.id });
      }
      closeInspectorBlade();
    });
  }

  const bladeGroupSoloBtn = document.getElementById('bladeGroupSoloBtn');
  if (bladeGroupSoloBtn) {
    bladeGroupSoloBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!bladeState.open || !bladeState.groupKey) return;
      const vids = bladeState.groupVideos || [];
      if (vids.length === 0) return;
      toggleInstrumentSolo(
        bladeState.groupKey,
        vids.map(v => v.id)
      );
    });
  }

  const bladeGroupSwitch = document.getElementById('bladeGroupSwitch');
  if (bladeGroupSwitch) {
    bladeGroupSwitch.addEventListener('click', () => {
      if (!bladeState.open) return;
      const vids = bladeState.groupVideos || [];
      if (vids.length === 0) return;
      const anyEnabled = vids.some(v => !isVideoMutedUnderlying(v.id));
      setVideosEnabled(
        vids.map(v => v.id),
        !anyEnabled
      );
    });
  }

  const bladeGroupVolSlider = document.getElementById('bladeGroupVolSlider');
  const bladeGroupVolDecBtn = document.getElementById('bladeGroupVolDecBtn');
  const bladeGroupVolIncBtn = document.getElementById('bladeGroupVolIncBtn');
  if (bladeGroupVolSlider) {
    bladeGroupVolSlider.addEventListener('input', () => {
      const ids = (bladeState.groupVideos || []).map(v => v.id);
      setGroupGainDb(ids, Number(bladeGroupVolSlider.value) || 0, false);
    });
    bladeGroupVolSlider.addEventListener('change', () => {
      const ids = (bladeState.groupVideos || []).map(v => v.id);
      setGroupGainDb(ids, Number(bladeGroupVolSlider.value) || 0, true);
    });
    bladeGroupVolSlider.addEventListener('dblclick', e => {
      e.stopPropagation();
      const ids = (bladeState.groupVideos || []).map(v => v.id);
      setGroupGainDb(ids, 0, true);
    });
  }
  if (bladeGroupVolDecBtn) {
    bladeGroupVolDecBtn.addEventListener('click', e => {
      e.stopPropagation();
      const vids = bladeState.groupVideos || [];
      if (!vids.length) return;
      setGroupGainDb(
        vids.map(v => v.id),
        getVideoGainDb(vids[0].id) - 1,
        true
      );
    });
  }
  if (bladeGroupVolIncBtn) {
    bladeGroupVolIncBtn.addEventListener('click', e => {
      e.stopPropagation();
      const vids = bladeState.groupVideos || [];
      if (!vids.length) return;
      setGroupGainDb(
        vids.map(v => v.id),
        getVideoGainDb(vids[0].id) + 1,
        true
      );
    });
  }

  document.addEventListener('mousedown', e => {
    if (!bladeState.open) return;
    const t = e.target;
    if (
      t.closest('#inspectorBlade') ||
      t.closest('#fileExplorer') ||
      t.closest('.candidate-card') ||
      t.closest('#bottomDock')
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
    const targetTag = e.target?.tagName;
    const isTextEntryTarget =
      targetTag === 'TEXTAREA' ||
      targetTag === 'SELECT' ||
      e.target?.isContentEditable ||
      (targetTag === 'INPUT' &&
        e.target.type !== 'range' &&
        e.target.type !== 'checkbox' &&
        e.target.type !== 'button');
    if (isTextEntryTarget || e.metaKey || e.ctrlKey) {
      return;
    }

    if (state.liteSplashActive) {
      if ((e.key === 'Enter' || e.code === 'Space' || e.key === ' ') && !e.repeat) {
        e.preventDefault();
        dismissLiteSplashAndStartBuild();
      }
      return;
    }

    // Spacebar toggles play/pause whenever a MIDI file is active (unless actively auditioning an open sample blade)
    if (
      (e.code === 'Space' || e.key === ' ') &&
      midiPlayer.parsed &&
      midiRecorder.state !== 'recording' &&
      !(bladeState.open && (state.selectionTarget === 'blade' || state.selectionTarget === 'explorer'))
    ) {
      e.preventDefault();
      if (!e.repeat) {
        if (midiPlayer.playing) pauseMidiTransport();
        else playMidiTransport();
      }
      return;
    }

    if (targetTag === 'INPUT' || targetTag === 'SELECT') {
      return;
    }

    if (e.key === 'Escape') {
      if (liteReplaceConfirmState.open) {
        e.preventDefault();
        closeLiteReplaceConfirmPopover();
        return;
      }
      if (buildPreviewState.running) {
        e.preventDefault();
        stopIntroBuildPreview();
        return;
      }
      if (midiBrowserOpen) {
        e.preventDefault();
        closeMidiBrowserPopover();
        return;
      }
      if (midiRecorder.state === 'armed' || midiRecorder.state === 'recording') {
        e.preventDefault();
        discardActiveMidiRecording();
        return;
      }
      if (bladeState.open) {
        e.preventDefault();
        closeInspectorBlade();
        return;
      }
      if (state.soloVideoIds.size > 0) {
        e.preventDefault();
        setInstrumentSolo(null, []);
        return;
      }
      if (state.selectionTarget === 'explorer') {
        e.preventDefault();
        setSelectionFocus('keyboard');
        return;
      }
      return;
    }

    if (e.code === 'KeyS' && e.altKey && !e.metaKey && !e.ctrlKey && !e.repeat) {
      e.preventDefault();
      if (bladeState.open && bladeState.groupKey && bladeState.groupVideos?.length) {
        toggleInstrumentSolo(
          bladeState.groupKey,
          bladeState.groupVideos.map(v => v.id)
        );
      } else if (state.soloVideoIds.size > 0) {
        setInstrumentSolo(null, []);
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

      if (e.code === 'BracketLeft' && bladeState.slice) {
        e.preventDefault();
        stepBladeTestToneMidi(e.shiftKey ? -12 : -1);
        return;
      }

      if (e.code === 'BracketRight' && bladeState.slice) {
        e.preventDefault();
        stepBladeTestToneMidi(e.shiftKey ? 12 : 1);
        return;
      }

      if (e.code === 'KeyC' && !e.repeat && !e.shiftKey && !e.altKey && bladeState.slice) {
        e.preventDefault();
        copyExpandedSampleReference();
        return;
      }

      if (e.key === 'Enter' && !e.repeat) {
        e.preventDefault();
        if (
          e.shiftKey &&
          bladeState.slice &&
          Number.isFinite(bladeState.testToneMidi) &&
          bladeState.testToneMidi !== bladeState.assignedMidi
        ) {
          await commitBladeTestToneMidi();
          return;
        }
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

    if (e.code === 'KeyR' && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      toggleMidiRecording();
      return;
    }

    if (e.code === 'KeyT' && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      triggerContextualTestTone();
      return;
    }

    if (bladeState.open && bladeState.slice) {
      if (e.code === 'BracketLeft') {
        e.preventDefault();
        setSelectionFocus('blade');
        stepBladeTestToneMidi(e.shiftKey ? -12 : -1);
        return;
      }
      if (e.code === 'BracketRight') {
        e.preventDefault();
        setSelectionFocus('blade');
        stepBladeTestToneMidi(e.shiftKey ? 12 : 1);
        return;
      }
    }

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

let liteBootReady = false;
let litePendingBuildLaunch = false;

function dismissLiteSplashAndStartBuild() {
  if (!state.liteSplashActive) return;
  state.liteSplashActive = false;
  document.body.classList.remove('lite-splash-active');

  const ctx = ensureAudioContext();
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }

  const overlay = document.getElementById('liteStartOverlay');
  if (overlay) {
    overlay.classList.add('is-fading');
    setTimeout(() => {
      overlay.classList.add('hidden');
      overlay.classList.remove('is-fading');
    }, 240);
  }

  if (liteBootReady) {
    if (!buildPreviewState.running) {
      toggleIntroBuildPreview();
    }
  } else {
    litePendingBuildLaunch = true;
  }
}

// ============================================================================
// Boot
// ============================================================================
async function init() {
  if (state.isLiteMode) {
    document.body.classList.add('lite-mode', 'lite-splash-active');
    const overlay = document.getElementById('liteStartOverlay');
    if (overlay) overlay.classList.remove('hidden');
    const tabTitle = document.getElementById('sessionsTabTitle');
    if (tabTitle) tabTitle.textContent = 'MIDI';
    const keysTabTitle = document.getElementById('keysTabTitle');
    if (keysTabTitle) keysTabTitle.textContent = 'Octave';
    const stagePianoWrapEl = document.getElementById('stagePianoWrap');
    const pianoKbEl = document.getElementById('pianoKeyboard');
    if (stagePianoWrapEl && pianoKbEl && pianoKbEl.parentElement !== stagePianoWrapEl) {
      stagePianoWrapEl.appendChild(pianoKbEl);
      stagePianoWrapEl.style.opacity = '0';
    }
  }

  const prefs = loadPrefsFromStorage();
  state.chromeCollapsed = state.isLiteMode ? true : Boolean(prefs.chromeCollapsed);
  state.sessionsCollapsed = Boolean(prefs.sessionsCollapsed);
  state.presetsCollapsed = Boolean(prefs.presetsCollapsed);
  state.rollCollapsed = Boolean(prefs.rollCollapsed);
  state.keysCollapsed = Boolean(prefs.keysCollapsed);
  state.noteSamplesExpanded = Boolean(prefs.noteSamplesExpanded);
  state.selectionTarget = 'keyboard';
  state.selectedTileSliceId = null;
  state.stageSettingsTab = normalizeStageSettingsTab(prefs.stageSettingsTab);
  state.stageGridMode = normalizeStageGridMode(prefs.stageGridMode);
  state.stageTileScale = clampStageTileScale(prefs.stageTileScale ?? 1.0);
  state.stageSpecScale = clampStageSpecScale(prefs.stageSpecScale ?? 1.0);
  state.stageFadeInSec = clampStageFadeInSec(prefs.stageFadeInSec ?? 0.0);
  state.stageFadeSec = clampStageFadeSec(prefs.stageFadeSec ?? 0.2);
  state.stageMinDisplaySec = clampStageMinDisplaySec(prefs.stageMinDisplaySec ?? 0.7);
  state.stageMaxDisplaySec = clampStageMaxDisplaySec(prefs.stageMaxDisplaySec ?? 1.0);
  state.stageShowVideo = prefs.stageShowVideo !== undefined ? Boolean(prefs.stageShowVideo) : true;
  state.stageVideoPosition = normalizeStageVideoPosition(prefs.stageVideoPosition ?? 'right');
  state.stageVideoWidthPct = clampStageVideoWidthPct(prefs.stageVideoWidthPct ?? 50);
  state.stageVideoHeightPct = clampStageVideoHeightPct(prefs.stageVideoHeightPct ?? 23);
  state.stageVideoCropX = clampStageVideoCropX(prefs.stageVideoCropX ?? 50);
  state.stageVideoCropY = clampStageVideoCropY(prefs.stageVideoCropY ?? 50);
  state.stageVideoZoom = clampStageVideoZoom(prefs.stageVideoZoom ?? 1.0);
  state.stageVideoBrightness = clampStageVideoBrightness(prefs.stageVideoBrightness ?? 1.0);
  state.stageBuildRampUp = normalizeBuildRampUp(prefs.stageBuildRampUp ?? true);
  state.stageBuildFullSec = clampBuildFullSec(prefs.stageBuildFullSec ?? 5.0);
  state.stageBuildMaxFps = clampBuildMaxFps(prefs.stageBuildMaxFps ?? 12);
  state.stageBuildSound = normalizeBuildSound(prefs.stageBuildSound ?? true);
  state.velocitySensitive = Boolean(prefs.velocitySensitive ?? false);
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
  setSessionsCollapsed(state.sessionsCollapsed);
  setPresetsCollapsed(state.presetsCollapsed);
  setRollCollapsed(state.rollCollapsed);
  setNoteSamplesExpanded(state.noteSamplesExpanded);
  setKeysCollapsed(state.keysCollapsed);
  syncVelocityToggleUI();
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
  const rollBodyEl = document.getElementById('midiRollBody');
  if (rollBodyEl && typeof ResizeObserver !== 'undefined') {
    let lastRollW = 0;
    let lastRollH = 0;
    new ResizeObserver(() => {
      const nextW = Math.round(rollBodyEl.clientWidth || 0);
      const nextH = Math.round(rollBodyEl.clientHeight || 0);
      if (nextW > 0 && nextH > 0 && (nextW !== lastRollW || nextH !== lastRollH)) {
        lastRollW = nextW;
        lastRollH = nextH;
        drawMidiRollCanvas();
      }
    }).observe(rollBodyEl);
  }
  setupEventListeners();
  initWebMIDI();

  const atlasPromise = threeStage ? threeStage.loadAtlas() : Promise.resolve();

  let loadedFromLocalServer = false;
  const forceStaticMode = Boolean(
    document.querySelector('meta[name="everytone-static"][content="true"]')
  );
  const isLocalHost =
    !forceStaticMode &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
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
  state.assetBust = Date.parse(state.catalog?.updatedAt || '') || Date.now();

  // Hydrate curated stageConfig defaults for first-time visitors (or enforce locked visual settings in lite mode)
  if (state.catalog?.stageConfig) {
    const sc = state.catalog.stageConfig;
    if (sc.stageGridMode !== undefined) {
      state.defaultCatalogGridMode = normalizeStageGridMode(sc.stageGridMode);
    }
    if (state.isLiteMode) {
      if (!prefs.hasSavedPrefs && sc.stageGridMode !== undefined) {
        state.stageGridMode = normalizeStageGridMode(sc.stageGridMode);
      }
      if (sc.stageTileScale !== undefined) state.stageTileScale = clampStageTileScale(sc.stageTileScale);
      if (sc.stageSpecScale !== undefined) state.stageSpecScale = clampStageSpecScale(sc.stageSpecScale);
      if (sc.stageFadeInSec !== undefined) state.stageFadeInSec = clampStageFadeInSec(sc.stageFadeInSec);
      if (sc.stageFadeSec !== undefined) state.stageFadeSec = clampStageFadeSec(sc.stageFadeSec);
      if (sc.stageMinDisplaySec !== undefined) {
        state.stageMinDisplaySec = clampStageMinDisplaySec(sc.stageMinDisplaySec);
      }
      if (sc.stageMaxDisplaySec !== undefined) {
        state.stageMaxDisplaySec = clampStageMaxDisplaySec(sc.stageMaxDisplaySec);
      }
      state.stageShowVideo = false;
      if (sc.stageBuildRampUp !== undefined) {
        state.stageBuildRampUp = normalizeBuildRampUp(sc.stageBuildRampUp);
      }
      if (sc.stageBuildFullSec !== undefined) {
        state.stageBuildFullSec = clampBuildFullSec(sc.stageBuildFullSec);
      }
      if (sc.stageBuildMaxFps !== undefined) {
        state.stageBuildMaxFps = clampBuildMaxFps(sc.stageBuildMaxFps);
      }
      state.stageBuildSound = sc.stageBuildSound !== undefined ? normalizeBuildSound(sc.stageBuildSound) : true;
      midiPlayer.transposeOctaves = 0;
      syncStageConfigUI();
      updateStageTileSizes();
      updateMidiTransportUi();
    } else if (!prefs.hasSavedPrefs) {
      if (sc.stageGridMode !== undefined) state.stageGridMode = normalizeStageGridMode(sc.stageGridMode);
      if (sc.stageTileScale !== undefined) state.stageTileScale = clampStageTileScale(sc.stageTileScale);
      if (sc.stageSpecScale !== undefined) state.stageSpecScale = clampStageSpecScale(sc.stageSpecScale);
      if (sc.stageFadeInSec !== undefined) state.stageFadeInSec = clampStageFadeInSec(sc.stageFadeInSec);
      if (sc.stageFadeSec !== undefined) state.stageFadeSec = clampStageFadeSec(sc.stageFadeSec);
      if (sc.stageMinDisplaySec !== undefined) {
        state.stageMinDisplaySec = clampStageMinDisplaySec(sc.stageMinDisplaySec);
      }
      if (sc.stageMaxDisplaySec !== undefined) {
        state.stageMaxDisplaySec = clampStageMaxDisplaySec(sc.stageMaxDisplaySec);
      }
      if (sc.stageShowVideo !== undefined) {
        state.stageShowVideo = Boolean(sc.stageShowVideo);
      }
      if (sc.stageVideoPosition !== undefined) {
        state.stageVideoPosition = normalizeStageVideoPosition(sc.stageVideoPosition);
      }
      if (sc.stageVideoWidthPct !== undefined) {
        state.stageVideoWidthPct = clampStageVideoWidthPct(sc.stageVideoWidthPct);
      }
      if (sc.stageVideoHeightPct !== undefined) {
        state.stageVideoHeightPct = clampStageVideoHeightPct(sc.stageVideoHeightPct);
      }
      if (sc.stageVideoCropX !== undefined) {
        state.stageVideoCropX = clampStageVideoCropX(sc.stageVideoCropX);
      }
      if (sc.stageVideoCropY !== undefined) {
        state.stageVideoCropY = clampStageVideoCropY(sc.stageVideoCropY);
      }
      if (sc.stageVideoZoom !== undefined) {
        state.stageVideoZoom = clampStageVideoZoom(sc.stageVideoZoom);
      }
      if (sc.stageVideoBrightness !== undefined) {
        state.stageVideoBrightness = clampStageVideoBrightness(sc.stageVideoBrightness);
      }
      if (sc.stageBuildRampUp !== undefined) {
        state.stageBuildRampUp = normalizeBuildRampUp(sc.stageBuildRampUp);
      }
      if (sc.stageBuildFullSec !== undefined) {
        state.stageBuildFullSec = clampBuildFullSec(sc.stageBuildFullSec);
      }
      if (sc.stageBuildMaxFps !== undefined) {
        state.stageBuildMaxFps = clampBuildMaxFps(sc.stageBuildMaxFps);
      }
      if (sc.stageBuildSound !== undefined) {
        state.stageBuildSound = normalizeBuildSound(sc.stageBuildSound);
      }
      if (sc.midiTransposeOctaves !== undefined) {
        midiPlayer.transposeOctaves = clampMidiTransposeOctaves(sc.midiTransposeOctaves);
      }
      syncStageConfigUI();
      updateStageTileSizes();
      updateMidiTransportUi();
    }
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

  if ((state.isStaticMode || state.isLiteMode) && prefs.hasSavedDisabledVideos) {
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

  // In static or lite mode, also restore saved per-slice toggles across reloads
  if ((state.isStaticMode || state.isLiteMode) && state.catalog?.keyboardMap) {
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
  if (!state.isLiteMode) {
    await fetchPresetsFromServer();
  }
  refreshAllUI();
  syncStageConfigUI();
  updateStageTileSizes();

  if (state.isLiteMode) {
    liteBootReady = true;
    if (state.liteSplashActive) {
      threeStage?.setVisibleCount?.(0);
      // Pre-warm initial showcase audio bytes behind the START splash so frame 1 is instant
      const plan = computeCurrentIntroBuildPlan();
      const firstSteps = (plan.showcaseSteps || plan.steps || []).slice(0, 32);
      for (const st of firstSteps) {
        if (st?.cand?.audioUrl) prefetchRawAudioBytes(st.cand.audioUrl);
      }
    } else if (litePendingBuildLaunch) {
      litePendingBuildLaunch = false;
      toggleIntroBuildPreview();
    }
  }

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
