// Control UI chat module implements realtime talk webrtc behavior.
import { formatUiError } from "../../lib/format-error.ts";
import { RealtimeTalkMediaStreamMeter } from "./realtime-talk-audio.ts";
import { RealtimeTalkCameraController } from "./realtime-talk-camera-controller.ts";
import { openRealtimeTalkCamera, openRealtimeTalkInput } from "./realtime-talk-input.ts";
import {
  type RealtimeTalkWebRtcSdpSessionResult,
  createRealtimeTalkEventEmitter,
  type RealtimeTalkTransport,
  type RealtimeTalkTransportContext,
  type RealtimeTalkTransportStartResult,
} from "./realtime-talk-shared.ts";
import { RealtimeTalkWebRtcReadinessOwner } from "./realtime-talk-webrtc-readiness.ts";
import {
  RealtimeTalkWebRtcOfferExchange,
  type RealtimeServerEvent,
} from "./realtime-talk-webrtc-support.ts";
import { RealtimeTalkWebRtcToolController } from "./realtime-talk-webrtc-tool-controller.ts";
import { RealtimeTalkWebRtcTranscriptController } from "./realtime-talk-webrtc-transcript-controller.ts";
// Muting the browser track is synchronous, but provider VAD events already in
// flight can arrive afterward. Keep ownership alive through the effective VAD
// silence window plus network/event-loop delay before declaring quiescence.
const REALTIME_TRANSCRIPT_DRAIN_DELIVERY_MARGIN_MS = 1_000;
const REALTIME_TRANSCRIPT_DRAIN_MIN_GRACE_MS = 1_500;
const REALTIME_TRANSCRIPT_DRAIN_COMPLETION_TIMEOUT_MS = 10_000;
const MAX_REALTIME_TRANSCRIPT_SILENCE_MS = 60_000;
const cancelledSetup = Symbol("cancelledSetup");

export class WebRtcSdpRealtimeTalkTransport implements RealtimeTalkTransport {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private media: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private inputMeter: RealtimeTalkMediaStreamMeter | null = null;
  private closed = false;
  private readonly offerExchange = new RealtimeTalkWebRtcOfferExchange();
  private mediaSetupController: AbortController | null = null;
  private readonly camera: RealtimeTalkCameraController;
  private readonly emitTalkEvent: ReturnType<typeof createRealtimeTalkEventEmitter>;
  private readonly tools: RealtimeTalkWebRtcToolController;
  private starting = false;
  private startupError: Error | null = null;
  private activated = false;
  private readonly readiness: RealtimeTalkWebRtcReadinessOwner;
  private readonly transcripts: RealtimeTalkWebRtcTranscriptController;
  private speechPending = false;
  private draining = false;
  private drainPromise: Promise<void> | null = null;
  private drainResolve: (() => void) | null = null;
  private drainReject: ((error: Error) => void) | null = null;
  private drainGraceElapsed = false;
  private drainGraceTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private drainTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private readonly transcriptDrainGraceMs: number;

  constructor(
    private readonly session: RealtimeTalkWebRtcSdpSessionResult,
    private readonly ctx: RealtimeTalkTransportContext,
  ) {
    this.emitTalkEvent = createRealtimeTalkEventEmitter(ctx, session);
    this.camera = new RealtimeTalkCameraController({
      acquire: (deviceId, signal) => openRealtimeTalkCamera(deviceId, { signal }),
      getDeviceId: () => this.ctx.videoDeviceId,
      setDeviceId: (deviceId) => (this.ctx.videoDeviceId = deviceId),
      isClosed: () => this.closed,
      onStream: (stream) => this.ctx.callbacks.onVideoStream?.(stream),
    });
    this.tools = new RealtimeTalkWebRtcToolController({
      ctx,
      camera: this.camera,
      emitTalkEvent: this.emitTalkEvent,
      send: (event) => this.send(event),
      getPeer: () => this.peer,
      isClosed: () => this.closed,
      isDraining: () => this.draining,
      failConnection: (detail) => this.failConnection(detail),
    });
    this.readiness = new RealtimeTalkWebRtcReadinessOwner(session.transcriptProtocol);
    this.transcripts = new RealtimeTalkWebRtcTranscriptController({
      ctx,
      emitTalkEvent: this.emitTalkEvent,
      isClosed: () => this.closed,
      onFatal: (detail) => this.failTranscriptContinuity(detail),
      onSettlementChange: () => this.maybeResolveDrain(),
      onUserFinal: (text) => this.tools.handleUserTranscript(text),
    });
    const configuredSilenceMs = session.transcriptSilenceDurationMs ?? 500;
    if (
      !Number.isSafeInteger(configuredSilenceMs) ||
      configuredSilenceMs < 0 ||
      configuredSilenceMs > MAX_REALTIME_TRANSCRIPT_SILENCE_MS
    ) {
      throw new Error("Realtime Talk provider returned an unsupported transcript silence window");
    }
    this.transcriptDrainGraceMs = Math.max(
      REALTIME_TRANSCRIPT_DRAIN_MIN_GRACE_MS,
      configuredSilenceMs + REALTIME_TRANSCRIPT_DRAIN_DELIVERY_MARGIN_MS,
    );
  }

