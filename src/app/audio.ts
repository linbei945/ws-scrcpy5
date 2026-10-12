/**
 * Optional audio playback (Android 11+ only, enabled on demand).
 * Decoding uses WebCodecs AudioDecoder, playback uses Web Audio.
 */
import { AUDIO_CODEC_MIME } from '../common/protocol';

export class AudioPlayer {
  private ctx: AudioContext | undefined;
  private decoder: AudioDecoder | undefined;
  private nextStartTime = 0;
  private started = false;
  private gain: GainNode | undefined;
  /** Reported once: a missing AudioDecoder is not retried on every packet. */
  private unavailable = false;

  constructor(private readonly onError: (message: string) => void) {}

  get isPlaying(): boolean {
    return this.started;
  }

  async start(codecName: string, sampleRate: number, channels: number, description?: Uint8Array): Promise<void> {
    if (this.unavailable) return;
    if (!('AudioDecoder' in window)) {
      this.unavailable = true;
      this.onError('浏览器未提供 WebCodecs 音频解码接口（AudioDecoder），已跳过声音');
      return;
    }
    const mime = AUDIO_CODEC_MIME[codecName];
    if (!mime) {
      this.unavailable = true;
      this.onError(`不支持的音频编码: ${codecName}`);
      return;
    }
    this.stop();
    const ctx = new AudioContext({ sampleRate });
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = 1;
    this.gain.connect(ctx.destination);
    this.nextStartTime = ctx.currentTime + 0.08;

    this.decoder = new AudioDecoder({
      output: (data) => this.play(data),
      error: (e) => this.onError(`AudioDecoder error: ${e.message}`),
    });
    try {
      this.decoder.configure({
        codec: mime,
        sampleRate,
        numberOfChannels: channels,
        description,
      });
      this.started = true;
    } catch (e) {
      this.unavailable = true;
      this.onError(`AudioDecoder.configure failed: ${(e as Error).message}`);
    }
  }

  push(pts: number, data: Uint8Array): void {
    if (!this.decoder || this.decoder.state !== 'configured') return;
    try {
      this.decoder.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: pts,
          data,
        }),
      );
    } catch (e) {
      this.onError(`audio decode failed: ${(e as Error).message}`);
    }
  }

  private play(data: AudioData): void {
    const ctx = this.ctx;
    const gain = this.gain;
    if (!ctx || !gain) {
      data.close();
      return;
    }
    try {
      const frames = data.numberOfFrames;
      const channels = data.numberOfChannels;
      const interleaved = new Float32Array(frames * channels);
      data.copyTo(interleaved, { planeIndex: 0, format: 'f32' });
      const buffer = ctx.createBuffer(channels, frames, data.sampleRate);
      for (let c = 0; c < channels; c++) {
        const channel = buffer.getChannelData(c);
        for (let i = 0; i < frames; i++) {
          channel[i] = interleaved[i * channels + c];
        }
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      const startAt = Math.max(this.nextStartTime, ctx.currentTime);
      source.start(startAt);
      this.nextStartTime = startAt + buffer.duration;
    } catch (e) {
      this.onError(`audio playback failed: ${(e as Error).message}`);
    } finally {
      data.close();
    }
  }

  setVolume(value: number): void {
    if (this.gain) this.gain.gain.value = value;
  }

  stop(): void {
    this.started = false;
    if (this.decoder && this.decoder.state !== 'closed') {
      try {
        this.decoder.close();
      } catch {
        /* ignore */
      }
    }
    this.decoder = undefined;
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined);
      this.ctx = undefined;
      this.gain = undefined;
    }
  }
}
