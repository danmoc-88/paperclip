import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "./heartbeat.js";
import {
  deliverReconciledExecutions,
  settleUnrecoverableExecutions,
} from "./execution-recovery-resolution.js";
import { terminalizeLegacyExecution } from "./legacy-execution-recovery.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("conversation interruption resume", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-conversation-interruption-resume-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(input: {
    errorCode: string;
    status?: string;
    assigneeAgentId?: string | null;
    returnOwnerAgentId?: string | null;
    newerRun?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const stoppedAt = new Date("2026-10-11T16:13:08.000Z");
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
    ]);
    const assignee = input.assigneeAgentId === undefined ? agentId : input.assigneeAgentId;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Interrupted task",
      status: input.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: assignee,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "interrupted",
      errorCode: input.errorCode,
      runtimeMode: "legacy",
      contextSnapshot: { issueId },
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
      createdAt: stoppedAt,
      updatedAt: stoppedAt,
    });
    await db.insert(heartbeatRunEvents).values({
      companyId,
      agentId,
      runId,
      seq: 1,
      eventType: "adapter.invoke",
      payload: { adapterType: "codex_local" },
    });
    if (input.newerRun) {
      const later = new Date(stoppedAt.getTime() + 60_000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        runtimeMode: "legacy",
        contextSnapshot: { issueId },
        createdAt: later,
        updatedAt: later,
      });
    }
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "active_run_watchdog",
      ownerType: "board",
      returnOwnerAgentId: input.returnOwnerAgentId === undefined ? agentId : input.returnOwnerAgentId,
      cause: "legacy_execution_requires_reconciliation",
      status: "active",
      evidence: { runId, originalFailureCode: input.errorCode },
      fingerprint: `legacy-execution:${runId}`,
      nextAction: "Inspect the stopped run.",
    }).returning();
    return { companyId, agentId, otherAgentId, issueId, runId, action: action! };
  }

  async function wakesFor(actionId: string) {
    const calls: Array<{ idempotencyKey?: string; contextSnapshot?: Record<string, unknown> }> = [];
    const wake = async (_agentId: string, opts: { idempotencyKey?: string; contextSnapshot?: Record<string, unknown> }) => {
      calls.push(opts);
      return { id: randomUUID() };
    };
    await deliverReconciledExecutions(db, wake as never);
    await deliverReconciledExecutions(db, wake as never);
    return calls.filter((call) => call.idempotencyKey === `execution-reconciliation:${actionId}`);
  }

  async function settled(actionId: string) {
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId));
    return action!;
  }

  it.each(["orphaned_running_run", "process_lost", "server_shutdown_interrupted", "lease_released_before_terminal"])(
    "queues one fresh session after %s",
    async (errorCode) => {
      const fixture = await seed({ errorCode });
      await settleUnrecoverableExecutions(db);
      const action = await settled(fixture.action.id);
      expect(action).toMatchObject({
        status: "resolved",
        outcome: "cancelled",
        evidence: {
          continuationDelivery: "pending",
          executionReconciliation: { runId: fixture.runId, providerStopped: true, actionOutcome: "mixed" },
        },
      });
      const wakes = await wakesFor(fixture.action.id);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]?.contextSnapshot).toMatchObject({
        forceFreshSession: true,
        previousRunId: fixture.runId,
        recoveryActionId: fixture.action.id,
        executionRetryAccounting: { version: 1, failureRetries: 1, maxTurnContinuations: 0 },
        scheduledRetryAttempt: 1,
        retryReason: "transient_failure",
      });
    },
  );

  it.each(["done", "cancelled"])("does not resume a %s task", async (status) => {
    const fixture = await seed({ errorCode: "orphaned_running_run", status });
    await settleUnrecoverableExecutions(db);
    const action = await settled(fixture.action.id);
    expect(action.evidence.continuationDelivery).toBeUndefined();
    expect(action.evidence.executionReconciliation).toMatchObject({ runId: fixture.runId });
    expect(await wakesFor(fixture.action.id)).toHaveLength(0);
  });

  it("does not resume after the assignee changes", async () => {
    const fixture = await seed({
      errorCode: "process_lost",
      assigneeAgentId: undefined,
    });
    await db.update(issues).set({ assigneeAgentId: fixture.otherAgentId }).where(eq(issues.id, fixture.issueId));
    await settleUnrecoverableExecutions(db);
    const action = await settled(fixture.action.id);
    expect(action.evidence.continuationDelivery).toBeUndefined();
    expect(action.evidence.executionReconciliation).toMatchObject({ runId: fixture.runId });
    expect(await wakesFor(fixture.action.id)).toHaveLength(0);
  });

  it("does not resume when a newer run exists", async () => {
    const fixture = await seed({ errorCode: "server_shutdown_interrupted", newerRun: true });
    await settleUnrecoverableExecutions(db);
    const action = await settled(fixture.action.id);
    expect(action.evidence.continuationDelivery).toBeUndefined();
    expect(action.evidence.executionReconciliation).toMatchObject({ runId: fixture.runId });
    expect(await wakesFor(fixture.action.id)).toHaveLength(0);
  });

  it.each(["orphaned_running_run", "lease_released_before_terminal"])(
    "two reconciliation passes after %s queue one wake and do not recreate the action",
    async (errorCode) => {
      const fixture = await seed({ errorCode });
      await settleUnrecoverableExecutions(db);
      await settleUnrecoverableExecutions(db);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
      await terminalizeLegacyExecution({ db, run: run!, status: "interrupted" });
      const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId));
      expect(actions).toHaveLength(1);
      expect(actions[0]?.id).toBe(fixture.action.id);
      expect(actions[0]?.evidence.executionReconciliation).toMatchObject({ runId: fixture.runId });
      const wakes = await wakesFor(fixture.action.id);
      expect(wakes).toHaveLength(1);
      await deliverReconciledExecutions(db, (async () => ({ id: randomUUID() })) as never);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId))).toHaveLength(1);
    },
  );

  it("does not wake when the task is blocked between settlement and delivery", async () => {
    const fixture = await seed({ errorCode: "process_lost" });
    await settleUnrecoverableExecutions(db);
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, fixture.issueId));
    expect(await wakesFor(fixture.action.id)).toHaveLength(0);
    expect((await settled(fixture.action.id)).evidence.continuationDelivery).toBe("invalidated");
  });

  it("does not wake when a newer completed run appears between settlement and delivery", async () => {
    const fixture = await seed({ errorCode: "process_lost" });
    await settleUnrecoverableExecutions(db);
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      status: "succeeded",
      runtimeMode: "legacy",
      contextSnapshot: { issueId: fixture.issueId },
      createdAt: new Date("2026-10-11T17:00:00.000Z"),
    });
    expect(await wakesFor(fixture.action.id)).toHaveLength(0);
    expect((await settled(fixture.action.id)).evidence.continuationDelivery).toBe("invalidated");
  });

  it("does not wake when the failure retry budget is already spent", async () => {
    const fixture = await seed({ errorCode: "process_lost" });
    await db.update(heartbeatRuns).set({
      scheduledRetryAttempt: 2,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: {
        issueId: fixture.issueId,
        executionRetryAccounting: { version: 1, failureRetries: 2, maxTurnContinuations: 0 },
      },
    }).where(eq(heartbeatRuns.id, fixture.runId));
    await settleUnrecoverableExecutions(db);
    expect((await settled(fixture.action.id)).evidence.continuationDelivery).toBeUndefined();
    expect(await wakesFor(fixture.action.id)).toHaveLength(0);
  });

  it("records the next failure retry when one attempt remains", async () => {
    const fixture = await seed({ errorCode: "orphaned_running_run" });
    await db.update(heartbeatRuns).set({
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: {
        issueId: fixture.issueId,
        executionRetryAccounting: { version: 1, failureRetries: 1, maxTurnContinuations: 0 },
      },
    }).where(eq(heartbeatRuns.id, fixture.runId));
    await settleUnrecoverableExecutions(db);
    const wakes = await wakesFor(fixture.action.id);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.contextSnapshot).toMatchObject({
      executionRetryAccounting: { version: 1, failureRetries: 2, maxTurnContinuations: 0 },
      scheduledRetryAttempt: 2,
    });
  });

  it("keeps a manual reconciliation wake when the task is blocked", async () => {
    const fixture = await seed({ errorCode: "process_lost" });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, fixture.issueId));
    await db.update(issueRecoveryActions).set({
      status: "resolved",
      outcome: "restored",
      evidence: {
        runId: fixture.runId,
        continuationDelivery: "pending",
        executionReconciliation: {
          runId: fixture.runId,
          providerStopped: true,
          actionOutcome: "not_performed",
          outcomeEvidence: "Operator checked the stopped process.",
          actorId: "operator",
        },
      },
    }).where(eq(issueRecoveryActions.id, fixture.action.id));
    expect(await wakesFor(fixture.action.id)).toHaveLength(1);
  });

  it("admission rechecks a block that appears after the sweep read and keeps the retry delay", async () => {
    const fixture = await seed({ errorCode: "process_lost" });
    await settleUnrecoverableExecutions(db);
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const queued = await deliverReconciledExecutions(db, heartbeat.wakeup);
    void queued;
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, fixture.runId));
    expect(successor).toMatchObject({
      status: "scheduled_retry",
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
    });
    expect(successor?.contextSnapshot).toMatchObject({
      automaticInterruptionResume: true,
      forceFreshSession: true,
      previousRunId: fixture.runId,
      executionRetryAccounting: { version: 1, failureRetries: 1, maxTurnContinuations: 0 },
    });
    expect(successor?.scheduledRetryAt!.getTime() - Date.now()).toBeGreaterThan(20_000);
    const dueAt = successor!.scheduledRetryAt!;
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, fixture.issueId));
    const promotion = await heartbeat.promoteDueScheduledRetries(new Date(dueAt.getTime() + 1_000));
    expect(promotion.runIds).not.toContain(successor!.id);
    const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successor!.id));
    expect(cancelled).toMatchObject({ status: "cancelled", errorCode: "automatic_interruption_resume_stale" });
  });

  it("admission invalidates a pending wake when a newer run appears inside the lock", async () => {
    const fixture = await seed({ errorCode: "server_shutdown_interrupted" });
    await settleUnrecoverableExecutions(db);
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    await deliverReconciledExecutions(db, async (...args) => {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        status: "succeeded",
        runtimeMode: "legacy",
        contextSnapshot: { issueId: fixture.issueId },
        createdAt: new Date("2026-10-11T17:00:00.000Z"),
      });
      return heartbeat.wakeup(...args);
    });
    expect(await db.select().from(agentWakeupRequests).where(eq(
      agentWakeupRequests.idempotencyKey,
      `execution-reconciliation:${fixture.action.id}`,
    ))).toHaveLength(0);
    expect((await settled(fixture.action.id)).evidence.continuationDelivery).toBe("invalidated");
  });
});
