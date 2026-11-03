const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const ACCIDENTAL_SEMITONES = new Set([1, 3, 6, 8, 10]);

// Standard chromatic QWERTY layout (18 keys starting at baseOctaveMidi)
const QWERTY_MAP = [
  { code: 'KeyA', label: 'A', offset: 0 },
  { code: 'KeyW', label: 'W', offset: 1 },
  { code: 'KeyS', label: 'S', offset: 2 },
  { code: 'KeyE', label: 'E', offset: 3 },
  { code: 'KeyD', label: 'D', offset: 4 },
  { code: 'KeyF', label: 'F', offset: 5 },
  { code: 'KeyT', label: 'T', offset: 6 },
  { code: 'KeyG', label: 'G', offset: 7 },
  { code: 'KeyY', label: 'Y', offset: 8 },
  { code: 'KeyH', label: 'H', offset: 9 },
  { code: 'KeyU', label: 'U', offset: 10 },
  { code: 'KeyJ', label: 'J', offset: 11 },
  { code: 'KeyK', label: 'K', offset: 12 },
  { code: 'KeyO', label: 'O', offset: 13 },
  { code: 'KeyL', label: 'L', offset: 14 },
  { code: 'KeyP', label: 'P', offset: 15 },
  { code: 'Semicolon', label: ';', offset: 16 },
  { code: 'Quote', label: "'", offset: 17 }
];

const state = {
  catalog: null,
  selectedMidi: 60, // Currently inspected piano key (defaults to C4)
  auditionIndex: 0,
  keyCandidateFilter: '',
  kbHighlightMode: 'all', // 'all' | 'new' | 'gaps'
  kbZoomMode: 'fit', // 'fit' | 'wide'
  wurliEnabled: false, // Strictly OFF by default
  releaseSec: 0.65, // Smooth decay duration upon lifting finger
  highpassHz: 85,
  baseOctaveMidi: 60, // C4
  sustainPedalDown: false,
  lastPlayedVideoId: null,
  lastPlayedSliceId: null,
  assetBust: 0,
  // Secondary Library / Slicer state
  selectedCategory: 'all',
  searchQuery: '',
  sortBy: 'index',
  selectedVideoId: null,
  selectedSliceId: null
};

