const MIN_MIDI = 24;
const MAX_MIDI = 103;
const MAX_CLIP_DUR = 2.50;
const DEFAULT_RELEASE_SEC = 0.40;

export function resolveTransposedMidiNote(ev, transposeOctaves = 0) {
  if (!ev) return null;
  if (ev.channel === 9) return ev.midi; // Never pitch-shift General MIDI drum channel 10
  const octShift = Math.max(-4, Math.min(4, Math.round(Number(transposeOctaves) || 0)));
  if (octShift === 0) return ev.midi;
  const shifted = ev.midi + octShift * 12;
  const floorMidi = ev.midi >= 36 ? 36 : MIN_MIDI;
  if (shifted < floorMidi || shifted > MAX_MIDI) return null;
  return shifted;
}

export function evalFadeInCurve(elapsedSec, fadeInSec) {
  if (fadeInSec <= 0.002) return 1.0;
  const u = Math.max(0, Math.min(1, elapsedSec / fadeInSec));
  return u * u * (3 - 2 * u);
}

export function computeScheduledGainAt(voice, elapsed) {
  const pk = voice.peakGain;
  if (elapsed <= 0) return 0.0001;
  if (elapsed < 0.006) return Math.max(0.0001, pk * (elapsed / 0.006));
  if (elapsed <= voice.forcedRelStart) return pk;
  const u = Math.max(
    0,
    Math.min(1, (elapsed - voice.forcedRelStart) / Math.max(0.02, voice.forcedRelDur))
  );
  if (u <= 0.35) return pk * (1 - (u / 0.35) * (1 - 0.56));
  if (u <= 0.72) return pk * (0.56 - ((u - 0.35) / 0.37) * (0.56 - 0.18));
  return Math.max(0.0001, pk * 0.18 * (1 - (u - 0.72) / 0.28));
}

export function evalVoiceGain(voice, t) {
  if (t < voice.startSec || t >= voice.endSec) return 0;
  if (voice.stolenAtSec !== null && t >= voice.stolenAtSec) {
    const dt = t - voice.stolenAtSec;
    const fDur = Math.max(0.01, voice.stolenFadeDur || 0.016);
    if (dt >= fDur) return 0;
    return voice.stolenGainStart * (1 - dt / fDur);
  }
  if (voice.earlyRelSec !== null && t >= voice.earlyRelSec) {
    const u = Math.max(
      0,
      Math.min(1, (t - voice.earlyRelSec) / Math.max(0.02, voice.earlyRelDur))
    );
    const g0 = voice.earlyRelGainStart;
    if (u <= 0.35) return g0 * (1 - (u / 0.35) * (1 - 0.56));
    if (u <= 0.72) return g0 * (0.56 - ((u - 0.35) / 0.37) * (0.56 - 0.18));
    return Math.max(0, g0 * 0.18 * (1 - (u - 0.72) / 0.28));
  }
  return computeScheduledGainAt(voice, t - voice.startSec);
}

/**
 * Shared deterministic stage slot allocator used by both live playing and MIDI timeline planning.
 * Each slot descriptor in `slots[0..slotCount-1]` exposes:
 *   { occupied, fadingOut, audioCompleted, seq, lastSeq, sliceKey, groupKey, rememberedGroupKey }
 */