  async start(): Promise<RealtimeTalkTransportStartResult> {
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      throw new Error("Realtime Talk requires browser WebRTC and microphone access");
    }
    this.closed = false;
    this.starting = true;
    this.startupError = null;
    this.activated = false;
    this.readiness.reset();
    this.transcripts.reset();
    this.speechPending = false;
    this.draining = false;
    this.drainGraceElapsed = false;
    this.mediaSetupController?.abort();
    const peer = new RTCPeerConnection();
    this.peer = peer;
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    this.audio.muted = false;
    this.audio.setAttribute("playsinline", "");
    this.audio.style.display = "none";
    document.body.append(this.audio);
    peer.addEventListener("track", (event) => {
      const stream = event.streams[0];
      if (this.audio && stream) {
        this.audio.srcObject = stream;
        const audio = this.audio;
        const play = (reportError: boolean) => {
          if (this.audio !== audio || this.closed) {
            return;
          }
          void audio.play().catch((error: unknown) => {
            if (reportError && this.audio === audio && !this.closed) {
              this.ctx.callbacks.onStatus?.(
                "error",
                `Realtime audio playback failed: ${formatUiError(error)}`,
              );
            }
          });
        };
        play(!event.track.muted);
        // iOS can deliver the remote track muted until media starts flowing.
        // Retrying on unmute gives Safari a second chance to attach the live stream.
        event.track.addEventListener("unmute", () => play(true), { once: true });
      }
    });
    const mediaSetupController = new AbortController();
    this.mediaSetupController = mediaSetupController;
    let media: MediaStream | typeof cancelledSetup;
    try {
      media = await this.awaitSetupStep(
        peer,
        openRealtimeTalkInput(this.ctx.inputDeviceId, {
          signal: mediaSetupController.signal,
        }),
      );
    } finally {
      if (this.mediaSetupController === mediaSetupController) {
        this.mediaSetupController = null;
      }
    }
    if (media === cancelledSetup) {
      return this.cancelledStart();
    }
    if (!this.isCurrentPeer(peer)) {
      media.getTracks().forEach((track) => track.stop());
      return this.cancelledStart();
    }
    this.media = media;
    // Camera frames travel only as explicit describe_view data-channel events.
    // Keeping video off the peer prevents unintended continuous camera upload.
    for (const track of media.getAudioTracks()) {
      track.enabled = false;
      peer.addTrack(track, media);
    }
    const channel = peer.createDataChannel("oai-events");
    if (!this.isCurrentPeer(peer)) {
      channel.close();
      return this.cancelledStart();
    }
    this.channel = channel;
    channel.addEventListener("open", () => {
      this.readiness.markChannelOpen();
    });
    channel.addEventListener("message", (event) => this.handleRealtimeEvent(event.data));
    channel.addEventListener("close", () => this.failConnection("Realtime data channel closed"));
    channel.addEventListener("error", () => this.failConnection("Realtime data channel failed"));
    peer.addEventListener("connectionstatechange", () => {
      if (this.closed) {
        return;
      }
      if (this.peer?.connectionState === "failed" || this.peer?.connectionState === "closed") {
        this.failConnection("Realtime connection closed");
      }
    });

