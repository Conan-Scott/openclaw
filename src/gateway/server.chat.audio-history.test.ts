import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
type GatewaySocket = Awaited<ReturnType<GatewayHarness["openWs"]>>;

let harness: GatewayHarness;

beforeAll(async () => {
  harness = await createGatewaySuiteHarness();
});

afterAll(async () => {
  await harness.close();
});

async function withMainHistory(
  run: (ctx: { ws: GatewaySocket; sessionDir: string }) => Promise<void>,
) {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
  const ws = await harness.openWs();
  try {
    await connectOk(ws);
    testState.sessionStorePath = path.join(sessionDir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: { sessionId: "sess-main", updatedAt: Date.now() },
      },
    });
    await run({ ws, sessionDir });
  } finally {
    testState.sessionStorePath = undefined;
    ws.close();
    await fs.rm(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

describe("gateway chat history audio display", () => {
  test("chat.history preserves assistant base64 audio blocks for control UI playback", async () => {
    await withMainHistory(async ({ ws, sessionDir }) => {
      const audioB64 = "//uQAA==";
      await fs.writeFile(
        path.join(sessionDir, "sess-main.jsonl"),
        `${JSON.stringify({
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Audio reply" },
              {
                type: "audio",
                source: {
                  type: "base64",
                  media_type: "audio/mpeg",
                  data: audioB64,
                },
              },
            ],
            timestamp: 1,
          },
        })}\n`,
        "utf-8",
      );

      const historyRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
      });
      expect(historyRes.ok).toBe(true);
      const messages = historyRes.payload?.messages ?? [];
      expect(messages).toEqual([
        expect.objectContaining({
          role: "assistant",
          content: [
            { type: "text", text: "Audio reply" },
            {
              type: "audio",
              source: {
                type: "base64",
                media_type: "audio/mpeg",
                data: audioB64,
              },
            },
          ],
        }),
      ]);
      const serializedAssistant = JSON.stringify(messages[0]);
      expect(serializedAssistant).toContain(audioB64);
      expect(serializedAssistant).not.toContain('"omitted":true');
    });
  });
});
