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
 * was dropped. No hash of the dropped original is stored: it would be computed before the
 * storage-time redaction and would let a reader confirm low-entropy secrets by guessing.
 * Lengths are measured in UTF-16 code units, and cuts never split a surrogate pair, because
 * a lone surrogate is not valid JSON text for PostgreSQL jsonb.
 */

/** Scalars up to this many chars stay verbatim in a compacted context. */
export const ADAPTER_INVOKE_CONTEXT_SCALAR_MAX_CHARS = 512;
/** A non-scalar context value stays verbatim only when its JSON is at most this long. */
export const ADAPTER_INVOKE_CONTEXT_VALUE_MAX_CHARS = 1024;
/** Prompt shown in the invocation card, in UTF-16 code units (not bytes); the rest is dropped from the event. */
export const ADAPTER_INVOKE_PROMPT_MAX_CHARS = 8 * 1024;

/** Head and tail of stdout/stderr kept, in UTF-16 code units. The head matches HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS. */
export const RESULT_OUTPUT_HEAD_CHARS = 4 * 1024;
export const RESULT_OUTPUT_TAIL_CHARS = 4 * 1024;
const RESULT_OUTPUT_KEYS = ["stdout", "stderr"] as const;

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** First at most `max` UTF-16 code units, without cutting a surrogate pair in half. */
function safeHead(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end -= 1;
  return text.slice(0, end);
}

/** Last at most `max` UTF-16 code units, without cutting a surrogate pair in half. */
function safeTail(text: string, max: number): string {
  if (text.length <= max) return text;
  let start = text.length - max;
  if (start < text.length && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) {
    start += 1;
  }
  return text.slice(start);
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
  const omitted: Record<string, { bytes: number }> = {};
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
      omitted[key] = { bytes: Buffer.byteLength(value) };
      continue;
    }
    const json = JSON.stringify(value) ?? "null";
    if (json.length <= ADAPTER_INVOKE_CONTEXT_VALUE_MAX_CHARS) {
      out[key] = value;
      continue;
    }
    omitted[key] = { bytes: Buffer.byteLength(json) };
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
    const head = safeHead(payload.prompt, ADAPTER_INVOKE_PROMPT_MAX_CHARS);
    out.prompt = `${head}\n[truncated ${payload.prompt.length - head.length} chars]`;
  }
  return out;
}

function compactOutput(text: string): string {
  const keep = RESULT_OUTPUT_HEAD_CHARS + RESULT_OUTPUT_TAIL_CHARS;
  if (text.length <= keep) return text;
  const head = safeHead(text, RESULT_OUTPUT_HEAD_CHARS);
  const tail = safeTail(text, RESULT_OUTPUT_TAIL_CHARS);
  const omittedChars = text.length - head.length - tail.length;
  return (
    `${head}\n` +
    `[paperclip kept head and tail only: omitted ${omittedChars} chars; ` +
    `full transcript is in the run log]\n` +
    `${tail}`
  );
}

/**
 * Keep head and tail of the top-level `stdout` / `stderr` of a run result.
 * The kept head has the same length as the 4096-char head the run API serves for oversized output
 * (the API may still return a whole resultJson up to its own size cap, so the tail is additional).
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
