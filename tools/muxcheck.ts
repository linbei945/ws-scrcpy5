/**
 * Structural test for the fMP4 muxer.
 *
 * MSE will silently reject a malformed init segment (or accept it and then
 * refuse every append), which in production looks exactly like "the phone is
 * still black". Encoding the box rules here means a broken `moov` fails
 * `npm test` instead of a family member's phone.
 *
 * The checks are written against ISO/IEC 14496-12 box layouts rather than
 * against this implementation, so they keep their meaning if the writer is
 * refactored.
 *
 * Run with: npm test  (via the `muxcheck` script)
 */
import { Fmp4Muxer, microsToTimescale, MuxError } from '../src/server/muxer';
import { buildAvcC, buildInitSegment, buildMediaSegment, TIMESCALE } from '../src/common/fmp4';
import { splitAnnexB } from '../src/common/annexb';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

/* ---------------------------------------------------------------- */
/* Annex-B fixtures (profile 0x42 = Baseline, what h264bsd targets)  */
/* ---------------------------------------------------------------- */

const SPS = Uint8Array.from([
  0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xc0, 0x29, 0x8d, 0x68, 0x05, 0x00,
]);
const PPS = Uint8Array.from([0x00, 0x00, 0x00, 0x01, 0x68, 0xce, 0x3c, 0x80]);
const CONFIG = Uint8Array.from([...SPS, ...PPS]);
/** An IDR access unit: start code + type-5 NAL header. */
const IDR = Uint8Array.from([
  0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00, 0x33, 0xff, 0xf1, 0x22,
]);
/** A non-IDR (P) access unit: type-1 NAL. */
const PFRAME = Uint8Array.from([
  0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x00, 0x11, 0x22, 0x33,
]);

/* ---------------------------------------------------------------- */
/* Box reader                                                        */
/* ---------------------------------------------------------------- */

interface Box {
  type: string;
  /** Offset of the box header within the buffer it was read from. */
  start: number;
  /** Total size, header included. */
  size: number;
  /** Offset of the first payload byte (after size + type [+ largesize]). */
  payload: number;
  children: Box[];
}

/**
 * Walks the box tree of a buffer. Only 32-bit sizes are produced by the muxer,
 * so `largesize` is not needed and its absence is itself an assertion.
 *
 * `childStart` encodes the per-box header prefix: full boxes carry a 4-byte
 * version/flags word, `stsd` additionally a 4-byte entry_count, and the `avc1`
 * sample entry has its 78-byte VisualSampleEntry fields before any child box.
 */
