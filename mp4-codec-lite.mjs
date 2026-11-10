// ============================================================================
// Pure-JS ISO-BMFF (.mp4) AVC Demuxer + FastStart H.264/AAC/Opus MP4 Muxer
// Zero external dependencies — runs identically in Browser (WebCodecs) & Node.
// ============================================================================

const ASCII_DECODER = new TextDecoder('ascii');

function fourccToStr(u8, off) {
  return String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
}

function writeFourcc(u8, off, str) {
  u8[off] = str.charCodeAt(0) & 0xff;
  u8[off + 1] = str.charCodeAt(1) & 0xff;
  u8[off + 2] = str.charCodeAt(2) & 0xff;
  u8[off + 3] = str.charCodeAt(3) & 0xff;
}

function concatBoxes(...arrays) {
  let total = 0;
  for (const a of arrays) {
    if (a) total += a.byteLength;
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) {
    if (!a || a.byteLength === 0) continue;
    out.set(a instanceof Uint8Array ? a : new Uint8Array(a), pos);
    pos += a.byteLength;
  }
  return out;
}

function makeBox(type, ...payloads) {
  let bodyLen = 0;
  for (const p of payloads) {
    if (p) bodyLen += p.byteLength;
  }
  const out = new Uint8Array(8 + bodyLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 8 + bodyLen, false);
  writeFourcc(out, 4, type);
  let pos = 8;
  for (const p of payloads) {
    if (!p || p.byteLength === 0) continue;
    out.set(p instanceof Uint8Array ? p : new Uint8Array(p), pos);
    pos += p.byteLength;
  }
  return out;
}

function makeFullBox(type, version, flags, ...payloads) {
  const vf = new Uint8Array(4);
  vf[0] = version & 0xff;
  vf[1] = (flags >> 16) & 0xff;
  vf[2] = (flags >> 8) & 0xff;
  vf[3] = flags & 0xff;
  return makeBox(type, vf, ...payloads);
}

function u32Bytes(...vals) {
  const out = new Uint8Array(vals.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < vals.length; i++) {
    dv.setUint32(i * 4, vals[i] >>> 0, false);
  }
  return out;
}

// ============================================================================
// 1. Lightweight ISO-BMFF `avc1` Video Track Demuxer for WebCodecs VideoDecoder
// ============================================================================

function listChildBoxes(u8, start, end) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const boxes = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = dv.getUint32(pos, false);
    const type = fourccToStr(u8, pos + 4);
    let headerLen = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      const hi = dv.getUint32(pos + 8, false);
      const lo = dv.getUint32(pos + 12, false);
      size = hi * 4294967296 + lo;
      headerLen = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerLen || pos + size > end) break;
    boxes.push({
      type,
      boxStart: pos,
      bodyStart: pos + headerLen,
      boxEnd: pos + size
    });
    pos += size;
  }
  return boxes;
}

