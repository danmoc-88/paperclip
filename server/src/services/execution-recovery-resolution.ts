import { hasWorkspaceRestoreFailure } from "@paperclipai/shared";
import { randomUUID } from "node:crypto";
import { claimedAdapterType, conversationRecoveryActionPredicate, getConversationOwnershipBlocker } from "./conversation-continuation.js";
import { persistActivity } from "./activity-log.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { logger } from "../middleware/logger.js";
import { and, eq, gt, inArray, isNull, ne, not, notInArray, or, sql } from "drizzle-orm";
import {
  chatActions,
  environmentLeases,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import { conflict } from "../errors.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import {
  EXECUTION_RECONCILIATION_CAUSES,
  type ExecutionReconciliation,
} from "@paperclipai/shared";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { isSupersededConversationRun } from "./agent-conversations.js";
import {
  accountingForScheduledRetry,
  executionFailureRetryCount,
  type ExecutionRetryAccounting,
} from "./execution-recovery-attempt.js";
import { isPreDispatchReviewWaitVerified } from "./pre-dispatch-review-wait.js";

/** An operator records observed outcomes; this is not permission to blindly retry. */
export async function validateExecutionReconciliation(input: {
  db: Db;
  companyId: string;
  issueId: string;
  agentId: string | null;
  sourceRunId: unknown;
  decision: ExecutionReconciliation | undefined;
}) {
  const { db, companyId, issueId, agentId, decision } = input;
  if (!decision || decision.runId !== input.sourceRunId || !agentId) {
    throw conflict(
      "Reconcile the recorded execution and its action outcomes before continuing this task.",
    );
  }
  const [run] = await db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.id, decision.runId),
      ),
    );
  const [task] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  const review =
    task?.status === "in_review"
      ? parseIssueExecutionState(task.executionState)
      : null;
  const isCurrentReviewer =
    review?.status === "pending" &&
    review.currentParticipant?.type === "agent" &&
    review.currentParticipant.agentId === run?.agentId;
  if (
    !run ||
    !task ||
    task.assigneeAgentId !== agentId ||
    (run.agentId !== agentId && !isCurrentReviewer) ||
    (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== issueId ||
    !["failed", "interrupted", "timed_out", "cancelled"].includes(run.status)
  ) {
    throw conflict(
      "The recovery source or task owner changed. Inspect the current execution before continuing.",
    );
  }
  if (hasWorkspaceRestoreFailure(run.resultJson) &&
      (!decision.workspaceRepairEvidence || decision.workspaceRepairEvidence.trim().length < 20)) {
    throw conflict("Verify safe workspace staging or repair and record workspaceRepairEvidence before continuing this run.");
  }
  for (const pid of [
    run.processPid,
    run.processGroupId ? -run.processGroupId : null,
  ]) {
    if (!pid) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
      throw conflict(
        "The previous provider's process ownership cannot be verified.",
      );
    }
    throw conflict(
      "The previous provider is still running. Stop it before continuing.",
    );
  }
  const [coordinator] = await db
    .select()
    .from(nativeRunFinalizations)
    .where(
      and(
        eq(nativeRunFinalizations.companyId, companyId),
        eq(nativeRunFinalizations.runId, run.id),
      ),
    );
  if (coordinator?.leaseOwner || coordinator?.failureDetail?.successorRunId)
    throw conflict(
      "This execution still has a coordinator or a linked continuation. Inspect that run first.",
    );
  const leases = await db
    .select({ id: environmentLeases.id })
    .from(environmentLeases)
    .where(
      and(
        eq(environmentLeases.companyId, companyId),
        eq(environmentLeases.heartbeatRunId, run.id),
        isNull(environmentLeases.releasedAt),
      ),
    )
    .limit(1);
  if (leases.length)
    throw conflict(
      "The previous execution environment has not finished releasing its authority.",
    );
  await buildExecutionContinuation({
    db,
    companyId,
    issueId,
    agentId,
    context: { previousRunId: run.id },
    summary: null,
    exposeLowTrustRaw: false,
  });
  return run;
}

/** Availability losses, not uncertain external effects. A fresh session may continue. */
const INTERRUPTION_RESUME_ERROR_CODES = new Set([
  "orphaned_running_run",
  "process_lost",
  "server_shutdown_interrupted",
  // Lease teardown cuts a still-running turn without the SIGTERM drain.
  // It is the same availability loss: one fresh session, no tool replay.
  "lease_released_before_terminal",
]);

