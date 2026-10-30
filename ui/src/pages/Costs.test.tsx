// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Costs } from "./Costs";

const upsertPolicyMock = vi.hoisted(() => vi.fn());
const budgetOverviewMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const costsApiMocks = vi.hoisted(() => ({
  summary: vi.fn(),
  byAgent: vi.fn(),
  byProject: vi.fn(),
  byAgentModel: vi.fn(),
  financeSummary: vi.fn(),
  financeByBiller: vi.fn(),
  financeByKind: vi.fn(),
  financeEvents: vi.fn(),
  byProvider: vi.fn(),
  byBiller: vi.fn(),
  windowSpend: vi.fn(),
  quotaWindows: vi.fn(),
}));

vi.mock("../api/budgets", () => ({
  budgetsApi: {
    overview: (...args: unknown[]) => budgetOverviewMock(...args),
    upsertPolicy: (...args: unknown[]) => upsertPolicyMock(...args),
    resolveIncident: vi.fn(),
  },
}));

vi.mock("../api/costs", () => ({ costsApi: costsApiMocks }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Costs embedded Audit surfaces", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    upsertPolicyMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    budgetOverviewMock.mockResolvedValue({
      policies: [],
      activeIncidents: [],
      pendingApprovalCount: 0,
      pausedAgentCount: 0,
      pausedProjectCount: 0,
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders a focused Budgets section without duplicate Costs chrome or spend queries", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Costs embedded initialTab="budgets" lockTab />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(budgetOverviewMock).toHaveBeenCalledWith("company-1");
        expect(container.textContent).toContain("Budget control plane");
      });
    });
    expect(container.textContent).not.toContain("Inference spend");
    expect(container.querySelector('[role="tab"]')).toBeFalsy();
    expect(setBreadcrumbsMock).not.toHaveBeenCalled();
    for (const mock of Object.values(costsApiMocks)) expect(mock).not.toHaveBeenCalled();
  });
  async function renderBudgets() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><Costs embedded initialTab="budgets" lockTab /></QueryClientProvider>);
    });
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("Budget control plane")); });
  }

  function enterBudget(value: string) {
    const input = container.querySelector<HTMLInputElement>("#company-monthly-budget")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("creates the first organization monthly policy and shows the server read-back", async () => {
    await renderBudgets();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    enterBudget("1000");
    upsertPolicyMock.mockImplementation(async () => {
      budgetOverviewMock.mockResolvedValue({
        policies: [{ policyId: "policy-1", scopeType: "company", scopeId: "company-1", scopeName: "Test organization",
          amount: 100000, observedAmount: 638, remainingAmount: 99362, utilizationPercent: 0.638,
          windowKind: "calendar_month_utc", warnPercent: 80, status: "healthy", paused: false }],
        activeIncidents: [], pendingApprovalCount: 0, pausedAgentCount: 0, pausedProjectCount: 0,
      });
    });
    await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(upsertPolicyMock).toHaveBeenCalledWith("company-1", {
      scopeType: "company", scopeId: "company-1", amount: 100000, windowKind: "calendar_month_utc",
    });
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("Test organization")); });
    expect(container.querySelector("#company-monthly-budget")).toBeNull();
    expect(container.textContent).toContain("Update budget");
  });

  it("keeps Save disabled until the delayed server read-back completes", async () => {
    await renderBudgets();
    enterBudget("1000");
    let finishRead!: (value: unknown) => void;
    upsertPolicyMock.mockResolvedValue({});
    budgetOverviewMock.mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
    await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await act(async () => { await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)); });
    expect(upsertPolicyMock).toHaveBeenCalledTimes(1);
    await act(async () => { finishRead({ policies: [], activeIncidents: [], pendingApprovalCount: 0, pausedAgentCount: 0, pausedProjectCount: 0 }); });
    await act(async () => { await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false)); });
  });

  it.each(["", "-1", "no", "Infinity", "0", "999999999999999999999"])("does not submit invalid initial limit %s", async (value) => {
    await renderBudgets();
    enterBudget(value);
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(upsertPolicyMock).not.toHaveBeenCalled();
  });

  it("keeps the draft and displays a board authorization denial without claiming success", async () => {
    upsertPolicyMock.mockRejectedValue(new Error("Board access required"));
    await renderBudgets();
    enterBudget("1000");
    await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await act(async () => { await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toBe("Board access required")); });
    expect(container.querySelector<HTMLInputElement>("#company-monthly-budget")!.value).toBe("1000");
    expect(container.textContent).toContain("No monthly cap configured");
  });

});
