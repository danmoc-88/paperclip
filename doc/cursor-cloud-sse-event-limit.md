# Cursor cloud SSE event byte limit

This document records the memory bound added to the cursor-cloud transport path,
what it protects, and what it does not prove.

## The path

`@paperclipai/adapter-cursor-cloud` runs a Cursor cloud agent through
`@cursor/sdk`. The adapter reads run output with `run.stream()` and `run.wait()`
(`packages/adapters/cursor-cloud/src/server/execute.ts`). Inside the SDK the
cloud run stream is read as Server-Sent Events in `dist/esm/642.js`
(`./src/agent/cloud-agent.ts`):

1. the reader appends decoded chunks to an accumulator and splits events on `\n\n`;
2. it joins the `data:` lines of one event and calls `JSON.parse`;
3. for an `interaction_update` event it validates the parsed value with
   `InteractionUpdateSchema.safeParse`.

Before this change the accumulator had no byte bound. One event could grow the
pending string without limit before `JSON.parse`, and the parsed value could
carry unbounded collections into validation.

## No SDK hook

`@cursor/sdk@1.0.28` exposes `Agent`, `Run`, and `Cursor` only. The cloud client
(`CloudApiClient`) is private, the stream is fetched with the global `fetch`, and
`AgentOptions` / `CloudAgentOptions` / `SendOptions` have no transport or `fetch`
option. There is no public point to wrap before `JSON.parse`. The narrowest
durable mechanism is a `pnpm` patch of the SDK reader.

## The change

`patches/@cursor__sdk@1.0.28.patch` (registered in `package.json` and
`pnpm-workspace.yaml`) edits `dist/esm/642.js`. The repository does not accept
committed `pnpm-lock.yaml` changes; CI resolves the stale lockfile inline.

- it tracks the raw bytes accumulated since the last completed event;
- it rejects one event frame whose UTF-8 byte length exceeds `MAX` before
  `JSON.parse`;
- it rejects the pending (unterminated) accumulation once its content exceeds
  `MAX`.

The pending-accumulation guard measures the event content, not the framing. The
accumulator holds no `\n\n`, so it is an event-content prefix plus at most the
single `\n` that may begin the blank-line separator. That trailing newline is not
charged to the content budget. This matters when a real at-limit event and its
`\n\n` separator arrive in different network chunks: an earlier revision counted
the separator byte, so an event of exactly `MAX` bytes was rejected as soon as
the first `\n` of the separator landed in a separate chunk. The guard now accepts
that split while still rejecting a frame one byte over `MAX`.

`MAX` is `1048576` bytes (1 MiB). It matches the SDK's own 1 MiB buffer limits
and stays far below the 10 MiB manifest cap in `357.js`, which is a different,
unreachable chunk. Real `interaction_update` frames are kilobytes. The rejection
is a non-retryable error with the code `sse_event_too_large`; the message names
the limit and never contains the event body. The reader still cancels on error
and still honours `AbortSignal`.

## What the bound protects

- The bytes of one SSE event frame and of the pending incomplete accumulation,
  and therefore the input to `JSON.parse` for a single event.
- The work and memory of validating one event: a bounded frame bounds the parsed
  value and the nested collections it can carry.

## What it does not prove

- It does not cap the number of events, the total size of a run, or the count of
  collection elements inside a frame that is under the limit.
- It bounds one event's bytes, not peak memory. The reader decodes a whole
  network chunk and appends it to the accumulator before the check runs, so peak
  resident memory for the pending event is the limit plus the largest decoded
  chunk, not exactly the limit.
- A bounded `JSON.parse` input is not proof that `InteractionUpdateSchema`
  validation is resistant to deeply nested collections inside a frame that stays
  under the limit; it only bounds the input the schema sees. A separate
  collection/depth guard, if needed, must run before element validation rather
  than as a `.max()` on the parsed arrays.
- It does not prove which `@cursor/sdk` version a running process uses, and it is
  not evidence of exploitation.
- It patches the ESM build only. The server uses ESM (`@cursor/sdk` `import`
  entry); the CJS and `./bundled` builds are not patched.

## Rollback

Revert the pull request that adds this document and the patch. The patch file,
the `patchedDependencies` entries, the `pnpm-lock.yaml` patch hash, and the
integration test are removed together. Rollback is a separate pull request.

## Tests

`packages/adapters/cursor-cloud/src/server/sse-event-limit.test.ts` drives the
real SDK reader over a synthetic stream: at the limit and one byte over, an
at-limit event whose `\n\n` separator is split across chunks, UTF-8 split inside
a multibyte character, one large chunk and many small chunks, multi-line `data:`,
an unterminated event over the limit, a fragmented oversized multi-line event
(asserting one stream request, one source cancellation, and that no oversized
payload reaches `JSON.parse`), several events in one chunk, and cancellation.
The fetch mock is test-only; the SDK has no transport injection point.
