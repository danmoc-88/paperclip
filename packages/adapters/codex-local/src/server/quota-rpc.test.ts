import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
import { getQuotaWindows, mapCodexRpcQuota } from "./quota.js";

let home: string;
let oldHome: string | undefined;
let methods: string[];
const snapshot = { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1730947200 } } };
function respond(reply: Record<string, unknown>) {
  spawn.mockImplementation(() => {
    const stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    const child = Object.assign(new EventEmitter(), {
      stdout, stderr: Object.assign(new EventEmitter(), { setEncoding() {} }),
      stdin: { write(line: string) {
        const msg = JSON.parse(line);
        methods.push(msg.method);
        if (!msg.id) return;
        queueMicrotask(() => stdout.emit("data", JSON.stringify({ id: msg.id,
          ...(msg.method === "account/rateLimits/read" ? reply : { result: {} }) }) + "\n"));
      } }, kill: vi.fn(),
    });
    return child;
  });
}
beforeEach(async () => {
  oldHome = process.env.CODEX_HOME;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "quota-rpc-"));
  process.env.CODEX_HOME = home;
  methods = [];
  spawn.mockReset();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected direct HTTP request"); }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  if (oldHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = oldHome;
  await fs.rm(home, { recursive: true, force: true });
});

describe("quota RPC boundary", () => {
  it("inherits approval policy, keeps read-only, and only sends usage RPC", async () => {
    respond({ result: snapshot });
    const result = await getQuotaWindows();
    expect(spawn.mock.calls[0]?.slice(0, 2)).toEqual(["codex", ["-s", "read-only", "app-server"]]);
    expect(methods).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
    expect(result).toMatchObject({ ok: true, quotaStatus: "available", windows: [{ usedPercent: 25 }] });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("returns unknown for empty windows, never zero or unlimited", async () => {
    respond({ result: {} });
    expect(await getQuotaWindows()).toMatchObject({ ok: false, quotaStatus: "unavailable", windows: [], lastSuccessful: null });
  });
  it("stops on 401, redacts the provider message, and retries only after auth metadata changes", async () => {
    respond({ error: { code: 401, message: "unauthorized Bearer fixture-secret" } });
    const first = await getQuotaWindows();
    expect(first).toMatchObject({ ok: false, quotaStatus: "auth_error", windows: [] });
    expect(JSON.stringify(first)).not.toContain("fixture-secret");
    expect(await getQuotaWindows()).toEqual(first);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    await fs.writeFile(path.join(home, "auth.json"), "synthetic fixture, not a token");
    respond({ result: snapshot });
    expect((await getQuotaWindows()).ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
  it("does not retry when the failing SDK itself rewrites auth metadata", async () => {
    respond({ error: { code: 401, message: "unauthorized" } });
    const original = spawn.getMockImplementation()!;
    spawn.mockImplementation((...args: unknown[]) => {
      // Reproduce a failed SDK refresh that rewrites auth.json before replying.
      const child = original(...args);
      const write = child.stdin.write;
      child.stdin.write = (line: string) => {
        if (JSON.parse(line).method === "account/rateLimits/read") {
          void fs.writeFile(path.join(home, "auth.json"), "synthetic failed refresh")
            .then(() => write(line));
        } else write(line);
      };
      return child;
    });
    expect((await getQuotaWindows()).quotaStatus).toBe("auth_error");
    await getQuotaWindows();
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it("coalesces concurrent auth failures", async () => {
    respond({ error: { code: 401, message: "unauthorized" } });
    const results = await Promise.all([getQuotaWindows(), getQuotaWindows()]);
    expect(results.every(r => !r.ok)).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it("distinguishes unsupported RPC and retains a timestamped last good observation", async () => {
    respond({ result: snapshot });
    const good = await getQuotaWindows();
    respond({ error: { code: -32601, message: "secret unsupported detail" } });
    const bad = await getQuotaWindows();
    expect(bad).toMatchObject({ ok: false, quotaStatus: "version_error", windows: [], lastSuccessful: { windows: good.windows } });
    expect(bad.lastSuccessful?.observedAt).toMatch(/^20/);
    expect(bad.error).toContain("Last successful");
    expect(bad.error).not.toContain("secret");
  });
  it("classifies a rejected CLI flag without returning raw stderr", async () => {
    spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: Object.assign(new EventEmitter(), { setEncoding() {} }),
        stderr: Object.assign(new EventEmitter(), { setEncoding() {} }),
        stdin: { write() {} }, kill: vi.fn(),
      });
      queueMicrotask(() => {
        child.stderr.emit("data", "invalid value 'untrusted' for '--ask-for-approval' fixture-secret");
        child.emit("exit", 2);
      });
      return child;
    });
    const result = await getQuotaWindows();
    expect(result.quotaStatus).toBe("version_error");
    expect(result.error).not.toContain("fixture-secret");
  });
});

describe("documented app-server units", () => {
  it("preserves fractional percentages and actual window duration", () => {
    const result = mapCodexRpcQuota({ rateLimits: { primary: { usedPercent: 0.5, windowDurationMins: 15 } } });
    expect(result.windows[0]).toMatchObject({ usedPercent: 0.5, label: "15m limit" });
  });
  it("does not turn invalid percentages into usable quota", () => {
    for (const usedPercent of [-1, NaN, Infinity, 101]) {
      expect(mapCodexRpcQuota({ rateLimits: { primary: { usedPercent } } }).windows[0]?.usedPercent).toBeNull();
    }
  });
});
