import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Linux rejects one argv or env string at MAX_ARG_STRLEN (32 pages, 131072
 * bytes on a 4 KiB page). The kernel counts the trailing NUL, so 131071 bytes
 * of text still spawn and 131072 bytes return E2BIG. Measured on this host.
 */
export const LINUX_MAX_ARG_STRLEN = 131072;
export const PAPERCLIP_GROK_PROMPT_FILE_NAME = "paperclip-grok-prompt.txt";

export function grokPromptExceedsSingleArgument(prompt: string): boolean {
  return Buffer.byteLength(prompt, "utf8") >= LINUX_MAX_ARG_STRLEN;
}

export function paperclipGrokPromptRemotePath(runId: string): string {
  const safe = runId.trim().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 80);
  if (!safe) throw new Error("Grok prompt run id is empty.");
  return `/tmp/paperclip-grok-prompt-${safe}.txt`;
}

export function formatGrokPromptDeliveryDiagnostic(delivery: {
  mode: "arg" | "file";
  bytes: number;
  argBytes: number;
}): string {
  return `[paperclip] grok prompt delivery=${delivery.mode} bytes=${delivery.bytes} argBytes=${delivery.argBytes}\n`;
}

export async function writePaperclipGrokPromptFile(input: {
  runId: string;
  prompt: string;
  scratchDir?: string | null;
}): Promise<string> {
  const directory = await resolvePromptDirectory(input);
  const filePath = path.join(directory, PAPERCLIP_GROK_PROMPT_FILE_NAME);
  await writeExactFile(filePath, input.prompt);
  return filePath;
}

async function resolvePromptDirectory(input: {
  runId: string;
  scratchDir?: string | null;
}): Promise<string> {
  const explicit = absoluteDirectory(input.scratchDir);
  if (explicit) {
    await fs.mkdir(explicit, { recursive: true });
    return explicit;
  }
  const safe = input.runId.trim().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "run";
  return fs.mkdtemp(path.join(os.tmpdir(), `paperclip-run-${safe}-`));
}

function absoluteDirectory(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) return null;
  return path.resolve(trimmed);
}

async function writeExactFile(filePath: string, contents: string): Promise<void> {
  const existing = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) {
    await fs.unlink(filePath);
  }
  await fs.writeFile(filePath, contents, { encoding: "utf8", mode: 0o600, flag: "w" });
  await fs.chmod(filePath, 0o600);
}