function readBoxes(data: Uint8Array, from = 0, to = data.length): Box[] {
  const out: Box[] = [];
  let offset = from;
  while (offset + 8 <= to) {
    const size =
      (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
    if (size < 8 || offset + size > to) break;
    const type = String.fromCharCode(
      data[offset + 4],
      data[offset + 5],
      data[offset + 6],
      data[offset + 7],
    );
    const box: Box = { type, start: offset, size, payload: offset + 8, children: [] };
    const prefix = CHILD_PREFIX[type];
    if (prefix !== undefined) {
      box.children = readBoxes(data, offset + 8 + prefix, offset + size);
    }
    out.push(box);
    offset += size;
  }
  return out;
}

/** Bytes between a container's header and its first child box. */
const CHILD_PREFIX: Record<string, number> = {
  moov: 0, // mvhd is itself a full box; moov has no version/flags of its own
  trak: 0,
  mdia: 0,
  minf: 0,
  stbl: 0,
  dinf: 0,
  moof: 0,
  traf: 0,
  mvex: 0, // plain container holding the per-track trex defaults
  stsd: 8, // full box: version/flags(4) + entry_count(4)
  dref: 8, // full box: version/flags(4) + entry_count(4)
  avc1: 78, // VisualSampleEntry fixed fields before avcC
};

function find(boxes: Box[], type: string): Box | undefined {
  for (const box of boxes) {
    if (box.type === type) return box;
    const nested = find(box.children, type);
    if (nested) return nested;
  }
  return undefined;
}

/** Byte offset of a four-character box type, the way the client finds `avcC`. */
function indexOfAscii(haystack: Uint8Array, needle: string): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

function findAll(boxes: Box[], type: string): Box[] {
  const out: Box[] = [];
  for (const box of boxes) {
    if (box.type === type) out.push(box);
    out.push(...findAll(box.children, type));
  }
  return out;
}

function u32at(data: Uint8Array, offset: number): number {
  return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

/**
 * How many 4-byte words a `trun` carries *after* `sample_count`, derived purely
 * from its flag bits (ISO/IEC 14496-12 §8.8.8). Used to assert the writer's
 * flags declare exactly the fields it actually emits — the bug that let a
 * `sample-flags-present` word slip out undeclared.
 */
function trunExpectedTrailingWords(flags: number, sampleCount: number): number {
  let words = 0;
  if (flags & 0x000001) words += 1; // data-offset-present
  if (flags & 0x000004) words += 1; // first-sample-flags-present
  const perSample =
    (flags & 0x000100 ? 1 : 0) + // sample-duration-present
    (flags & 0x000200 ? 1 : 0) + // sample-size-present
    (flags & 0x000400 ? 1 : 0) + // sample-flags-present
    (flags & 0x000800 ? 1 : 0); // sample-composition-time-offset-present
  words += perSample * sampleCount;
  return words;
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...data.subarray(offset, offset + length));
}

/* ---------------------------------------------------------------- */
/* avcC                                                              */
/* ---------------------------------------------------------------- */

console.log('avcC (AVCDecoderConfigurationRecord)');
{
  const sps = SPS.subarray(4); // drop the start code
  const pps = PPS.subarray(4);
  const avcC = buildAvcC(sps, pps);
  check('configurationVersion is 1', avcC[0] === 1, avcC[0]);
  check('carries SPS profile/compat/level', avcC[1] === 0x42 && avcC[2] === 0xc0 && avcC[3] === 0x29);
  check('lengthSizeMinusOne is 3 (4-byte NAL lengths)', (avcC[4] & 0x03) === 3, avcC[4] & 0x03);
  check('one SPS declared', (avcC[5] & 0x1f) === 1, avcC[5] & 0x1f);
  const spsLen = (avcC[6] << 8) | avcC[7];
  check('SPS length matches', spsLen === sps.length, { spsLen, actual: sps.length });
  const ppsCountOffset = 8 + spsLen;
  check('one PPS declared', avcC[ppsCountOffset] === 1, avcC[ppsCountOffset]);
  const ppsLen = (avcC[ppsCountOffset + 1] << 8) | avcC[ppsCountOffset + 2];
  check('PPS length matches', ppsLen === pps.length, { ppsLen, actual: pps.length });
}

/* ---------------------------------------------------------------- */
/* init segment                                                      */
/* ---------------------------------------------------------------- */

console.log('\ninit segment (ftyp + moov)');
{
  const init = buildInitSegment({
    sps: SPS.subarray(4),
    pps: PPS.subarray(4),
    width: 1080,
    height: 2400,
  });
  const top = readBoxes(init);
  check('starts with ftyp', top[0]?.type === 'ftyp', top.map((b) => b.type));
  check('followed by moov', top[1]?.type === 'moov', top.map((b) => b.type));
  check('exactly two top-level boxes', top.length === 2, top.length);
  check('top-level sizes cover the buffer', top.reduce((a, b) => a + b.size, 0) === init.length);

  check('ftyp major brand is iso6', ascii(init, 8, 4) === 'iso6', ascii(init, 8, 4));
  const brands = ascii(init, 16, 12);
  check('ftyp lists avc1 as a compatible brand', brands.includes('avc1'), brands);

  check('moov carries mvhd', !!find(top, 'mvhd'));
  check('moov carries trak', !!find(top, 'trak'));
  /*
   * Regression for a black screen: without `mvex` the file is not *fragmented*
   * as far as MSE is concerned, and Chrome refuses the init segment with
   *
   *   Detected unfragmented MP4. Media Source Extensions require ISO BMFF moov
   *   to contain mvex to indicate that Movie Fragments are to be expected.
   *
   * It then discards the SourceBuffer, so the *next* append reports "This
   * SourceBuffer has been removed from the parent media source" — a message
   * that points at the lifecycle instead of at the missing header.
   */
  check('moov carries mvex (required for a fragmented stream)', !!find(top, 'mvex'));
  const trex = find(top, 'trex');
  check('mvex carries a trex for the track', !!trex);
  if (trex) {
    // trex v0: ver/flags(4) track_ID(4) default_sample_description_index(4)…
    check('trex declares track_ID 1', u32at(init, trex.payload + 4) === 1, u32at(init, trex.payload + 4));
    check(
      'trex declares sample description index 1',
      u32at(init, trex.payload + 8) === 1,
      u32at(init, trex.payload + 8),
    );
  }
  check('trak carries tkhd', !!find(top, 'tkhd'));
  check('mdia carries mdhd', !!find(top, 'mdhd'));
  check('mdia carries hdlr', !!find(top, 'hdlr'));
  check('minf carries vmhd (video media header)', !!find(top, 'vmhd'));
  check('minf carries dinf', !!find(top, 'dinf'));
  check('dref has one entry', !!find(top, 'url '));

  const stsd = find(top, 'stsd');
  check('stbl carries stsd', !!stsd);
  const avc1 = findAll(top, 'avc1')[0];
  check('stsd holds an avc1 sample entry', !!avc1);
  check('sample entry carries avcC', !!find(top, 'avcC'));

  const hdlr = find(top, 'hdlr');
  if (hdlr) {
    // hdlr payload: version/flags(4) pre_defined(4) handler_type(4) …
    check('handler type is vide', ascii(init, hdlr.payload + 8, 4) === 'vide', ascii(init, hdlr.payload + 8, 4));
  }

  const tkhd = find(top, 'tkhd');
  if (tkhd) {
    // tkhd v0 payload: ver/flags(4) times(8) track_ID(4) reserved(4) dur(4)
    //                 reserved(8) layer(2) alt(2) vol(2) reserved(2) matrix(36)
    //                 width(4) height(4)
    const width = u32at(init, tkhd.payload + 76) / 65536;
    const height = u32at(init, tkhd.payload + 80) / 65536;
    check('tkhd display width is 1080', width === 1080, width);
    check('tkhd display height is 2400', height === 2400, height);
  }

  const mvhd = find(top, 'mvhd');
  if (mvhd) {
    // mvhd v0: ver/flags(4) times(8) timescale(4)
    check('mvhd timescale is 90000', u32at(init, mvhd.payload + 12) === TIMESCALE, u32at(init, mvhd.payload + 12));
  }

  const stsz = find(top, 'stsz');
  check('stsz is present (sample size table)', !!stsz);
  check('stco is present (chunk offset table)', !!find(top, 'stco'));
}

/* ---------------------------------------------------------------- */
/* media segment                                                     */
/* ---------------------------------------------------------------- */

console.log('\nmedia segment (moof + mdat)');
{
  const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x11, 0x22]);
  const segment = buildMediaSegment({
    data: payload,
    decodeTime: 12_345,
    duration: 3000,
    keyFrame: true,
    sequenceNumber: 7,
  });
  const top = readBoxes(segment);
  check('starts with moof', top[0]?.type === 'moof', top.map((b) => b.type));
  check('followed by mdat', top[1]?.type === 'mdat', top.map((b) => b.type));
  check('exactly two top-level boxes', top.length === 2, top.length);

  const moof = top[0];
  const mdat = top[1];
  check('moof carries mfhd', !!find([moof], 'mfhd'));
  check('moof carries traf', !!find([moof], 'traf'));
  check('traf carries tfhd', !!find([moof], 'tfhd'));
  check('traf carries tfdt', !!find([moof], 'tfdt'));
  const trun = find([moof], 'trun');
  check('traf carries trun', !!trun);

  const mfhd = find([moof], 'mfhd');
  if (mfhd) check('mfhd sequence_number is 7', u32at(segment, mfhd.payload + 4) === 7, u32at(segment, mfhd.payload + 4));

  const tfdt = find([moof], 'tfdt');
  if (tfdt) {
    // tfdt v1: ver/flags(4) baseMediaDecodeTime(uint64)
    const hi = u32at(segment, tfdt.payload + 4);
    const lo = u32at(segment, tfdt.payload + 8);
    check('tfdt carries the decode time', hi === 0 && lo === 12_345, { hi, lo });
  }

  if (trun) {
    // trun with data-offset + duration + size + flags: ver/flags(4)
    // sample_count(4) data_offset(4) duration(4) size(4) flags(4)
    const sampleCount = u32at(segment, trun.payload + 4);
    const dataOffset = u32at(segment, trun.payload + 8);
    const duration = u32at(segment, trun.payload + 12);
    const size = u32at(segment, trun.payload + 16);
    const flags = u32at(segment, trun.payload + 20);
    check('trun has one sample', sampleCount === 1, sampleCount);
    check('trun duration matches', duration === 3000, duration);
    check('trun sample size matches the payload', size === payload.length, size);
    check('trun marks a key frame', (flags & 0x0100_0000) === 0, flags.toString(16));
    check('trun data_offset points at the mdat payload', dataOffset === moof.size + 8, {
      dataOffset,
      expected: moof.size + 8,
    });
    // The lock that catches the undeclared sample-flags word: the trun *box*
    // flags must declare exactly the words actually present after sample_count.
    // `flags` above is the per-sample flags word (at payload+20); the box flags
    // live in the version/flags word at the start of the box. A mismatch here is
    // the bug that put `mdat` four bytes off for strict ISO-BMFF readers.
    const boxFlags = u32at(segment, trun.payload) & 0x00ffffff;
    // Words after sample_count, measured inside the box: header(8) + ver/flags(4)
    // + sample_count(4) = 16 bytes come before the per-sample fields.
    const trailingWords = (trun.size - 16) / 4;
    const declaredWords = trunExpectedTrailingWords(boxFlags, sampleCount);
    check('trun flags declare exactly the fields written', trailingWords === declaredWords, {
      trailingWords,
      declaredWords,
      boxFlags: boxFlags.toString(16),
    });
    // The decisive one: those bytes must actually be the payload. `data_offset`
    // is relative to the *moof*, so the absolute position is moof.start + it.
    const at = moof.start + dataOffset;
    check(
      'data_offset lands on the first payload byte',
      segment[at] === payload[0] && segment[at + payload.length - 1] === payload[payload.length - 1],
      [...segment.subarray(at, at + payload.length)],
    );
  }

  check('mdat payload is intact', Array.from(segment.subarray(mdat.payload, mdat.payload + payload.length)).join() === Array.from(payload).join());
}

