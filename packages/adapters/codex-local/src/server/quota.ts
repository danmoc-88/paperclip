import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/adapter-utils";
import {
  classifyCodexAuthRefreshFailure,
  type CodexAuthRefreshFailureClass,
} from "./parse.js";

const CODEX_USAGE_SOURCE_RPC = "codex-rpc";
const MAX_QUOTA_ERROR_BODY_BYTES = 4_000;

export function codexHomeDir(): string {
  const fromEnv = process.env.CODEX_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return path.join(os.homedir(), ".codex");
}

interface CodexLegacyAuthFile {
  accessToken?: string | null;
  accountId?: string | null;
}

interface CodexTokenBlock {
  id_token?: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
  account_id?: string | null;
}

interface CodexModernAuthFile {
  OPENAI_API_KEY?: string | null;
  tokens?: CodexTokenBlock | null;
  last_refresh?: string | null;
}

export interface CodexAuthInfo {
  accessToken: string;
  accountId: string | null;
  refreshToken: string | null;
  idToken: string | null;
  email: string | null;
  planType: string | null;
  lastRefresh: string | null;
}

function base64UrlDecode(input: string): string | null {
  try {
    let normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const remainder = normalized.length % 4;
    if (remainder > 0) normalized += "=".repeat(4 - remainder);
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  if (typeof token !== "string" || token.trim().length === 0) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const decoded = base64UrlDecode(parts[1] ?? "");
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function readNestedString(record: Record<string, unknown>, pathSegments: string[]): string | null {
  let current: unknown = record;
  for (const segment of pathSegments) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" && current.trim().length > 0 ? current.trim() : null;
}

function parsePlanAndEmailFromToken(idToken: string | null, accessToken: string | null): {
  email: string | null;
  planType: string | null;
} {
  const payloads = [decodeJwtPayload(idToken), decodeJwtPayload(accessToken)].filter(
    (value): value is Record<string, unknown> => value != null,
  );
  for (const payload of payloads) {
    const directEmail = typeof payload.email === "string" ? payload.email : null;
    const authBlock =
      typeof payload["https://api.openai.com/auth"] === "object" &&
      payload["https://api.openai.com/auth"] !== null &&
      !Array.isArray(payload["https://api.openai.com/auth"])
        ? payload["https://api.openai.com/auth"] as Record<string, unknown>
        : null;
    const profileBlock =
      typeof payload["https://api.openai.com/profile"] === "object" &&
      payload["https://api.openai.com/profile"] !== null &&
      !Array.isArray(payload["https://api.openai.com/profile"])
        ? payload["https://api.openai.com/profile"] as Record<string, unknown>
        : null;
    const email =
      directEmail
      ?? (typeof profileBlock?.email === "string" ? profileBlock.email : null)
      ?? (typeof authBlock?.chatgpt_user_email === "string" ? authBlock.chatgpt_user_email : null);
    const planType =
      typeof authBlock?.chatgpt_plan_type === "string" ? authBlock.chatgpt_plan_type : null;
    if (email || planType) return { email: email ?? null, planType };
  }
  return { email: null, planType: null };
}

export async function readCodexAuthInfo(codexHome?: string): Promise<CodexAuthInfo | null> {
  const authPath = path.join(codexHome ?? codexHomeDir(), "auth.json");
  let raw: string;
  try {
    raw = await fs.readFile(authPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const modern = obj as CodexModernAuthFile;
  const legacy = obj as CodexLegacyAuthFile;

  const accessToken =
    legacy.accessToken
    ?? modern.tokens?.access_token
    ?? readNestedString(obj, ["tokens", "access_token"]);
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;

  const accountId =
    legacy.accountId
    ?? modern.tokens?.account_id
    ?? readNestedString(obj, ["tokens", "account_id"]);
  const refreshToken =
    modern.tokens?.refresh_token
    ?? readNestedString(obj, ["tokens", "refresh_token"]);
  const idToken =
    modern.tokens?.id_token
    ?? readNestedString(obj, ["tokens", "id_token"]);
  const { email, planType } = parsePlanAndEmailFromToken(idToken, accessToken);

  return {
    accessToken,
    accountId:
      typeof accountId === "string" && accountId.trim().length > 0 ? accountId.trim() : null,
    refreshToken:
      typeof refreshToken === "string" && refreshToken.trim().length > 0 ? refreshToken.trim() : null,
    idToken:
      typeof idToken === "string" && idToken.trim().length > 0 ? idToken.trim() : null,
    email,
    planType,
    lastRefresh:
      typeof modern.last_refresh === "string" && modern.last_refresh.trim().length > 0
        ? modern.last_refresh.trim()
        : null,
  };
}

export async function readCodexToken(): Promise<{ token: string; accountId: string | null } | null> {
  const auth = await readCodexAuthInfo();
  if (!auth) return null;
  return { token: auth.accessToken, accountId: auth.accountId };
}

interface WhamWindow {
  used_percent?: number | null;
  limit_window_seconds?: number | null;
  reset_at?: string | number | null;
}

interface WhamCredits {
  balance?: number | null;
  unlimited?: boolean | null;
}

interface WhamUsageResponse {
  plan_type?: string | null;
  rate_limit?: {
    primary_window?: WhamWindow | null;
    secondary_window?: WhamWindow | null;
  } | null;
  credits?: WhamCredits | null;
}

class CodexQuotaAuthError extends Error {
  constructor(
    message: string,
    readonly errorFamily: CodexAuthRefreshFailureClass,
  ) {
    super(message);
    this.name = "CodexQuotaAuthError";
  }
}

/**
 * Map a window duration in seconds to a human-readable label.
 * Falls back to the provided fallback string when seconds is null/undefined.
 */
export function secondsToWindowLabel(
  seconds: number | null | undefined,
  fallback: string,
): string {
  if (seconds == null) return fallback;
  const hours = seconds / 3600;
  if (hours < 6) return "5h";
  if (hours <= 24) return "24h";
  if (hours <= 168) return "7d";
  return `${Math.round(hours / 24)}d`;
}

/** fetch with an abort-based timeout so a hanging provider api doesn't block the response indefinitely */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms = 8000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseTextPrefix(
  resp: Response,
  maxBytes = MAX_QUOTA_ERROR_BODY_BYTES,
): Promise<string> {
  if (maxBytes <= 0 || !resp.body) return "";

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let remainingBytes = maxBytes;
  let text = "";

  try {
    while (remainingBytes > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      const chunk =
        value.byteLength > remainingBytes
          ? value.subarray(0, remainingBytes)
          : value;
      text += decoder.decode(chunk, { stream: true });
      remainingBytes -= chunk.byteLength;

      if (remainingBytes <= 0) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    text += decoder.decode();
    return text;
  } catch {
    return "";
  } finally {
    reader.releaseLock();
  }
}

function normalizeCodexUsedPercent(rawPct: number | null | undefined): number | null {
  if (rawPct == null) return null;
  return Math.min(100, Math.round(rawPct < 1 ? rawPct * 100 : rawPct));
}

export async function fetchCodexQuota(
  token: string,
  accountId: string | null,
): Promise<QuotaWindow[]> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;

  const resp = await fetchWithTimeout("https://chatgpt.com/backend-api/wham/usage", { headers });
  if (!resp.ok) {
    const message = `chatgpt wham api returned ${resp.status}`;
    const responseText = await readResponseTextPrefix(resp);
    const authFailure = classifyCodexAuthRefreshFailure({
      errorMessage: [message, responseText].filter(Boolean).join("\n"),
    });
    if (authFailure) throw new CodexQuotaAuthError(message, authFailure);
    throw new Error(message);
  }
  const body = (await resp.json()) as WhamUsageResponse;
  const windows: QuotaWindow[] = [];

  const rateLimit = body.rate_limit;
  if (rateLimit?.primary_window != null) {
    const w = rateLimit.primary_window;
    windows.push({
      label: "5h limit",
      usedPercent: normalizeCodexUsedPercent(w.used_percent),
      resetsAt:
        typeof w.reset_at === "number"
          ? unixSecondsToIso(w.reset_at)
          : (w.reset_at ?? null),
      valueLabel: null,
      detail: null,
    });
  }
  if (rateLimit?.secondary_window != null) {
    const w = rateLimit.secondary_window;
    windows.push({
      label: "Weekly limit",
      usedPercent: normalizeCodexUsedPercent(w.used_percent),
      resetsAt:
        typeof w.reset_at === "number"
          ? unixSecondsToIso(w.reset_at)
          : (w.reset_at ?? null),
      valueLabel: null,
      detail: null,
    });
  }
  if (body.credits != null && body.credits.unlimited !== true) {
    const balance = body.credits.balance;
    const valueLabel = balance != null ? `$${(balance / 100).toFixed(2)} remaining` : "N/A";
    windows.push({
      label: "Credits",
      usedPercent: null,
      resetsAt: null,
      valueLabel,
      detail: null,
    });
  }
  return windows;
}

interface CodexRpcWindow {
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

interface CodexRpcCredits {
  hasCredits?: boolean | null;
  unlimited?: boolean | null;
  balance?: string | number | null;
}

interface CodexRpcLimit {
  limitId?: string | null;
  limitName?: string | null;
  primary?: CodexRpcWindow | null;
  secondary?: CodexRpcWindow | null;
  credits?: CodexRpcCredits | null;
  planType?: string | null;
}

interface CodexRpcRateLimitsResult {
  rateLimits?: CodexRpcLimit | null;
  rateLimitsByLimitId?: Record<string, CodexRpcLimit> | null;
}

interface CodexRpcAccountResult {
  account?: {
    type?: string | null;
    email?: string | null;
    planType?: string | null;
  } | null;
  requiresOpenaiAuth?: boolean | null;
}

export interface CodexRpcQuotaSnapshot {
  windows: QuotaWindow[];
  email: string | null;
  planType: string | null;
}

function unixSecondsToIso(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function rpcWindowLabel(fallback: string, minutes: number | null | undefined): string {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return fallback;
  const duration = minutes === 10080 ? "Weekly" : minutes < 60 ? `${minutes}m`
    : minutes < 1440 ? `${minutes / 60}h` : `${minutes / 1440}d`;
  return fallback.replace(/(?:5h|Weekly) limit$/, `${duration} limit`);
}

function buildCodexRpcWindow(label: string, window: CodexRpcWindow | null | undefined): QuotaWindow | null {
  if (!window) return null;
  return {
    label: rpcWindowLabel(label, window.windowDurationMins),
    // RPC reports percent, not a fraction (0.5 means 0.5%, not 50%).
    usedPercent: typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)
      && window.usedPercent >= 0 && window.usedPercent <= 100 ? window.usedPercent : null,
    resetsAt: unixSecondsToIso(window.resetsAt),
    valueLabel: null,
    detail: null,
  };
}

function parseCreditBalance(value: string | number | null | undefined): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `$${value.toFixed(2)} remaining`;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return `$${parsed.toFixed(2)} remaining`;
    }
    return null;
  }
  return null;
}

export function mapCodexRpcQuota(result: CodexRpcRateLimitsResult, account?: CodexRpcAccountResult | null): CodexRpcQuotaSnapshot {
  const windows: QuotaWindow[] = [];
  const limitOrder = ["codex"];
  const limitsById = result.rateLimitsByLimitId ?? {};
  for (const key of Object.keys(limitsById)) {
    if (!limitOrder.includes(key)) limitOrder.push(key);
  }

  const rootLimit = result.rateLimits ?? null;
  const allLimits = new Map<string, CodexRpcLimit>();
  if (rootLimit?.limitId) allLimits.set(rootLimit.limitId, rootLimit);
  for (const [key, value] of Object.entries(limitsById)) {
    allLimits.set(key, value);
  }
  if (!allLimits.has("codex") && rootLimit) allLimits.set("codex", rootLimit);

  for (const limitId of limitOrder) {
    const limit = allLimits.get(limitId);
    if (!limit) continue;
    const prefix =
      limitId === "codex"
        ? ""
        : `${limit.limitName ?? limitId} · `;
    const primary = buildCodexRpcWindow(`${prefix}5h limit`, limit.primary);
    if (primary) windows.push(primary);
    const secondary = buildCodexRpcWindow(`${prefix}Weekly limit`, limit.secondary);
    if (secondary) windows.push(secondary);
    if (limitId === "codex" && limit.credits && limit.credits.unlimited !== true) {
      windows.push({
        label: "Credits",
        usedPercent: null,
        resetsAt: null,
        valueLabel: parseCreditBalance(limit.credits.balance) ?? "N/A",
        detail: null,
      });
    }
  }

  return {
    windows,
    email:
      typeof account?.account?.email === "string" && account.account.email.trim().length > 0
        ? account.account.email.trim()
        : null,
    planType:
      typeof account?.account?.planType === "string" && account.account.planType.trim().length > 0
        ? account.account.planType.trim()
        : (typeof rootLimit?.planType === "string" && rootLimit.planType.trim().length > 0 ? rootLimit.planType.trim() : null),
  };
}

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

class CodexRpcClient {
  // Inherit configured approvals. No model turn or command RPC is permitted.
  private proc = spawn(
    "codex",
    ["-s", "read-only", "app-server"],
    { stdio: ["pipe", "pipe", "pipe"], env: process.env },
  );

  private nextId = 1;
  private buffer = "";
  private pending = new Map<number, PendingRequest>();
  private stderr = "";

  constructor() {
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_QUOTA_ERROR_BODY_BYTES);
    });
    this.proc.on("exit", () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(quotaProbeError(this.stderr));
      }
      this.pending.clear();
    });
    this.proc.stdin.on?.("error", () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(quotaProbeError(""));
      }
      this.pending.clear();
    });
    this.proc.on("error", (err: Error) => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(quotaProbeError(err.message));
      }
      this.pending.clear();
    });
  }

  private onStdout(chunk: string) {
    this.buffer += chunk;
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      // Server requests (including approval/token refresh) are never executed.
      if (typeof parsed.method === "string") continue;
      const id = typeof parsed.id === "number" ? parsed.id : null;
      if (id == null) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (parsed.error) {
        const error = parsed.error as { code?: number; message?: string };
        pending.reject(quotaProbeError(typeof error.message === "string" ? error.message : "", error.code));
      } else {
        pending.resolve(parsed);
      }
    }
  }

  private request(method: string, params: Record<string, unknown> = {}, timeoutMs = 6_000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params }) + "\n";
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server timed out on ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(payload);
    });
  }

  private notify(method: string, params: Record<string, unknown> = {}) {
    this.proc.stdin.write(JSON.stringify({ method, params }) + "\n");
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: {
        name: "paperclip",
        version: "0.0.0",
      },
    });
    this.notify("initialized", {});
  }

  async fetchRateLimits(): Promise<CodexRpcRateLimitsResult> {
    const message = await this.request("account/rateLimits/read");
    return (message.result as CodexRpcRateLimitsResult | undefined) ?? {};
  }

  async shutdown() {
    this.proc.kill("SIGTERM");
  }
}

