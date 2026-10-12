/**
 * Annex-B NAL splitting, shared by the WebCodecs path (which repairs the
 * buffer into AVCC) and the software decoder worker (which feeds one NAL at a
 * time to h264bsd).
 *
 * Kept dependency-free on purpose: the worker bundles it too, and it must not
 * pull in any DOM or WebCodecs API just to slice bytes.
 */

/**
 * Splits an Annex-B buffer into NAL units; `[]` means "not Annex-B".
 *
 * A start code is either `00 00 01` (3 bytes) or `00 00 00 01` (4 bytes). The
 * NAL payload always starts right after the `00 00 01` pattern, so the offset
 * from the pattern to the payload is 3 regardless of the start code length.
 * H.264 forbids `00 00 00` / `00 00 01` inside a NAL (emulation prevention),
 * so a zero byte right before the pattern unambiguously means a 4-byte code.
 */
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  if (data.length < 4) return [];
  const startsWithStartCode =
    (data[0] === 0 && data[1] === 0 && data[2] === 1) ||
    (data[0] === 0 && data[1] === 0 && data[2] === 0 && data[3] === 1);
  if (!startsWithStartCode) return [];

  const marks: number[] = [];
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      marks.push(i);
      i += 2;
    }
  }

  const nals: Uint8Array[] = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i] + 3;
    let end = data.length;
    if (i + 1 < marks.length) {
      const next = marks[i + 1];
      // The preceding zero belongs to the next (4-byte) start code.
      end = next > 0 && data[next - 1] === 0 ? next - 1 : next;
    }
    if (end > start) nals.push(data.subarray(start, end));
  }
  return nals;
}

/** H.264 NAL unit type, taken from the low 5 bits of the NAL header. */
export function nalUnitType(nal: Uint8Array): number {
  return nal.length > 0 ? nal[0] & 0x1f : 0;
}

export const NAL_TYPE = {
  SLICE_NON_IDR: 1,
  SLICE_IDR: 5,
  SEI: 6,
  SPS: 7,
  PPS: 8,
  AUD: 9,
} as const;
