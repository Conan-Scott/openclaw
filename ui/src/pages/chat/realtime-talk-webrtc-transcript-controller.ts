import { formatUiError } from "../../lib/format-error.ts";
import {
  OpenAiRealtimeTranscriptOwner,
  type OpenAiRealtimeTranscriptAction,
} from "./realtime-talk-openai-transcript-owner.ts";
import {
  createRealtimeTalkEventEmitter,
  type RealtimeTalkTransportContext,
} from "./realtime-talk-shared.ts";
import type { RealtimeServerEvent } from "./realtime-talk-webrtc-support.ts";

const MAX_PROVIDER_ERROR_DETAIL_BYTES = 1_024;
const utf8Encoder = new TextEncoder();

type RealtimeTalkWebRtcTranscriptControllerOptions = {
  ctx: RealtimeTalkTransportContext;
  emitTalkEvent: ReturnType<typeof createRealtimeTalkEventEmitter>;
  isClosed: () => boolean;
  onFatal: (detail: string) => void;
  onSettlementChange: () => void;
  onUserFinal: (text: string) => void;
};

export class RealtimeTalkWebRtcTranscriptController {
  private readonly owner = new OpenAiRealtimeTranscriptOwner();

  constructor(private readonly options: RealtimeTalkWebRtcTranscriptControllerOptions) {}

  get pendingCount(): number {
    return this.owner.pendingCount;
  }

  reset(): void {
    this.owner.reset();
  }

  assertSettled(): void {
    this.owner.assertSettled();
  }

  complete(itemId: unknown, transcript: unknown): void {
    this.apply(() => this.owner.complete(itemId, transcript));
  }

  fail(itemId: unknown, detail: string): void {
    this.apply(() => this.owner.fail(itemId, detail));
  }

  emitUserFinal(text: string, itemId?: string): void {
    this.emitActions([{ role: "user", text, itemId }]);
  }

  commit(itemId: unknown): void {
    let actions: OpenAiRealtimeTranscriptAction[];
    try {
      actions = this.owner.commit(itemId);
    } catch (error) {
      this.options.onFatal(formatUiError(error));
      return;
    }
    try {
      this.options.emitTalkEvent({
        type: "input.audio.committed",
        final: true,
        ...(typeof itemId === "string" ? { itemId } : {}),
      });
    } catch (error) {
      console.warn("Realtime Talk input audit callback failed", error);
    }
    if (this.options.isClosed()) {
      return;
    }
    this.emitActions(actions);
    this.options.onSettlementChange();
  }

  emitAssistant(event: RealtimeServerEvent, final: boolean, ordered: boolean): void {
    const text = final ? (event.transcript ?? event.text) : event.delta;
    if (!text) {
      return;
    }
    if (final && ordered) {
      this.apply(() => this.owner.assistant(text, event.item_id));
      return;
    }
    this.options.ctx.callbacks.onTranscript?.({ role: "assistant", text, final });
    if (this.options.isClosed()) {
      return;
    }
    this.options.emitTalkEvent({
      type: final ? "output.text.done" : "output.text.delta",
      final,
      itemId: event.item_id,
      payload: { text },
    });
  }

  emitFrameless(
    role: "user" | "assistant",
    text: string | undefined,
    final: boolean,
    itemId?: string,
  ): void {
    if (!text) {
      return;
    }
    this.options.ctx.callbacks.onTranscript?.({ role, text, final });
    if (this.options.isClosed()) {
      return;
    }
    const type =
      role === "user"
        ? final
          ? "transcript.done"
          : "transcript.delta"
        : final
          ? "output.text.done"
          : "output.text.delta";
    this.options.emitTalkEvent({ type, final, itemId, payload: { role, text } });
  }

  extractErrorDetail(error: unknown): string {
    if (!error || typeof error !== "object") {
      return "Realtime provider error";
    }
    // SAFETY: the object guard above establishes an indexable provider error record.
    const record = error as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message.trim() : "";
    const code = typeof record.code === "string" ? record.code.trim() : "";
    const type = typeof record.type === "string" ? record.type.trim() : "";
    return this.clampProviderDetail(message || code || type || "Realtime provider error");
  }

  private apply(operation: () => OpenAiRealtimeTranscriptAction[]): void {
    let actions: OpenAiRealtimeTranscriptAction[];
    try {
      actions = operation();
    } catch (error) {
      this.options.onFatal(formatUiError(error));
      return;
    }
    this.emitActions(actions);
    this.options.onSettlementChange();
  }

  private emitActions(actions: OpenAiRealtimeTranscriptAction[]): void {
    for (const action of actions) {
      try {
        this.options.ctx.callbacks.onTranscript?.({
          role: action.role,
          text: action.text,
          final: true,
        });
      } catch (error) {
        console.warn("Realtime Talk transcript callback failed", error);
      }
      if (this.options.isClosed()) {
        return;
      }
      if (action.role === "user") {
        try {
          this.options.emitTalkEvent({
            type: "transcript.done",
            final: true,
            itemId: action.itemId,
            payload: { role: "user", text: action.text },
          });
        } catch (error) {
          console.warn("Realtime Talk transcript audit callback failed", error);
        }
        this.options.onUserFinal(action.text);
      } else {
        try {
          this.options.emitTalkEvent({
            type: "output.text.done",
            final: true,
            itemId: action.itemId,
            payload: { text: action.text },
          });
        } catch (error) {
          console.warn("Realtime Talk output audit callback failed", error);
        }
      }
    }
  }

  private clampProviderDetail(detail: string): string {
    if (utf8Encoder.encode(detail).byteLength <= MAX_PROVIDER_ERROR_DETAIL_BYTES) {
      return detail;
    }
    let bounded = "";
    for (const character of detail) {
      if (
        utf8Encoder.encode(`${bounded}${character}…`).byteLength > MAX_PROVIDER_ERROR_DETAIL_BYTES
      ) {
        break;
      }
      bounded += character;
    }
    return `${bounded}…`;
  }
}
