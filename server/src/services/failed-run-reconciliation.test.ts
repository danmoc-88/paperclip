import { describe, expect, it } from "vitest";
import { decideFailedRunAttention, isProviderScopedFailure } from "./failed-run-reconciliation.js";

const base = {
  failedAtMs: 1_000,
  errorCode: "adapter_failed",
  errorText: "adapter failed",
  issueStatus: "in_progress" as string | null,
  sameScopeNewer: [] as Array<{ createdAtMs: number; status: string; hasEvidence: boolean }>,
  agentSucceededAfter: false,
  dispositionAfterFailure: false,
};

describe("decideFailedRunAttention", () => {
  it("keeps an exhausted failure with no later result", () => {
    const once = decideFailedRunAttention(base);
    expect(once).toEqual({ show: true, reason: "unresolved" });
    expect(decideFailedRunAttention(base)).toEqual(once);
  });

  it("hides the row while a later run of the same scope is still active", () => {
    expect(decideFailedRunAttention({
      ...base,
      sameScopeNewer: [{ createdAtMs: 2_000, status: "running", hasEvidence: false }],
    })).toEqual({ show: false, reason: "newer_live_run" });
  });

  it("does not treat a bare success as completion of an open task", () => {
    expect(decideFailedRunAttention({
      ...base,
      sameScopeNewer: [{ createdAtMs: 2_000, status: "succeeded", hasEvidence: false }],
    })).toEqual({ show: true, reason: "success_without_evidence" });
  });

  it("clears the row after a later success that left a work trace", () => {
    expect(decideFailedRunAttention({
      ...base,
      sameScopeNewer: [{ createdAtMs: 2_000, status: "succeeded", hasEvidence: true }],
    })).toEqual({ show: false, reason: "recovered_with_evidence" });
  });

  it("shows a new failure that lands after a recovered success", () => {
    expect(decideFailedRunAttention({
      ...base,
      failedAtMs: 1_000,
      sameScopeNewer: [
        { createdAtMs: 2_000, status: "succeeded", hasEvidence: true },
        { createdAtMs: 3_000, status: "failed", hasEvidence: false },
      ],
    })).toEqual({ show: false, reason: "superseded_by_newer_failure" });
    expect(decideFailedRunAttention({
      ...base,
      failedAtMs: 3_000,
      sameScopeNewer: [],
    })).toEqual({ show: true, reason: "unresolved" });
  });

  it("keeps a done task visible while the provider failure is still open", () => {
    expect(isProviderScopedFailure("adapter_failed", "API error (status 402 Payment Required): balance exhausted")).toBe(true);
    expect(decideFailedRunAttention({
      ...base,
      errorText: "API error (status 402 Payment Required): balance exhausted",
      issueStatus: "done",
      agentSucceededAfter: false,
      dispositionAfterFailure: true,
    })).toEqual({ show: true, reason: "provider_still_open" });
  });

  it("clears a done task only after the provider recovers and a disposition is recorded", () => {
    expect(decideFailedRunAttention({
      ...base,
      errorText: "402 Payment Required balance exhausted",
      issueStatus: "done",
      agentSucceededAfter: true,
      dispositionAfterFailure: false,
    })).toEqual({ show: true, reason: "terminal_without_disposition" });
    expect(decideFailedRunAttention({
      ...base,
      errorText: "402 Payment Required balance exhausted",
      issueStatus: "done",
      agentSucceededAfter: true,
      dispositionAfterFailure: true,
    })).toEqual({ show: false, reason: "accepted_completion" });
  });

  it("leaves an open provider outage with supervision once the provider itself recovered", () => {
    expect(decideFailedRunAttention({
      ...base,
      errorCode: "claude_auth_required",
      errorText: "401 OAuth",
      issueStatus: "blocked",
      agentSucceededAfter: true,
    })).toEqual({ show: false, reason: "provider_recovered" });
  });

  it("does not invent a human acceptance", () => {
    const decision = decideFailedRunAttention({
      ...base,
      issueStatus: "in_review",
    });
    expect(decision).toEqual({ show: true, reason: "unresolved" });
    expect(decision).not.toHaveProperty("accept");
  });
});