function midiToName(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

function midiToShortLabel(midi, isWide) {
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  if (isWide || pc === 0) return NOTE_NAMES[pc] + oct;
  return NOTE_NAMES[pc];
}

function midiToFreq(midi) {
  return (440 * Math.pow(2, (midi - 69) / 12)).toFixed(1);
}

// ============================================================================
// Web Audio Engine + Hold-to-Sustain / Key-Up Release Voice Manager
// ============================================================================
let audioCtx = null;
let masterBus = null;
let sampleHighpass = null;
const audioBufferCache = new Map();

// Active held voices keyed by triggerId (e.g. 'qwerty_KeyA', 'midi_60', 'mouse', 'arrow_preview')
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

function withBust(url) {
  if (!url || !state.assetBust) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${state.assetBust}`;
}

async function loadAudioBuffer(url) {
  const bustedUrl = withBust(url);
  if (audioBufferCache.has(bustedUrl)) return audioBufferCache.get(bustedUrl);
  const ctx = ensureAudioContext();
  const res = await fetch(bustedUrl);
  const arr = await res.arrayBuffer();
  const decoded = await ctx.decodeAudioData(arr);
  audioBufferCache.set(bustedUrl, decoded);
  return decoded;
}

function startWurlitzerVoice(midi, velocity = 0.8) {
  if (!state.wurliEnabled) return null;
  const ctx = ensureAudioContext();
  const now = ctx.currentTime;
  const freq = 440 * Math.pow(2, (midi - 69) / 12);

  const carrier = ctx.createOscillator();
  const subSine = ctx.createOscillator();
  const mod = ctx.createOscillator();
  const modGain = ctx.createGain();

  carrier.type = 'triangle';
  carrier.frequency.setValueAtTime(freq, now);
  subSine.type = 'sine';
  subSine.frequency.setValueAtTime(freq, now);

  mod.type = 'sine';
  mod.frequency.setValueAtTime(freq * 2.0, now);

  const barkAmount = freq * (0.6 + velocity * 1.1);
  modGain.gain.setValueAtTime(barkAmount, now);
  modGain.gain.exponentialRampToValueAtTime(freq * 0.08, now + 0.18);
  modGain.gain.exponentialRampToValueAtTime(0.5, now + 1.8);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(Math.min(5500, freq * 6.5), now);
  filter.frequency.exponentialRampToValueAtTime(Math.max(600, freq * 2.2), now + 1.1);

  const env = ctx.createGain();
  const peakGain = 0.14 * velocity;
  env.gain.setValueAtTime(0.0001, now);
  env.gain.linearRampToValueAtTime(peakGain, now + 0.006);
  env.gain.exponentialRampToValueAtTime(peakGain * 0.52, now + 0.45);
  env.gain.exponentialRampToValueAtTime(0.0001, now + 3.2);

  mod.connect(modGain);
  modGain.connect(carrier.frequency);
  carrier.connect(filter);
  subSine.connect(filter);
  filter.connect(env);
  env.connect(masterBus);

  carrier.start(now);
  subSine.start(now);
  mod.start(now);

  return {
    env,
    peakGain: peakGain * 0.52,
    stopAt(stopTime) {
      try {
        carrier.stop(stopTime);
        subSine.stop(stopTime);
        mod.stop(stopTime);
      } catch {}
    }
  };
}

// ============================================================================
// Fixed 3-Slot 1:1 Square Stage + Per-Slot Visual Mini Spectrogram Strips
// ============================================================================
const STAGE_SLOT_COUNT = 3;
const MINI_SPEC_H = 54;
let stageSlotSeq = 0;
let currentStageTileSize = 220;
let miniSpecAnimId = null;
const miniSpecBitmapCache = new Map();

const stageSlots = [
  { occupied: false, seq: 0, token: null, videoEl: null, voice: null, miniBitmap: null },
  { occupied: false, seq: 0, token: null, videoEl: null, voice: null, miniBitmap: null },
  { occupied: false, seq: 0, token: null, videoEl: null, voice: null, miniBitmap: null }
];

function updateStageTileSizes() {
  const stageEl = document.getElementById('videoStage');
  const grid = document.getElementById('polyVideoGrid');
  if (!stageEl || !grid) return;

  const gap = 18;
  const availW = Math.max(180, stageEl.clientWidth - 40 - gap * (STAGE_SLOT_COUNT - 1));
  const availH = Math.max(110, stageEl.clientHeight - 28 - (MINI_SPEC_H + 6));
  const side = Math.max(84, Math.floor(Math.min(availH, availW / STAGE_SLOT_COUNT)));
  currentStageTileSize = side;
  grid.style.setProperty('--tile-size', `${side}px`);
}

window.addEventListener('resize', updateStageTileSizes);

function allocateStageSlotIndex() {
  // 1. Fill empty slots strictly left-to-right (0 -> 1 -> 2)
  for (let i = 0; i < STAGE_SLOT_COUNT; i++) {
    if (!stageSlots[i].occupied) return i;
  }
  // 2. If > 3 polyphony, steal the earliest/first occupied slot and continue left-to-right!
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

function createStageSquareTile(slice, playbackRate = 1.0) {
  const grid = document.getElementById('polyVideoGrid');
  if (!grid) return null;

  const slotIdx = allocateStageSlotIndex();
  const unitEl = grid.querySelector(`.stage-slot-unit[data-slot="${slotIdx}"]`);
  const videoWrap = unitEl?.querySelector('.stage-slot-video');
  if (!unitEl || !videoWrap) return null;

  // Pause & clean up any stolen clip currently in this slot
  if (stageSlots[slotIdx].videoEl) {
    try {
      stageSlots[slotIdx].videoEl.pause();
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
  videoWrap.appendChild(videoEl);

  stageSlots[slotIdx] = {
    occupied: true,
    seq: stageSlotSeq,
    token,
    videoEl,
    voice: null,
    miniBitmap: null
  };

  videoEl.playbackRate = Math.max(0.5, Math.min(2.0, playbackRate));
  videoEl.currentTime = 0;
  videoEl.play().catch(() => {});

  return { slotIdx, token, tile: videoWrap, videoEl };
}

function removeStageTile(tileObj) {
  if (!tileObj || tileObj.slotIdx === undefined) return;
  const { slotIdx, token } = tileObj;
  const slotState = stageSlots[slotIdx];
  // If a newer note already stole this slot, do NOT clear the newer note!
  if (!slotState || slotState.token !== token) return;

  try {
    tileObj.videoEl?.pause();
  } catch {}

  const grid = document.getElementById('polyVideoGrid');
  const videoWrap = grid?.querySelector(`.stage-slot-unit[data-slot="${slotIdx}"] .stage-slot-video`);
  if (videoWrap) {
    videoWrap.innerHTML = '';
  }
  clearSlotMiniSpec(slotIdx);

  stageSlots[slotIdx] = {
    occupied: false,
    seq: 0,
    token: null,
    videoEl: null,
    voice: null,
    miniBitmap: null
  };
}

function buildMiniSpectrogramBitmap(buffer, playbackRate = 1.0) {
  const W = 200;
  const H = MINI_SPEC_H;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');

  const ch = buffer.getChannelData(0);
  const effectiveSr = buffer.sampleRate * playbackRate;
  const minFreq = 65;
  const maxFreq = 4200;
  const logMin = Math.log(minFreq);
  const logMax = Math.log(maxFreq);

  const imgData = ctx.createImageData(W, H);
  const data = imgData.data;

  const real = new Float32Array(fftSizeSpec);
  const imag = new Float32Array(fftSizeSpec);
  const half = fftSizeSpec >> 1;
  const colMags = new Array(W);
  let globalMaxDb = -90;

  for (let x = 0; x < W; x++) {
    const startSample = Math.floor((x / W) * Math.max(1, ch.length - fftSizeSpec));
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
  ctx.putImageData(imgData, 0, 0);
  return c;
}

function attachSlotMiniSpectrogram(tileObj, slice, buffer, voice) {
  if (!tileObj || tileObj.slotIdx === undefined) return;
  const slotState = stageSlots[tileObj.slotIdx];
  if (!slotState || slotState.token !== tileObj.token) return;

  const rate = voice ? voice.playbackRate : 1.0;
  const cacheKey = `${slice.audioUrl}__${rate.toFixed(4)}`;
  let bmp = miniSpecBitmapCache.get(cacheKey);
  if (!bmp) {
    bmp = buildMiniSpectrogramBitmap(buffer, rate);
    miniSpecBitmapCache.set(cacheKey, bmp);
  }

  slotState.voice = voice;
  slotState.miniBitmap = bmp;
  ensureMiniSpecAnimLoop();
}

function ensureMiniSpecAnimLoop() {
  if (miniSpecAnimId) return;

  const tick = () => {
    const grid = document.getElementById('polyVideoGrid');
    if (!grid || !audioCtx) {
      miniSpecAnimId = null;
      return;
    }

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = currentStageTileSize;
    const cssH = MINI_SPEC_H;
    const targetW = Math.round(cssW * dpr);
    const targetH = Math.round(cssH * dpr);
    const now = audioCtx.currentTime;
    let anyActive = false;

    for (let i = 0; i < STAGE_SLOT_COUNT; i++) {
      const slot = stageSlots[i];
      if (!slot.occupied || !slot.voice || !slot.miniBitmap) continue;
      anyActive = true;

      const canvas = grid.querySelector(`.stage-slot-unit[data-slot="${i}"] .slot-mini-spec`);
      if (!canvas) continue;
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(slot.miniBitmap, 0, 0, cssW, cssH);

      const elapsed = Math.max(0, now - slot.voice.startedAt);
      const progress = Math.min(1, elapsed / Math.max(0.08, slot.voice.naturalDur));
      const x = progress * cssW;

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, cssH);
      ctx.stroke();
    }

    if (anyActive) {
      miniSpecAnimId = requestAnimationFrame(tick);
    } else {
      miniSpecAnimId = null;
    }
  };

  miniSpecAnimId = requestAnimationFrame(tick);
}

/**
 * Start a held audio + square video voice (sustains until releaseVoice or natural clip end)
 */
async function startHeldVoice({
  triggerId,
  midi = null,
  slice = null,
  noteLabel = '',
  shiftCents = 0,
  playbackRate = 1.0,
  velocity = 0.92
}) {
  // If this exact triggerId was already active, release it cleanly first
  if (activeVoices.has(triggerId)) {
    releaseHeldVoice(triggerId, 0.08);
  }

  const ctx = ensureAudioContext();
  if (midi !== null) setKeyActiveClass(midi, true);

  const wurliVoice = midi !== null ? startWurlitzerVoice(midi, velocity) : null;

  if (!slice) {
    if (wurliVoice) {
      activeVoices.set(triggerId, {
        triggerId,
        midi,
        wurliVoice,
        released: false
      });
    }
    return;
  }

  // Spawn pure borderless 1:1 square video tile immediately for zero visual latency
  const tileObj = createStageSquareTile(slice, playbackRate);

  const voice = {
    triggerId,
    midi,
    slice,
    playbackRate,
    wurliVoice,
    tileObj,
    src: null,
    gainNode: null,
    peakGain: 0.85,
    startedAt: ctx.currentTime,
    naturalDur: (slice.durSec || 2.0) / playbackRate,
    naturalTimer: null,
    released: false,
    releaseStartCtxTime: null,
    releaseDur: state.releaseSec
  };
  activeVoices.set(triggerId, voice);

  try {
    const buffer = await loadAudioBuffer(slice.audioUrl);
    // Check if user already lifted finger while buffer was decoding (first-play cache miss)
    const now = ctx.currentTime;
    const dbOffset = slice.peakDb !== undefined ? Math.max(0, Math.min(8, (-22 - slice.peakDb) * 0.35)) : 0;
    const boost = Math.pow(10, dbOffset / 20);
    const peakGain = Math.min(1.25, 0.86 * velocity * boost);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.setValueAtTime(playbackRate, now);

    const gainNode = ctx.createGain();
    const dur = buffer.duration / playbackRate;

    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.linearRampToValueAtTime(peakGain, now + 0.006);
    // Natural end-of-file fade only at the very tail of the clip
    gainNode.gain.setValueAtTime(peakGain, now + Math.max(0.02, dur - 0.12));
    gainNode.gain.linearRampToValueAtTime(0.0001, now + dur);

    src.connect(gainNode);
    gainNode.connect(sampleHighpass);
    src.start(now);

    voice.src = src;
    voice.gainNode = gainNode;
    voice.peakGain = peakGain;
    voice.startedAt = now;
    voice.naturalDur = dur;

    // Attach visual-only mini spectrogram + playhead underneath this clip's slot,
    // and update the separate right-side Inspector spectrogram!
    attachSlotMiniSpectrogram(tileObj, slice, buffer, voice);
    const playedFreq = Number(((slice.freq || 261.6) * playbackRate).toFixed(1));
    renderStageSpectrogramLive(slice, buffer, playedFreq, noteLabel, voice);

    if (voice.released) {
      // Finger already lifted during async decode -> immediately apply smooth release!
      applyVoiceReleaseRamp(voice, voice.releaseDur);
    } else {
      // If held past the entire natural sample length, remove tile instantly when sound stops
      voice.naturalTimer = setTimeout(() => {
        if (!voice.released) {
          voice.released = true;
          activeVoices.delete(triggerId);
          if (midi !== null && !isMidiStillHeld(midi)) setKeyActiveClass(midi, false);
          removeStageTile(voice.tileObj);
        }
      }, Math.max(80, Math.round(dur * 1000)));
    }
  } catch (err) {
    console.warn('Error starting voice:', err);
    removeStageTile(tileObj);
    activeVoices.delete(triggerId);
  }
}

function applyVoiceReleaseRamp(voice, customReleaseSec = null) {
  const ctx = ensureAudioContext();
  const now = ctx.currentTime;
  const requestedRel = customReleaseSec ?? state.releaseSec;

  // Never extend past the natural end of the sample buffer
  const elapsed = voice.startedAt ? Math.max(0, now - voice.startedAt) : 0;
  const remainingNatural = voice.naturalDur ? Math.max(0.03, voice.naturalDur - elapsed) : requestedRel;
  const rel = Math.min(requestedRel, remainingNatural);

  voice.released = true;
  voice.releaseStartCtxTime = now;
  voice.releaseDur = rel;
  if (voice.naturalTimer) {
    clearTimeout(voice.naturalTimer);
    voice.naturalTimer = null;
  }
  if (voice.removeTimer) {
    clearTimeout(voice.removeTimer);
    voice.removeTimer = null;
  }

  // 1. Smoothly ramp out sample audio over `rel` seconds (e.g. 0.65s)
  if (voice.gainNode && voice.src) {
    const g = voice.gainNode.gain;
    const curVal = Math.max(0.0002, g.value || voice.peakGain * 0.85);
    g.cancelScheduledValues(now);
    g.setValueAtTime(curVal, now);
    g.linearRampToValueAtTime(curVal * 0.56, now + rel * 0.35);
    g.linearRampToValueAtTime(curVal * 0.18, now + rel * 0.72);
    g.linearRampToValueAtTime(0.0001, now + rel);
    try {
      voice.src.stop(now + rel + 0.015);
    } catch {}
  }

  // 2. Smoothly release Wurli synth if active
  if (voice.wurliVoice) {
    const wg = voice.wurliVoice.env.gain;
    const wCur = Math.max(0.0002, wg.value || voice.wurliVoice.peakGain);
    wg.cancelScheduledValues(now);
    wg.setValueAtTime(wCur, now);
    wg.linearRampToValueAtTime(0.0001, now + rel);
    voice.wurliVoice.stopAt(now + rel + 0.02);
  }

  // 3. Keep square video at 100% full opacity until the exact moment the sound stops, then remove instantly!
  if (voice.tileObj?.tile) {
    voice.removeTimer = setTimeout(() => {
      removeStageTile(voice.tileObj);
    }, Math.round(rel * 1000));
  }
}

function releaseHeldVoice(triggerId, customReleaseSec = null) {
  const voice = activeVoices.get(triggerId);
  if (!voice) return;

  // Respect MIDI sustain pedal for MIDI-triggered notes
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
// High-Resolution Live Stage Spectrogram + f0 Line + Animated Playhead
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

// Cache offscreen spectrogram canvases per (audioUrl + playbackRate) for instant zero-lag redraws!
const spectrogramBitmapCache = new Map();
let stageSpecAnimId = null;

const SPEC_CSS_W = 344;
const SPEC_CSS_H = 138;

function buildSpectrogramOffscreen(buffer, f0Hz, f0Label, dpr = 1, playbackRate = 1.0) {
  const W = SPEC_CSS_W;
  const H = SPEC_CSS_H;

  // 1. Build 1:1 CSS-pixel STFT bitmap (zero stretching, crisp pixel cells)
  const stftCanvas = document.createElement('canvas');
  stftCanvas.width = W;
  stftCanvas.height = H;
  const stftCtx = stftCanvas.getContext('2d');

  const ch = buffer.getChannelData(0);
  const effectiveSr = buffer.sampleRate * playbackRate;
  const minFreq = 65;
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

  for (let x = 0; x < W; x++) {
    const startSample = Math.floor((x / W) * Math.max(1, ch.length - fftSizeSpec));
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

  // 2. Composite crisp nearest-neighbor STFT pixels + Retina-sharp vector overlay
  const offCanvas = document.createElement('canvas');
  offCanvas.width = Math.round(W * dpr);
  offCanvas.height = Math.round(H * dpr);
  const ctx = offCanvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(stftCanvas, 0, 0, W, H);

  // Subtle log-frequency grid lines
  const gridFreqs = [100, 200, 440, 1000, 2000, 3500];
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

  // Fundamental pitch line f0 (solid emerald) + harmonics 2f0, 3f0, 4f0 (dashed amber)
  if (f0Hz >= minFreq && f0Hz <= maxFreq) {
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

function renderStageSpectrogramLive(slice, buffer, playedFreq, noteLabel, voice) {
  const canvas = document.getElementById('stageSpectrogramCanvas');
  if (!canvas || !buffer) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const targetW = Math.round(SPEC_CSS_W * dpr);
  const targetH = Math.round(SPEC_CSS_H * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  const ctx = canvas.getContext('2d');

  const badge = document.getElementById('stageF0Badge');
  if (badge) {
    badge.textContent = slice.percBucket
      ? `${noteLabel} · ${playedFreq} Hz`
      : `f0: ${noteLabel} · ${playedFreq} Hz`;
  }

  const metaEl = document.getElementById('stageSpecMeta');
  if (metaEl) {
    const slug = slice.videoSlug || slice.baseName || '--';
    const durStr = slice.durSec ? `${Number(slice.durSec).toFixed(2)}s` : '';
    const startStr = slice.startSec !== undefined ? `@${Number(slice.startSec).toFixed(2)}s` : '';
    metaEl.textContent = `${slug} ${startStr} · ${durStr}`;
  }

  const rate = voice ? voice.playbackRate : 1.0;
  const cacheKey = `${slice.audioUrl}__${rate.toFixed(4)}__${dpr}`;
  let offscreen = spectrogramBitmapCache.get(cacheKey);
  if (!offscreen) {
    offscreen = buildSpectrogramOffscreen(
      buffer,
      playedFreq,
      noteLabel || slice.name,
      dpr,
      rate
    );
    spectrogramBitmapCache.set(cacheKey, offscreen);
  }

  if (stageSpecAnimId) {
    cancelAnimationFrame(stageSpecAnimId);
    stageSpecAnimId = null;
  }

  const drawFrame = playheadX => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(offscreen, 0, 0);
    if (playheadX !== null) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, SPEC_CSS_H);
      ctx.stroke();
    }
  };

  if (!voice || !audioCtx) {
    drawFrame(null);
    return;
  }

  const animatePlayhead = () => {
    const now = audioCtx.currentTime;
    const elapsed = Math.max(0, now - voice.startedAt);
    const progress = Math.min(1, elapsed / Math.max(0.1, voice.naturalDur));

    let stillAudible = progress < 1;
    if (voice.released && voice.releaseStartCtxTime !== null) {
      if (now - voice.releaseStartCtxTime >= voice.releaseDur) {
        stillAudible = false;
      }
    }

    if (stillAudible) {
      drawFrame(progress * SPEC_CSS_W);
      stageSpecAnimId = requestAnimationFrame(animatePlayhead);
    } else {
      drawFrame(null);
    }
  };
  stageSpecAnimId = requestAnimationFrame(animatePlayhead);
}

// ============================================================================
// Piano Key & Candidate Trigger Helpers
// ============================================================================
function startPianoKeyHold(triggerId, midi, velocity = 0.92, selectInDeck = true) {
  if (midi < 36 || midi > 103) return;
  if (selectInDeck && state.selectedMidi !== midi) {
    selectKeyForConfig(midi, false);
  }

  const entry = state.catalog?.keyboardMap?.[midi];
  if (!entry || !entry.primary) {
    startHeldVoice({ triggerId, midi, slice: null, velocity });
    return;
  }

  const cand = entry.primary;
  state.lastPlayedVideoId = cand.videoId;
  state.lastPlayedSliceId = cand.sliceId;

  startHeldVoice({
    triggerId,
    midi,
    slice: cand,
    noteLabel: entry.targetName,
    shiftCents: cand.shiftCents,
    playbackRate: cand.playbackRate,
    velocity
  });
}

function startCandidateHold(triggerId, midi, cand, idx = 0) {
  state.auditionIndex = idx;
  state.lastPlayedVideoId = cand.videoId;
  state.lastPlayedSliceId = cand.sliceId;

  const noteName = midiToName(midi);

  document.querySelectorAll('.candidate-card').forEach((el, i) => {
    el.classList.toggle('audition-focus', i === idx);
  });

  startHeldVoice({
    triggerId,
    midi,
    slice: cand,
    noteLabel: noteName,
    shiftCents: cand.shiftCents,
    playbackRate: cand.playbackRate,
    velocity: 0.94
  });
}

function selectKeyForConfig(midi, shouldTapPreview = false) {
  const clamped = Math.max(36, Math.min(103, midi));
  state.selectedMidi = clamped;
  state.keyCandidateFilter = '';
  const filterInput = document.getElementById('keyCandidateFilter');
  if (filterInput) filterInput.value = '';

  const entry = state.catalog?.keyboardMap?.[clamped];
  if (entry && entry.candidates?.length) {
    const activeIdx = entry.candidates.findIndex(c => c.sliceId === entry.activeSliceId);
    state.auditionIndex = activeIdx >= 0 ? activeIdx : 0;
  } else {
    state.auditionIndex = 0;
  }

  document.querySelectorAll('.key-cell').forEach(el => {
    const m = Number(el.dataset.midi);
    el.classList.toggle('selected-key', m === clamped);
  });

  const keyEl = document.querySelector(`.key-cell[data-midi="${clamped}"]`);
  if (keyEl && state.kbZoomMode === 'wide') {
    keyEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }

  renderSelectedKeyDeck();

  if (shouldTapPreview) {
    startPianoKeyHold('arrow_preview', clamped, 0.9, false);
    setTimeout(() => releaseHeldVoice('arrow_preview'), 220);
  }
}

// ============================================================================
// Percussion Buckets (Kick [1], Snare [2], Hi-Hat / Click [3])
// ============================================================================
function startPercussionHold(triggerId, bucketId, specificSliceId = null, velocity = 0.98) {
  const bucket = state.catalog?.percussionMap?.[bucketId];
  if (!bucket || !bucket.slots?.length) return;

  const targetId = specificSliceId || bucket.activeSliceId || bucket.slots[0].sliceId;
  const slot = bucket.slots.find(s => s.sliceId === targetId) || bucket.slots[0];

  state.lastPlayedVideoId = slot.videoId;
  state.lastPlayedSliceId = slot.sliceId;

  const padEl = document.querySelector(`.perc-bucket[data-bucket="${bucketId}"]`);
  if (padEl) {
    padEl.classList.add('active-play');
    setTimeout(() => padEl.classList.remove('active-play'), 180);
  }

  startHeldVoice({
    triggerId,
    midi: null,
    slice: slot,
    noteLabel: bucket.label.toUpperCase(),
    shiftCents: 0,
    playbackRate: 1.0,
    velocity
  });
}

function renderPercussionRack() {
  const rack = document.getElementById('percussionRack');
  if (!rack) return;
  rack.innerHTML = '';

  const percMap = state.catalog?.percussionMap || {};
  for (const bKey of ['kick', 'snare', 'hihat']) {
    const bucket = percMap[bKey] || {
      id: bKey,
      label: bKey.toUpperCase(),
      keyShortcut: bKey === 'kick' ? '1' : bKey === 'snare' ? '2' : '3',
      slots: []
    };
    const activeSlot =
      bucket.slots.find(s => s.sliceId === bucket.activeSliceId) || bucket.slots[0] || null;

    const el = document.createElement('div');
    el.className = 'perc-bucket';
    el.dataset.bucket = bKey;

    el.innerHTML = `
      <div class="perc-pad-top" title="Press & hold [${bucket.keyShortcut}] or click to trigger ${bucket.label}">
        ${
          activeSlot
            ? `<img class="perc-thumb" src="${activeSlot.thumbUrl}" alt="${bucket.label}" />`
            : `<div class="perc-thumb"></div>`
        }
        <div style="flex:1;min-width:0">
          <div class="perc-title-row">
            <span class="perc-title">${bucket.label}</span>
            <span class="perc-key-badge">Key ${bucket.keyShortcut}</span>
          </div>
          <div class="perc-active-name">
            ${activeSlot ? `${activeSlot.percLabel} (${activeSlot.videoSlug})` : 'No takes'}
          </div>
        </div>
      </div>
      <div class="perc-slots"></div>
    `;

    el.querySelector('.perc-pad-top').addEventListener('mousedown', () => {
      startPercussionHold('mouse_hold', bKey);
    });

    const slotsWrap = el.querySelector('.perc-slots');
    bucket.slots.forEach((slot, idx) => {
      const btn = document.createElement('button');
      const isSelected = activeSlot && slot.sliceId === activeSlot.sliceId;
      btn.className = `perc-slot-btn ${isSelected ? 'selected' : ''}`;
      btn.innerHTML = `
        <span>T${idx + 1} · ${slot.percLabel}</span>
        <span style="opacity:0.65">${slot.videoSlug}</span>
      `;
      btn.addEventListener('mousedown', e => {
        e.stopPropagation();
        startPercussionHold('mouse_hold', bKey, slot.sliceId);
      });
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        await apiPost('/api/percussion/select', {
          bucket: bKey,
          sliceId: slot.sliceId
        });
      });
      slotsWrap.appendChild(btn);
    });

    rack.appendChild(el);
  }
}

// ============================================================================
// Rendering: Top Stats, Equal-Width Keyline Keyboard, and Compact Candidate Strip
// ============================================================================
function renderStats() {
  const st = state.catalog?.stats || {};
  document.getElementById('statConfiguredKeys').textContent = st.coveredKeys ?? 0;
  document.getElementById('statTotalCandidates').textContent = st.totalCandidates ?? 0;
  document.getElementById('statPercCount').textContent = st.percCount ?? 0;
  document.getElementById('statVideos').textContent = st.totalVideos ?? 0;

  const newBtn = document.getElementById('jumpNewTopBtn');
  const newCount = st.newConsiderations ?? 0;
  document.getElementById('statNewCount').textContent = newCount;
  newBtn.classList.toggle('hidden', newCount === 0);
}

function renderPianoKeyboard() {
  const container = document.getElementById('pianoKeyboard');
  if (!container) return;
  container.innerHTML = '';
  container.classList.toggle('fit-mode', state.kbZoomMode === 'fit');
  container.classList.toggle('wide-mode', state.kbZoomMode === 'wide');

  const keyMap = state.catalog?.keyboardMap || {};
  const isWide = state.kbZoomMode === 'wide';

  const qwertyByMidi = new Map();
  for (const q of QWERTY_MAP) {
    qwertyByMidi.set(state.baseOctaveMidi + q.offset, q.label);
  }
  const endOctName = midiToName(state.baseOctaveMidi + 17);
  document.getElementById('octaveLabel').textContent =
    `QWERTY: ${midiToName(state.baseOctaveMidi)} – ${endOctName}`;
  document.getElementById('midiText').textContent =
    `QWERTY ${midiToName(state.baseOctaveMidi)} (Z/X)`;

  for (let midi = 36; midi <= 103; midi++) {
    const pc = ((midi % 12) + 12) % 12;
    const isAccidental = ACCIDENTAL_SEMITONES.has(pc);
    const isOctaveStart = pc === 0;
    const entry = keyMap[midi];
    const candCount = entry?.candidateCount || 0;
    const newCount = entry?.newCount || 0;
    const primary = entry?.primary || null;
    const isEmpty = !primary;

    let dimmed = false;
    if (state.kbHighlightMode === 'new' && newCount === 0) dimmed = true;
    if (state.kbHighlightMode === 'gaps' && candCount > 0) dimmed = true;

    const cell = document.createElement('div');
    cell.className = [
      'key-cell',
      isAccidental ? 'accidental' : 'natural',
      isOctaveStart ? 'octave-start' : '',
      isEmpty ? 'empty-key' : 'configured-key',
      midi === state.selectedMidi ? 'selected-key' : '',
      isMidiStillHeld(midi) ? 'active-play' : '',
      dimmed ? 'dimmed' : ''
    ]
      .filter(Boolean)
      .join(' ');
    cell.dataset.midi = midi;

    const fullNoteName = midiToName(midi);
    const shortNote = midiToShortLabel(midi, isWide);
    const qLabel = qwertyByMidi.get(midi);
    const countText = candCount > 0 ? (newCount > 0 ? `${candCount}✦` : `${candCount}`) : '·';

    cell.innerHTML = `
      <div class="key-top-meta">
        <span class="key-cand-count ${newCount > 0 ? 'has-new' : ''}">${countText}</span>
        ${
          primary?.thumbUrl
            ? `<img class="key-thumb-square" src="${primary.thumbUrl}" alt="${fullNoteName}" loading="lazy" />`
            : ''
        }
      </div>
      <div class="key-slug-vertical">${primary ? primary.videoSlug : ''}</div>
      <div class="key-bottom-footer">
        ${qLabel ? `<span class="key-qwerty-tag">${qLabel}</span>` : ''}
        <span class="key-note-label">${shortNote}</span>
      </div>
    `;

    if (primary) {
      const shiftStr = primary.shiftCents >= 0 ? `+${primary.shiftCents}c` : `${primary.shiftCents}c`;
      cell.title =
        `${fullNoteName} (${midiToFreq(midi)} Hz)\n` +
        `Active Go-To: ${primary.videoSlug} (@${primary.startSec}s, ${shiftStr})\n` +
        `Candidates: ${candCount}${newCount > 0 ? ` (${newCount} NEW)` : ''}`;
    } else if (candCount > 0) {
      cell.title = `${fullNoteName} — Cleared (${candCount} candidates available)`;
    } else {
      cell.title = `${fullNoteName} (${midiToFreq(midi)} Hz) — Empty (0 nearest-note candidates)`;
    }

    cell.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      selectKeyForConfig(midi, false);
      startPianoKeyHold('mouse_hold', midi, 0.92, false);
    });

    container.appendChild(cell);
  }
}

function getFilteredCandidatesForSelectedKey() {
  const entry = state.catalog?.keyboardMap?.[state.selectedMidi];
  if (!entry || !entry.candidates) return [];
  const q = state.keyCandidateFilter.toLowerCase().trim();
  if (!q) return entry.candidates;
  return entry.candidates.filter(
    c =>
      c.videoSlug.toLowerCase().includes(q) ||
      (c.videoLabel || '').toLowerCase().includes(q) ||
      c.category.toLowerCase().includes(q)
  );
}

function renderSelectedKeyDeck() {
  const midi = state.selectedMidi;
  const noteName = midiToName(midi);
  const freqStr = midiToFreq(midi);
  const entry = state.catalog?.keyboardMap?.[midi];

  document.getElementById('selectedKeyName').textContent = noteName;
  document.getElementById('selectedKeyMeta').textContent = `${freqStr} Hz`;

  const totalCands = entry?.candidateCount || 0;
  const newCount = entry?.newCount || 0;
  document.getElementById('candidateSummaryLabel').textContent =
    totalCands === 0
      ? '0 Candidates'
      : `${totalCands} Option${totalCands === 1 ? '' : 's'}${newCount > 0 ? ` · ${newCount} NEW` : ''}`;

  const filterEl = document.getElementById('keyCandidateFilter');
  filterEl.classList.toggle('hidden', totalCands < 5);

  document.getElementById('markKeySeenBtn').classList.toggle('hidden', newCount === 0);
  document.getElementById('clearKeyBtn').classList.toggle('hidden', !entry?.primary);

  const grid = document.getElementById('candidatesGrid');
  grid.innerHTML = '';

  const candidates = getFilteredCandidatesForSelectedKey();
  if (candidates.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-key-state';
    if (totalCands === 0) {
      emptyDiv.innerHTML = `
        <h3>${noteName} (${freqStr} Hz) — Empty Slot</h3>
        <p>No sample currently sits within ±50c of ${noteName}. Record an object near ${freqStr} Hz or slice an unextracted moment in Video Library &amp; Slicer.</p>
      `;
    } else {
      emptyDiv.innerHTML = `<h3>No candidates on ${noteName} match "${state.keyCandidateFilter}"</h3>`;
    }
    grid.appendChild(emptyDiv);
    return;
  }

  candidates.forEach((cand, idx) => {
    const isActive = entry.activeSliceId === cand.sliceId && !entry.isCleared;
    const card = document.createElement('div');
    card.className = [
      'candidate-card',
      isActive ? 'is-active' : '',
      cand.isNew ? 'is-new' : '',
      idx === state.auditionIndex ? 'audition-focus' : ''
    ]
      .filter(Boolean)
      .join(' ');

    const shiftStr = cand.shiftCents >= 0 ? `+${cand.shiftCents}c` : `${cand.shiftCents}c`;
    const numStr = String(cand.videoIndex || 0).padStart(2, '0');

    card.innerHTML = `
      <div class="cand-top">
        <div class="cand-thumb-wrap" title="Press & hold to audition at ${noteName}">
          <img src="${cand.thumbUrl}" alt="${cand.videoSlug}" loading="lazy" />
          <div class="cand-play-overlay">▶</div>
        </div>
        <div class="cand-info">
          <div class="cand-badges-row">
            ${isActive ? `<span class="pill-badge active-go-to">✓ Go-To</span>` : ''}
            ${cand.isNew ? `<span class="pill-badge new-flag">✦ New</span>` : ''}
            <span class="pill-badge cat-flag">#${numStr} ${cand.category}</span>
          </div>
          <input
            type="text"
            class="cand-slug-input"
            value="${cand.videoSlug}"
            title="Rename shorthand on disk (Enter to save)"
          />
          <div class="cand-tech-meta">@${cand.startSec}s (${cand.durSec}s) · Tune ${shiftStr}</div>
        </div>
      </div>

      <div class="cand-actions">
        <button class="set-goto-btn ${isActive ? 'current' : ''}">
          ${isActive ? `✓ Active on ${noteName}` : `Use as Go-To`}
        </button>
        <div class="cand-mini-tools">
          <button class="icon-tool-btn trim-btn" title="Slide In &amp; Out points for this clip">✂ Trim</button>
          <button class="icon-tool-btn danger trash-cand-btn" title="Move slice to _trash/">🗑</button>
        </div>
      </div>
    `;

    // Hold mouse button on card to sustain audition; lifting mouse triggers smooth release!
    card.addEventListener('mousedown', e => {
      if (e.button !== 0 || e.target.tagName === 'INPUT' || e.target.closest('button')) return;
      startCandidateHold('mouse_hold', midi, cand, idx);
    });

    const slugInput = card.querySelector('.cand-slug-input');
    slugInput.addEventListener('mousedown', e => e.stopPropagation());
    slugInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') e.target.blur();
    });
    slugInput.addEventListener('blur', async () => {
      const nextSlug = slugInput.value.trim();
      if (nextSlug && nextSlug !== cand.videoSlug) {
        await apiPost('/api/video/rename', { videoId: cand.videoId, slug: nextSlug });
      }
    });

    card.querySelector('.set-goto-btn').addEventListener('click', async e => {
      e.stopPropagation();
      startCandidateHold('tap_commit', midi, cand, idx);
      setTimeout(() => releaseHeldVoice('tap_commit'), 220);
      if (!isActive) {
        await apiPost('/api/keyboard/select', { midi, sliceId: cand.sliceId });
      }
    });

    card.querySelector('.trim-btn').addEventListener('click', e => {
      e.stopPropagation();
      openTrimModal(cand.videoId, cand.sliceId, cand.playbackRate || 1.0);
    });

    card.querySelector('.trash-cand-btn').addEventListener('click', async e => {
      e.stopPropagation();
      await apiPost('/api/slice/trash', { videoId: cand.videoId, sliceId: cand.sliceId });
    });

    grid.appendChild(card);
  });
}

// ============================================================================
// Secondary Drawer: Raw Video Library, Waveform & Slicer Spectrogram
// ============================================================================
async function renderDrawerSpectrogram(slice, existingBuffer = null) {
  const canvas = document.getElementById('spectrogramCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const buffer = existingBuffer || (await loadAudioBuffer(slice.audioUrl));
  if (!buffer) return;
  const off = buildSpectrogramOffscreen(
    buffer,
    slice.freq || 261.6,
    slice.name,
    canvas.width,
    canvas.height,
    1.0
  );
  ctx.drawImage(off, 0, 0);
}

function renderSourceWaveform(video, activeSlice) {
  const canvas = document.getElementById('waveformCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  ctx.fillStyle = '#040507';
  ctx.fillRect(0, 0, W, H);
  if (!video || !video.waveformPeaks) return;

  const peaks = video.waveformPeaks;
  const maxPeak = Math.max(...peaks, 0.05);
  const dur = video.duration || 1;

  if (activeSlice) {
    const x0 = (activeSlice.startSec / dur) * W;
    const wSlice = (activeSlice.durSec / dur) * W;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.fillRect(x0, 0, wSlice, H);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0, 1, wSlice, H - 2);
  }

  const barW = W / peaks.length;
  for (let i = 0; i < peaks.length; i++) {
    const x = i * barW;
    const tSec = (i / peaks.length) * dur;
    const inActive =
      activeSlice &&
      tSec >= activeSlice.startSec &&
      tSec <= activeSlice.startSec + activeSlice.durSec;
    ctx.fillStyle = inActive ? '#ffffff' : '#475569';
    const normH = (peaks[i] / maxPeak) * (H * 0.82);
    ctx.fillRect(x, (H - normH) / 2, Math.max(1.5, barW - 1), normH);
  }

  for (const onset of video.allDetectedOnsets || []) {
    const x = (onset.startSec / dur) * W;
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.75)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
}

function getFilteredVideos() {
  if (!state.catalog) return [];
  const q = state.searchQuery.toLowerCase().trim();
  const list = state.catalog.videos.filter(v => {
    if (state.selectedCategory === 'trash') return !!v.deleted;
    if (v.deleted) return false;
    if (state.selectedCategory !== 'all' && v.category !== state.selectedCategory) return false;
    if (!q) return true;
    const matchName =
      v.slug.toLowerCase().includes(q) ||
      (v.label || '').toLowerCase().includes(q) ||
      v.category.toLowerCase().includes(q);
    const matchSlice = (v.slices || []).some(s => !s.deleted && s.name.toLowerCase().includes(q));
    return matchName || matchSlice;
  });

  list.sort((a, b) => {
    const slicesA = (a.slices || []).filter(s => !s.deleted);
    const slicesB = (b.slices || []).filter(s => !s.deleted);
    if (state.sortBy === 'pitch-asc') {
      return Math.min(...slicesA.map(s => s.midi), 999) - Math.min(...slicesB.map(s => s.midi), 999);
    }
    if (state.sortBy === 'pitch-desc') {
      return Math.max(...slicesB.map(s => s.midi), 0) - Math.max(...slicesA.map(s => s.midi), 0);
    }
    if (state.sortBy === 'slices') {
      return slicesB.length - slicesA.length;
    }
    return a.index - b.index;
  });
  return list;
}

function renderVideoGrid() {
  const grid = document.getElementById('videoGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const videos = getFilteredVideos();

  for (const video of videos) {
    const activeSlices = (video.slices || []).filter(s => !s.deleted);
    const card = document.createElement('div');
    card.className = `video-card ${video.id === state.selectedVideoId ? 'selected' : ''}`;
    const numStr = String(video.index).padStart(2, '0');
    const cacheBust = video.extraRotateDeg ? `?r=${video.extraRotateDeg}` : '';

    card.innerHTML = `
      <div class="card-top">
        <div class="thumb-box" title="Audition first slice">
          <img src="${video.thumbUrl}${cacheBust}" alt="${video.slug}" loading="lazy" />
          <span class="thumb-index">#${numStr}</span>
        </div>
        <div class="card-meta">
          <input type="text" class="slug-input" value="${video.slug}" />
          <div class="meta-row">
            <select class="cat-select">
              ${['strings', 'winds', 'glass', 'metal', 'keys', 'toms', 'percussion']
                .map(c => `<option value="${c}" ${video.category === c ? 'selected' : ''}>${c}</option>`)
                .join('')}
            </select>
            <div class="card-actions">
              ${
                video.deleted
                  ? `<button class="icon-btn restore-btn">↩ Restore</button>`
                  : `<button class="icon-btn rot-btn" title="Rotate 90°">↻ 90°</button>
                     <button class="icon-btn danger trash-video-btn" title="Move video to _trash/">🗑</button>`
              }
            </div>
          </div>
          <div class="folder-path-hint">samples/${video.folderName}/ (${video.duration}s)</div>
        </div>
      </div>
      <div class="slices-wrap"></div>
    `;

    card.querySelector('.thumb-box').addEventListener('click', () => {
      selectVideoAndSlice(video, activeSlices[0] || null, null, true);
    });

    const slugInput = card.querySelector('.slug-input');
    const commitRename = async () => {
      const nextSlug = slugInput.value.trim();
      const nextCat = card.querySelector('.cat-select').value;
      if ((nextSlug && nextSlug !== video.slug) || nextCat !== video.category) {
        await apiPost('/api/video/rename', { videoId: video.id, slug: nextSlug, category: nextCat });
      }
    };
    slugInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') e.target.blur();
    });
    slugInput.addEventListener('blur', commitRename);
    card.querySelector('.cat-select').addEventListener('change', commitRename);

    const rotBtn = card.querySelector('.rot-btn');
    if (rotBtn) {
      rotBtn.addEventListener('click', async e => {
        e.stopPropagation();
        rotBtn.textContent = '...';
        await apiPost('/api/video/rotate', { videoId: video.id, deltaDeg: 90 });
      });
    }

    const trashBtn = card.querySelector('.trash-video-btn');
    if (trashBtn) {
      trashBtn.addEventListener('click', async e => {
        e.stopPropagation();
        await apiPost('/api/video/trash', { videoId: video.id });
      });
    }

    const restoreBtn = card.querySelector('.restore-btn');
    if (restoreBtn) {
      restoreBtn.addEventListener('click', async e => {
        e.stopPropagation();
        await apiPost('/api/video/restore', { videoId: video.id });
      });
    }

    const slicesWrap = card.querySelector('.slices-wrap');
    for (const slice of activeSlices) {
      const pill = document.createElement('div');
      pill.className = `slice-pill ${slice.id === state.selectedSliceId ? 'active-slice' : ''}`;
      const isPerc = !!slice.percBucket;
      const label = isPerc ? slice.percBucket.toUpperCase() : slice.name;

      pill.innerHTML = `
        <span>${label}</span>
        <span style="color:var(--text-2)">@${slice.startSec}s</span>
        <button class="del-slice-btn" title="Move slice to _trash/">×</button>
      `;
      pill.addEventListener('click', () => selectVideoAndSlice(video, slice, null, true));
      pill.querySelector('.del-slice-btn').addEventListener('click', async e => {
        e.stopPropagation();
        await apiPost('/api/slice/trash', { videoId: video.id, sliceId: slice.id });
      });
      slicesWrap.appendChild(pill);
    }

    grid.appendChild(card);
  }
}

async function selectVideoAndSlice(video, slice, preloadedBuffer = null, shouldPlay = true) {
  state.selectedVideoId = video ? video.id : null;
  state.selectedSliceId = slice ? slice.id : null;
  renderVideoGrid();

  if (video) {
    document.getElementById('waveformTitle').textContent =
      `#${String(video.index).padStart(2, '0')} ${video.slug} (${video.duration}s)`;
    renderSourceWaveform(video, slice);
  }

  if (slice) {
    const centsStr = slice.cents >= 0 ? `+${slice.cents}c` : `${slice.cents}c`;
    document.getElementById('specSubtitle').textContent =
      `${slice.name} (${centsStr}) · ${slice.startSec}s–${(slice.startSec + slice.durSec).toFixed(2)}s`;
    document.getElementById('f0Readout').textContent = `${slice.name} · ${slice.freq} Hz`;
    document.getElementById('filePairBadge').textContent = `${slice.mp4File}`;
    document.getElementById('sliceBucketSelect').value = slice.percBucket || 'tonal';
    document.getElementById('sliceStartInput').value = slice.startSec;
    document.getElementById('sliceDurInput').value = slice.durSec;
    document.getElementById('sliceHpInput').value = slice.highpassHz || 85;

    const peaksList = document.getElementById('peaksList');
    peaksList.innerHTML = '';
    for (const pk of slice.candidatePeaks || []) {
      const chip = document.createElement('button');
      const isCurrent = Math.abs(pk.freq - slice.freq) < 6;
      chip.className = `peak-chip ${isCurrent ? 'selected' : ''}`;
      chip.textContent = `${pk.name} (${pk.freq}Hz)`;
      chip.addEventListener('click', async () => {
        await apiPost('/api/slice/update', {
          videoId: video.id,
          sliceId: slice.id,
          overrideFreq: pk.freq
        });
      });
      peaksList.appendChild(chip);
    }

    if (shouldPlay) {
      startHeldVoice({
        triggerId: 'slicer_preview',
        midi: null,
        slice: { ...slice, videoSlug: video.slug },
        noteLabel: slice.name,
        shiftCents: slice.cents,
        playbackRate: 1.0,
        velocity: 0.94
      });
      setTimeout(() => releaseHeldVoice('slicer_preview'), 450);
      await renderDrawerSpectrogram(slice, preloadedBuffer);
    } else {
      await renderDrawerSpectrogram(slice, preloadedBuffer);
    }
  }
}

