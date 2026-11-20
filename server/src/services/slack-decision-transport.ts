import { and, eq } from "drizzle-orm";
import { chatActions, chatEndpoints, companyMemberships, type Db } from "@paperclipai/db";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import { prepareSlackDecisionPublication } from "./chat-interaction-publications.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import {
  bindSlackDecisionActionView,
  consumeSlackDecisionAction,
  issueSlackDecisionAction,
  loadSlackDecisionAction,
} from "./slack-decision-action-ledger.js";
import { authenticateSlackDecisionCallback } from "./slack-decision-callback.js";
import { loadSlackDecisionDisclosure } from "./slack-decision-disclosures.js";
import { buildSlackDecisionModal, mapSlackDecisionModalSubmission } from "./slack-decision-modal.js";
import { SlackDecisionPolicyError, slackDecisionSourceDigest } from "./slack-decision-policy.js";
import { slackDecisionResolutionService, type SlackDecisionAction } from "./slack-decision-resolution.js";
import { loadEnabledSlackDecisionRoute, type SlackDecisionRoute } from "./slack-decision-route.js";
import { slackRequestSignatureIsValid } from "./slack-request-authentication.js";
import { logger } from "../middleware/logger.js";

const DELIVERY_KIND = "slack_decision_delivery";
const deliveryKey = (interactionId: string, sourceDigest: string) =>
  `slack-decision-delivery:${interactionId}:${sourceDigest}`;

type Writer = Pick<Db, "select" | "insert" | "update">;

export interface SlackDecisionCallbackResult {
  status: number;
  /** In-process only. The HTTP ack stays empty and this is never posted to Slack. */
  modal?: unknown;
}

function deliveryPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sameRoute(route: SlackDecisionRoute, action: {
  workspaceId: string; appId: string; slackUserId: string; channelId: string; userId: string;
}) {
  return route.workspaceId === action.workspaceId && route.appId === action.appId
    && route.slackUserId === action.slackUserId && route.channelId === action.channelId
    && route.userId === action.userId;
}

/** Claims one company delivery for this source revision. Disabled routes write
 * nothing. Decision tokens are not issued here: that waits for a message receipt.
 * This function does not call Slack.
 */
export async function planCompanySlackDecisionDelivery(
  db: Writer,
  interaction: IssueThreadInteraction,
  now = new Date(),
) {
  if (interaction.status !== "pending") return { mode: "disabled" as const };
  if (interaction.kind !== "request_confirmation" && interaction.kind !== "ask_user_questions") {
    return { mode: "disabled" as const };
  }
  const route = await loadEnabledSlackDecisionRoute(db, interaction.companyId);
  if (!route) return { mode: "disabled" as const };
  const prepared = await prepareSlackDecisionPublication(db, interaction, {
    companyId: route.companyId,
    endpointId: route.endpointId,
    userId: route.userId,
    publicBaseUrl: route.publicBaseUrl,
  }, now);
  if (!prepared) return { mode: "disabled" as const };
  const sourceDigest = slackDecisionSourceDigest(interaction);
  await db.insert(chatActions).values({
    companyId: route.companyId,
    endpointId: route.endpointId,
    kind: DELIVERY_KIND,
    providerActionId: deliveryKey(interaction.id, sourceDigest),
    status: "pending",
    payload: {
      mode: prepared.mode,
      interactionId: interaction.id,
      sourceDigest,
      awaitingReceipt: prepared.mode === "decision",
    },
  }).onConflictDoNothing({ target: [chatActions.endpointId, chatActions.providerActionId] });
  return { mode: prepared.mode };
}

/** Issues one-use actions only after the publisher has a message timestamp.
 * Still does not send or update a Slack message.
 */