/* ---------------------------------------------------------------- */
/* muxer (whole pipeline)                                            */
/* ---------------------------------------------------------------- */

console.log('\nmuxer pipeline');
{
  const muxer = new Fmp4Muxer();
  check('nothing is emitted before geometry is known', muxer.setConfig(CONFIG) === undefined);
  check('no media segment is produced before the init segment', muxer.pushFrame(0, true, IDR) === undefined);

  muxer.setGeometry(1080, 2400);
  const init = muxer.setConfig(CONFIG);
  check('init segment appears once SPS/PPS and size are known', !!init);
  check('init starts with ftyp', init ? ascii(init, 4, 4) === 'ftyp' : false);
  check('muxer reports ready', muxer.ready);
  check('codec string is the SPS profile', muxer.codecString === 'avc1.42C029', muxer.codecString);

  const first = muxer.pushFrame(0, true, IDR);
  check('IDR produces a media segment', !!first);
  check('that segment starts with moof', first ? ascii(first, 4, 4) === 'moof' : false);

  const second = muxer.pushFrame(33_333, false, PFRAME);
  check('a P frame produces a media segment too', !!second);

  // The AVCC conversion must have replaced the Annex-B start code with a length.
  if (second) {
    const top = readBoxes(second);
    const mdat = top.find((b) => b.type === 'mdat');
    if (mdat) {
      const nalLen = u32at(second, mdat.payload);
      const nalType = second[mdat.payload + 4] & 0x1f;
      check('mdat starts with a 4-byte NAL length', nalLen === PFRAME.length - 4, {
        nalLen,
        expected: PFRAME.length - 4,
      });
      check('the NAL is the original type (P = 1)', nalType === 1, nalType);
    } else {
      check('mdat is present', false);
    }
  }

  // Sequence numbers must advance, or players concatenate fragments wrongly.
  if (first && second) {
    const s1 = find(readBoxes(first), 'mfhd');
    const s2 = find(readBoxes(second), 'mfhd');
    const n1 = s1 ? u32at(first, s1.payload + 4) : 0;
    const n2 = s2 ? u32at(second, s2.payload + 4) : 0;
    check('sequence numbers advance', n2 === n1 + 1, { n1, n2 });
  }

  // A resize must rebuild the init segment with the new dimensions.
  muxer.setGeometry(720, 1280);
  const resized = muxer.setConfig(CONFIG);
  const tkhd = resized ? find(readBoxes(resized), 'tkhd') : undefined;
  if (resized && tkhd) {
    check('resize rebuilds the init segment at the new size', u32at(resized, tkhd.payload + 76) / 65536 === 720);
  } else {
    check('resize rebuilds the init segment', false);
  }

  const bad = new Fmp4Muxer();
  let threw = false;
  try {
    bad.setCodec('h265');
  } catch (e) {
    threw = e instanceof MuxError;
  }
  check('a non-H.264 codec is refused with MuxError', threw);
}

