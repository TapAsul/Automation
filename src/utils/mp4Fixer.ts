interface Mp4Box {
  type: string;
  start: number;
  size: number;
  hdr: number;
  dataStart: number;
  end: number;
}

interface ExtractedSample {
  data: Uint8Array;
  duration: number;
  cto: number;
  isSync: boolean;
}

interface TrackFragmentRun {
  tfdt: bigint | null;
  samples: ExtractedSample[];
}

interface ParsedTrack {
  trackId: number;
  handlerType: string;
  mediaTimescale: number;
  nalLengthSize: number;
  tkhdRaw: Uint8Array;
  mdhdRaw: Uint8Array;
  hdlrRaw: Uint8Array;
  keptMinfBoxes: Uint8Array[];
  stsdRaw: Uint8Array;
  fragments: TrackFragmentRun[];
  samples: ExtractedSample[];
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length && offset + i < bytes.byteLength; i++) {
    out += String.fromCharCode(bytes[offset + i]);
  }
  return out;
}

function encodeAscii(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function u32be(val: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, val >>> 0);
  return out;
}

function readU64Number(dv: DataView, offset: number): number {
  return dv.getUint32(offset) * 4294967296 + dv.getUint32(offset + 4);
}

function writeU64Number(dv: DataView, offset: number, val: number): void {
  const safe = Math.max(0, Math.round(val));
  dv.setUint32(offset, Math.floor(safe / 4294967296) >>> 0);
  dv.setUint32(offset + 4, safe >>> 0);
}

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function makeBox(type: string, ...payloads: Uint8Array[]): Uint8Array {
  let bodyLen = 0;
  for (const p of payloads) bodyLen += p.byteLength;
  const out = new Uint8Array(8 + bodyLen);
  new DataView(out.buffer).setUint32(0, (8 + bodyLen) >>> 0);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i) & 0xff;
  let offset = 8;
  for (const p of payloads) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function makeFullBox(
  type: string,
  version: number,
  flags: number,
  ...payloads: Uint8Array[]
): Uint8Array {
  const vf = new Uint8Array([
    version & 0xff,
    (flags >>> 16) & 0xff,
    (flags >>> 8) & 0xff,
    flags & 0xff,
  ]);
  return makeBox(type, vf, ...payloads);
}

function parseBoxes(bytes: Uint8Array, start: number, end: number): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  const safeEnd = Math.min(end, bytes.byteLength);
  let pos = Math.max(0, start);

  while (pos + 8 <= safeEnd) {
    const dv = new DataView(
      bytes.buffer,
      bytes.byteOffset + pos,
      safeEnd - pos
    );
    let size = dv.getUint32(0);
    const type = readAscii(bytes, pos + 4, 4);
    let hdr = 8;

    if (size === 1) {
      if (pos + 16 > safeEnd) break;
      size = readU64Number(dv, 8);
      hdr = 16;
    } else if (size === 0) {
      size = safeEnd - pos;
    }

    if (size < hdr || pos + size > safeEnd) break;
    boxes.push({
      type,
      start: pos,
      size,
      hdr,
      dataStart: pos + hdr,
      end: pos + size,
    });
    pos += size;
  }
  return boxes;
}

function detectAvcNalLengthSize(bytes: Uint8Array, stsd: Mp4Box): number {
  if (stsd.end - stsd.dataStart < 16) return 0;
  const entries = parseBoxes(bytes, stsd.dataStart + 8, stsd.end);
  const avcEntry = entries.find((b) => b.type === "avc1" || b.type === "avc3");
  if (!avcEntry || avcEntry.end - avcEntry.dataStart < 86) return 0;
  const subBoxes = parseBoxes(bytes, avcEntry.dataStart + 78, avcEntry.end);
  const avcC = subBoxes.find((b) => b.type === "avcC");
  if (!avcC || avcC.end - avcC.dataStart < 5) return 0;
  return (bytes[avcC.dataStart + 4] & 0x03) + 1;
}

function containsAvcIdrSlice(sample: Uint8Array, nalLenSize: number): boolean {
  let pos = 0;
  while (pos + nalLenSize < sample.byteLength) {
    let nalLen = 0;
    for (let i = 0; i < nalLenSize; i++) {
      nalLen = nalLen * 256 + sample[pos + i];
    }
    pos += nalLenSize;
    if (nalLen <= 0 || pos + nalLen > sample.byteLength) return false;
    const nalType = sample[pos] & 0x1f;
    if (nalType === 5) return true;
    pos += nalLen;
  }
  return false;
}