export async function commitSlackDecisionPublicationReceipt(
  db: Db,
  interaction: IssueThreadInteraction,
  messageTimestamp: string,
  now = new Date(),
) {
  if (!/^\d+\.\d+$/.test(messageTimestamp) || messageTimestamp.length > 40) throw new SlackDecisionPolicyError();
  const route = await loadEnabledSlackDecisionRoute(db, interaction.companyId);
  if (!route) throw new SlackDecisionPolicyError();
  const prepared = await prepareSlackDecisionPublication(db, interaction, {
    companyId: route.companyId, endpointId: route.endpointId, userId: route.userId, publicBaseUrl: route.publicBaseUrl,
  }, now);
  if (prepared?.mode !== "decision") throw new SlackDecisionPolicyError();
  const disclosure = await loadSlackDecisionDisclosure(db, {
    companyId: route.companyId, endpointId: route.endpointId, interactionId: interaction.id,
  });
  if (!disclosure) throw new SlackDecisionPolicyError();
  const sourceDigest = slackDecisionSourceDigest(interaction);
  const operations = interaction.kind === "request_confirmation"
    ? (["accept", "reject"] as const)
    : (["answer"] as const);
  return db.transaction(async (tx) => {
    const [delivery] = await tx.select().from(chatActions).where(and(
      eq(chatActions.companyId, route.companyId),
      eq(chatActions.endpointId, route.endpointId),
      eq(chatActions.kind, DELIVERY_KIND),
      eq(chatActions.providerActionId, deliveryKey(interaction.id, sourceDigest)),
      eq(chatActions.status, "pending"),
    )).for("update");
    const payload = deliveryPayload(delivery?.payload);
    if (!delivery || payload.interactionId !== interaction.id || payload.sourceDigest !== sourceDigest) {
      throw new SlackDecisionPolicyError();
    }
    if (typeof payload.messageTimestamp === "string" && payload.messageTimestamp !== messageTimestamp) {
      throw new SlackDecisionPolicyError();
    }
    const existing = Array.isArray(payload.actionIds) ? payload.actionIds.filter((item): item is string => typeof item === "string") : [];
    if (existing.length > 0) return existing;
    const actionIds: string[] = [];
    for (const operation of operations) {
      actionIds.push(await issueSlackDecisionAction(tx, {
        companyId: route.companyId,
        endpointId: route.endpointId,
        issueId: interaction.issueId,
        interactionId: interaction.id,
        sourceDigest,
        userId: route.userId,
        workspaceId: route.workspaceId,
        slackUserId: route.slackUserId,
        channelId: route.channelId,
        appId: route.appId,
        messageTimestamp,
        operation,
        expiresAt: disclosure.expiresAt,
      }, now));
    }
    await tx.update(chatActions).set({
      payload: { mode: "decision", interactionId: interaction.id, sourceDigest, messageTimestamp, actionIds },
      updatedAt: now,
    }).where(eq(chatActions.id, delivery.id));
    return actionIds;
  });
}

/** Binds a views.open receipt. Does not call Slack and does not resolve the card. */
export async function recordSlackDecisionModalReceipt(
  db: Db,
  scope: { companyId: string; endpointId: string; actionId: string },
  viewId: string,
  now = new Date(),
) {
  const route = await loadEnabledSlackDecisionRoute(db, scope.companyId);
  if (!route || route.endpointId !== scope.endpointId) throw new SlackDecisionPolicyError();
  const stored = await loadSlackDecisionAction(db, scope, now);
  if (!sameRoute(route, stored)) throw new SlackDecisionPolicyError();
  await bindSlackDecisionActionView(db, scope, viewId, now);
}

function opaqueActionId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const token = /^pcsd:[A-Za-z0-9_-]{32}$/;
  if (record.type === "block_actions" && Array.isArray(record.actions) && record.actions.length === 1) {
    const action = record.actions[0] as { action_id?: unknown } | null;
    return typeof action?.action_id === "string" && token.test(action.action_id) ? action.action_id : null;
  }
  const view = record.view as { callback_id?: unknown; private_metadata?: unknown } | undefined;
  if ((record.type === "view_submission" || record.type === "view_closed") && view
    && view.callback_id === view.private_metadata && typeof view.callback_id === "string" && token.test(view.callback_id)) {
    return view.callback_id;
  }
  return null;
}

/**
 * Company decision ingress. A missing or disabled route is a 404 and does not
 * parse the body. Signature verification uses the captured bytes before the
 * payload is trusted. Nothing in this function sends a Slack request.
 */
