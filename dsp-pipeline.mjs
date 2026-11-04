import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export const SR = 44100;
export const MAX_CLIP_DUR = 2.5;
const FFT_SIZE = 4096;
const HOP_SIZE = 1024; // ~23.2ms per frame

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function freqToMidi(freq) {
  if (!freq || freq <= 0 || !Number.isFinite(freq)) return null;
  const exactMidi = 69 + 12 * Math.log2(freq / 440);
  const midi = Math.round(exactMidi);
  const cents = Math.round((exactMidi - midi) * 100);
  const name = NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
  return { midi, name, cents, exactMidi: Number(exactMidi.toFixed(3)), freq: Number(freq.toFixed(1)) };
}

export function midiToName(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

export function midiToFreq(midi) {
  return Number((440 * Math.pow(2, (midi - 69) / 12)).toFixed(2));
}

// Initial object identifications from inspecting the 27 opening frames
export const INITIAL_VIDEO_META = {
  'PXL_20261101_162521928.mp4': { idx: 1, slug: 'ukulele-frets-high', category: 'strings', label: 'Ukulele Frets (High)' },
  'PXL_20261101_162606050.mp4': { idx: 2, slug: 'ukulele-frets-low', category: 'strings', label: 'Ukulele Frets (Low)' },
  'PXL_20261101_162617677.mp4': { idx: 3, slug: 'ukulele-frets-mid1', category: 'strings', label: 'Ukulele Frets (Mid 1)' },
  'PXL_20261101_162644263.mp4': { idx: 4, slug: 'ukulele-frets-mid2', category: 'strings', label: 'Ukulele Frets (Mid 2)' },
  'PXL_20261101_162758273.mp4': { idx: 5, slug: 'bamboo-flute', category: 'winds', label: 'Bamboo Flute' },
  'PXL_20261101_163617558.mp4': { idx: 6, slug: 'clock-chime-gears', category: 'metal', label: 'Clock Chime Gears' },
  'PXL_20261101_163639871.mp4': { idx: 7, slug: 'clock-chime-bell', category: 'metal', label: 'Clock Brass Bell' },
  'PXL_20261101_163746258.mp4': { idx: 8, slug: 'clock-pendulum', category: 'percussion', label: 'Clock Pendulum (Percussion)' },
  'PXL_20261101_163939046.mp4': { idx: 9, slug: 'glass-lamp-shade', category: 'percussion', label: 'Glass Lamp Switch & Shade (Percussion)' },
  'PXL_20261101_174337407.mp4': { idx: 10, slug: 'rubberband-bowl-1', category: 'strings', label: 'Rubber Band Bowl 1' },
  'PXL_20261101_174402733.mp4': { idx: 11, slug: 'rubberband-bowl-2', category: 'strings', label: 'Rubber Band Bowl 2' },
  'PXL_20261101_174416519.mp4': { idx: 12, slug: 'rubberband-bowl-3', category: 'strings', label: 'Rubber Band Bowl 3' },
  'PXL_20261101_174457761.mp4': { idx: 13, slug: 'rubberband-bowl-4', category: 'strings', label: 'Rubber Band Bowl 4' },
  'PXL_20261101_174817616.mp4': { idx: 14, slug: 'rubberband-bowl-bass', category: 'strings', label: 'Rubber Band Bowl Bass' },
  'PXL_20261101_181929284.mp4': { idx: 15, slug: 'wine-glass-rim', category: 'glass', label: 'Wine Glass Rim (D5)' },
  'PXL_20261101_182001592.mp4': { idx: 16, slug: 'wine-glass-pour', category: 'glass', label: 'Wine Glass Pouring Water' },
  'PXL_20261101_182052576.mp4': { idx: 17, slug: 'wine-glass-water-1', category: 'glass', label: 'Wine Glass Water 1 (C5)' },
  'PXL_20261101_182143954.mp4': { idx: 18, slug: 'wine-glass-water-2', category: 'glass', label: 'Wine Glass Water 2 (C5)' },
  'PXL_20261101_182549821.mp4': { idx: 19, slug: 'bike-bell-1', category: 'metal', label: 'Bicycle Bell 1' },
  'PXL_20261101_182607577.mp4': { idx: 20, slug: 'bike-bell-2', category: 'metal', label: 'Bicycle Bell 2' },
  'PXL_20261101_182632968.mp4': { idx: 21, slug: 'bike-bell-3', category: 'metal', label: 'Bicycle Bell 3' },
  'PXL_20261101_191719350.mp4': { idx: 22, slug: 'drumhead-mallet-1', category: 'toms', label: 'Drumhead Mallet Tom 1 (Tonal)' },
  'PXL_20261101_191823828.mp4': { idx: 23, slug: 'drumhead-mallet-2', category: 'toms', label: 'Drumhead Mallet Tom 2 (Tonal)' },
  'PXL_20261101_210448576.mp4': { idx: 24, slug: 'chord-organ-low', category: 'keys', label: 'Chord Organ (Low)' },
  'PXL_20261101_210539175.mp4': { idx: 25, slug: 'chord-organ-mid', category: 'keys', label: 'Chord Organ (Mid)' },
  'PXL_20261101_210842842.mp4': { idx: 26, slug: 'ukulele-open-strings', category: 'strings', label: 'Ukulele Open Strings' },
  'PXL_20261102_150349710.mp4': { idx: 27, slug: 'metal-bottle-blow', category: 'winds', label: 'Metal Bottle Blow' }
};

const hann = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
}

