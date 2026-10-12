/**
 * Web Worker entry point for the software H.264 decoder (TinyH264 / h264bsd).
 *
 * Why a custom worker instead of the one shipped in the tinyh264 package:
 * that worker passes each incoming buffer to h264bsd as a *single* NAL unit,
 * but scrcpy sends Annex-B access units that may hold several NALs (the config
 * packet is SPS followed by PPS, for instance). Feeding the raw buffer would
 * make h264bsd see one malformed NAL and drop the whole packet.
 *
 * So this worker splits Annex-B itself and drives the decoder one NAL at a
 * time, replaying the cached SPS/PPS ahead of each IDR slice — h264bsd needs
 * the parameter sets before it can decode anything.
 *
 * Message protocol (kept identical to the tinyh264 worker, so the main thread
 * would work with either):
 *   in : { type: 'decode', data: ArrayBuffer, offset, length, renderStateId }
 *        { type: 'release', renderStateId }
 *   out: { type: 'pictureReady', width, height, renderStateId, data: ArrayBuffer }
 *        { type: 'decoderReady' }
 */
import TinyH264 from 'tinyh264/es/TinyH264';
import TinyH264Decoder from 'tinyh264/es/TinyH264Decoder';
import { splitAnnexB, nalUnitType, NAL_TYPE } from '../../src/common/annexb';

interface DecodeMessage {
  type: 'decode';
  data: ArrayBuffer;
  offset: number;
  length: number;
  renderStateId: number;
}
interface ReleaseMessage {
  type: 'release';
  renderStateId: number;
}
type IncomingMessage = DecodeMessage | ReleaseMessage;

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<IncomingMessage>) => void): void;
}

const scope = self as unknown as WorkerScope;

interface DecoderEntry {
  decoder: TinyH264Decoder;
  parameterSets: Uint8Array[];
}

const decoders = new Map<number, DecoderEntry>();
let module: Awaited<ReturnType<typeof TinyH264>> | undefined;

function createEntry(renderStateId: number): DecoderEntry | undefined {
  if (!module) return undefined;
  const entry: DecoderEntry = {
    decoder: new TinyH264Decoder(module, (output, width, height) => {
      /*
       * `output` is a view into the WASM heap. Transferring its buffer would
       * detach the entire heap and crash the decoder, so copy the frame out
       * first — then the copy (and only the copy) can be transferred.
       */
      const frame = output.slice();
      scope.postMessage(
        { type: 'pictureReady', width, height, renderStateId, data: frame.buffer },
        [frame.buffer],
      );
    }),
    parameterSets: [],
  };
  decoders.set(renderStateId, entry);
  return entry;
}

function feed(entry: DecoderEntry, data: Uint8Array): void {
  const nals = splitAnnexB(data);
  for (const nal of nals) {
    const type = nalUnitType(nal);
    if (type === NAL_TYPE.SPS || type === NAL_TYPE.PPS) {
      // Cache the parameter set, dropping any stale one of the same kind.
      entry.parameterSets = entry.parameterSets.filter((n) => nalUnitType(n) !== type);
      entry.parameterSets.push(nal);
      entry.decoder.decode(nal);
      continue;
    }
    if (type === NAL_TYPE.SLICE_IDR) {
      // h264bsd cannot start a picture without its parameter sets in front.
      for (const param of entry.parameterSets) entry.decoder.decode(param);
    }
    entry.decoder.decode(nal);
  }
}

scope.addEventListener('message', (event) => {
  const message = event.data;
  try {
    if (message.type === 'release') {
      const entry = decoders.get(message.renderStateId);
      if (entry) {
        entry.decoder.release();
        decoders.delete(message.renderStateId);
      }
      return;
    }

    if (message.type !== 'decode') return;
    const entry = decoders.get(message.renderStateId) ?? createEntry(message.renderStateId);
    if (!entry) return;
    const view = new Uint8Array(message.data, message.offset, message.length);
    feed(entry, view);
  } catch (e) {
    scope.postMessage({ type: 'decoderError', message: (e as Error).message });
  }
});

// Booting the WASM runtime is async; announce readiness only once it resolves,
// which is what tells the main thread it may start pushing frames.
void TinyH264().then((resolved) => {
  module = resolved;
  scope.postMessage({ type: 'decoderReady' });
});
