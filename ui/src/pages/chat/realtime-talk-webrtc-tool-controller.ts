import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME } from "../../../../src/talk/describe-view-tool.js";
import { formatUiError } from "../../lib/format-error.ts";
import type { RealtimeTalkCameraController } from "./realtime-talk-camera-controller.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  type RealtimeTalkEventInput,
  type RealtimeTalkTransportContext,
  shouldAutoControlRealtimeVoiceAgentText,
  steerRealtimeTalkActiveConsult,
  submitRealtimeTalkAgentControl,
  submitRealtimeTalkConsult,
} from "./realtime-talk-shared.ts";
import { captureRealtimeTalkVideoFrame } from "./realtime-talk-video.ts";
import {
  RealtimeTalkResponseOutcomeOwner,
  realtimeTalkDataChannelMaxMessageSize,
  realtimeTalkImageEvent,
  type RealtimeServerEvent,
} from "./realtime-talk-webrtc-support.ts";

type CompletedToolCall = {
  itemId?: string;
  name: string;
  callId: string;
  args: string;
};

type RealtimeTalkWebRtcToolControllerOptions = {
  ctx: RealtimeTalkTransportContext;
  camera: RealtimeTalkCameraController;
  emitTalkEvent: (input: RealtimeTalkEventInput) => void;
  send: (event: unknown) => void;
  getPeer: () => RTCPeerConnection | null;
  isClosed: () => boolean;
  isDraining: () => boolean;
  failConnection: (detail: string) => void;
};

const MAX_REALTIME_TOOL_ARGUMENT_BYTES = 256_000;
// Realtime defines no replay window, so evicting terminal IDs could execute a
// very late duplicate. End an extreme session instead of weakening dedupe.
const MAX_COMPLETED_TOOL_CALL_IDS = 1_024;
const utf8Encoder = new TextEncoder();

/**
 * Owns OpenAI Realtime response sequencing and executable provider tool calls.
 *
 * The WebRTC transport remains responsible for connection and transcript
 * lifecycle. This controller deliberately receives those lifecycle facts as
 * callbacks so late asynchronous tool work cannot outlive Stop or transcript
 * drain ownership.
 */
export class RealtimeTalkWebRtcToolController {
  private responseActive = false;
  private responseCreateInFlight = false;
  private responseCreatePending = false;
  private readonly responseOutcomes = new RealtimeTalkResponseOutcomeOwner(
    MAX_COMPLETED_TOOL_CALL_IDS,
  );
  private readonly completedToolCallIds = new Set<string>();
  private readonly consultAbortControllers = new Set<AbortController>();
  private readonly toolAbortControllers = new Set<AbortController>();

  constructor(private readonly options: RealtimeTalkWebRtcToolControllerOptions) {}

  handleResponseCreated(event: RealtimeServerEvent): void {
    if (this.isUnavailable()) {
      return;
    }
    this.responseActive = true;
    this.responseCreateInFlight = false;
    this.responseOutcomes.start(event.response?.id);
    this.options.ctx.callbacks.onStatus?.("thinking", "Generating response");
  }

  handleResponseTerminal(event: RealtimeServerEvent): void {
    const terminal = this.responseOutcomes.finish(event);
    if (!terminal) {
      return;
    }
    const { outcome } = terminal;
    try {
      if (outcome.status === "completed") {
        this.handleCompletedResponse(event);
        if (this.options.isClosed()) {
          return;
        }
      }
      if (outcome.status === "failed" || outcome.status === "incomplete") {
        this.options.ctx.callbacks.onStatus?.("error", outcome.message);
        this.options.emitTalkEvent({
          type: "session.error",
          final: true,
          payload: outcome,
        });
      } else {
        this.options.ctx.callbacks.onStatus?.(
          "listening",
          outcome.status === "cancelled" ? "Response cancelled" : undefined,
        );
      }
      this.options.emitTalkEvent({
        type: outcome.status === "cancelled" ? "turn.cancelled" : "turn.ended",
        final: true,
        payload: outcome,
      });
    } finally {
      if (terminal.overflow) {
        this.options.failConnection("Realtime response session limit exceeded");
      }
      this.responseActive = false;
      this.responseCreateInFlight = false;
      this.flushPendingResponseCreate();
    }
  }