export function chooseStageSlot(slots, slotCount, { sliceKey = '', groupKey = '' } = {}) {
  const count = Math.max(1, Math.min(slots.length, slotCount));

  // 1. Re-triggering the exact same sample overrides its own slot (including if fading out)
  if (sliceKey) {
    for (let i = 0; i < count; i++) {
      if (slots[i].occupied && slots[i].sliceKey === sliceKey) {
        return i;
      }
    }
  }

  // 2. Reclaim a slot of the same instrument if it is already fading out (never steal held chord notes)
  if (groupKey) {
    let bestSameFading = -1;
    for (let i = 0; i < count; i++) {
      const sl = slots[i];
      if (sl.occupied && sl.fadingOut && sl.groupKey === groupKey) {
        if (bestSameFading === -1 || sl.seq < slots[bestSameFading].seq) {
          bestSameFading = i;
        }
      }
    }
    if (bestSameFading !== -1) return bestSameFading;
  }

  // 3. Empty slot — prefer an empty slot that previously held this same instrument
  if (groupKey) {
    let bestEmptySame = -1;
    for (let i = 0; i < count; i++) {
      const sl = slots[i];
      if (!sl.occupied && sl.rememberedGroupKey === groupKey) {
        if (bestEmptySame === -1 || sl.lastSeq > slots[bestEmptySame].lastSeq) {
          bestEmptySame = i;
        }
      }
    }
    if (bestEmptySame !== -1) return bestEmptySame;
  }
  for (let i = 0; i < count; i++) {
    if (!slots[i].occupied) return i;
  }

  // 4. Interrupt a slot that is already fading out (prefer same instrument first, else oldest)
  let bestFadingSame = -1;
  let oldestFading = -1;
  for (let i = 0; i < count; i++) {
    const sl = slots[i];
    if (!sl.fadingOut) continue;
    if (groupKey && sl.groupKey === groupKey) {
      if (bestFadingSame === -1 || sl.seq < slots[bestFadingSame].seq) {
        bestFadingSame = i;
      }
    }
    if (oldestFading === -1 || sl.seq < slots[oldestFading].seq) {
      oldestFading = i;
    }
  }
  if (bestFadingSame !== -1) return bestFadingSame;
  if (oldestFading !== -1) return oldestFading;

  // 5. Steal audio-completed freeze-frame slot (prefer same instrument first, else oldest)
  let bestFrozenSame = -1;
  let oldestFrozen = -1;
  for (let i = 0; i < count; i++) {
    const sl = slots[i];
    if (!sl.audioCompleted) continue;
    if (groupKey && sl.groupKey === groupKey) {
      if (bestFrozenSame === -1 || sl.seq < slots[bestFrozenSame].seq) {
        bestFrozenSame = i;
      }
    }
    if (oldestFrozen === -1 || sl.seq < slots[oldestFrozen].seq) {
      oldestFrozen = i;
    }
  }
  if (bestFrozenSame !== -1) return bestFrozenSame;
  if (oldestFrozen !== -1) return oldestFrozen;

  // 6. Steal oldest playing slot (prefer same instrument first, else oldest overall)
  if (groupKey) {
    let oldestActiveSame = -1;
    for (let i = 0; i < count; i++) {
      if (slots[i].groupKey === groupKey) {
        if (oldestActiveSame === -1 || slots[i].seq < slots[oldestActiveSame].seq) {
          oldestActiveSame = i;
        }
      }
    }
    if (oldestActiveSame !== -1) return oldestActiveSame;
  }
  let oldestIdx = 0;
  for (let i = 1; i < count; i++) {
    if (slots[i].seq < slots[oldestIdx].seq) {
      oldestIdx = i;
    }
  }
  return oldestIdx;
}

/**
 * Pure-math O(N) timeline planner (~0.1-0.3ms).
 * Stamps `plannedMidi`, `plannedSlice`, and `plannedSlotIdx` onto every `noteOn` event in `parsed.events`,
 * and returns the full deterministic `voices` timeline for offline rendering.
 */
