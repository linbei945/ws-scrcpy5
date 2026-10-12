/**
 * Minimal fragmented-MP4 (ISO/IEC 14496-12) writer for one H.264 track.
 *
 * Why this exists: on a plain `http://<lan-ip>` origin the browser withholds
 * WebCodecs (`VideoDecoder`) because that origin is not a *secure context*, but
 * it *does* expose Media Source Extensions. MSE feeds a `<video>` element, whose
 * decoding is hardware-accelerated — so wrapping the scrcpy H.264 stream in
 * fMP4 gets hardware decoding back on http, with no certificate.
 *
 * scrcpy hands us raw Annex-B access units; MSE wants fMP4. This module is the
 * bridge, and it is deliberately dependency-free so it can be unit tested from
 * Node with no browser at all.
 *
 * Layout produced:
 *
 *   init segment  : ftyp + moov(mvhd/trak/tkhd/mdia/mdhd/hdlr/minf/vmhd/dinf/
 *                   stbl/stsd(avc1/avcC)/stts/stsc/stsz/stco)
 *   media segment : moof(mfhd/traf/tfhd/tfdt/trun) + mdat   (one per AU)
 *
 * Each media segment starts on a key frame and carries a single access unit.
 * That is the simplest shape MSE accepts and the one that handles latency best:
 * nothing is buffered ahead, so a stalled socket cannot leave the decoder
 * waiting for a fragment that never arrives.
 */

/** 90000 Hz is the conventional H.264/mp4 media timescale. */
export const TIMESCALE = 90_000;

function ascii(out: number[], text: string): void {
  for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i) & 0xff);
}

function u8(out: number[], value: number): void {
  out.push(value & 0xff);
}

function u16(out: number[], value: number): void {
  out.push((value >>> 8) & 0xff, value & 0xff);
}

