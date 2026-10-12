import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authenticateSlackDecisionCallback, type SlackDecisionCallbackBinding } from "./slack-decision-callback.js";

const now = new Date("2026-10-10T11:00:00Z");
const secret = "synthetic-secret";
const actionId = `pcsd:${"a".repeat(32)}`;
const binding: SlackDecisionCallbackBinding = {
  enabled: true, workspaceId: "T1", appId: "A1", slackUserId: "U1", channelId: "C1",
  messageTimestamp: "1234.5678", actionId, expiresAt: new Date(now.getTime() + 60_000), viewId: "V1",
};
function button() {
  return {
    type: "block_actions", api_app_id: "A1", team: { id: "T1" }, user: { id: "U1" },
    channel: { id: "C1" }, message: { ts: "1234.5678", text: "Do not copy this" },
    container: { type: "message", channel_id: "C1", message_ts: "1234.5678" },
    actions: [{ type: "button", action_id: actionId, value: "untrusted-issue-id" }], trigger_id: "trigger",
  };
}
function modal(type = "view_submission") {
  return {
    type, api_app_id: "A1", team: { id: "T1" }, user: { id: "U1" },
    view: { id: "V1", callback_id: actionId, private_metadata: actionId,
      state: { values: { q1: { answer: { type: "plain_text_input", value: "private answer" } } } } },
  };
}
function request(payload: unknown, route = binding) {
  const rawBody = new TextEncoder().encode(new URLSearchParams({ payload: JSON.stringify(payload) }).toString());
  return rawRequest(rawBody, route);
}
function rawRequest(rawBody: Uint8Array, route = binding) {
  const timestamp = String(now.getTime() / 1000);
  return { rawBody, signingSecret: secret, binding: route, now, headers: new Headers({
    "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:`).update(rawBody).digest("hex")}`,
  }) };
}

describe("decision callback preflight", () => {
  it("returns only the bound action and trigger, not callback message text or issue IDs", () => {
    expect(authenticateSlackDecisionCallback(request(button()))).toEqual({ kind: "button", actionId, triggerId: "trigger" });
  });

  it.each(["workspaceId", "appId", "slackUserId", "channelId", "messageTimestamp", "actionId"] as const)("rejects a foreign %s even with a valid signature", (key) => {
    expect(() => authenticateSlackDecisionCallback(request(button(), { ...binding, [key]: "foreign" }))).toThrow("requires a response in MyDay");
  });

  it.each(["channel", "containerChannel", "message", "containerMessage"])("rejects contradictory %s identity", (field) => {
    const payload = button();
    if (field === "channel") payload.channel.id = "C2";
    if (field === "containerChannel") payload.container.channel_id = "C2";
    if (field === "message") payload.message.ts = "1234.9999";
    if (field === "containerMessage") payload.container.message_ts = "1234.9999";
    expect(() => authenticateSlackDecisionCallback(request(payload))).toThrow();
  });

  it("refuses multi-action batches, unknown actions and missing identity", () => {
    const payload = button();
    payload.actions.push(payload.actions[0]!);
    expect(() => authenticateSlackDecisionCallback(request(payload))).toThrow();
    expect(() => authenticateSlackDecisionCallback(request({ ...button(), team: null }))).toThrow();
    expect(() => authenticateSlackDecisionCallback(request({ ...button(), type: "shortcut" }))).toThrow();
  });

  it("does not admit disabled, expired or malformed bindings", () => {
    for (const route of [
      { ...binding, enabled: false }, { ...binding, expiresAt: now },
      { ...binding, expiresAt: new Date(NaN) },
    ]) expect(() => authenticateSlackDecisionCallback(request(button(), route))).toThrow();
  });

  it("requires a view receipt and matching opaque callback and metadata", () => {
    const payload = modal();
    expect(authenticateSlackDecisionCallback(request(payload))).toEqual({ kind: "submission", actionId, values: payload.view.state.values });
    expect(() => authenticateSlackDecisionCallback(request(payload, { ...binding, viewId: undefined }))).toThrow();
    expect(() => authenticateSlackDecisionCallback(request(payload, { ...binding, viewId: "V2" }))).toThrow();
    payload.view.private_metadata = '{"issueId":"forged"}';
    expect(() => authenticateSlackDecisionCallback(request(payload))).toThrow();
    payload.view.private_metadata = actionId;
    payload.view.callback_id = `pcsd:${"b".repeat(32)}`;
    expect(() => authenticateSlackDecisionCallback(request(payload))).toThrow();
  });

  it("returns a separate close event, never an answer or rejection", () => {
    expect(authenticateSlackDecisionCallback(request(modal("view_closed")))).toEqual({ kind: "closed", actionId });
  });

  it("requires form state on submission", () => {
    const payload = modal();
    expect(() => authenticateSlackDecisionCallback(request({ ...payload, view: { ...payload.view, state: undefined } }))).toThrow();
  });

  it("rejects malformed/ambiguous signed bodies with a content-free error", () => {
    for (const raw of ["payload=private-secret", "payload=%7B%7D&payload=%7B%7D", "missing=payload"]) {
      expect(() => authenticateSlackDecisionCallback(rawRequest(new TextEncoder().encode(raw)))).toThrow("This decision requires a response in MyDay");
    }
    expect(() => authenticateSlackDecisionCallback(rawRequest(new Uint8Array([255])))).toThrow();
    expect(() => authenticateSlackDecisionCallback(rawRequest(new Uint8Array(256 * 1024 + 1)))).toThrow();
  });

  it("rejects unsigned traffic before parsing, with the same safe error", () => {
    const input = request(button());
    input.headers.delete("x-slack-signature");
    expect(() => authenticateSlackDecisionCallback(input)).toThrow("This decision requires a response in MyDay");
  });
});
