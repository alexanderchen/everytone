const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const ACCIDENTAL_SEMITONES = new Set([1, 3, 6, 8, 10]);
const MIN_MIDI = 24; // C1 (Start of 12-key Percussion Octave C1–B1; Tonal C2–G7 starts at 36)
const MAX_MIDI = 103; // G7

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
  selectedMidi: 60, // Defaults to C4
  auditionIndex: 0,
  kbZoomMode: 'fit', // 'fit' | 'wide'
  wurliEnabled: false, // Strictly OFF by default
  releaseSec: 0.65,
  highpassHz: 85,
  baseOctaveMidi: 60, // C4 (press Z down to C1 for Percussion Octave)
  sustainPedalDown: false,
  lastPlayedVideoId: null,
  lastPlayedSliceId: null,
  assetBust: 0
};

// Track last-played slice per MIDI key for no-immediate-repeat randomization when 2+ clips are ON
const lastPlayedSliceByMidi = new Map();

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
  // Never layer pitched Wurlitzer on the low Percussion Octave (MIDI 24..35)
  if (!state.wurliEnabled || midi === null || midi < 36) return null;
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
// Fixed 3-Slot 1:1 Square Stage + Left-to-Right Unveiling Spectrogram Strips
// ============================================================================
const STAGE_SLOT_COUNT = 3;
const MINI_SPEC_H = 54;
let stageSlotSeq = 0;
let currentStageTileSize = 260;
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

  const gap = 24;
  const availW = Math.max(240, stageEl.clientWidth - 56 - gap * (STAGE_SLOT_COUNT - 1));
  const availH = Math.max(120, stageEl.clientHeight - 28 - (MINI_SPEC_H + 6));
  const side = Math.max(96, Math.floor(Math.min(availH, availW / STAGE_SLOT_COUNT)));
  currentStageTileSize = side;
  grid.style.setProperty('--tile-size', `${side}px`);
}

window.addEventListener('resize', updateStageTileSizes);

function allocateStageSlotIndex() {
  for (let i = 0; i < STAGE_SLOT_COUNT; i++) {
    if (!stageSlots[i].occupied) return i;
  }
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
  const minFreq = 55;
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
      ctx.fillStyle = '#030406';
      ctx.fillRect(0, 0, cssW, cssH);

      const elapsed = Math.max(0, now - slot.voice.startedAt);
      const progress = Math.min(1, elapsed / Math.max(0.08, slot.voice.naturalDur));
      const revealW = Math.max(0, Math.min(cssW, progress * cssW));

      if (revealW > 0.5) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, revealW, cssH);
        ctx.clip();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(slot.miniBitmap, 0, 0, cssW, cssH);
        ctx.restore();
      }

      if (progress > 0 && progress < 0.998) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(revealW, 0);
        ctx.lineTo(revealW, cssH);
        ctx.stroke();
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