/* ---------------------------------------------------------------- */
/* timestamp rebasing                                                */
/* ---------------------------------------------------------------- */

/*
 * Regression for a black screen with *no* error reported anywhere: scrcpy
 * stamps frames with the device clock, which starts at an arbitrary large
 * value. Passing that through to `tfdt` made `video.currentTime` begin in the
 * tens of seconds while the buffer held only a fraction of a second, so the
 * element sat past the end of its own buffered range and never presented a
 * frame. Rebasing the first frame to zero is what makes it play.
 */
console.log('\ntimestamp rebasing');
{
  const muxer = new Fmp4Muxer();
  muxer.setGeometry(720, 1280);
  muxer.setConfig(CONFIG);

  // A realistic device clock origin: ~11.5 seconds in microseconds.
  const BASE = 11_500_000;
  const decodeTimeOf = (segment: Uint8Array): number => {
    const tfdt = find(readBoxes(segment), 'tfdt');
    if (!tfdt) return -1;
    const hi = u32at(segment, tfdt.payload + 4);
    const lo = u32at(segment, tfdt.payload + 8);
    return hi * 2 ** 32 + lo;
  };

  const firstSeg = muxer.pushFrame(BASE, true, IDR);
  check('the first frame still produces a segment', !!firstSeg);
  check('the first frame is rebased to decode time 0', !!firstSeg && decodeTimeOf(firstSeg) === 0, {
    decodeTime: firstSeg ? decodeTimeOf(firstSeg) : null,
  });

  const secondSeg = muxer.pushFrame(BASE + 33_333, false, PFRAME);
  check('the second frame keeps its relative offset (~3000 ticks)', !!secondSeg && decodeTimeOf(secondSeg) === 3000, {
    decodeTime: secondSeg ? decodeTimeOf(secondSeg) : null,
  });

  // A pts that goes backwards must not produce a negative decode time: MSE
  // rejects a fragment whose timestamp precedes the previous one.
  const backSeg = muxer.pushFrame(BASE - 1000, false, PFRAME);
  check('a backwards pts is clamped, never negative', !backSeg || decodeTimeOf(backSeg) >= 0, {
    decodeTime: backSeg ? decodeTimeOf(backSeg) : null,
  });
}

