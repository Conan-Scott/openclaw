import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { RealtimeTalkWebRtcSdpSessionResult } from "./realtime-talk-shared.ts";
import type { RealtimeServerEvent } from "./realtime-talk-webrtc-support.ts";

const MAX_PROVISIONAL_EVENTS = 32;
const MAX_PROVISIONAL_EVENT_BYTES = 256 * 1_024;
const SESSION_READY_TIMEOUT_MS = 10_000;
const encoder = new TextEncoder();

export class RealtimeTalkWebRtcReadinessOwner {
  private channelOpen = false;
  private providerReady = false;
  private terminalError: Error | null = null;
  private resolve: (() => void) | null = null;
  private reject: ((error: Error) => void) | null = null;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private readonly buffered: RealtimeServerEvent[] = [];
  private bufferedBytes = 0;

  constructor(private readonly protocol: RealtimeTalkWebRtcSdpSessionResult["transcriptProtocol"]) {
    this.reset();
  }

  reset(): void {
    this.cancel(new Error("Realtime Talk provider readiness was reset"));
    this.channelOpen = false;
    this.providerReady = this.protocol === undefined;
    this.terminalError = null;
    this.buffered.length = 0;
    this.bufferedBytes = 0;
  }

  markChannelOpen(): void {
    this.channelOpen = true;
    this.maybeResolve();
  }

  get isReady(): boolean {
    return this.terminalError === null && this.channelOpen && this.providerReady;
  }

  wait(): Promise<void> {
    if (this.terminalError) {
      return Promise.reject(this.terminalError);
    }
    if (this.isReady) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.timer = globalThis.setTimeout(() => {
        this.fail(new Error("Realtime provider did not confirm transcript readiness"));
      }, SESSION_READY_TIMEOUT_MS);
      this.maybeResolve();
    });
  }

  consumeReadinessEvent(
    event: RealtimeServerEvent,
    extractErrorDetail: (error: unknown) => string,
  ): boolean {
    if (this.protocol === "openai-frameless-turns" && event.type === "session.started") {
      this.providerReady = true;
      this.maybeResolve();
      return true;
    }
    if (
      this.protocol === "openai-ga-items" &&
      (event.type === "session.created" || event.type === "session.updated")
    ) {
      const session = isRecord(event.session) ? event.session : undefined;
      const audio = session && isRecord(session.audio) ? session.audio : undefined;
      const input = audio && isRecord(audio.input) ? audio.input : undefined;
      const transcription =
        input && isRecord(input.transcription) ? input.transcription : undefined;
      if (typeof transcription?.model === "string" && transcription.model.trim()) {
        this.providerReady = true;
        this.maybeResolve();
      } else if (event.type === "session.updated" || this.providerReady) {
        this.providerReady = false;
        this.fail(new Error("Realtime provider did not enable input transcription"));
      }
      return true;
    }
    if (event.type === "error") {
      this.fail(new Error(extractErrorDetail(event.error)));
      return true;
    }
    return false;
  }

  buffer(event: RealtimeServerEvent): void {
    const bytes = encoder.encode(JSON.stringify(event)).byteLength;
    if (
      this.buffered.length >= MAX_PROVISIONAL_EVENTS ||
      bytes > MAX_PROVISIONAL_EVENT_BYTES - this.bufferedBytes
    ) {
      throw new Error("Realtime provider sent too many events before transcript readiness");
    }
    this.buffered.push(event);
    this.bufferedBytes += bytes;
  }

  takeBuffered(): RealtimeServerEvent[] {
    const events = this.buffered.splice(0);
    this.bufferedBytes = 0;
    return events;
  }

  cancel(error: Error): void {
    this.fail(error);
  }

  private maybeResolve(): void {
    if (!this.isReady || !this.resolve) {
      return;
    }
    const resolve = this.resolve;
    this.clearWait();
    resolve();
  }

  private fail(error: Error): void {
    this.terminalError = error;
    const reject = this.reject;
    this.clearWait();
    reject?.(error);
  }

  private clearWait(): void {
    if (this.timer) {
      globalThis.clearTimeout(this.timer);
    }
    this.timer = null;
    this.resolve = null;
    this.reject = null;
  }
}