export function fftInPlace(real, imag) {
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

export function detectPitchYIN(buf, offset, windowSize = 2048, minFreq = 65, maxFreq = 3350) {
  const halfW = windowSize >> 1;
  const tauMin = Math.max(2, Math.floor(SR / maxFreq));
  const tauMax = Math.min(halfW - 1, Math.ceil(SR / minFreq));
  const yin = new Float32Array(tauMax + 1);
  yin[0] = 1.0;
  let runningSum = 0;

  for (let tau = 1; tau <= tauMax; tau++) {
    let diff = 0;
    for (let i = 0; i < halfW; i++) {
      const d = (buf[offset + i] || 0) - (buf[offset + i + tau] || 0);
      diff += d * d;
    }
    runningSum += diff;
    yin[tau] = runningSum > 0 ? (diff * tau) / runningSum : 1.0;
  }

  const threshold = 0.20;
  let bestTau = -1;
  for (let tau = tauMin; tau < tauMax; tau++) {
    if (yin[tau] < threshold) {
      while (tau + 1 < tauMax && yin[tau + 1] < yin[tau]) {
        tau++;
      }
      bestTau = tau;
      break;
    }
  }

  if (bestTau === -1) {
    let minVal = 1.0;
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (yin[tau] < minVal && yin[tau] < yin[tau - 1] && yin[tau] <= yin[tau + 1]) {
        minVal = yin[tau];
        bestTau = tau;
      }
    }
  }

  if (bestTau === -1 || yin[bestTau] > 0.55) {
    return { freq: 0, clarity: 0 };
  }

  const y1 = yin[bestTau - 1];
  const y2 = yin[bestTau];
  const y3 = yin[bestTau + 1];
  const denom = 2 * (2 * y2 - y3 - y1);
  const delta = denom !== 0 ? (y3 - y1) / denom : 0;
  const refinedTau = bestTau + Math.max(-0.5, Math.min(0.5, delta));

  return {
    freq: SR / refinedTau,
    clarity: Math.max(0, 1 - y2)
  };
}

export function analyzeSpectrum(buf, offset, minFreq = 65) {
  const real = new Float32Array(FFT_SIZE);
  const imag = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    real[i] = (buf[offset + i] || 0) * hann[i];
  }
  fftInPlace(real, imag);

  const half = FFT_SIZE >> 1;
  const mag = new Float32Array(half);
  for (let i = 0; i < half; i++) {
    mag[i] = Math.hypot(real[i], imag[i]);
  }

  const binHz = SR / FFT_SIZE;
  const minBin = Math.ceil(minFreq / binHz);
  const maxBin = Math.min(half - 2, Math.floor(4500 / binHz));

  const peaks = [];
  for (let k = minBin; k <= maxBin; k++) {
    if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1] && mag[k] > 1e-4) {
      const a = Math.log(mag[k - 1] + 1e-12);
      const b = Math.log(mag[k] + 1e-12);
      const c = Math.log(mag[k + 1] + 1e-12);
      const denom = a - 2 * b + c;
      const p = denom !== 0 ? 0.5 * (a - c) / denom : 0;
      const freq = (k + p) * binHz;
      peaks.push({ bin: k, freq, mag: mag[k] });
    }
  }
  peaks.sort((x, y) => y.mag - x.mag);

  let sumMag = 0;
  for (let k = minBin; k <= maxBin; k++) sumMag += mag[k];
  const topPeakMag = peaks.length > 0 ? peaks[0].mag : 0;
  const prominence = sumMag > 0 ? (topPeakMag * 10) / sumMag : 0;

  return {
    topPeaks: peaks.slice(0, 6),
    prominence: Math.min(1, prominence),
    mag
  };
}

