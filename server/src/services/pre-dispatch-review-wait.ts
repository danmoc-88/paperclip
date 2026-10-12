import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";

type Run = typeof heartbeatRuns.$inferSelect;
type DispatchFields = "startedAt" | "runtimeModeResolvedAt" | "processPid" | "processGroupId" |
  "processStartedAt" | "nativeIssueId" | "nativeSessionId" | "sessionIdAfter" |
  "controllerBootId" | "controllerLeaseExpiresAt" | "executionStage";

/** The queued-run gate owns this receipt before execution authority is claimed.
 * A deliberate review wait has no provider actions to reconcile. The error code
 * alone is not proof; missing or conflicting dispatch evidence retains the hold. */
export function isPreDispatchReviewWait(
  run: Pick<Run, "runtimeMode" | "status" | "errorCode" | "resultJson"> & Partial<Pick<Run, DispatchFields>>,
): boolean {
  return run.runtimeMode === "legacy" && run.status === "cancelled" &&
    run.errorCode === "issue_continuation_waiting_on_review" &&
    run.resultJson?.stopReason === run.errorCode &&
    run.resultJson?.timeoutSource === "stale_queued_run_gate" &&
    run.resultJson?.workspaceRestoreFailure !== "restore_unsafe_archive" &&
    run.startedAt === null && run.runtimeModeResolvedAt === null &&
    run.processPid === null && run.processGroupId === null && run.processStartedAt === null &&
    run.nativeIssueId === null && run.nativeSessionId === null && run.sessionIdAfter === null &&
    run.controllerBootId === null && run.controllerLeaseExpiresAt === null && run.executionStage === null;
}

/** Retained evidence that no provider execution began for this run. Shared by
 * every pre-provider settlement proof so they cannot drift apart. */
async function hasNoRetainedExecutionEvidence(db: Db, run: Run): Promise<boolean> {
  const [coordinator] = await db.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id),
  )).limit(1);
  if (coordinator) return false;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
  if (leases.some(lease => lease.provider === "local"
    ? !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed"
    : !hasRemoteTerminationReceipt(lease))) return false;
  const [execution] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    or(isNotNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, ["adapter.invoke", PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED,
        "harness.ready", "session.started", "session.resumed", "session.updated", "turn.started",
        "provider.event", "provider.rpc_result", "tool.execution.started"])),
  )).limit(1);
  return !execution;
}

/** The row receipt is a candidate, not permission to discard conflicting
 * retained execution or cleanup evidence. Historical false holds must be
 * checked against the same evidence that gates explicit user admission. */
export async function isPreDispatchReviewWaitVerified(db: Db, run: Run): Promise<boolean> {
  if (!isPreDispatchReviewWait(run)) return false;
  return hasNoRetainedExecutionEvidence(db, run);
}

/** A run the adapter failed before launching any provider, for example because
 * the configured model was unavailable. The run row alone is only a candidate:
 * `adapter_failed` also covers failures after provider work, so settlement still
 * requires the retained evidence to show that no execution was ever recorded.
 * This is for an explicit board settlement only. It never lets the automatic
 * retry classifier treat the run as safe to replay. */
export function isAdapterStartupFailure(
  run: Pick<Run, "runtimeMode" | "status" | "errorCode" | "finishedAt" | "resultJson"> & Partial<Pick<Run, DispatchFields>>,
): boolean {
  return run.runtimeMode === "legacy" && run.status === "cancelled" &&
    run.errorCode === "adapter_failed" && run.finishedAt != null &&
    run.resultJson?.workspaceRestoreFailure !== "restore_unsafe_archive" &&
    run.processPid == null && run.processGroupId == null && run.processStartedAt == null &&
    run.nativeIssueId == null && run.nativeSessionId == null && run.sessionIdAfter == null;
}

export async function isAdapterStartupFailureVerified(db: Db, run: Run): Promise<boolean> {
  if (!isAdapterStartupFailure(run)) return false;
  return hasNoRetainedExecutionEvidence(db, run);
}