function patchMvhdBox(
  rawBox: Uint8Array,
  movieTimescale: number,
  durationTicks: number
): Uint8Array {
  const copy = rawBox.slice();
  const dv = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  const hdr = dv.getUint32(0) === 1 ? 16 : 8;
  const ver = copy[hdr];
  const safeTicks = Math.max(1, Math.round(durationTicks));
  if (ver === 1 && copy.byteLength >= hdr + 32) {
    dv.setUint32(hdr + 20, movieTimescale >>> 0);
    writeU64Number(dv, hdr + 24, safeTicks);
  } else if (copy.byteLength >= hdr + 20) {
    dv.setUint32(hdr + 12, movieTimescale >>> 0);
    dv.setUint32(hdr + 16, Math.min(0x7fffffff, safeTicks) >>> 0);
  }
  return copy;
}

function patchTkhdBox(rawBox: Uint8Array, durationInMovieTs: number): Uint8Array {
  const copy = rawBox.slice();
  const dv = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  const hdr = dv.getUint32(0) === 1 ? 16 : 8;
  const ver = copy[hdr];
  copy[hdr + 3] = copy[hdr + 3] | 0x03;
  const safeTicks = Math.max(1, Math.round(durationInMovieTs));
  if (ver === 1 && copy.byteLength >= hdr + 36) {
    writeU64Number(dv, hdr + 28, safeTicks);
  } else if (copy.byteLength >= hdr + 24) {
    dv.setUint32(hdr + 20, Math.min(0x7fffffff, safeTicks) >>> 0);
  }
  return copy;
}

function patchMdhdBox(
  rawBox: Uint8Array,
  mediaTimescale: number,
  mediaDurationTicks: number
): Uint8Array {
  const copy = rawBox.slice();
  const dv = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  const hdr = dv.getUint32(0) === 1 ? 16 : 8;
  const ver = copy[hdr];
  const safeTicks = Math.max(1, Math.round(mediaDurationTicks));
  if (ver === 1 && copy.byteLength >= hdr + 32) {
    dv.setUint32(hdr + 20, mediaTimescale >>> 0);
    writeU64Number(dv, hdr + 24, safeTicks);
  } else if (copy.byteLength >= hdr + 20) {
    dv.setUint32(hdr + 12, mediaTimescale >>> 0);
    dv.setUint32(hdr + 16, Math.min(0x7fffffff, safeTicks) >>> 0);
  }
  return copy;
}

