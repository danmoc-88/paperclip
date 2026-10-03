import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createAcpxEngineExecutor } from "./execute.js";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const fixturePath = path.join(
  repoRoot,
  "scripts",
  "mcp-fixtures",
  "servers",
  "acp-echo-agent.mjs",
);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

/**
 * An adapter without `classifyTerminalSessionFailure` — the codex lane, for
 * example — used to leave a typed terminal session failure with no
 * machine-readable reason in the run record: only `acpx_turn_failed` and the
 * engine's own sentence. The agent's category is a closed vocabulary and
 * carries no provider text, so the engine records it either way.
 */
it("records the typed failure category for an adapter that ships no classifier", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "paperclip-acpx-failure-category-"),
  );
  tempRoots.push(root);
  const providerText = "provider-text-canary-must-not-escape";
  const logs: string[] = [];
  const execute = createAcpxEngineExecutor();

  const result = (await execute({
    runId: "failure-category-smoke",
    agent: { id: "category-agent", companyId: "category-company" },
    runtime: {},
    config: {
      agent: "custom",
      agentCommand: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(fixturePath.replaceAll("\\", "/"))}`,
      mode: "oneshot",
      stateDir: path.join(root, "state"),
      cwd: repoRoot,
      env: {
        PAPERCLIP_ACPX_TYPED_FAILURE_CANARY: providerText,
        PAPERCLIP_ACPX_TYPED_FAILURE_CATEGORY: "service",
      },
    },
    context: {},
    onLog: async (_stream: string, text: string) => logs.push(text),
    onMeta: async () => {},
  } as never)) as {
    exitCode?: number | null;
    errorCode?: string | null;
    errorFamily?: string | null;
    resultJson?: Record<string, unknown>;
  };

  expect(result.exitCode).toBe(1);
  expect(result.errorCode).toBe("acpx_turn_failed");
  expect(result.resultJson?.terminalSessionFailureCategory).toBe("service");
  const errorLog = logs.find((line) => line.includes("\"acpx.error\"")) ?? "";
  expect(errorLog).toContain("\"failureCategory\":\"service\"");

  // No classifier ran, so nothing may claim a recovery family or a retry time.
  expect(result.errorFamily ?? null).toBeNull();
  expect(result.resultJson?.errorFamily).toBeUndefined();
  expect(result.resultJson?.retryNotBefore).toBeUndefined();

  // The provider's own words still must not reach the result or the run log.
  expect(JSON.stringify(result)).not.toContain(providerText);
  expect(logs.join("\n")).not.toContain(providerText);
});