/**
 * The timeline MSE plays must be gapless.
 *
 * This is the bug that froze the picture: `tfdt` carried the frame's real pts
 * while `trun` carried the *previous* interval as this sample's duration, so
 * whenever the frame spacing changed, consecutive samples stopped meeting and
 * left a hole in the middle of the buffer. A `<video>` reaching a hole waits
 * for data that can never arrive — frozen picture, no error, appends still
 * succeeding. Varying the interval below is what the old code got wrong.
 */
console.log('\ngapless timeline (no holes between samples)');
{
  const muxer = new Fmp4Muxer();
  muxer.setGeometry(720, 1280);
  muxer.setConfig(CONFIG);

  const tfdtOf = (segment: Uint8Array): number => {
    const tfdt = find(readBoxes(segment), 'tfdt');
    if (!tfdt) return -1;
    return u32at(segment, tfdt.payload + 4) * 2 ** 32 + u32at(segment, tfdt.payload + 8);
  };
  /** trun: ver/flags(4) sample_count(4) data_offset(4) duration(4) */
  const durationOf = (segment: Uint8Array): number => {
    const trun = find(readBoxes(segment), 'trun');
    if (!trun) return -1;
    return u32at(segment, trun.payload + 12);
  };

  // Frame spacing changes mid-stream (100 ms, then ~33 ms): exactly the shape
  // a real encoder produces while it ramps up.
  const intervals = [100_000, 100_000, 33_333, 33_333, 33_333, 50_000, 33_333, 33_333];
  let pts = 5_000_000;
  let expectedEnd = 0;
  let holes = 0;
  let overlaps = 0;

  for (const step of intervals) {
    const segment = muxer.pushFrame(pts, false, PFRAME);
    if (!segment) {
      holes++;
      continue;
    }
    const start = tfdtOf(segment);
    const end = start + durationOf(segment);
    if (start > expectedEnd) holes++;
    if (start < expectedEnd) overlaps++;
    expectedEnd = end;
    pts += step;
  }

  check('no hole between consecutive samples', holes === 0, { holes });
  check('no overlap between consecutive samples', overlaps === 0, { overlaps });
  check('the timeline still tracks real time', Math.abs(expectedEnd - microsToTimescale(intervals.reduce((a, b) => a + b, 0))) <= 2, {
    timeline: expectedEnd,
    real: microsToTimescale(intervals.reduce((a, b) => a + b, 0)),
  });

  // One encoder stall must not become a multi-second frozen sample.
  const stalled = new Fmp4Muxer();
  stalled.setGeometry(720, 1280);
  stalled.setConfig(CONFIG);
  stalled.pushFrame(0, true, IDR);
  const afterStall = stalled.pushFrame(5_000_000, false, PFRAME);
  check('a 5s encoder stall is capped, not turned into a 5s sample', !!afterStall && durationOf(afterStall) <= 30_000, {
    duration: afterStall ? durationOf(afterStall) : null,
  });
}

