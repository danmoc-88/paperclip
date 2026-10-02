import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutionBlocker, IssueRecoveryAction } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { Checkbox } from "./ui/checkbox";
import { Textarea } from "./ui/textarea";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";

export function ExecutionBlockerNotice({ companyId, issueId, blocker: executionBlocker, recoveryAction, onRetried }: {
  companyId: string;
  issueId: string;
  blocker?: ExecutionBlocker | null;
  recoveryAction?: IssueRecoveryAction | null;
  onRetried: () => void;
}) {
  const recoveryRunId = recoveryAction?.evidence.runId ?? recoveryAction?.evidence.sourceRunId;
  const blocker: ExecutionBlocker = executionBlocker ?? {
    recoveryActionId: recoveryAction?.id ?? null,
    runId: typeof recoveryRunId === "string" ? recoveryRunId : null,
    agentId: null,
    cause: recoveryAction?.cause ?? "",
    nextAction: recoveryAction?.nextAction ?? "",
  };
  const matchingAction = recoveryAction && recoveryRunId === blocker.runId ? recoveryAction : null;
  const reconciliationActionId = matchingAction?.id ?? blocker.recoveryActionId;
  const reconciliationCause = matchingAction?.cause ?? blocker.cause;
  const ownershipHeld = blocker.cause === "execution_owner_active";
  const queryClient = useQueryClient();
  const evidenceId = useId();
  const confirmationId = useId();
  const [confirmedRunId, setConfirmedRunId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState({ runId: blocker.runId, text: "" });
  const outcomeEvidence = evidence.runId === blocker.runId ? evidence.text : "";
  const confirmed = confirmedRunId === blocker.runId;
  const { data: runs } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
  });
  const failedRun = runs?.find(run => run.runId === blocker.runId &&
    ["failed", "timed_out"].includes(run.status));
  const orphanedRun = runs?.find(run => run.runId === blocker.runId &&
    run.status === "interrupted" && run.runtimeMode === "legacy" &&
    run.errorCode === "orphaned_running_run");
  const reconcile = useMutation({
    mutationFn: () => issuesApi.resolveRecoveryAction(issueId, {
      actionId: reconciliationActionId!,
      outcome: "restored",
      sourceIssueStatus: "todo",
      executionReconciliation: {
        runId: blocker.runId!,
        providerStopped: true,
        actionOutcome: "not_performed",
        outcomeEvidence: outcomeEvidence.trim(),
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
  const retry = useMutation({
    mutationFn: () => agentsApi.retryFailedRun(failedRun!.agentId, failedRun!.runId, companyId),
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
      <span>{blocker.cause === "legacy_execution_requires_reconciliation" ? "Automatic recovery of this task stopped." : blocker.nextAction}</span>
      {failedRun && (
        <Button variant="outline" size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
          {retry.isPending ? "Retrying…" : "Retry"}
        </Button>
      )}
      {orphanedRun && reconciliationActionId && reconciliationCause === "legacy_execution_requires_reconciliation" && (
        <form className="w-full" onSubmit={(event) => {
          event.preventDefault();
          if (!ownershipHeld && confirmed && outcomeEvidence.trim().length >= 20 && !reconcile.isPending) reconcile.mutate();
        }}>
          <p>Inspect the run and external action receipts before continuing. The absence of a commit does not prove that no actions occurred.</p>
          <label htmlFor={evidenceId}>Evidence that no actions were performed</label>
          <Textarea id={evidenceId} value={outcomeEvidence} minLength={20} maxLength={12000} required
            onChange={(event) => setEvidence({ runId: blocker.runId, text: event.target.value })} />
          <Checkbox id={confirmationId} checked={confirmed}
            onCheckedChange={(checked) => setConfirmedRunId(checked === true ? blocker.runId : null)} />
          <label htmlFor={confirmationId}>I verified that the previous process stopped and no actions were performed.</label>
          <Button type="submit" variant="outline" size="sm"
            disabled={ownershipHeld || !confirmed || outcomeEvidence.trim().length < 20 || reconcile.isPending}>
            {reconcile.isPending ? "Continuing…" : "Record evidence and continue"}
          </Button>
        </form>
      )}
      {reconcile.isError && (
        <p role="alert" className="w-full text-destructive">{reconcile.error.message}</p>
      )}
      {retry.isError && (
        <p role="alert" className="w-full text-destructive">{retry.error.message}</p>
      )}
    </div>
  );
}
