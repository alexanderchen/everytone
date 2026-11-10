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

function pushVarLen(out, value) {
  let v = Math.max(0, Math.floor(value || 0)) >>> 0;
  const bytes = [v & 0x7f];
  while ((v >>= 7) > 0) {
    bytes.push((v & 0x7f) | 0x80);
  }
  for (let i = bytes.length - 1; i >= 0; i--) {
    out.push(bytes[i]);
  }
}

function writeUInt16BE(out, pos, val) {
  out[pos] = (val >>> 8) & 0xff;
  out[pos + 1] = val & 0xff;
}

function writeUInt32BE(out, pos, val) {
  out[pos] = (val >>> 24) & 0xff;
  out[pos + 1] = (val >>> 16) & 0xff;
  out[pos + 2] = (val >>> 8) & 0xff;
  out[pos + 3] = val & 0xff;
}

/**
 * Encode timed events ({ timeSec, type: 'noteOn'|'noteOff'|'sustain', midi, velocity, pedalDown, channel })
 * into a Standard MIDI File (Format 0, 480 PPQ @ 120 BPM => 960 ticks/sec, ~1.04ms resolution).
 */
export function encodeMidiFile(events = []) {
  const ticksPerBeat = 480;
  const usPerBeat = 500000; // 120 BPM => 0.5s/beat => 960 ticks/sec
  const ticksPerSec = (ticksPerBeat * 1e6) / usPerBeat;

  const typePriority = { noteOff: 0, sustain: 1, noteOn: 2 };
  const prepared = [];
  events.forEach((ev, seq) => {
    if (!ev || !ev.type) return;
    const tick = Math.max(0, Math.round(Math.max(0, Number(ev.timeSec || 0)) * ticksPerSec));
    const ch = Math.max(0, Math.min(15, Number(ev.channel || 0)));
    if (ev.type === 'noteOn' || ev.type === 'noteOff') {
      const midi = Math.max(0, Math.min(127, Math.round(Number(ev.midi ?? 60))));
      const velByte =
        ev.type === 'noteOn'
          ? Math.max(1, Math.min(127, Math.round(Number(ev.velocity ?? 0.9) * 127)))
          : 0;
      prepared.push({ tick, seq, type: ev.type, ch, d1: midi, d2: velByte });
    } else if (ev.type === 'sustain') {
      prepared.push({
        tick,
        seq,
        type: 'sustain',
        ch,
        d1: 64,
        d2: ev.pedalDown ? 127 : 0
      });
    }
  });

  prepared.sort((a, b) => {
    if (a.tick !== b.tick) return a.tick - b.tick;
    const pa = typePriority[a.type] ?? 1;
    const pb = typePriority[b.type] ?? 1;
    if (pa !== pb) return pa - pb;
    return a.seq - b.seq;
  });

  const track = [];
  // Meta Tempo @ tick 0: FF 51 03 07 A1 20 (500,000 us/beat = 120 BPM)
  track.push(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20);

  let prevTick = 0;
  for (const ev of prepared) {
    const delta = Math.max(0, ev.tick - prevTick);
    prevTick = ev.tick;
    pushVarLen(track, delta);
    if (ev.type === 'noteOn') {
      track.push(0x90 | ev.ch, ev.d1, ev.d2);
    } else if (ev.type === 'noteOff') {
      track.push(0x80 | ev.ch, ev.d1, 0x00);
    } else if (ev.type === 'sustain') {
      track.push(0xb0 | ev.ch, 64, ev.d2);
    }
  }

  // End of Track: delta 0, FF 2F 00
  track.push(0x00, 0xff, 0x2f, 0x00);

  const out = new Uint8Array(14 + 8 + track.length);
  // MThd
  out[0] = 0x4d;
  out[1] = 0x54;
  out[2] = 0x68;
  out[3] = 0x64;
  writeUInt32BE(out, 4, 6);
  writeUInt16BE(out, 8, 0); // Format 0
  writeUInt16BE(out, 10, 1); // 1 track
  writeUInt16BE(out, 12, ticksPerBeat);

  // MTrk
  out[14] = 0x4d;
  out[15] = 0x54;
  out[16] = 0x72;
  out[17] = 0x6b;
  writeUInt32BE(out, 18, track.length);
  out.set(track, 22);

  return out;
}