export function demuxMp4AvcTrack(inputBuffer) {
  const u8 =
    inputBuffer instanceof Uint8Array
      ? inputBuffer
      : new Uint8Array(inputBuffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const topBoxes = listChildBoxes(u8, 0, u8.byteLength);
  const moov = topBoxes.find(b => b.type === 'moov');
  if (!moov) {
    throw new Error('Not a valid MP4 container (missing moov box)');
  }

  const traks = listChildBoxes(u8, moov.bodyStart, moov.boxEnd).filter(b => b.type === 'trak');
  for (const trak of traks) {
    const mdia = listChildBoxes(u8, trak.bodyStart, trak.boxEnd).find(b => b.type === 'mdia');
    if (!mdia) continue;
    const mdiaChildren = listChildBoxes(u8, mdia.bodyStart, mdia.boxEnd);
    const hdlr = mdiaChildren.find(b => b.type === 'hdlr');
    if (!hdlr || hdlr.boxEnd - hdlr.bodyStart < 12) continue;
    const handlerType = fourccToStr(u8, hdlr.bodyStart + 8);
    if (handlerType !== 'vide') continue;

    const mdhd = mdiaChildren.find(b => b.type === 'mdhd');
    let timescale = 30000;
    if (mdhd) {
      const ver = u8[mdhd.bodyStart];
      timescale =
        ver === 1
          ? dv.getUint32(mdhd.bodyStart + 20, false)
          : dv.getUint32(mdhd.bodyStart + 12, false);
    }
    if (!timescale || timescale <= 0) timescale = 30000;

    const minf = mdiaChildren.find(b => b.type === 'minf');
    if (!minf) continue;
    const stbl = listChildBoxes(u8, minf.bodyStart, minf.boxEnd).find(b => b.type === 'stbl');
    if (!stbl) continue;
    const stblChildren = listChildBoxes(u8, stbl.bodyStart, stbl.boxEnd);

    // 1. Parse stsd -> avc1 / avc3 -> width, height, avcC
    const stsd = stblChildren.find(b => b.type === 'stsd');
    if (!stsd || stsd.boxEnd - stsd.bodyStart < 16) continue;
    const sampleEntries = listChildBoxes(u8, stsd.bodyStart + 8, stsd.boxEnd);
    const avcEntry = sampleEntries.find(e => e.type === 'avc1' || e.type === 'avc3');
    if (!avcEntry || avcEntry.boxEnd - avcEntry.bodyStart < 78) continue;

    const width = dv.getUint16(avcEntry.bodyStart + 24, false);
    const height = dv.getUint16(avcEntry.bodyStart + 26, false);
    const entryChildren = listChildBoxes(u8, avcEntry.bodyStart + 78, avcEntry.boxEnd);
    const avcCBox = entryChildren.find(b => b.type === 'avcC');
    if (!avcCBox || avcCBox.boxEnd - avcCBox.bodyStart < 7) continue;

    const avcCBytes = u8.slice(avcCBox.bodyStart, avcCBox.boxEnd);
    const hex2 = n => n.toString(16).padStart(2, '0');
    const codec = `avc1.${hex2(avcCBytes[1])}${hex2(avcCBytes[2])}${hex2(avcCBytes[3])}`;

    // 2. Parse stsz (sample byte sizes)
    const stsz = stblChildren.find(b => b.type === 'stsz');
    if (!stsz) continue;
    const uniformSize = dv.getUint32(stsz.bodyStart + 4, false);
    const sampleCount = dv.getUint32(stsz.bodyStart + 8, false);
    const sampleSizes = new Uint32Array(sampleCount);
    if (uniformSize > 0) {
      sampleSizes.fill(uniformSize);
    } else {
      let p = stsz.bodyStart + 12;
      for (let i = 0; i < sampleCount; i++) {
        sampleSizes[i] = dv.getUint32(p, false);
        p += 4;
      }
    }

    // 3. Parse stco / co64 (chunk byte offsets)
    const stco = stblChildren.find(b => b.type === 'stco');
    const co64 = stblChildren.find(b => b.type === 'co64');
    let chunkOffsets = [];
    if (stco) {
      const cnt = dv.getUint32(stco.bodyStart + 4, false);
      chunkOffsets = new Array(cnt);
      let p = stco.bodyStart + 8;
      for (let i = 0; i < cnt; i++) {
        chunkOffsets[i] = dv.getUint32(p, false);
        p += 4;
      }
    } else if (co64) {
      const cnt = dv.getUint32(co64.bodyStart + 4, false);
      chunkOffsets = new Array(cnt);
      let p = co64.bodyStart + 8;
      for (let i = 0; i < cnt; i++) {
        const hi = dv.getUint32(p, false);
        const lo = dv.getUint32(p + 4, false);
        chunkOffsets[i] = hi * 4294967296 + lo;
        p += 8;
      }
    }
    if (!chunkOffsets.length) continue;

    // 4. Parse stsc (sample-to-chunk table) -> per-sample byte offset
    const stsc = stblChildren.find(b => b.type === 'stsc');
    if (!stsc) continue;
    const stscEntryCount = dv.getUint32(stsc.bodyStart + 4, false);
    const stscEntries = new Array(stscEntryCount);
    {
      let p = stsc.bodyStart + 8;
      for (let i = 0; i < stscEntryCount; i++) {
        stscEntries[i] = {
          firstChunk: dv.getUint32(p, false), // 1-based
          samplesPerChunk: dv.getUint32(p + 4, false)
        };
        p += 12;
      }
    }

    const sampleOffsets = new Float64Array(sampleCount);
    {
      let sIdx = 0;
      let stscIdx = 0;
      for (let cIdx = 0; cIdx < chunkOffsets.length && sIdx < sampleCount; cIdx++) {
        const chunkNum1 = cIdx + 1;
        while (
          stscIdx + 1 < stscEntries.length &&
          chunkNum1 >= stscEntries[stscIdx + 1].firstChunk
        ) {
          stscIdx++;
        }
        const nInChunk = stscEntries[stscIdx]?.samplesPerChunk || 1;
        let byteCursor = chunkOffsets[cIdx];
        for (let k = 0; k < nInChunk && sIdx < sampleCount; k++) {
          sampleOffsets[sIdx] = byteCursor;
          byteCursor += sampleSizes[sIdx];
          sIdx++;
        }
      }
    }

    // 5. Parse stts (decoding time deltas)
    const stts = stblChildren.find(b => b.type === 'stts');
    const sampleDts = new Float64Array(sampleCount);
    const sampleDur = new Uint32Array(sampleCount);
    if (stts) {
      const cnt = dv.getUint32(stts.bodyStart + 4, false);
      let p = stts.bodyStart + 8;
      let sIdx = 0;
      let dtsCursor = 0;
      for (let i = 0; i < cnt && sIdx < sampleCount; i++) {
        const runCnt = dv.getUint32(p, false);
        const delta = dv.getUint32(p + 4, false);
        p += 8;
        for (let k = 0; k < runCnt && sIdx < sampleCount; k++) {
          sampleDts[sIdx] = dtsCursor;
          sampleDur[sIdx] = delta;
          dtsCursor += delta;
          sIdx++;
        }
      }
    }

    // 6. Parse optional ctts (composition / B-frame PTS offsets)
    const ctts = stblChildren.find(b => b.type === 'ctts');
    const sampleCtts = new Int32Array(sampleCount);
    if (ctts) {
      const cttsVer = u8[ctts.bodyStart];
      const cnt = dv.getUint32(ctts.bodyStart + 4, false);
      let p = ctts.bodyStart + 8;
      let sIdx = 0;
      for (let i = 0; i < cnt && sIdx < sampleCount; i++) {
        const runCnt = dv.getUint32(p, false);
        const offset =
          cttsVer === 1 ? dv.getInt32(p + 4, false) : dv.getUint32(p + 4, false);
        p += 8;
        for (let k = 0; k < runCnt && sIdx < sampleCount; k++) {
          sampleCtts[sIdx++] = offset;
        }
      }
    }

    // 7. Parse stss (sync/keyframe indices, 1-based; if absent, all frames are keyframes)
    const stss = stblChildren.find(b => b.type === 'stss');
    const keyframeSet = new Set();
    if (stss) {
      const cnt = dv.getUint32(stss.bodyStart + 4, false);
      let p = stss.bodyStart + 8;
      for (let i = 0; i < cnt; i++) {
        keyframeSet.add(dv.getUint32(p, false) - 1);
        p += 4;
      }
    }

    let minPtsTicks = Infinity;
    for (let i = 0; i < sampleCount; i++) {
      const pts = sampleDts[i] + sampleCtts[i];
      if (pts < minPtsTicks) minPtsTicks = pts;
    }
    if (!Number.isFinite(minPtsTicks)) minPtsTicks = 0;

    const samples = new Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      const ptsTicks = sampleDts[i] + sampleCtts[i] - minPtsTicks;
      samples[i] = {
        idx: i,
        offset: sampleOffsets[i],
        size: sampleSizes[i],
        dtsUs: Math.round((sampleDts[i] * 1_000_000) / timescale),
        ptsUs: Math.round((ptsTicks * 1_000_000) / timescale),
        durationUs: Math.max(1, Math.round((sampleDur[i] * 1_000_000) / timescale)),
        isKeyframe: stss ? keyframeSet.has(i) : true
      };
    }

    return {
      codec,
      width,
      height,
      timescale,
      avcCBytes,
      dataBuffer: u8,
      samples
    };
  }

  throw new Error('No avc1/H.264 video track found in MP4');
}