function openSlicerForVideoAndSlice(videoId, sliceId) {
  document.getElementById('libraryDrawer').classList.remove('hidden');
  const video = state.catalog?.videos.find(v => v.id === videoId);
  if (video) {
    const slice = (video.slices || []).find(s => s.id === sliceId && !s.deleted) || video.slices?.[0];
    selectVideoAndSlice(video, slice, null, false);
  }
}

// ============================================================================
// Focused Single-Clip Visual "Trim In / Out" Modal (Draggable IN / OUT Handles)
// ============================================================================
const trimState = {
  open: false,
  video: null,
  slice: null,
  playbackRate: 1.0,
  origIn: 0,
  origOut: 2.0,
  inSec: 0,
  outSec: 2.0,
  viewStart: 0,
  viewEnd: 5.0,
  zoomMode: 'clip', // 'clip' | 'full'
  sliceAudioBuffer: null,
  previewRaf: null,
  dragMode: null, // 'in' | 'out' | 'move' | null
  dragStartX: 0,
  dragStartIn: 0,
  dragStartOut: 0
};

function computeTrimViewWindow() {
  const dur = Math.max(1.0, trimState.video?.duration || 5.0);
  if (trimState.zoomMode === 'full' || dur <= 6.0) {
    trimState.viewStart = 0;
    trimState.viewEnd = dur;
    return;
  }
  const padBefore = 1.6;
  const padAfter = 2.2;
  let v0 = Math.max(0, trimState.inSec - padBefore);
  let v1 = Math.min(dur, trimState.outSec + padAfter);
  if (v1 - v0 < 5.0) {
    const extra = (5.0 - (v1 - v0)) / 2;
    v0 = Math.max(0, v0 - extra);
    v1 = Math.min(dur, v1 + extra);
  }
  trimState.viewStart = v0;
  trimState.viewEnd = Math.max(v0 + 0.8, v1);
}