    const offer = await this.awaitSetupStep(peer, peer.createOffer());
    if (offer === cancelledSetup) {
      return this.cancelledStart();
    }
    if (!this.isCurrentPeer(peer)) {
      return this.cancelledStart();
    }
    const localDescriptionResult = await this.awaitSetupStep(peer, peer.setLocalDescription(offer));
    if (localDescriptionResult === cancelledSetup) {
      return this.cancelledStart();
    }
    if (!this.isCurrentPeer(peer)) {
      return this.cancelledStart();
    }
    const answerSdp = await this.offerExchange.readAnswer({
      session: this.session,
      offer,
      gatewayUrl: this.ctx.client.gatewayUrl,
      isCurrent: () => this.isCurrentPeer(peer),
    });
    if (answerSdp === undefined) {
      return this.cancelledStart();
    }
    if (!this.isCurrentPeer(peer)) {
      return this.cancelledStart();
    }
    const remoteDescriptionResult = await this.awaitSetupStep(
      peer,
      peer.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      }),
    );
    if (remoteDescriptionResult === cancelledSetup || !this.isCurrentPeer(peer)) {
      return this.cancelledStart();
    }
    let readinessResult: void | typeof cancelledSetup;
    try {
      readinessResult = await this.awaitSetupStep(peer, this.readiness.wait());
    } catch (error) {
      if (this.isCurrentPeer(peer)) {
        this.stop({ emitClosed: false });
      }
      throw error;
    }
    if (readinessResult === cancelledSetup || !this.isCurrentPeer(peer)) {
      return this.cancelledStart();
    }
    this.starting = false;
    return "ready";
  }

  activate(): void {
    if (this.closed) {
      throw new Error("Realtime Talk transport closed before activation");
    }
    if (this.activated) {
      return;
    }
    if (!this.readiness.isReady || !this.media) {
      throw new Error("Realtime Talk transport activated before transcript readiness");
    }
    try {
      this.activated = true;
      for (const track of this.media.getAudioTracks()) {
        track.enabled = true;
      }
      if (this.ctx.callbacks.onInputLevel) {
        this.inputMeter = new RealtimeTalkMediaStreamMeter(this.ctx.callbacks.onInputLevel);
        this.inputMeter.start(this.media);
      }
      this.ctx.callbacks.onStatus?.("listening");
      this.emitTalkEvent({ type: "session.ready" });
      const buffered = this.readiness.takeBuffered();
      for (const event of buffered) {
        if (this.closed) {
          break;
        }
        this.handleParsedRealtimeEvent(event);
      }
    } catch (error) {
      this.stop({ emitClosed: false });
      throw error;
    }
  }

  drain(): Promise<void> {
    if (this.closed || this.session.transcriptProtocol !== "openai-ga-items") {
      return Promise.resolve();
    }
    if (this.drainPromise) {
      return this.drainPromise;
    }
    this.draining = true;
    this.drainPromise = new Promise<void>((resolve, reject) => {
      this.drainResolve = resolve;
      this.drainReject = reject;
    });
    this.drainGraceElapsed = false;
    this.drainGraceTimer = globalThis.setTimeout(() => {
      this.drainGraceElapsed = true;
      this.maybeResolveDrain();
    }, this.transcriptDrainGraceMs);
    this.drainTimer = globalThis.setTimeout(() => {
      this.failTranscriptContinuity(
        "Realtime Talk timed out waiting for the final user transcription",
      );
    }, this.transcriptDrainGraceMs + REALTIME_TRANSCRIPT_DRAIN_COMPLETION_TIMEOUT_MS);

    try {
      for (const track of this.media?.getAudioTracks() ?? []) {
        track.enabled = false;
      }
    } catch (error) {
      console.warn("Realtime Talk input mute failed during transcript drain", error);
    }
    try {
      this.inputMeter?.stop();
    } catch (error) {
      console.warn("Realtime Talk input meter cleanup failed during transcript drain", error);
    }
    this.inputMeter = null;
    if (this.audio) {
      this.audio.muted = true;
      try {
        this.audio.pause();
      } catch (error) {
        console.warn("Realtime Talk output cleanup failed during transcript drain", error);
      }
    }
    try {
      this.camera.release();
    } catch (error) {
      console.warn("Realtime Talk camera cleanup failed during transcript drain", error);
    }
    this.tools.beginDrain();
    return this.drainPromise;
  }

  async setVideoEnabled(enabled: boolean): Promise<void> {
    await this.camera.setEnabled(enabled);
  }

  async switchCamera(videoDeviceId: string | undefined): Promise<void> {
    await this.camera.switchDevice(videoDeviceId);
  }

  private isCurrentPeer(peer: RTCPeerConnection): boolean {
    return !this.closed && this.peer === peer;
  }

  private cancelledStart(): RealtimeTalkTransportStartResult {
    const startupError = this.currentStartupError();
    if (startupError) {
      throw startupError;
    }
    return "cancelled";
  }

  private currentStartupError(): Error | null {
    return this.startupError;
  }

  private async awaitSetupStep<T>(
    peer: RTCPeerConnection,
    promise: Promise<T>,
  ): Promise<T | typeof cancelledSetup> {
    try {
      return await promise;
    } catch (error) {
      if (!this.isCurrentPeer(peer)) {
        return cancelledSetup;
      }
      throw error;
    }
  }

  stop(options?: { emitClosed?: boolean }): void {
    const emitClosed = !this.closed && options?.emitClosed !== false;
    this.closed = true;
    try {
      if (emitClosed) {
        this.emitTalkEvent({ type: "session.closed", final: true });
      }
    } finally {
      this.releaseResources();
    }
  }

  private releaseResources(): void {
    this.starting = false;
    this.activated = false;
    this.readiness.cancel(new Error("Realtime Talk stopped during provider setup"));
    this.rejectDrain(new Error("Realtime Talk stopped before transcript drain completed"));
    this.mediaSetupController?.abort();
    this.mediaSetupController = null;
    this.offerExchange.abort();
    this.channel?.close();
    this.channel = null;
    this.peer?.close();
    this.peer = null;
    this.media?.getTracks().forEach((track) => track.stop());
    this.media = null;
    this.camera.release();
    this.inputMeter?.stop();
    this.inputMeter = null;
    this.audio?.remove();
    this.audio = null;
    this.tools.reset();
    this.transcripts.reset();
    this.speechPending = false;
  }

  private failConnection(detail: string): void {
    if (this.closed) {
      return;
    }
    if (this.draining) {
      this.failTranscriptContinuity(detail);
      return;
    }
    const wasStarting = this.starting;
    try {
      if (!wasStarting) {
        this.ctx.callbacks.onStatus?.("error", detail);
      } else {
        this.startupError = new Error(detail);
      }
    } finally {
      // A terminal peer failure still owns browser media if status delivery fails.
      this.stop({ emitClosed: !wasStarting });
    }
  }

  private send(event: unknown): void {
    if (this.channel?.readyState === "open") {
      this.channel.send(JSON.stringify(event));
    }
  }

  private handleRealtimeEvent(data: unknown): void {
    if (this.closed) {
      return;
    }
    let event: RealtimeServerEvent;
    try {
      event = JSON.parse(String(data)) as RealtimeServerEvent;
    } catch {
      return;
    }
    if (!this.activated) {
      try {
        if (
          this.readiness.consumeReadinessEvent(event, (error) =>
            this.transcripts.extractErrorDetail(error),
          )
        ) {
          return;
        }
        this.readiness.buffer(event);
      } catch (error) {
        this.startupError = error instanceof Error ? error : new Error(String(error));
        this.readiness.cancel(this.startupError);
      }
      return;
    }
    this.handleParsedRealtimeEvent(event);
  }

  private handleParsedRealtimeEvent(event: RealtimeServerEvent): void {
    if (
      this.session.transcriptProtocol === "openai-ga-items" &&
      (event.type === "session.created" || event.type === "session.updated")
    ) {
      this.readiness.consumeReadinessEvent(event, (error) =>
        this.transcripts.extractErrorDetail(error),
      );
      if (!this.readiness.isReady) {
        this.failTranscriptContinuity("Realtime provider disabled input transcription");
      }
      return;
    }
    if (this.draining) {
      this.handleDrainingRealtimeEvent(event);
      return;
    }
    switch (event.type) {
      case "input_transcript.added":
        this.transcripts.emitFrameless("user", event.item?.text, false, event.item?.id);
        return;
      case "output_transcript.added":
        this.transcripts.emitFrameless("assistant", event.item?.text, false, event.item?.id);
        return;
      case "turn.done": {
        const role = event.turn?.role;
        if (role === "user" || role === "assistant") {
          this.transcripts.emitFrameless(role, event.turn?.transcript, true, event.turn?.id);
          if (this.closed) {
            return;
          }
          if (role === "assistant") {
            this.ctx.callbacks.onStatus?.("listening");
            this.emitTalkEvent({
              type: "turn.ended",
              final: true,
              payload: { status: "completed" },
            });
          }
        }
        return;
      }
      case "conversation.item.input_audio_transcription.completed":
        if (this.session.transcriptProtocol !== "openai-ga-items") {
          const text = typeof event.transcript === "string" ? event.transcript.trim() : "";
          if (!text) {
            this.failTranscriptContinuity("Realtime user transcription was empty");
            return;
          }
          this.transcripts.emitUserFinal(text, event.item_id);
          return;
        }
        this.transcripts.complete(event.item_id, event.transcript);
        return;
      case "conversation.item.input_audio_transcription.failed":
        this.transcripts.fail(event.item_id, this.transcripts.extractErrorDetail(event.error));
        return;
      case "conversation.output_transcript.delta":
      case "response.output_text.delta":
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        this.transcripts.emitAssistant(event, false, false);
        return;
      case "response.output_text.done":
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done":
        this.transcripts.emitAssistant(
          event,
          true,
          this.session.transcriptProtocol === "openai-ga-items",
        );
        break;
      case "response.function_call_arguments.delta":
      case "response.function_call_arguments.done":
        // Tool argument events are provisional and can also arrive for interrupted
        // responses. Only the completed response owns executable calls.
        break;
      case "input_audio_buffer.speech_started":
        this.speechPending = true;
        this.ctx.callbacks.onStatus?.("listening", "Speech detected");
        this.emitTalkEvent({ type: "turn.started", payload: { source: event.type } });
        return;
      case "input_audio_buffer.speech_stopped":
        this.ctx.callbacks.onStatus?.("thinking", "Processing speech");
        return;
      case "input_audio_buffer.committed":
        this.commitTranscriptItem(event.item_id);
        return;
      case "response.created":
        this.tools.handleResponseCreated(event);
        return;
      case "response.cancelled":
      case "response.done":
        this.tools.handleResponseTerminal(event);
        return;
      case "error":
        this.tools.handleProviderError();
        this.ctx.callbacks.onStatus?.("error", this.transcripts.extractErrorDetail(event.error));
        this.emitTalkEvent({
          type: "session.error",
          final: true,
          payload: { message: this.transcripts.extractErrorDetail(event.error) },
        });

      default:
    }
  }

  private handleDrainingRealtimeEvent(event: RealtimeServerEvent): void {
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        this.speechPending = true;
        break;
      case "input_audio_buffer.speech_stopped":
        return;
      case "input_audio_buffer.committed":
        this.commitTranscriptItem(event.item_id);
        return;
      case "conversation.item.input_audio_transcription.completed":
        this.transcripts.complete(event.item_id, event.transcript);
        return;
      case "conversation.item.input_audio_transcription.failed":
        this.transcripts.fail(event.item_id, this.transcripts.extractErrorDetail(event.error));
        return;
      case "response.created":
        this.tools.cancelResponseBestEffort();
        break;
      case "error":
        // `response.cancel` races can produce benign provider errors while
        // the user transcript still settles. Explicit transcription failures,
        // connection loss, and the bounded drain timeout own continuity.
        break;
      default:
        // Stop means stop: late provider output, tools, and status events must
        // not execute work or resurrect the UI while transcript ownership drains.
        break;
    }
  }

  private commitTranscriptItem(itemId: unknown): void {
    this.speechPending = false;
    this.transcripts.commit(itemId);
  }

  private failTranscriptContinuity(detail: string): void {
    if (this.closed) {
      return;
    }
    const message = detail || "Realtime user transcription failed";
    this.rejectDrain(new Error(message));
    try {
      try {
        this.ctx.callbacks.onStatus?.("error", message);
      } catch (error) {
        console.warn("Realtime Talk status callback failed during transcript shutdown", error);
      }
      try {
        this.emitTalkEvent({
          type: "session.error",
          final: true,
          payload: { message },
        });
      } catch (error) {
        console.warn("Realtime Talk event callback failed during transcript shutdown", error);
      }
      try {
        this.ctx.callbacks.onFatalError?.(message);
      } catch (error) {
        console.warn("Realtime Talk fatal callback failed during transcript shutdown", error);
      }
    } finally {
      if (!this.closed) {
        this.stop();
      }
    }
  }

  private maybeResolveDrain(): void {
    if (
      !this.draining ||
      !this.drainGraceElapsed ||
      this.speechPending ||
      this.transcripts.pendingCount > 0
    ) {
      return;
    }
    try {
      this.transcripts.assertSettled();
    } catch (error) {
      this.rejectDrain(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const resolve = this.drainResolve;
    this.clearDrainWait();
    this.draining = false;
    resolve?.();
  }

  private rejectDrain(error: Error): void {
    const reject = this.drainReject;
    this.clearDrainWait();
    this.draining = false;
    reject?.(error);
  }

  private clearDrainWait(): void {
    if (this.drainGraceTimer) {
      globalThis.clearTimeout(this.drainGraceTimer);
    }
    if (this.drainTimer) {
      globalThis.clearTimeout(this.drainTimer);
    }
    this.drainGraceTimer = null;
    this.drainTimer = null;
    this.drainPromise = null;
    this.drainResolve = null;
    this.drainReject = null;
    this.drainGraceElapsed = false;
  }
}
