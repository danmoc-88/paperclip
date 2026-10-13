// Decides whether an exhausted failed/timed_out run still belongs in the
// active decision feed. History of the run is never deleted. The function is
// pure so the same inputs always yield the same decision (idempotent, no
// retry loop). It does not accept human cards, dismiss rows, or wake agents.

export const FAILED_RUN_EVIDENCE_ACTIONS = [
  "issue.comment_added",
  "issue.updated",
  "issue.document_created",
  "issue.document_updated",
  "issue.work_product_created",
] as const;

const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

export type ScopeRun = {
  createdAtMs: number;
  status: string;
  hasEvidence: boolean;
};

export type FailedRunDecisionReason =
  | "newer_live_run"
  | "recovered_with_evidence"
  | "accepted_completion"
  | "provider_recovered"
  | "superseded_by_newer_failure"
  | "unresolved"
  | "success_without_evidence"
  | "provider_still_open"
  | "terminal_without_disposition";

export type FailedRunAttentionInput = {
  failedAtMs: number;
  errorCode: string | null;
  errorText: string | null;
  issueStatus: string | null;
  sameScopeNewer: ScopeRun[];
  agentSucceededAfter: boolean;
  dispositionAfterFailure: boolean;
};

export function isProviderScopedFailure(errorCode: string | null, errorText: string | null): boolean {
  const code = errorCode ?? "";
  if (code === "claude_auth_required" || code === "codex_auth_required") return true;
  const text = `${code}\n${errorText ?? ""}`.toLowerCase();
  return text.includes("402")
    || text.includes("payment required")
    || text.includes("balance exhausted")
    || text.includes("requires more credits")
    || text.includes("usage balance");
}

export function decideFailedRunAttention(input: FailedRunAttentionInput): {
  show: boolean;
  reason: FailedRunDecisionReason;
} {
  const newer = input.sameScopeNewer
    .filter((run) => run.createdAtMs > input.failedAtMs)
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
  if (newer.some((run) => run.status === "queued" || run.status === "running")) {
    return { show: false, reason: "newer_live_run" };
  }
  const evidenceRecovery = newer.find((run) => run.status === "succeeded" && run.hasEvidence);
  const failureAfterRecovery = evidenceRecovery
    ? newer.find((run) =>
      (run.status === "failed" || run.status === "timed_out")
      && run.createdAtMs > evidenceRecovery.createdAtMs)
    : undefined;
  // The later failure is evaluated on its own row. This older row leaves the feed.
  if (failureAfterRecovery) return { show: false, reason: "superseded_by_newer_failure" };
  if (evidenceRecovery) return { show: false, reason: "recovered_with_evidence" };
  if (newer.some((run) => run.status === "failed" || run.status === "timed_out")) {
    return { show: false, reason: "superseded_by_newer_failure" };
  }

  const provider = isProviderScopedFailure(input.errorCode, input.errorText);
  const terminal = input.issueStatus !== null && TERMINAL_ISSUE_STATUSES.has(input.issueStatus);
  const bareSuccess = newer.some((run) => run.status === "succeeded" && !run.hasEvidence);

  if (!terminal && bareSuccess) {
    return { show: true, reason: "success_without_evidence" };
  }

  if (terminal && provider && !input.agentSucceededAfter) {
    return { show: true, reason: "provider_still_open" };
  }

  if (input.issueStatus === null && input.agentSucceededAfter) {
    return { show: false, reason: "accepted_completion" };
  }

  if ((terminal || input.issueStatus === null) && input.dispositionAfterFailure && (!provider || input.agentSucceededAfter)) {
    return { show: false, reason: "accepted_completion" };
  }

  if (terminal) {
    return { show: true, reason: "terminal_without_disposition" };
  }

  if (provider && input.agentSucceededAfter) {
    return { show: false, reason: "provider_recovered" };
  }

  return { show: true, reason: "unresolved" };
}