function stopTrimPreview() {
  if (trimState.previewRaf) {
    cancelAnimationFrame(trimState.previewRaf);
    trimState.previewRaf = null;
  }
  const vid = document.getElementById('trimScrubVideo');
  if (vid) {
    try {
      vid.pause();
    } catch {}
  }
  const ph = document.getElementById('trimPlayhead');
  if (ph) ph.classList.remove('visible');
  const btn = document.getElementById('trimPreviewBtn');
  if (btn) btn.textContent = '▶ Preview In → Out (Space)';
}

function scrubTrimVideoTo(sec) {
  const vid = document.getElementById('trimScrubVideo');
  if (!vid) return;
  const clamped = Math.max(0, Math.min(trimState.video?.duration || 10, sec));
  document.getElementById('trimScrubTimeReadout').textContent = `Frame @ ${clamped.toFixed(2)}s`;
  if (Math.abs(vid.currentTime - clamped) > 0.015) {
    try {
      vid.muted = true;
      vid.currentTime = clamped;
    } catch {}
  }
}

function startTrimPreview() {
  const vid = document.getElementById('trimScrubVideo');
  if (!vid || !trimState.video) return;

  if (trimState.previewRaf) {
    stopTrimPreview();
    return;
  }

  const ph = document.getElementById('trimPlayhead');
  const btn = document.getElementById('trimPreviewBtn');
  btn.textContent = '⏹ Stop Preview (Space)';

  vid.muted = false;
  vid.playbackRate = Math.max(0.5, Math.min(2.0, trimState.playbackRate || 1.0));
  vid.currentTime = trimState.inSec;
  vid.play().catch(() => {});

  ph.classList.add('visible');
  ph.style.left = '0%';

  const tick = () => {
    if (!trimState.open || vid.paused) {
      stopTrimPreview();
      return;
    }
    const t = vid.currentTime;
    document.getElementById('trimScrubTimeReadout').textContent = `Playing ${t.toFixed(2)}s`;
    const span = Math.max(0.05, trimState.outSec - trimState.inSec);
    const pct = Math.max(0, Math.min(100, ((t - trimState.inSec) / span) * 100));
    ph.style.left = `${pct.toFixed(1)}%`;

    if (t >= trimState.outSec) {
      stopTrimPreview();
      scrubTrimVideoTo(trimState.inSec);
      return;
    }
    trimState.previewRaf = requestAnimationFrame(tick);
  };
  trimState.previewRaf = requestAnimationFrame(tick);
}