  handleProviderError(): void {
    this.responseCreateInFlight = false;
  }

  handleUserTranscript(text: string): void {
    if (
      this.isUnavailable() ||
      this.consultAbortControllers.size === 0 ||
      !shouldAutoControlRealtimeVoiceAgentText(text)
    ) {
      return;
    }
    void steerRealtimeTalkActiveConsult({
      ctx: this.options.ctx,
      text,
      emitTalkEvent: this.options.emitTalkEvent,
      onControlResult: (result) => this.interruptSuppressedControlResponse(result),
      speakControlResult: (message) => this.sendControlSpeechMessage(message),
      suppressSpeechForModes: ["cancel"],
    });
  }

  cancelResponseBestEffort(): void {
    try {
      this.options.send({ type: "response.cancel" });
    } catch (error) {
      console.warn("Realtime Talk response cancellation failed", error);
    }
  }

  beginDrain(): void {
    this.abortTools("Realtime Talk tool cancellation failed during transcript drain");
    this.responseCreatePending = false;
    if (this.responseActive) {
      this.cancelResponseBestEffort();
    }
  }

  reset(): void {
    this.abortTools();
    this.completedToolCallIds.clear();
    this.responseOutcomes.reset();
    this.responseActive = false;
    this.responseCreateInFlight = false;
    this.responseCreatePending = false;
  }

  private handleCompletedResponse(event: RealtimeServerEvent): void {
    const response: unknown = event.response;
    if (!isRecord(response) || response.status !== "completed" || !Array.isArray(response.output)) {
      return;
    }
    for (const output of response.output) {
      if (
        !isRecord(output) ||
        output.type !== "function_call" ||
        (output.status !== undefined && output.status !== "completed")
      ) {
        continue;
      }
      const itemId = typeof output.id === "string" ? output.id.trim() || undefined : undefined;
      const callId = typeof output.call_id === "string" ? output.call_id.trim() : "";
      const name = typeof output.name === "string" ? output.name.trim() : "";
      const args = typeof output.arguments === "string" ? output.arguments : "";
      if (!callId || !name || !args.trim()) {
        continue;
      }
      if (
        name !== REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME &&
        name !== REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME &&
        name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME
      ) {
        continue;
      }
      if (this.completedToolCallIds.has(callId)) {
        continue;
      }
      if (this.completedToolCallIds.size >= MAX_COMPLETED_TOOL_CALL_IDS) {
        this.options.failConnection("Realtime tool-call session limit exceeded");
        return;
      }
      this.completedToolCallIds.add(callId);
      if (utf8Encoder.encode(args).byteLength > MAX_REALTIME_TOOL_ARGUMENT_BYTES) {
        const message = "Realtime tool arguments exceed the 256000-byte UTF-8 limit";
        this.submitToolResult(callId, { error: message });
        this.options.emitTalkEvent({
          type: "tool.error",
          callId,
          itemId,
          final: true,
          payload: { name, message },
        });
        continue;
      }
      void this.handleToolCall({ itemId, callId, name, args }).catch((error: unknown) => {
        this.reportToolResultSubmissionError(error);
      });
    }
  }

  private async handleToolCall(call: CompletedToolCall): Promise<void> {
    if (this.isUnavailable()) {
      return;
    }
    const { itemId, callId, name, args } = call;
    const abortController = new AbortController();
    this.toolAbortControllers.add(abortController);
    try {
      if (name === REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME) {
        await submitRealtimeTalkAgentControl({
          ctx: this.options.ctx,
          callId,
          args,
          signal: abortController.signal,
          emitTalkEvent: this.options.emitTalkEvent,
          submit: (toolCallId, result) => this.submitToolResult(toolCallId, result),
        });
        return;
      }
      if (name === REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME) {
        await this.handleDescribeViewToolCall(callId, itemId, abortController.signal);
        return;
      }
      if (name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
        return;
      }
      this.options.emitTalkEvent({
        type: "tool.call",
        callId,
        itemId,
        payload: { name, args },
      });
      this.consultAbortControllers.add(abortController);
      await submitRealtimeTalkConsult({
        ctx: this.options.ctx,
        callId,
        args,
        signal: abortController.signal,
        emitTalkEvent: this.options.emitTalkEvent,
        submit: (toolCallId, result) => this.submitToolResult(toolCallId, result),
      });
    } finally {
      this.consultAbortControllers.delete(abortController);
      this.toolAbortControllers.delete(abortController);
    }
  }

