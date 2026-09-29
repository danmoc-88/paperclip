import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LINUX_MAX_ARG_STRLEN,
  grokPromptExceedsSingleArgument,
  paperclipGrokPromptRemotePath,
  writePaperclipGrokPromptFile,
} from "./grok-prompt-file.js";

const MARKER = "Zażółć gęślą jaźń";

function spawnNode(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: string | null; status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, args, { env });
    } catch (error) {
      const code = error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : null;
      resolve({ code, status: null, stdout: "" });
      return;
    }
    let settled = false;
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      resolve({ code: error.code ?? null, status: null, stdout });
    });
    child.on("exit", (status) => {
      if (settled) return;
      settled = true;
      resolve({ code: null, status, stdout });
    });
  });
}

describe("grok prompt file", () => {
  it("treats 131071 bytes as one argument and 131072 bytes as too long", () => {
    expect(grokPromptExceedsSingleArgument("a".repeat(LINUX_MAX_ARG_STRLEN - 1))).toBe(false);
    expect(grokPromptExceedsSingleArgument("a".repeat(LINUX_MAX_ARG_STRLEN))).toBe(true);
  });

  it("measures UTF-8 bytes, so a shorter character count can still be too long", () => {
    const prompt = "ą".repeat(LINUX_MAX_ARG_STRLEN / 2);
    expect(prompt.length).toBeLessThan(LINUX_MAX_ARG_STRLEN);
    expect(Buffer.byteLength(prompt)).toBe(LINUX_MAX_ARG_STRLEN);
    expect(grokPromptExceedsSingleArgument(prompt)).toBe(true);
  });

  it("keeps the full prompt, including Polish characters, in the run file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-grok-prompt-"));
    const prompt = `${MARKER}\n${"ą".repeat(10)}`;
    const filePath = await writePaperclipGrokPromptFile({
      runId: "polish",
      prompt,
      scratchDir: dir,
    });
    const stat = await fs.stat(filePath);
    expect(filePath).toBe(path.join(dir, "paperclip-grok-prompt.txt"));
    expect(await fs.readFile(filePath, "utf8")).toBe(prompt);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(paperclipGrokPromptRemotePath("run/id 1")).toBe("/tmp/paperclip-grok-prompt-runid1.txt");
    expect(Buffer.byteLength(paperclipGrokPromptRemotePath("run-1"))).toBeLessThan(LINUX_MAX_ARG_STRLEN);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.runIf(process.platform === "linux")(
    "reproduces spawn E2BIG at 131072 bytes and still starts at 131071",
    async () => {
      const env = { PATH: process.env.PATH ?? "" };
      const tooLong = await spawnNode(["-e", "process.exit(0)", "a".repeat(LINUX_MAX_ARG_STRLEN)], env);
      const stillFits = await spawnNode(["-e", "process.exit(0)", "a".repeat(LINUX_MAX_ARG_STRLEN - 1)], env);
      expect(tooLong.code).toBe("E2BIG");
      expect(stillFits.code).toBeNull();
      expect(stillFits.status).toBe(0);
    },
  );

  it.runIf(process.platform === "linux")(
    "starts the process when the prompt exceeds 131072 bytes",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-grok-spawn-"));
      const prompt = `${MARKER}${"ą".repeat(70_000)}`;
      expect(prompt.length).toBeLessThan(LINUX_MAX_ARG_STRLEN);
      expect(Buffer.byteLength(prompt)).toBeGreaterThan(LINUX_MAX_ARG_STRLEN);
      const filePath = await writePaperclipGrokPromptFile({
        runId: "spawn",
        prompt,
        scratchDir: dir,
      });
      const script = `
const fs = require("node:fs");
const filePath = process.argv[2];
const marker = ${JSON.stringify(MARKER)};
if (!filePath || Buffer.byteLength(filePath) >= ${LINUX_MAX_ARG_STRLEN}) process.exit(2);
for (const arg of process.argv) {
  if (Buffer.byteLength(arg) >= ${LINUX_MAX_ARG_STRLEN}) process.exit(3);
  if (arg.includes(marker)) process.exit(4);
}
for (const value of Object.values(process.env)) {
  if (typeof value === "string" && (value.includes(marker) || Buffer.byteLength(value) >= ${LINUX_MAX_ARG_STRLEN})) process.exit(5);
}
const text = fs.readFileSync(filePath, "utf8");
if (text !== ${JSON.stringify(prompt)}) process.exit(6);
if (Buffer.byteLength(text) <= ${LINUX_MAX_ARG_STRLEN}) process.exit(7);
process.stdout.write("started-ok");
`;
      const scriptPath = path.join(dir, "read-prompt.js");
      await fs.writeFile(scriptPath, script);
      const direct = await spawnNode([scriptPath, prompt], { PATH: process.env.PATH ?? "" });
      const started = await spawnNode([scriptPath, filePath], { PATH: process.env.PATH ?? "" });
      expect(direct.code).toBe("E2BIG");
      expect(started.code).toBeNull();
      expect(started.status).toBe(0);
      expect(started.stdout).toBe("started-ok");
      await fs.rm(dir, { recursive: true, force: true });
    },
  );
});
