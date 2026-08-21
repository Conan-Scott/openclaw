// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  type RealtimeTalkWebRtcSdpSessionResult,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
} from "./realtime-talk-shared.ts";
import { WebRtcSdpRealtimeTalkTransport } from "./realtime-talk-webrtc.ts";

let getUserMedia: ReturnType<typeof vi.fn>;
let stopInputTrack: ReturnType<typeof vi.fn>;
let inputTrack: MediaStreamTrack;

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = "closed";
  });
}

class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];
  static autoSignalReady = true;

  connectionState: RTCPeerConnectionState = "new";
  readonly channel = new FakeDataChannel();
  readonly addTrack = vi.fn();
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;

  constructor() {
    super();
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(): RTCDataChannel {
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "offer-sdp" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
    if (FakePeerConnection.autoSignalReady) {
      this.channel.dispatchEvent(new Event("open"));
      dispatchRealtimeEvent(this, {
        type: "session.created",
        session: {
          audio: {
            input: {
              transcription: { model: "gpt-4o-mini-transcribe" },
            },
          },
        },
      });
    }
  }

  close(): void {
    this.connectionState = "closed";
  }
}

function requireTalkEvent(
  onTalkEvent: ReturnType<typeof vi.fn>,
  index: number,
): Record<string, unknown> {
  const call = onTalkEvent.mock.calls[index];
  if (!call) {
    throw new Error(`expected talk event at index ${index}`);
  }
  const [event] = call;
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error(`expected talk event record at index ${index}`);
  }
  return event as Record<string, unknown>;
}

function stubAnswerSdpFetch(): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch);
}

function createOpenAiTransport(
  client: Record<string, unknown> = {},
  callbacks: Record<string, unknown> = {},
  inputDeviceId?: string,
  sessionOverrides: Partial<RealtimeTalkWebRtcSdpSessionResult> = {},
): WebRtcSdpRealtimeTalkTransport {
  return new WebRtcSdpRealtimeTalkTransport(
    {
      provider: "openai",
      transport: "webrtc",
      clientSecret: "client-secret-123",
      transcriptProtocol: "openai-ga-items",
      ...sessionOverrides,
    },
    {
      client: client as never,
      sessionKey: "main",
      callbacks: callbacks as never,
      inputDeviceId,
    },
  );
}

async function startAndActivate(transport: WebRtcSdpRealtimeTalkTransport): Promise<void> {
  await transport.start();
  transport.activate();
}

function dispatchRealtimeEvent(peer: FakePeerConnection | undefined, event: unknown): void {
  peer?.channel.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify(event),
    }),
  );
}

function dispatchConsultToolCall(peer: FakePeerConnection | undefined): void {
  dispatchRealtimeEvent(peer, {
    type: "response.done",
    response: {
      id: "response-1",
      status: "completed",
      output: [
        {
          type: "function_call",
          id: "item-1",
          status: "completed",
          call_id: "call-1",
          name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
          arguments: JSON.stringify({ question: "status?" }),
        },
      ],
    },
  });
}

function dispatchTranscription(peer: FakePeerConnection | undefined, transcript: string): void {
  dispatchCommitted(peer, "input-1");
  dispatchRealtimeEvent(peer, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "input-1",
    transcript,
  });
}

function dispatchCommitted(
  peer: FakePeerConnection | undefined,
  itemId: string,
  previousItemId?: string,
): void {
  dispatchRealtimeEvent(peer, {
    type: "input_audio_buffer.committed",
    item_id: itemId,
    previous_item_id: previousItemId ?? null,
  });
}