// ============================================================================
// 2. FastStart ISO-BMFF (.mp4) Muxer (`ftyp` + `moov` + `mdat`)
//    Supports `avc1` (H.264) video + `mp4a` (AAC-LC) or `Opus` audio
// ============================================================================

const AAC_FREQ_INDEX_BY_SR = {
  96000: 0,
  88200: 1,
  64000: 2,
  48000: 3,
  44100: 4,
  32000: 5,
  24000: 6,
  22050: 7,
  16000: 8,
  12000: 9,
  11025: 10,
  8000: 11
};

function makeDefaultAacSpecificConfig(sampleRate = 48000, channels = 2) {
  const freqIdx = AAC_FREQ_INDEX_BY_SR[sampleRate] ?? 3;
  const audioObjectType = 2; // AAC-LC
  const b0 = ((audioObjectType & 0x1f) << 3) | ((freqIdx >> 1) & 0x07);
  const b1 = ((freqIdx & 0x01) << 7) | ((channels & 0x0f) << 3);
  return new Uint8Array([b0, b1]);
}

function writeDescrTag(tag, body) {
  const len = body.byteLength;
  // Standard 4-byte expandable ISO 14496-1 descriptor length encoding
  const hdr = new Uint8Array(5);
  hdr[0] = tag;
  hdr[1] = 0x80 | ((len >> 21) & 0x7f);
  hdr[2] = 0x80 | ((len >> 14) & 0x7f);
  hdr[3] = 0x80 | ((len >> 7) & 0x7f);
  hdr[4] = len & 0x7f;
  return concatBoxes(hdr, body);
}

