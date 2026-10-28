import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const cp = await importOriginal<typeof import("node:child_process")>();
  return {
    ...cp,
    spawn: (...args: Parameters<typeof cp.spawn>) => mockSpawn(...args) as ReturnType<typeof cp.spawn>,
  };
});

import { fetchCodexQuota, fetchCodexRpcQuota, getQuotaWindows } from "./quota.js";

function createChildThatErrorsOnMicrotask(err: Error): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stream = Object.assign(new EventEmitter(), {
    setEncoding: () => {},
  });
  Object.assign(child, {
    stdout: stream,
    stderr: Object.assign(new EventEmitter(), { setEncoding: () => {} }),
    stdin: { write: vi.fn(), end: vi.fn() },
    kill: vi.fn(),
  });
  queueMicrotask(() => {
    child.emit("error", err);
  });
  return child;
}

// A child whose stdin is a real EventEmitter, so a test can emit a stdin
// `error` event the way the runtime emits EPIPE/EIO on the socket.
function createChildWithLiveStdin(): { child: ChildProcess; emitStdinError: (err: Error) => void } {
  const child = new EventEmitter() as ChildProcess;
  const stdin = new EventEmitter() as EventEmitter & {
    write: (chunk: string) => boolean;
    end: () => void;
  };
  stdin.write = () => true;
  stdin.end = () => {};
  Object.assign(child, {
    stdout: Object.assign(new EventEmitter(), { setEncoding: () => {} }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: () => {} }),
    stdin,
    kill: vi.fn(),
  });
  return { child, emitStdinError: (err) => stdin.emit("error", err) };
}

describe("CodexRpcClient spawn failures", () => {
  let previousCodexHome: string | undefined;
  let isolatedCodexHome: string | undefined;

  beforeEach(() => {
    mockSpawn.mockReset();
    // Keep each test in an isolated auth metadata context.
    previousCodexHome = process.env.CODEX_HOME;
    isolatedCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-codex-spawn-test-"));
    process.env.CODEX_HOME = isolatedCodexHome;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (isolatedCodexHome) {
      try {
        fs.rmSync(isolatedCodexHome, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      isolatedCodexHome = undefined;
    }
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("classifies app-server refresh-token failures as quota probe auth errors", async () => {
    mockSpawn.mockImplementation(() => createChildThatErrorsOnMicrotask(new Error("OAuth failed: refresh token has expired")));

    const result = await getQuotaWindows();

    expect(result.ok).toBe(false);
    expect(result.source).toBe("codex-rpc");
    expect(result.errorFamily).toBe("refresh_token_expired");
    expect(result.error).toContain("Codex app-server");
  });

  it("does not fall back to WHAM after an app-server auth failure", async () => {
    mockSpawn.mockImplementation(() => createChildThatErrorsOnMicrotask(new Error("OAuth failed: refresh token has expired")));
    vi.stubGlobal("fetch", vi.fn());
    const result = await getQuotaWindows();
    expect(result).toMatchObject({ ok: false, source: "codex-rpc", quotaStatus: "auth_error", errorFamily: "refresh_token_expired" });
    expect(fetch).not.toHaveBeenCalled();
    await getQuotaWindows();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("limits WHAM error response buffering before classifying auth failures", async () => {
    const encoder = new TextEncoder();
    const totalChunks = 20;
    let pullCount = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount > totalChunks) {
          controller.close();
          return;
        }
        const text =
          pullCount === 1
            ? `OAuth failed: invalid_grant ${"x".repeat(1_024)}`
            : "x".repeat(1_024);
        controller.enqueue(encoder.encode(text));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 401 })),
    );

    await expect(fetchCodexQuota("access-token-fixture-secret", null)).rejects.toMatchObject({
      name: "CodexQuotaAuthError",
      errorFamily: "refresh_token_invalidated",
    });
    expect(pullCount).toBeLessThan(totalChunks);
    expect(cancelled).toBe(true);
  });

  it("bounds a direct legacy WHAM 401 to one request and does not expose its body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized fixture-secret", { status: 401 })));
    await expect(fetchCodexQuota("fixture-token", null)).rejects.toThrow("chatgpt wham api returned 401");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not crash the process when codex is missing; getQuotaWindows returns ok: false", async () => {
    const enoent = Object.assign(new Error("spawn codex ENOENT"), {
      code: "ENOENT",
      errno: -2,
      syscall: "spawn codex",
      path: "codex",
    });
    mockSpawn.mockImplementation(() => createChildThatErrorsOnMicrotask(enoent));

    const result = await getQuotaWindows();

    expect(result.ok).toBe(false);
    expect(result.windows).toEqual([]);
    expect(result.error).toContain("Codex app-server");
    expect(result.quotaStatus).toBe("unavailable");
  });

  it("rejects in-flight requests on a non-EPIPE stdin error instead of waiting for the timeout", async () => {
    const { child, emitStdinError } = createChildWithLiveStdin();
    mockSpawn.mockImplementation(() => child);

    // The constructor attaches the stdin error handler synchronously and
    // initialize() registers its request synchronously, so emitting right
    // after the call reaches the pending request before the 6s timer fires.
    const pending = fetchCodexRpcQuota();
    emitStdinError(Object.assign(new Error("codex stdin EIO"), { code: "EIO" }));

    await expect(pending).rejects.toThrow("codex stdin EIO");
  });

  it("treats an EPIPE stdin error as a closed pipe, not a pending-request failure", async () => {
    const { child, emitStdinError } = createChildWithLiveStdin();
    mockSpawn.mockImplementation(() => child);

    const pending = fetchCodexRpcQuota();
    // EPIPE is swallowed by the handler, so the request stays pending instead
    // of rejecting with the EPIPE error.
    emitStdinError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    // A different stdin error still rejects the in-flight request, which also
    // releases this test's pending promise.
    emitStdinError(Object.assign(new Error("codex stdin EIO"), { code: "EIO" }));
    await expect(pending).rejects.toThrow("codex stdin EIO");
  });
});