function renderTrimHandlesUI() {
  const span = Math.max(0.1, trimState.viewEnd - trimState.viewStart);
  const leftPct = Math.max(0, Math.min(100, ((trimState.inSec - trimState.viewStart) / span) * 100));
  const rightEdgePct = Math.max(0, Math.min(100, ((trimState.outSec - trimState.viewStart) / span) * 100));
  const widthPct = Math.max(1.5, rightEdgePct - leftPct);

  document.getElementById('trimCurtainLeft').style.width = `${leftPct.toFixed(2)}%`;
  document.getElementById('trimCurtainRight').style.width = `${Math.max(0, 100 - rightEdgePct).toFixed(2)}%`;

  const box = document.getElementById('trimWindowBox');
  box.style.left = `${leftPct.toFixed(2)}%`;
  box.style.width = `${widthPct.toFixed(2)}%`;

  const len = Math.max(0.5, trimState.outSec - trimState.inSec);
  document.getElementById('trimInVal').textContent = `${trimState.inSec.toFixed(2)}s`;
  document.getElementById('trimOutVal').textContent = `${trimState.outSec.toFixed(2)}s`;
  document.getElementById('trimLenVal').textContent = `${len.toFixed(2)}s`;
  document.getElementById('trimHandleInTag').textContent = `IN ${trimState.inSec.toFixed(2)}s`;
  document.getElementById('trimHandleOutTag').textContent = `OUT ${trimState.outSec.toFixed(2)}s`;
}