export async function fetchCodexRpcQuota(): Promise<CodexRpcQuotaSnapshot> {
  const client = new CodexRpcClient();
  try {
    await client.initialize();
    const limits = await client.fetchRateLimits();
    return mapCodexRpcQuota(limits);
  } finally {
    await client.shutdown();
  }
}

type QuotaFailureStatus = "auth_error" | "version_error" | "unavailable";

class QuotaProbeError extends Error {
  constructor(readonly quotaStatus: QuotaFailureStatus, readonly errorFamily?: CodexAuthRefreshFailureClass) {
    super(`Codex app-server: quota unknown (${quotaStatus})`);
  }
}

function quotaProbeError(message: string, code?: number): QuotaProbeError {
  const family = classifyCodexAuthRefreshFailure({ errorMessage: message });
  if (family || code === 401 || code === 403 || /\b(?:401|403|unauthorized|not authenticated|not logged in|authentication required)\b/i.test(message)) {
    return new QuotaProbeError("auth_error", family ?? undefined);
  }
  if (code === -32601 || /invalid value.*(?:ask-for-approval|untrusted)|unexpected argument|unrecognized (?:option|subcommand)/i.test(message)) {
    return new QuotaProbeError("version_error");
  }
  // Never return raw RPC errors, stderr, tokens, paths, or provider bodies.
  return new QuotaProbeError("unavailable");
}

