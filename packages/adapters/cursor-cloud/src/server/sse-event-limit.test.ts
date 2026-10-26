// Integration test for the cursor-cloud SSE transport path.
//
// It drives the real @cursor/sdk cloud reader (the same reader that
// `execute.ts` reaches through `run.stream()`), not a local helper. The SDK
// reads the run stream as Server-Sent Events, accumulates each event frame,
// then calls `JSON.parse` and validates `interaction_update` frames with
// `InteractionUpdateSchema.safeParse`. A single event with an unbounded frame
// can exhaust memory before either step runs.
//
// `patches/@cursor__sdk@1.0.28.patch` bounds one event's bytes in that reader
// before `JSON.parse`. These tests feed synthetic streams through the real
// transport and prove the boundary, the rejection path, and the preserved
// success path. `globalThis.fetch` is mocked here because the SDK has no
// injection point for the transport; that mock is test-only.
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "@cursor/sdk";

const AGENT_ID = "bc-00000000-0000-4000-8000-000000000001";
const RUN_ID = "run-00000000-0000-4000-8000-000000000002";
// Must match the constant inserted by the patch in @cursor/sdk `dist/esm/642.js`.
const EVENT_BYTE_LIMIT = 1024 * 1024;

const encoder = new TextEncoder();

type Collected = {
  messages: Array<Record<string, unknown>>;
  status: string;
  errorCode?: string;
  errorMessage?: string;
  streamFetches: number;
  longestParsedJsonBytes: number;
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(chunks: Uint8Array[], signal?: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
      signal?.addEventListener("abort", () => {
        const error = Object.assign(new Error("aborted"), { name: "AbortError" });
        try {
          controller.error(error);
        } catch {
          // The stream may already be closed.
        }
      });
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function openSseResponse(signal?: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => {
        const error = Object.assign(new Error("aborted"), { name: "AbortError" });
        try {
          controller.error(error);
        } catch {
          // The stream may already be closed.
        }
      });
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const originalFetch = globalThis.fetch;
const originalParse = JSON.parse;

afterEach(() => {
  globalThis.fetch = originalFetch;
  JSON.parse = originalParse;
});

async function collectRun(
  chunks: Uint8Array[],
  options: { open?: boolean } = {},
): Promise<Collected> {
  let streamFetches = 0;
  let longestParsedJsonBytes = 0;

  JSON.parse = ((text: string, reviver?: (key: string, value: unknown) => unknown) => {
    if (typeof text === "string") {
      longestParsedJsonBytes = Math.max(longestParsedJsonBytes, Buffer.byteLength(text, "utf8"));
    }
    return originalParse(text, reviver as never);
  }) as typeof JSON.parse;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/stream")) {
      streamFetches += 1;
      return options.open ? openSseResponse(init?.signal ?? undefined) : sseResponse(chunks, init?.signal ?? undefined);
    }
    if (url.endsWith("/cancel")) return jsonResponse({ id: RUN_ID });
    if (/\/v1\/agents\/[^/]+\/runs\/[^/]+$/.test(url)) {
      return jsonResponse({
        id: RUN_ID,
        agentId: AGENT_ID,
        status: "RUNNING",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    return jsonResponse({});
  }) as typeof fetch;

  const run = await Agent.getRun(RUN_ID, {
    runtime: "cloud",
    agentId: AGENT_ID,
    apiKey: "test-key",
  });
  const messages: Array<Record<string, unknown>> = [];
  try {
    for await (const message of run.stream()) {
      messages.push(message as unknown as Record<string, unknown>);
    }
  } catch {
    // Stream failures surface through `run.wait()` as the run status.
  }
  const result = await run.wait();
  return {
    messages,
    status: result.status,
    errorCode: result.error?.code,
    errorMessage: result.error?.message,
    streamFetches,
    longestParsedJsonBytes,
  };
}

function assistantFrame(payload: string, terminator = true): string {
  return `event: assistant\ndata: ${payload}${terminator ? "\n\n" : ""}`;
}

function resultFrame(): string {
  return `event: result\ndata: {"status":"FINISHED","result":"ok"}\n\n`;
}

// Builds an assistant frame whose UTF-8 byte length is exactly `bytes`
// (excluding the trailing blank-line separator).
function assistantFrameExactBytes(bytes: number): string {
  const head = "event: assistant\ndata: ";
  const overhead = Buffer.byteLength(head + JSON.stringify({ text: "" }), "utf8");
  const pad = bytes - overhead;
  if (pad < 0) throw new Error(`requested ${bytes} bytes is below the frame overhead`);
  const frame = head + JSON.stringify({ text: "a".repeat(pad) });
  const actual = Buffer.byteLength(frame, "utf8");
  if (actual !== bytes) throw new Error(`frame is ${actual} bytes, expected ${bytes}`);
  return frame;
}

describe("cursor-cloud SSE event byte limit (real transport)", () => {
  it("delivers a valid event whose frame is exactly at the byte limit", async () => {
    const frame = assistantFrameExactBytes(EVENT_BYTE_LIMIT);
    const collected = await collectRun([encoder.encode(`${frame}\n\n${resultFrame()}`)]);

    expect(collected.status).toBe("finished");
    expect(collected.errorCode).toBeUndefined();
    expect(collected.messages).toHaveLength(1);
    expect(collected.messages[0]?.type).toBe("assistant");
  });

  it("rejects an event one byte over the limit before JSON.parse and without retry", async () => {
    const frame = assistantFrameExactBytes(EVENT_BYTE_LIMIT + 1);
    const collected = await collectRun([encoder.encode(`${frame}\n\n`)]);

    expect(collected.status).toBe("error");
    expect(collected.errorCode).toBe("sse_event_too_large");
    expect(collected.errorMessage).toContain(String(EVENT_BYTE_LIMIT));
    // The rejection message must not carry the event body.
    expect(collected.errorMessage).not.toContain("aaaa");
    // One stream request: the non-retryable error stops the retry loop.
    expect(collected.streamFetches).toBe(1);
    // The oversized payload never reached JSON.parse.
    expect(collected.longestParsedJsonBytes).toBeLessThan(100_000);
  });

  it("rejects an unterminated event once the pending buffer exceeds the limit", async () => {
    const frame = assistantFrameExactBytes(EVENT_BYTE_LIMIT + 1);
    // No `\n\n` separator: the reader must cap the incomplete accumulation too.
    const collected = await collectRun([encoder.encode(frame)]);

    expect(collected.status).toBe("error");
    expect(collected.errorCode).toBe("sse_event_too_large");
    expect(collected.streamFetches).toBe(1);
  });

  it("decodes a UTF-8 character split across two chunks", async () => {
    const text = "café 😀 漢字";
    const frame = assistantFrame(JSON.stringify({ text }));
    const encoded = encoder.encode(`${frame}${resultFrame()}`);
    const prefixBytes = Buffer.byteLength(`event: assistant\ndata: {"text":"`, "utf8");
    // Split inside the first multibyte character so the decoder must buffer it.
    const splitAt = prefixBytes + 1;
    const collected = await collectRun([encoded.slice(0, splitAt), encoded.slice(splitAt)]);

    expect(collected.status).toBe("finished");
    expect(collected.messages).toHaveLength(1);
    const message = collected.messages[0]?.message as { content?: Array<{ text?: string }> } | undefined;
    expect(message?.content?.[0]?.text).toBe(text);
  });

  it("treats one large chunk and many small chunks the same", async () => {
    const body = `${assistantFrame('{"text":"one"}')}${assistantFrame('{"text":"two"}')}${resultFrame()}`;
    const encoded = encoder.encode(body);
    const single = await collectRun([encoded]);
    const byteByByte = await collectRun(Array.from(encoded, (byte) => Uint8Array.of(byte)));

    expect(single.status).toBe("finished");
    expect(byteByByte.status).toBe("finished");
    expect(byteByByte.messages).toEqual(single.messages);
    expect(single.messages).toHaveLength(2);
  });

  it("joins every data line of one event before parsing", async () => {
    const frame = 'event: assistant\ndata: {"text":\ndata: "hello"}\n\n';
    const collected = await collectRun([encoder.encode(`${frame}${resultFrame()}`)]);

    expect(collected.status).toBe("finished");
    expect(collected.messages).toHaveLength(1);
    const message = collected.messages[0]?.message as { content?: Array<{ text?: string }> } | undefined;
    expect(message?.content?.[0]?.text).toBe("hello");
  });

  it("delivers several valid events packed into one chunk", async () => {
    const body = `${assistantFrame('{"text":"a"}')}${assistantFrame('{"text":"b"}')}${assistantFrame('{"text":"c"}')}${resultFrame()}`;
    const collected = await collectRun([encoder.encode(body)]);

    expect(collected.status).toBe("finished");
    expect(collected.messages).toHaveLength(3);
  });

  it("keeps cancellation working and does not report the size error", async () => {
    let streamFetches = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/stream")) {
        streamFetches += 1;
        return openSseResponse(init?.signal ?? undefined);
      }
      if (url.endsWith("/cancel")) return jsonResponse({ id: RUN_ID });
      if (/\/v1\/agents\/[^/]+\/runs\/[^/]+$/.test(url)) {
        return jsonResponse({
          id: RUN_ID,
          agentId: AGENT_ID,
          status: "RUNNING",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
      return jsonResponse({});
    }) as typeof fetch;

    const run = await Agent.getRun(RUN_ID, {
      runtime: "cloud",
      agentId: AGENT_ID,
      apiKey: "test-key",
    });
    const streamed = (async () => {
      for await (const _message of run.stream()) {
        // Drain until the run is cancelled.
      }
    })();
    await run.cancel();
    const result = await run.wait();
    await streamed;

    expect(result.status).toBe("cancelled");
    expect(streamFetches).toBe(1);
  });
});