function defragmentToFastStartMp4(
  input: Uint8Array,
  topBoxes: Mp4Box[],
  moovBox: Mp4Box,
  expectedDurationSec: number,
  fps: number
): Uint8Array<ArrayBuffer> | null {
  const moovChildren = parseBoxes(input, moovBox.dataStart, moovBox.end);
  const mvhdBox = moovChildren.find((b) => b.type === "mvhd");
  if (!mvhdBox || mvhdBox.end - mvhdBox.dataStart < 20) return null;

  const mvhdDv = new DataView(
    input.buffer,
    input.byteOffset + mvhdBox.dataStart,
    mvhdBox.end - mvhdBox.dataStart
  );
  const mvhdVer = input[mvhdBox.dataStart];
  const movieTimescale =
    (mvhdVer === 1 && mvhdDv.byteLength >= 24
      ? mvhdDv.getUint32(20)
      : mvhdDv.getUint32(12)) || 1000;

  const trexDefaults = new Map<
    number,
    { duration: number; size: number; flags: number }
  >();
  const mvexBox = moovChildren.find((b) => b.type === "mvex");
  if (mvexBox) {
    for (const child of parseBoxes(input, mvexBox.dataStart, mvexBox.end)) {
      if (child.type === "trex" && child.end - child.dataStart >= 24) {
        const dv = new DataView(
          input.buffer,
          input.byteOffset + child.dataStart,
          child.end - child.dataStart
        );
        trexDefaults.set(dv.getUint32(4), {
          duration: dv.getUint32(12),
          size: dv.getUint32(16),
          flags: dv.getUint32(20),
        });
      }
    }
  }

  const tracks = new Map<number, ParsedTrack>();
  const trackOrder: ParsedTrack[] = [];

  for (const trakBox of moovChildren.filter((b) => b.type === "trak")) {
    const tKids = parseBoxes(input, trakBox.dataStart, trakBox.end);
    const tkhd = tKids.find((b) => b.type === "tkhd");
    const mdia = tKids.find((b) => b.type === "mdia");
    if (!tkhd || !mdia || tkhd.end - tkhd.dataStart < 24) continue;

    const tkDv = new DataView(
      input.buffer,
      input.byteOffset + tkhd.dataStart,
      tkhd.end - tkhd.dataStart
    );
    const tkVer = input[tkhd.dataStart];
    const trackId =
      tkVer === 1 && tkDv.byteLength >= 24
        ? tkDv.getUint32(20)
        : tkDv.getUint32(12);

    const mKids = parseBoxes(input, mdia.dataStart, mdia.end);
    const mdhd = mKids.find((b) => b.type === "mdhd");
    const hdlr = mKids.find((b) => b.type === "hdlr");
    const minf = mKids.find((b) => b.type === "minf");
    if (
      !mdhd ||
      !hdlr ||
      !minf ||
      mdhd.end - mdhd.dataStart < 20 ||
      hdlr.end - hdlr.dataStart < 12
    ) {
      continue;
    }

    const mdDv = new DataView(
      input.buffer,
      input.byteOffset + mdhd.dataStart,
      mdhd.end - mdhd.dataStart
    );
    const mdVer = input[mdhd.dataStart];
    const handlerType = readAscii(input, hdlr.dataStart + 8, 4);
    const mediaTimescale =
      (mdVer === 1 && mdDv.byteLength >= 24
        ? mdDv.getUint32(20)
        : mdDv.getUint32(12)) || (handlerType === "soun" ? 48000 : 90000);

    const minfKids = parseBoxes(input, minf.dataStart, minf.end);
    const stbl = minfKids.find((b) => b.type === "stbl");
    if (!stbl) continue;
    const stsd = parseBoxes(input, stbl.dataStart, stbl.end).find(
      (b) => b.type === "stsd"
    );
    if (!stsd) continue;

    const nalLengthSize =
      handlerType === "vide" ? detectAvcNalLengthSize(input, stsd) : 0;

    const trk: ParsedTrack = {
      trackId,
      handlerType,
      mediaTimescale,
      nalLengthSize,
      tkhdRaw: input.subarray(tkhd.start, tkhd.end),
      mdhdRaw: input.subarray(mdhd.start, mdhd.end),
      hdlrRaw: input.subarray(hdlr.start, hdlr.end),
      keptMinfBoxes: minfKids
        .filter((b) => b.type !== "stbl")
        .map((b) => input.subarray(b.start, b.end)),
      stsdRaw: input.subarray(stsd.start, stsd.end),
      fragments: [],
      samples: [],
    };
    tracks.set(trackId, trk);
    trackOrder.push(trk);
  }

  if (trackOrder.length === 0) return null;

  for (let bi = 0; bi < topBoxes.length; bi++) {
    const moof = topBoxes[bi];
    if (moof.type !== "moof") continue;

    let nextMdat: Mp4Box | null = null;
    for (let j = bi + 1; j < topBoxes.length; j++) {
      if (topBoxes[j].type === "mdat") {
        nextMdat = topBoxes[j];
        break;
      }
      if (topBoxes[j].type === "moof") break;
    }
    const fallbackDataStart = nextMdat ? nextMdat.dataStart : moof.end + 8;

    const moofKids = parseBoxes(input, moof.dataStart, moof.end);
    let prevTrafEnd = fallbackDataStart;
    let trafIdx = 0;

    for (const traf of moofKids.filter((k) => k.type === "traf")) {
      const trafKids = parseBoxes(input, traf.dataStart, traf.end);
      const tfhd = trafKids.find((k) => k.type === "tfhd");
      if (!tfhd || tfhd.end - tfhd.dataStart < 8) {
        trafIdx++;
        continue;
      }

      const tfDv = new DataView(
        input.buffer,
        input.byteOffset + tfhd.dataStart,
        tfhd.end - tfhd.dataStart
      );
      const tfFlags = tfDv.getUint32(0) & 0xffffff;
      const trackId = tfDv.getUint32(4);
      const trk = tracks.get(trackId);
      if (!trk) {
        trafIdx++;
        continue;
      }

      const trex = trexDefaults.get(trackId) ?? {
        duration: 0,
        size: 0,
        flags: 0,
      };

      let tp = 8;
      let explicitBase: number | null = null;
      if ((tfFlags & 0x000001) && tp + 8 <= tfDv.byteLength) {
        explicitBase = readU64Number(tfDv, tp);
        tp += 8;
      }
      if ((tfFlags & 0x000002) && tp + 4 <= tfDv.byteLength) {
        tp += 4;
      }
      let defDur = trex.duration;
      if ((tfFlags & 0x000008) && tp + 4 <= tfDv.byteLength) {
        defDur = tfDv.getUint32(tp);
        tp += 4;
      }
      let defSize = trex.size;
      if ((tfFlags & 0x000010) && tp + 4 <= tfDv.byteLength) {
        defSize = tfDv.getUint32(tp);
        tp += 4;
      }
      let defFlags = trex.flags;
      if ((tfFlags & 0x000020) && tp + 4 <= tfDv.byteLength) {
        defFlags = tfDv.getUint32(tp);
        tp += 4;
      }
      const defaultBaseIsMoof = (tfFlags & 0x020000) !== 0;

      const baseOffset =
        explicitBase !== null
          ? explicitBase
          : defaultBaseIsMoof || trafIdx === 0
            ? moof.start
            : prevTrafEnd;

      let tfdtVal: bigint | null = null;
      const tfdt = trafKids.find((k) => k.type === "tfdt");
      if (tfdt && tfdt.end - tfdt.dataStart >= 8) {
        const dtDv = new DataView(
          input.buffer,
          input.byteOffset + tfdt.dataStart,
          tfdt.end - tfdt.dataStart
        );
        const dtVer = input[tfdt.dataStart];
        tfdtVal =
          dtVer === 1 && dtDv.byteLength >= 12
            ? dtDv.getBigUint64(4)
            : BigInt(dtDv.getUint32(4));
      }

      const fragSamples: ExtractedSample[] = [];
      let dataCursor = explicitBase !== null ? explicitBase : fallbackDataStart;

      for (const trun of trafKids.filter((k) => k.type === "trun")) {
        if (trun.end - trun.dataStart < 8) continue;
        const trDv = new DataView(
          input.buffer,
          input.byteOffset + trun.dataStart,
          trun.end - trun.dataStart
        );
        const trVer = input[trun.dataStart];
        const trFlags = trDv.getUint32(0) & 0xffffff;
        const sampleCount = trDv.getUint32(4);
        let rp = 8;

        if ((trFlags & 0x000001) && rp + 4 <= trDv.byteLength) {
          const relOffset = trDv.getInt32(rp);
          rp += 4;
          let candidate = baseOffset + relOffset;
          if (
            explicitBase === null &&
            !defaultBaseIsMoof &&
            trafIdx > 0 &&
            nextMdat
          ) {
            const moofRel = moof.start + relOffset;
            if (
              moofRel === prevTrafEnd ||
              ((candidate < nextMdat.dataStart || candidate >= nextMdat.end) &&
                moofRel >= nextMdat.dataStart &&
                moofRel < nextMdat.end)
            ) {
              candidate = moofRel;
            }
          }
          dataCursor = candidate;
        }

        let firstSampleFlags: number | null = null;
        if ((trFlags & 0x000004) && rp + 4 <= trDv.byteLength) {
          firstSampleFlags = trDv.getUint32(rp);
          rp += 4;
        }

        for (let i = 0; i < sampleCount; i++) {
          let dur = defDur;
          if (trFlags & 0x000100) {
            if (rp + 4 > trDv.byteLength) break;
            dur = trDv.getUint32(rp);
            rp += 4;
          }
          let sz = defSize;
          if (trFlags & 0x000200) {
            if (rp + 4 > trDv.byteLength) break;
            sz = trDv.getUint32(rp);
            rp += 4;
          }
          let sFlags =
            i === 0 && firstSampleFlags !== null ? firstSampleFlags : defFlags;
          if (trFlags & 0x000400) {
            if (rp + 4 > trDv.byteLength) break;
            const readF = trDv.getUint32(rp);
            rp += 4;
            if (!(i === 0 && firstSampleFlags !== null)) sFlags = readF;
          }
          let cto = 0;
          if (trFlags & 0x000800) {
            if (rp + 4 > trDv.byteLength) break;
            const rawCto =
              trVer === 0 ? trDv.getUint32(rp) : trDv.getInt32(rp);
            cto = rawCto > 0x7fffffff ? rawCto | 0 : rawCto;
            rp += 4;
          }

          if (sz > 0 && dataCursor >= 0 && dataCursor + sz <= input.byteLength) {
            const dependsOn = (sFlags >>> 24) & 0x03;
            const isNonSync = (sFlags & 0x00010000) !== 0;
            const isSync =
              dependsOn === 2 ? true : dependsOn === 1 ? false : !isNonSync;
            fragSamples.push({
              data: input.subarray(dataCursor, dataCursor + sz),
              duration: dur,
              cto,
              isSync,
            });
            dataCursor += sz;
          }
        }
      }

      prevTrafEnd = dataCursor;
      if (fragSamples.length > 0) {
        trk.fragments.push({ tfdt: tfdtVal, samples: fragSamples });
      }
      trafIdx++;
    }
  }

  for (const trk of trackOrder) {
    const maxSampleTicks = trk.mediaTimescale * 3;
    const isValidDur = (d: number) =>
      Number.isFinite(d) && d > 0 && d < 0x7fffffff && d <= maxSampleTicks;

    for (let fi = 0; fi < trk.fragments.length; fi++) {
      const cur = trk.fragments[fi];
      const nxt = trk.fragments[fi + 1];
      if (
        nxt &&
        cur.tfdt !== null &&
        nxt.tfdt !== null &&
        nxt.tfdt > cur.tfdt
      ) {
        const diffBig = nxt.tfdt - cur.tfdt;
        if (diffBig <= BigInt(maxSampleTicks * (cur.samples.length + 2))) {
          const fragDelta = Number(diffBig);
          let validSum = 0;
          const bogusIndices: number[] = [];
          cur.samples.forEach((s, idx) => {
            if (isValidDur(s.duration)) validSum += s.duration;
            else bogusIndices.push(idx);
          });
          if (bogusIndices.length > 0 && fragDelta > validSum) {
            const each = Math.round((fragDelta - validSum) / bogusIndices.length);
            if (isValidDur(each)) {
              for (const idx of bogusIndices) cur.samples[idx].duration = each;
            }
          }
        }
      }
      for (const s of cur.samples) trk.samples.push(s);
    }

    if (trk.samples.length === 0) continue;

    const validDurs = trk.samples
      .map((s) => s.duration)
      .filter(isValidDur)
      .sort((a, b) => a - b);

    const fallbackSampleTicks =
      validDurs.length > 0
        ? validDurs[Math.floor(validDurs.length / 2)]
        : Math.max(
            1,
            Math.round(
              expectedDurationSec > 0
                ? (expectedDurationSec * trk.mediaTimescale) / trk.samples.length
                : trk.handlerType === "soun"
                  ? 1024
                  : trk.mediaTimescale / Math.max(1, fps)
            )
          );

    let totalTicks = 0;
    let minCto = 0;
    for (const s of trk.samples) {
      if (!isValidDur(s.duration)) s.duration = fallbackSampleTicks;
      totalTicks += s.duration;
      if (!Number.isFinite(s.cto) || Math.abs(s.cto) > maxSampleTicks) {
        s.cto = 0;
      }
      if (s.cto < minCto) minCto = s.cto;
    }
    if (minCto < 0) {
      for (const s of trk.samples) s.cto -= minCto;
    }

    if (expectedDurationSec > 0) {
      const actualSec = totalTicks / trk.mediaTimescale;
      if (
        actualSec > expectedDurationSec * 1.8 ||
        actualSec < expectedDurationSec * 0.25
      ) {
        const targetTotal = Math.max(
          trk.samples.length,
          Math.round(expectedDurationSec * trk.mediaTimescale)
        );
        const base = Math.floor(targetTotal / trk.samples.length);
        let rem = targetTotal - base * trk.samples.length;
        for (const s of trk.samples) {
          s.duration = base + (rem > 0 ? (rem--, 1) : 0);
        }
      }
    }

    if (trk.handlerType === "vide" && trk.nalLengthSize > 0) {
      const idrFlags = trk.samples.map((s) =>
        containsAvcIdrSlice(s.data, trk.nalLengthSize)
      );
      if (idrFlags.some(Boolean)) {
        trk.samples.forEach((s, idx) => {
          s.isSync = idrFlags[idx];
        });
      }
    }
    trk.samples[0].isSync = true;
  }

  const activeTracks = trackOrder.filter((t) => t.samples.length > 0);
  if (activeTracks.length === 0) return null;

  const cursors = activeTracks.map(() => 0);
  const timesSec = activeTracks.map(() => 0);
  const chunkRelOffsets: number[][] = activeTracks.map(() => []);
  const chunkSampleCounts: number[][] = activeTracks.map(() => []);
  const mdatSlices: Uint8Array[] = [];
  let mdatDataLen = 0;
  let windowEndSec = 0.5;

  while (activeTracks.some((t, ti) => cursors[ti] < t.samples.length)) {
    let progressed = false;
    for (let ti = 0; ti < activeTracks.length; ti++) {
      const trk = activeTracks[ti];
      const startIdx = cursors[ti];
      if (startIdx >= trk.samples.length) continue;
      let idx = startIdx;
      while (idx < trk.samples.length && timesSec[ti] < windowEndSec) {
        timesSec[ti] += trk.samples[idx].duration / trk.mediaTimescale;
        idx++;
      }
      if (idx > startIdx) {
        chunkRelOffsets[ti].push(mdatDataLen);
        chunkSampleCounts[ti].push(idx - startIdx);
        for (let k = startIdx; k < idx; k++) {
          const d = trk.samples[k].data;
          mdatSlices.push(d);
          mdatDataLen += d.byteLength;
        }
        cursors[ti] = idx;
        progressed = true;
      }
    }
    if (
      !progressed ||
      activeTracks.every(
        (t, ti) =>
          cursors[ti] >= t.samples.length || timesSec[ti] >= windowEndSec
      )
    ) {
      windowEndSec += 0.5;
    }
  }

  const trackSummaries = activeTracks.map((trk, ti) => {
    const mediaDuration = trk.samples.reduce((sum, s) => sum + s.duration, 0);
    const movieDuration = Math.max(
      1,
      Math.round((mediaDuration / trk.mediaTimescale) * movieTimescale)
    );
    return {
      trk,
      relOffsets: chunkRelOffsets[ti],
      sampleCounts: chunkSampleCounts[ti],
      mediaDuration,
      movieDuration,
    };
  });

  const maxMovieDuration = Math.max(
    ...trackSummaries.map((s) => s.movieDuration)
  );
  const mvhdRaw = input.subarray(mvhdBox.start, mvhdBox.end);

  const buildMoov = (mdatDataFileOffset: number): Uint8Array => {
    const patchedMvhd = patchMvhdBox(mvhdRaw, movieTimescale, maxMovieDuration);
    const trakBoxes = trackSummaries.map(
      ({ trk, relOffsets, sampleCounts, mediaDuration, movieDuration }) => {
        const sttsRuns: Array<{ count: number; delta: number }> = [];
        for (const s of trk.samples) {
          const prev = sttsRuns[sttsRuns.length - 1];
          if (prev && prev.delta === s.duration) prev.count++;
          else sttsRuns.push({ count: 1, delta: s.duration });
        }
        const sttsBody = new Uint8Array(4 + sttsRuns.length * 8);
        const sttsDv = new DataView(sttsBody.buffer);
        sttsDv.setUint32(0, sttsRuns.length);
        sttsRuns.forEach((r, idx) => {
          sttsDv.setUint32(4 + idx * 8, r.count >>> 0);
          sttsDv.setUint32(8 + idx * 8, r.delta >>> 0);
        });
        const stts = makeFullBox("stts", 0, 0, sttsBody);

        const stblChildren: Uint8Array[] = [trk.stsdRaw, stts];
        if (trk.samples.some((s) => s.cto !== 0)) {
          const cttsRuns: Array<{ count: number; cto: number }> = [];
          for (const s of trk.samples) {
            const prev = cttsRuns[cttsRuns.length - 1];
            if (prev && prev.cto === s.cto) prev.count++;
            else cttsRuns.push({ count: 1, cto: s.cto });
          }
          const cttsBody = new Uint8Array(4 + cttsRuns.length * 8);
          const cttsDv = new DataView(cttsBody.buffer);
          cttsDv.setUint32(0, cttsRuns.length);
          cttsRuns.forEach((r, idx) => {
            cttsDv.setUint32(4 + idx * 8, r.count >>> 0);
            cttsDv.setUint32(8 + idx * 8, r.cto >>> 0);
          });
          stblChildren.push(makeFullBox("ctts", 0, 0, cttsBody));
        }

        if (trk.handlerType === "vide") {
          const syncSampleNums: number[] = [];
          trk.samples.forEach((s, idx) => {
            if (s.isSync) syncSampleNums.push(idx + 1);
          });
          if (
            syncSampleNums.length > 0 &&
            syncSampleNums.length < trk.samples.length
          ) {
            const stssBody = new Uint8Array(4 + syncSampleNums.length * 4);
            const stssDv = new DataView(stssBody.buffer);
            stssDv.setUint32(0, syncSampleNums.length);
            syncSampleNums.forEach((n, idx) => {
              stssDv.setUint32(4 + idx * 4, n >>> 0);
            });
            stblChildren.push(makeFullBox("stss", 0, 0, stssBody));
          }
        }

        const stscRuns: Array<{ firstChunk: number; count: number }> = [];
        sampleCounts.forEach((cnt, idx) => {
          const prev = stscRuns[stscRuns.length - 1];
          if (!prev || prev.count !== cnt) {
            stscRuns.push({ firstChunk: idx + 1, count: cnt });
          }
        });
        const stscBody = new Uint8Array(4 + stscRuns.length * 12);
        const stscDv = new DataView(stscBody.buffer);
        stscDv.setUint32(0, stscRuns.length);
        stscRuns.forEach((r, idx) => {
          stscDv.setUint32(4 + idx * 12, r.firstChunk >>> 0);
          stscDv.setUint32(8 + idx * 12, r.count >>> 0);
          stscDv.setUint32(12 + idx * 12, 1);
        });
        stblChildren.push(makeFullBox("stsc", 0, 0, stscBody));

        const stszBody = new Uint8Array(8 + trk.samples.length * 4);
        const stszDv = new DataView(stszBody.buffer);
        stszDv.setUint32(0, 0);
        stszDv.setUint32(4, trk.samples.length >>> 0);
        trk.samples.forEach((s, idx) => {
          stszDv.setUint32(8 + idx * 4, s.data.byteLength >>> 0);
        });
        stblChildren.push(makeFullBox("stsz", 0, 0, stszBody));

        const stcoBody = new Uint8Array(4 + relOffsets.length * 4);
        const stcoDv = new DataView(stcoBody.buffer);
        stcoDv.setUint32(0, relOffsets.length >>> 0);
        relOffsets.forEach((rel, idx) => {
          stcoDv.setUint32(4 + idx * 4, (mdatDataFileOffset + rel) >>> 0);
        });
        stblChildren.push(makeFullBox("stco", 0, 0, stcoBody));

        const newStbl = makeBox("stbl", ...stblChildren);
        const newMinf = makeBox("minf", ...trk.keptMinfBoxes, newStbl);
        const newMdhd = patchMdhdBox(
          trk.mdhdRaw,
          trk.mediaTimescale,
          mediaDuration
        );
        const newMdia = makeBox("mdia", newMdhd, trk.hdlrRaw, newMinf);
        const newTkhd = patchTkhdBox(trk.tkhdRaw, movieDuration);
        return makeBox("trak", newTkhd, newMdia);
      }
    );

    return makeBox("moov", patchedMvhd, ...trakBoxes);
  };

  const hasAvcVideo = activeTracks.some(
    (t) => t.handlerType === "vide" && t.nalLengthSize > 0
  );
  const origFtyp = topBoxes.find((b) => b.type === "ftyp");
  const ftypBytes =
    hasAvcVideo || !origFtyp
      ? makeBox(
          "ftyp",
          encodeAscii("isom"),
          u32be(0x200),
          encodeAscii("isomiso2avc1mp41")
        )
      : input.subarray(origFtyp.start, origFtyp.end);

  const sizeProbeMoov = buildMoov(0);
  const mdatDataFileOffset = ftypBytes.byteLength + sizeProbeMoov.byteLength + 8;
  const finalMoov = buildMoov(mdatDataFileOffset);

  const mdatHeader = new Uint8Array(8);
  new DataView(mdatHeader.buffer).setUint32(0, (8 + mdatDataLen) >>> 0);
  mdatHeader.set(encodeAscii("mdat"), 4);

  return concatBytes([ftypBytes, finalMoov, mdatHeader, ...mdatSlices]);
}