export function getVideoRotationMetadata(filePath) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream_side_data=rotation',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath
    ]).toString().trim();
    return parseInt(out, 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Extract 512x512 center-cropped square thumbnail or silent MP4 clip.
 * Automatically ignores accidental -90/+90 portrait gravity tags on 1920x1080 sensor streams,
 * and applies any manual extra rotation (0, 90, 180, 270).
 */
export function buildSquareVideoFilter(size = 512, extraRotateDeg = 0, cropLeftFrac = null) {
  const xExpr = Number.isFinite(cropLeftFrac)
    ? `min(iw-min(iw\\,ih)\\,max(0\\,iw*${Number(cropLeftFrac).toFixed(4)}))`
    : '(iw-min(iw\\,ih))/2';
  const filters = [
    `crop=min(iw\\,ih):min(iw\\,ih):${xExpr}:(ih-min(iw\\,ih))/2`,
    `scale=${size}:${size}`
  ];
  const rot = ((extraRotateDeg % 360) + 360) % 360;
  if (rot === 90) filters.push('transpose=1');
  else if (rot === 180) filters.push('transpose=1,transpose=1');
  else if (rot === 270) filters.push('transpose=2');
  return filters.join(',');
}

export function extractSquareThumbnail(sourceMp4, outJpg, timeSec = 0.1, extraRotateDeg = 0, cropLeftFrac = null) {
  const rotMeta = getVideoRotationMetadata(sourceMp4);
  const noAutoRotate = (rotMeta === -90 || rotMeta === 90) ? ['-noautorotate'] : [];
  const vf = buildSquareVideoFilter(512, extraRotateDeg, cropLeftFrac);
  execFileSync('ffmpeg', [
    '-y', ...noAutoRotate, '-ss', String(Math.max(0, timeSec)),
    '-i', sourceMp4, '-frames:v', '1', '-vf', vf, '-q:v', '3', outJpg
  ], { stdio: 'ignore' });
}

export function extractSliceAssets(sourceMp4, startSec, durSec, outMp4, outWav, extraRotateDeg = 0, highpassHz = 85, cropLeftFrac = null) {
  const clampedDur = Math.max(0.25, Math.min(MAX_CLIP_DUR, Number(durSec) || 2.0));
  const rotMeta = getVideoRotationMetadata(sourceMp4);
  const noAutoRotate = (rotMeta === -90 || rotMeta === 90) ? ['-noautorotate'] : [];
  const vf = buildSquareVideoFilter(512, extraRotateDeg, cropLeftFrac);

  // 1. Cut short silent 512x512 H.264 MP4 clip (capped <= 2.5s) with frequent keyframes for instant triggering
  execFileSync('ffmpeg', [
    '-y', ...noAutoRotate,
    '-ss', String(startSec.toFixed(3)),
    '-t', String(clampedDur.toFixed(3)),
    '-i', sourceMp4,
    '-an',
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
    '-g', '15', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outMp4
  ], { stdio: 'ignore' });

  // 2. Cut clean mono 44.1kHz 16-bit WAV (Web Audio handles the universal 0.4s release decay)
  const microFadeOutDur = 0.015;
  const microFadeOutStart = Math.max(0.02, clampedDur - microFadeOutDur);
  const af = [
    `highpass=f=${highpassHz}`,
    `afade=t=in:st=0:d=0.006`,
    `afade=t=out:st=${microFadeOutStart.toFixed(3)}:d=${microFadeOutDur.toFixed(3)}`
  ].join(',');

  execFileSync('ffmpeg', [
    '-y',
    '-ss', String(startSec.toFixed(3)),
    '-t', String(clampedDur.toFixed(3)),
    '-i', sourceMp4,
    '-vn', '-af', af,
    '-ac', '1', '-ar', String(SR), '-c:a', 'pcm_s16le',
    outWav
  ], { stdio: 'ignore' });
}

/**
 * Analyze a single slice region [startSec, startSec + durSec] from already-loaded PCM samples
 */
export function analyzeSliceRegion(samples, startSec, durSec, minFreq = 65) {
  const startSample = Math.max(0, Math.floor(startSec * SR));
  const endSample = Math.min(samples.length, Math.floor((startSec + durSec) * SR));
  const startF = Math.floor(startSample / HOP_SIZE);
  const endF = Math.max(startF, Math.floor((endSample - FFT_SIZE) / HOP_SIZE));

  // Find the loudest frame in the first 400ms of the slice so we measure right after the true strike peak
  let peakF = startF;
  let maxSliceRmsDb = -100;
  const searchEndF = Math.min(endF, startF + 18);
  for (let f = startF; f <= searchEndF; f++) {
    const off = f * HOP_SIZE;
    if (off + 2048 > samples.length) break;
    let sumSq = 0;
    for (let i = 0; i < 2048; i++) sumSq += samples[off + i] * samples[off + i];
    const db = 20 * Math.log10(Math.sqrt(sumSq / 2048) + 1e-8);
    if (db > maxSliceRmsDb) {
      maxSliceRmsDb = db;
      peakF = f;
    }
  }

  // Measure the resonant sustain window (+25ms to +450ms from peakF)
  const ringStartF = Math.min(endF, peakF + 1);
  const ringEndF = Math.max(ringStartF, Math.min(endF, peakF + 20));

  const pitchCandidates = [];
  let bestSpec = null;
  let maxRmsDb = -100;

  for (let rf = ringStartF; rf <= ringEndF; rf++) {
    const off = rf * HOP_SIZE;
    if (off + FFT_SIZE > samples.length) break;
    let sumSq = 0;
    for (let i = 0; i < 2048; i++) {
      const s = samples[off + i] || 0;
      sumSq += s * s;
    }
    const rmsDb = 20 * Math.log10(Math.sqrt(sumSq / 2048) + 1e-8);
    if (rmsDb < maxSliceRmsDb - 24) continue; // Ignore silent tail frames

    const yinRes = detectPitchYIN(samples, off, 4096, minFreq, 3350);
    const specRes = analyzeSpectrum(samples, off, minFreq);

    if (rmsDb > maxRmsDb || !bestSpec) {
      maxRmsDb = rmsDb;
      bestSpec = specRes;
    }

    let chosenFreq = yinRes.freq;
    let confidence = yinRes.clarity;

    // If spectral peak is much higher & prominent while YIN is weak or caught low rumble, prefer spectral peak
    if ((yinRes.clarity < 0.65 || chosenFreq < minFreq) && specRes.topPeaks.length > 0) {
      const inRangePeak = specRes.topPeaks.find(p => p.freq >= minFreq && p.freq <= 3350) || specRes.topPeaks[0];
      chosenFreq = inRangePeak.freq;
      confidence = Math.max(yinRes.clarity, specRes.prominence * 0.85);
    }
    if (chosenFreq >= minFreq && chosenFreq <= 3350) {
      pitchCandidates.push({ freq: chosenFreq, confidence, rms: rmsDb });
    }
  }

  let finalFreq = 261.6;
  let finalConf = 0.5;
  if (pitchCandidates.length > 0) {
    const midiVotes = new Map();
    for (const pc of pitchCandidates) {
      const m = Math.round(69 + 12 * Math.log2(pc.freq / 440));
      const w = (pc.confidence + 0.25) * Math.pow(10, (pc.rms - maxSliceRmsDb) / 30);
      const cur = midiVotes.get(m) || { weight: 0, freqs: [], confs: [] };
      cur.weight += w;
      cur.freqs.push(pc.freq);
      cur.confs.push(pc.confidence);
      midiVotes.set(m, cur);
    }
    let bestCluster = null;
    for (const cluster of midiVotes.values()) {
      if (!bestCluster || cluster.weight > bestCluster.weight) bestCluster = cluster;
    }
    bestCluster.freqs.sort((a, b) => a - b);
    finalFreq = bestCluster.freqs[Math.floor(bestCluster.freqs.length / 2)];
    finalConf = Math.max(...bestCluster.confs);
  } else if (bestSpec && bestSpec.topPeaks.length > 0) {
    finalFreq = bestSpec.topPeaks[0].freq;
    finalConf = bestSpec.prominence * 0.55;
  }

  const noteInfo = freqToMidi(finalFreq) || { midi: 60, name: 'C4', cents: 0, exactMidi: 60, freq: 261.6 };
  const candidatePeaks = bestSpec
    ? bestSpec.topPeaks.slice(0, 5).map(p => {
        const ni = freqToMidi(p.freq);
        return {
          freq: Number(p.freq.toFixed(1)),
          midi: ni ? ni.midi : 60,
          name: ni ? ni.name : 'C4',
          cents: ni ? ni.cents : 0,
          relDb: Number((20 * Math.log10((p.mag + 1e-8) / (bestSpec.topPeaks[0].mag + 1e-8))).toFixed(1))
        };
      })
    : [];

  return {
    ...noteInfo,
    peakDb: Number(maxSliceRmsDb.toFixed(1)),
    confidence: Number(finalConf.toFixed(2)),
    candidatePeaks
  };
}

/**
 * Full audio analysis of a video: computes downsampled waveform envelope,
 * detects true peak-aligned strike/note onsets (ignoring pre-hit thumb thumps),
 * and selects the cleanest slices per distinct pitch.
 */
export function analyzeVideoAudio(filePath, options = {}) {
  const minPitchHz = options.minPitchHz || 65;
  const analysisHighpass = Math.max(85, Math.min(220, Math.round(minPitchHz * 0.85)));

  const buf = execFileSync('ffmpeg', [
    '-v', 'error', '-i', filePath,
    '-vn', '-af', `highpass=f=${analysisHighpass}`, '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1'
  ], { maxBuffer: 90 * 1024 * 1024 });

  const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const duration = Number((samples.length / SR).toFixed(2));
  const numFrames = Math.max(0, Math.floor((samples.length - FFT_SIZE) / HOP_SIZE));

  const rmsDb = new Float32Array(numFrames);
  const flux = new Float32Array(numFrames);
  let prevMag = null;

  const real = new Float32Array(FFT_SIZE);
  const imag = new Float32Array(FFT_SIZE);

  for (let f = 0; f < numFrames; f++) {
    const off = f * HOP_SIZE;
    let sumSq = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = samples[off + i];
      sumSq += s * s;
      real[i] = s * hann[i];
      imag[i] = 0;
    }
    const rms = Math.sqrt(sumSq / FFT_SIZE);
    rmsDb[f] = 20 * Math.log10(rms + 1e-8);

    fftInPlace(real, imag);
    const maxB = 440; // Up to ~4.7kHz so high bells, chimes & glasses have crisp onset flux
    const curMag = new Float32Array(maxB);
    let fl = 0;
    for (let k = 6; k < maxB; k++) {
      curMag[k] = Math.log1p(12 * Math.hypot(real[k], imag[k]));
      if (prevMag) {
        const diff = curMag[k] - prevMag[k];
        if (diff > 0) fl += diff;
      }
    }
    flux[f] = fl;
    prevMag = curMag;
  }

  // Downsampled waveform peaks (180 buckets across duration)
  const numBuckets = 180;
  const bucketSize = Math.max(1, Math.floor(samples.length / numBuckets));
  const waveformPeaks = [];
  for (let b = 0; b < numBuckets; b++) {
    let maxAbs = 0;
    const start = b * bucketSize;
    const end = Math.min(samples.length, start + bucketSize);
    for (let i = start; i < end; i += 4) {
      const v = Math.abs(samples[i]);
      if (v > maxAbs) maxAbs = v;
    }
    waveformPeaks.push(Number(maxAbs.toFixed(3)));
  }

  const sortedDb = Array.from(rmsDb).sort((a, b) => a - b);
  const noiseFloorDb = sortedDb[Math.floor(sortedDb.length * 0.20)] || -60;
  const peakDb = sortedDb[Math.floor(sortedDb.length * 0.99)] || -20;

  // Reject completely silent / false-start clips where nothing was struck
  if (peakDb < -52 && (peakDb - noiseFloorDb) < 7.5) {
    return {
      duration,
      noiseFloorDb: Number(noiseFloorDb.toFixed(1)),
      peakDb: Number(peakDb.toFixed(1)),
      waveformPeaks,
      allDetectedOnsets: [],
      selectedSlices: []
    };
  }

  // Require real note events to reach within 15 dB of the video's peak (rejects quiet thumb/handling thumps!)
  const minEventPeakDb = Math.max(noiseFloorDb + 10, peakDb - (options.allowWideDynamics ? 19 : 14));

  const minGapFrames = Math.round(0.42 * SR / HOP_SIZE);
  const sortedFlux = Array.from(flux).sort((a, b) => a - b);
  const medianFlux = sortedFlux[Math.floor(sortedFlux.length * 0.5)] || 1;
  const fluxThresh = Math.max(medianFlux * 2.4, 4.5);

  const eventFrames = [];
  let lastFrame = -minGapFrames;
  for (let f = 2; f < numFrames - 6; f++) {
    const isFluxPeak = flux[f] > fluxThresh && flux[f] >= flux[f - 1] && flux[f] >= flux[f + 1];
    const isSteepJump = (rmsDb[f] - rmsDb[Math.max(0, f - 2)]) > 5.0;

    if (isFluxPeak || isSteepJump) {
      // Look ahead 200ms to verify this event actually reaches minEventPeakDb
      let localMaxDb = rmsDb[f];
      let localPeakF = f;
      for (let k = f; k <= Math.min(numFrames - 1, f + 9); k++) {
        if (rmsDb[k] > localMaxDb) {
          localMaxDb = rmsDb[k];
          localPeakF = k;
        }
      }
      if (localMaxDb < minEventPeakDb) continue;

      // Snap attack frame right to the steepest climb leading into localPeakF (never 300ms early on a thumb rustle!)
      let attackF = f;
      let maxClimb = -999;
      for (let k = Math.max(1, localPeakF - 6); k <= localPeakF; k++) {
        const climb = (rmsDb[k] - rmsDb[k - 1]) + flux[k] * 0.25;
        if (climb > maxClimb && rmsDb[k] >= localMaxDb - 14) {
          maxClimb = climb;
          attackF = k;
        }
      }

      if (attackF - lastFrame >= minGapFrames) {
        eventFrames.push(attackF);
        lastFrame = attackF;
        f = Math.max(f, localPeakF + 2);
      } else if (eventFrames.length > 0) {
        // If a much louder real strike occurs right after a quiet thumb pre-click (< 420ms), replace the pre-click!
        const prevF = eventFrames[eventFrames.length - 1];
        let prevMaxDb = rmsDb[prevF];
        for (let k = prevF; k <= Math.min(numFrames - 1, prevF + 6); k++) {
          if (rmsDb[k] > prevMaxDb) prevMaxDb = rmsDb[k];
        }
        if (localMaxDb > prevMaxDb + 5.5) {
          eventFrames[eventFrames.length - 1] = attackF;
          lastFrame = attackF;
          f = Math.max(f, localPeakF + 2);
        }
      }
    }
  }

  // Fallback for smooth fade-in sustained sounds (e.g. rubbing wine glass rim or soft flute/bottle blow)
  if (eventFrames.length === 0 && numFrames > 0) {
    let inRegion = false;
    for (let f = 1; f < numFrames - 6; f++) {
      if (!inRegion && rmsDb[f] >= minEventPeakDb) {
        eventFrames.push(f);
        inRegion = true;
        lastFrame = f;
      } else if (inRegion && rmsDb[f] < minEventPeakDb - 8 && f - lastFrame >= minGapFrames) {
        inRegion = false;
      }
    }
    if (eventFrames.length === 0) {
      let bestF = 0;
      for (let f = 0; f < numFrames; f++) {
        if (rmsDb[f] > rmsDb[bestF]) bestF = f;
      }
      eventFrames.push(bestF);
    }
  }

  // Analyze every detected onset event
  const allCandidates = [];
  for (let idx = 0; idx < eventFrames.length; idx++) {
    const startF = eventFrames[idx];
    const nextF = idx + 1 < eventFrames.length ? eventFrames[idx + 1] : numFrames;
    const startSec = Number(Math.max(0, (startF * HOP_SIZE) / SR - 0.025).toFixed(2));
    const maxEndSec = Math.min(duration, ((nextF * HOP_SIZE) / SR) - 0.02);
    const durSec = Number(Math.min(MAX_CLIP_DUR, Math.max(0.8, maxEndSec - startSec)).toFixed(2));

    const analysis = analyzeSliceRegion(samples, startSec, durSec, minPitchHz);
    allCandidates.push({
      startSec,
      durSec,
      ...analysis
    });
  }

  // Filter out weak hits if stronger hits exist in the same video
  const maxCandDb = Math.max(...allCandidates.map(c => c.peakDb), -40);
  const maxConf = Math.max(...allCandidates.map(c => c.confidence), 0.5);
  const meaningful = allCandidates.filter(c => {
    const loudEnough = c.peakDb >= maxCandDb - (options.allowWideDynamics ? 18 : 10.5);
    const clearEnough = c.confidence >= Math.min(0.55, maxConf - 0.25);
    return loudEnough && clearEnough;
  });
  const pool = meaningful.length > 0 ? meaningful : allCandidates.slice(0, 2);

  // Deduplicate redundant strikes of the same MIDI note within the same video
  const byMidi = new Map();
  const scoreSlice = s => s.confidence * 2.0 + (s.peakDb - maxCandDb) / 8.0 - Math.abs(s.cents) / 250;

  for (const cand of pool) {
    const list = byMidi.get(cand.midi) || [];
    list.push(cand);
    byMidi.set(cand.midi, list);
  }

  const selectedSlices = [];
  const maxPerNote = byMidi.size === 1 ? 2 : 1;
  for (const [, list] of byMidi.entries()) {
    list.sort((a, b) => scoreSlice(b) - scoreSlice(a));
    selectedSlices.push(...list.slice(0, maxPerNote));
  }

  // Sort by quality first to cap, mark the #1 highest-scoring slice as best, then sort chronologically
  selectedSlices.sort((a, b) => scoreSlice(b) - scoreSlice(a));
  const capped = selectedSlices.slice(0, options.maxSlices || 8);
  if (capped.length > 0) {
    capped.forEach((s, i) => {
      s.isBestInVideo = i === 0;
    });
  }
  capped.sort((a, b) => a.startSec - b.startSec);

  return {
    duration,
    noiseFloorDb: Number(noiseFloorDb.toFixed(1)),
    peakDb: Number(peakDb.toFixed(1)),
    waveformPeaks,
    allDetectedOnsets: allCandidates.map(c => ({
      startSec: c.startSec,
      durSec: c.durSec,
      midi: c.midi,
      name: c.name,
      cents: c.cents,
      freq: c.freq,
      confidence: c.confidence,
      peakDb: c.peakDb
    })),
    selectedSlices: capped
  };
}