/*
 * Rotation / display change.
 *
 * scrcpy restarts the video encoder when the screen size changes and then
 * re-sends a session meta packet followed by a fresh codec-config packet
 * (`SurfaceEncoder.streamCapture`). The init segment bakes in the display size,
 * so it has to be rebuilt *and handed to the client again* — a one-shot
 * "already sent" latch dropped it, and the phone kept decoding the old
 * resolution for the rest of the session.
 *
 * The timeline has to restart too: the client answers a new init segment with a
 * brand-new `MediaSource`, whose buffer is empty and whose playhead is at zero.
 * A segment stamped with the old cursor would land seconds past the end of
 * that buffer, i.e. a frozen picture with no error anywhere.
 */
console.log('\nrotation: new init segment and a restarted timeline');
{
  const tfdtOf = (segment: Uint8Array): number => {
    const tfdt = find(readBoxes(segment), 'tfdt');
    if (!tfdt) return -1;
    return u32at(segment, tfdt.payload + 4) * 2 ** 32 + u32at(segment, tfdt.payload + 8);
  };
  const tkhdWidthOf = (init: Uint8Array): number => {
    const tkhd = find(readBoxes(init), 'tkhd');
    return tkhd ? u32at(init, tkhd.payload + 76) / 65536 : -1;
  };

  const muxer = new Fmp4Muxer();
  muxer.setGeometry(1080, 2400);
  const portrait = muxer.setConfig(CONFIG);
  check('the first config packet yields an init segment', !!portrait);
  check('the init segment names the portrait size', !!portrait && tkhdWidthOf(portrait) === 1080, portrait ? tkhdWidthOf(portrait) : null);

  // Stream for a while: 200 frames at ~33 ms is ~6.6 s of timeline.
  let pts = 1_000_000;
  for (let i = 0; i < 200; i++) {
    muxer.pushFrame(pts, i === 0, PFRAME);
    pts += 33_333;
  }
  const beforeRotation = muxer.pushFrame(pts, false, PFRAME);
  check('the timeline has advanced well past zero', !!beforeRotation && tfdtOf(beforeRotation) > 100_000, {
    decodeTime: beforeRotation ? tfdtOf(beforeRotation) : null,
  });

  // Rotate: the encoder restarts at 2400x1080.
  muxer.setGeometry(2400, 1080);
  const landscape = muxer.setConfig(CONFIG);
  check('rotation re-emits an init segment', !!landscape, landscape === undefined);
  check('the new init segment names the landscape size', !!landscape && tkhdWidthOf(landscape) === 2400, landscape ? tkhdWidthOf(landscape) : null);

  const afterRotation = muxer.pushFrame(pts + 33_333, true, IDR);
  check('the first frame after rotation starts the timeline at zero', !!afterRotation && tfdtOf(afterRotation) === 0, {
    decodeTime: afterRotation ? tfdtOf(afterRotation) : null,
  });

  // An encoder restart that changes nothing must NOT re-emit: the client would
  // tear its MediaSource down for no reason.
  const again = muxer.setConfig(CONFIG);
  check('an unchanged config packet does not re-emit the init segment', again === undefined);
  const stillStreaming = muxer.pushFrame(pts + 66_666, false, PFRAME);
  check('and the timeline keeps running', !!stillStreaming && tfdtOf(stillStreaming) > 0, {
    decodeTime: stillStreaming ? tfdtOf(stillStreaming) : null,
  });

  // A genuinely new SPS (different profile) must be picked up.
  const newSps = Uint8Array.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x29, 0x8d, 0x68, 0x05, 0x00]);
  const reconfigured = muxer.setConfig(Uint8Array.from([...newSps, ...PPS]));
  check('a changed SPS re-emits the init segment', !!reconfigured);
  check('the codec string follows the new SPS', muxer.codecString === 'avc1.640029', muxer.codecString);
}

