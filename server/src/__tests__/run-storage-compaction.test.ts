import { describe, expect, it } from "vitest";
import {
  ADAPTER_INVOKE_PROMPT_MAX_CHARS,
  RESULT_OUTPUT_HEAD_CHARS,
  RESULT_OUTPUT_TAIL_CHARS,
  compactAdapterInvokeContext,
  compactAdapterInvokePayload,
  compactRunResultJsonForStorage,
} from "../services/run-storage-compaction.ts";
import {
  HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS,
} from "../services/heartbeat-run-summary.ts";
import { boundHeartbeatRunEventPayloadForStorage } from "../services/heartbeat.ts";

const isWellFormed = (text: string) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);

describe("adapter.invoke payload compaction", () => {
  const heavyWake = { messages: Array.from({ length: 40 }, (_, i) => ({ id: i, body: "m".repeat(2000) })) };
  const heavyContinuation = { messages: "c".repeat(60_000) };
  const context = {
    issueId: "issue-1",
    taskId: "issue-1",
    wakeReason: "issue_assigned",
    commentId: null,
    paperclipWake: heavyWake,
    executionContinuation: heavyContinuation,
    paperclipTaskMarkdown: "t".repeat(11_000),
    paperclipWorkspace: { cwd: "/w", branch: "b", note: "n".repeat(3000) },
    small: { a: 1 },
  };

  it("keeps identifiers and short values, drops heavy ones, recording size only", () => {
    const compacted = compactAdapterInvokeContext(context);
    expect(compacted).toMatchObject({
      issueId: "issue-1",
      taskId: "issue-1",
      wakeReason: "issue_assigned",
      commentId: null,
      small: { a: 1 },
    });
    for (const key of ["paperclipWake", "executionContinuation", "paperclipTaskMarkdown", "paperclipWorkspace"]) {
      expect(compacted).not.toHaveProperty(key);
    }
    const omitted = (compacted._compacted as { omitted: Record<string, { bytes: number }> }).omitted;
    expect(Object.keys(omitted).sort()).toEqual([
      "executionContinuation",
      "paperclipTaskMarkdown",
      "paperclipWake",
      "paperclipWorkspace",
    ]);
    expect(omitted.paperclipTaskMarkdown).toEqual({ bytes: 11_000 });
    expect(omitted.paperclipWake).toEqual({ bytes: Buffer.byteLength(JSON.stringify(heavyWake)) });
    expect(JSON.stringify(compacted).length).toBeLessThan(2_000);
  });

  it("does not add a marker when nothing was dropped and does not mutate the input", () => {
    const small = { issueId: "i", wakeReason: "r" };
    expect(compactAdapterInvokeContext(small)).toEqual(small);
    const before = JSON.stringify(context);
    compactAdapterInvokeContext(context);
    expect(JSON.stringify(context)).toBe(before);
  });

  it("keeps the fields the invocation card and routing queries read", () => {
    const prompt = "p".repeat(20_000);
    const payload = compactAdapterInvokePayload({
      adapterType: "codex_local",
      command: "codex",
      cwd: "/work",
      commandArgs: ["exec", "-"],
      commandNotes: ["note"],
      env: { A: "1" },
      promptMetrics: { chars: 20_000 },
      prompt,
      context,
    });
    expect(payload).toMatchObject({
      adapterType: "codex_local",
      command: "codex",
      cwd: "/work",
      commandArgs: ["exec", "-"],
      commandNotes: ["note"],
      env: { A: "1" },
      promptMetrics: { chars: 20_000 },
    });
    const kept = payload.prompt as string;
    expect(kept.startsWith("p".repeat(ADAPTER_INVOKE_PROMPT_MAX_CHARS))).toBe(true);
    expect(kept).toContain(`truncated ${20_000 - ADAPTER_INVOKE_PROMPT_MAX_CHARS} chars`);
    expect(kept).not.toMatch(/sha256/i);
    expect((payload.context as Record<string, unknown>).issueId).toBe("issue-1");
  });

  it("leaves payloads without prompt or context unchanged", () => {
    const payload = { adapterType: "process", command: "x" };
    expect(compactAdapterInvokePayload(payload)).toEqual(payload);
  });

  it("is far smaller than the same payload stored through the existing bounder alone", () => {
    const payload = {
      adapterType: "codex_local",
      command: "codex",
      prompt: "p".repeat(16_000),
      env: { A: "1" },
      context,
    };
    const before = JSON.stringify(boundHeartbeatRunEventPayloadForStorage(payload)).length;
    const after = JSON.stringify(
      boundHeartbeatRunEventPayloadForStorage(compactAdapterInvokePayload(payload)),
    ).length;
    expect(after).toBeLessThan(before / 3);
  });
});