function makeEsdsBox(ascBytes, avgBitrate = 192000) {
  const asc =
    ascBytes && ascBytes.byteLength >= 2
      ? ascBytes instanceof Uint8Array
        ? ascBytes
        : new Uint8Array(ascBytes)
      : makeDefaultAacSpecificConfig(48000, 2);

  const decSpecInfo = writeDescrTag(0x05, asc);

  const decCfgHdr = new Uint8Array(13);
  const dv = new DataView(decCfgHdr.buffer);
  decCfgHdr[0] = 0x40; // Audio ISO/IEC 14496-3 (AAC)
  decCfgHdr[1] = 0x15; // streamType = 5 (audioStream) << 2 | 1
  decCfgHdr[2] = 0x00;
  decCfgHdr[3] = 0x00;
  decCfgHdr[4] = 0x00;
  dv.setUint32(5, avgBitrate, false);
  dv.setUint32(9, avgBitrate, false);
  const decConfigDescr = writeDescrTag(0x04, concatBoxes(decCfgHdr, decSpecInfo));

  const slConfigDescr = writeDescrTag(0x06, new Uint8Array([0x02]));

  const esHdr = new Uint8Array([0x00, 0x02, 0x00]); // ES_ID = 2, flags = 0
  const esDescr = writeDescrTag(0x03, concatBoxes(esHdr, decConfigDescr, slConfigDescr));

  return makeFullBox('esds', 0, 0, esDescr);
}

function makeDopsBox(sampleRate = 48000, channels = 2) {
  const body = new Uint8Array(11);
  const dv = new DataView(body.buffer);
  body[0] = 0; // Version
  body[1] = channels & 0xff;
  dv.setUint16(2, 312, false); // PreSkip (standard 6.5ms @ 48kHz)
  dv.setUint32(4, sampleRate >>> 0, false);
  dv.setInt16(8, 0, false); // OutputGain
  body[10] = 0; // ChannelMappingFamily
  return makeBox('dOps', body);
}

function compressSttsRuns(deltas) {
  const runs = [];
  for (let i = 0; i < deltas.length; i++) {
    const d = Math.max(1, deltas[i] >>> 0);
    if (runs.length > 0 && runs[runs.length - 1].delta === d) {
      runs[runs.length - 1].count++;
    } else {
      runs.push({ count: 1, delta: d });
    }
  }
  const body = new Uint8Array(4 + runs.length * 8);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, runs.length, false);
  for (let i = 0; i < runs.length; i++) {
    dv.setUint32(4 + i * 8, runs[i].count, false);
    dv.setUint32(8 + i * 8, runs[i].delta, false);
  }
  return makeFullBox('stts', 0, 0, body);
}

function makeStszBox(sizes) {
  const body = new Uint8Array(8 + sizes.length * 4);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, 0, false); // variable sample sizes
  dv.setUint32(4, sizes.length, false);
  for (let i = 0; i < sizes.length; i++) {
    dv.setUint32(8 + i * 4, sizes[i] >>> 0, false);
  }
  return makeFullBox('stsz', 0, 0, body);
}

function makeStscSinglePerChunkBox() {
  // 1 sample per chunk -> clean, explicit per-sample stco offsets
  return makeFullBox('stsc', 0, 0, u32Bytes(1, 1, 1, 1));
}

function makeStcoOrCo64Box(offsets, force64 = false) {
  const need64 = force64 || offsets.some(o => o > 0xffffffff);
  if (need64) {
    const body = new Uint8Array(4 + offsets.length * 8);
    const dv = new DataView(body.buffer);
    dv.setUint32(0, offsets.length, false);
    for (let i = 0; i < offsets.length; i++) {
      const val = offsets[i];
      const hi = Math.floor(val / 4294967296) >>> 0;
      const lo = (val >>> 0);
      dv.setUint32(4 + i * 8, hi, false);
      dv.setUint32(8 + i * 8, lo, false);
    }
    return makeFullBox('co64', 0, 0, body);
  }
  const body = new Uint8Array(4 + offsets.length * 4);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, offsets.length, false);
  for (let i = 0; i < offsets.length; i++) {
    dv.setUint32(4 + i * 4, offsets[i] >>> 0, false);
  }
  return makeFullBox('stco', 0, 0, body);
}

function makeIdentityMatrixBytes() {
  return u32Bytes(
    0x00010000, 0, 0,
    0, 0x00010000, 0,
    0, 0, 0x40000000
  );
}

function makeMvhdBox(durationMs) {
  const body = new Uint8Array(96);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, 0, false); // creation_time (0 for clean metadata)
  dv.setUint32(4, 0, false); // modification_time
  dv.setUint32(8, 1000, false); // timescale = 1000 ms
  dv.setUint32(12, Math.max(1, Math.round(durationMs)), false);
  dv.setUint32(16, 0x00010000, false); // rate = 1.0
  dv.setUint16(20, 0x0100, false); // volume = 1.0
  body.set(makeIdentityMatrixBytes(), 32);
  dv.setUint32(92, 3, false); // next_track_ID
  return makeFullBox('mvhd', 0, 0, body);
}