/* ---------------------------------------------------------------- */
/* tfdt width                                                        */
/* ---------------------------------------------------------------- */

/*
 * `tfdt` is version 1, so `baseMediaDecodeTime` is 64 bits wide. Writing only
 * the low 32 (for instance through a `>>> 0`) silently wraps after ~13.2 hours
 * at 90 kHz — a backwards `tfdt` is precisely the hole that freezes playback.
 */
console.log('\ntfdt is a full 64-bit decode time');
{
  const beyond32 = 2 ** 32 + 12345;
  const segment = buildMediaSegment({
    data: new Uint8Array([1, 2, 3]),
    decodeTime: beyond32,
    duration: 3000,
    keyFrame: true,
    sequenceNumber: 1,
  });
  const tfdt = find(readBoxes(segment), 'tfdt');
  if (tfdt) {
    const hi = u32at(segment, tfdt.payload + 4);
    const lo = u32at(segment, tfdt.payload + 8);
    check('the high word is not dropped', hi === 1 && lo === 12345, { hi, lo, expected: beyond32 });
  } else {
    check('tfdt is present', false);
  }
}

/* ---------------------------------------------------------------- */
/* timestamps                                                        */
/* ---------------------------------------------------------------- */

console.log('\ntimestamps');
{
  check('1s in microseconds -> 90000 ticks', microsToTimescale(1_000_000) === 90_000, microsToTimescale(1_000_000));
  check('33.333ms -> 3000 ticks (30fps)', microsToTimescale(33_333) === 3000, microsToTimescale(33_333));
  check('zero stays zero', microsToTimescale(0) === 0);
  check('negative input is clamped to zero', microsToTimescale(-5) === 0, microsToTimescale(-5));

  // A non-monotonic pts (decoder restart) must not produce a zero-length sample.
  const muxer = new Fmp4Muxer();
  muxer.setGeometry(720, 1280);
  muxer.setConfig(CONFIG);
  muxer.pushFrame(1_000_000, true, IDR);
  const restarted = muxer.pushFrame(0, false, PFRAME);
  if (restarted) {
    const moof = readBoxes(restarted)[0];
    const trun = find([moof], 'trun');
    const duration = trun ? u32at(restarted, trun.payload + 12) : 0;
    check('a backwards pts falls back to a nominal duration', duration > 0, duration);
  } else {
    check('a backwards pts still yields a segment', false);
  }
}

