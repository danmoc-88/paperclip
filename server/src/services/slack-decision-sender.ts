import { and, eq, inArray, sql } from "drizzle-orm";
import { chatActions, type Db } from "@paperclipai/db";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { loadEnabledSlackDecisionRoute } from "./slack-decision-route.js";
import { commitSlackDecisionPublicationReceipt } from "./slack-decision-transport.js";

const DELIVERY_KIND = "slack_decision_delivery";
const BACKOFF_MS = [15_000, 30_000, 60_000];
const PUBLISH_STATUSES = ["pending", "retry"];
const BUTTON_STATUSES = ["button_retry"];
const UPDATE_STATUSES = ["update_pending", "update_retry"];
const UNKNOWN_STATUSES = ["delivery_unknown", "button_unknown", "update_unknown", "sending", "button_sending", "update_sending"];

type Writer = Pick<Db, "select" | "update">;

interface DeliveryPayload {
  mode?: string;
  interactionId?: string;
  issueId?: string;
  sourceDigest?: string;
  dedupeKey?: string;
  text?: string;
  cardUrl?: string;
  attempts?: number;
  nextAttemptAt?: string;
  messageTimestamp?: string;
  actionIds?: string[];
  buttonsAttached?: boolean;
  cancelledBeforeSend?: boolean;
  update?: { text?: string; attempts?: number; nextAttemptAt?: string };
}

export interface SlackDecisionOutbound {
  companyId: string;
  endpointId: string;
  channelId: string;
  dedupeKey: string;
  text: string;
  cardUrl: string;
  messageTimestamp?: string;
  /** Present only when the interactive flag is on and tokens already exist. */
  buttons?: Array<{ actionId: string; label: string }>;
}

export type SlackDecisionSendResult =
  | { outcome: "sent"; messageTimestamp: string }
  | { outcome: "retryable"; statusCode: 429 | 500 | 502 | 503 | 504 }
  | { outcome: "unknown" };

export type SlackDecisionInspectResult =
  | { outcome: "present"; messageTimestamp: string; text?: string }
  | { outcome: "absent" }
  | { outcome: "unknown" };

/** Test or future adapter. This module never constructs a Slack client. */
export interface SlackDecisionMessageTransport {
  post(message: SlackDecisionOutbound): Promise<SlackDecisionSendResult>;
  update(message: SlackDecisionOutbound & { messageTimestamp: string }): Promise<SlackDecisionSendResult>;
  inspect(query: { channelId: string; dedupeKey: string; messageTimestamp?: string }): Promise<SlackDecisionInspectResult>;
}

interface DispatchOptions {
  now?: Date;
  /** Default false. Tokens and buttons stay off until a caller opts in. */
  interactive?: boolean;
  /** Ids already delivered by the existing notification registry. */
  historicalKeys?: ReadonlySet<string>;
  staleClaimMs?: number;
}

function payloadOf(value: unknown): DeliveryPayload {
  return value && typeof value === "object" && !Array.isArray(value) ? value as DeliveryPayload : {};
}

function validTimestamp(value: string | undefined): value is string {
  return typeof value === "string" && value.length <= 40 && /^\d+\.\d+$/.test(value);
}

function due(status: string, payload: DeliveryPayload, now: Date) {
  if (status !== "retry" && status !== "button_retry" && status !== "update_retry") return true;
  const raw = status === "update_retry" ? payload.update?.nextAttemptAt : payload.nextAttemptAt;
  if (!raw) return true;
  const time = Date.parse(raw);
  return Number.isNaN(time) || time <= now.getTime();
}

function schedule(attempts: number, now: Date) {
  const next = attempts + 1;
  if (next > BACKOFF_MS.length) return { attempts: next, exhausted: true, nextAttemptAt: now.toISOString() };
  return {
    attempts: next,
    exhausted: false,
    nextAttemptAt: new Date(now.getTime() + BACKOFF_MS[next - 1]!).toISOString(),
  };
}

function historical(payload: DeliveryPayload, providerActionId: string, keys: ReadonlySet<string>) {
  if (keys.size === 0) return false;
  return [payload.interactionId, payload.issueId, payload.dedupeKey, payload.sourceDigest, providerActionId]
    .some((key) => typeof key === "string" && keys.has(key));
}

function formatWarsaw(at: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")} ${read("hour")}:${read("minute")}`;
}

function resolvedInstant(interaction: IssueThreadInteraction, now: Date) {
  const value = interaction.resolvedAt;
  const parsed = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : now;
}