function makeTkhdBox({ trackId, durationMs, width = 0, height = 0, isAudio = false }) {
  const body = new Uint8Array(80);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, 0, false);
  dv.setUint32(4, 0, false);
  dv.setUint32(8, trackId, false);
  dv.setUint32(16, Math.max(1, Math.round(durationMs)), false);
  dv.setUint16(32, isAudio ? 0x0100 : 0, false); // volume
  body.set(makeIdentityMatrixBytes(), 36);
  dv.setUint32(72, (width & 0xffff) << 16, false);
  dv.setUint32(76, (height & 0xffff) << 16, false);
  // flags = 3 (track_enabled | track_in_movie)
  return makeFullBox('tkhd', 0, 3, body);
}

function makeMdhdBox(timescale, durationTicks) {
  const body = new Uint8Array(20);
  const dv = new DataView(body.buffer);
  dv.setUint32(8, timescale >>> 0, false);
  dv.setUint32(12, Math.max(1, Math.round(durationTicks)) >>> 0, false);
  dv.setUint16(16, 0x55c4, false); // 'und' language
  return makeFullBox('mdhd', 0, 0, body);
}

function makeHdlrBox(handlerType, name) {
  const nameBytes = new Uint8Array(name.length + 1);
  for (let i = 0; i < name.length; i++) nameBytes[i] = name.charCodeAt(i) & 0x7f;
  const hdr = new Uint8Array(20);
  writeFourcc(hdr, 4, handlerType);
  return makeFullBox('hdlr', 0, 0, hdr, nameBytes);
}

function makeDinfBox() {
  const urlBox = makeFullBox('url ', 0, 1); // self-contained media flag = 1
  const drefBox = makeFullBox('dref', 0, 0, u32Bytes(1), urlBox);
  return makeBox('dinf', drefBox);
}

function makeAvc1SampleEntry({ width, height, avcCBytes }) {
  const body = new Uint8Array(78);
  const dv = new DataView(body.buffer);
  dv.setUint16(6, 1, false); // data_reference_index = 1
  dv.setUint16(24, width & 0xffff, false);
  dv.setUint16(26, height & 0xffff, false);
  dv.setUint32(28, 0x00480000, false); // horizresolution = 72 dpi
  dv.setUint32(32, 0x00480000, false); // vertresolution = 72 dpi
  dv.setUint16(40, 1, false); // frame_count = 1
  dv.setUint16(74, 0x0018, false); // depth = 24
  dv.setInt16(76, -1, false); // pre_defined = -1

  const avcC = makeBox('avcC', avcCBytes);
  // BT.709 color signaling (`colr` nclx: primaries=1, transfer=1, matrix=1, tv range=0)
  const colrPayload = new Uint8Array(11);
  writeFourcc(colrPayload, 0, 'nclx');
  const cdv = new DataView(colrPayload.buffer);
  cdv.setUint16(4, 1, false);
  cdv.setUint16(6, 1, false);
  cdv.setUint16(8, 1, false);
  colrPayload[10] = 0x00;
  const colr = makeBox('colr', colrPayload);

  return makeBox('avc1', body, avcC, colr);
}

function makeAudioSampleEntry({ codec, sampleRate, channels, decoderConfig }) {
  const body = new Uint8Array(28);
  const dv = new DataView(body.buffer);
  dv.setUint16(6, 1, false); // data_reference_index = 1
  dv.setUint16(16, channels & 0xffff, false);
  dv.setUint16(18, 16, false); // sampleSize = 16
  dv.setUint32(24, (Math.min(65535, sampleRate) & 0xffff) << 16, false);

  if (codec === 'opus') {
    return makeBox('Opus', body, makeDopsBox(sampleRate, channels));
  }
  return makeBox('mp4a', body, makeEsdsBox(decoderConfig, 192000));
}

