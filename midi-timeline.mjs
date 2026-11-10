const MIN_MIDI = 12;
const MAX_MIDI = 108;
const MAX_CLIP_DUR = 6.00;
const DEFAULT_RELEASE_SEC = 0.40;
export const DEFAULT_UNIFORM_VELOCITY = 0.90;

export const SIDEBAR_CATEGORY_ORDER = [
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

export const BUILD_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

export function inferVideoGroupNameShared(videoOrSlug) {
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

/**
 * Canonical ordering of active catalog videos matching the top-left sidebar instrument explorer:
 * 1) Category order: strings -> winds -> keys -> metal -> glass -> wood -> toms -> percussion (+ any other alphabetically)
 * 2) Instrument group name (case-insensitive natural sort)
 * 3) Video slug (case-insensitive natural sort)
 */
export function sortCatalogVideosInSidebarOrder(videos = []) {
  const catRank = new Map(SIDEBAR_CATEGORY_ORDER.map((c, i) => [c, i]));
  return (videos || []).slice().sort((a, b) => {
    const catA = String(a?.category || 'other').toLowerCase();
    const catB = String(b?.category || 'other').toLowerCase();
    if (catA !== catB) {
      const rA = catRank.has(catA) ? catRank.get(catA) : 999;
      const rB = catRank.has(catB) ? catRank.get(catB) : 999;
      if (rA !== rB) return rA - rB;
      return catA.localeCompare(catB);
    }
    const grpA = inferVideoGroupNameShared(a).trim();
    const grpB = inferVideoGroupNameShared(b).trim();
    const grpCmp = grpA.localeCompare(grpB, undefined, { numeric: true, sensitivity: 'base' });
    if (grpCmp !== 0) return grpCmp;
    const slugCmp = String(a?.slug || '').localeCompare(String(b?.slug || ''), undefined, {
      numeric: true,
      sensitivity: 'base'
    });
    if (slugCmp !== 0) return slugCmp;
    return (a?.index || 0) - (b?.index || 0);
  });
}

export function resolveTransposedMidiNote(ev, transposeOctaves = 0) {
  if (!ev) return null;
  if (ev.channel === 9) return ev.midi; // Never pitch-shift General MIDI drum channel 10
  const octShift = Math.max(-4, Math.min(4, Math.round(Number(transposeOctaves) || 0)));
  if (octShift === 0) return ev.midi;
  const shifted = ev.midi + octShift * 12;
  const floorMidi = ev.midi >= 21 ? 21 : MIN_MIDI;
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

  // 6. Steal oldest playing slot:
  //    First protect live-held finger slots (`liveHeld`) by preferring non-live backing slots;
  //    within each tier, prefer same instrument first, else oldest overall.
  if (groupKey) {
    let oldestNonLiveSame = -1;
    let oldestAnySame = -1;
    for (let i = 0; i < count; i++) {
      if (slots[i].groupKey === groupKey) {
        if (!slots[i].liveHeld && (oldestNonLiveSame === -1 || slots[i].seq < slots[oldestNonLiveSame].seq)) {
          oldestNonLiveSame = i;
        }
        if (oldestAnySame === -1 || slots[i].seq < slots[oldestAnySame].seq) {
          oldestAnySame = i;
        }
      }
    }
    if (oldestNonLiveSame !== -1) return oldestNonLiveSame;
    let hasAnyNonLive = false;
    for (let i = 0; i < count; i++) {
      if (!slots[i].liveHeld) {
        hasAnyNonLive = true;
        break;
      }
    }
    if (!hasAnyNonLive && oldestAnySame !== -1) return oldestAnySame;
  }

  let oldestNonLiveIdx = -1;
  let oldestIdx = 0;
  for (let i = 0; i < count; i++) {
    if (!slots[i].liveHeld && (oldestNonLiveIdx === -1 || slots[i].seq < slots[oldestNonLiveIdx].seq)) {
      oldestNonLiveIdx = i;
    }
    if (slots[i].seq < slots[oldestIdx].seq) {
      oldestIdx = i;
    }
  }
  return oldestNonLiveIdx !== -1 ? oldestNonLiveIdx : oldestIdx;
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
  minDisplaySec = 0.70,
  maxDisplaySec = 1.00,
  transposeOctaves = 0,
  velocitySensitive = false,
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
  const effMinDisplaySec =
    minDisplaySec !== null && minDisplaySec !== undefined && Number.isFinite(Number(minDisplaySec))
      ? Math.max(0, Number(minDisplaySec))
      : 0.70;
  const rawMaxDisplaySec =
    maxDisplaySec !== null && maxDisplaySec !== undefined && Number(maxDisplaySec) > 0
      ? Number(maxDisplaySec)
      : null;
  const effMaxDisplaySec =
    rawMaxDisplaySec !== null ? Math.max(effMinDisplaySec, rawMaxDisplaySec) : null;

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
    const visualFadeTime = Math.max(t, voice.startSec + effMinDisplaySec);
    if (voice.fadeStartSec === null || visualFadeTime < voice.fadeStartSec) {
      const startOutAlpha = evalFadeInCurve(
        Math.max(0, visualFadeTime - voice.startSec),
        effFadeInSec
      );
      const effOutDur =
        effFadeOutSec <= 0.002 || startOutAlpha <= 0.003
          ? 0
          : Math.max(0.05, effFadeOutSec * Math.sqrt(startOutAlpha));
      voice.fadeStartSec = visualFadeTime;
      voice.visualEndSec = visualFadeTime + effOutDur;
      voice.tileReleaseSec = visualFadeTime;

      // Unified audio-visual envelope: hold audio up to visualFadeTime, then ramp down with visual Fade out
      if (voice.stolenAtSec === null) {
        const naturalEndSec = voice.startSec + voice.naturalDur;
        if (visualFadeTime < naturalEndSec) {
          const audioFadeDur = Math.min(
            Math.max(0.025, effOutDur),
            Math.max(0.02, naturalEndSec - visualFadeTime)
          );
          voice.earlyRelSec = visualFadeTime;
          voice.earlyRelDur = audioFadeDur;
          voice.earlyRelGainStart = computeScheduledGainAt(
            voice,
            Math.max(0, visualFadeTime - voice.startSec)
          );
          voice.endSec = Math.min(naturalEndSec, visualFadeTime + audioFadeDur);
        } else {
          voice.earlyRelSec = null;
          voice.endSec = naturalEndSec;
        }
      }
    } else {
      voice.tileReleaseSec = Math.min(voice.tileReleaseSec, voice.fadeStartSec);
    }
  }

  const voices = [];
  const activeHeld = new Map();
  const pendingPedalRelease = new Set();
  const pedalDownChannels = new Set();

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const t = ev.timeSec;
    const ch = Number.isFinite(ev.channel) ? Math.max(0, Math.min(15, Math.round(ev.channel))) : 0;

    if (ev.type === 'sustain') {
      if (ev.pedalDown) {
        pedalDownChannels.add(ch);
      } else {
        pedalDownChannels.delete(ch);
        const prefix = `${ch}_`;
        for (const k of Array.from(pendingPedalRelease)) {
          if (!k.startsWith(prefix)) continue;
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

    const holdKey = `${ch}_${ev.midi}`;
    if (ev.type === 'noteOff') {
      if (pedalDownChannels.has(ch)) {
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

      const forcedRelDur = Math.min(0.04, playDur * 0.25);
      const forcedRelStart = Math.max(0.012, playDur - forcedRelDur);

      const gainLinear = resolveCachedGainLinear(cand.videoId);
      const effVelocity = velocitySensitive
        ? (ev.velocity || DEFAULT_UNIFORM_VELOCITY)
        : DEFAULT_UNIFORM_VELOCITY;
      const peakGain = Math.min(1.85, 0.86 * effVelocity * gainLinear);

      const groupKey = resolveCachedGroupKey(cand);
      const slotIdx = allocateSlotAt(t, cand.sliceId, groupKey);

      const displaced = simSlots[slotIdx].voice;
      if (displaced && t < displaced.visualEndSec) {
        const isSameClip = displaced.sliceKey === cand.sliceId;
        displaced.visualEndSec = t;
        displaced.tileReleaseSec = Math.min(displaced.tileReleaseSec, t);
        // Let displaced notes of a different clip/instrument continue ringing naturally!
        // Only crossfade audio quickly if the exact same sample clip re-triggers onto itself.
        if (isSameClip) {
          if (displaced.holdKey && activeHeld.get(displaced.holdKey) === displaced) {
            activeHeld.delete(displaced.holdKey);
            pendingPedalRelease.delete(displaced.holdKey);
          }
          if (displaced.stolenAtSec === null && t < displaced.endSec) {
            const remSec = Math.max(0.016, displaced.endSec - t);
            const fadeSec = Math.min(0.016, remSec);
            displaced.stolenGainStart = evalVoiceGain(displaced, t);
            displaced.stolenAtSec = t;
            displaced.stolenFadeDur = fadeSec;
            displaced.endSec = Math.min(displaced.endSec, t + fadeSec);
          }
        }
      }

      const isPerc = Boolean(cand.isPerc);
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
      if (maxDisplayCutoff !== null && maxDisplayCutoff < t + playDur) {
        const initAudioFadeDur = Math.min(
          Math.max(0.025, maxDisplayOutDur),
          Math.max(0.02, t + playDur - maxDisplayCutoff)
        );
        voice.earlyRelSec = maxDisplayCutoff;
        voice.earlyRelDur = initAudioFadeDur;
        voice.earlyRelGainStart = computeScheduledGainAt(voice, Math.max(0, effMaxDisplaySec));
        voice.endSec = Math.min(t + playDur, maxDisplayCutoff + initAudioFadeDur);
      }

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

export const MIN_BUILD_MAX_FPS = 2;
export const MAX_BUILD_SHOWCASE_FPS = 15;
export const DEFAULT_BUILD_MAX_FPS = 12;
export const MIN_BUILD_SHOWCASE_SEC = 1 / MAX_BUILD_SHOWCASE_FPS; // ~0.0667s (15 fps ceiling)

export function clampBuildMaxFps(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BUILD_MAX_FPS;
  return Math.max(MIN_BUILD_MAX_FPS, Math.min(MAX_BUILD_SHOWCASE_FPS, Math.round(n)));
}

export function clampBuildFullSec(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 5.0;
  return Math.max(1.0, Math.min(25.0, Math.round(n * 2) / 2));
}

export function normalizeBuildRampUp(raw) {
  if (raw === undefined || raw === null) return true;
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (s === 'false' || s === '0' || s === 'off' || s === 'linear') return false;
    return true;
  }
  return Boolean(raw);
}

export function normalizeBuildSound(raw) {
  if (raw === undefined || raw === null) return true;
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (s === 'false' || s === '0' || s === 'off' || s === 'silent' || s === 'mute') return false;
    return true;
  }
  return Boolean(raw);
}

export function formatTunedFreqHz(f0Hz) {
  if (!Number.isFinite(f0Hz) || f0Hz <= 0) return '';
  const rounded = Math.round(f0Hz * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded} Hz` : `${rounded.toFixed(1)} Hz`;
}

export const BUILD_SAMPLE_ATTEN_DB = -12.0;
const BUILD_SAMPLE_ATTEN_LIN = Math.pow(10, BUILD_SAMPLE_ATTEN_DB / 20);
export const BUILD_TAP_BASE_GAIN = 0.14;
export const BUILD_TAP_HOLD_GAIN = 0.17;
export const BUILD_TAP_CENTER_HZ = 285;
export const DEFAULT_POST_BUILD_SILENCE_SEC = 0.70;

/**
 * Gentle, playful `process-case-study` `soft-tap` (~28ms pure sine downward-settling membrane tap: 1.45 * f0 -> f0).
 * Completely dry, airy, and non-fatiguing; modulated gently in pitch per step via `step.tapRate`.
 */
export function synthesizeBuildTapPcm(sampleRate = 48000) {
  const sr = Math.max(8000, Math.round(Number(sampleRate) || 48000));
  const durSec = 0.028;
  const len = Math.max(16, Math.ceil(durSec * sr));
  const out = new Float32Array(len);

  let phase = 0;
  let peak = 1e-6;
  const fEnd = BUILD_TAP_CENTER_HZ;
  const fStart = fEnd * 1.45;

  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const u = t / durSec;
    // Rapid smooth downward pitch inflection (1.45 * f0 -> f0)
    const f = fEnd + (fStart - fEnd) * Math.exp(-t / 0.0075);
    phase += (2 * Math.PI * f) / sr;

    const attack = t < 0.0024 ? 0.5 * (1 - Math.cos((Math.PI * t) / 0.0024)) : 1.0;
    const decay = Math.pow(1 - u, 1.85) * Math.exp(-t / 0.015);
    const sig = Math.sin(phase) * attack * decay;

    out[i] = sig;
    const a = Math.abs(sig);
    if (a > peak) peak = a;
  }

  const norm = 1 / peak;
  for (let i = 0; i < len; i++) {
    out[i] *= norm;
  }
  return out;
}

export function evalBuildAudioGain(step, t) {
  if (!step || t < step.startSec || t >= step.audioEndSec) return 0;
  const elapsed = t - step.startSec;
  const pk = step.peakGain;
  if (elapsed < 0.004) {
    return Math.max(0.0001, pk * (elapsed / 0.004));
  }
  if (elapsed <= step.relStartOffset) {
    return pk;
  }
  const u = Math.max(0, Math.min(1, (elapsed - step.relStartOffset) / Math.max(0.015, step.relDur)));
  if (u <= 0.38) return pk * (1 - (u / 0.38) * (1 - 0.52));
  if (u <= 0.74) return pk * (0.52 - ((u - 0.38) / 0.36) * (0.52 - 0.16));
  return Math.max(0, pk * 0.16 * (1 - (u - 0.74) / 0.26));
}

function invertMonotoneProgress(a, p, targetFrac) {
  if (targetFrac <= 0) return 0;
  if (targetFrac >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let it = 0; it < 36; it++) {
    const mid = 0.5 * (lo + hi);
    const val = a * mid + (1 - a) * Math.pow(mid, p);
    if (val < targetFrac) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return 0.5 * (lo + hi);
}

/**
 * Deterministic full-grid intro build animation planner shared by both live browser simulator and offline-render.mjs.
 * Completes the entire mosaic build in `fullDurationSec`:
 *  - `rampUp = true`: starts noticeably slower at the beginning and continuously accelerates all the way to the end.
 *  - `rampUp = false`: builds linearly at a constant tile rate from start to finish.
 * Main-area showcase flashes (and optional sound hits) are strictly capped at <= 15 fps (`showcaseSteps`),
 * skipping intermediate tiles smoothly while all `steps` still advance in the bottom mosaic grid.
 */
export function planIntroBuild({
  items = [],
  buildDurationSec = undefined,
  fullDurationSec = 5.0,
  rampUp = true,
  buildSound = true,
  maxFps = DEFAULT_BUILD_MAX_FPS,
  hasHandVideo = false,
  cameraFadeSec = 0.65,
  getVideoGainDb = () => 0
} = {}) {
  const N = items.length;
  const useRampUp = normalizeBuildRampUp(rampUp);
  const soundEnabled = normalizeBuildSound(buildSound);
  const effMaxFps = clampBuildMaxFps(maxFps);
  const minShowcaseSec = 1 / effMaxFps;

  if (N === 0) {
    return {
      rampUp: useRampUp,
      buildSound: soundEnabled,
      maxFps: effMaxFps,
      steps: [],
      showcaseSteps: [],
      tilesCompleteSec: 0,
      handFadeStartSec: null,
      handFadeEndSec: null,
      totalBuildSec: 0
    };
  }

  const startSecs = new Float64Array(N);
  const endSecs = new Float64Array(N);
  const stepIsHold = new Uint8Array(N);
  const totalSpan = clampBuildFullSec(buildDurationSec ?? fullDurationSec ?? 5.0);

  if (useRampUp) {
    const avgRate = N / totalSpan;
    // Start gently (~3.6 tiles/sec) and continuously ramp up via tau^3.8 all the way to the end
    const a = Math.max(0.01, Math.min(0.42, 3.6 / avgRate));
    const p = 3.8;
    let prevEnd = 0;
    for (let i = 0; i < N; i++) {
      const tEnd =
        i === N - 1
          ? totalSpan
          : invertMonotoneProgress(a, p, (i + 1) / N) * totalSpan;
      startSecs[i] = prevEnd;
      endSecs[i] = Math.max(prevEnd + 1e-4, tEnd);
      prevEnd = endSecs[i];
    }
  } else {
    // Linear constant speed across the entire build
    let prevEnd = 0;
    for (let i = 0; i < N; i++) {
      const tEnd = i === N - 1 ? totalSpan : ((i + 1) / N) * totalSpan;
      startSecs[i] = prevEnd;
      endSecs[i] = Math.max(prevEnd + 1e-4, tEnd);
      prevEnd = endSecs[i];
    }
  }
  stepIsHold[N - 1] = 1;

  const steps = new Array(N);
  for (let i = 0; i < N; i++) {
    const it = items[i];
    const cand = it.cand || it;
    const midi = Number.isFinite(it.midi) ? Math.round(it.midi) : 60;
    const isPerc = Boolean(it.isPerc);
    const rate = Number(cand?.playbackRate) > 0 ? Number(cand.playbackRate) : 1.0;
    const rawLimit = Math.min(
      MAX_CLIP_DUR,
      Math.max(0.12, Number(cand?.rawDurSec ?? cand?.durSec ?? MAX_CLIP_DUR))
    );
    const trimIn = Math.max(0, Math.min(Math.max(0, rawLimit - 0.08), Number(cand?.trimIn ?? 0)));
    const trimOut = Math.max(trimIn + 0.08, Math.min(rawLimit, Number(cand?.trimOut ?? rawLimit)));
    const unpitchedSpan = Math.max(0.08, trimOut - trimIn);
    const naturalDur = Math.min(MAX_CLIP_DUR, unpitchedSpan / rate);

    const startSec = startSecs[i];
    const endSec = endSecs[i];
    const durSec = Math.max(1e-4, endSec - startSec);
    const isClusterHold = stepIsHold[i] === 1;

    const gainDb =
      Number(
        it.videoGainDb !== undefined ? it.videoGainDb : getVideoGainDb(it.videoId || cand?.videoId)
      ) || 0;
    const gainLinear = Math.pow(10, gainDb / 20);

    const f0Hz = isPerc ? null : 440 * Math.pow(2, (midi - 69) / 12);
    const freqText = f0Hz ? formatTunedFreqHz(f0Hz) : '';
    const noteName = isPerc ? '' : BUILD_NOTE_NAMES[((midi % 12) + 12) % 12];
    const rawInstName =
      String(it.instrumentName || cand?.groupName || '').trim() ||
      (String(it.groupKey || '').includes('::')
        ? String(it.groupKey).split('::').slice(1).join('::')
        : '');
    const instrumentLabel = rawInstName.trim().toLowerCase();

    steps[i] = {
      idx: i,
      sliceId: it.sliceId || cand?.sliceId,
      videoId: it.videoId || cand?.videoId,
      groupKey: String(it.groupKey || ''),
      instrumentLabel,
      noteName,
      midi,
      isPerc,
      cand,
      playbackRate: rate,
      trimIn,
      unpitchedSpan,
      naturalDur,
      f0Hz,
      freqText,
      startSec,
      durSec,
      endSec,
      isClusterHold,
      gainLinear
    };
  }

  const tilesCompleteSec = endSecs[N - 1];

  // Build max-FPS-capped showcase schedule (`minShowcaseSec` = 1 / effMaxFps minimum per main-area flash)
  const rawShow = [];
  let curStep = steps[0];
  let curStart = 0;
  for (let i = 1; i < N; i++) {
    const st = steps[i];
    const minNext = curStart + minShowcaseSec - 1e-6;
    if (tilesCompleteSec - minNext < minShowcaseSec - 1e-6) {
      break;
    }
    if (st.startSec >= minNext) {
      if (tilesCompleteSec - st.startSec < minShowcaseSec - 1e-6) {
        continue;
      }
      rawShow.push({ base: curStep, showStartSec: curStart, showEndSec: st.startSec });
      curStep = st;
      curStart = st.startSec;
    }
  }
  rawShow.push({ base: curStep, showStartSec: curStart, showEndSec: tilesCompleteSec });

  const showcaseSteps = rawShow.map((entry, sIdx) => {
    const b = entry.base;
    const showStartSec = entry.showStartSec;
    const showEndSec = entry.showEndSec;
    const showDurSec = Math.max(minShowcaseSec, showEndSec - showStartSec);
    const baseVel = b.isClusterHold ? 0.88 : showDurSec < 0.09 ? 0.74 : 0.80;
    // Attenuate sample audio by -12 dB during build so samples sit softly underneath the gentle playful tap
    const peakGain = Math.min(0.45, baseVel * b.gainLinear * BUILD_SAMPLE_ATTEN_LIN);
    const tapGain = b.isClusterHold ? BUILD_TAP_HOLD_GAIN : BUILD_TAP_BASE_GAIN;
    // Modulate the gentle soft-tap pitch subtly (~±3.5 semitones around 285 Hz) tracking the sample's frequency
    let tapRate = 0.86;
    if (!b.isPerc && Number.isFinite(b.f0Hz) && b.f0Hz > 0) {
      const clampedLog = Math.max(-1.0, Math.min(1.0, Math.log2(b.f0Hz / 330) / 2.4));
      tapRate = Number(Math.pow(2, (clampedLog * 3.5) / 12).toFixed(4));
    } else if (b.isPerc) {
      const percNorm = ((Math.max(12, Math.min(35, b.midi)) - 24) / 12) * 1.6;
      tapRate = Number(Math.pow(2, (-2.2 + percNorm) / 12).toFixed(4));
    }
    const holdBeforeRel = Math.max(
      0.018,
      Math.min(showDurSec, Math.max(0.025, b.naturalDur - 0.04))
    );
    const maxRemain = Math.max(0.025, b.naturalDur - holdBeforeRel);
    const desiredRel = b.isClusterHold
      ? 0.16
      : Math.min(0.14, Math.max(0.05, showDurSec * 1.05));
    const relDur = Math.min(desiredRel, maxRemain);
    const audioEndSec = showStartSec + holdBeforeRel + relDur;

    return {
      ...b,
      showIdx: sIdx,
      tileStepIdx: b.idx,
      idx: sIdx,
      startSec: showStartSec,
      durSec: showDurSec,
      endSec: showEndSec,
      peakGain,
      tapGain,
      tapRate,
      relStartOffset: holdBeforeRel,
      relDur,
      audioEndSec
    };
  });

  const camRampDur = Math.min(0.20, Math.max(0.08, tilesCompleteSec * 0.5));
  const handFadeStartSec = hasHandVideo ? Math.max(0, tilesCompleteSec - camRampDur) : null;
  const handFadeEndSec = hasHandVideo ? tilesCompleteSec : null;
  // Allow ~0.80s after the last tile pops in so the chromatic build trail settles cleanly to neutral grey
  const totalBuildSec = tilesCompleteSec + 0.80;

  return {
    rampUp: useRampUp,
    buildSound: soundEnabled,
    maxFps: effMaxFps,
    steps,
    showcaseSteps,
    tilesCompleteSec,
    handFadeStartSec,
    handFadeEndSec,
    totalBuildSec
  };
}