/** Parked and closed tasks stay where an operator or an earlier disposition left them. */
const INTERRUPTION_RESUME_STATUSES = new Set(["todo", "in_progress", "in_review"]);

/** Same two-slot budget as the transient heartbeat retry schedule. */
const AUTOMATIC_INTERRUPTION_RETRY_LIMIT = 2;

export function isAutomaticInterruptionResumeEvidence(
  evidence: Record<string, unknown> | null | undefined,
): boolean {
  return evidence?.automaticInterruptionResume === true;
}

/**
 * Conditions that can change between settlement and the fresh-session wake.
 * Operator reconciliation does not set `automaticInterruptionResume` and does
 * not use this gate.
 */
export async function evaluateAutomaticInterruptionResume(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    sourceRunId: string;
    returnOwnerAgentId: string | null;
    /** The scheduled successor is newer than its source. Do not treat it as a competing run. */
    ignoreRunId?: string | null;
  },
): Promise<
  | { resume: false; runId: string }
  | {
      resume: true;
      runId: string;
      nextAttempt: number;
      accounting: ExecutionRetryAccounting;
    }
> {
  const runId = input.sourceRunId;
  const [task] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  const [run] = await db
    .select()
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, runId)));
  if (!task || !run) return { resume: false, runId };
  const [newer] = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${task.id}::text`,
        ne(heartbeatRuns.id, run.id),
        input.ignoreRunId ? ne(heartbeatRuns.id, input.ignoreRunId) : undefined,
        or(
          gt(heartbeatRuns.createdAt, run.createdAt),
          and(eq(heartbeatRuns.createdAt, run.createdAt), gt(heartbeatRuns.id, run.id)),
        ),
      ),
    )
    .limit(1);
  const sameOwner =
    input.returnOwnerAgentId !== null && task.assigneeAgentId === input.returnOwnerAgentId;
  const currentExecution =
    (!task.executionRunId || task.executionRunId === run.id) &&
    (!task.checkoutRunId || task.checkoutRunId === run.id);
  const consumed = executionFailureRetryCount(run);
  const resume =
    INTERRUPTION_RESUME_ERROR_CODES.has(run.errorCode ?? "") &&
    INTERRUPTION_RESUME_STATUSES.has(task.status) &&
    sameOwner &&
    currentExecution &&
    !newer &&
    !hasWorkspaceRestoreFailure(run.resultJson) &&
    !isSupersededConversationRun(task, run) &&
    consumed < AUTOMATIC_INTERRUPTION_RETRY_LIMIT;
  if (!resume) return { resume: false, runId };
  const nextAttempt = consumed + 1;
  return {
    resume: true,
    runId,
    nextAttempt,
    accounting: accountingForScheduledRetry(run, "transient_failure", nextAttempt),
  };
}

/**
 * The fresh-session gate accepts only a complete reconciliation record.
 * `mixed` records that this sweep did not verify earlier tool calls, so the
 * new session must not replay them.
 */
function interruptionReconciliation(runId: string): ExecutionReconciliation {
  return {
    runId,
    providerStopped: true,
    actionOutcome: "mixed",
    outcomeEvidence:
      "The server lost this running session before it could finish. Earlier tool calls are not replayed. One fresh session continues the open task.",
  };
}

/**
 * Stamp the stopped run on every conversation fold so the stranded-work sweep
 * does not insert another action for it. Queue one fresh session only while
 * this hold is still the task's current execution.
 */
async function conversationInterruptionResume(
  db: Db,
  action: typeof issueRecoveryActions.$inferSelect,
): Promise<{ runId: string; resume: boolean } | null> {
  const runId = action.evidence.runId;
  if (typeof runId !== "string") return null;
  const liveHold = action.status === "active" || action.status === "escalated";
  const decision = await evaluateAutomaticInterruptionResume(db, {
    companyId: action.companyId,
    issueId: action.sourceIssueId,
    sourceRunId: runId,
    returnOwnerAgentId: action.returnOwnerAgentId,
  });
  return { runId, resume: liveHold && decision.resume };
}

/** Durable delivery marker lives on the existing source-scoped recovery action. */
export async function markExecutionReconciliation(
  db: Db,
  action: Pick<
    typeof issueRecoveryActions.$inferSelect,
    "companyId" | "id" | "evidence" | "sourceIssueId"
  >,
  decision: ExecutionReconciliation,
  actorId: string,
  deliveryOwner?: { kind: "chat_failed_run_retry"; actionId: string },
) {
  if (deliveryOwner) {
    const [retry] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, action.companyId),
          eq(chatActions.id, deliveryOwner.actionId),
        ),
      );
    if (
      deliveryOwner.kind !== "chat_failed_run_retry" ||
      !retry ||
      retry.kind !== "failed_run_retry" ||
      !["issued", "processing", "processed"].includes(retry.status) ||
      retry.payload.version !== 1 ||
      retry.payload.failedRunId !== decision.runId ||
      retry.payload.issueId !== action.sourceIssueId
    ) {
      throw conflict("The authorized chat retry owner is no longer valid.");
    }
  }
  await db
    .update(nativeRunFinalizations)
    .set({
      failureDetail: sql`coalesce(${nativeRunFinalizations.failureDetail}, '{}'::jsonb) || ${JSON.stringify({ replacementDenied: "operator_reconciled" })}::jsonb`,
    })
    .where(
      and(
        eq(nativeRunFinalizations.companyId, action.companyId),
        eq(nativeRunFinalizations.runId, decision.runId),
      ),
    );
  await db
    .update(issueRecoveryActions)
    .set({
      evidence: {
        ...action.evidence,
        automaticRecovery: undefined,
        executionReconciliation: {
          ...decision,
          actorId,
          recordedAt: new Date().toISOString(),
        },
        continuationDelivery: deliveryOwner ? "delegated" : "pending",
        ...(deliveryOwner ? { continuationDeliveryOwner: deliveryOwner } : {}),
      },
    })
    .where(
      and(
        eq(issueRecoveryActions.companyId, action.companyId),
        eq(issueRecoveryActions.id, action.id),
      ),
    );
}

export async function deliverReconciledExecutions(
  db: Db,
  wake: ReturnType<typeof import("./heartbeat.js").heartbeatService>["wakeup"],
) {
  const pending = await db
    .select()
    .from(issueRecoveryActions)
    .where(
      and(
        eq(issueRecoveryActions.status, "resolved"),
        sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
      ),
    )
    .limit(25);
  for (const action of pending) {
    try {
      const decision = action.evidence.executionReconciliation as
        ExecutionReconciliation | undefined;
      if (!decision || !action.returnOwnerAgentId) continue;
      const pendingDecision = and(
        eq(issueRecoveryActions.companyId, action.companyId),
        eq(issueRecoveryActions.id, action.id),
        eq(issueRecoveryActions.status, "resolved"),
        sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
        sql`${issueRecoveryActions.evidence}->'executionReconciliation' = ${JSON.stringify(decision)}::jsonb`,
      );
      const [task] = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, action.companyId),
            eq(issues.id, action.sourceIssueId),
          ),
        );
      if (
        !task ||
        task.assigneeAgentId !== action.returnOwnerAgentId ||
        ["done", "cancelled"].includes(task.status)
      ) {
        await db
          .update(issueRecoveryActions)
          .set({
            evidence: sql`${issueRecoveryActions.evidence} || '{"continuationDelivery":"invalidated"}'::jsonb`,
          })
          .where(pendingDecision);
        continue;
      }
      const automaticResume = isAutomaticInterruptionResumeEvidence(action.evidence)
        ? await evaluateAutomaticInterruptionResume(db, {
            companyId: action.companyId,
            issueId: task.id,
            sourceRunId: decision.runId,
            returnOwnerAgentId: action.returnOwnerAgentId,
          })
        : null;
      if (automaticResume && !automaticResume.resume) {
        await db
          .update(issueRecoveryActions)
          .set({
            evidence: sql`${issueRecoveryActions.evidence} || '{"continuationDelivery":"invalidated"}'::jsonb`,
          })
          .where(pendingDecision);
        continue;
      }
      const run = await wake(action.returnOwnerAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_recovery_action_restored",
        idempotencyKey: `execution-reconciliation:${action.id}`,
        payload: { issueId: task.id, recoveryActionId: action.id },
        requestedByActorType: "system",
        requestedByActorId: "execution-recovery",
        contextSnapshot: {
          issueId: task.id,
          taskId: task.id,
          recoveryActionId: action.id,
          previousRunId: decision.runId,
          retryOfRunId: decision.runId,
          forceFreshSession: true,
          wakeReason: "issue_recovery_action_restored",
          source: "execution.reconciled",
          ...(automaticResume?.resume
            ? {
                executionRetryAccounting: automaticResume.accounting,
                scheduledRetryAttempt: automaticResume.nextAttempt,
                retryReason: "transient_failure",
              }
            : {}),
        },
      });
      if (run)
        await db.transaction(async (tx) => {
          await tx
            .update(heartbeatRuns)
            .set({ retryOfRunId: decision.runId })
            .where(
              and(
                eq(heartbeatRuns.companyId, action.companyId),
                eq(heartbeatRuns.id, run.id),
                eq(heartbeatRuns.agentId, action.returnOwnerAgentId!),
                sql`${heartbeatRuns.contextSnapshot}->>'recoveryActionId' = ${action.id}`,
                sql`${heartbeatRuns.contextSnapshot}->>'previousRunId' = ${decision.runId}`,
              ),
            );
          await tx
            .update(issueRecoveryActions)
            .set({
              evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify(
                {
                  continuationDelivery: "delivered",
                  continuationRunId: run.id,
                },
              )}::jsonb`,
            })
            .where(pendingDecision);
        });
    } catch {
      logger.warn(
        { recoveryActionId: action.id },
        "Reconciled execution continuation remains pending for retry",
      );
    }
  }
}