/* ---------------------------------------------------------------- */
/* splitAnnexB contract (the muxer's input assumption)               */
/* ---------------------------------------------------------------- */

console.log('\nannex-b input contract');
{
  const split = splitAnnexB(CONFIG);
  check('config splits into SPS + PPS', split.length === 2, split.length);
  const idrSplit = splitAnnexB(IDR);
  check('IDR is a single NAL of type 5', idrSplit.length === 1 && (idrSplit[0][0] & 0x1f) === 5);
}

/* ---------------------------------------------------------------- */
/* The codec string MSE is handed (derived from this init segment)    */
/* ---------------------------------------------------------------- */

/*
 * Regression for a real black screen: the client used to read the
 * profile/compat/level from the *first* payload byte after the `avcC` type,
 * which is `configurationVersion` (always 0x01). It therefore asked MSE for
 * `avc1.0142C0` — a profile that does not exist — and every MSE-based phone
 * refused to create a SourceBuffer, leaving the screen black. The byte offsets
 * are pinned here so the on-wire string cannot drift again.
 */
console.log('\nmse codec string');
{
  const init = buildInitSegment({ sps: SPS.subarray(4), pps: PPS.subarray(4), width: 1280, height: 720 });
  const index = indexOfAscii(init, 'avcC');
  check('the init segment carries an avcC box', index >= 0);
  check('configurationVersion sits right after the box type', init[index + 4] === 0x01, init[index + 4]);
  const hex = (b: number) => b.toString(16).padStart(2, '0').toUpperCase();
  const codecString = `avc1.${hex(init[index + 5])}${hex(init[index + 6])}${hex(init[index + 7])}`;
  check('the codec string names the SPS profile (Baseline, not 0x01)', codecString === 'avc1.42C029', codecString);
  check('the profile byte is not configurationVersion', !codecString.startsWith('avc1.01'), codecString);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