export async function handleSlackDecisionCallback(
  db: Db,
  input: {
    publicId: string;
    headers: Headers;
    rawBody: Uint8Array;
    readSigningSecret: () => Promise<string | null>;
    now?: Date;
  },
): Promise<SlackDecisionCallbackResult> {
  const now = input.now ?? new Date();
  const [endpoint] = await db.select().from(chatEndpoints).where(and(
    eq(chatEndpoints.publicId, input.publicId),
    eq(chatEndpoints.provider, "slack"),
  ));
  if (!endpoint || endpoint.status === "archived") return { status: 404 };
  const route = await loadEnabledSlackDecisionRoute(db, endpoint.companyId);
  if (!route || route.endpointId !== endpoint.id) return { status: 404 };
  let signingSecret: string | null;
  try {
    signingSecret = await input.readSigningSecret();
  } catch {
    return { status: 401 };
  }
  if (!signingSecret || !slackRequestSignatureIsValid(
    { headers: input.headers }, input.rawBody, signingSecret, now.getTime(),
  )) return { status: 401 };

  try {
    const body = new TextDecoder("utf-8", { fatal: true }).decode(input.rawBody);
    const payloads = new URLSearchParams(body).getAll("payload");
    if (payloads.length !== 1) throw new SlackDecisionPolicyError();
    const actionId = opaqueActionId(JSON.parse(payloads[0]!));
    if (!actionId) throw new SlackDecisionPolicyError();
    const stored = await loadSlackDecisionAction(db, {
      companyId: route.companyId, endpointId: route.endpointId, actionId,
    }, now);
    if (!sameRoute(route, stored)) throw new SlackDecisionPolicyError();
    const authenticated = authenticateSlackDecisionCallback({
      headers: input.headers,
      rawBody: input.rawBody,
      signingSecret,
      now,
      binding: {
        enabled: true,
        workspaceId: stored.workspaceId,
        appId: stored.appId,
        slackUserId: stored.slackUserId,
        channelId: stored.channelId,
        messageTimestamp: stored.messageTimestamp,
        actionId: stored.actionId,
        expiresAt: new Date(stored.expiresAt),
        viewId: stored.viewId,
      },
    });
    const action: SlackDecisionAction = {
      id: stored.actionId,
      companyId: stored.companyId,
      endpointId: stored.endpointId,
      issueId: stored.issueId,
      interactionId: stored.interactionId,
      sourceDigest: stored.sourceDigest,
      userId: stored.userId,
      workspaceId: stored.workspaceId,
      slackUserId: stored.slackUserId,
      channelId: stored.channelId,
      appId: stored.appId,
      messageTimestamp: stored.messageTimestamp,
      operation: stored.operation,
      receivedAt: now,
    };
    if (authenticated.kind === "closed") return { status: 200 };
    if (authenticated.kind === "button" && action.operation !== "accept") {
      const interaction = await issueThreadInteractionService(db).getById(action.interactionId);
      if (!interaction) return { status: 200 };
      const modal = buildSlackDecisionModal(interaction, {
        companyId: action.companyId,
        userId: action.userId,
        now,
        disclosure: await loadSlackDecisionDisclosure(db, {
          companyId: action.companyId, endpointId: action.endpointId, interactionId: action.interactionId,
        }),
      }, route.publicBaseUrl, action.id);
      return { status: 200, modal };
    }
    let resolutionInput: unknown = {};
    if (authenticated.kind === "submission") {
      if (action.operation === "accept") throw new SlackDecisionPolicyError();
      const interaction = await issueThreadInteractionService(db).getById(action.interactionId);
      if (!interaction) throw new SlackDecisionPolicyError();
      const submission = mapSlackDecisionModalSubmission(interaction, {
        companyId: action.companyId,
        userId: action.userId,
        now,
        disclosure: await loadSlackDecisionDisclosure(db, {
          companyId: action.companyId, endpointId: action.endpointId, interactionId: action.interactionId,
        }),
      }, authenticated.values);
      if (submission.method === "acceptInteraction") throw new SlackDecisionPolicyError();
      resolutionInput = submission.input;
    }
    await slackDecisionResolutionService(db, {
      enabled: true,
      authorizeAndConsume: async (tx, candidate) => {
        const current = await loadEnabledSlackDecisionRoute(tx, candidate.companyId, undefined, true);
        if (!current || current.endpointId !== candidate.endpointId || !sameRoute(current, candidate)) {
          throw new SlackDecisionPolicyError();
        }
        const [member] = await tx.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
          eq(companyMemberships.companyId, candidate.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, candidate.userId),
          eq(companyMemberships.status, "active"),
        )).for("share");
        if (!member) throw new SlackDecisionPolicyError();
        await consumeSlackDecisionAction(tx, candidate, now);
      },
    }).resolve(action, resolutionInput);
    return { status: 200 };
  } catch (error) {
    if (error instanceof SlackDecisionPolicyError) return { status: 200 };
    logger.warn("Slack decision callback failed closed");
    return { status: 500 };
  }
}
