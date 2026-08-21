# PR #126988 exact-head browser proof

This branch contains reviewer-visible evidence for
[openclaw/openclaw#126988](https://github.com/openclaw/openclaw/pull/126988).
It is evidence only and is not part of the code patch.

## Candidate identity

- Git head: `3e2b581f6fc6417f1853771897b5a3c62b962ab7`
- Immutable image: `sha256:c1d80465c002d0c44b7489c9fa73c5c483d2cc577107cc1c1d713296dd141916`
- Provider route: browser Talk → OpenAI subscription OAuth WebRTC
- Platform API key: absent
- Fixture: isolated OpenShift Deployment; production was not used

## What the recording demonstrates

[stop-reload.webm](./stop-reload.webm) is a 12.68-second recording cropped to
the fixture's main browser pane.

1. Talk is active and the **Stop voice input** control is visible.
2. Stop is clicked immediately after the injected speech ends.
3. Talk returns to the stopped state while the final transcript is still absent.
4. The page reloads.
5. The complete finalized user turn appears after reload:

   > Provider Direct Ordinary confirms a simple real-time reply.

[stop-reload.png](./stop-reload.png) is the tight post-reload screenshot.

The recording's directly inspectable checkpoints are also preserved as:

1. [Talk active with Stop visible](./01-talk-active.png)
2. [Stopped while the final transcript is still absent](./02-stopped-before-final.png)
3. [Reloaded thread with the complete persisted turn](./03-reloaded-persisted.png)

## Causal timing

The browser instrumentation and durable database audit are in
[evidence.json](./evidence.json).

- speech ended: `1787311042902`
- Stop clicked: `1787311042903`
- provider final received: `1787311046055`
- final arrived **3,152 ms after Stop**
- persistence after reload: `true`

The durable audit found one closed, transcript-capable client voice session,
one `realtime_voice` user event containing the complete sentence, zero
transcript failures, and zero consult runs.

## Deterministic compatibility proof

The PR also adds transport/owner tests for the separate ClawSweeper regression:

- a text-bearing assistant final without `item_id` remains deliverable;
- the final stays ordered behind a pending user transcript;
- it does not close Talk through the fatal callback;
- multiple unkeyed assistant finals remain deliverable;
- keyed assistant finals retain deduplication and validation.

Focused owner/transport suite: **49 tests passed**.  
Full Talk/protocol slice: **10 files / 215 tests passed**.  
The repository changed-scope typecheck, lint, and guard gate also passed.
