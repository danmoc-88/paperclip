import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutionBlocker } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { activityApi, type RunForIssue } from "../api/activity";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { Link } from "../lib/router";

const PRESERVE_STATUSES = ["todo", "done", "in_review", "blocked"] as const;

function isCancelledBeforeStartRun(run: RunForIssue) {
  const result = run.resultJson;
  return (run.runtimeMode ?? "legacy") === "legacy"
    && run.status === "cancelled"
    && run.startedAt === null
    && run.errorCode === "issue_continuation_waiting_on_review"
    && result?.stopReason === run.errorCode
    && result?.timeoutSource === "stale_queued_run_gate";
}

export function ExecutionBlockerNotice({ companyId, issueId, blocker, onRetried, sourceStatus = "", canSettle = false }: {
  companyId: string;
  issueId: string;
  blocker: ExecutionBlocker;
  onRetried: () => void;
  sourceStatus?: string;
  canSettle?: boolean;
}) {
  const queryClient = useQueryClient();
  const evidenceId = useId();
  const [evidence, setEvidence] = useState("");
  const { data: runs, error: runsError } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
  });
  const failedRun = runs?.find(run => run.runId === blocker.runId &&
    ["failed", "timed_out"].includes(run.status));
  const sourceRun = runs?.find(run => run.runId === blocker.runId);
  const preserveStatus = PRESERVE_STATUSES.find(status => status === sourceStatus);
  const cancelledBeforeStart = Boolean(
    blocker.recoveryActionId && blocker.runId && sourceRun && preserveStatus
    && isCancelledBeforeStartRun(sourceRun),
  );
  const settle = useMutation({
    mutationFn: () => issuesApi.resolveRecoveryAction(issueId, {
      actionId: blocker.recoveryActionId!,
      outcome: "blocked",
      sourceIssueStatus: preserveStatus!,
      preserveWithoutReplay: true,
      executionReconciliation: {
        runId: blocker.runId!,
        providerStopped: true,
        actionOutcome: "not_performed",
        outcomeEvidence: evidence.trim(),
      },
    }),
    onSuccess: () => {
      onRetried();
      for (const queryKey of [queryKeys.issues.detail(issueId), queryKeys.issues.runs(issueId),
        queryKeys.issues.liveRuns(issueId), queryKeys.issues.activeRun(issueId)]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
  const requiresInspection = blocker.cause === "native_continuation_requires_reconciliation" ||
    blocker.cause === "native_session_cleanup_quarantined";
  const retry = useMutation({
    mutationFn: () => agentsApi.retryFailedRun(blocker.agentId!, blocker.runId!, companyId),
    onSuccess: () => {
      onRetried();
      for (const queryKey of [queryKeys.issues.detail(issueId), queryKeys.issues.runs(issueId),
        queryKeys.issues.liveRuns(issueId), queryKeys.issues.activeRun(issueId)]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
  return (
    <div role="status" aria-label="Task recovery" className="mx-(--sz-execution-blocker-inline) my-(--sz-execution-blocker-block) flex flex-wrap items-center justify-between execution-blocker-notice border border-border bg-muted text-foreground">
      <div className="min-w-0 flex-1 break-words">
        <p>Recovery needed.{blocker.runError ? ` ${blocker.runError}` : ""}</p>
        <p>{blocker.nextAction}</p>
        {Boolean(blocker.savedMessageCount) && (
          <p>{blocker.savedMessageCount} saved {blocker.savedMessageCount === 1 ? "message is" : "messages are"} waiting for recovery.</p>
        )}
      </div>
      {blocker.agentId && blocker.runId && (
        <Button variant="outline" size="sm" asChild>
          <Link to={`/agents/${blocker.agentId}/runs/${blocker.runId}`}>Inspect run</Link>
        </Button>
      )}
      {(!requiresInspection || blocker.canRetry) && blocker.agentId && blocker.runId && !cancelledBeforeStart &&
        ((blocker.cause === "legacy_execution_requires_reconciliation" && failedRun) || blocker.canContinue || blocker.canRetry) && (
        <Button variant="outline" size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
          {retry.isPending ? "Starting…" : blocker.canContinue ? "Continue" : "Retry"}
        </Button>
      )}
      {retry.isError && (
        <p role="alert" className="w-full text-destructive">{retry.error.message}</p>
      )}
      {cancelledBeforeStart && (
        <div className="flex w-full flex-col gap-2">
          <p className="text-muted-foreground">This run was cancelled before a provider started. Record that the provider did not perform the action. The task status and recorded work stay unchanged, and this run is not replayed.</p>
          {canSettle ? <>
            <Label htmlFor={evidenceId}>Outcome evidence</Label>
            <Textarea id={evidenceId} value={evidence} onChange={event => setEvidence(event.target.value)} maxLength={12_000}
              placeholder="Describe the proof that this run did not start and that received work stays in place." disabled={settle.isPending} />
            <div className="flex justify-end">
              <Button onClick={() => settle.mutate()} disabled={settle.isPending || evidence.trim().length < 20}>
                {settle.isPending ? "Settling…" : "Settle without replay"}
              </Button>
            </div>
          </> : <p className="text-muted-foreground">A board operator can settle this cancelled run without replay.</p>}
          {settle.isError && (
            <p role="alert" className="text-destructive">{settle.error instanceof Error ? settle.error.message : "Could not settle this run. Refresh the task and inspect it."}</p>
          )}
        </div>
      )}
      {runsError && <p role="alert" className="w-full text-destructive">{runsError.message}</p>}
    </div>
  );
}
