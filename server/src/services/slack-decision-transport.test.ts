import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  chatActions,
  chatEndpoints,
  companies,
  companyMemberships,
  createDb,
  goals,
  instanceSettings,
  instanceUserRoles,
  issueThreadInteractions,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { instanceSettingsService } from "./instance-settings.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { slackDecisionDisclosureService } from "./slack-decision-disclosures.js";
import { slackDecisionSourceDigest } from "./slack-decision-policy.js";
import {
  dispatchSlackDecisionDeliveries,
  reconcileSlackDecisionDeliveries,
  type SlackDecisionMessageTransport,
  type SlackDecisionSendResult,
} from "./slack-decision-sender.js";
import {
  commitSlackDecisionPublicationReceipt,
  handleSlackDecisionCallback,
  planCompanySlackDecisionDelivery,
  recordSlackDecisionModalReceipt,
  slackDecisionDeliveryDedupeKey,
} from "./slack-decision-transport.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping Slack decision transport tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

const secret = "decision-signing-secret";

function signedRequest(payload: unknown, timestamp = String(Math.floor(Date.now() / 1000))) {
  const raw = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const rawBody = new TextEncoder().encode(raw);
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:`).update(rawBody).digest("hex")}`;
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
  });
  return { headers, rawBody };
}

