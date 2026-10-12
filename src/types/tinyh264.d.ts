/**
 * Minimal ambient types for the `tinyh264` package (tinyh264@0.0.7 ships no
 * .d.ts). Only the surface the client actually uses is declared.
 */
declare module 'tinyh264/es/index' {
  /** Boots the WASM runtime inside a worker and installs its message handler. */
  export function init(): Promise<void>;
}

declare module 'tinyh264/es/TinyH264' {
  /**
   * Emscripten module factory. The returned object exposes the h264bsd entry
   * points (`_h264bsdAlloc`, `_malloc`, `HEAPU8`, …) used by the decoder.
   */
  interface TinyH264Module {
    _h264bsdAlloc(): number;
    _h264bsdInit(storage: number, flag: number): number;
    _h264bsdShutdown(storage: number): void;
    _h264bsdFree(storage: number): void;
    _h264bsdDecode(
      storage: number,
      buffer: number,
      size: number,
      picture: number,
      widthPtr: number,
      heightPtr: number,
    ): number;
    _malloc(size: number): number;
    _free(ptr: number): void;
    getValue(ptr: number, type: string): number;
    HEAPU8: Uint8Array;
  }
  const factory: (moduleOverrides?: Record<string, unknown>) => Promise<TinyH264Module>;
  export default factory;
}

declare module 'tinyh264/es/TinyH264Decoder' {
  import type TinyH264Module from 'tinyh264/es/TinyH264';
  type PictureReadyCallback = (output: Uint8Array, width: number, height: number) => void;
  export default class TinyH264Decoder {
    static readonly RDY: number;
    static readonly PIC_RDY: number;
    static readonly HDRS_RDY: number;
    static readonly ERROR: number;
    static readonly PARAM_SET_ERROR: number;
    static readonly MEMALLOC_ERROR: number;
    constructor(module: TinyH264Module, onPictureReady: PictureReadyCallback);
    decode(nal: Uint8Array | ArrayBuffer): void;
    release(): void;
  }
}
