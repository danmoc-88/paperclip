import { createHash } from "node:crypto";

/**
 * Storage compaction for heartbeat run rows (SAK-1674).
 *
 * Two columns dominated the growth of the instance database:
 *   - heartbeat_run_events.payload of the `adapter.invoke` event, which embedded a full
 *     copy of the run context (wake messages, continuation envelope, task markdown)
 *     that already lives in heartbeat_runs.context_snapshot;
 *   - heartbeat_runs.result_json.stdout / stderr, the full provider output of some
 *     adapters, while the run log file already holds the complete transcript.
 *
 * Both helpers keep a short, human-readable digest in the database and record how much
 * was dropped and a SHA-256 of the dropped original, so a row can still be matched to
 * the file or snapshot that holds the full text.
 */

/** Scalars up to this many chars stay verbatim in a compacted context. */
export const ADAPTER_INVOKE_CONTEXT_SCALAR_MAX_CHARS = 512;
/** A non-scalar context value stays verbatim only when its JSON is at most this long. */
export const ADAPTER_INVOKE_CONTEXT_VALUE_MAX_CHARS = 1024;
/** Prompt shown in the invocation card; the rest is dropped from the event. */
export const ADAPTER_INVOKE_PROMPT_MAX_CHARS = 8 * 1024;

/** Head of stdout/stderr that the run API already serves (HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS). */
export const RESULT_OUTPUT_HEAD_CHARS = 4 * 1024;
export const RESULT_OUTPUT_TAIL_CHARS = 4 * 1024;
const RESULT_OUTPUT_KEYS = ["stdout", "stderr"] as const;

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Replace the heavy values of an `adapter.invoke` context with a digest.
 * Identifiers and other short values (issueId, wakeReason, commentId, ...) are kept so
 * the invocation card and routing queries still show what the run was woken for.
 */
export function compactAdapterInvokeContext(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const omitted: Record<string, { bytes: number; sha256: string }> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    if (typeof value === "string") {
      if (value.length <= ADAPTER_INVOKE_CONTEXT_SCALAR_MAX_CHARS) {
        out[key] = value;
        continue;
      }
      omitted[key] = { bytes: Buffer.byteLength(value), sha256: sha256(value) };
      continue;
    }
    const json = JSON.stringify(value) ?? "null";
    if (json.length <= ADAPTER_INVOKE_CONTEXT_VALUE_MAX_CHARS) {
      out[key] = value;
      continue;
    }
    omitted[key] = { bytes: Buffer.byteLength(json), sha256: sha256(json) };
  }
  if (Object.keys(omitted).length > 0) {
    out._compacted = {
      reason: "full context is stored in heartbeat_runs.context_snapshot",
      omitted,
    };
  }
  return out;
}

/** Compact the payload of an `adapter.invoke` event before it is written to the database. */
export function compactAdapterInvokePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  if (isRecord(payload.context)) {
    out.context = compactAdapterInvokeContext(payload.context);
  }
  if (typeof payload.prompt === "string" && payload.prompt.length > ADAPTER_INVOKE_PROMPT_MAX_CHARS) {
    const omittedChars = payload.prompt.length - ADAPTER_INVOKE_PROMPT_MAX_CHARS;
    out.prompt =
      `${payload.prompt.slice(0, ADAPTER_INVOKE_PROMPT_MAX_CHARS)}\n` +
      `[truncated ${omittedChars} chars; sha256 of full prompt ${sha256(payload.prompt)}]`;
  }
  return out;
}

function compactOutput(text: string): string {
  const keep = RESULT_OUTPUT_HEAD_CHARS + RESULT_OUTPUT_TAIL_CHARS;
  if (text.length <= keep) return text;
  const omittedChars = text.length - keep;
  return (
    `${text.slice(0, RESULT_OUTPUT_HEAD_CHARS)}\n` +
    `[paperclip kept head and tail only: omitted ${omittedChars} chars, ` +
    `sha256 of full text ${sha256(text)}; full transcript is in the run log]\n` +
    `${text.slice(text.length - RESULT_OUTPUT_TAIL_CHARS)}`
  );
}

/**
 * Keep head and tail of the top-level `stdout` / `stderr` of a run result.
 * The head equals what the run API already returns (first 4096 chars), so API output is unchanged.
 * Returns the same object when nothing exceeds the limit.
 */
export function compactRunResultJsonForStorage<T extends Record<string, unknown> | null | undefined>(
  resultJson: T,
): T {
  if (!isRecord(resultJson)) return resultJson;
  let out: Record<string, unknown> | null = null;
  for (const key of RESULT_OUTPUT_KEYS) {
    const value = resultJson[key];
    if (typeof value !== "string") continue;
    const compacted = compactOutput(value);
    if (compacted === value) continue;
    out ??= { ...resultJson };
    out[key] = compacted;
  }
  return (out ?? resultJson) as T;
}