/**
 * Failed execution is a system responsibility, not a user questionnaire. After
 * automatic recovery is ruled out, preserve evidence and stop without replay.
 * This is NOT evidence that an external action succeeded or never happened.
 * The resolved record retains a dispatch hold until actual evidence clears it.
 */
export async function settleUnrecoverableExecutions(
  db: Db,
  now = new Date(),
  options: { failpoint?: (phase: "persisted") => void } = {},
) {
  // Fold conversation holds. Historical blocked work stays unwoken. An open task
  // whose run died with an availability error gets one fresh session, delivered
  // later by deliverReconciledExecutions. The run id on the action stops the
  // stranded-work sweep from inserting the same hold again.
  const obsoleteConversationHold = and(
    conversationRecoveryActionPredicate(),
    or(
      inArray(issueRecoveryActions.status, ["active", "escalated"]),
      sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
    ),
  );
  await db.transaction(async tx => {
    const foldable = await tx.select().from(issueRecoveryActions).where(obsoleteConversationHold)
      .limit(25).for("update", { skipLocked: true });
    for (const candidate of foldable) {
      if (await getConversationOwnershipBlocker(tx as unknown as Db, candidate.companyId, candidate.sourceIssueId)) continue;
      const interruption = await conversationInterruptionResume(tx as unknown as Db, candidate);
      const foldedEvidence = () => sql`case when ${issueRecoveryActions.evidence} ? 'automaticRecovery'
          then jsonb_set(${issueRecoveryActions.evidence}, '{automaticRecovery,replay}', '"conversation_continuation"'::jsonb)
          else ${issueRecoveryActions.evidence} end`;
      const reconciliationStamp = interruption
        ? JSON.stringify({ executionReconciliation: interruptionReconciliation(interruption.runId) })
        : null;
      const resumeStamp = interruption?.resume
        ? JSON.stringify({
            executionReconciliation: interruptionReconciliation(interruption.runId),
            continuationDelivery: "pending",
            automaticInterruptionResume: true,
          })
        : null;
      const heldWithoutResume = interruption && !interruption.resume
        ? JSON.stringify({
            executionReconciliation: interruptionReconciliation(interruption.runId),
            automaticRecovery: {
              policy: "preserve_without_replay_v1",
              replay: "conversation_continuation",
              runId: interruption.runId,
              actionOutcome: "unknown",
            },
          })
        : null;
      const evidence = resumeStamp
        ? sql`(${foldedEvidence()}) || ${resumeStamp}::jsonb`
        : heldWithoutResume
          ? sql`case when (${foldedEvidence()}) ? 'automaticRecovery'
              then (${foldedEvidence()}) || ${reconciliationStamp!}::jsonb
              else (${foldedEvidence()}) || ${heldWithoutResume}::jsonb end`
          : foldedEvidence();
      const [action] = await tx.update(issueRecoveryActions).set({
        status: "resolved",
        outcome: "cancelled",
        resolvedAt: now,
        updatedAt: now,
        nextAction: interruption?.resume
          ? "The interrupted run is closed. A fresh session is queued for the same task."
          : "Automatic attempts stopped. Send a new message to continue the conversation.",
        resolutionNote: interruption?.resume
          ? "Availability interruption queued one fresh session. Prior tool calls are not replayed."
          : "Conversation continuation does not replay prior tool calls.",
        wakePolicy: null,
        monitorPolicy: null,
        evidence,
      }).where(and(obsoleteConversationHold, eq(issueRecoveryActions.id, candidate.id))).returning();
      if (!action) continue;
      await persistActivity(tx as unknown as Db, {
        companyId: action.companyId,
        actorType: "system",
        actorId: "execution-recovery",
        action: "issue.execution_recovery_settled",
        entityType: "issue",
        entityId: action.sourceIssueId,
        details: {
          recoveryActionId: action.id,
          outcome: "cancelled",
          continuation: "conversation",
          ...(interruption?.resume ? { freshSessionQueued: true } : {}),
        },
      });
    }
  });
  // Filter eligibility before applying the batch limit. A queue of sessions
  // awaiting replacement must not starve settled incidents behind it.
  const candidates = await db
    .select({ action: issueRecoveryActions })
    .from(issueRecoveryActions)
    .innerJoin(
      heartbeatRuns,
      and(
        eq(heartbeatRuns.companyId, issueRecoveryActions.companyId),
        sql`${heartbeatRuns.id}::text = ${issueRecoveryActions.evidence}->>'runId'`,
        sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueRecoveryActions.sourceIssueId}::text`,
      ),
    )
    .leftJoin(
      nativeRunFinalizations,
      and(
        eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId),
        eq(nativeRunFinalizations.runId, heartbeatRuns.id),
      ),
    )
    .where(
      and(
        not(conversationRecoveryActionPredicate()!),
        inArray(issueRecoveryActions.status, ["active", "escalated"]),
        eq(issueRecoveryActions.kind, "active_run_watchdog"),
        inArray(issueRecoveryActions.cause, [
          ...EXECUTION_RECONCILIATION_CAUSES,
        ]),
        inArray(heartbeatRuns.status, [
          "failed",
          "timed_out",
          "interrupted",
          "cancelled",
        ]),
        isNull(nativeRunFinalizations.leaseOwner),
        isNull(nativeRunFinalizations.resultId),
        or(
          isNull(nativeRunFinalizations.runId),
          eq(nativeRunFinalizations.phase, "terminal_failure"),
        ),
        sql`coalesce(${nativeRunFinalizations.failureDetail}->>'successorRunId', '') = ''`,
        sql`(${heartbeatRuns.runtimeMode} <> 'native' or coalesce(${nativeRunFinalizations.failureCode}, '') <> 'native_provider_terminal_failed'
        or coalesce(${nativeRunFinalizations.failureDetail}->>'replacementDenied', '') <> '')`,
      ),
    )
    .limit(25);
  for (const { action: candidate } of candidates) {
    const runId = candidate.evidence.runId;
    if (typeof runId !== "string") continue;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
        );
        // Same issue -> coordinator -> run ordering as replacement/finalization.
        const [task] = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, candidate.companyId),
              eq(issues.id, candidate.sourceIssueId),
            ),
          )
          .for("update");
        const [coordinator] = await tx
          .select()
          .from(nativeRunFinalizations)
          .where(
            and(
              eq(nativeRunFinalizations.companyId, candidate.companyId),
              eq(nativeRunFinalizations.runId, runId),
            ),
          )
          .for("update");
        const [run] = await tx
          .select()
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, candidate.companyId),
              eq(heartbeatRuns.id, runId),
            ),
          )
          .for("update");
        const [action] = await tx
          .select()
          .from(issueRecoveryActions)
          .where(eq(issueRecoveryActions.id, candidate.id))
          .for("update");
        if (
          !task ||
          !run ||
          !action ||
          action.evidence.runId !== runId ||
          !EXECUTION_RECONCILIATION_CAUSES.includes(
            action.cause as (typeof EXECUTION_RECONCILIATION_CAUSES)[number],
          ) ||
          !["active", "escalated"].includes(action.status) ||
          (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== task.id ||
          !["failed", "timed_out", "interrupted", "cancelled"].includes(
            run.status,
          )
        )
          return;
        // Give durable native recovery its chance; never preempt a resume,
        // replacement, result finalizer, or still-owned execution.
        if (
          coordinator?.leaseOwner ||
          coordinator?.resultId ||
          coordinator?.failureDetail?.successorRunId ||
          (coordinator && coordinator.phase !== "terminal_failure") ||
          (run.runtimeMode === "native" &&
            coordinator?.failureCode === "native_provider_terminal_failed" &&
            !coordinator.failureDetail?.replacementDenied)
        )
          return;
        const current =
          !isSupersededConversationRun(task, run) &&
          action.returnOwnerAgentId !== null &&
          task.assigneeAgentId === action.returnOwnerAgentId &&
          !["done", "cancelled"].includes(task.status) &&
          (!task.executionRunId || task.executionRunId === run.id) &&
          (!task.checkoutRunId || task.checkoutRunId === run.id);
        const note = current
          ? hasWorkspaceRestoreFailure(run.resultJson)
            ? "Workspace repair required. Verify safe staging or repair before continuing. Saved work and approval decisions remain in force."
            : "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated."
          : "Recovery closed because the task's owner, execution, or status changed. No work was replayed.";
        let nativeFailureBlock = action.evidence.nativeFailureBlock;
        let nativeBootstrapFailureBlock = action.evidence.nativeBootstrapFailureBlock;
        if (current) {
          const [projected] = await tx
            .update(issues)
            .set({
              status: "blocked",
              executionRunId: null,
              checkoutRunId: null,
              updatedAt: now,
            })
            .where(eq(issues.id, task.id)).returning();
          // Only a transition owned by this failure grants a recovery receipt.
          // An already-blocked task may have a separate human/dependency hold.
          if (task.status !== "blocked" && run.runtimeMode === "native") {
            nativeFailureBlock = { runId: run.id, statusVersion: projected!.statusVersion };
          }
          if (task.status !== "blocked" && run.runtimeMode === "legacy" && !run.runtimeModeResolvedAt &&
              run.errorCode === "server_shutdown_interrupted" && claimedAdapterType(run) === "paperclip_runner") {
            nativeBootstrapFailureBlock = { runId: run.id, statusVersion: projected!.statusVersion, previousStatus: task.status };
          }
        }
        await tx
          .update(issueRecoveryActions)
          .set({
            status: "resolved",
            outcome: current ? "blocked" : "cancelled",
            resolvedAt: now,
            updatedAt: now,
            nextAction: note,
            resolutionNote: note,
            wakePolicy: null,
            monitorPolicy: null,
            evidence: {
              ...action.evidence,
              ...(nativeFailureBlock ? { nativeFailureBlock } : {}),
              ...(nativeBootstrapFailureBlock ? { nativeBootstrapFailureBlock } : {}),
              automaticRecovery: {
                policy: "preserve_without_replay_v1",
                runId: run.id,
                replay: "blocked",
                actionOutcome: "unknown",
                recordedAt: now.toISOString(),
              },
            },
          })
          .where(eq(issueRecoveryActions.id, action.id));
        await persistActivity(tx as unknown as Db, {
          companyId: run.companyId,
          actorType: "system",
          actorId: "execution-recovery",
          action: "issue.execution_recovery_settled",
          entityType: "issue",
          entityId: task.id,
          runId: run.id,
          details: {
            recoveryActionId: action.id,
            outcome: current ? "blocked" : "cancelled",
            replay: "not_authorized",
          },
        });
        await tx
          .update(heartbeatRuns)
          .set({ executionStatusDeliveryId: randomUUID() })
          .where(eq(heartbeatRuns.id, run.id));
        await appendHeartbeatRunEvent(tx as unknown as Db, {
          companyId: run.companyId,
          agentId: run.agentId,
          runId: run.id,
          eventType: "lifecycle",
          stream: "system",
          level: "warn",
          message: note,
          payload: {
            recoveryActionId: action.id,
            cause: action.cause,
            automaticRecovery: "preserve_without_replay_v1",
            replay: "blocked",
          },
        });
        options.failpoint?.("persisted");
      });
    } catch (err) {
      if (options.failpoint) throw err;
      logger.warn(
        { err, recoveryActionId: candidate.id },
        "Automatic recovery disposition remains pending",
      );
    }
  }
}

const TERMINAL_RUN_STATUSES = ["succeeded", "completed", "failed", "timed_out", "interrupted", "cancelled"];

/** Board evidence for one verified review-wait cancellation. This does not wake or replay. */
export async function verifiedCancelledBeforeStartRun(db: Db, companyId: string, runId: string) {
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId),
  ));
  return Boolean(run && await isPreDispatchReviewWaitVerified(db, run));
}

function recordedSettlement(evidence: Record<string, unknown>, decision: ExecutionReconciliation) {
  const current = evidence.executionReconciliation;
  if (!current || typeof current !== "object") return "absent" as const;
  const value = current as Record<string, unknown>;
  const same = value.runId === decision.runId && value.providerStopped === true
    && value.actionOutcome === decision.actionOutcome && value.outcomeEvidence === decision.outcomeEvidence;
  return same ? "same" as const : "different" as const;
}

export async function settleCancelledBeforeStartHold(input: {
  db: Db;
  issue: { id: string; companyId: string; status: string; assigneeAgentId: string | null; executionRunId: string | null; checkoutRunId: string | null };
  actionId: string;
  decision: ExecutionReconciliation;
  actorId: string;
  resolutionNote?: string | null;
}) {
  const { db, issue, decision } = input;
  const [action] = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.id, input.actionId),
    eq(issueRecoveryActions.companyId, issue.companyId),
    eq(issueRecoveryActions.sourceIssueId, issue.id),
  )).for("update");
  if (!action) throw conflict("Active recovery action not found");
  if (action.fingerprint !== `legacy-execution:${decision.runId}`
    || (action.evidence.runId ?? action.evidence.sourceRunId) !== decision.runId) {
    throw conflict("The recovery action changed. Inspect the current hold before continuing.");
  }
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.id, decision.runId),
  )).for("update");
  if (!run || run.agentId !== action.returnOwnerAgentId
    || (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== issue.id) {
    throw conflict("The recovery source or task owner changed. Inspect the current execution before continuing.");
  }
  const evidence = action.evidence as Record<string, unknown>;
  const recorded = recordedSettlement(evidence, decision);
  if (recorded === "same" && evidence.continuationDelivery === "preserved") {
    return { action, idempotent: true as const };
  }
  if (recorded !== "absent") {
    throw conflict("This recovery event was already settled. A repeated event cannot change the recorded outcome.");
  }
  if (issue.executionRunId || issue.checkoutRunId) {
    throw conflict("A live run still holds this task. Stop it before settling the cancelled run.");
  }
  const [live] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, issue.companyId),
    notInArray(heartbeatRuns.status, TERMINAL_RUN_STATUSES),
    or(eq(heartbeatRuns.nativeIssueId, issue.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`),
  )).limit(1);
  if (live) throw conflict("A live run still holds this task. Stop it before settling the cancelled run.");
  if (!(await isPreDispatchReviewWaitVerified(db, run))) {
    throw conflict("This run is not a verified cancelled-before-start review wait. Provider work or missing proof keeps the hold.");
  }
  const automatic = evidence.automaticRecovery as { replay?: string } | undefined;
  if (automatic?.replay !== "blocked") {
    throw conflict("Verified outcomes must settle the current no-replay hold.");
  }
  const [otherActive] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, issue.companyId),
    eq(issueRecoveryActions.sourceIssueId, issue.id),
    inArray(issueRecoveryActions.status, ["active", "escalated"]),
  )).limit(1);
  if (otherActive) throw conflict("Another active recovery action still holds this task.");
  const retained = { ...evidence };
  delete retained.automaticRecovery;
  const recordedAt = new Date().toISOString();
  const [updated] = await db.update(issueRecoveryActions).set({
    evidence: {
      ...retained,
      executionReconciliation: { ...decision, actorId: input.actorId, recordedAt },
      continuationDelivery: "preserved",
      cancelledBeforeStartSettlement: {
        runId: decision.runId,
        fingerprint: action.fingerprint,
        preservedStatus: issue.status,
        preservedAssigneeAgentId: issue.assigneeAgentId,
        recordedAt,
      },
    },
    nextAction: "Verified cancelled-before-start. Recorded work stays in place and this run was not replayed.",
    resolutionNote: input.resolutionNote ?? action.resolutionNote,
    updatedAt: new Date(),
  }).where(and(
    eq(issueRecoveryActions.companyId, issue.companyId),
    eq(issueRecoveryActions.id, action.id),
    sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
    sql`${issueRecoveryActions.evidence}->'executionReconciliation' is null`,
  )).returning();
  if (!updated) throw conflict("This recovery event was already settled. A repeated event cannot change the recorded outcome.");
  return { action: updated, idempotent: false as const };
}
