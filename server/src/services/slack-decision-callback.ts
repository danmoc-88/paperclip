import { z } from "zod";
import { SlackDecisionPolicyError } from "./slack-decision-policy.js";
import { slackRequestSignatureIsValid } from "./slack-request-authentication.js";

const id = z.string().min(1).max(255);
const token = z.string().regex(/^pcsd:[A-Za-z0-9_-]{32}$/);
const timestamp = z.string().regex(/^\d+\.\d+$/).max(40);
const identity = z.object({
  api_app_id: id,
  team: z.object({ id }),
  user: z.object({ id }),
});
const button = identity.extend({
  type: z.literal("block_actions"),
  container: z.object({ type: z.literal("message"), channel_id: id, message_ts: timestamp }),
  channel: z.object({ id }),
  message: z.object({ ts: timestamp }),
  actions: z.array(z.object({ type: z.literal("button"), action_id: token })).length(1),
  trigger_id: id.optional(),
});
const modal = identity.extend({
  type: z.enum(["view_submission", "view_closed"]),
  view: z.object({
    id,
    callback_id: token,
    // Only an opaque server-issued token. Never trust issue/actor/channel IDs
    // supplied through metadata or reconstruct a binding from those fields.
    private_metadata: token,
    state: z.object({ values: z.record(z.string(), z.record(z.string(), z.unknown())) }).optional(),
  }),
});

export interface SlackDecisionCallbackBinding {
  enabled: boolean;
  workspaceId: string;
  appId: string;
  slackUserId: string;
  channelId: string;
  messageTimestamp: string;
  actionId: string;
  expiresAt: Date;
  /** Bound to the views.open receipt before a submission can be resolved. */
  viewId?: string;
}

/** A cryptographic/identity preflight only. The caller still must load the
 * binding from the company+endpoint-scoped ledger, lock current membership and
 * route configuration, and consume the action inside the resolution transaction.
 * This function neither acknowledges delivery nor resolves a decision.
 */
export function authenticateSlackDecisionCallback(input: {
  headers: Headers;
  rawBody: Uint8Array;
  signingSecret: string;
  binding: SlackDecisionCallbackBinding;
  now: Date;
}) {
  const { binding, now } = input;
  if (!binding.enabled || !Number.isFinite(now.getTime()) ||
    !(binding.expiresAt.getTime() > now.getTime()) ||
    input.rawBody.byteLength > 256 * 1024 ||
    input.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded" ||
    !slackRequestSignatureIsValid(input, input.rawBody, input.signingSecret, now.getTime())) {
    throw new SlackDecisionPolicyError();
  }
  let value: unknown;
  try {
    const body = new TextDecoder("utf-8", { fatal: true }).decode(input.rawBody);
    const form = new URLSearchParams(body);
    const payloads = form.getAll("payload");
    if (payloads.length !== 1) throw new Error();
    value = JSON.parse(payloads[0]!);
  } catch {
    throw new SlackDecisionPolicyError();
  }
  const parsed = z.union([button, modal]).safeParse(value);
  if (!parsed.success) throw new SlackDecisionPolicyError();
  const payload = parsed.data;
  if (payload.api_app_id !== binding.appId || payload.team.id !== binding.workspaceId ||
    payload.user.id !== binding.slackUserId) throw new SlackDecisionPolicyError();
  if (payload.type === "block_actions") {
    if (payload.actions[0]!.action_id !== binding.actionId ||
      payload.container.channel_id !== binding.channelId || payload.channel.id !== binding.channelId ||
      payload.container.message_ts !== binding.messageTimestamp || payload.message.ts !== binding.messageTimestamp) {
      throw new SlackDecisionPolicyError();
    }
    return { kind: "button" as const, actionId: binding.actionId, triggerId: payload.trigger_id };
  }
  if (!binding.viewId || payload.view.id !== binding.viewId ||
    payload.view.callback_id !== binding.actionId || payload.view.private_metadata !== binding.actionId) {
    throw new SlackDecisionPolicyError();
  }
  if (payload.type === "view_closed") return { kind: "closed" as const, actionId: binding.actionId };
  if (!payload.view.state) throw new SlackDecisionPolicyError();
  // Values are untrusted answers, never identity or authorization. They must
  // pass the canonical complete-answer mapper before any transactional write.
  return { kind: "submission" as const, actionId: binding.actionId, values: payload.view.state.values };
}
