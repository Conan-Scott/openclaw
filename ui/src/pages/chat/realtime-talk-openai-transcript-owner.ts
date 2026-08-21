const MAX_UNRESOLVED_ITEMS = 64;
const MAX_ORDERED_ITEMS = 128;
const MAX_ITEM_ID_BYTES = 1_024;
const MAX_RETAINED_TRANSCRIPT_BYTES = 256 * 1_024;
const MAX_SETTLED_ITEMS = 4_096;
const MAX_SETTLED_ID_BYTES = 256 * 1_024;

const encoder = new TextEncoder();

type TranscriptAction = {
  role: "user" | "assistant";
  text: string;
  itemId?: string;
};

type UserEntry = {
  kind: "user";
  itemId: string;
  text?: string | null;
};

type AssistantEntry = {
  kind: "assistant";
  text: string;
  itemId?: string;
};

type OrderedEntry = UserEntry | AssistantEntry;

export class OpenAiRealtimeTranscriptOwner {
  private readonly ordered: OrderedEntry[] = [];
  private readonly deferredAssistants: AssistantEntry[] = [];
  private readonly unresolvedUsers = new Map<string, UserEntry>();
  private readonly earlyCompletions = new Map<string, string | null>();
  private readonly pendingAssistantIds = new Set<string>();
  private readonly settledIds = new Set<string>();
  private retainedBytes = 0;
  private settledIdBytes = 0;

  commit(rawItemId: unknown): TranscriptAction[] {
    const itemId = this.requireItemId(rawItemId);
    if (this.settledIds.has(itemId) || this.unresolvedUsers.has(itemId)) {
      return [];
    }
    const early = this.earlyCompletions.get(itemId);
    if (early === undefined) {
      this.assertUnresolvedCapacity();
    }
    this.assertOrderedCapacity();
    const entry: UserEntry = { kind: "user", itemId };
    if (early !== undefined) {
      entry.text = early;
      this.earlyCompletions.delete(itemId);
    }
    this.unresolvedUsers.set(itemId, entry);
    this.ordered.push(entry);
    if (this.earlyCompletions.size === 0 && this.deferredAssistants.length > 0) {
      this.ordered.push(...this.deferredAssistants.splice(0));
    }
    return this.flush();
  }

  complete(rawItemId: unknown, rawText: unknown): TranscriptAction[] {
    const itemId = this.requireItemId(rawItemId);
    if (this.settledIds.has(itemId)) {
      return [];
    }
    const text = typeof rawText === "string" ? rawText.trim() || null : null;
    const entry = this.unresolvedUsers.get(itemId);
    if (entry?.text !== undefined || this.earlyCompletions.has(itemId)) {
      return [];
    }
    const bytes = text ? encoder.encode(text).byteLength : 0;
    if (bytes > MAX_RETAINED_TRANSCRIPT_BYTES - this.retainedBytes) {
      throw new Error("Realtime transcription exceeded the retained transcript limit");
    }
    this.retainedBytes += bytes;
    if (entry) {
      entry.text = text;
    } else {
      this.assertUnresolvedCapacity();
      this.earlyCompletions.set(itemId, text);
    }
    return this.flush();
  }

  assistant(rawText: unknown, rawItemId: unknown): TranscriptAction[] {
    const itemId = this.requireItemId(rawItemId);
    if (this.settledIds.has(itemId) || this.pendingAssistantIds.has(itemId)) {
      return [];
    }
    const text = typeof rawText === "string" ? rawText.trim() : "";
    if (!text) {
      return [];
    }
    this.assertOrderedCapacity();
    const bytes = encoder.encode(text).byteLength;
    if (bytes > MAX_RETAINED_TRANSCRIPT_BYTES - this.retainedBytes) {
      throw new Error("Realtime transcription exceeded the retained transcript limit");
    }
    this.retainedBytes += bytes;
    const entry: AssistantEntry = { kind: "assistant", text, itemId };
    this.pendingAssistantIds.add(itemId);
    if (this.earlyCompletions.size > 0) {
      this.deferredAssistants.push(entry);
      return [];
    }
    this.ordered.push(entry);
    return this.flush();
  }

  fail(rawItemId: unknown, detail: string): TranscriptAction[] {
    const itemId = this.requireItemId(rawItemId);
    if (
      this.settledIds.has(itemId) ||
      this.unresolvedUsers.get(itemId)?.text !== undefined ||
      this.earlyCompletions.has(itemId)
    ) {
      return [];
    }
    throw new Error(detail.trim() || "Realtime user transcription failed");
  }

  get pendingCount(): number {
    return this.unresolvedUsers.size + this.earlyCompletions.size;
  }

  assertSettled(): void {
    if (this.pendingCount > 0) {
      throw new Error("Realtime Talk closed before the final user transcription completed");
    }
  }

  reset(): void {
    this.ordered.length = 0;
    this.deferredAssistants.length = 0;
    this.unresolvedUsers.clear();
    this.earlyCompletions.clear();
    this.pendingAssistantIds.clear();
    this.settledIds.clear();
    this.retainedBytes = 0;
    this.settledIdBytes = 0;
  }

  private flush(): TranscriptAction[] {
    const actions: TranscriptAction[] = [];
    while (this.ordered.length > 0) {
      const entry = this.ordered[0];
      if (!entry) {
        break;
      }
      if (entry.kind === "user" && entry.text === undefined) {
        break;
      }
      this.ordered.shift();
      if (entry.kind === "user") {
        const text = entry.text;
        if (text === undefined) {
          break;
        }
        this.unresolvedUsers.delete(entry.itemId);
        this.rememberSettled(entry.itemId);
        if (text) {
          this.retainedBytes -= encoder.encode(text).byteLength;
          actions.push({ role: "user", text, itemId: entry.itemId });
        }
      } else {
        if (entry.itemId) {
          this.pendingAssistantIds.delete(entry.itemId);
          this.rememberSettled(entry.itemId);
        }
        this.retainedBytes -= encoder.encode(entry.text).byteLength;
        actions.push({ role: "assistant", text: entry.text, itemId: entry.itemId });
      }
    }
    return actions;
  }

  private requireItemId(value: unknown): string {
    const itemId = typeof value === "string" ? value.trim() : "";
    if (!itemId) {
      throw new Error("Realtime transcription item identity was missing");
    }
    if (encoder.encode(itemId).byteLength > MAX_ITEM_ID_BYTES) {
      throw new Error("Realtime transcription exceeded the item identity limit");
    }
    return itemId;
  }

  private assertUnresolvedCapacity(): void {
    if (this.pendingCount >= MAX_UNRESOLVED_ITEMS) {
      throw new Error("Realtime transcription exceeded the unresolved item limit");
    }
  }

  private assertOrderedCapacity(): void {
    if (this.ordered.length + this.deferredAssistants.length >= MAX_ORDERED_ITEMS) {
      throw new Error("Realtime transcription exceeded the ordered item limit");
    }
  }

  private rememberSettled(itemId: string): void {
    const bytes = encoder.encode(itemId).byteLength;
    if (
      this.settledIds.size >= MAX_SETTLED_ITEMS ||
      bytes > MAX_SETTLED_ID_BYTES - this.settledIdBytes
    ) {
      throw new Error("Realtime transcription exceeded the terminal item history limit");
    }
    this.settledIds.add(itemId);
    this.settledIdBytes += bytes;
  }
}

export type { TranscriptAction as OpenAiRealtimeTranscriptAction };