function sanitizeStandardMp4(
  input: Uint8Array,
  moovBox: Mp4Box,
  expectedDurationSec: number,
  fps: number
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(input.byteLength));
  out.set(input);

  const moovKids = parseBoxes(out, moovBox.dataStart, moovBox.end);
  const mvhd = moovKids.find((b) => b.type === "mvhd");
  if (!mvhd || mvhd.end - mvhd.dataStart < 20) return out;

  const mvDv = new DataView(
    out.buffer,
    out.byteOffset + mvhd.dataStart,
    mvhd.end - mvhd.dataStart
  );
  const mvVer = out[mvhd.dataStart];
  let movieTs =
    mvVer === 1 && mvDv.byteLength >= 24
      ? mvDv.getUint32(20)
      : mvDv.getUint32(12);
  if (!movieTs) {
    movieTs = 1000;
    mvDv.setUint32(mvVer === 1 ? 20 : 12, movieTs);
  }

  let maxTrackMovieTicks = 0;

  for (const trak of moovKids.filter((b) => b.type === "trak")) {
    const tKids = parseBoxes(out, trak.dataStart, trak.end);
    const tkhd = tKids.find((b) => b.type === "tkhd");
    const edts = tKids.find((b) => b.type === "edts");
    const mdia = tKids.find((b) => b.type === "mdia");

    if (edts && edts.size >= 8) {
      out.set(encodeAscii("free"), edts.start + 4);
      out.fill(0, edts.dataStart, edts.end);
    }
    if (!tkhd || !mdia || tkhd.end - tkhd.dataStart < 24) continue;

    const mKids = parseBoxes(out, mdia.dataStart, mdia.end);
    const mdhd = mKids.find((b) => b.type === "mdhd");
    const minf = mKids.find((b) => b.type === "minf");
    if (!mdhd || mdhd.end - mdhd.dataStart < 20) continue;

    const mdDv = new DataView(
      out.buffer,
      out.byteOffset + mdhd.dataStart,
      mdhd.end - mdhd.dataStart
    );
    const mdVer = out[mdhd.dataStart];
    const mediaTs =
      (mdVer === 1 && mdDv.byteLength >= 24
        ? mdDv.getUint32(20)
        : mdDv.getUint32(12)) || 90000;
    const maxSampleTicks = mediaTs * 3;
    const isValid = (d: number) =>
      d > 0 && d < 0x7fffffff && d <= maxSampleTicks;

    let mediaTicks = 0;
    if (minf) {
      const stbl = parseBoxes(out, minf.dataStart, minf.end).find(
        (b) => b.type === "stbl"
      );
      const stts = stbl
        ? parseBoxes(out, stbl.dataStart, stbl.end).find(
            (b) => b.type === "stts"
          )
        : undefined;
      if (stts && stts.end - stts.dataStart >= 8) {
        const stDv = new DataView(
          out.buffer,
          out.byteOffset + stts.dataStart,
          stts.end - stts.dataStart
        );
        const count = stDv.getUint32(4);
        const validDeltas: number[] = [];
        for (let i = 0; i < count && 8 + (i + 1) * 8 <= stDv.byteLength; i++) {
          const sc = stDv.getUint32(8 + i * 8);
          const sd = stDv.getUint32(12 + i * 8);
          if (sc > 0 && isValid(sd)) validDeltas.push(sd);
        }
        const fallbackDelta =
          validDeltas.length > 0
            ? validDeltas[Math.floor(validDeltas.length / 2)]
            : Math.max(1, Math.round(mediaTs / Math.max(1, fps)));
        for (let i = 0; i < count && 8 + (i + 1) * 8 <= stDv.byteLength; i++) {
          const sc = stDv.getUint32(8 + i * 8);
          let sd = stDv.getUint32(12 + i * 8);
          if (!isValid(sd)) {
            sd = fallbackDelta;
            stDv.setUint32(12 + i * 8, sd >>> 0);
          }
          mediaTicks += sc * sd;
        }
      }
    }

    if (expectedDurationSec > 0) {
      const sec = mediaTicks / mediaTs;
      if (
        mediaTicks <= 0 ||
        sec > expectedDurationSec * 1.8 ||
        sec < expectedDurationSec * 0.25
      ) {
        mediaTicks = Math.max(1, Math.round(expectedDurationSec * mediaTs));
      }
    }

    if (mdVer === 1 && mdDv.byteLength >= 32) {
      writeU64Number(mdDv, 24, mediaTicks);
    } else {
      mdDv.setUint32(16, Math.min(0x7fffffff, Math.round(mediaTicks)) >>> 0);
    }

    const trackMovieTicks = Math.max(
      1,
      Math.round((mediaTicks / mediaTs) * movieTs)
    );
    if (trackMovieTicks > maxTrackMovieTicks) {
      maxTrackMovieTicks = trackMovieTicks;
    }

    const tkDv = new DataView(
      out.buffer,
      out.byteOffset + tkhd.dataStart,
      tkhd.end - tkhd.dataStart
    );
    const tkVer = out[tkhd.dataStart];
    out[tkhd.dataStart + 3] = out[tkhd.dataStart + 3] | 0x03;
    if (tkVer === 1 && tkDv.byteLength >= 36) {
      writeU64Number(tkDv, 28, trackMovieTicks);
    } else {
      tkDv.setUint32(20, Math.min(0x7fffffff, trackMovieTicks) >>> 0);
    }
  }

  if (maxTrackMovieTicks <= 0 && expectedDurationSec > 0) {
    maxTrackMovieTicks = Math.max(1, Math.round(expectedDurationSec * movieTs));
  }
  if (maxTrackMovieTicks > 0) {
    if (mvVer === 1 && mvDv.byteLength >= 32) {
      writeU64Number(mvDv, 24, maxTrackMovieTicks);
    } else {
      mvDv.setUint32(16, Math.min(0x7fffffff, maxTrackMovieTicks) >>> 0);
    }
  }

  return out;
}