// Convert Annex-B (`00 00 00 01` / `00 00 01`) bitstream to 4-byte length-prefixed AVC if needed
function ensureAvcLengthPrefixed(u8) {
  if (u8.byteLength < 5) return { data: u8, sps: null, pps: null };
  // Quick check: if it starts with `00 00 00 01` or `00 00 01`, check whether valid length-prefixed walk matches exact end
  let walkPos = 0;
  let validLenPrefixed = true;
  while (walkPos + 4 <= u8.byteLength) {
    const naluLen =
      ((u8[walkPos] << 24) >>> 0) +
      (u8[walkPos + 1] << 16) +
      (u8[walkPos + 2] << 8) +
      u8[walkPos + 3];
    if (naluLen <= 0 || walkPos + 4 + naluLen > u8.byteLength) {
      validLenPrefixed = false;
      break;
    }
    walkPos += 4 + naluLen;
  }
  if (validLenPrefixed && walkPos === u8.byteLength) {
    return { data: u8, sps: null, pps: null };
  }

  // Parse Annex-B start codes
  const nalus = [];
  let sps = null;
  let pps = null;
  let i = 0;
  const N = u8.byteLength;
  const starts = [];
  while (i + 3 < N) {
    if (u8[i] === 0 && u8[i + 1] === 0) {
      if (u8[i + 2] === 1) {
        starts.push({ scStart: i, dataStart: i + 3 });
        i += 3;
        continue;
      }
      if (i + 4 < N && u8[i + 2] === 0 && u8[i + 3] === 1) {
        starts.push({ scStart: i, dataStart: i + 4 });
        i += 4;
        continue;
      }
    }
    i++;
  }
  if (!starts.length) return { data: u8, sps: null, pps: null };

  let outBytes = 0;
  for (let k = 0; k < starts.length; k++) {
    const d0 = starts[k].dataStart;
    const d1 = k + 1 < starts.length ? starts[k + 1].scStart : N;
    if (d1 <= d0) continue;
    const nalu = u8.subarray(d0, d1);
    const naluType = nalu[0] & 0x1f;
    if (naluType === 7 && !sps) sps = nalu;
    if (naluType === 8 && !pps) pps = nalu;
    nalus.push(nalu);
    outBytes += 4 + nalu.byteLength;
  }

  const out = new Uint8Array(outBytes);
  const dv = new DataView(out.buffer);
  let wp = 0;
  for (const nalu of nalus) {
    dv.setUint32(wp, nalu.byteLength, false);
    out.set(nalu, wp + 4);
    wp += 4 + nalu.byteLength;
  }
  return { data: out, sps, pps };
}

function buildAvcCFromSpsPps(sps, pps) {
  if (!sps || !pps || sps.byteLength < 4) return null;
  const out = new Uint8Array(11 + sps.byteLength + pps.byteLength);
  const dv = new DataView(out.buffer);
  out[0] = 1; // configurationVersion
  out[1] = sps[1]; // AVCProfileIndication
  out[2] = sps[2]; // profile_compatibility
  out[3] = sps[3]; // AVCLevelIndication
  out[4] = 0xff; // 4-byte NALU lengths
  out[5] = 0xe1; // 1 SPS
  dv.setUint16(6, sps.byteLength, false);
  out.set(sps, 8);
  let p = 8 + sps.byteLength;
  out[p] = 1; // 1 PPS
  dv.setUint16(p + 1, pps.byteLength, false);
  out.set(pps, p + 3);
  return out;
}

