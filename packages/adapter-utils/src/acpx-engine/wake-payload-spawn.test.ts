import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createAcpxEngineExecutor } from "./execute.js";
import {
  PAPERCLIP_WAKE_PAYLOAD_FILE_SCHEMA,
  PAPERCLIP_WAKE_PAYLOAD_INLINE_MAX_BYTES,
} from "../wake-payload-env.js";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const fixturePath = path.join(
  repoRoot,
  "scripts",
  "mcp-fixtures",
  "servers",
  "acp-echo-agent.mjs",
);

/**
 * Linux rejects a single environment string above MAX_ARG_STRLEN (32 pages,
 * 131072 bytes on a 4 KiB page), including the `NAME=` prefix. A wake document
 * past that ceiling made `AcpClient.spawnAgentProcess` fail with `spawn E2BIG`
 * in the `ensure_session` phase, before the agent started.
 */
const MAX_ARG_STRLEN = 32 * 4096;

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function runEcho(input: {
  runId: string;
  root: string;
  wake: unknown;
}): Promise<{
  result: { exitCode?: number | null; errorCode?: string | null; summary?: string | null };
  env: Record<string, string>;
  prompt: string;
  logs: string[];
}> {
  const logs: string[] = [];
  let env: Record<string, string> = {};
  let prompt = "";
  const execute = createAcpxEngineExecutor();
  const result = (await execute({
    runId: input.runId,
    agent: { id: "wake-agent", companyId: "wake-company" },
    runtime: {},
    config: {
      agent: "custom",
      agentCommand: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(fixturePath.replaceAll("\\", "/"))}`,
      mode: "oneshot",
      stateDir: path.join(input.root, "state"),
      cwd: repoRoot,
    },
    context: {
      paperclipWake: input.wake,
      paperclipScratch: { type: "heartbeat_run", dir: path.join(input.root, "scratch") },
    },
    onLog: async (_stream: string, text: string) => logs.push(text),
    onMeta: async (meta: { env?: Record<string, string>; prompt?: string }) => {
      env = meta.env ?? {};
      prompt = meta.prompt ?? "";
    },
  } as never)) as { exitCode?: number | null; errorCode?: string | null; summary?: string | null };
  return { result, env, prompt, logs };
}

function wakePayload(descriptionBytes: number): Record<string, unknown> {
  return {
    reason: "issue_assigned",
    issue: {
      id: "e9f31c0a-0000-4000-8000-00000000c640",
      identifier: "SAK-640",
      title: "Oversized wake document",
      description: "x".repeat(descriptionBytes),
      status: "in_progress",
      priority: "high",
    },
  };
}

it("spills an oversized wake document to a run file instead of failing with spawn E2BIG", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "paperclip-acpx-wake-spill-"),
  );
  tempRoots.push(root);

  const { result, env, prompt, logs } = await runEcho({
    runId: "wake-spill-smoke",
    root,
    wake: wakePayload(600 * 1024),
  });

  expect(result.exitCode, JSON.stringify({ result, logs }, null, 2)).toBe(0);
  expect(logs.join("")).not.toContain("E2BIG");

  const pointerJson = env.PAPERCLIP_WAKE_PAYLOAD_JSON ?? "";
  const payloadPath = env.PAPERCLIP_WAKE_PAYLOAD_PATH ?? "";
  expect(payloadPath).not.toBe("");
  // Every environment string the spawn carries must stay under the kernel limit.
  for (const [key, value] of Object.entries(env)) {
    expect(
      Buffer.byteLength(`${key}=${value}`),
      `env string ${key} is at or above MAX_ARG_STRLEN`,
    ).toBeLessThan(MAX_ARG_STRLEN);
  }

  const pointer = JSON.parse(pointerJson) as {
    schema: string;
    path: string;
    bytes: number;
    sha256: string;
  };
  expect(pointer.schema).toBe(PAPERCLIP_WAKE_PAYLOAD_FILE_SCHEMA);
  expect(pointer.path).toBe(payloadPath);
  expect(Buffer.byteLength(pointerJson)).toBeLessThanOrEqual(
    PAPERCLIP_WAKE_PAYLOAD_INLINE_MAX_BYTES,
  );

  // The complete document must survive: a pointer to a short or missing file
  // would start the agent without its task.
  const file = await fs.readFile(payloadPath);
  expect(file.byteLength).toBe(pointer.bytes);
  expect(createHash("sha256").update(file).digest("hex")).toBe(pointer.sha256);
  const parsed = JSON.parse(file.toString("utf8")) as {
    issue?: { identifier?: string; description?: string };
  };
  expect(parsed.issue?.identifier).toBe("SAK-640");
  expect(parsed.issue?.description?.length).toBe(600 * 1024);

  // The agent reads the pointer, not the task, so the prompt has to name the file.
  expect(prompt).toContain("PAPERCLIP_WAKE_PAYLOAD_PATH");
});

it("keeps a small wake document inline in the environment", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "paperclip-acpx-wake-inline-"),
  );
  tempRoots.push(root);

  const { result, env, prompt } = await runEcho({
    runId: "wake-inline-smoke",
    root,
    wake: wakePayload(512),
  });

  expect(result.exitCode).toBe(0);
  expect(env.PAPERCLIP_WAKE_PAYLOAD_PATH).toBeUndefined();
  expect(env.PAPERCLIP_WAKE_PAYLOAD_JSON ?? "").toContain("SAK-640");
  expect(prompt).not.toContain("PAPERCLIP_WAKE_PAYLOAD_PATH");
});