export function planMidiTimeline({
  parsed,
  keyboardMap = {},
  isVideoDisabled = () => false,
  getGroupKey = () => '',
  getVideoGainDb = () => 0,
  stageSlotCount = 6,
  fadeInSec = 0.0,
  fadeOutSec = 0.20,
  maxDisplaySec = null,
  transposeOctaves = 0,
  releaseSec = DEFAULT_RELEASE_SEC
}) {
  const events = parsed?.events || [];
  for (let i = 0; i < events.length; i++) {
    events[i].plannedMidi = null;
    events[i].plannedSlice = null;
    events[i].plannedSlotIdx = null;
  }
  if (!events.length) {
    return { voices: [], stageSlotCount };
  }

  const slotCount = Math.max(1, Math.round(stageSlotCount || 6));
  const effFadeInSec = Math.max(0, Number(fadeInSec) || 0);
  const effFadeOutSec = Math.max(0, Number(fadeOutSec ?? 0.2));
  const effMaxDisplaySec =
    maxDisplaySec !== null && maxDisplaySec !== undefined && Number(maxDisplaySec) > 0
      ? Number(maxDisplaySec)
      : null;

  const occurrenceByMidi = new Map();
  const enabledCacheByMidi = new Map();
  const groupKeyCacheByVideo = new Map();
  const gainLinCacheByVideo = new Map();

  function pickDeterministicCandidate(midi) {
    const occ = occurrenceByMidi.get(midi) || 0;
    occurrenceByMidi.set(midi, occ + 1);
    let enabled = enabledCacheByMidi.get(midi);
    if (!enabled) {
      enabled = (keyboardMap?.[midi]?.candidates || []).filter(
        c => c.enabled && !isVideoDisabled(c.videoId)
      );
      enabledCacheByMidi.set(midi, enabled);
    }
    if (!enabled.length) return null;
    return enabled[occ % enabled.length];
  }

  function resolveCachedGroupKey(cand) {
    const vid = cand.videoId || '';
    if (vid && groupKeyCacheByVideo.has(vid)) return groupKeyCacheByVideo.get(vid);
    const gk = String(getGroupKey(cand) || '');
    if (vid) groupKeyCacheByVideo.set(vid, gk);
    return gk;
  }

  function resolveCachedGainLinear(videoId) {
    const vid = videoId || '';
    if (vid && gainLinCacheByVideo.has(vid)) return gainLinCacheByVideo.get(vid);
    const db = Number(getVideoGainDb(videoId) || 0);
    const lin = Math.pow(10, db / 20);
    if (vid) gainLinCacheByVideo.set(vid, lin);
    return lin;
  }

  const simSlots = Array.from({ length: slotCount }, () => ({
    voice: null,
    seq: 0,
    lastGroupKey: '',
    lastSeq: 0
  }));
  const slotViews = Array.from({ length: slotCount }, () => ({
    occupied: false,
    fadingOut: false,
    audioCompleted: false,
    seq: 0,
    lastSeq: 0,
    sliceKey: '',
    groupKey: '',
    rememberedGroupKey: ''
  }));
  let slotSeq = 0;

  function allocateSlotAt(t, sliceKey, groupKey) {
    for (let i = 0; i < slotCount; i++) {
      const s = simSlots[i];
      if (s.voice && t >= s.voice.visualEndSec) {
        s.lastGroupKey = s.voice.groupKey || s.lastGroupKey || '';
        s.lastSeq = s.seq || s.lastSeq || 0;
        s.voice = null;
      }
      const v = s.voice;
      const view = slotViews[i];
      view.occupied = Boolean(v);
      view.fadingOut = Boolean(v && v.fadeStartSec !== null && t >= v.fadeStartSec && t < v.visualEndSec);
      view.audioCompleted = Boolean(v && t >= v.endSec);
      view.seq = s.seq;
      view.lastSeq = s.lastSeq;
      view.sliceKey = v ? v.sliceKey : '';
      view.groupKey = v ? v.groupKey : '';
      view.rememberedGroupKey = v ? v.groupKey : s.lastGroupKey;
    }
    return chooseStageSlot(slotViews, slotCount, { sliceKey, groupKey });
  }

  function triggerNoteRelease(voice, t) {
    if (!voice) return;
    voice.tileReleaseSec = Math.min(voice.tileReleaseSec, t);
    if (voice.fadeStartSec === null || t < voice.fadeStartSec) {
      const startOutAlpha = evalFadeInCurve(Math.max(0, t - voice.startSec), effFadeInSec);
      const effOutDur =
        effFadeOutSec <= 0.002 || startOutAlpha <= 0.003
          ? 0
          : Math.max(0.05, effFadeOutSec * Math.sqrt(startOutAlpha));
      voice.fadeStartSec = t;
      voice.visualEndSec = Math.min(voice.visualEndSec, t + effOutDur);
    }
    if (t >= voice.endSec || voice.earlyRelSec !== null) {
      return;
    }
    const elapsed = Math.max(0, t - voice.startSec);
    const remaining = Math.max(0.02, voice.naturalDur - elapsed);
    const rel = Math.min(releaseSec, remaining);
    voice.earlyRelSec = t;
    voice.earlyRelDur = rel;
    voice.earlyRelGainStart = computeScheduledGainAt(voice, elapsed);
    voice.endSec = Math.min(voice.endSec, t + rel);
  }

  const voices = [];
  const activeHeld = new Map();
  const pendingPedalRelease = new Set();
  let pedalDown = false;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const t = ev.timeSec;

    if (ev.type === 'sustain') {
      pedalDown = !!ev.pedalDown;
      if (!pedalDown && pendingPedalRelease.size > 0) {
        for (const k of Array.from(pendingPedalRelease)) {
          pendingPedalRelease.delete(k);
          const v = activeHeld.get(k);
          if (v) {
            activeHeld.delete(k);
            triggerNoteRelease(v, t);
          }
        }
      }
      continue;
    }

    const holdKey = `${ev.channel}_${ev.midi}`;
    if (ev.type === 'noteOff') {
      if (pedalDown) {
        if (activeHeld.has(holdKey)) pendingPedalRelease.add(holdKey);
      } else {
        const v = activeHeld.get(holdKey);
        if (v) {
          activeHeld.delete(holdKey);
          triggerNoteRelease(v, t);
        }
      }
      continue;
    }

    if (ev.type === 'noteOn') {
      const playedMidi = resolveTransposedMidiNote(ev, transposeOctaves);
      if (playedMidi === null || playedMidi < MIN_MIDI || playedMidi > MAX_MIDI) continue;
      ev.plannedMidi = playedMidi;

      pendingPedalRelease.delete(holdKey);
      const prevHeld = activeHeld.get(holdKey);
      if (prevHeld) {
        activeHeld.delete(holdKey);
        triggerNoteRelease(prevHeld, t);
      }

      const cand = pickDeterministicCandidate(playedMidi);
      if (!cand) continue;

      const rate = cand.playbackRate || 1.0;
      const rawLimit = Math.min(MAX_CLIP_DUR, Math.max(0.12, Number(cand.rawDurSec ?? MAX_CLIP_DUR)));
      const trimIn = Math.max(0, Math.min(Math.max(0, rawLimit - 0.08), Number(cand.trimIn ?? 0)));
      const trimOut = Math.max(trimIn + 0.08, Math.min(rawLimit, Number(cand.trimOut ?? rawLimit)));
      const unpitchedSpan = Math.max(0.08, trimOut - trimIn);
      const playDur = Math.min(MAX_CLIP_DUR, unpitchedSpan / rate);

      const forcedRelDur = Math.min(releaseSec, playDur * 0.78);
      const forcedRelStart = Math.max(0.012, playDur - forcedRelDur);

      const gainLinear = resolveCachedGainLinear(cand.videoId);
      const peakGain = Math.min(1.85, 0.86 * (ev.velocity || 0.85) * gainLinear);

      const groupKey = resolveCachedGroupKey(cand);
      const slotIdx = allocateSlotAt(t, cand.sliceId, groupKey);

      const displaced = simSlots[slotIdx].voice;
      if (displaced && t < displaced.visualEndSec) {
        const isSameClip = displaced.sliceKey === cand.sliceId;
        const alreadyFadingOut = displaced.fadeStartSec !== null && t >= displaced.fadeStartSec;
        displaced.visualEndSec = t;
        displaced.tileReleaseSec = Math.min(displaced.tileReleaseSec, t);
        if (!alreadyFadingOut || isSameClip) {
          if (displaced.holdKey && activeHeld.get(displaced.holdKey) === displaced) {
            activeHeld.delete(displaced.holdKey);
            pendingPedalRelease.delete(displaced.holdKey);
          }
          if (displaced.stolenAtSec === null && t < displaced.endSec) {
            const fadeSec = isSameClip ? 0.016 : 0.18;
            displaced.stolenGainStart = evalVoiceGain(displaced, t);
            displaced.stolenAtSec = t;
            displaced.stolenFadeDur = fadeSec;
            displaced.endSec = Math.min(displaced.endSec, t + fadeSec);
          }
        }
      }

      const isPerc = playedMidi < 36 || Boolean(cand.isPerc);
      const f0Hz = isPerc ? null : 440 * Math.pow(2, (playedMidi - 69) / 12);
      const maxDisplayCutoff = effMaxDisplaySec !== null ? t + effMaxDisplaySec : null;
      const maxDisplayStartOutAlpha =
        maxDisplayCutoff !== null ? evalFadeInCurve(effMaxDisplaySec, effFadeInSec) : 1;
      const maxDisplayOutDur =
        effFadeOutSec <= 0.002 || maxDisplayStartOutAlpha <= 0.003
          ? 0
          : Math.max(0.05, effFadeOutSec * Math.sqrt(maxDisplayStartOutAlpha));

      slotSeq += 1;
      const voice = {
        holdKey,
        midi: playedMidi,
        isPerc,
        cand,
        sliceKey: cand.sliceId,
        groupKey,
        slotIdx,
        playbackRate: rate,
        trimIn,
        unpitchedSpan,
        peakGain,
        startSec: t,
        naturalDur: playDur,
        forcedRelStart,
        forcedRelDur,
        earlyRelSec: null,
        earlyRelDur: releaseSec,
        earlyRelGainStart: peakGain,
        stolenAtSec: null,
        stolenGainStart: 0,
        stolenFadeDur: 0.016,
        endSec: t + playDur,
        maxDisplayCutoff,
        fadeStartSec: maxDisplayCutoff,
        visualEndSec: maxDisplayCutoff !== null ? maxDisplayCutoff + maxDisplayOutDur : Infinity,
        tileReleaseSec: maxDisplayCutoff !== null ? maxDisplayCutoff : Infinity,
        f0Hz
      };

      ev.plannedSlice = cand;
      ev.plannedSlotIdx = slotIdx;

      simSlots[slotIdx] = {
        voice,
        seq: slotSeq,
        lastGroupKey: groupKey || simSlots[slotIdx].lastGroupKey || '',
        lastSeq: slotSeq
      };
      activeHeld.set(holdKey, voice);
      voices.push(voice);
    }
  }

  const endCutoff = (Number(parsed?.durationSec) || 0) + 0.05;
  for (const v of activeHeld.values()) {
    triggerNoteRelease(v, endCutoff);
  }

  return { voices, stageSlotCount: slotCount };
}