export function createMp4Muxer({
  width,
  height,
  fps = 30,
  sampleRate = 48000,
  channels = 2,
  audioCodec = 'mp4a' // 'mp4a' | 'opus' | null
}) {
  const VIDEO_TIMESCALE = 90000;
  const AUDIO_TIMESCALE = sampleRate;

  const videoChunks = [];
  const audioChunks = [];
  let avcCBytes = null;
  let audioConfigBytes = null;

  return {
    addVideoChunk(rawBytes, timestampUs, durationUs, isKeyframe = false, decoderConfig = null) {
      if (decoderConfig?.description && !avcCBytes) {
        const desc = decoderConfig.description;
        avcCBytes =
          desc instanceof Uint8Array
            ? desc.slice()
            : new Uint8Array(desc instanceof ArrayBuffer ? desc : desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength));
      }
      const u8 = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
      const converted = ensureAvcLengthPrefixed(u8);
      if (!avcCBytes && converted.sps && converted.pps) {
        avcCBytes = buildAvcCFromSpsPps(converted.sps, converted.pps);
      }
      videoChunks.push({
        data: converted.data,
        timestampUs: Math.max(0, Number(timestampUs) || 0),
        durationUs: Math.max(1, Number(durationUs) || Math.round(1_000_000 / fps)),
        isKeyframe: Boolean(isKeyframe)
      });
    },

    addAudioChunk(rawBytes, timestampUs, durationUs, decoderConfig = null) {
      if (decoderConfig?.description && !audioConfigBytes) {
        const desc = decoderConfig.description;
        audioConfigBytes =
          desc instanceof Uint8Array
            ? desc.slice()
            : new Uint8Array(desc instanceof ArrayBuffer ? desc : desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength));
      }
      let u8 = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
      // Safeguard: if a browser's AudioEncoder ever emits an ADTS-wrapped AAC frame, strip the 7/9-byte ADTS header
      if (audioCodec === 'mp4a' && u8.byteLength > 9 && u8[0] === 0xff && (u8[1] & 0xf6) === 0xf0) {
        const adtsLen = ((u8[3] & 0x03) << 11) | (u8[4] << 3) | ((u8[5] >> 5) & 0x07);
        const hdrLen = u8[1] & 0x01 ? 7 : 9;
        if (adtsLen === u8.byteLength && u8.byteLength > hdrLen) {
          u8 = u8.subarray(hdrLen);
        }
      }
      audioChunks.push({
        data: u8,
        timestampUs: Math.max(0, Number(timestampUs) || 0),
        durationUs: Math.max(1, Number(durationUs) || Math.round((1024 * 1_000_000) / sampleRate))
      });
    },

    finalize() {
      if (!videoChunks.length) {
        throw new Error('Cannot finalize MP4 without video frames');
      }
      if (!avcCBytes) {
        throw new Error('Missing H.264 avcC decoder configuration');
      }

      videoChunks.sort((a, b) => a.timestampUs - b.timestampUs);
      audioChunks.sort((a, b) => a.timestampUs - b.timestampUs);

      // Compute video sample deltas in 90kHz ticks
      const vCount = videoChunks.length;
      const vDeltas = new Uint32Array(vCount);
      const vSizes = new Uint32Array(vCount);
      const keyframeIndices1 = [];
      let vTotalTicks = 0;
      for (let i = 0; i < vCount; i++) {
        const curTicks = Math.round((videoChunks[i].timestampUs * VIDEO_TIMESCALE) / 1_000_000);
        const nextTicks =
          i + 1 < vCount
            ? Math.round((videoChunks[i + 1].timestampUs * VIDEO_TIMESCALE) / 1_000_000)
            : curTicks + Math.max(1, Math.round((videoChunks[i].durationUs * VIDEO_TIMESCALE) / 1_000_000));
        const d = Math.max(1, nextTicks - curTicks);
        vDeltas[i] = d;
        vTotalTicks += d;
        vSizes[i] = videoChunks[i].data.byteLength;
        if (videoChunks[i].isKeyframe) keyframeIndices1.push(i + 1);
      }
      if (keyframeIndices1.length === 0) keyframeIndices1.push(1);

      const hasAudio = audioChunks.length > 0 && Boolean(audioCodec);
      const aCount = hasAudio ? audioChunks.length : 0;
      const aDeltas = new Uint32Array(aCount);
      const aSizes = new Uint32Array(aCount);
      let aTotalTicks = 0;
      for (let i = 0; i < aCount; i++) {
        const curTicks = Math.round((audioChunks[i].timestampUs * AUDIO_TIMESCALE) / 1_000_000);
        const nextTicks =
          i + 1 < aCount
            ? Math.round((audioChunks[i + 1].timestampUs * AUDIO_TIMESCALE) / 1_000_000)
            : curTicks + Math.max(1, Math.round((audioChunks[i].durationUs * AUDIO_TIMESCALE) / 1_000_000));
        const d = Math.max(1, nextTicks - curTicks);
        aDeltas[i] = d;
        aTotalTicks += d;
        aSizes[i] = audioChunks[i].data.byteLength;
      }

      const vDurationMs = (vTotalTicks / VIDEO_TIMESCALE) * 1000;
      const aDurationMs = hasAudio ? (aTotalTicks / AUDIO_TIMESCALE) * 1000 : 0;
      const movieDurationMs = Math.max(vDurationMs, aDurationMs);

      let mdatPayloadBytes = 0;
      for (let i = 0; i < vCount; i++) mdatPayloadBytes += vSizes[i];
      for (let i = 0; i < aCount; i++) mdatPayloadBytes += aSizes[i];

      const ftypBox = makeBox(
        'ftyp',
        concatBoxes(
          new Uint8Array([105, 115, 111, 109]), // 'isom'
          u32Bytes(0x200),
          new Uint8Array([
            105, 115, 111, 109, // 'isom'
            105, 115, 111, 50,  // 'iso2'
            97, 118, 99, 49,    // 'avc1'
            109, 112, 52, 49    // 'mp41'
          ])
        )
      );

      const buildMoovWithBaseOffset = (mdatDataStartOffset, force64) => {
        let cursor = mdatDataStartOffset;
        const vOffsets = new Array(vCount);
        for (let i = 0; i < vCount; i++) {
          vOffsets[i] = cursor;
          cursor += vSizes[i];
        }
        const aOffsets = new Array(aCount);
        for (let i = 0; i < aCount; i++) {
          aOffsets[i] = cursor;
          cursor += aSizes[i];
        }

        // Video Track
        const vStsd = makeFullBox(
          'stsd',
          0,
          0,
          u32Bytes(1),
          makeAvc1SampleEntry({ width, height, avcCBytes })
        );
        const vStts = compressSttsRuns(vDeltas);
        const vStssBody = new Uint8Array(4 + keyframeIndices1.length * 4);
        {
          const dv = new DataView(vStssBody.buffer);
          dv.setUint32(0, keyframeIndices1.length, false);
          for (let i = 0; i < keyframeIndices1.length; i++) {
            dv.setUint32(4 + i * 4, keyframeIndices1[i], false);
          }
        }
        const vStss = makeFullBox('stss', 0, 0, vStssBody);
        const vStsc = makeStscSinglePerChunkBox();
        const vStsz = makeStszBox(vSizes);
        const vStco = makeStcoOrCo64Box(vOffsets, force64);
        const vStbl = makeBox('stbl', vStsd, vStts, vStss, vStsc, vStsz, vStco);
        const vmhd = makeFullBox('vmhd', 0, 1, new Uint8Array(8));
        const vMinf = makeBox('minf', vmhd, makeDinfBox(), vStbl);
        const vMdia = makeBox(
          'mdia',
          makeMdhdBox(VIDEO_TIMESCALE, vTotalTicks),
          makeHdlrBox('vide', 'VideoHandler'),
          vMinf
        );
        const vTrak = makeBox(
          'trak',
          makeTkhdBox({ trackId: 1, durationMs: vDurationMs, width, height, isAudio: false }),
          vMdia
        );

        let aTrak = null;
        if (hasAudio) {
          const aStsd = makeFullBox(
            'stsd',
            0,
            0,
            u32Bytes(1),
            makeAudioSampleEntry({
              codec: audioCodec,
              sampleRate,
              channels,
              decoderConfig: audioConfigBytes
            })
          );
          const aStts = compressSttsRuns(aDeltas);
          const aStsc = makeStscSinglePerChunkBox();
          const aStsz = makeStszBox(aSizes);
          const aStco = makeStcoOrCo64Box(aOffsets, force64);
          const aStbl = makeBox('stbl', aStsd, aStts, aStsc, aStsz, aStco);
          const smhd = makeFullBox('smhd', 0, 0, new Uint8Array(4));
          const aMinf = makeBox('minf', smhd, makeDinfBox(), aStbl);
          const aMdia = makeBox(
            'mdia',
            makeMdhdBox(AUDIO_TIMESCALE, aTotalTicks),
            makeHdlrBox('soun', 'SoundHandler'),
            aMinf
          );
          aTrak = makeBox(
            'trak',
            makeTkhdBox({ trackId: 2, durationMs: aDurationMs, isAudio: true }),
            aMdia
          );
        }

        return makeBox('moov', makeMvhdBox(movieDurationMs), vTrak, aTrak);
      };

      const need64Bit = mdatPayloadBytes > 0xefffffff;
      const mdatHeaderLen = mdatPayloadBytes + 8 > 0xffffffff ? 16 : 8;

      // Two-pass exact offset calculation (`ftyp` -> `moov` -> `mdat` header -> `mdat` payload)
      const dummyMoov = buildMoovWithBaseOffset(0, need64Bit);
      const exactMdatPayloadStart = ftypBox.byteLength + dummyMoov.byteLength + mdatHeaderLen;
      const finalMoov = buildMoovWithBaseOffset(exactMdatPayloadStart, need64Bit);

      const totalFileBytes = exactMdatPayloadStart + mdatPayloadBytes;
      const out = new Uint8Array(totalFileBytes);
      out.set(ftypBox, 0);
      out.set(finalMoov, ftypBox.byteLength);

      const mdatStart = ftypBox.byteLength + finalMoov.byteLength;
      const mdv = new DataView(out.buffer, mdatStart, mdatHeaderLen);
      if (mdatHeaderLen === 16) {
        mdv.setUint32(0, 1, false);
        writeFourcc(out, mdatStart + 4, 'mdat');
        const fullMdatSize = mdatPayloadBytes + 16;
        mdv.setUint32(8, Math.floor(fullMdatSize / 4294967296) >>> 0, false);
        mdv.setUint32(12, fullMdatSize >>> 0, false);
      } else {
        mdv.setUint32(0, (mdatPayloadBytes + 8) >>> 0, false);
        writeFourcc(out, mdatStart + 4, 'mdat');
      }

      let writePos = exactMdatPayloadStart;
      for (let i = 0; i < vCount; i++) {
        out.set(videoChunks[i].data, writePos);
        writePos += vSizes[i];
      }
      for (let i = 0; i < aCount; i++) {
        out.set(audioChunks[i].data, writePos);
        writePos += aSizes[i];
      }

      return out;
    }
  };
}