export function readCodexQuotaErrorFamily(error: unknown): CodexAuthRefreshFailureClass | null {
  if (error instanceof CodexQuotaAuthError) return error.errorFamily;
  if (error instanceof QuotaProbeError) return error.errorFamily ?? null;
  const message = error instanceof Error ? error.message : String(error);
  return classifyCodexAuthRefreshFailure({ errorMessage: message });
}

interface QuotaState {
  key: string;
  lastSuccessful: ProviderQuotaResult["lastSuccessful"];
  authFailure?: ProviderQuotaResult;
  pending?: Promise<ProviderQuotaResult>;
}
let quotaState: QuotaState | undefined;

async function quotaContextKey(): Promise<string> {
  const home = codexHomeDir();
  // Metadata only. The collector never reads or copies credentials. A sign-in
  // or config change permits one new attempt; polling alone does not.
  const metadata = await Promise.all(["auth.json", "config.toml"].map(async (file) => {
    try {
      const stat = await fs.stat(path.join(home, file));
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch { return "missing"; }
  }));
  return JSON.stringify([home, ...metadata]);
}

async function collectQuota(state: QuotaState): Promise<ProviderQuotaResult> {
  try {
    const rpc = await fetchCodexRpcQuota();
    if (!rpc.windows.some(w => w.usedPercent !== null || (w.valueLabel !== null && w.valueLabel !== "N/A"))) {
      throw new QuotaProbeError("unavailable");
    }
    state.lastSuccessful = { observedAt: new Date().toISOString(), windows: rpc.windows };
    return { provider: "openai", source: CODEX_USAGE_SOURCE_RPC, ok: true,
      quotaStatus: "available", windows: rpc.windows, lastSuccessful: state.lastSuccessful };
  } catch (error) {
    const failure = error instanceof QuotaProbeError ? error : quotaProbeError("");
    const last = state.lastSuccessful;
    const history = last
      ? ` Last successful observation at ${last.observedAt} (historical): ${last.windows.map(w => `${w.label}: ${w.usedPercent === null ? "unknown" : `${w.usedPercent}% used`}`).join(", ")}.`
      : " No successful observation in this process for the current auth context.";
    const result: ProviderQuotaResult = {
      provider: "openai", source: CODEX_USAGE_SOURCE_RPC, ok: false,
      quotaStatus: failure.quotaStatus, error: failure.message + history,
      windows: [], lastSuccessful: last ?? null,
      ...(failure.errorFamily ? { errorFamily: failure.errorFamily } : {}),
    };
    if (failure.quotaStatus === "auth_error") {
      // A failed SDK refresh can update auth metadata. Latch the resulting
      // context, so that write alone cannot cause a polling refresh loop.
      state.key = await quotaContextKey();
      state.authFailure = result;
    }
    return result;
  }
}

export async function getQuotaWindows(): Promise<ProviderQuotaResult> {
  const key = await quotaContextKey();
  if (!quotaState || quotaState.key !== key) quotaState = { key, lastSuccessful: null };
  const state = quotaState;
  if (state.authFailure) return state.authFailure;
  if (!state.pending) {
    state.pending = collectQuota(state).finally(() => { state.pending = undefined; });
  }
  return state.pending;
}