describeEmbeddedPostgres("slack decision transport", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-slack-decision-transport-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(chatActions);
    await db.delete(chatEndpoints);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companyMemberships);
    await db.delete(instanceUserRoles);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(prompt = "Use this direction?") {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const endpointId = randomUUID();
    const publicId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({ id: goalId, companyId, title: "Direction", level: "task", status: "active" });
    await db.insert(issues).values({
      id: issueId, companyId, goalId, title: "Parent issue", status: "in_progress", priority: "medium",
    });
    await db.insert(agents).values({ id: agentId, companyId, name: "Test", role: "operator", adapterType: "process" });
    await db.insert(toolApplications).values({
      id: applicationId, companyId, applicationKey: `test-${applicationId}`, name: "Test", type: "chat",
    });
    await db.insert(toolConnections).values({
      id: connectionId, companyId, applicationId, name: "Test", uid: connectionId,
      connectionPurpose: "channel", transport: "chat_sdk",
    });
    await db.insert(chatEndpoints).values({
      id: endpointId, companyId, connectionId, provider: "slack", publicId, assignedAgentId: agentId,
    });
    const interaction = await issueThreadInteractionService(db).create({ id: issueId, companyId }, {
      kind: "request_confirmation", resolverPolicy: "human_only", continuationPolicy: "none",
      payload: { version: 1, prompt },
    }, { userId: "local-board" });
    return { companyId, issueId, endpointId, publicId, interaction };
  }

  async function grantRoute(companyId: string, endpointId: string, enabled = true) {
    await db.insert(chatActions).values({
      companyId, endpointId, kind: "slack_decision_route", providerActionId: "slack-decision-route",
      status: enabled ? "granted" : "revoked",
      payload: {
        enabled: true, workspaceId: "T1", appId: "A1", slackUserId: "U1", channelId: "C1",
        userId: "local-board", publicBaseUrl: "https://myday.example.com",
      },
    });
  }

  function button(actionId: string, userId = "U1") {
    return {
      type: "block_actions", api_app_id: "A1", team: { id: "T1" }, user: { id: userId },
      container: { type: "message", channel_id: "C1", message_ts: "123.456" },
      channel: { id: "C1" }, message: { ts: "123.456" },
      actions: [{ type: "button", action_id: actionId }], trigger_id: "trigger",
    };
  }

  it("stays off without a granted route and does not issue actions or resolve a signed click", async () => {
    const { companyId, endpointId, publicId, interaction } = await seed();
    expect(await planCompanySlackDecisionDelivery(db, interaction)).toEqual({ mode: "disabled" });
    expect(await db.select().from(chatActions).where(eq(chatActions.kind, "slack_decision_delivery"))).toHaveLength(0);
    const request = signedRequest(button("pcsd:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    const refused = await handleSlackDecisionCallback(db, {
      publicId, ...request, readSigningSecret: async () => secret,
    });
    expect(refused.status).toBe(404);
    expect((await issueThreadInteractionService(db).getById(interaction.id))?.status).toBe("pending");

    await grantRoute(companyId, endpointId, false);
    expect(await planCompanySlackDecisionDelivery(db, interaction)).toEqual({ mode: "disabled" });
  });

  it("claims one delivery, resolves one signed accept, and refuses a bad signature", async () => {
    const { companyId, endpointId, publicId, interaction } = await seed();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await slackDecisionDisclosureService(db).update(endpointId, interaction.id, {
      disclosure: { sourceDigest: slackDecisionSourceDigest(interaction), topic: "product_direction", expiresAt },
    }, "local-board");
    await grantRoute(companyId, endpointId);
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "local-board", status: "active",
    });
    expect(await planCompanySlackDecisionDelivery(db, interaction, new Date(), { interactive: true })).toEqual({ mode: "decision" });
    expect(await planCompanySlackDecisionDelivery(db, interaction, new Date(), { interactive: true })).toEqual({ mode: "decision" });
    const deliveries = await db.select().from(chatActions).where(eq(chatActions.kind, "slack_decision_delivery"));
    expect(deliveries).toHaveLength(1);
    expect(JSON.stringify(deliveries[0]?.payload)).not.toContain("pcsd:");
    const actionIds = await commitSlackDecisionPublicationReceipt(db, interaction, "123.456");
    expect(await commitSlackDecisionPublicationReceipt(db, interaction, "123.456")).toEqual(actionIds);
    await expect(commitSlackDecisionPublicationReceipt(db, interaction, "124.456")).rejects.toThrow("requires a response in MyDay");
    const acceptId = actionIds[0]!;
    const bad = signedRequest(button(acceptId));
    bad.headers.set("x-slack-signature", "v0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect((await handleSlackDecisionCallback(db, {
      publicId, ...bad, readSigningSecret: async () => secret,
    })).status).toBe(401);
    const foreign = await handleSlackDecisionCallback(db, {
      publicId, ...signedRequest(button(acceptId, "U-other")), readSigningSecret: async () => secret,
    });
    expect(foreign.status).toBe(200);
    expect((await issueThreadInteractionService(db).getById(interaction.id))?.status).toBe("pending");
    const accepted = await handleSlackDecisionCallback(db, {
      publicId, ...signedRequest(button(acceptId)), readSigningSecret: async () => secret,
    });
    expect(accepted).toEqual({ status: 200 });
    expect((await issueThreadInteractionService(db).getById(interaction.id))?.status).toBe("accepted");
    const replay = await handleSlackDecisionCallback(db, {
      publicId, ...signedRequest(button(acceptId)), readSigningSecret: async () => secret,
    });
    expect(replay.status).toBe(200);
    const audits = await db.select().from(activityLog).where(eq(activityLog.action, "slack.decision_resolved"));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).not.toContain(secret);
  });

  it("prepares a rejection modal without resolving until the bound submission", async () => {
    const { companyId, endpointId, publicId, interaction } = await seed();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await slackDecisionDisclosureService(db).update(endpointId, interaction.id, {
      disclosure: { sourceDigest: slackDecisionSourceDigest(interaction), topic: "product_direction", expiresAt },
    }, "local-board");
    await grantRoute(companyId, endpointId);
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "local-board", status: "active",
    });
    await planCompanySlackDecisionDelivery(db, interaction, new Date(), { interactive: true });
    const actionIds = await commitSlackDecisionPublicationReceipt(db, interaction, "123.456");
    const rejectId = actionIds[1]!;
    const opened = await handleSlackDecisionCallback(db, {
      publicId, ...signedRequest(button(rejectId)), readSigningSecret: async () => secret,
    });
    expect(opened.status).toBe(200);
    expect(opened.modal).toMatchObject({ callback_id: rejectId, private_metadata: rejectId });
    expect((await issueThreadInteractionService(db).getById(interaction.id))?.status).toBe("pending");
    await recordSlackDecisionModalReceipt(db, { companyId, endpointId, actionId: rejectId }, "V1");
    const closed = await handleSlackDecisionCallback(db, {
      publicId,
      ...signedRequest({
        type: "view_closed", api_app_id: "A1", team: { id: "T1" }, user: { id: "U1" },
        view: { id: "V1", callback_id: rejectId, private_metadata: rejectId },
      }),
      readSigningSecret: async () => secret,
    });
    expect(closed).toEqual({ status: 200 });
    expect((await issueThreadInteractionService(db).getById(interaction.id))?.status).toBe("pending");
    const submitted = await handleSlackDecisionCallback(db, {
      publicId,
      ...signedRequest({
        type: "view_submission", api_app_id: "A1", team: { id: "T1" }, user: { id: "U1" },
        view: {
          id: "V1", callback_id: rejectId, private_metadata: rejectId,
          state: { values: { reason: { input: { type: "plain_text_input", value: "PRIVATE REASON" } } } },
        },
      }),
      readSigningSecret: async () => secret,
    });
    expect(submitted.status).toBe(200);
    expect((await issueThreadInteractionService(db).getById(interaction.id))?.status).toBe("rejected");
    const audits = await db.select().from(activityLog).where(and(
      eq(activityLog.action, "slack.decision_resolved"),
      eq(activityLog.entityId, interaction.id),
    ));
    expect(JSON.stringify(audits)).not.toContain("PRIVATE REASON");
  });

  function recordingTransport(result: () => SlackDecisionSendResult) {
    const posts: Array<{ text: string; buttons?: unknown; cardUrl: string }> = [];
    const updates: Array<{ text: string; buttons?: unknown; messageTimestamp: string }> = [];
    let inspected: "absent" | "present" | "unknown" = "absent";
    const transport: SlackDecisionMessageTransport = {
      async post(message) {
        posts.push({ text: message.text, buttons: message.buttons, cardUrl: message.cardUrl });
        return result();
      },
      async update(message) {
        updates.push({ text: message.text, buttons: message.buttons, messageTimestamp: message.messageTimestamp });
        return { outcome: "sent", messageTimestamp: message.messageTimestamp };
      },
      async inspect(query) {
        return inspected === "present"
          ? { outcome: "present", messageTimestamp: query.messageTimestamp ?? "123.456", text: updates.at(-1)?.text }
          : { outcome: inspected };
      },
    };
    return { transport, posts, updates, setInspected: (value: typeof inspected) => { inspected = value; } };
  }

  async function classified(interactive = false) {
    const seeded = await seed();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await slackDecisionDisclosureService(db).update(seeded.endpointId, seeded.interaction.id, {
      disclosure: { sourceDigest: slackDecisionSourceDigest(seeded.interaction), topic: "product_direction", expiresAt },
    }, "local-board");
    await grantRoute(seeded.companyId, seeded.endpointId);
    await db.insert(companyMemberships).values({
      companyId: seeded.companyId, principalType: "user", principalId: "local-board", status: "active",
    });
    await planCompanySlackDecisionDelivery(db, seeded.interaction, new Date(), { interactive });
    return seeded;
  }

  it("keeps the flag off: one linked message, no buttons, no tokens, and no historical resend", async () => {
    const { companyId, interaction } = await classified(false);
    const planned = await db.select().from(chatActions).where(eq(chatActions.kind, "slack_decision_delivery"));
    expect(planned).toHaveLength(1);
    expect(planned[0]?.payload).toMatchObject({ mode: "link_only" });
    expect(JSON.stringify(planned[0]?.payload)).toContain("Otwórz kartę:");
    await expect(commitSlackDecisionPublicationReceipt(db, interaction, "123.456")).rejects.toThrow("requires a response in MyDay");
    expect(await db.select().from(chatActions).where(eq(chatActions.kind, "slack_decision_action"))).toHaveLength(0);

    const seen = recordingTransport(() => ({ outcome: "sent", messageTimestamp: "123.456" }));
    const digest = slackDecisionSourceDigest(interaction);
    await dispatchSlackDecisionDeliveries(db, seen.transport, {
      historicalKeys: new Set([slackDecisionDeliveryDedupeKey(companyId, interaction.id, digest)]),
    });
    expect(seen.posts).toHaveLength(0);
    expect((await db.select().from(chatActions).where(eq(chatActions.kind, "slack_decision_delivery")))[0]?.status)
      .toBe("skipped_historical");

    await db.update(chatActions).set({ status: "pending" }).where(eq(chatActions.kind, "slack_decision_delivery"));
    await dispatchSlackDecisionDeliveries(db, seen.transport);
    await dispatchSlackDecisionDeliveries(db, seen.transport);
    expect(seen.posts).toHaveLength(1);
    expect(seen.posts[0]?.buttons).toBeUndefined();
    expect(seen.posts[0]?.text).toContain(seen.posts[0]?.cardUrl ?? "");
    expect(seen.updates).toHaveLength(0);
    expect(await db.select().from(chatActions).where(eq(chatActions.kind, "slack_decision_action"))).toHaveLength(0);
  });

  it("retries a 429 and does not post again after an unknown result until reconciliation finds no message", async () => {
    await classified(false);
    const now = new Date("2026-11-20T06:47:00.000Z");
    let posts = 0;
    const transport = recordingTransport(() => {
      posts += 1;
      if (posts === 1) return { outcome: "retryable", statusCode: 429 };
      if (posts === 2) return { outcome: "unknown" };
      return { outcome: "sent", messageTimestamp: "123.456" };
    });
    await dispatchSlackDecisionDeliveries(db, transport.transport, { now });
    await dispatchSlackDecisionDeliveries(db, transport.transport, { now });
    expect(posts).toBe(1);
    expect((await db.select().from(chatActions).where(eq(chatActions.kind, "slack_decision_delivery")))[0]?.status)
      .toBe("retry");
    await dispatchSlackDecisionDeliveries(db, transport.transport, { now: new Date(now.getTime() + 15_000) });
    await dispatchSlackDecisionDeliveries(db, transport.transport, { now: new Date(now.getTime() + 15_000) });
    expect(posts).toBe(2);
    expect((await db.select().from(chatActions).where(eq(chatActions.kind, "slack_decision_delivery")))[0]?.status)
      .toBe("delivery_unknown");
    await reconcileSlackDecisionDeliveries(db, transport.transport, { now: new Date(now.getTime() + 15_000) });
    await dispatchSlackDecisionDeliveries(db, transport.transport, { now: new Date(now.getTime() + 20_000) });
    expect(posts).toBe(3);
    expect((await db.select().from(chatActions).where(eq(chatActions.kind, "slack_decision_delivery")))[0]?.status)
      .toBe("sent");
  });

  it("updates the original message once after a decision and retries a failed replacement without resolving again", async () => {
    const { endpointId, publicId, interaction } = await classified(true);
    let updates = 0;
    const updateMessages: Array<{ text: string; buttons?: unknown }> = [];
    const transport = recordingTransport(() => ({ outcome: "sent", messageTimestamp: "123.456" }));
    transport.transport.update = async (message) => {
      updates += 1;
      updateMessages.push({ text: message.text, buttons: message.buttons });
      if (updates === 2) return { outcome: "retryable", statusCode: 503 };
      return { outcome: "sent", messageTimestamp: message.messageTimestamp };
    };
    await dispatchSlackDecisionDeliveries(db, transport.transport, { interactive: true });
    expect(transport.posts).toHaveLength(1);
    expect(transport.posts[0]?.buttons).toBeUndefined();
    expect(updates).toBe(1);
    const delivery = (await db.select().from(chatActions).where(eq(chatActions.kind, "slack_decision_delivery")))[0];
    const actionIds = (delivery?.payload as { actionIds?: string[] }).actionIds ?? [];
    expect(actionIds).toHaveLength(2);
    const accepted = await handleSlackDecisionCallback(db, {
      publicId, ...signedRequest(button(actionIds[0]!)), readSigningSecret: async () => secret,
    });
    expect(accepted.status).toBe(200);
    expect((await issueThreadInteractionService(db).getById(interaction.id))?.status).toBe("accepted");
    const queued = (await db.select().from(chatActions).where(eq(chatActions.kind, "slack_decision_delivery")))[0];
    expect(queued?.status).toBe("update_pending");
    const queuedText = (queued?.payload as { update?: { text?: string } }).update?.text ?? "";
    expect(queuedText).toMatch(/Daniel · \d{4}-\d{2}-\d{2} \d{2}:\d{2} Europe\/Warsaw · Zatwierdź/);
    expect(queuedText).not.toContain("pcsd:");
    const now = new Date("2026-11-20T07:00:00.000Z");
    await dispatchSlackDecisionDeliveries(db, transport.transport, { now });
    expect(updates).toBe(2);
    expect((await db.select().from(chatActions).where(eq(chatActions.kind, "slack_decision_delivery")))[0]?.status)
      .toBe("update_retry");
    await dispatchSlackDecisionDeliveries(db, transport.transport, { now: new Date(now.getTime() + 15_000) });
    await dispatchSlackDecisionDeliveries(db, transport.transport, { now: new Date(now.getTime() + 15_000) });
    expect(updates).toBe(3);
    expect(updateMessages[1]?.buttons).toBeUndefined();
    expect(updateMessages[1]?.text).toContain("Otwórz kartę:");
    expect(updateMessages[1]?.text).not.toContain(secret);
    expect((await db.select().from(chatActions).where(eq(chatActions.kind, "slack_decision_delivery")))[0]?.status)
      .toBe("updated");
    const replay = await handleSlackDecisionCallback(db, {
      publicId, ...signedRequest(button(actionIds[0]!)), readSigningSecret: async () => secret,
    });
    expect(replay.status).toBe(200);
    expect((await issueThreadInteractionService(db).getById(interaction.id))?.status).toBe("accepted");
    const audits = await db.select().from(activityLog).where(eq(activityLog.action, "slack.decision_resolved"));
    expect(audits).toHaveLength(1);
    expect(endpointId).toBeTruthy();
  });
});
