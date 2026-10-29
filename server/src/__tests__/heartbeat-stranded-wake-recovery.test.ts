import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  STRANDED_WAKE_RESUME_ATTEMPT_CAP,
  heartbeatService,
} from "../services/heartbeat.ts";
import { withQueuedCommentIdsInWakePayload } from "../services/issue-queued-comment-queue.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stranded-wake recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat stranded wake recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-stranded-wake-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "company_skills",
        "issue_comments",
        "issue_documents",
        "document_revisions",
        "documents",
        "issue_relations",
        "issue_tree_holds",
        "issues",
        "heartbeat_run_events",
        "cost_events",
        "activity_log",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  type SeedInput = {
    agentStatus?: "idle" | "paused";
    run?: { runtimeMode: "legacy" | "native"; status: string };
    wakeAgeMs?: number;
    invalidOrgChain?: boolean;
    resumeAttempts?: number;
  };

  async function seedStrandedWake(input: SeedInput = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const commentId = randomUUID();
    const queueId = randomUUID();
    const wakeUpdatedAt = new Date(Date.now() - (input.wakeAgeMs ?? 2 * 60_000));

    await db.insert(companies).values({
      id: companyId,
      name: "Stranded Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Stranded Agent",
      role: "engineer",
      status: input.agentStatus ?? "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stranded issue",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    if (input.invalidOrgChain) {
      const managerId = randomUUID();
      await db.insert(agents).values({
        id: managerId,
        companyId,
        name: "Terminated Manager",
        role: "cto",
        status: "terminated",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
        permissions: {},
      });
      await db.update(agents).set({ reportsTo: managerId }).where(eq(agents.id, agentId));
    }
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorUserId: "local-board",
      body: "Continue this task.",
    });
    const basePayload: Record<string, unknown> = { issueId };
    if (input.resumeAttempts) basePayload._paperclipResumeAttempts = input.resumeAttempts;
    await db.insert(agentWakeupRequests).values({
      id: queueId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      status: "deferred_issue_execution",
      payload: withQueuedCommentIdsInWakePayload(basePayload, [commentId]),
      updatedAt: wakeUpdatedAt,
    });
    if (input.run) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: input.run.status,
        runtimeMode: input.run.runtimeMode,
        wakeupRequestId: queueId,
        contextSnapshot: { issueId },
        startedAt: new Date(),
        finishedAt: new Date(),
      });
    }
    return { queueId, wakeUpdatedAt };
  }

  async function readWake(queueId: string) {
    const [row] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, queueId));
    return row;
  }

  it("keeps an unpromotable wake idle inside the rotation window", async () => {
    const { queueId, wakeUpdatedAt } = await seedStrandedWake({
      agentStatus: "idle",
      run: { runtimeMode: "native", status: "running" },
      wakeAgeMs: 2 * 60_000,
    });
    const heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.resumeQueuedRuns();

    const wake = await readWake(queueId);
    expect(wake?.status).toBe("deferred_issue_execution");
    expect(wake?.updatedAt.getTime()).toBe(wakeUpdatedAt.getTime());
    expect((wake?.payload as Record<string, unknown> | null)?._paperclipResumeAttempts).toBeUndefined();
  });

  it("leaves a stranded wake untouched while its agent is not invokable", async () => {
    const { queueId, wakeUpdatedAt } = await seedStrandedWake({
      agentStatus: "paused",
      run: { runtimeMode: "legacy", status: "succeeded" },
      wakeAgeMs: 2 * 60_000,
    });
    const heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });

    await heartbeat.resumeQueuedRuns();

    const wake = await readWake(queueId);
    expect(wake?.status).toBe("deferred_issue_execution");
    expect(wake?.updatedAt.getTime()).toBe(wakeUpdatedAt.getTime());
  });

  it("re-stamps an unpromotable wake only after the rotation window", async () => {
    const { queueId, wakeUpdatedAt } = await seedStrandedWake({
      agentStatus: "idle",
      run: { runtimeMode: "native", status: "running" },
      wakeAgeMs: 16 * 60_000,
    });
    const heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });

    await heartbeat.resumeQueuedRuns();

    const wake = await readWake(queueId);
    expect(wake?.status).toBe("deferred_issue_execution");
    expect(wake?.updatedAt.getTime()).toBeGreaterThan(wakeUpdatedAt.getTime());
    expect((wake?.payload as Record<string, unknown> | null)?._paperclipResumeAttempts).toBeUndefined();
  });

  it("leaves a stranded wake untouched while its agent has an invalid reporting chain", async () => {
    const { queueId, wakeUpdatedAt } = await seedStrandedWake({
      agentStatus: "idle",
      invalidOrgChain: true,
      run: { runtimeMode: "legacy", status: "succeeded" },
      wakeAgeMs: 2 * 60_000,
    });
    const heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });

    await heartbeat.resumeQueuedRuns();

    const wake = await readWake(queueId);
    expect(wake?.status).toBe("deferred_issue_execution");
    expect(wake?.updatedAt.getTime()).toBe(wakeUpdatedAt.getTime());
  });

  it("charges one stranded resume attempt per pass", async () => {
    const { queueId, wakeUpdatedAt } = await seedStrandedWake({
      agentStatus: "idle",
      run: { runtimeMode: "legacy", status: "succeeded" },
      wakeAgeMs: 5 * 60_000,
    });
    const heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });

    await heartbeat.resumeQueuedRuns();

    const wake = await readWake(queueId);
    expect(wake?.updatedAt.getTime()).toBeGreaterThan(wakeUpdatedAt.getTime());
    expect((wake?.payload as Record<string, unknown> | null)?._paperclipResumeAttempts).toBe(1);
  });

  it("closes a stranded wake whose attempt budget is exhausted", async () => {
    const { queueId } = await seedStrandedWake({
      agentStatus: "idle",
      run: { runtimeMode: "legacy", status: "succeeded" },
      wakeAgeMs: 5 * 60_000,
      resumeAttempts: STRANDED_WAKE_RESUME_ATTEMPT_CAP,
    });
    const heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });

    await heartbeat.resumeQueuedRuns();

    const wake = await readWake(queueId);
    expect(wake?.status).toBe("skipped");
    expect(wake?.error).toContain(`${STRANDED_WAKE_RESUME_ATTEMPT_CAP} attempts`);
    expect(wake?.finishedAt).not.toBeNull();
  });
});