/** Public result line. Rejection reasons and free-text answers stay in Paperclip. */
export function formatSlackDecisionResolutionLine(
  interaction: IssueThreadInteraction,
  cardUrl: string,
  at: Date,
) {
  let label = "Zamknięte w MyDay";
  if (interaction.status === "accepted") label = "Zatwierdź";
  else if (interaction.status === "rejected") label = "Odrzuć";
  else if (interaction.kind === "ask_user_questions" && interaction.status === "answered") {
    const answers = interaction.result?.answers ?? [];
    const privateText = answers.some((answer) => answer.otherText?.trim());
    const labels = privateText ? [] : answers.flatMap((answer) => {
      const question = interaction.payload.questions.find((item) => item.id === answer.questionId);
      return answer.optionIds.map((optionId) => question?.options.find((option) => option.id === optionId)?.label ?? "");
    });
    label = labels.length > 0 && labels.every((item) => item.length > 0 && item.length <= 80) && labels.join(", ").length <= 120
      ? labels.join(", ")
      : "Odpowiedź zapisana w MyDay";
  }
  return `Daniel · ${formatWarsaw(at)} Europe/Warsaw · ${label}\nOtwórz kartę: ${cardUrl}`;
}

function buttonSpecs(actionIds: string[]) {
  const labels = actionIds.length === 2 ? ["Zatwierdź", "Odrzuć"] : ["Odpowiedz"];
  return actionIds.map((actionId, index) => ({ actionId, label: labels[index] ?? "Otwórz kartę" }));
}

/**
 * Queues the original-message replacement, or cancels a send that has no
 * receipt. Does not call Slack and does not resolve the card again.
 */
export async function enqueueSlackDecisionOriginalUpdate(
  db: Writer,
  interaction: IssueThreadInteraction,
  now = new Date(),
) {
  if (interaction.status === "pending") return;
  const rows = await db.select().from(chatActions).where(and(
    eq(chatActions.companyId, interaction.companyId),
    eq(chatActions.kind, DELIVERY_KIND),
    eq(sql<string>`${chatActions.payload}->>'interactionId'`, interaction.id),
  )).for("update");
  for (const row of rows) {
    const payload = payloadOf(row.payload);
    if (!validTimestamp(payload.messageTimestamp)) {
      if (PUBLISH_STATUSES.includes(row.status) || row.status === "sending") {
        await db.update(chatActions).set({
          status: "cancelled",
          payload: { ...payload, cancelledBeforeSend: true },
          updatedAt: now,
        }).where(eq(chatActions.id, row.id));
      }
      continue;
    }
    if (!payload.cardUrl || row.status === "updated") continue;
    const text = formatSlackDecisionResolutionLine(interaction, payload.cardUrl, resolvedInstant(interaction, now));
    if (payload.update?.text === text && (row.status === "update_pending" || row.status === "updated")) continue;
    await db.update(chatActions).set({
      status: "update_pending",
      payload: {
        ...payload,
        update: { text, attempts: payload.update?.text === text ? payload.update.attempts ?? 0 : 0 },
      },
      updatedAt: now,
    }).where(eq(chatActions.id, row.id));
  }
}

async function claim(
  db: Db,
  id: string,
  statuses: string[],
  now: Date,
) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(chatActions).where(eq(chatActions.id, id)).for("update");
    if (!row || !statuses.includes(row.status)) return null;
    const payload = payloadOf(row.payload);
    if (!due(row.status, payload, now)) return null;
    const next = row.status === "update_pending" || row.status === "update_retry"
      ? "update_sending"
      : row.status === "button_retry"
        ? "button_sending"
        : "sending";
    await tx.update(chatActions).set({ status: next, updatedAt: now }).where(eq(chatActions.id, id));
    return { ...row, status: next, payload };
  });
}

/**
 * One owner for company decision messages. Unknown results are not posted
 * again until reconciliation. The interactive flag defaults off, and this
 * function does not open a Slack connection by itself.
 */