async function startHeldVoice({
  triggerId,
  midi = null,
  slice = null,
  playbackRate = 1.0,
  velocity = 0.92
}) {
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
    } else if (midi !== null) {
      setTimeout(() => {
        if (!isMidiStillHeld(midi)) setKeyActiveClass(midi, false);
      }, 120);
    }
    return;
  }

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

    attachSlotMiniSpectrogram(tileObj, slice, buffer, voice);

    if (voice.released) {
      applyVoiceReleaseRamp(voice, voice.releaseDur);
    } else {
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

  if (voice.wurliVoice) {
    const wg = voice.wurliVoice.env.gain;
    const wCur = Math.max(0.0002, wg.value || voice.wurliVoice.peakGain);
    wg.cancelScheduledValues(now);
    wg.setValueAtTime(wCur, now);
    wg.linearRampToValueAtTime(0.0001, now + rel);
    voice.wurliVoice.stopAt(now + rel + 0.02);
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
// Piano Key & Multi-Candidate Randomization Trigger Helpers
// ============================================================================
function pickEnabledCandidateForMidi(midi, entry) {
  const enabledCands = (entry?.candidates || []).filter(c => c.enabled);
  if (enabledCands.length === 0) return null;
  if (enabledCands.length === 1) {
    lastPlayedSliceByMidi.set(midi, enabledCands[0].sliceId);
    return enabledCands[0];
  }
  const lastId = lastPlayedSliceByMidi.get(midi);
  const nonRepeatPool = enabledCands.filter(c => c.sliceId !== lastId);
  const pool = nonRepeatPool.length > 0 ? nonRepeatPool : enabledCands;
  const chosen = pool[Math.floor(Math.random() * pool.length)];
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
// Rendering: Slim Minimal Note-Name Keyboard Bars & ON/OFF Candidate Strip
// ============================================================================
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
  const endOctName = midiToName(Math.min(MAX_MIDI, state.baseOctaveMidi + 17));
  document.getElementById('octaveLabel').textContent =
    `QWERTY: ${midiToName(state.baseOctaveMidi)} – ${endOctName}`;
  document.getElementById('midiText').textContent =
    `QWERTY ${midiToName(state.baseOctaveMidi)} (Z/X)`;

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

    const fullNoteName = midiToName(midi);
    const shortNote = midiToShortLabel(midi, isWide);
    const qLabel = qwertyByMidi.get(midi);

    let pipsHtml = '';
    if (enabledCount === 1) {
      pipsHtml = `<span class="key-pip"></span>`;
    } else if (enabledCount >= 2) {
      pipsHtml = `<span class="key-pip"></span><span class="key-pip"></span>`;
    }

    cell.innerHTML = `
      <div class="key-pips">${pipsHtml}</div>
      <div class="key-bottom-footer">
        ${qLabel ? `<span class="key-qwerty-tag">${qLabel}</span>` : ''}
        <span class="key-note-label">${shortNote}</span>
      </div>
    `;

    const roleMeta = isPercKey
      ? entry?.percRole || 'Percussion'
      : `${midiToFreq(midi)} Hz`;

    if (enabledCount > 0) {
      cell.title = `${fullNoteName} · ${roleMeta} — ${enabledCount} / ${candCount} ON`;
    } else if (candCount > 0) {
      cell.title = `${fullNoteName} · ${roleMeta} — All OFF (${candCount} candidates)`;
    } else {
      cell.title = `${fullNoteName} (${roleMeta}) — Empty`;
    }

    cell.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      selectKeyForConfig(midi, false);
      startPianoKeyHold('mouse_hold', midi, 0.92, false);
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

  document.getElementById('selectedKeyName').textContent = noteName;
  const metaEl = document.getElementById('selectedKeyMeta');
  if (isPercKey) {
    metaEl.textContent = entry?.percRole || 'Percussion';
    metaEl.classList.add('perc-role');
  } else {
    metaEl.textContent = `${freqStr} Hz`;
    metaEl.classList.remove('perc-role');
  }

  const totalCands = entry?.candidateCount || 0;
  const enabledCount = entry?.enabledCount || 0;
  document.getElementById('candidateSummaryLabel').textContent =
    totalCands > 0
      ? `${enabledCount} / ${totalCands} ON${enabledCount >= 2 ? ' · Random' : ''}`
      : '0 Clips';

  const grid = document.getElementById('candidatesGrid');
  grid.innerHTML = '';

  const candidates = getCandidatesForSelectedKey();
  if (candidates.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-key-state';
    emptyDiv.innerHTML = `
      <h3>${noteName} (${freqStr} Hz) — Empty</h3>
      <p>No clip sits within ±50c of ${noteName}.</p>
    `;
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

    const shiftStr = cand.shiftCents >= 0 ? `+${cand.shiftCents}c` : `${cand.shiftCents}c`;
    const techText = cand.isPerc
      ? `@${cand.startSec}s (${cand.durSec}s)`
      : `@${cand.startSec}s (${cand.durSec}s) · ${shiftStr}`;

    card.innerHTML = `
      <div class="cand-top">
        <div class="cand-thumb-wrap" title="Press & hold to audition on ${noteName}">
          <img src="${withBust(cand.thumbUrl)}" alt="${cand.videoSlug}" loading="lazy" />
          <div class="cand-play-overlay">▶</div>
        </div>
        <div class="cand-info">
          <div class="cand-slug-title" title="${cand.videoSlug}">${cand.videoSlug}</div>
          <div class="cand-tech-meta">${techText}</div>
        </div>
      </div>

      <div class="cand-actions">
        <button class="toggle-on-btn ${isEnabled ? 'is-on' : 'is-off'}" type="button" title="Toggle candidate ON / OFF (multiple ON clips randomize)">
          ${isEnabled ? '● ON' : '○ OFF'}
        </button>
        <button class="icon-tool-btn trim-btn" type="button" title="Inspect spectrogram, rename, override pitch, trim, or trash">
          Inspect
        </button>
      </div>
    `;

    card.addEventListener('mousedown', e => {
      if (e.button !== 0 || e.target.closest('button')) return;
      startCandidateHold('mouse_hold', midi, cand, idx);
    });

    card.querySelector('.toggle-on-btn').addEventListener('click', async e => {
      e.stopPropagation();
      const nextEnabled = !isEnabled;
      if (nextEnabled) {
        startCandidateHold('tap_commit', midi, cand, idx);
        setTimeout(() => releaseHeldVoice('tap_commit'), 220);
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
// Universal Clip Inspector Overlay (Rename + Rotate + Spectrogram + Peaks + Trim + Trash)
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
  zoomMode: 'clip',
  sliceAudioBuffer: null,
  previewRaf: null,
  dragMode: null,
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
  const specPh = document.getElementById('inspectorSpecPlayhead');
  if (specPh) specPh.classList.remove('visible');
  const btn = document.getElementById('trimPreviewBtn');
  if (btn) btn.textContent = '▶ Preview (Space)';
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
  const specPh = document.getElementById('inspectorSpecPlayhead');
  const btn = document.getElementById('trimPreviewBtn');
  btn.textContent = '⏹ Stop (Space)';

  vid.muted = false;
  vid.playbackRate = Math.max(0.5, Math.min(2.0, trimState.playbackRate || 1.0));
  vid.currentTime = trimState.inSec;
  vid.play().catch(() => {});

  ph.classList.add('visible');
  ph.style.left = '0%';
  const origSpan = Math.max(0.05, trimState.origOut - trimState.origIn);

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

    if (specPh) {
      if (t >= trimState.origIn && t <= trimState.origOut) {
        const specPct = Math.max(0, Math.min(100, ((t - trimState.origIn) / origSpan) * 100));
        specPh.classList.add('visible');
        specPh.style.left = `${specPct.toFixed(1)}%`;
      } else {
        specPh.classList.remove('visible');
      }
    }

    if (t >= trimState.outSec) {
      stopTrimPreview();
      scrubTrimVideoTo(trimState.inSec);
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
  const cssW = Math.max(320, Math.round(rect.width || 520));
  const cssH = Math.max(110, Math.round(rect.height || 148));
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
  const isPerc = isPercussionSlice(trimState.video, slice);
  const playedFreq = Number(((slice.freq || 261.6) * rate).toFixed(1));
  const f0Label = isPerc ? 'PERC' : slice.name;
  const cacheKey = `insp__${slice.audioUrl}__${playedFreq}__${isPerc ? 0 : 1}__${cssW}x${cssH}__${dpr}`;

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

  const origSpan = Math.max(0.05, trimState.origOut - trimState.origIn);
  const leftCut = Math.max(0, Math.min(cssW, ((trimState.inSec - trimState.origIn) / origSpan) * cssW));
  const rightKeep = Math.max(0, Math.min(cssW, ((trimState.outSec - trimState.origIn) / origSpan) * cssW));

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (leftCut > 1) {
    ctx.fillStyle = 'rgba(3, 4, 7, 0.72)';
    ctx.fillRect(0, 0, leftCut, cssH);
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(leftCut, 0);
    ctx.lineTo(leftCut, cssH);
    ctx.stroke();
  }
  if (rightKeep < cssW - 1) {
    ctx.fillStyle = 'rgba(3, 4, 7, 0.72)';
    ctx.fillRect(rightKeep, 0, cssW - rightKeep, cssH);
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(rightKeep, 0);
    ctx.lineTo(rightKeep, cssH);
    ctx.stroke();
  }
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

  if (trimState.sliceAudioBuffer) {
    renderInspectorSpectrogram();
  }
}

function renderTrimWaveformCanvas() {
  const canvas = document.getElementById('trimWaveformCanvas');
  if (!canvas || !trimState.video) return;

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

  const v = trimState.video;
  const dur = Math.max(0.5, v.duration || 5.0);
  const vStart = trimState.viewStart;
  const vEnd = trimState.viewEnd;
  const vSpan = Math.max(0.2, vEnd - vStart);
  const midY = (cssH - 18) / 2;

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(cssW, midY);
  ctx.stroke();

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

function populateInspectorHeaderAndPeaks() {
  const video = trimState.video;
  const slice = trimState.slice;
  if (!video || !slice) return;

  const isPerc = isPercussionSlice(video, slice);
  document.getElementById('inspectorSlugInput').value = video.slug || '';

  const noteLabelEl = document.getElementById('inspectorNoteLabel');
  if (isPerc) {
    noteLabelEl.textContent = '— Percussion';
  } else {
    noteLabelEl.textContent = `— ${slice.name}`;
  }

  const playedFreq = Number(((slice.freq || 261.6) * (trimState.playbackRate || 1.0)).toFixed(1));
  const f0Badge = document.getElementById('inspectorF0Badge');
  if (f0Badge) {
    f0Badge.textContent = isPerc
      ? `Center ~${playedFreq} Hz`
      : `f0: ${slice.name} · ${playedFreq} Hz`;
  }

  const specMeta = document.getElementById('inspectorSpecMeta');
  if (specMeta) {
    specMeta.textContent = `Clip @${trimState.origIn.toFixed(2)}s – ${trimState.origOut.toFixed(2)}s`;
  }

  const peaksRow = document.getElementById('inspectorPeaksRow');
  const peaksList = document.getElementById('inspectorPeaksList');
  peaksList.innerHTML = '';

  const peaks = slice.candidatePeaks || [];
  if (!isPerc && peaks.length > 0) {
    peaksRow.classList.remove('hidden');
    for (const pk of peaks) {
      const chip = document.createElement('button');
      chip.type = 'button';
      const isCurrent = Math.abs(pk.freq - slice.freq) < 6;
      chip.className = `peak-chip ${isCurrent ? 'selected' : ''}`;
      chip.textContent = `${pk.name} (${pk.freq}Hz)`;
      chip.addEventListener('click', async () => {
        await apiPost('/api/slice/update', {
          videoId: video.id,
          sliceId: slice.id,
          overrideFreq: pk.freq
        });
        const freshVideo = state.catalog?.videos.find(v => v.id === video.id);
        const freshSlice = freshVideo?.slices?.find(s => s.id === slice.id && !s.deleted);
        if (freshVideo && freshSlice) {
          trimState.video = freshVideo;
          trimState.slice = freshSlice;
          trimState.playbackRate = 1.0;
          if (freshSlice.midi >= MIN_MIDI && freshSlice.midi <= MAX_MIDI) {
            selectKeyForConfig(freshSlice.midi, false);
          }
          populateInspectorHeaderAndPeaks();
          renderInspectorSpectrogram();
        }
      });
      peaksList.appendChild(chip);
    }
  } else {
    peaksRow.classList.add('hidden');
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

  populateInspectorHeaderAndPeaks();

  const vidEl = document.getElementById('trimScrubVideo');
  const sourceFile = video.sourceFile || `${video.slug}_source.mp4`;
  vidEl.src = withBust(`/samples/${video.folderName}/${sourceFile}`);
  vidEl.style.transform = video.extraRotateDeg ? `rotate(${video.extraRotateDeg}deg)` : '';

  document.getElementById('trimModal').classList.remove('hidden');

  computeTrimViewWindow();
  renderTrimHandlesUI();
  renderTrimWaveformCanvas();
  renderInspectorSpectrogram();

  vidEl.onloadedmetadata = () => {
    scrubTrimVideoTo(trimState.inSec);
  };
  scrubTrimVideoTo(trimState.inSec);

  try {
    const buf = await loadAudioBuffer(slice.audioUrl);
    if (trimState.open && trimState.slice?.id === slice.id) {
      trimState.sliceAudioBuffer = buf;
      renderTrimWaveformCanvas();
      renderInspectorSpectrogram();
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
  renderPianoKeyboard();
  renderSelectedKeyDeck();
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

function setupEventListeners() {
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

  // Release Decay Time Slider
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

  // Universal "Inspect Clip" button in Top Controls Bar
  document.getElementById('inspectLatestBtn').addEventListener('click', () => {
    if (state.lastPlayedVideoId) {
      const rate = findPlaybackRateForSlice(state.lastPlayedSliceId);
      openTrimModal(state.lastPlayedVideoId, state.lastPlayedSliceId, rate);
    } else {
      const entry = state.catalog?.keyboardMap?.[state.selectedMidi];
      const fallback = entry?.primary || entry?.candidates?.[0];
      if (fallback) {
        openTrimModal(fallback.videoId, fallback.sliceId, fallback.playbackRate || 1.0);
      }
    }
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
        if (freshSlice) trimState.slice = freshSlice;
        populateInspectorHeaderAndPeaks();
        const vidEl = document.getElementById('trimScrubVideo');
        const sourceFile = freshVideo.sourceFile || `${freshVideo.slug}_source.mp4`;
        vidEl.src = withBust(`/samples/${freshVideo.folderName}/${sourceFile}`);
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
      if (freshVideo) {
        trimState.video = freshVideo;
        const vidEl = document.getElementById('trimScrubVideo');
        vidEl.style.transform = freshVideo.extraRotateDeg ? `rotate(${freshVideo.extraRotateDeg}deg)` : '';
      }
    } finally {
      rotateBtn.disabled = false;
      rotateBtn.textContent = '↻ 90°';
    }
  });

  // Inspector Footer Move Clip to Trash Button
  document.getElementById('inspectorTrashClipBtn').addEventListener('click', async () => {
    if (!trimState.open || !trimState.video || !trimState.slice) return;
    stopTrimPreview();
    const vidId = trimState.video.id;
    const slId = trimState.slice.id;
    closeTrimModal();
    await apiPost('/api/slice/trash', { videoId: vidId, sliceId: slId });
  });

  // ==========================================================================
  // Universal Clip Inspector Drag & Trim Bindings
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

  document.getElementById('trimSaveBtn').addEventListener('click', async () => {
    if (!trimState.video || !trimState.slice) return;
    stopTrimPreview();
    const btn = document.getElementById('trimSaveBtn');
    btn.disabled = true;
    btn.textContent = 'Cutting...';

    const savedVideoId = trimState.video.id;
    const savedSliceId = trimState.slice.id;
    const durSec = Number(
      Math.max(MIN_TRIM_LEN, Math.min(MAX_TRIM_LEN, trimState.outSec - trimState.inSec)).toFixed(2)
    );
    const payload = {
      videoId: savedVideoId,
      sliceId: savedSliceId,
      startSec: Number(trimState.inSec.toFixed(2)),
      durSec
    };
    if (
      !isPercussionSlice(trimState.video, trimState.slice) &&
      trimState.slice.freq &&
      Math.abs(trimState.inSec - trimState.origIn) < 0.65
    ) {
      payload.overrideFreq = trimState.slice.freq;
    }

    try {
      await apiPost('/api/slice/update', payload);
      closeTrimModal();
    } finally {
      btn.disabled = false;
      btn.textContent = '✓ Save Trim';
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

  // Keyboard Dock Toolbar (Z steps down to C1 = 24 for Percussion Octave!)
  document.getElementById('octDownBtn').addEventListener('click', () => {
    state.baseOctaveMidi = Math.max(MIN_MIDI, state.baseOctaveMidi - 12);
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
        startCandidateHold('arrow_cand', state.selectedMidi, cands[nextIdx], nextIdx);
        setTimeout(() => releaseHeldVoice('arrow_cand'), 260);
      }
      return;
    }
    if (e.key === 'Enter') {
      const cands = getCandidatesForSelectedKey();
      const chosen = cands[state.auditionIndex];
      if (chosen) {
        e.preventDefault();
        await apiPost('/api/keyboard/toggle', {
          midi: state.selectedMidi,
          sliceId: chosen.sliceId,
          enabled: !chosen.enabled
        });
      }
      return;
    }

    if (e.repeat) return;

    if (e.code === 'KeyZ') {
      state.baseOctaveMidi = Math.max(MIN_MIDI, state.baseOctaveMidi - 12);
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
  updateStageTileSizes();
}

init();
