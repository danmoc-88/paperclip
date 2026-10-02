// @vitest-environment jsdom

import { act as reactAct, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConnectionIntentInteraction } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  issueThreadInteractionFixtureMeta,
  pendingConnectionIntentInteraction,
  withdrawnConnectionIntentInteraction,
} from "@/fixtures/issueThreadInteractionFixtures";
import { ConnectionIntentInteractionBody } from "./ConnectionIntentInteractionBody";

/**
 * SAK-812. The sibling suite replaces `ConnectionSetupFlow` with a stub, so it
 * cannot see what the dialog actually puts on screen. Here only the HTTP client
 * is mocked: the real dialog, the real body selection and the real setup module
 * are loaded, which is what Daniel's empty overlay was about.
 */
const setupOptionsMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn());
const declineMock = vi.hoisted(() => vi.fn());
const setPhaseMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/connection-intents", () => ({
  connectionIntentsApi: {
    setupOptions: (...args: unknown[]) => setupOptionsMock(...args),
    complete: (...args: unknown[]) => completeMock(...args),
    decline: (...args: unknown[]) => declineMock(...args),
    setPhase: (...args: unknown[]) => setPhaseMock(...args),
  },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function act(callback: () => void | Promise<void>) {
  await reactAct(callback);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function renderNode(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  void act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>,
    );
  });
  return host;
}

function renderBody(interaction: ConnectionIntentInteraction) {
  return renderNode(
    <ConnectionIntentInteractionBody
      interaction={interaction}
      currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
      addresseeLabel="Carol"
    />,
  );
}

function buttons() {
  return Array.from(document.body.querySelectorAll("button")).map((candidate) =>
    candidate.textContent?.trim(),
  );
}

function dialogBody() {
  return document.body.querySelector("[role=dialog]");
}

beforeEach(() => {
  setupOptionsMock.mockReset();
  completeMock.mockReset();
  declineMock.mockReset();
  setPhaseMock.mockReset();
  setupOptionsMock.mockResolvedValue({
    requestedAgentId:
      pendingConnectionIntentInteraction.payload.requestingAgentId,
    existingConnections: [],
  });
});

afterEach(async () => {
  if (root) await act(() => root?.unmount());
  host?.remove();
  document.body
    .querySelectorAll("[data-radix-focus-guard]")
    .forEach((node) => node.remove());
  root = null;
  host = null;
});

describe("ConnectionIntentInteractionBody withdrawn request", () => {
  it("reads a withdrawn request as terminal instead of offering a dead Connect button", async () => {
    renderBody(withdrawnConnectionIntentInteraction);
    await flush();

    expect(document.body.textContent).toContain("Connection request withdrawn");
    expect(
      document.body.querySelector("[data-testid=connection-intent-terminal]"),
    ).not.toBeNull();
    expect(
      document.body.querySelector("[data-testid=connection-intent-actions]"),
    ).toBeNull();
    expect(buttons()).toEqual([]);
    // The setup query is disabled for a non-pending request, so the old card
    // had nothing to put in the dialog and no request to blame for it.
    expect(setupOptionsMock).not.toHaveBeenCalled();
  });

  it("opens no dialog at all for a withdrawn request", async () => {
    renderBody(withdrawnConnectionIntentInteraction);
    await flush();

    expect(dialogBody()).toBeNull();
  });

  it("still offers the live card while the request is pending", async () => {
    renderBody(pendingConnectionIntentInteraction);
    await flush();

    expect(buttons()).toContain("Connect");
    expect(setupOptionsMock).toHaveBeenCalledWith(
      pendingConnectionIntentInteraction.id,
    );
  });

  it("fills the dialog with the loading state rather than an empty body", async () => {
    setupOptionsMock.mockReturnValue(new Promise(() => {}));
    renderBody(pendingConnectionIntentInteraction);
    await flush();

    const connect = Array.from(document.body.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Connect",
    );
    await act(() => connect?.click());
    await flush();

    const dialog = dialogBody();
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Loading connection options…");
  });
});