export async function dispatchSlackDecisionDeliveries(
  db: Db,
  transport: SlackDecisionMessageTransport,
  options: DispatchOptions = {},
) {
  const now = options.now ?? new Date();
  const interactive = options.interactive === true;
  const historicalKeys = options.historicalKeys ?? new Set<string>();
  const rows = await db.select().from(chatActions).where(eq(chatActions.kind, DELIVERY_KIND));
  for (const candidate of rows) {
    const payload = payloadOf(candidate.payload);
    if (historical(payload, candidate.providerActionId, historicalKeys)
      && ["pending", "retry", "update_pending", "update_retry", "button_retry"].includes(candidate.status)) {
      await db.update(chatActions).set({ status: "skipped_historical", updatedAt: now }).where(and(
        eq(chatActions.id, candidate.id),
        inArray(chatActions.status, ["pending", "retry", "update_pending", "update_retry", "button_retry"]),
      ));
      continue;
    }
    const wanted = payload.update?.text && UPDATE_STATUSES.includes(candidate.status)
      ? UPDATE_STATUSES
      : BUTTON_STATUSES.includes(candidate.status)
        ? BUTTON_STATUSES
        : PUBLISH_STATUSES;
    if (!wanted.includes(candidate.status)) continue;
    const route = await loadEnabledSlackDecisionRoute(db, candidate.companyId);
    if (!route || route.endpointId !== candidate.endpointId) continue;
    const claimed = await claim(db, candidate.id, wanted, now);
    if (!claimed) continue;
    const current = payloadOf(claimed.payload);
    if (!current.text?.includes(current.cardUrl ?? "\0") || !current.dedupeKey || !current.cardUrl
      || (wanted !== PUBLISH_STATUSES && !validTimestamp(current.messageTimestamp))) {
      await db.update(chatActions).set({ status: "failed", updatedAt: now }).where(eq(chatActions.id, claimed.id));
      continue;
    }
    const outbound: SlackDecisionOutbound = {
      companyId: claimed.companyId,
      endpointId: claimed.endpointId,
      channelId: route.channelId,
      dedupeKey: current.dedupeKey,
      text: wanted === UPDATE_STATUSES ? current.update!.text! : current.text,
      cardUrl: current.cardUrl,
      messageTimestamp: current.messageTimestamp,
    };
    if (wanted === BUTTON_STATUSES) outbound.buttons = buttonSpecs(current.actionIds ?? []);
    const result = wanted === PUBLISH_STATUSES
      ? await transport.post(outbound)
      : await transport.update({ ...outbound, messageTimestamp: current.messageTimestamp ?? "" });
    await applyTransportResult(db, transport, claimed.id, wanted, interactive, result, now);
  }
}

async function applyTransportResult(
  db: Db,
  transport: SlackDecisionMessageTransport,
  id: string,
  phase: string[],
  interactive: boolean,
  result: SlackDecisionSendResult,
  now: Date,
) {
  const [row] = await db.select().from(chatActions).where(eq(chatActions.id, id));
  if (!row) return;
  const payload = payloadOf(row.payload);
  const attempts = phase === UPDATE_STATUSES ? payload.update?.attempts ?? 0 : payload.attempts ?? 0;
  if (result.outcome === "retryable") {
    const retry = schedule(attempts, now);
    if (phase === UPDATE_STATUSES) {
      await db.update(chatActions).set({
        status: retry.exhausted ? "failed" : "update_retry",
        payload: { ...payload, update: { ...payload.update, attempts: retry.attempts, nextAttemptAt: retry.nextAttemptAt } },
        updatedAt: now,
      }).where(eq(chatActions.id, id));
      return;
    }
    await db.update(chatActions).set({
      status: retry.exhausted ? "failed" : phase === BUTTON_STATUSES ? "button_retry" : "retry",
      payload: { ...payload, attempts: retry.attempts, nextAttemptAt: retry.nextAttemptAt },
      updatedAt: now,
    }).where(eq(chatActions.id, id));
    return;
  }
  if (result.outcome !== "sent" || !validTimestamp(result.messageTimestamp)) {
    await db.update(chatActions).set({
      status: phase === UPDATE_STATUSES ? "update_unknown" : phase === BUTTON_STATUSES ? "button_unknown" : "delivery_unknown",
      updatedAt: now,
    }).where(eq(chatActions.id, id));
    return;
  }
  if (phase === UPDATE_STATUSES) {
    await db.update(chatActions).set({
      status: "updated",
      payload: { ...payload, messageTimestamp: payload.messageTimestamp ?? result.messageTimestamp },
      updatedAt: now,
    }).where(eq(chatActions.id, id));
    return;
  }
  if (phase === BUTTON_STATUSES) {
    await db.update(chatActions).set({
      status: "sent",
      payload: { ...payload, buttonsAttached: true, messageTimestamp: payload.messageTimestamp },
      updatedAt: now,
    }).where(eq(chatActions.id, id));
    return;
  }
  const sent = { ...payload, messageTimestamp: result.messageTimestamp, awaitingReceipt: false };
  await db.update(chatActions).set({ status: "sent", payload: sent, updatedAt: now }).where(eq(chatActions.id, id));
  if (!interactive || payload.mode !== "decision" || !payload.interactionId) return;
  const interaction = await issueThreadInteractionService(db).getById(payload.interactionId);
  if (!interaction) return;
  try {
    const actionIds = await commitSlackDecisionPublicationReceipt(db, interaction, result.messageTimestamp, now);
    const [fresh] = await db.select().from(chatActions).where(eq(chatActions.id, id));
    const freshPayload = payloadOf(fresh?.payload);
    const route = await loadEnabledSlackDecisionRoute(db, row.companyId);
    if (!route || !freshPayload.dedupeKey || !freshPayload.cardUrl || !freshPayload.text) return;
    const buttonResult = await transport.update({
      companyId: row.companyId,
      endpointId: row.endpointId,
      channelId: route.channelId,
      dedupeKey: freshPayload.dedupeKey,
      text: freshPayload.text,
      cardUrl: freshPayload.cardUrl,
      messageTimestamp: result.messageTimestamp,
      buttons: buttonSpecs(actionIds),
    });
    await db.update(chatActions).set({
      status: "button_sending",
      payload: { ...freshPayload, actionIds },
      updatedAt: now,
    }).where(eq(chatActions.id, id));
    await applyTransportResult(db, transport, id, BUTTON_STATUSES, false, buttonResult, now);
  } catch {
    // The root message is already recorded. Leave it as a link; do not post another one.
  }
}

