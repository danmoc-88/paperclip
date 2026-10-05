import { Command } from "commander";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerToolAccessCommands } from "../commands/client/tool-access.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const connectionId = "44444444-4444-4444-8444-444444444444";
let directory: string;
async function run(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerToolAccessCommands(program);
  await program.parseAsync(["tool-access", ...args, "--api-base", "http://localhost:3100", "--api-key", "test-agent-token", ...(args[0] === "snapshot" ? ["--company-id", companyId] : [])], { from: "user" });
}

describe("tool-access operator commands", () => {
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tool-access-test-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("command failed"); });
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

  it("exports complete access rows without connection configuration or credentials", async () => {
    const rows: Record<string, unknown> = {
      [`/api/companies/${companyId}/tools/connections`]: { connections: [{ id: connectionId, name: "Tools", connectionPurpose: "tools", config: { private: "excluded" }, secret: "excluded" }] },
      [`/api/companies/${companyId}/agents`]: [{ id: agentId, name: "Worker", status: "active", adapterConfig: { secret: "excluded" } }],
      [`/api/companies/${companyId}/tools/profiles`]: { profiles: [{ id: "profile", entries: [{ effect: "exclude" }], bindings: [{ priority: 70, metadata: { source: "custom" } }] }] },
      [`/api/companies/${companyId}/tools/policies`]: { policies: [{ policyType: "require_approval" }] },
      [`/api/tool-connections/${connectionId}/installs`]: { installs: [{ targetType: "company", targetId: companyId }] },
      [`/api/tool-connections/${connectionId}/catalog`]: { catalog: [{ id: "tool" }] },
      [`/api/companies/${companyId}/tools/profiles/effective/agents/${agentId}`]: { profiles: [{ id: "profile" }] },
    };
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(rows[new URL(url).pathname])));
    vi.stubGlobal("fetch", fetchMock);
    await run(["snapshot"]);
    const output = String(vi.mocked(console.log).mock.calls.at(-1)?.[0]);
    expect(output).not.toContain("excluded");
    const snapshot = JSON.parse(output);
    expect(snapshot.profiles).toEqual(rows[`/api/companies/${companyId}/tools/profiles`]);
    expect(snapshot.policies).toEqual(rows[`/api/companies/${companyId}/tools/policies`]);
    expect(snapshot.effectiveAccess).toHaveLength(1);
    expect(snapshot.connections[0].installs.installs[0].targetId).toBe(companyId);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("replaces exactly the reviewed list and retains the caller authentication", async () => {
    const payload = { installs: [{ targetType: "agent", targetId: agentId }] };
    const file = path.join(directory, "installs.json");
    await writeFile(file, JSON.stringify(payload));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload)));
    vi.stubGlobal("fetch", fetchMock);
    await run(["installs:set", connectionId, "--file", file]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://localhost:3100/api/tool-connections/${connectionId}/installs`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual(payload);
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-agent-token");
  });

  it("rejects malformed target data before any request", async () => {
    const file = path.join(directory, "bad.json");
    await writeFile(file, JSON.stringify({ installs: [{ targetType: "user", targetId: agentId }] }));
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(run(["installs:set", connectionId, "--file", file])).rejects.toThrow("command failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops on a board-only denial without retry, auth substitution or partial output", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "Board access required" }), { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(run(["snapshot"])).rejects.toThrow("command failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();
  });
});