  private async handleDescribeViewToolCall(
    callId: string,
    itemId: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    this.options.emitTalkEvent({
      type: "tool.call",
      callId,
      itemId,
      payload: { name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME },
    });
    if (!this.options.camera.hasLiveTrack()) {
      this.submitToolResult(callId, { ok: false, error: "camera is off" });
      this.options.emitTalkEvent({
        type: "tool.error",
        callId,
        itemId,
        final: true,
        payload: { name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME, message: "camera is off" },
      });
      return;
    }
    try {
      const frame = await captureRealtimeTalkVideoFrame(
        this.options.camera.video,
        realtimeTalkDataChannelMaxMessageSize(this.options.getPeer()),
        realtimeTalkImageEvent,
      );
      if (signal.aborted || this.isUnavailable()) {
        return;
      }
      this.options.send(realtimeTalkImageEvent(frame));
      this.submitToolResult(callId, { ok: true, frameAttached: true });
      this.options.emitTalkEvent({
        type: "tool.result",
        callId,
        itemId,
        final: true,
        payload: { name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME, frameAttached: true },
      });
    } catch (error) {
      if (signal.aborted || this.isUnavailable()) {
        return;
      }
      const message = formatUiError(error);
      this.submitToolResult(callId, { ok: false, error: message });
      this.options.emitTalkEvent({
        type: "tool.error",
        callId,
        itemId,
        final: true,
        payload: { name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME, message },
      });
    }
  }

  private submitToolResult(callId: string, result: unknown): void {
    if (this.isUnavailable()) {
      return;
    }
    this.options.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
    this.requestResponseCreate();
  }

  private reportToolResultSubmissionError(error: unknown): void {
    if (this.isUnavailable()) {
      return;
    }
    this.options.ctx.callbacks.onStatus?.("error", formatUiError(error));
  }

  private sendControlSpeechMessage(message: string): void {
    if (this.isUnavailable()) {
      return;
    }
    if (this.responseActive) {
      this.cancelResponseBestEffort();
    }
    this.options.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: message }],
      },
    });
    this.requestResponseCreate();
  }

  private interruptSuppressedControlResponse(result: unknown): void {
    if (this.isUnavailable() || !this.responseActive || !isRecord(result)) {
      return;
    }
    if (
      result.ok === true &&
      (result.mode === "cancel" || (result.suppress === true && result.mode !== "steer"))
    ) {
      this.cancelResponseBestEffort();
    }
  }

  private requestResponseCreate(): void {
    if (this.isUnavailable()) {
      return;
    }
    if (this.responseActive || this.responseCreateInFlight) {
      this.responseCreatePending = true;
      return;
    }
    this.responseCreatePending = false;
    this.responseCreateInFlight = true;
    this.options.send({ type: "response.create" });
  }

  private flushPendingResponseCreate(): void {
    if (!this.responseCreatePending) {
      return;
    }
    this.responseCreatePending = false;
    this.requestResponseCreate();
  }

  private abortTools(warning?: string): void {
    for (const controller of this.toolAbortControllers) {
      try {
        controller.abort();
      } catch (error) {
        if (warning) {
          console.warn(warning, error);
        }
      }
    }
    this.consultAbortControllers.clear();
    this.toolAbortControllers.clear();
  }

  private isUnavailable(): boolean {
    return this.options.isClosed() || this.options.isDraining();
  }
}