function u24(out: number[], value: number): void {
  out.push((value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function u32(out: number[], value: number): void {
  out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function bytes(out: number[], data: Uint8Array): void {
  for (let i = 0; i < data.length; i++) out.push(data[i]);
}

function zeros(out: number[], count: number): void {
  for (let i = 0; i < count; i++) out.push(0);
}

/**
 * A box whose size is patched in once its contents are known.
 *
 * Every box starts with a 32-bit size, so writing children first and then
 * back-filling the length keeps the code readable and avoids a second pass.
 */
function box(type: string, body: (out: number[]) => void): Uint8Array {
  const out: number[] = [];
  out.push(0, 0, 0, 0); // patched below
  ascii(out, type);
  body(out);
  const size = out.length;
  out[0] = (size >>> 24) & 0xff;
  out[1] = (size >>> 16) & 0xff;
  out[2] = (size >>> 8) & 0xff;
  out[3] = size & 0xff;
  return Uint8Array.from(out);
}

function fullBox(
  type: string,
  version: number,
  flags: number,
  body: (out: number[]) => void,
): Uint8Array {
  return box(type, (out) => {
    u8(out, version);
    u24(out, flags);
    body(out);
  });
}

/** SPS profile / compatibility / level, as needed by `avc1` and `avcC`. */
export interface AvcProfile {
  profileIdc: number;
  profileCompat: number;
  levelIdc: number;
}

/**
 * `avcC` (AVCDecoderConfigurationRecord, ISO/IEC 14496-15 §5.2.4.1).
 *
 * Only SPS/PPS are carried: scrcpy's H.264 encoder emits no SPS extensions and
 * MSE never reads them for H.264 anyway.
 */
export function buildAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const out: number[] = [];
  out.push(0x01); // configurationVersion
  out.push(sps[1], sps[2], sps[3]); // profile, compatibility, level
  out.push(0xff); // 6 reserved bits set | lengthSizeMinusOne = 3 (4-byte lengths)
  out.push(0xe1); // 3 reserved bits set | numOfSequenceParameterSets = 1
  u16(out, sps.length);
  bytes(out, sps);
  out.push(0x01); // numOfPictureParameterSets
  u16(out, pps.length);
  bytes(out, pps);
  return Uint8Array.from(out);
}

/** The unity transformation matrix every track header carries. */
function unityMatrix(out: number[]): void {
  u32(out, 0x0001_0000); u32(out, 0); u32(out, 0);
  u32(out, 0); u32(out, 0x0001_0000); u32(out, 0);
  u32(out, 0); u32(out, 0); u32(out, 0x4000_0000);
}

/**
 * Builds the init segment for an H.264 track.
 *
 * `width` / `height` are the pixel dimensions from the scrcpy session meta. The
 * sample entry carries the mandatory 72 dpi resolution fields; `pasp` is omitted,
 * which players treat as square pixels — correct for phone screens.
 */
export function buildInitSegment(options: {
  sps: Uint8Array;
  pps: Uint8Array;
  width: number;
  height: number;
  timescale?: number;
}): Uint8Array {
  const { sps, pps, width, height } = options;
  const timescale = options.timescale ?? TIMESCALE;

  const ftyp = box('ftyp', (out) => {
    ascii(out, 'iso6'); // major_brand
    u32(out, 0x200); // minor_version
    ascii(out, 'iso6'); // compatible brands (MSE sniffs these)
    ascii(out, 'avc1');
    ascii(out, 'mp41');
  });

  const avcC = box('avcC', (out) => bytes(out, buildAvcC(sps, pps)));

  /*
   * VisualSampleEntry: 6 reserved bytes + data_reference_index, then the
   * pre_defined/reserved words, then the 78-byte video fields. The sample entry
   * does NOT repeat its own four-character type after the box header.
   */
  const avc1 = box('avc1', (out) => {
    zeros(out, 6); // reserved
    u16(out, 1); // data_reference_index
    u16(out, 0); // pre_defined
    u16(out, 0); // reserved
    zeros(out, 12); // pre_defined[3]
    u16(out, width);
    u16(out, height);
    u32(out, 0x0048_0000); // horizresolution 72 dpi
    u32(out, 0x0048_0000); // vertresolution 72 dpi
    u32(out, 0); // reserved
    u16(out, 1); // frame_count
    u8(out, 0); // compressorname: length byte…
    zeros(out, 31); // …and 31 bytes of name (unused)
    u16(out, 0x0018); // depth
    u16(out, 0xffff); // pre_defined = -1
    bytes(out, avcC);
  });

  const stsd = fullBox('stsd', 0, 0, (out) => {
    u32(out, 1); // entry_count
    bytes(out, avc1);
  });

  /*
   * One sample per fragment, so the sample tables stay trivial. MSE ignores the
   * `stbl` tables for fragmented streams (every fragment is described by its own
   * `trun`), but a well-formed `stsd` is mandatory and the rest keeps the file
   * readable by other tools.
   */
  const table = (type: string, fields: number[]): Uint8Array =>
    fullBox(type, 0, 0, (out) => {
      u32(out, 1); // entry_count
      for (const f of fields) u32(out, f);
    });

  const stbl = box('stbl', (out) => {
    bytes(out, stsd);
    bytes(out, table('stts', [1, 0])); // one entry: count=1, delta=0
    bytes(out, table('stsc', [1, 1, 1])); // one entry: 1 sample per chunk
    bytes(out, table('stsz', [0, 0])); // sample_size=0 + one entry of size 0
    bytes(out, fullBox('stco', 0, 0, (out2) => u32(out2, 1)));
  });

  // dinf/dref/url with flags=1: "media data is in the same file".
  const dinf = box('dinf', (out) => {
    bytes(
      out,
      fullBox('dref', 0, 0, (out2) => {
        u32(out2, 1);
        bytes(out2, fullBox('url ', 0, 1, () => undefined));
      }),
    );
  });

  const minf = box('minf', (out) => {
    bytes(
      out,
      fullBox('vmhd', 0, 1, (out2) => {
        u16(out2, 0); // graphicsmode
        u16(out2, 0); // opcolor r
        u16(out2, 0); // opcolor g
        u16(out2, 0); // opcolor b
      }),
    );
    bytes(out, dinf);
    bytes(out, stbl);
  });

  const hdlr = fullBox('hdlr', 0, 0, (out) => {
    u32(out, 0); // pre_defined
    ascii(out, 'vide'); // handler_type
    zeros(out, 12); // reserved
    ascii(out, 'VideoHandler'); // name
    u8(out, 0); // null terminator
  });

  const mdhd = fullBox('mdhd', 0, 0, (out) => {
    u32(out, 0); // creation_time
    u32(out, 0); // modification_time
    u32(out, timescale);
    u32(out, 0); // duration: 0 for a fragmented/live track
    u16(out, 0x55c4); // language 'und'
    u16(out, 0); // pre_defined
  });

  const mdia = box('mdia', (out) => {
    bytes(out, mdhd);
    bytes(out, hdlr);
    bytes(out, minf);
  });

  const tkhd = fullBox('tkhd', 0, 3 /* enabled | in_movie */, (out) => {
    u32(out, 0); // creation_time
    u32(out, 0); // modification_time
    u32(out, 1); // track_ID
    zeros(out, 4); // reserved
    u32(out, 0); // duration
    zeros(out, 8); // reserved
    u16(out, 0); // layer
    u16(out, 0); // alternate_group
    u16(out, 0); // volume (0 for video)
    u16(out, 0); // reserved
    unityMatrix(out);
    u32(out, width << 16); // display width in 16.16 fixed point
    u32(out, height << 16);
  });

  const trak = box('trak', (out) => {
    bytes(out, tkhd);
    bytes(out, mdia);
  });

  const mvhd = fullBox('mvhd', 0, 0, (out) => {
    u32(out, 0); // creation_time
    u32(out, 0); // modification_time
    u32(out, timescale);
    u32(out, 0); // duration: 0 (fragmented)
    u32(out, 0x0001_0000); // rate 1.0
    u16(out, 0x0100); // volume 1.0
    u16(out, 0); // reserved
    zeros(out, 8); // reserved
    unityMatrix(out);
    zeros(out, 24); // pre_defined[6]
    u32(out, 2); // next_track_ID
  });

  /*
   * `mvex` is what makes the file *fragmented*, and MSE refuses a `moov`
   * without it:
   *
   *   Detected unfragmented MP4. Media Source Extensions require ISO BMFF moov
   *   to contain mvex to indicate that Movie Fragments are to be expected.
   *
   * The symptom is indirect — Chrome discards the whole SourceBuffer after the
   * failed init append, and the *next* `appendBuffer` then throws "This
   * SourceBuffer has been removed from the parent media source", which reads
   * like a lifecycle bug rather than the missing header it actually is.
   *
   * `trex` supplies the per-track defaults a fragment may omit (`tfhd` flags
   * 0x020000 in our segments means the defaults apply).
   */
  const mvex = box('mvex', (out) => {
    bytes(
      out,
      fullBox('trex', 0, 0, (out2) => {
        u32(out2, 1); // track_ID
        u32(out2, 1); // default_sample_description_index
        u32(out2, 0); // default_sample_duration (each trun states its own)
        u32(out2, 0); // default_sample_size
        u32(out2, 0); // default_sample_flags
      }),
    );
  });

  const moov = box('moov', (out) => {
    bytes(out, mvhd);
    bytes(out, trak);
    bytes(out, mvex);
  });

  const init = new Uint8Array(ftyp.length + moov.length);
  init.set(ftyp, 0);
  init.set(moov, ftyp.length);
  return init;
}

/**
 * Wraps one access unit (already AVCC: 4-byte length-prefixed NALs) into a
 * single-fragment media segment (`moof` + `mdat`).
 */
export function buildMediaSegment(options: {
  data: Uint8Array;
  /** Presentation time in `timescale` units. */
  decodeTime: number;
  /** Sample duration in `timescale` units. */
  duration: number;
  keyFrame: boolean;
  sequenceNumber: number;
  trackId?: number;
}): Uint8Array {
  const trackId = options.trackId ?? 1;
  const dataLength = options.data.length;

  // tfhd flags 0x020000 = default-base-is-moof: trun's data_offset is relative
  // to the start of the enclosing moof, which is what we compute below.
  const tfhd = fullBox('tfhd', 0, 0x020000, (out) => u32(out, trackId));

  /*
   * trun flags 0x000701 =
   *   data-offset-present (0x000001) | sample-duration-present (0x000100) |
   *   sample-size-present (0x000200) | sample-flags-present (0x000400).
   *
   * The five fields written below — sample_count, data_offset, duration, size and
   * per-sample flags — must be exactly the five the flags declare. A flag that is
   * missing the `sample-flags-present` bit (e.g. the old 0x000301) lets the
   * writer emit a 6th word the parser never reads, which shifts `mdat` by four
   * bytes for any *strict* ISO-BMFF reader (Safari, Firefox, ffmpeg). Chrome
   * happens to ignore the trailing word, which is why the old value "worked" in a
   * browser test while remaining spec-incorrect — a classic silent bug. The flags
   * and the written fields are kept in lock-step deliberately.
   */
  const trun = fullBox('trun', 0, 0x000701, (out) => {
    u32(out, 1); // sample_count
    u32(out, 0); // data_offset: patched below
    u32(out, options.duration);
    u32(out, dataLength);
    u32(out, options.keyFrame ? 0x0200_0000 : 0x0101_0000);
  });

  const mfhd = fullBox('mfhd', 0, 0, (out) => u32(out, options.sequenceNumber));
  /*
   * tfdt version 1 means `baseMediaDecodeTime` is a 64-bit value; writing only
   * 32 bits would shift every following box by four bytes and make the whole
   * fragment unparseable. Version 0 is 32-bit, so the split is written by hand
   * rather than picked by version.
   *
   * The full 64 bits are written, not the low 32: at 90 kHz the 32-bit field
   * wraps after ~13.2 hours, and a `tfdt` that jumps *backwards* is exactly the
   * hole in the timeline that freezes a `<video>` element.
   */
  const tfdt = fullBox('tfdt', 1, 0, (out) => {
    const time = BigInt(Math.round(options.decodeTime));
    u32(out, Number((time >> 32n) & 0xffff_ffffn));
    u32(out, Number(time & 0xffff_ffffn));
  });

  const moof = box('moof', (out) => {
    bytes(out, mfhd);
    bytes(
      out,
      box('traf', (out2) => {
        bytes(out2, tfhd);
        bytes(out2, tfdt);
        bytes(out2, trun);
      }),
    );
  });

  const mdat = box('mdat', (out) => bytes(out, options.data));

  const segment = new Uint8Array(moof.length + mdat.length);
  segment.set(moof, 0);
  segment.set(mdat, moof.length);

  /*
   * Patch trun's data_offset to point at the first payload byte of `mdat`.
   * trun is the last child of traf, so its box starts `trun.length` bytes
   * before the end of moof; the field is 8 bytes into the box (size + type) plus
   * 8 more for version/flags and sample_count.
   */
  const dataOffset = moof.length + 8; // skip the mdat box header
  const field = moof.length - trun.length + 16;
  segment[field + 0] = (dataOffset >>> 24) & 0xff;
  segment[field + 1] = (dataOffset >>> 16) & 0xff;
  segment[field + 2] = (dataOffset >>> 8) & 0xff;
  segment[field + 3] = dataOffset & 0xff;

  return segment;
}

/**
 * Converts an Annex-B access unit to the AVCC form fMP4 requires.
 *
 * Returns the input unchanged when it is already AVCC (some encoders hand out
 * length-prefixed NALs), so the muxer never silently drops a frame.
 */
export function annexBToAvcc(
  data: Uint8Array,
  split: (d: Uint8Array) => Uint8Array[],
): Uint8Array {
  const nals = split(data);
  if (nals.length === 0) return data;
  let total = 0;
  for (const nal of nals) total += nal.length + 4;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const nal of nals) {
    out[offset++] = (nal.length >>> 24) & 0xff;
    out[offset++] = (nal.length >>> 16) & 0xff;
    out[offset++] = (nal.length >>> 8) & 0xff;
    out[offset++] = nal.length & 0xff;
    out.set(nal, offset);
    offset += nal.length;
  }
  return out;
}