function patchWebmDurationInPlace(
  input: Uint8Array,
  expectedDurationSec: number
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(input.byteLength));
  out.set(input);
  if (expectedDurationSec <= 0 || out.byteLength < 64) return out;
  const scanLimit = Math.min(out.byteLength - 12, 4096);
  const durationMs = expectedDurationSec * 1000;
  for (let i = 0; i < scanLimit; i++) {
    if (out[i] === 0x44 && out[i + 1] === 0x89) {
      const dv = new DataView(out.buffer, out.byteOffset + i);
      if (out[i + 2] === 0x88 && i + 11 <= out.byteLength) {
        dv.setFloat64(3, durationMs, false);
        break;
      }
      if (out[i + 2] === 0x84 && i + 7 <= out.byteLength) {
        dv.setFloat32(3, durationMs, false);
        break;
      }
    }
  }
  return out;
}

export async function normalizeRecordedVideoBlob(
  rawBlob: Blob,
  mimeType: string,
  expectedDurationSec: number,
  fps = 30
): Promise<Blob> {
  try {
    const ab = await rawBlob.arrayBuffer();
    const input = new Uint8Array(ab);
    if (input.byteLength < 32) return rawBlob;

    if (mimeType.includes("webm") || (input[0] === 0x1a && input[1] === 0x45)) {
      const patched = patchWebmDurationInPlace(input, expectedDurationSec);
      return new Blob([patched], { type: "video/webm" });
    }

    const topBoxes = parseBoxes(input, 0, input.byteLength);
    const moovBox = topBoxes.find((b) => b.type === "moov");
    if (!moovBox) return rawBlob;

    const hasMoof = topBoxes.some((b) => b.type === "moof");
    if (hasMoof) {
      const fastStart = defragmentToFastStartMp4(
        input,
        topBoxes,
        moovBox,
        expectedDurationSec,
        fps
      );
      if (fastStart && fastStart.byteLength > 64) {
        return new Blob([fastStart], { type: "video/mp4" });
      }
    }

    const sanitized = sanitizeStandardMp4(
      input,
      moovBox,
      expectedDurationSec,
      fps
    );
    return new Blob([sanitized], { type: "video/mp4" });
  } catch {
    return rawBlob;
  }
}