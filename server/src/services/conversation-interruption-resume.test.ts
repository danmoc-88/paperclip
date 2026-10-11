import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
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

  it.each(["orphaned_running_run", "process_lost", "server_shutdown_interrupted"])(
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

  it("two reconciliation passes queue one wake and do not recreate the action", async () => {
    const fixture = await seed({ errorCode: "orphaned_running_run" });
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
  });
});
