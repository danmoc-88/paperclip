import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { chatActions, type Db } from "@paperclipai/db";
import { z } from "zod";
import { SlackDecisionPolicyError } from "./slack-decision-policy.js";
import type { SlackDecisionAction, SlackDecisionResolutionDependencies } from "./slack-decision-resolution.js";

const KIND = "slack_decision_action";
const opaqueId = z.string().regex(/^pcsd:[A-Za-z0-9_-]{32}$/);
const id = z.string().min(1).max(255);
const bindingSchema = z.object({
  companyId: z.string().uuid(), endpointId: z.string().uuid(),
  issueId: z.string().uuid(), interactionId: z.string().uuid(),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  userId: id, workspaceId: id, slackUserId: id, channelId: id, appId: id,
  messageTimestamp: z.string().regex(/^\d+\.\d+$/).max(40),
  operation: z.enum(["accept", "reject", "answer"]),
  expiresAt: z.string().datetime(), viewId: id.optional(),
}).strict();

type Binding = z.infer<typeof bindingSchema>;
type Transaction = Parameters<SlackDecisionResolutionDependencies["authorizeAndConsume"]>[0];
type Writer = Pick<Db, "select" | "insert" | "update">;

/** Durable identity only: never store a signature, trigger, answer or source
 * text. Issuance is internal, after the publisher obtains a message receipt.
 * This ledger does not authorize a route or authenticate an HTTP callback.
 */
export async function issueSlackDecisionAction(db: Writer, binding: Binding, now = new Date()) {
  const parsed = bindingSchema.safeParse(binding);
  if (!parsed.success || !Number.isFinite(now.getTime()) || Date.parse(parsed.data.expiresAt) <= now.getTime()) {
    throw new SlackDecisionPolicyError();
  }
  const actionId = `pcsd:${randomBytes(24).toString("base64url")}`;
  await db.insert(chatActions).values({
    companyId: binding.companyId, endpointId: binding.endpointId,
    kind: KIND, providerActionId: actionId, status: "pending", payload: parsed.data,
  });
  return actionId;
}

export async function loadSlackDecisionAction(
  db: Pick<Db, "select">,
  scope: { companyId: string; endpointId: string; actionId: string },
  now = new Date(),
  lock = false,
) {
  if (!opaqueId.safeParse(scope.actionId).success || !Number.isFinite(now.getTime())) throw new SlackDecisionPolicyError();
  const query = db.select().from(chatActions).where(and(
    eq(chatActions.companyId, scope.companyId), eq(chatActions.endpointId, scope.endpointId),
    eq(chatActions.providerActionId, scope.actionId), eq(chatActions.kind, KIND), eq(chatActions.status, "pending"),
  ));
  const [record] = await (lock ? query.for("update") : query);
  const parsed = bindingSchema.safeParse(record?.payload);
  if (!record || !parsed.success || parsed.data.companyId !== scope.companyId ||
    parsed.data.endpointId !== scope.endpointId || Date.parse(parsed.data.expiresAt) <= now.getTime()) {
    throw new SlackDecisionPolicyError();
  }
  return { recordId: record.id, actionId: scope.actionId, ...parsed.data };
}

/** Bind the views.open receipt exactly once. The modal token has to exist
 * before that provider call; submissions remain invalid until this commits.
 * A timeout without a receipt must not guess a view ID or reuse the token for
 * another modal. Replaying the same confirmed receipt is harmless.
 */
export async function bindSlackDecisionActionView(
  db: Db,
  scope: { companyId: string; endpointId: string; actionId: string },
  viewId: string,
  now = new Date(),
) {
  if (!id.safeParse(viewId).success) throw new SlackDecisionPolicyError();
  await db.transaction(async (tx) => {
    const stored = await loadSlackDecisionAction(tx, scope, now, true);
    if (stored.operation === "accept" || (stored.viewId && stored.viewId !== viewId)) throw new SlackDecisionPolicyError();
    if (stored.viewId === viewId) return;
    const { recordId, actionId: _actionId, ...binding } = stored;
    await tx.update(chatActions).set({ payload: { ...binding, viewId }, updatedAt: now })
      .where(and(eq(chatActions.id, recordId), eq(chatActions.status, "pending")));
  });
}

/** Called only inside the canonical interaction transaction, after checking
 * current route, endpoint and user authorization under locks in that same
 * transaction. A rollback restores pending; concurrent consumers cannot win.
 * Comparing every bound field prevents a caller from changing operation/actor
 * after signature preflight. The receive time is supplied by the HTTP server.
 */
export async function consumeSlackDecisionAction(
  tx: Transaction,
  action: SlackDecisionAction,
  now = new Date(),
) {
  const stored = await loadSlackDecisionAction(tx, {
    companyId: action.companyId, endpointId: action.endpointId, actionId: action.id,
  }, now, true);
  const keys = ["companyId", "endpointId", "issueId", "interactionId", "sourceDigest", "userId",
    "workspaceId", "slackUserId", "channelId", "appId", "messageTimestamp", "operation"] as const;
  if (keys.some((key) => stored[key] !== action[key]) || !Number.isFinite(action.receivedAt.getTime())) {
    throw new SlackDecisionPolicyError();
  }
  const [consumed] = await tx.update(chatActions).set({
    status: "consumed", updatedAt: now,
    result: { receivedAt: action.receivedAt.toISOString(), consumedAt: now.toISOString() },
  }).where(and(eq(chatActions.id, stored.recordId), eq(chatActions.status, "pending"))).returning({ id: chatActions.id });
  if (!consumed) throw new SlackDecisionPolicyError();
}