function renderTrimWaveformCanvas() {
  const canvas = document.getElementById('trimWaveformCanvas');
  if (!canvas || !trimState.video) return;

  const rect = canvas.parentElement.getBoundingClientRect();
  const cssW = Math.max(320, Math.round(rect.width || 490));
  const cssH = Math.max(96, Math.round(rect.height || 132));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#05070b';
  ctx.fillRect(0, 0, cssW, cssH);

  const v = trimState.video;
  const dur = Math.max(0.5, v.duration || 5.0);
  const vStart = trimState.viewStart;
  const vEnd = trimState.viewEnd;
  const vSpan = Math.max(0.2, vEnd - vStart);
  const midY = (cssH - 18) / 2;

  // Center baseline
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(cssW, midY);
  ctx.stroke();

  // 1. Background envelope from video.waveformPeaks across [vStart .. vEnd]
  const peaks = v.waveformPeaks || [];
  if (peaks.length > 0) {
    const maxPk = Math.max(...peaks, 0.05);
    ctx.fillStyle = 'rgba(148, 163, 184, 0.42)';
    for (let x = 0; x < cssW; x++) {
      const t = vStart + (x / cssW) * vSpan;
      const exactIdx = (t / dur) * (peaks.length - 1);
      const i0 = Math.max(0, Math.min(peaks.length - 1, Math.floor(exactIdx)));
      const i1 = Math.min(peaks.length - 1, i0 + 1);
      const frac = exactIdx - i0;
      const amp = ((peaks[i0] * (1 - frac) + peaks[i1] * frac) / maxPk) * (midY - 8);
      const h = Math.max(1.5, amp * 2);
      ctx.fillRect(x, midY - h / 2, 1, h);
    }
  }

  // 2. High-resolution sample-accurate waveform inside original slice buffer [origIn .. origOut]
  if (trimState.sliceAudioBuffer) {
    const ch = trimState.sliceAudioBuffer.getChannelData(0);
    const sr = trimState.sliceAudioBuffer.sampleRate;
    let maxAbs = 0.05;
    for (let i = 0; i < ch.length; i += 16) {
      const a = Math.abs(ch[i]);
      if (a > maxAbs) maxAbs = a;
    }

    ctx.fillStyle = '#38bdf8';
    for (let x = 0; x < cssW; x++) {
      const t0 = vStart + (x / cssW) * vSpan;
      const t1 = vStart + ((x + 1) / cssW) * vSpan;
      if (t1 < trimState.origIn || t0 > trimState.origOut) continue;

      const s0 = Math.max(0, Math.floor((t0 - trimState.origIn) * sr));
      const s1 = Math.min(ch.length, Math.ceil((t1 - trimState.origIn) * sr));
      if (s1 <= s0) continue;

      let localPeak = 0;
      const step = Math.max(1, Math.floor((s1 - s0) / 12));
      for (let s = s0; s < s1; s += step) {
        const av = Math.abs(ch[s]);
        if (av > localPeak) localPeak = av;
      }
      const amp = (localPeak / maxAbs) * (midY - 6);
      const h = Math.max(2, amp * 2);
      ctx.fillRect(x, midY - h / 2, 1, h);
    }
  }

  // 3. Subtle detected onset markers across [vStart .. vEnd]
  ctx.strokeStyle = 'rgba(245, 158, 11, 0.38)';
  ctx.setLineDash([3, 3]);
  for (const onset of v.allDetectedOnsets || []) {
    if (onset.startSec >= vStart && onset.startSec <= vEnd) {
      const ox = ((onset.startSec - vStart) / vSpan) * cssW;
      ctx.beginPath();
      ctx.moveTo(ox, 0);
      ctx.lineTo(ox, cssH - 18);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);

  // 4. Time ruler along bottom 18px
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(0, cssH - 18, cssW, 18);
  ctx.font = '10px "SF Mono", Menlo, monospace';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  const tickStep = vSpan <= 6 ? 0.5 : vSpan <= 16 ? 2.0 : 5.0;
  const firstTick = Math.ceil(vStart / tickStep) * tickStep;
  for (let t = firstTick; t <= vEnd + 0.001; t += tickStep) {
    const x = ((t - vStart) / vSpan) * cssW;
    ctx.fillRect(x, cssH - 18, 1, 4);
    if (x > 8 && x < cssW - 28) {
      ctx.fillText(`${t.toFixed(tickStep < 1 ? 1 : 0)}s`, x + 3, cssH - 5);
    }
  }
}

async function openTrimModal(videoId, sliceId, playbackRate = 1.0) {
  const video = state.catalog?.videos.find(v => v.id === videoId);
  if (!video) return;
  const slice = (video.slices || []).find(s => s.id === sliceId && !s.deleted) || video.slices?.[0];
  if (!slice) return;

  stopTrimPreview();

  trimState.open = true;
  trimState.video = video;
  trimState.slice = slice;
  trimState.playbackRate = playbackRate || 1.0;
  trimState.origIn = Number(slice.startSec || 0);
  trimState.origOut = Number((slice.startSec + slice.durSec).toFixed(2));
  trimState.inSec = trimState.origIn;
  trimState.outSec = trimState.origOut;
  trimState.zoomMode = 'clip';
  trimState.sliceAudioBuffer = null;

  document.getElementById('trimZoomClipBtn').classList.add('active');
  document.getElementById('trimZoomFullBtn').classList.remove('active');

  const noteTag = slice.percBucket ? slice.percBucket.toUpperCase() : slice.name;
  document.getElementById('trimModalTitle').textContent =
    `Trim Clip In / Out — ${video.slug} (${noteTag})`;

  const vidEl = document.getElementById('trimScrubVideo');
  const sourceFile = video.sourceFile || `${video.slug}_source.mp4`;
  vidEl.src = `/samples/${video.folderName}/${sourceFile}`;
  vidEl.style.transform = video.extraRotateDeg ? `rotate(${video.extraRotateDeg}deg)` : '';

  document.getElementById('trimModal').classList.remove('hidden');

  computeTrimViewWindow();
  renderTrimHandlesUI();
  renderTrimWaveformCanvas();

  vidEl.onloadedmetadata = () => {
    scrubTrimVideoTo(trimState.inSec);
  };
  scrubTrimVideoTo(trimState.inSec);

  try {
    const buf = await loadAudioBuffer(slice.audioUrl);
    if (trimState.open && trimState.slice?.id === slice.id) {
      trimState.sliceAudioBuffer = buf;
      renderTrimWaveformCanvas();
    }
  } catch {}
}

function closeTrimModal() {
  stopTrimPreview();
  trimState.open = false;
  document.getElementById('trimModal').classList.add('hidden');
}

// ============================================================================
// API & Event Bindings
// ============================================================================
async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (res.ok) {
    state.assetBust = Date.now();
    audioBufferCache.clear();
    spectrogramBitmapCache.clear();
    miniSpecBitmapCache.clear();
    state.catalog = await res.json();
    refreshAllUI();
  }
  return res;
}

function refreshAllUI() {
  renderStats();
  renderPianoKeyboard();
  renderSelectedKeyDeck();
  renderPercussionRack();

  const libOpen = !document.getElementById('libraryDrawer').classList.contains('hidden');
  if (libOpen) {
    renderVideoGrid();
    const video = state.catalog?.videos.find(v => v.id === state.selectedVideoId);
    if (video) {
      const slice = (video.slices || []).find(s => s.id === state.selectedSliceId && !s.deleted);
      renderSourceWaveform(video, slice);
    }
  }
}

function stepToAdjacentPopulatedKey(dir) {
  let m = state.selectedMidi + dir;
  while (m >= 36 && m <= 103) {
    if ((state.catalog?.keyboardMap?.[m]?.candidateCount || 0) > 0) {
      selectKeyForConfig(m, true);
      return;
    }
    m += dir;
  }
}

function jumpToNextNewKey() {
  const keyMap = state.catalog?.keyboardMap || {};
  for (let offset = 1; offset <= 68; offset++) {
    const m = 36 + ((state.selectedMidi - 36 + offset) % 68);
    if ((keyMap[m]?.newCount || 0) > 0) {
      selectKeyForConfig(m, true);
      return;
    }
  }
}

