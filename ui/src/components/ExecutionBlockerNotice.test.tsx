// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExecutionBlockerNotice } from "./ExecutionBlockerNotice";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
vi.mock("../api/issues", () => ({ issuesApi: { resolveRecoveryAction: vi.fn() } }));
vi.mock("../api/agents", () => ({ agentsApi: { retryFailedRun: vi.fn() } }));
vi.mock("../api/activity", () => ({ activityApi: { runsForIssue: vi.fn() } }));

describe("stopped task recovery notice", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  const onRetried = vi.fn();
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.mocked(activityApi.runsForIssue).mockResolvedValue([{ runId: "failed-run", agentId: "agent", status: "failed" }] as never);
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "failed-run", agentId: "agent", cause: "legacy_execution_requires_reconciliation",
        nextAction: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated.",
      }} />
    </QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals(); });
  it("shows only the requested sentence and Retry, inside a distinct recovery container", () => {
    const notice = container.querySelector('[role="status"][aria-label="Task recovery"]')!;
    expect(notice.textContent).toBe("Automatic recovery of this task stopped.Retry");
    expect(notice.classList.contains("border")).toBe(true);
    expect(notice.classList.contains("bg-muted")).toBe(true);
    expect(notice.querySelector("a")).toBeNull();
  });
  it("keeps the required next action for other reconciliation causes", async () => {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried} blocker={{
        recoveryActionId: "recovery", runId: "failed-run", agentId: "agent", cause: "action_outcome_unknown",
        nextAction: "Verify the external action outcome before continuing.",
      }} />
    </QueryClientProvider>));
    expect(container.textContent).toContain("Verify the external action outcome before continuing.");
    expect(container.textContent).not.toContain("Automatic recovery of this task stopped.");
  });
  it("retries the exact failed run and refreshes the task", async () => {
    vi.mocked(agentsApi.retryFailedRun).mockResolvedValue({} as never);
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(agentsApi.retryFailedRun).toHaveBeenCalledWith("agent", "failed-run", "company");
    expect(onRetried).toHaveBeenCalledOnce();
  });
  it("requires evidence and confirmation to reconcile an interrupted run", async () => {
    await act(async () => {
      client.setQueryData([...(await import("../lib/queryKeys")).queryKeys.issues.runs("task")],
        [{ runId: "failed-run", agentId: "agent", status: "interrupted" }]);
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit).not.toBeNull();
    expect(submit.disabled).toBe(true);
    expect(container.textContent).not.toContain("Retry");
    const evidence = "Read the logs and receipts: no external actions were submitted.";
    await act(async () => {
      const textarea = container.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, evidence);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click();
    });
    expect(submit.disabled).toBe(false);
    vi.mocked(issuesApi.resolveRecoveryAction).mockResolvedValue({} as never);
    await act(async () => submit.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(issuesApi.resolveRecoveryAction).toHaveBeenCalledWith("task", {
      actionId: "recovery", outcome: "restored", sourceIssueStatus: "todo",
      executionReconciliation: { runId: "failed-run", providerStopped: true,
        actionOutcome: "not_performed", outcomeEvidence: evidence },
    });
    expect(agentsApi.retryFailedRun).not.toHaveBeenCalled();
    expect(onRetried).toHaveBeenCalledOnce();
  });
  it.each([true, false])("keeps reconciliation visible with ownership hold=%s", async (held) => {
    await act(async () => {
      client.setQueryData([...(await import("../lib/queryKeys")).queryKeys.issues.runs("task")],
        [{ runId: "failed-run", agentId: "agent", status: "interrupted" }]);
      root.render(<QueryClientProvider client={client}>
        <ExecutionBlockerNotice companyId="company" issueId="task" onRetried={onRetried}
          blocker={held ? { recoveryActionId: null, runId: "failed-run", agentId: "agent",
            cause: "execution_owner_active", nextAction: "Wait for environment cleanup." } : null}
          recoveryAction={{ id: "recovery", cause: "legacy_execution_requires_reconciliation",
            evidence: { runId: "failed-run" }, nextAction: "Reconcile outcomes." } as never} />
      </QueryClientProvider>);
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    if (held) expect(container.textContent).toContain("Wait for environment cleanup.");
  });
  it("shows a failed Retry in the same container and allows another attempt", async () => {
    vi.mocked(agentsApi.retryFailedRun).mockRejectedValue(new Error("Environment cleanup is still running."));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Environment cleanup is still running.");
    expect(container.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
    expect(onRetried).not.toHaveBeenCalled();
  });
});