// Curated low-to-high 12-key Percussion Octave (MIDI 24 C1 -> 35 B1)
export const PERC_OCTAVE_ROLES = {
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

const PERC_SLICE_TO_MIDI = {
  // 24 C1 — Sub Kick (Puffball Mushroom 1)
  v53_s01: 24, v53_s02: 24, v08_s01: 24,
  // 25 C#1 — Deep Kick (Puffball Mushroom 2)
  v54_s01: 25, v54_s02: 25, v08_s03: 25,
  // 26 D1 — Soft Thud (Puffball + Lamp / Clock Low)
  v53_s03: 26, v08_s02: 26, v09_s01: 26,
  // 27 D#1 — Low Metal Thump (Bird Feeder Low)
  v55_s01: 27, v57_s01: 27,
  // 28 E1 — Low Wood Log
  v46_s01: 28, v48_s01: 28, v52_s01: 28,
  // 29 F1 — Warm Wood Log
  v44_s01: 29, v50_s01: 29, v51_s01: 29, v58_s01: 29,
  // 30 F#1 — Mid Wood Block
  v40_s01: 30, v43_s01: 30, v42_s01: 30, v41_s01: 30,
  // 31 G1 — High Wood Clack
  v45_s01: 31, v47_s01: 31, v49_s01: 31,
  // 32 G#1 — Hollow Resonance
  v08_s06: 32, v08_s04: 32, v08_s05: 32,
  // 33 A1 — Tin & Glass Rim
  v56_s01: 33, v59_s01: 33, v09_s02: 33, v09_s03: 33,
  // 34 A#1 — Ping-Pong & Clock Tick
  v110_s01: 34, v08_s09: 34, v08_s08: 34, v08_s07: 34,
  // 35 B1 — Crisp High Click
  v09_s04: 35, v09_s06: 35, v09_s05: 35, v09_s07: 35
};

const DEFAULT_PERC_ON_BY_MIDI = {
  24: 'v53_s01',
  25: 'v54_s01',
  26: 'v53_s03',
  27: 'v55_s01',
  28: 'v46_s01',
  29: 'v44_s01',
  30: 'v40_s01',
  31: 'v45_s01',
  32: 'v08_s06',
  33: 'v56_s01',
  34: 'v110_s01',
  35: 'v09_s04'
};

function inferPercMidiFallback(video, slice) {
  if ((video?.slug || '').includes('puffball')) return slice.freq < 100 ? 24 : 26;
  const f = slice?.freq || 200;
  if (f < 76) return 24;
  if (f < 86) return 25;
  if (f < 110) return 28;
  if (f < 160) return 26;
  if (f < 204) return 29;
  if (f < 230) return 30;
  if (f < 290) return 31;
  if (f < 360) return 32;
  if (f < 650) return 33;
  if (f < 1450) return 34;
  return 35;
}

export function isDefaultPercSlice(video, slice) {
  return (
    video?.category === 'percussion' ||
    slice?.percBucket === 'kick' ||
    slice?.percBucket === 'snare' ||
    slice?.percBucket === 'hihat'
  );
}

export function getDefaultSliceMidi(video, slice) {
  if (slice?.dspOriginal && Number.isFinite(slice.dspOriginal.midi)) {
    return Number(slice.dspOriginal.midi);
  }
  if (isDefaultPercSlice(video, slice)) {
    return PERC_SLICE_TO_MIDI[slice.id] ?? inferPercMidiFallback(video, slice);
  }
  return Number(slice?.midi ?? 60);
}

export function getEffectiveSliceMidi(video, slice) {
  if (Number.isFinite(slice?.manualMidi)) {
    return Number(slice.manualMidi);
  }
  if (isDefaultPercSlice(video, slice)) {
    return PERC_SLICE_TO_MIDI[slice.id] ?? inferPercMidiFallback(video, slice);
  }
  return Number(slice?.midi ?? 60);
}

/**
 * Unified Keyboard Configurator:
 *  - MIDI 24..35 (C1..B1): 12-key Percussion Octave mapped low kick (puffballs) -> high clicks
 *  - MIDI 36..103 (C2..G7): 68-key Nearest-Note Tonal Range (<= ±50c micro-tuning)
 *  - Supports manual MIDI slot reassignment (`s.manualMidi`) at original pitch (`1.0x`) + manual re-pitch (`s.manualTuneCents`),
 *    with non-destructive revert to `s.dspOriginal`.
 *  - Supports multiple `ON` clips per key (`keyboardConfig.enabledByMidi[midi]`) for round-robin / random playback.
 */
export function computeKeyboardMap(videos, keyboardConfig = {}) {
  if (!keyboardConfig.selectedByMidi) keyboardConfig.selectedByMidi = {};
  if (!keyboardConfig.enabledByMidi) keyboardConfig.enabledByMidi = {};
  if (!Array.isArray(keyboardConfig.clearedMidis)) keyboardConfig.clearedMidis = [];

  const clearedSet = new Set(keyboardConfig.clearedMidis.map(Number));
  const MIN_MIDI = 24;
  const MAX_MIDI = 103;
  const bucketsByMidi = new Map();

  function candidateQualityScore(v, s, shiftCents) {
    const isScaleExercise = v.slug.startsWith('ukulele-frets-');
    const isRubberbandBowl = v.slug.startsWith('rubberband-bowl');
    const objectBonus = isScaleExercise ? 0 : isRubberbandBowl ? 32 : 24;
    return (
      (s.starred ? 28 : 0) +
      (s.confidence ?? 0.85) * 30 +
      Math.max(-20, Math.min(18, ((s.peakDb ?? -22) + 24) * 1.1)) +
      objectBonus -
      Math.abs(shiftCents) * 0.45
    );
  }

  for (const v of videos) {
    if (v.deleted) continue;

    for (const s of v.slices || []) {
      if (s.deleted) continue;

      const dspMidi = getDefaultSliceMidi(v, s);
      const hasManualMove = Number.isFinite(s.manualMidi);
      const hasManualTune = Number.isFinite(s.manualTuneCents);
      const targetMidi = getEffectiveSliceMidi(v, s);

      if (!Number.isFinite(targetMidi) || targetMidi < MIN_MIDI || targetMidi > MAX_MIDI) {
        continue;
      }

      const isPercSlot = targetMidi < 36;
      const dspName =
        dspMidi < 36
          ? `${midiToName(dspMidi)} (${PERC_OCTAVE_ROLES[dspMidi] || 'Perc'})`
          : midiToName(dspMidi);

      let shiftCents = 0;
      let playbackRate = 1.0;
      const exactMidi = s.exactMidi ?? (s.midi + (s.cents || 0) / 100);

      if (hasManualMove || hasManualTune) {
        shiftCents = Math.round(Number(s.manualTuneCents || 0));
        playbackRate = Number(Math.pow(2, shiftCents / 1200).toFixed(4));
      } else if (!isPercSlot) {
        const shiftSemitones = targetMidi - exactMidi;
        shiftCents = Math.round(shiftSemitones * 100);
        playbackRate = Number(Math.pow(2, shiftSemitones / 12).toFixed(4));
      }

      const isOverridden =
        hasManualMove ||
        hasManualTune ||
        Boolean(s.dspOriginal && (targetMidi !== dspMidi || s.freq !== s.dspOriginal.freq));

      const rawDurSec = Number(Math.min(MAX_CLIP_DUR, Number(s.rawDurSec ?? s.durSec ?? 2.0)).toFixed(2));
      const trimIn = Number(Math.max(0, Math.min(Math.max(0, rawDurSec - 0.15), Number(s.trimIn ?? 0))).toFixed(2));
      const trimOut = Number(Math.max(Math.min(rawDurSec, trimIn + 0.15), Math.min(rawDurSec, Number(s.trimOut ?? rawDurSec))).toFixed(2));
      const activeDurSec = Number(Math.max(0.15, trimOut - trimIn).toFixed(2));
      const isTrimmed = trimIn > 0.005 || trimOut < rawDurSec - 0.005;

      if (isPercSlot) {
        const isDefaultHero = DEFAULT_PERC_ON_BY_MIDI[targetMidi] === s.id;
        const item = {
          videoId: v.id,
          videoIndex: v.index,
          videoSlug: v.slug,
          videoLabel: v.label,
          category: 'percussion',
          isPerc: true,
          thumbUrl: v.thumbUrl,
          sliceId: s.id,
          midi: targetMidi,
          name: PERC_OCTAVE_ROLES[targetMidi] || midiToName(targetMidi),
          dspMidi,
          dspName,
          manualMidi: hasManualMove ? targetMidi : null,
          manualTuneCents: hasManualTune ? Math.round(Number(s.manualTuneCents)) : (hasManualMove ? 0 : null),
          isOverridden,
          freq: s.freq,
          cents: 0,
          exactMidi: targetMidi,
          shiftCents,
          playbackRate,
          confidence: s.confidence ?? 0.85,
          peakDb: s.peakDb ?? -20,
          starred: !!s.starred,
          videoUrl: s.videoUrl,
          audioUrl: s.audioUrl,
          startSec: s.startSec,
          rawDurSec,
          trimIn,
          trimOut,
          durSec: activeDurSec,
          isTrimmed,
          _score: (isDefaultHero ? 1000 : 0) + (hasManualMove ? 500 : 0) - (s.freq || 0) * 0.01
        };
        const list = bucketsByMidi.get(targetMidi) || [];
        list.push(item);
        bucketsByMidi.set(targetMidi, list);
        continue;
      }

      const score = candidateQualityScore(v, s, shiftCents) + (hasManualMove ? 35 : 0);

      const item = {
        videoId: v.id,
        videoIndex: v.index,
        videoSlug: v.slug,
        videoLabel: v.label,
        category: v.category,
        isPerc: false,
        thumbUrl: v.thumbUrl,
        sliceId: s.id,
        midi: targetMidi,
        name: midiToName(targetMidi),
        dspMidi,
        dspName,
        manualMidi: hasManualMove ? targetMidi : null,
        manualTuneCents: hasManualTune ? Math.round(Number(s.manualTuneCents)) : (hasManualMove ? 0 : null),
        isOverridden,
        freq: s.freq,
        cents: s.cents || 0,
        exactMidi,
        shiftCents,
        playbackRate,
        confidence: s.confidence ?? 0.85,
        peakDb: s.peakDb ?? -20,
        starred: !!s.starred,
        videoUrl: s.videoUrl,
        audioUrl: s.audioUrl,
        startSec: s.startSec,
        rawDurSec,
        trimIn,
        trimOut,
        durSec: activeDurSec,
        isTrimmed,
        _score: score
      };

      const list = bucketsByMidi.get(targetMidi) || [];
      list.push(item);
      bucketsByMidi.set(targetMidi, list);
    }
  }

  const keyMap = {};

  for (let targetMidi = MIN_MIDI; targetMidi <= MAX_MIDI; targetMidi++) {
    const isPercKey = targetMidi < 36;
    const candidates = bucketsByMidi.get(targetMidi) || [];
    if (candidates.length === 0) {
      delete keyboardConfig.selectedByMidi[targetMidi];
      delete keyboardConfig.enabledByMidi[targetMidi];
      continue;
    }

    // Fixed stable order (never reorders when toggling ON/OFF)
    candidates.sort(
      (a, b) => b._score - a._score || a.videoIndex - b.videoIndex || a.startSec - b.startSec
    );
    for (const c of candidates) delete c._score;

    // Migrate or validate enabledByMidi[targetMidi]
    let enabledIds = keyboardConfig.enabledByMidi[targetMidi];
    if (!Array.isArray(enabledIds)) {
      if (clearedSet.has(targetMidi)) {
        enabledIds = [];
      } else if (isPercKey) {
        const heroId = DEFAULT_PERC_ON_BY_MIDI[targetMidi];
        const hero = candidates.find(c => c.sliceId === heroId) || candidates[0];
        enabledIds = hero ? [hero.sliceId] : [];
      } else {
        const savedId = keyboardConfig.selectedByMidi[targetMidi];
        const savedCand = candidates.find(c => c.sliceId === savedId) || candidates[0];
        enabledIds = savedCand ? [savedCand.sliceId] : [];
      }
    } else {
      enabledIds = enabledIds.filter(id => candidates.some(c => c.sliceId === id));
    }

    keyboardConfig.enabledByMidi[targetMidi] = enabledIds;
    if (enabledIds.length > 0) {
      keyboardConfig.selectedByMidi[targetMidi] = enabledIds[0];
      keyboardConfig.clearedMidis = keyboardConfig.clearedMidis.filter(m => Number(m) !== targetMidi);
    } else {
      delete keyboardConfig.selectedByMidi[targetMidi];
      if (!keyboardConfig.clearedMidis.includes(targetMidi)) {
        keyboardConfig.clearedMidis.push(targetMidi);
      }
    }

    const enabledSet = new Set(enabledIds);
    for (const c of candidates) {
      c.enabled = enabledSet.has(c.sliceId);
    }

    const primary = candidates.find(c => c.enabled) || null;
    const targetName = midiToName(targetMidi);
    const targetFreq = midiToFreq(targetMidi);

    keyMap[targetMidi] = {
      targetMidi,
      targetName,
      targetFreq,
      isPercKey,
      percRole: isPercKey ? PERC_OCTAVE_ROLES[targetMidi] : null,
      isCleared: enabledIds.length === 0,
      enabledSliceIds: enabledIds,
      enabledCount: enabledIds.length,
      activeSliceId: primary ? primary.sliceId : null,
      matchType: 'exact',
      shiftCents: primary ? primary.shiftCents : 0,
      semitoneSteps: 0,
      playbackRate: primary ? primary.playbackRate : 1.0,
      primary,
      candidates,
      candidateCount: candidates.length
    };
  }

  return keyMap;
}

/**
 * Build the 3 minimal Percussion Buckets: 'kick', 'snare', 'hihat'
 */
export function computePercussionMap(videos, prevPercMap = {}) {
  const buckets = {
    kick: { id: 'kick', label: 'Kick', keyShortcut: '1', midiNote: 36, activeSliceId: prevPercMap?.kick?.activeSliceId || null, slots: [] },
    snare: { id: 'snare', label: 'Snare', keyShortcut: '2', midiNote: 38, activeSliceId: prevPercMap?.snare?.activeSliceId || null, slots: [] },
    hihat: { id: 'hihat', label: 'Hi-Hat / Click', keyShortcut: '3', midiNote: 42, activeSliceId: prevPercMap?.hihat?.activeSliceId || null, slots: [] }
  };

  for (const v of videos) {
    if (v.deleted) continue;
    for (const s of v.slices || []) {
      if (s.deleted) continue;
      let b = s.percBucket;
      if (!b && v.category === 'percussion') {
        if (s.freq < 130) b = 'kick';
        else if (s.freq < 900) b = 'snare';
        else b = 'hihat';
      }
      if (b && buckets[b]) {
        buckets[b].slots.push({
          videoId: v.id,
          videoSlug: v.slug,
          videoLabel: v.label,
          thumbUrl: v.thumbUrl,
          sliceId: s.id,
          baseName: s.baseName,
          percBucket: b,
          percLabel: s.percLabel || `${v.slug} #${s.hitIndex}`,
          freq: s.freq,
          name: s.name,
          peakDb: s.peakDb,
          startSec: s.startSec,
          durSec: s.durSec,
          starred: !!s.starred,
          videoUrl: s.videoUrl,
          audioUrl: s.audioUrl
        });
      }
    }
  }

  for (const bKey of ['kick', 'snare', 'hihat']) {
    const bucket = buckets[bKey];
    if (bucket.slots.length > 0) {
      const stillValid = bucket.slots.some(sl => sl.sliceId === bucket.activeSliceId);
      if (!stillValid) {
        const starred = bucket.slots.find(sl => sl.starred);
        bucket.activeSliceId = (starred || bucket.slots[0]).sliceId;
      }
    } else {
      bucket.activeSliceId = null;
    }
  }

  return buckets;
}

