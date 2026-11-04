// Zero-dependency Standard MIDI File (.mid / .midi) parser
// Shared between browser live transport (public/app.js) and Node offline renderer (offline-render.mjs)

function readVarLen(bytes, offsetObj) {
  let value = 0;
  let count = 0;
  while (offsetObj.pos < bytes.length && count < 5) {
    const b = bytes[offsetObj.pos++];
    value = (value << 7) | (b & 0x7f);
    count++;
    if ((b & 0x80) === 0) break;
  }
  return value >>> 0;
}

function readUInt16BE(bytes, pos) {
  return ((bytes[pos] << 8) | bytes[pos + 1]) >>> 0;
}

function readUInt32BE(bytes, pos) {
  return (
    ((bytes[pos] << 24) >>> 0) +
    ((bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3])
  ) >>> 0;
}

export function parseMidiFile(inputBuffer) {
  const bytes =
    inputBuffer instanceof Uint8Array
      ? inputBuffer
      : new Uint8Array(inputBuffer);

  if (
    bytes.length < 14 ||
    bytes[0] !== 0x4d || // 'M'
    bytes[1] !== 0x54 || // 'T'
    bytes[2] !== 0x68 || // 'h'
    bytes[3] !== 0x64    // 'd'
  ) {
    throw new Error('Invalid MIDI file header (missing MThd)');
  }

  const headerLen = readUInt32BE(bytes, 4);
  const format = readUInt16BE(bytes, 8);
  const numTracks = readUInt16BE(bytes, 10);
  const division = readUInt16BE(bytes, 12);

  let isSmpte = false;
  let ticksPerBeat = 480;
  let ticksPerSecSmpte = null;

  if (division & 0x8000) {
    isSmpte = true;
    const rawFps = 256 - (division >> 8);
    const fps = rawFps === 29 ? 29.97 : rawFps;
    const ticksPerFrame = division & 0xff;
    ticksPerSecSmpte = fps * ticksPerFrame;
  } else {
    ticksPerBeat = Math.max(1, division);
  }

  let cursor = 8 + headerLen;
  const rawTickEvents = [];
  const tempoChanges = [{ tick: 0, usPerBeat: 500000 }]; // Default 120 BPM
  let orderSeq = 0;

  for (let trk = 0; trk < numTracks && cursor + 8 <= bytes.length; trk++) {
    const chunkId = String.fromCharCode(
      bytes[cursor],
      bytes[cursor + 1],
      bytes[cursor + 2],
      bytes[cursor + 3]
    );
    const chunkLen = readUInt32BE(bytes, cursor + 4);
    const trackStart = cursor + 8;
    const trackEnd = Math.min(bytes.length, trackStart + chunkLen);
    cursor = trackEnd;

    if (chunkId !== 'MTrk') continue;

    const ptr = { pos: trackStart };
    let absTick = 0;
    let runningStatus = 0;

    while (ptr.pos < trackEnd) {
      const delta = readVarLen(bytes, ptr);
      absTick += delta;
      if (ptr.pos >= trackEnd) break;

      let status = bytes[ptr.pos];
      if (status < 0x80) {
        if (!runningStatus) {
          ptr.pos++;
          continue;
        }
        status = runningStatus;
      } else {
        ptr.pos++;
        if (status < 0xf0) {
          runningStatus = status;
        } else if (status === 0xf0 || status === 0xf7) {
          runningStatus = 0;
        }
      }

      if (status === 0xff) {
        // Meta event
        if (ptr.pos >= trackEnd) break;
        const metaType = bytes[ptr.pos++];
        const len = readVarLen(bytes, ptr);
        const dataStart = ptr.pos;
        ptr.pos = Math.min(trackEnd, ptr.pos + len);

        if (metaType === 0x51 && len === 3 && dataStart + 3 <= trackEnd) {
          const usPerBeat =
            (bytes[dataStart] << 16) |
            (bytes[dataStart + 1] << 8) |
            bytes[dataStart + 2];
          if (usPerBeat > 0) {
            tempoChanges.push({ tick: absTick, usPerBeat, seq: orderSeq++ });
          }
        } else if (metaType === 0x2f) {
          // End of track
          break;
        }
      } else if (status === 0xf0 || status === 0xf7) {
        // SysEx event
        const len = readVarLen(bytes, ptr);
        ptr.pos = Math.min(trackEnd, ptr.pos + len);
      } else {
        const cmd = status & 0xf0;
        const channel = status & 0x0f;

        if (cmd === 0xc0 || cmd === 0xd0) {
          // 1-data-byte channel message (Program Change / Channel Pressure)
          ptr.pos = Math.min(trackEnd, ptr.pos + 1);
        } else {
          // 2-data-byte channel message
          if (ptr.pos + 1 >= trackEnd) {
            ptr.pos = trackEnd;
            break;
          }
          const d1 = bytes[ptr.pos++];
          const d2 = bytes[ptr.pos++];

          if (cmd === 0x90 && d2 > 0) {
            rawTickEvents.push({
              tick: absTick,
              seq: orderSeq++,
              type: 'noteOn',
              channel,
              midi: d1,
              velocity: Math.max(0.05, Math.min(1, d2 / 127))
            });
          } else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) {
            rawTickEvents.push({
              tick: absTick,
              seq: orderSeq++,
              type: 'noteOff',
              channel,
              midi: d1,
              velocity: 0
            });
          } else if (cmd === 0xb0 && d1 === 64) {
            rawTickEvents.push({
              tick: absTick,
              seq: orderSeq++,
              type: 'sustain',
              channel,
              pedalDown: d2 >= 64
            });
          }
        }
      }
    }
  }

  // Sort tempo map and collapse same-tick tempo changes to latest
  tempoChanges.sort((a, b) => a.tick - b.tick || (a.seq || 0) - (b.seq || 0));
  const tempoSegments = [];
  let accumSec = 0;
  let prevTick = 0;
  let curUsPerBeat = 500000;

  for (const tc of tempoChanges) {
    if (tc.tick > prevTick) {
      const dtTicks = tc.tick - prevTick;
      accumSec += (dtTicks / ticksPerBeat) * (curUsPerBeat / 1e6);
      prevTick = tc.tick;
    }
    curUsPerBeat = tc.usPerBeat;
    if (tempoSegments.length && tempoSegments[tempoSegments.length - 1].tick === tc.tick) {
      tempoSegments[tempoSegments.length - 1].usPerBeat = curUsPerBeat;
    } else {
      tempoSegments.push({ tick: tc.tick, timeSec: accumSec, usPerBeat: curUsPerBeat });
    }
  }
  if (tempoSegments.length === 0) {
    tempoSegments.push({ tick: 0, timeSec: 0, usPerBeat: 500000 });
  }

  function tickToSeconds(tick) {
    if (isSmpte && ticksPerSecSmpte) {
      return tick / ticksPerSecSmpte;
    }
    // Binary search last tempo segment <= tick
    let lo = 0;
    let hi = tempoSegments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tempoSegments[mid].tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    const seg = tempoSegments[lo];
    const extraTicks = Math.max(0, tick - seg.tick);
    return seg.timeSec + (extraTicks / ticksPerBeat) * (seg.usPerBeat / 1e6);
  }

  // Order noteOff slightly before noteOn on identical tick for clean re-articulation
  const typePriority = { noteOff: 0, sustain: 1, noteOn: 2 };
  rawTickEvents.sort((a, b) => {
    if (a.tick !== b.tick) return a.tick - b.tick;
    const pa = typePriority[a.type] ?? 1;
    const pb = typePriority[b.type] ?? 1;
    if (pa !== pb) return pa - pb;
    return a.seq - b.seq;
  });

  const timedEvents = rawTickEvents.map(ev => ({
    timeSec: tickToSeconds(ev.tick),
    type: ev.type,
    channel: ev.channel,
    midi: ev.midi,
    velocity: ev.velocity,
    pedalDown: ev.pedalDown
  }));

  // Normalize excessive leading silence down to a crisp 0.08s pre-roll
  const firstNoteOn = timedEvents.find(e => e.type === 'noteOn');
  const leadShift = firstNoteOn && firstNoteOn.timeSec > 0.25 ? firstNoteOn.timeSec - 0.08 : 0;
  if (leadShift > 0) {
    for (const ev of timedEvents) {
      ev.timeSec = Math.max(0, ev.timeSec - leadShift);
    }
  }

  let noteCount = 0;
  let lastEventSec = 0;
  for (const ev of timedEvents) {
    if (ev.type === 'noteOn') noteCount++;
    if (ev.timeSec > lastEventSec) lastEventSec = ev.timeSec;
  }

  return {
    format,
    ticksPerBeat,
    noteCount,
    durationSec: lastEventSec,
    events: timedEvents
  };
}