/**
 * Repairs a lost receipt or a lost original-message update. A present message
 * is adopted. An absent unpublished message may be retried once the unknown
 * state is cleared. Nothing here resolves a card a second time.
 */
export async function reconcileSlackDecisionDeliveries(
  db: Db,
  transport: SlackDecisionMessageTransport,
  options: DispatchOptions = {},
) {
  const now = options.now ?? new Date();
  const staleBefore = now.getTime() - (options.staleClaimMs ?? 60_000);
  const rows = await db.select().from(chatActions).where(eq(chatActions.kind, DELIVERY_KIND));
  for (const row of rows) {
    const payload = payloadOf(row.payload);
    if (row.status === "sent" && payload.interactionId && validTimestamp(payload.messageTimestamp)) {
      const interaction = await issueThreadInteractionService(db).getById(payload.interactionId);
      if (interaction && interaction.status !== "pending") await enqueueSlackDecisionOriginalUpdate(db, interaction, now);
      continue;
    }
    const staleClaim = ["sending", "button_sending", "update_sending"].includes(row.status)
      && row.updatedAt.getTime() <= staleBefore;
    if (!UNKNOWN_STATUSES.includes(row.status) || (["sending", "button_sending", "update_sending"].includes(row.status) && !staleClaim)) {
      continue;
    }
    const route = await loadEnabledSlackDecisionRoute(db, row.companyId);
    if (!route || !payload.dedupeKey) continue;
    const inspected = await transport.inspect({
      channelId: route.channelId,
      dedupeKey: payload.dedupeKey,
      messageTimestamp: payload.messageTimestamp,
    });
    if (inspected.outcome === "unknown") continue;
    if (row.status === "update_unknown" || row.status === "update_sending") {
      if (inspected.outcome === "absent" || !validTimestamp(payload.messageTimestamp)) {
        await db.update(chatActions).set({ status: "failed", updatedAt: now }).where(eq(chatActions.id, row.id));
        continue;
      }
      const text = payload.update?.text;
      const applied = typeof inspected.text === "string" && typeof text === "string" && inspected.text === text;
      await db.update(chatActions).set({
        status: applied ? "updated" : "update_pending",
        updatedAt: now,
      }).where(eq(chatActions.id, row.id));
      continue;
    }
    if (inspected.outcome === "present" && validTimestamp(inspected.messageTimestamp)) {
      await db.update(chatActions).set({
        status: row.status === "button_unknown" || row.status === "button_sending" ? "button_retry" : "sent",
        payload: { ...payload, messageTimestamp: inspected.messageTimestamp },
        updatedAt: now,
      }).where(eq(chatActions.id, row.id));
      continue;
    }
    const attempts = payload.attempts ?? 0;
    await db.update(chatActions).set({
      status: attempts > BACKOFF_MS.length ? "failed" : "pending",
      updatedAt: now,
    }).where(eq(chatActions.id, row.id));
  }
}
