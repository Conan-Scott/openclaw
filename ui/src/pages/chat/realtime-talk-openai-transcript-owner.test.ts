import { describe, expect, it } from "vitest";
import { OpenAiRealtimeTranscriptOwner } from "./realtime-talk-openai-transcript-owner.ts";

describe("OpenAiRealtimeTranscriptOwner", () => {
  it("emits completed user transcripts in committed order", () => {
    const owner = new OpenAiRealtimeTranscriptOwner();
    expect(owner.commit("a")).toEqual([]);
    expect(owner.commit("b")).toEqual([]);
    expect(owner.complete("b", "second")).toEqual([]);
    expect(owner.complete("a", "first")).toEqual([
      { role: "user", text: "first", itemId: "a" },
      { role: "user", text: "second", itemId: "b" },
    ]);
  });

  it("holds completion-before-commit and deduplicates terminals", () => {
    const owner = new OpenAiRealtimeTranscriptOwner();
    expect(owner.complete("a", "first")).toEqual([]);
    expect(owner.complete("a", "duplicate")).toEqual([]);
    expect(owner.commit("a")).toEqual([{ role: "user", text: "first", itemId: "a" }]);
    expect(owner.complete("a", "late duplicate")).toEqual([]);
  });

  it("holds assistant finals behind completion-before-commit user items", () => {
    const owner = new OpenAiRealtimeTranscriptOwner();
    expect(owner.complete("a", "question")).toEqual([]);
    expect(owner.assistant("answer", "assistant-a")).toEqual([]);
    expect(owner.commit("a")).toEqual([
      { role: "user", text: "question", itemId: "a" },
      { role: "assistant", text: "answer", itemId: "assistant-a" },
    ]);
  });

  it("holds assistant finals behind unresolved user commits", () => {
    const owner = new OpenAiRealtimeTranscriptOwner();
    owner.commit("a");
    expect(owner.assistant("answer", "assistant-a")).toEqual([]);
    expect(owner.complete("a", "question")).toEqual([
      { role: "user", text: "question", itemId: "a" },
      { role: "assistant", text: "answer", itemId: "assistant-a" },
    ]);
  });

  it("rejects missing item identity and explicit provider failure", () => {
    const owner = new OpenAiRealtimeTranscriptOwner();
    expect(() => owner.commit("")).toThrow("identity was missing");
    expect(() => owner.assistant("answer", 42)).toThrow("identity was invalid");
    owner.commit("a");
    expect(() => owner.fail("a", "provider rejected transcription")).toThrow(
      "provider rejected transcription",
    );
  });

  it("settles an empty completion as non-speech without persisting a placeholder", () => {
    const owner = new OpenAiRealtimeTranscriptOwner();
    expect(owner.commit("noise")).toEqual([]);
    expect(owner.complete("noise", "  ")).toEqual([]);
    expect(owner.pendingCount).toBe(0);
    expect(() => owner.assertSettled()).not.toThrow();
  });

  it("keeps the first terminal outcome for an item", () => {
    const owner = new OpenAiRealtimeTranscriptOwner();
    owner.commit("a");
    expect(owner.complete("a", "done")).toEqual([{ role: "user", text: "done", itemId: "a" }]);
    expect(owner.fail("a", "late failure")).toEqual([]);
  });

  it("deduplicates assistant finals by provider item id", () => {
    const owner = new OpenAiRealtimeTranscriptOwner();
    expect(owner.assistant("answer", "assistant-a")).toEqual([
      { role: "assistant", text: "answer", itemId: "assistant-a" },
    ]);
    expect(owner.assistant("duplicate", "assistant-a")).toEqual([]);
  });

  it("delivers each unkeyed assistant final", () => {
    const owner = new OpenAiRealtimeTranscriptOwner();
    expect(owner.assistant("first", undefined)).toEqual([
      { role: "assistant", text: "first", itemId: undefined },
    ]);
    expect(owner.assistant("second", "  ")).toEqual([
      { role: "assistant", text: "second", itemId: undefined },
    ]);
  });

  it("holds an unkeyed assistant final behind an unresolved user commit", () => {
    const owner = new OpenAiRealtimeTranscriptOwner();
    owner.commit("user-a");
    expect(owner.assistant("answer", undefined)).toEqual([]);
    expect(owner.complete("user-a", "question")).toEqual([
      { role: "user", text: "question", itemId: "user-a" },
      { role: "assistant", text: "answer", itemId: undefined },
    ]);
  });

  it("detects unresolved user items at close", () => {
    const owner = new OpenAiRealtimeTranscriptOwner();
    owner.commit("a");
    expect(() => owner.assertSettled()).toThrow("final user transcription");
    owner.complete("a", "done");
    expect(() => owner.assertSettled()).not.toThrow();
  });

  it("bounds unresolved provider items", () => {
    const owner = new OpenAiRealtimeTranscriptOwner();
    for (let index = 0; index < 64; index += 1) {
      owner.commit(`item-${index}`);
    }
    expect(() => owner.commit("item-overflow")).toThrow("unresolved item limit");
  });

  it("bounds provider item identities by UTF-8 bytes", () => {
    const owner = new OpenAiRealtimeTranscriptOwner();
    expect(() => owner.commit("x".repeat(1_025))).toThrow("item identity limit");
    expect(() => owner.commit("é".repeat(513))).toThrow("item identity limit");
    expect(() => owner.assistant("answer", "x".repeat(1_025))).toThrow("item identity limit");
  });

  it("bounds assistant finals held behind an unresolved user item", () => {
    const owner = new OpenAiRealtimeTranscriptOwner();
    owner.commit("user-pending");
    for (let index = 0; index < 127; index += 1) {
      owner.assistant(`answer-${index}`, `assistant-${index}`);
    }
    expect(() => owner.assistant("overflow", "assistant-overflow")).toThrow("ordered item limit");
  });

  it("bounds retained transcript text by UTF-8 bytes", () => {
    const owner = new OpenAiRealtimeTranscriptOwner();
    owner.commit("a");
    expect(() => owner.complete("a", "x".repeat(256 * 1_024 + 1))).toThrow(
      "retained transcript limit",
    );
    expect(() => owner.complete("a", "é".repeat(128 * 1_024 + 1))).toThrow(
      "retained transcript limit",
    );
  });
});