describe("run result compaction", () => {
  it("keeps head and tail of oversized stdout/stderr and records omitted size without a hash", () => {
    const stdout = `HEAD${"a".repeat(400_000)}TAIL`;
    const result = compactRunResultJsonForStorage({ stdout, stderr: "err", summary: "s", costUsd: 0.2 });
    expect(result).toMatchObject({ stderr: "err", summary: "s", costUsd: 0.2 });
    const kept = result?.stdout as string;
    expect(kept.length).toBeLessThan(RESULT_OUTPUT_HEAD_CHARS + RESULT_OUTPUT_TAIL_CHARS + 300);
    expect(kept.startsWith("HEAD")).toBe(true);
    expect(kept.endsWith("TAIL")).toBe(true);
    expect(kept).toContain(`omitted ${stdout.length - RESULT_OUTPUT_HEAD_CHARS - RESULT_OUTPUT_TAIL_CHARS} chars`);
    expect(kept).not.toMatch(/sha256/i);
  });

  it("keeps the head the run API serves unchanged and still reads as truncated", () => {
    expect(RESULT_OUTPUT_HEAD_CHARS).toBe(HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS);
    const stdout = "x".repeat(100_000);
    const kept = compactRunResultJsonForStorage({ stdout })?.stdout as string;
    expect(kept.slice(0, HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS)).toBe(stdout.slice(0, HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS));
    expect(kept.length).toBeGreaterThan(HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS);
  });

  it("returns the same object when nothing is oversized, and passes null through", () => {
    const small = { stdout: "ok", stderr: "" };
    expect(compactRunResultJsonForStorage(small)).toBe(small);
    expect(compactRunResultJsonForStorage(null)).toBeNull();
    expect(compactRunResultJsonForStorage(undefined)).toBeUndefined();
  });

  it("does not touch the input and ignores non-string output fields", () => {
    const input = { stdout: "z".repeat(50_000), nested: { stdout: "q".repeat(50_000) }, stderr: { a: 1 } };
    const before = JSON.stringify(input);
    const result = compactRunResultJsonForStorage(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(result).not.toBe(input);
    expect(result?.nested).toBe(input.nested);
    expect(result?.stderr).toBe(input.stderr);
  });

  it("an exactly-at-limit output is stored in full", () => {
    const stdout = "y".repeat(RESULT_OUTPUT_HEAD_CHARS + RESULT_OUTPUT_TAIL_CHARS);
    expect(compactRunResultJsonForStorage({ stdout })?.stdout).toBe(stdout);
  });
});

describe("compaction never produces malformed UTF-16", () => {
  const emoji = "\u{1F600}";

  it("does not split a surrogate pair at the head boundary of stdout", () => {
    const stdout = "a".repeat(RESULT_OUTPUT_HEAD_CHARS - 1) + emoji + "b".repeat(9000);
    expect(isWellFormed(stdout)).toBe(true);
    const kept = compactRunResultJsonForStorage({ stdout })?.stdout as string;
    expect(isWellFormed(kept)).toBe(true);
    expect(kept.startsWith("a".repeat(RESULT_OUTPUT_HEAD_CHARS - 1))).toBe(true);
  });

  it("does not split a surrogate pair at the tail boundary of stdout", () => {
    const stdout = "a".repeat(9000) + emoji + "b".repeat(RESULT_OUTPUT_TAIL_CHARS - 1);
    expect(isWellFormed(stdout)).toBe(true);
    const kept = compactRunResultJsonForStorage({ stdout })?.stdout as string;
    expect(isWellFormed(kept)).toBe(true);
    expect(kept.endsWith("b".repeat(RESULT_OUTPUT_TAIL_CHARS - 1))).toBe(true);
  });

  it("keeps emoji-only output well formed and reports consistent omitted size", () => {
    const stdout = emoji.repeat(20_000);
    const kept = compactRunResultJsonForStorage({ stdout })?.stdout as string;
    expect(isWellFormed(kept)).toBe(true);
    const keptEmoji = kept.split(emoji).length - 1;
    expect(kept).toContain(`omitted ${stdout.length - keptEmoji * 2} chars`);
  });

  it("does not split a surrogate pair at the prompt boundary", () => {
    const prompt = "a".repeat(ADAPTER_INVOKE_PROMPT_MAX_CHARS - 1) + emoji + "b".repeat(9000);
    expect(isWellFormed(prompt)).toBe(true);
    const kept = compactAdapterInvokePayload({ prompt }).prompt as string;
    expect(isWellFormed(kept)).toBe(true);
    const keptPrompt = kept.split("\n[truncated")[0]!;
    expect(kept).toContain(`truncated ${prompt.length - keptPrompt.length} chars`);
  });

  it("stores no hash of raw dropped data, so a nested secret cannot be confirmed by guessing", () => {
    const context = { issueId: "i", blob: { neutral: { password: "1234" }, pad: "x".repeat(2000) } };
    const compacted = JSON.stringify(compactAdapterInvokeContext(context));
    expect(compacted).not.toContain("1234");
    expect(compacted).not.toMatch(/sha256|[0-9a-f]{64}/i);
  });
});
