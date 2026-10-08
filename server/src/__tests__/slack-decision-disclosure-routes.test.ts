import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { chatChannelRoutes } from "../routes/chat-channels.js";
import type { ChatChannelService } from "../services/chat-channels.js";

const mocks = vi.hoisted(() => ({ update: vi.fn(), hasPermission: vi.fn() }));
vi.mock("../services/slack-decision-disclosures.js", () => ({ slackDecisionDisclosureService: () => ({ update: mocks.update }) }));
vi.mock("../services/access.js", () => ({ accessService: () => ({ hasPermission: mocks.hasPermission }) }));
const companyId = "11111111-1111-4111-8111-111111111111";
const interactionId = "22222222-2222-4222-8222-222222222222";
const endpointId = "33333333-3333-4333-8333-333333333333";
const actor: Express.Request["actor"] = { type: "board", source: "session", userId: "board-user", companyIds: [companyId] };
const path = `/api/chat-endpoints/${endpointId}/slack/decision-disclosures/${interactionId}`;
const get = vi.fn();
function app(identity = actor) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { req.actor = identity; next(); });
  server.use("/api", chatChannelRoutes({} as Db, {
    service: { get } as unknown as ChatChannelService, heartbeat: { wakeup: vi.fn() },
  }));
  server.use(errorHandler);
  return server;
}
beforeEach(() => {
  vi.resetAllMocks();
  get.mockResolvedValue({ id: endpointId, companyId });
  mocks.hasPermission.mockResolvedValue(true);
  mocks.update.mockResolvedValue({ status: "revoked" });
});
describe("protected Slack disclosure route", () => {
  it("requires a Board actor before reaching the storage service", async () => {
    await request(app({ type: "agent", source: "api_key", agentId: "agent", companyId }))
      .put(path).send({ disclosure: null }).expect(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("rejects a Board user outside the endpoint company", async () => {
    await request(app({ ...actor, companyIds: [] })).put(path).send({ disclosure: null }).expect(404);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("requires existing connection-management permission", async () => {
    mocks.hasPermission.mockResolvedValue(false);
    await request(app()).put(path).send({ disclosure: null }).expect(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("passes the authenticated user to the classification service", async () => {
    await request(app()).put(path).send({ disclosure: null }).expect(200);
    expect(mocks.hasPermission).toHaveBeenCalledWith(companyId, "user", "board-user", "tools:manage_connections");
    expect(mocks.update).toHaveBeenCalledWith(endpointId, interactionId, { disclosure: null }, "board-user");
  });
  it("rejects injected actor, source text and arbitrary classification fields", async () => {
    await request(app()).put(path).send({ disclosure: null, userId: "victim" }).expect(400);
    await request(app()).put(path).send({ disclosure: { sourceDigest: "0".repeat(64), topic: "product_direction",
      expiresAt: "2026-10-09T00:00:00Z", text: "untrusted" } }).expect(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
