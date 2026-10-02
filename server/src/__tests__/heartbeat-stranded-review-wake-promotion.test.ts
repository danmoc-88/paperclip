import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stranded review wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat promotes a review wake stranded by a handoff", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-stranded-review-wake-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Reproduces the handoff shape: the coder's legacy run is cancelled for the
   * reassignment, the issue moves to `in_review` owned by the reviewer, the
   * execution lock is already released, and the reviewer's mention wake is left
   * deferred. The reviewer has never run this issue, so only the coder's run
   * can key the release that drains the queue.
   */
  async function seedHandoffScenario(opts: { reviewerRanThisIssueBefore?: boolean } = {}) {
    const companyId = randomUUID();
    const coderAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const issueId = randomUUID();
    const coderRunId = randomUUID();
    const reviewerWakeId = randomUUID();
    const commentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values([
      {
        id: coderAgentId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerAgentId,
        companyId,
        name: "Reviewer",
        role: "engineer",
        status: "idle",
        // Keep the reviewer's queue from claiming and executing the promoted
        // run inside this unit test; the busy run below occupies the one slot.
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        adapterType: "process",
        adapterConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review the handed-off branch",
      status: "in_review",
      priority: "high",
      assigneeAgentId: reviewerAgentId,
      executionRunId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: coderAgentId,
      body: "Handing this to the reviewer.",
    });

    // The previous owner's run: legacy, terminal, cancelled for the handoff.
    // This is the only run that ever executed this issue.
    await db.insert(heartbeatRuns).values({
      id: coderRunId,
      companyId,
      agentId: coderAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      runtimeMode: "legacy",
      status: "cancelled",
      errorCode: "issue_reassigned",
      error: "Cancelled before issue reassignment",
      startedAt: new Date(Date.now() - 120_000),
      finishedAt: new Date(Date.now() - 60_000),
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_blockers_resolved" },
    });

    if (opts.reviewerRanThisIssueBefore) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId: reviewerAgentId,
        invocationSource: "automation",
        triggerDetail: "system",
        runtimeMode: "legacy",
        status: "running",
        startedAt: new Date(),
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_comment_mentioned" },
      });
    }

    // Occupies the reviewer's single concurrency slot without referencing the issue.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: reviewerAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { wakeReason: "test_busy_slot" },
    });

    await db.insert(agentWakeupRequests).values({
      id: reviewerWakeId,
      companyId,
      agentId: reviewerAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      status: "deferred_issue_execution",
      requestedByActorType: "agent",
      requestedByActorId: coderAgentId,
      payload: {
        issueId,
        commentId,
        _paperclipWakeContext: {
          issueId,
          taskId: issueId,
          commentId,
          wakeCommentId: commentId,
          wakeCommentIds: [commentId],
          wakeReason: "issue_comment_mentioned",
          source: "comment.mention",
        },
      },
    });

    return { companyId, coderAgentId, reviewerAgentId, issueId, coderRunId, reviewerWakeId };
  }

  async function readWake(wakeId: string) {
    return db
      .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeId))
      .then((rows) => rows[0] ?? null);
  }

  it("promotes the new assignee's deferred wake by keying the release on the issue's own last run", async () => {
    const { reviewerAgentId, issueId, reviewerWakeId } = await seedHandoffScenario();

    expect(await readWake(reviewerWakeId)).toMatchObject({
      status: "deferred_issue_execution",
      runId: null,
    });

    await heartbeat.resumeQueuedRuns();

    const wake = await readWake(reviewerWakeId);
    expect(wake?.status).not.toBe("deferred_issue_execution");
    expect(wake?.runId).not.toBeNull();

    const promoted = await db
      .select({
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wake!.runId!))
      .then((rows) => rows[0] ?? null);

    expect(promoted?.agentId).toBe(reviewerAgentId);
    expect(promoted?.contextSnapshot?.issueId).toBe(issueId);
  });

  it("leaves the wake deferred while the new assignee's own run on the issue is still live", async () => {
    const { reviewerWakeId } = await seedHandoffScenario({ reviewerRanThisIssueBefore: true });

    await heartbeat.resumeQueuedRuns();

    expect(await readWake(reviewerWakeId)).toMatchObject({
      status: "deferred_issue_execution",
      runId: null,
    });
  });
});