function setupEventListeners() {
  // Global mouseup releases any mouse-held key or candidate card!
  window.addEventListener('mouseup', () => {
    releaseHeldVoice('mouse_hold');
  });
  window.addEventListener('blur', () => {
    for (const key of Array.from(activeVoices.keys())) {
      releaseHeldVoice(key, 0.25);
    }
  });

  // Wurli Toggle (Default OFF)
  const wurliBtn = document.getElementById('wurliToggleBtn');
  wurliBtn.addEventListener('click', () => {
    state.wurliEnabled = !state.wurliEnabled;
    wurliBtn.classList.toggle('active', state.wurliEnabled);
    document.getElementById('wurliStatusText').textContent = state.wurliEnabled ? 'ON' : 'OFF';
  });

  // Release Decay Time Slider (Default 0.65s)
  document.getElementById('releaseSlider').addEventListener('input', e => {
    state.releaseSec = Number(e.target.value);
    document.getElementById('releaseVal').textContent = `${state.releaseSec.toFixed(2)}s`;
  });

  // Master HPF Slider
  document.getElementById('hpSlider').addEventListener('input', e => {
    state.highpassHz = Number(e.target.value);
    document.getElementById('hpVal').textContent = `${state.highpassHz}Hz`;
    if (sampleHighpass && audioCtx) {
      sampleHighpass.frequency.setValueAtTime(state.highpassHz, audioCtx.currentTime);
    }
  });

  document.getElementById('jumpNewTopBtn').addEventListener('click', jumpToNextNewKey);

  // Drawers
  document.getElementById('openPercBtn').addEventListener('click', () => {
    document.getElementById('percDrawer').classList.remove('hidden');
  });
  document.getElementById('openLibraryBtn').addEventListener('click', () => {
    document.getElementById('libraryDrawer').classList.remove('hidden');
    renderVideoGrid();
    if (!state.selectedVideoId) {
      const firstVid = state.catalog?.videos.find(v => !v.deleted && v.slices?.length > 0);
      if (firstVid) selectVideoAndSlice(firstVid, firstVid.slices.find(s => !s.deleted), null, false);
    }
  });

  document.querySelectorAll('.close-drawer-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.close === 'trimModal') {
        closeTrimModal();
      } else {
        document.getElementById(btn.dataset.close).classList.add('hidden');
      }
    });
  });
  document.querySelectorAll('.drawer-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', e => {
      if (e.target === backdrop) {
        if (backdrop.id === 'trimModal') {
          closeTrimModal();
        } else {
          backdrop.classList.add('hidden');
        }
      }
    });
  });

  const findPlaybackRateForSlice = sliceId => {
    if (!sliceId || !state.catalog?.keyboardMap) return 1.0;
    const selEntry = state.catalog.keyboardMap[state.selectedMidi];
    const selCand = selEntry?.candidates?.find(c => c.sliceId === sliceId);
    if (selCand) return selCand.playbackRate || 1.0;
    for (const entry of Object.values(state.catalog.keyboardMap)) {
      const found = entry?.candidates?.find(c => c.sliceId === sliceId);
      if (found) return found.playbackRate || 1.0;
    }
    return 1.0;
  };

  // Trim In / Out button on Right-Side Stage Inspector pane
  document.getElementById('inspectActiveSliceBtn').addEventListener('click', () => {
    if (state.lastPlayedVideoId) {
      const rate = findPlaybackRateForSlice(state.lastPlayedSliceId);
      openTrimModal(state.lastPlayedVideoId, state.lastPlayedSliceId, rate);
    } else {
      const entry = state.catalog?.keyboardMap?.[state.selectedMidi];
      if (entry?.primary) {
        openTrimModal(entry.primary.videoId, entry.primary.sliceId, entry.primary.playbackRate || 1.0);
      } else {
        document.getElementById('libraryDrawer').classList.remove('hidden');
        renderVideoGrid();
      }
    }
  });

  // ==========================================================================
  // Focused Visual "Trim In / Out" Modal Drag & Control Bindings
  // ==========================================================================
  const MIN_TRIM_LEN = 0.50;
  const MAX_TRIM_LEN = 6.00;

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
    if (!trimState.open || !trimState.video) return;
    if (e.target.closest('#trimWindowBox')) return;
    e.preventDefault();
    stopTrimPreview();

    const stageEl = document.getElementById('trimTimelineStage');
    const rect = stageEl.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    const vidDur = Math.max(0.6, trimState.video.duration || 5.0);
    const clickSec = Math.max(
      0,
      Math.min(vidDur, trimState.viewStart + ratio * (trimState.viewEnd - trimState.viewStart))
    );

    if (clickSec < trimState.inSec) {
      const nextIn = Math.max(
        trimState.outSec - MAX_TRIM_LEN,
        Math.min(trimState.outSec - MIN_TRIM_LEN, clickSec)
      );
      trimState.inSec = Number(Math.max(0, nextIn).toFixed(2));
      trimState.dragMode = 'in';
      scrubTrimVideoTo(trimState.inSec);
    } else if (clickSec > trimState.outSec) {
      const nextOut = Math.min(
        trimState.inSec + MAX_TRIM_LEN,
        Math.max(trimState.inSec + MIN_TRIM_LEN, clickSec)
      );
      trimState.outSec = Number(Math.min(vidDur, nextOut).toFixed(2));
      trimState.dragMode = 'out';
      scrubTrimVideoTo(trimState.outSec);
    }
    trimState.dragStartX = e.clientX;
    trimState.dragStartIn = trimState.inSec;
    trimState.dragStartOut = trimState.outSec;
    renderTrimHandlesUI();
  });

  window.addEventListener('mousemove', e => {
    if (!trimState.open || !trimState.dragMode || !trimState.video) return;
    const stageEl = document.getElementById('trimTimelineStage');
    const rect = stageEl.getBoundingClientRect();
    const span = Math.max(0.1, trimState.viewEnd - trimState.viewStart);
    const deltaSec = ((e.clientX - trimState.dragStartX) / Math.max(1, rect.width)) * span;
    const vidDur = Math.max(0.6, trimState.video.duration || 5.0);

    if (trimState.dragMode === 'in') {
      let nextIn = trimState.dragStartIn + deltaSec;
      nextIn = Math.max(0, Math.min(vidDur - MIN_TRIM_LEN, nextIn));
      nextIn = Math.max(trimState.outSec - MAX_TRIM_LEN, Math.min(trimState.outSec - MIN_TRIM_LEN, nextIn));
      trimState.inSec = Number(nextIn.toFixed(2));
      renderTrimHandlesUI();
      scrubTrimVideoTo(trimState.inSec);
    } else if (trimState.dragMode === 'out') {
      let nextOut = trimState.dragStartOut + deltaSec;
      nextOut = Math.max(MIN_TRIM_LEN, Math.min(vidDur, nextOut));
      nextOut = Math.max(trimState.inSec + MIN_TRIM_LEN, Math.min(trimState.inSec + MAX_TRIM_LEN, nextOut));
      trimState.outSec = Number(nextOut.toFixed(2));
      renderTrimHandlesUI();
      scrubTrimVideoTo(trimState.outSec);
    } else if (trimState.dragMode === 'move') {
      const clipLen = Math.max(
        MIN_TRIM_LEN,
        Math.min(MAX_TRIM_LEN, trimState.dragStartOut - trimState.dragStartIn)
      );
      let nextIn = trimState.dragStartIn + deltaSec;
      nextIn = Math.max(0, Math.min(vidDur - clipLen, nextIn));
      trimState.inSec = Number(nextIn.toFixed(2));
      trimState.outSec = Number((trimState.inSec + clipLen).toFixed(2));
      renderTrimHandlesUI();
      scrubTrimVideoTo(trimState.inSec);
    }
  });

  window.addEventListener('mouseup', () => {
    if (trimState.dragMode) {
      trimState.dragMode = null;
    }
  });

  document.getElementById('trimZoomClipBtn').addEventListener('click', () => {
    trimState.zoomMode = 'clip';
    document.getElementById('trimZoomClipBtn').classList.add('active');
    document.getElementById('trimZoomFullBtn').classList.remove('active');
    computeTrimViewWindow();
    renderTrimHandlesUI();
    renderTrimWaveformCanvas();
  });

  document.getElementById('trimZoomFullBtn').addEventListener('click', () => {
    trimState.zoomMode = 'full';
    document.getElementById('trimZoomFullBtn').classList.add('active');
    document.getElementById('trimZoomClipBtn').classList.remove('active');
    computeTrimViewWindow();
    renderTrimHandlesUI();
    renderTrimWaveformCanvas();
  });

  document.querySelectorAll('#trimModal .nudge-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!trimState.open || !trimState.video) return;
      stopTrimPreview();
      const which = btn.dataset.nudge;
      const delta = Number(btn.dataset.delta || 0);
      const vidDur = Math.max(0.6, trimState.video.duration || 5.0);

      if (which === 'in') {
        let nextIn = trimState.inSec + delta;
        nextIn = Math.max(0, Math.min(vidDur - MIN_TRIM_LEN, nextIn));
        nextIn = Math.max(trimState.outSec - MAX_TRIM_LEN, Math.min(trimState.outSec - MIN_TRIM_LEN, nextIn));
        trimState.inSec = Number(nextIn.toFixed(2));
        renderTrimHandlesUI();
        scrubTrimVideoTo(trimState.inSec);
      } else {
        let nextOut = trimState.outSec + delta;
        nextOut = Math.max(MIN_TRIM_LEN, Math.min(vidDur, nextOut));
        nextOut = Math.max(trimState.inSec + MIN_TRIM_LEN, Math.min(trimState.inSec + MAX_TRIM_LEN, nextOut));
        trimState.outSec = Number(nextOut.toFixed(2));
        renderTrimHandlesUI();
        scrubTrimVideoTo(trimState.outSec);
      }
    });
  });

  document.getElementById('trimPreviewBtn').addEventListener('click', () => {
    startTrimPreview();
  });

  document.getElementById('trimOpenAdvancedBtn').addEventListener('click', () => {
    const vidId = trimState.video?.id;
    const slId = trimState.slice?.id;
    closeTrimModal();
    if (vidId) {
      openSlicerForVideoAndSlice(vidId, slId);
    }
  });

  document.getElementById('trimSaveBtn').addEventListener('click', async () => {
    if (!trimState.video || !trimState.slice) return;
    stopTrimPreview();
    const btn = document.getElementById('trimSaveBtn');
    btn.disabled = true;
    btn.textContent = 'Cutting...';

    const savedVideoId = trimState.video.id;
    const savedSliceId = trimState.slice.id;
    const savedRate = trimState.playbackRate || 1.0;
    const durSec = Number(
      Math.max(MIN_TRIM_LEN, Math.min(MAX_TRIM_LEN, trimState.outSec - trimState.inSec)).toFixed(2)
    );
    const payload = {
      videoId: savedVideoId,
      sliceId: savedSliceId,
      startSec: Number(trimState.inSec.toFixed(2)),
      durSec
    };
    // Preserve detected note pitch when fine-trimming pre-roll / tail around the same strike
    if (
      !trimState.slice.percBucket &&
      trimState.slice.freq &&
      Math.abs(trimState.inSec - trimState.origIn) < 0.65
    ) {
      payload.overrideFreq = trimState.slice.freq;
    }

    try {
      await apiPost('/api/slice/update', payload);
      closeTrimModal();

      const updatedVid = state.catalog?.videos.find(v => v.id === savedVideoId);
      const updatedSlice = updatedVid?.slices?.find(s => s.id === savedSliceId && !s.deleted);
      if (updatedSlice) {
        const enriched = { ...updatedSlice, videoSlug: updatedVid.slug };
        const buf = await loadAudioBuffer(updatedSlice.audioUrl);
        const playedFreq = Number(((updatedSlice.freq || 261.6) * savedRate).toFixed(1));
        const label = updatedSlice.percBucket
          ? updatedSlice.percBucket.toUpperCase()
          : updatedSlice.name;
        renderStageSpectrogramLive(enriched, buf, playedFreq, label, null);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = '✓ Save In / Out';
    }
  });

  document.getElementById('trimSaveNewBtn').addEventListener('click', async () => {
    if (!trimState.video) return;
    stopTrimPreview();
    const btn = document.getElementById('trimSaveNewBtn');
    btn.disabled = true;
    btn.textContent = 'Cutting...';
    const durSec = Number(
      Math.max(MIN_TRIM_LEN, Math.min(MAX_TRIM_LEN, trimState.outSec - trimState.inSec)).toFixed(2)
    );
    try {
      await apiPost('/api/slice/create', {
        videoId: trimState.video.id,
        startSec: Number(trimState.inSec.toFixed(2)),
        durSec
      });
      closeTrimModal();
    } finally {
      btn.disabled = false;
      btn.textContent = '+ Save as New Clip';
    }
  });

  // Candidate Strip Controls
  document.getElementById('prevKeyBtn').addEventListener('click', () => {
    selectKeyForConfig(state.selectedMidi - 1, true);
  });
  document.getElementById('nextKeyBtn').addEventListener('click', () => {
    selectKeyForConfig(state.selectedMidi + 1, true);
  });
  document.getElementById('nextPopulatedKeyBtn').addEventListener('click', () => {
    stepToAdjacentPopulatedKey(1);
  });
  document.getElementById('keyCandidateFilter').addEventListener('input', e => {
    state.keyCandidateFilter = e.target.value;
    renderSelectedKeyDeck();
  });
  document.getElementById('markKeySeenBtn').addEventListener('click', async () => {
    await apiPost('/api/keyboard/mark-seen', { midi: state.selectedMidi });
  });
  document.getElementById('markAllSeenBtn').addEventListener('click', async () => {
    await apiPost('/api/keyboard/mark-seen', { all: true });
  });
  document.getElementById('clearKeyBtn').addEventListener('click', async () => {
    await apiPost('/api/keyboard/select', { midi: state.selectedMidi, sliceId: null });
  });

  // Keyboard Dock Toolbar
  document.getElementById('kbHighlightGroup').addEventListener('click', e => {
    const btn = e.target.closest('.kb-pill');
    if (!btn) return;
    document.querySelectorAll('.kb-pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.kbHighlightMode = btn.dataset.hl;
    renderPianoKeyboard();
  });

  document.getElementById('octDownBtn').addEventListener('click', () => {
    state.baseOctaveMidi = Math.max(36, state.baseOctaveMidi - 12);
    renderPianoKeyboard();
  });
  document.getElementById('octUpBtn').addEventListener('click', () => {
    state.baseOctaveMidi = Math.min(84, state.baseOctaveMidi + 12);
    renderPianoKeyboard();
  });

  document.getElementById('fitKeysBtn').addEventListener('click', () => {
    state.kbZoomMode = 'fit';
    document.getElementById('fitKeysBtn').classList.add('active');
    document.getElementById('wideKeysBtn').classList.remove('active');
    renderPianoKeyboard();
  });
  document.getElementById('wideKeysBtn').addEventListener('click', () => {
    state.kbZoomMode = 'wide';
    document.getElementById('wideKeysBtn').classList.add('active');
    document.getElementById('fitKeysBtn').classList.remove('active');
    renderPianoKeyboard();
  });

  // Slicer Drawer Controls
  document.getElementById('searchInput').addEventListener('input', e => {
    state.searchQuery = e.target.value;
    renderVideoGrid();
  });
  document.getElementById('categorySelect').addEventListener('change', e => {
    state.selectedCategory = e.target.value;
    renderVideoGrid();
  });
  document.getElementById('sortSelect').addEventListener('change', e => {
    state.sortBy = e.target.value;
    renderVideoGrid();
  });

  const waveCanvas = document.getElementById('waveformCanvas');
  waveCanvas.addEventListener('click', e => {
    const video = state.catalog?.videos.find(v => v.id === state.selectedVideoId);
    if (!video) return;
    const rect = waveCanvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const clickSec = Number((ratio * video.duration).toFixed(2));
    let chosenStart = clickSec;
    let chosenDur = 2.2;
    for (const onset of video.allDetectedOnsets || []) {
      if (Math.abs(onset.startSec - clickSec) < 0.32) {
        chosenStart = onset.startSec;
        chosenDur = onset.durSec;
        break;
      }
    }
    document.getElementById('sliceStartInput').value = chosenStart;
    document.getElementById('sliceDurInput').value = chosenDur;
  });

  document.getElementById('recutSliceBtn').addEventListener('click', async () => {
    if (!state.selectedVideoId || !state.selectedSliceId) return;
    const btn = document.getElementById('recutSliceBtn');
    btn.textContent = 'Cutting...';
    audioBufferCache.clear();
    await apiPost('/api/slice/update', {
      videoId: state.selectedVideoId,
      sliceId: state.selectedSliceId,
      startSec: Number(document.getElementById('sliceStartInput').value),
      durSec: Number(document.getElementById('sliceDurInput').value),
      highpassHz: Number(document.getElementById('sliceHpInput').value),
      percBucket: document.getElementById('sliceBucketSelect').value
    });
    btn.textContent = 'Re-Cut Moment';
  });

  document.getElementById('addSliceAtStartBtn').addEventListener('click', async () => {
    if (!state.selectedVideoId) return;
    const btn = document.getElementById('addSliceAtStartBtn');
    btn.textContent = 'Cutting...';
    await apiPost('/api/slice/create', {
      videoId: state.selectedVideoId,
      startSec: Number(document.getElementById('sliceStartInput').value),
      durSec: Number(document.getElementById('sliceDurInput').value)
    });
    btn.textContent = '+ Cut New Moment';
  });

  // QWERTY Keydown / Keyup (Hold to Sustain + Lift to Decay!)
  window.addEventListener('keydown', async e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.metaKey || e.ctrlKey) {
      return;
    }

    if (e.key === 'Escape') {
      if (trimState.open) closeTrimModal();
      document.getElementById('percDrawer').classList.add('hidden');
      document.getElementById('libraryDrawer').classList.add('hidden');
      return;
    }

    if (trimState.open) {
      if ((e.code === 'Space' || e.key === ' ') && !e.repeat) {
        e.preventDefault();
        startTrimPreview();
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
      const cands = getFilteredCandidatesForSelectedKey();
      if (cands.length > 0) {
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        const nextIdx = (state.auditionIndex + delta + cands.length) % cands.length;
        startCandidateHold('arrow_cand', state.selectedMidi, cands[nextIdx], nextIdx);
        setTimeout(() => releaseHeldVoice('arrow_cand'), 260);
      }
      return;
    }
    if (e.key === 'Enter') {
      const cands = getFilteredCandidatesForSelectedKey();
      const chosen = cands[state.auditionIndex];
      if (chosen) {
        e.preventDefault();
        await apiPost('/api/keyboard/select', {
          midi: state.selectedMidi,
          sliceId: chosen.sliceId
        });
      }
      return;
    }

    if (e.repeat) return;

    if (e.code === 'Digit1') {
      e.preventDefault();
      startPercussionHold('qwerty_Digit1', 'kick');
      return;
    }
    if (e.code === 'Digit2') {
      e.preventDefault();
      startPercussionHold('qwerty_Digit2', 'snare');
      return;
    }
    if (e.code === 'Digit3') {
      e.preventDefault();
      startPercussionHold('qwerty_Digit3', 'hihat');
      return;
    }

    if (e.code === 'KeyZ') {
      state.baseOctaveMidi = Math.max(36, state.baseOctaveMidi - 12);
      renderPianoKeyboard();
      return;
    }
    if (e.code === 'KeyX') {
      state.baseOctaveMidi = Math.min(84, state.baseOctaveMidi + 12);
      renderPianoKeyboard();
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
    if (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3') {
      releaseHeldVoice(`qwerty_${e.code}`);
      return;
    }
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
        let count = 0;
        for (const input of midiAccess.inputs.values()) {
          count++;
          input.onmidimessage = msg => {
            const [status, data1, data2] = msg.data;
            const cmd = status & 0xf0;
            if (cmd === 0x90 && data2 > 0) {
              sustainedVoicesPendingRelease.delete(`midi_${data1}`);
              startPianoKeyHold(`midi_${data1}`, data1, data2 / 127, true);
            } else if (cmd === 0x80 || (cmd === 0x90 && data2 === 0)) {
              releaseHeldVoice(`midi_${data1}`);
            } else if (cmd === 0xb0 && data1 === 64) {
              // Sustain pedal CC 64
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
        if (count > 0) {
          document.getElementById('midiDot').style.background = '#10b981';
          document.getElementById('midiText').textContent = `MIDI (${count}) + QWERTY`;
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
  updateStageTileSizes();
  setupEventListeners();
  initWebMIDI();

  const res = await fetch('/api/catalog');
  state.catalog = await res.json();

  if (!state.catalog?.keyboardMap?.[60]) {
    const firstKey = Object.keys(state.catalog?.keyboardMap || {}).map(Number).sort((a, b) => a - b)[0];
    if (firstKey) state.selectedMidi = firstKey;
  }

  refreshAllUI();

  // Pre-render initial selected key's spectrogram on stage so the spectral view is populated on load!
  const initEntry = state.catalog?.keyboardMap?.[state.selectedMidi];
  if (initEntry?.primary) {
    loadAudioBuffer(initEntry.primary.audioUrl).then(buf => {
      const playedFreq = Number(((initEntry.primary.freq || 261.6) * initEntry.primary.playbackRate).toFixed(1));
      renderStageSpectrogramLive(initEntry.primary, buf, playedFreq, initEntry.targetName, null);
    }).catch(() => {});
  }
}

init();