describe("WebRtcSdpRealtimeTalkTransport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.spyOn(globalThis.HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    FakePeerConnection.instances = [];
    FakePeerConnection.autoSignalReady = true;
    stopInputTrack = vi.fn();
    inputTrack = { enabled: true, stop: stopInputTrack } as unknown as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [inputTrack],
      getTracks: () => [inputTrack],
    } as unknown as MediaStream;
    getUserMedia = vi.fn(async () => stream);
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia,
      },
    });
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection as unknown as typeof RTCPeerConnection);
  });
  it("emits common Talk transcript events from the OpenAI data channel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch,
    );
    const onTranscript = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = new WebRtcSdpRealtimeTalkTransport(
      {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "client-secret-123",
      },
      {
        client: {} as never,
        sessionKey: "main",
        callbacks: { onTranscript, onTalkEvent },
      },
    );

    await startAndActivate(transport);
    const peer = FakePeerConnection.instances[0];
    peer?.channel.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "input-1",
          transcript: "hello",
        }),
      }),
    );
    peer?.channel.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "response.audio_transcript.done",
          item_id: "response-1",
          transcript: "hi there",
        }),
      }),
    );

    expect(onTranscript).toHaveBeenCalledWith({ role: "user", text: "hello", final: true });
    expect(onTranscript).toHaveBeenCalledWith({
      role: "assistant",
      text: "hi there",
      final: true,
    });
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "session.ready",
      "transcript.done",
      "output.text.done",
    ]);
    expect(onTalkEvent.mock.calls.map(([event]) => event.turnId)).toEqual([
      undefined,
      "turn-1",
      "turn-1",
    ]);
    const userTranscriptEvent = requireTalkEvent(onTalkEvent, 1);
    expect(userTranscriptEvent.itemId).toBe("input-1");
    expect(userTranscriptEvent.payload).toEqual({ role: "user", text: "hello" });
    expect(userTranscriptEvent.sessionId).toBe("main:openai:webrtc");
    expect(userTranscriptEvent.transport).toBe("webrtc");
    const assistantTranscriptEvent = requireTalkEvent(onTalkEvent, 2);
    expect(assistantTranscriptEvent.itemId).toBe("response-1");
    expect(assistantTranscriptEvent.payload).toEqual({ text: "hi there" });
    expect(assistantTranscriptEvent.sessionId).toBe("main:openai:webrtc");
    expect(assistantTranscriptEvent.transport).toBe("webrtc");
    transport.stop();
  });

  it("keeps microphone input provisional until the committed transport activates", async () => {
    FakePeerConnection.autoSignalReady = false;
    stubAnswerSdpFetch();
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = createOpenAiTransport({}, { onStatus, onTalkEvent });

    const start = transport.start();
    const peer = FakePeerConnection.instances[0];
    await waitForFast(() => expect(peer?.remoteDescription).not.toBeNull());
    await Promise.resolve();
    expect(inputTrack.enabled).toBe(false);
    await expect(Promise.race([start, Promise.resolve("pending")])).resolves.toBe("pending");

    peer?.channel.dispatchEvent(new Event("open"));
    await expect(Promise.race([start, Promise.resolve("pending")])).resolves.toBe("pending");
    dispatchRealtimeEvent(peer, {
      type: "session.created",
      session: {
        audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" } } },
      },
    });
    await expect(start).resolves.toBe("ready");
    expect(onStatus).not.toHaveBeenCalledWith("listening");
    expect(onTalkEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.ready" }),
    );

    (transport as unknown as { activate?: () => void }).activate?.();

    expect(inputTrack.enabled).toBe(true);
    expect(onStatus).toHaveBeenCalledWith("listening");
    expect(onTalkEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "session.ready" }));
    transport.stop();
  });

  it("buffers provider transcript events until outer ownership activates", async () => {
    FakePeerConnection.autoSignalReady = false;
    stubAnswerSdpFetch();
    const onTranscript = vi.fn();
    const transport = createOpenAiTransport({}, { onTranscript });

    const start = transport.start();
    const peer = FakePeerConnection.instances[0];
    await waitForFast(() => expect(peer?.remoteDescription).not.toBeNull());
    peer?.channel.dispatchEvent(new Event("open"));
    dispatchRealtimeEvent(peer, {
      type: "session.created",
      session: {
        audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" } } },
      },
    });
    await expect(start).resolves.toBe("ready");
    dispatchCommitted(peer, "input-before-activation");
    dispatchRealtimeEvent(peer, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "input-before-activation",
      transcript: "owned only after activation",
    });

    expect(onTranscript).not.toHaveBeenCalled();
    transport.activate();
    expect(onTranscript).toHaveBeenCalledWith({
      role: "user",
      text: "owned only after activation",
      final: true,
    });
    transport.stop();
  });

  it("uses the distinct frameless provider readiness event", async () => {
    FakePeerConnection.autoSignalReady = false;
    stubAnswerSdpFetch();
    const transport = new WebRtcSdpRealtimeTalkTransport(
      {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "client-secret-123",
        transcriptProtocol: "openai-frameless-turns",
      },
      { client: {} as never, sessionKey: "main", callbacks: {} },
    );

    const start = transport.start();
    const peer = FakePeerConnection.instances[0];
    await waitForFast(() => expect(peer?.remoteDescription).not.toBeNull());
    peer?.channel.dispatchEvent(new Event("open"));
    await expect(Promise.race([start, Promise.resolve("pending")])).resolves.toBe("pending");
    dispatchRealtimeEvent(peer, { type: "session.started" });
    await expect(start).resolves.toBe("ready");
    expect(inputTrack.enabled).toBe(false);
    transport.activate();
    expect(inputTrack.enabled).toBe(true);
    transport.stop();
  });

  it("fails setup and releases media when transcript readiness is never confirmed", async () => {
    vi.useFakeTimers();
    FakePeerConnection.autoSignalReady = false;
    stubAnswerSdpFetch();
    const transport = createOpenAiTransport();
    const startResult = transport.start().then(
      () => undefined,
      (error: unknown) => error,
    );
    const peer = FakePeerConnection.instances[0];
    await waitForFast(() => expect(peer?.remoteDescription).not.toBeNull());
    peer?.channel.dispatchEvent(new Event("open"));

    await vi.runAllTimersAsync();

    await expect(startResult).resolves.toMatchObject(
      new Error("Realtime provider did not confirm transcript readiness"),
    );
    expect(stopInputTrack).toHaveBeenCalledOnce();
    expect(peer?.channel.close).toHaveBeenCalledOnce();
  });

  it("waits through the default created session for the configured session update", async () => {
    FakePeerConnection.autoSignalReady = false;
    stubAnswerSdpFetch();
    const transport = createOpenAiTransport();
    const start = transport.start();
    const peer = FakePeerConnection.instances[0];
    await waitForFast(() => expect(peer?.remoteDescription).not.toBeNull());
    peer?.channel.dispatchEvent(new Event("open"));
    dispatchRealtimeEvent(peer, {
      type: "session.created",
      session: { audio: { input: { transcription: null } } },
    });
    await expect(Promise.race([start, Promise.resolve("pending")])).resolves.toBe("pending");

    dispatchRealtimeEvent(peer, {
      type: "session.updated",
      session: {
        audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" } } },
      },
    });

    await expect(start).resolves.toBe("ready");
    expect(inputTrack.enabled).toBe(false);
    transport.activate();
    expect(inputTrack.enabled).toBe(true);
    transport.stop();
  });

  it("fails setup immediately when the configured provider session lacks transcription", async () => {
    FakePeerConnection.autoSignalReady = false;
    stubAnswerSdpFetch();
    const transport = createOpenAiTransport();
    const startResult = transport.start().then(
      () => undefined,
      (error: unknown) => error,
    );
    const peer = FakePeerConnection.instances[0];
    await waitForFast(() => expect(peer?.remoteDescription).not.toBeNull());
    peer?.channel.dispatchEvent(new Event("open"));
    dispatchRealtimeEvent(peer, {
      type: "session.updated",
      session: { audio: { input: { transcription: {} } } },
    });

    await expect(startResult).resolves.toMatchObject(
      new Error("Realtime provider did not enable input transcription"),
    );
    expect(stopInputTrack).toHaveBeenCalledOnce();
  });

  it("rejects activation when the provider fails after readiness but before adoption", async () => {
    stubAnswerSdpFetch();
    const transport = createOpenAiTransport();
    await expect(transport.start()).resolves.toBe("ready");
    dispatchRealtimeEvent(FakePeerConnection.instances[0], {
      type: "error",
      error: { message: "provider revoked the session" },
    });

    expect(() => transport.activate()).toThrow("activated before transcript readiness");
    expect(inputTrack.enabled).toBe(false);
    transport.stop();
  });

  it("rejects activation when a later provider session disables transcription", async () => {
    stubAnswerSdpFetch();
    const transport = createOpenAiTransport();
    await expect(transport.start()).resolves.toBe("ready");
    dispatchRealtimeEvent(FakePeerConnection.instances[0], {
      type: "session.updated",
      session: { audio: { input: { transcription: null } } },
    });

    expect(() => transport.activate()).toThrow("activated before transcript readiness");
    expect(inputTrack.enabled).toBe(false);
    transport.stop();
  });

  it("stops an active session when a provider update disables transcription", async () => {
    stubAnswerSdpFetch();
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const onFatalError = vi.fn();
    const transport = createOpenAiTransport({}, { onStatus, onTalkEvent, onFatalError });
    await startAndActivate(transport);

    dispatchRealtimeEvent(FakePeerConnection.instances[0], {
      type: "session.updated",
      session: { audio: { input: { transcription: null } } },
    });

    expect(onStatus).toHaveBeenCalledWith(
      "error",
      "Realtime provider disabled input transcription",
    );
    expect(onTalkEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "session.error" }));
    expect(onFatalError).toHaveBeenCalledWith("Realtime provider disabled input transcription");
    expect(stopInputTrack).toHaveBeenCalledOnce();
  });

  it("rejects activation when the ready data channel closes before adoption", async () => {
    stubAnswerSdpFetch();
    const transport = createOpenAiTransport();
    await expect(transport.start()).resolves.toBe("ready");
    FakePeerConnection.instances[0]?.channel.dispatchEvent(new Event("close"));

    expect(() => transport.activate()).toThrow("closed before activation");
    expect(stopInputTrack).toHaveBeenCalledOnce();
  });

  it("mutes immediately and drains a final turn whose provider events arrive after stop", async () => {
    vi.useFakeTimers();
    stubAnswerSdpFetch();
    const onTranscript = vi.fn();
    const transport = createOpenAiTransport({}, { onTranscript });
    await startAndActivate(transport);
    const peer = FakePeerConnection.instances[0];
    const drain = transport.drain();
    expect(inputTrack.enabled).toBe(false);
    await expect(Promise.race([drain, Promise.resolve("pending")])).resolves.toBe("pending");

    await vi.advanceTimersByTimeAsync(500);
    dispatchRealtimeEvent(peer, { type: "input_audio_buffer.speech_started" });
    dispatchRealtimeEvent(peer, { type: "input_audio_buffer.speech_stopped" });
    dispatchCommitted(peer, "input-last");
    dispatchRealtimeEvent(peer, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "input-last",
      transcript: "preserve the final turn",
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(drain).resolves.toBeUndefined();
    expect(onTranscript).toHaveBeenCalledWith({
      role: "user",
      text: "preserve the final turn",
      final: true,
    });
    transport.stop();
  });

  it("does not bypass transcript drain when response cancellation throws", async () => {
    vi.useFakeTimers();
    stubAnswerSdpFetch();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const transport = createOpenAiTransport();
    await startAndActivate(transport);
    const peer = FakePeerConnection.instances[0];
    dispatchRealtimeEvent(peer, { type: "response.created", response: { id: "response-1" } });
    peer?.channel.send.mockImplementation((payload: string) => {
      if (JSON.parse(payload).type === "response.cancel") {
        throw new Error("data channel closed during cancel");
      }
    });

    const drain = transport.drain();
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(drain).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "Realtime Talk response cancellation failed",
      expect.any(Error),
    );
    transport.stop();
  });

  it("ignores benign provider cancellation errors while transcript ownership drains", async () => {
    vi.useFakeTimers();
    stubAnswerSdpFetch();
    const onStatus = vi.fn();
    const transport = createOpenAiTransport({}, { onStatus });
    await startAndActivate(transport);
    const peer = FakePeerConnection.instances[0];

    const drain = transport.drain();
    dispatchRealtimeEvent(peer, {
      type: "error",
      error: { code: "response_cancel_not_active", message: "No active response" },
    });
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(drain).resolves.toBeUndefined();
    expect(onStatus).not.toHaveBeenCalledWith("error", expect.anything());
    transport.stop();
  });

  it("fails continuity when the provider connection closes during transcript drain", async () => {
    vi.useFakeTimers();
    stubAnswerSdpFetch();
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = createOpenAiTransport({}, { onStatus, onTalkEvent });
    await startAndActivate(transport);
    const peer = FakePeerConnection.instances[0];
    dispatchRealtimeEvent(peer, { type: "input_audio_buffer.speech_started" });

    const drainResult = transport.drain().catch((error: unknown) => error);
    peer?.channel.dispatchEvent(new Event("close"));

    await expect(drainResult).resolves.toMatchObject(new Error("Realtime data channel closed"));
    expect(onStatus).toHaveBeenCalledWith("error", "Realtime data channel closed");
    expect(onTalkEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "session.error" }));
  });

  it("rejects a drain that never receives the final committed transcript", async () => {
    vi.useFakeTimers();
    stubAnswerSdpFetch();
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = createOpenAiTransport({}, { onStatus, onTalkEvent });
    await startAndActivate(transport);
    const peer = FakePeerConnection.instances[0];
    dispatchRealtimeEvent(peer, { type: "input_audio_buffer.speech_started" });

    const drain = transport.drain();
    const drainResult = drain.catch((error: unknown) => error);
    expect(inputTrack.enabled).toBe(false);
    await vi.advanceTimersByTimeAsync(11_500);

    await expect(drainResult).resolves.toMatchObject(
      new Error("Realtime Talk timed out waiting for the final user transcription"),
    );
    expect(onStatus).toHaveBeenCalledWith(
      "error",
      "Realtime Talk timed out waiting for the final user transcription",
    );
    expect(onTalkEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "session.error" }));
    expect(stopInputTrack).toHaveBeenCalledOnce();
    transport.stop();
  });

  it("does not execute late provider tools while transcript ownership drains", async () => {
    vi.useFakeTimers();
    stubAnswerSdpFetch();
    const request = vi.fn(async () => ({ ok: true }));
    const onStatus = vi.fn();
    const transport = createOpenAiTransport({ request }, { onStatus });
    await startAndActivate(transport);
    const drain = transport.drain();

    dispatchConsultToolCall(FakePeerConnection.instances[0]);
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(drain).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalledWith("thinking", expect.anything());
    transport.stop();
  });

  it("derives the post-mute drain grace from the effective provider silence window", async () => {
    vi.useFakeTimers();
    stubAnswerSdpFetch();
    const transport = createOpenAiTransport({}, {}, undefined, {
      transcriptSilenceDurationMs: 2_000,
    });
    await startAndActivate(transport);

    const drain = transport.drain();
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(Promise.race([drain, Promise.resolve("pending")])).resolves.toBe("pending");
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(drain).resolves.toBeUndefined();
    transport.stop();
  });

  it("accepts and drains an existing provider silence window above the retention ceiling", async () => {
    vi.useFakeTimers();
    stubAnswerSdpFetch();
    const transport = createOpenAiTransport({}, {}, undefined, {
      transcriptSilenceDurationMs: 60_001,
    });
    await startAndActivate(transport);
    const peer = FakePeerConnection.instances[0];
    dispatchRealtimeEvent(peer, { type: "input_audio_buffer.speech_started" });

    const drain = transport.drain();
    await vi.advanceTimersByTimeAsync(60_001);
    dispatchCommitted(peer, "input-long-vad");
    dispatchRealtimeEvent(peer, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "input-long-vad",
      transcript: "long pause preserved",
    });
    await vi.advanceTimersByTimeAsync(999);

    await expect(drain).resolves.toBeUndefined();
    transport.stop();
  });

  it("bounds transcript drain retention for an extreme provider silence window", async () => {
    vi.useFakeTimers();
    stubAnswerSdpFetch();
    const transport = createOpenAiTransport({}, {}, undefined, {
      transcriptSilenceDurationMs: Number.MAX_SAFE_INTEGER,
    });
    await startAndActivate(transport);
    const peer = FakePeerConnection.instances[0];
    dispatchRealtimeEvent(peer, { type: "input_audio_buffer.speech_started" });

    const drainResult = transport.drain().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(70_999);
    await expect(Promise.race([drainResult, Promise.resolve("pending")])).resolves.toBe("pending");
    await vi.advanceTimersByTimeAsync(1);

    await expect(drainResult).resolves.toMatchObject(
      new Error("Realtime Talk timed out waiting for the final user transcription"),
    );
    transport.stop();
  });

  it("rejects unsafe provider silence window metadata", () => {
    for (const transcriptSilenceDurationMs of [-1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        createOpenAiTransport({}, {}, undefined, { transcriptSilenceDurationMs }),
      ).toThrow("unsupported transcript silence window");
    }
  });

  it("persists completed user transcripts in committed item order", async () => {
    stubAnswerSdpFetch();
    const onTranscript = vi.fn();
    const transport = createOpenAiTransport({}, { onTranscript });
    await startAndActivate(transport);
    const peer = FakePeerConnection.instances[0];

    dispatchCommitted(peer, "input-a");
    dispatchCommitted(peer, "input-b", "input-a");
    dispatchRealtimeEvent(peer, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "input-b",
      transcript: "second",
    });
    dispatchRealtimeEvent(peer, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "input-a",
      transcript: "first",
    });

    expect(onTranscript.mock.calls.map(([entry]) => entry.text)).toEqual(["first", "second"]);
    transport.stop();
  });

  it("holds an assistant final behind its unresolved user commit", async () => {
    stubAnswerSdpFetch();
    const onTranscript = vi.fn();
    const transport = createOpenAiTransport({}, { onTranscript });
    await startAndActivate(transport);
    const peer = FakePeerConnection.instances[0];
    dispatchCommitted(peer, "input-a");
    dispatchRealtimeEvent(peer, {
      type: "response.audio_transcript.done",
      item_id: "response-a",
      transcript: "answer",
    });
    expect(onTranscript).not.toHaveBeenCalled();

    dispatchRealtimeEvent(peer, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "input-a",
      transcript: "question",
    });
    expect(onTranscript.mock.calls.map(([entry]) => `${entry.role}:${entry.text}`)).toEqual([
      "user:question",
      "assistant:answer",
    ]);
    transport.stop();
  });

  it("delivers an unkeyed assistant final behind its unresolved user commit", async () => {
    stubAnswerSdpFetch();
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const onTranscript = vi.fn();
    const transport = createOpenAiTransport({}, { onStatus, onTalkEvent, onTranscript });
    await startAndActivate(transport);
    const peer = FakePeerConnection.instances[0];
    dispatchCommitted(peer, "input-a");
    dispatchRealtimeEvent(peer, {
      type: "response.output_text.done",
      text: "answer without provider identity",
    });
    expect(onTranscript).not.toHaveBeenCalled();

    dispatchRealtimeEvent(peer, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "input-a",
      transcript: "question",
    });

    expect(onTranscript.mock.calls.map(([entry]) => `${entry.role}:${entry.text}`)).toEqual([
      "user:question",
      "assistant:answer without provider identity",
    ]);
    expect(onTalkEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "output.text.done",
        itemId: undefined,
        payload: { text: "answer without provider identity" },
      }),
    );
    expect(onStatus).not.toHaveBeenCalledWith("error", expect.anything());
    transport.stop();
  });

  it("deduplicates terminal user transcript events by provider item id", async () => {
    stubAnswerSdpFetch();
    const onTranscript = vi.fn();
    const transport = createOpenAiTransport({}, { onTranscript });
    await startAndActivate(transport);
    const peer = FakePeerConnection.instances[0];

    dispatchCommitted(peer, "input-1");
    dispatchTranscription(peer, "only once");
    dispatchTranscription(peer, "only once");

    expect(onTranscript).toHaveBeenCalledTimes(1);
    transport.stop();
  });

  it("deduplicates terminal assistant transcript events by provider item id", async () => {
    stubAnswerSdpFetch();
    const onTranscript = vi.fn();
    const transport = createOpenAiTransport({}, { onTranscript });
    await startAndActivate(transport);
    const peer = FakePeerConnection.instances[0];
    const event = {
      type: "response.audio_transcript.done",
      item_id: "assistant-1",
      transcript: "only once",
    };

    dispatchRealtimeEvent(peer, event);
    dispatchRealtimeEvent(peer, event);

    expect(onTranscript).toHaveBeenCalledTimes(1);
    transport.stop();
  });

  it("continues a settled transcript batch when the first observer callback throws", async () => {
    stubAnswerSdpFetch();
    const delivered: string[] = [];
    const onTranscript = vi.fn((entry: { text: string }) => {
      delivered.push(entry.text);
      if (entry.text === "first") {
        throw new Error("first observer failed");
      }
    });
    const transport = createOpenAiTransport({}, { onTranscript });
    await startAndActivate(transport);
    const peer = FakePeerConnection.instances[0];
    dispatchCommitted(peer, "input-a");
    dispatchCommitted(peer, "input-b", "input-a");
    dispatchRealtimeEvent(peer, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "input-b",
      transcript: "second",
    });

    dispatchRealtimeEvent(peer, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "input-a",
      transcript: "first",
    });

    expect(delivered).toEqual(["first", "second"]);
    transport.stop();
  });

  it("fails closed when OpenAI reports a user transcription failure", async () => {
    stubAnswerSdpFetch();
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = createOpenAiTransport({}, { onStatus, onTalkEvent });
    await startAndActivate(transport);
    const peer = FakePeerConnection.instances[0];
    dispatchCommitted(peer, "input-1");

    dispatchRealtimeEvent(peer, {
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "input-1",
      error: { message: "Transcription failed" },
    });

    expect(onStatus).toHaveBeenCalledWith("error", "Transcription failed");
    expect(onTalkEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.error",
        payload: expect.objectContaining({ message: "Transcription failed" }),
      }),
    );
    expect(stopInputTrack).toHaveBeenCalledOnce();
  });

  it("treats an empty completed transcript as settled non-speech", async () => {
    vi.useFakeTimers();
    stubAnswerSdpFetch();
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const onTranscript = vi.fn();
    const transport = createOpenAiTransport({}, { onStatus, onTalkEvent, onTranscript });
    await startAndActivate(transport);
    const peer = FakePeerConnection.instances[0];
    dispatchCommitted(peer, "input-1");

    dispatchRealtimeEvent(peer, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "input-1",
      transcript: "",
    });

    const drain = transport.drain();
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(drain).resolves.toBeUndefined();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalledWith("error", expect.anything());
    expect(onTalkEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.error" }),
    );
    transport.stop();
  });

  it("finishes terminal cleanup when observer callbacks throw", async () => {
    stubAnswerSdpFetch();
    const onFatalError = vi.fn();
    const onStatus = vi.fn((status: string) => {
      if (status === "error") {
        throw new Error("status observer failed");
      }
    });
    const onTalkEvent = vi.fn((event: { type?: string }) => {
      if (event.type === "session.error") {
        throw new Error("event observer failed");
      }
    });
    const transport = createOpenAiTransport({}, { onFatalError, onStatus, onTalkEvent });
    await startAndActivate(transport);
    const peer = FakePeerConnection.instances[0];
    dispatchCommitted(peer, "input-1");

    dispatchRealtimeEvent(peer, {
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "input-1",
      error: { message: "Transcription failed" },
    });

    expect(onFatalError).toHaveBeenCalledWith("Transcription failed");
    expect(stopInputTrack).toHaveBeenCalledOnce();
  });

  it("stops processing the current provider event when a transcript callback closes it", async () => {
    stubAnswerSdpFetch();
    const onTalkEvent = vi.fn();
    const onTranscript = vi.fn(() => transport.stop());
    const transport = createOpenAiTransport({}, { onTranscript, onTalkEvent });

    await startAndActivate(transport);
    dispatchTranscription(FakePeerConnection.instances[0], "overflow");

    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "session.ready",
      "input.audio.committed",
      "session.closed",
    ]);
  });

  it("maps frameless Codex transcript events by role and finality", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch,
    );
    const onTalkEvent = vi.fn();
    const transport = new WebRtcSdpRealtimeTalkTransport(
      {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "client-secret-123",
      },
      {
        client: {} as never,
        sessionKey: "main",
        callbacks: { onTalkEvent },
      },
    );

    await startAndActivate(transport);
    const peer = FakePeerConnection.instances[0];
    for (const event of [
      { type: "input_transcript.added", item: { id: "user-live", text: "hel" } },
      { type: "output_transcript.added", item: { id: "assistant-live", text: "hi" } },
      {
        type: "turn.done",
        turn: { id: "user-final", role: "user", transcript: "hello" },
      },
      {
        type: "turn.done",
        turn: { id: "assistant-final", role: "assistant", transcript: "hi there" },
      },
    ]) {
      peer?.channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
    }

    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "session.ready",
      "transcript.delta",
      "output.text.delta",
      "transcript.done",
      "output.text.done",
      "turn.ended",
    ]);
    transport.stop();
  });

  // Audio output sends the final string in `transcript`; text output sends it in
  // `text`. Both must surface the same assistant transcript + talk events.
  it.each([
    {
      label: "audio output",
      deltaType: "response.output_audio_transcript.delta",
      doneType: "response.output_audio_transcript.done",
      doneField: { transcript: "hi there" },
    },
    {
      label: "text output",
      deltaType: "response.output_text.delta",
      doneType: "response.output_text.done",
      doneField: { text: "hi there" },
    },
  ])(
    "emits assistant transcripts from OpenAI Realtime $label events",
    async ({ deltaType, doneType, doneField }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch,
      );
      const onTranscript = vi.fn();
      const onTalkEvent = vi.fn();
      const transport = new WebRtcSdpRealtimeTalkTransport(
        {
          provider: "openai",
          transport: "webrtc",
          clientSecret: "client-secret-123",
        },
        {
          client: {} as never,
          sessionKey: "main",
          callbacks: { onTranscript, onTalkEvent },
        },
      );

      await startAndActivate(transport);
      const peer = FakePeerConnection.instances[0];
      peer?.channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: deltaType, item_id: "response-1", delta: "hi" }),
        }),
      );
      peer?.channel.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: doneType, item_id: "response-1", ...doneField }),
        }),
      );

      expect(onTranscript).toHaveBeenCalledWith({
        role: "assistant",
        text: "hi",
        final: false,
      });
      expect(onTranscript).toHaveBeenCalledWith({
        role: "assistant",
        text: "hi there",
        final: true,
      });
      expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual([
        "session.ready",
        "output.text.delta",
        "output.text.done",
      ]);
      expect(onTalkEvent.mock.calls.map(([event]) => event.payload)).toEqual([
        null,
        { text: "hi" },
        { text: "hi there" },
      ]);
      transport.stop();
    },
  );
});
