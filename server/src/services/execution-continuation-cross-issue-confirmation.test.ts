import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issueThreadInteractions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { buildExecutionContinuation } from "./execution-continuation.js";

// Regression for a confirmation card created on a child task by a run that was
// scoped to the parent task (paperclipai/paperclip#13704). On 2026.916.0 the
// accepted card's wake failed with `continuation_source_context_missing`
// before the adapter started, and recovery parked the task as blocked.
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("confirmation created from a parent-task run", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-continuation-cross-issue-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(status: "accepted" | "pending") {
    const companyId = randomUUID(), agentId = randomUUID(), cardIssueId = randomUUID(), parentIssueId = randomUUID();
    const producerRunId = randomUUID(), interactionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cross-issue fixture", issuePrefix: `CRS${companyId.slice(0, 8)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Executor", role: "engineer", adapterType: "paperclip_runner" });
    await db.insert(issues).values([
      { id: parentIssueId, companyId, title: "Pilot", status: "blocked", assigneeAgentId: agentId },
      { id: cardIssueId, companyId, parentId: parentIssueId, title: "Decision: test environment", status: "in_review", assigneeAgentId: agentId },
    ]);
    await db.insert(issueComments).values({ companyId, issueId: cardIssueId, authorType: "agent", authorAgentId: agentId, body: "Card created; waiting for the answer." });
    await db.insert(heartbeatRuns).values({ id: producerRunId, companyId, agentId, status: "succeeded",
      contextSnapshot: { issueId: parentIssueId, wakeReason: "finish_successful_run_handoff" },
      resultJson: { summary: "Parent pilot design.", apiToolReceipts: { parent: { state: "completed", operationId: "parent_design_saved", result: "Parent only." } } },
    });
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId, issueId: cardIssueId,
      kind: "request_confirmation", status, sourceRunId: producerRunId, originCommentIds: [],
      createdByAgentId: agentId,
      ...(status === "accepted" ? { resolvedByUserId: "board-user", resolvedAt: new Date(), result: { version: 1, outcome: "accepted" } } : {}),
      payload: { version: 1, prompt: "Use the dev environment?", acceptLabel: "Yes", rejectLabel: "No" },
    });
    // Same wake context the server stored for the failed runs.
    const build = () => buildExecutionContinuation({
      db, companyId, issueId: cardIssueId, agentId, summary: null, exposeLowTrustRaw: false,
      context: { source: "issue.interaction.accept", issueId: cardIssueId, wakeReason: "issue_commented",
        interactionId, interactionKind: "request_confirmation", interactionStatus: status, sourceRunId: producerRunId },
    });
    return { companyId, agentId, cardIssueId, producerRunId, interactionId, build };
  }

  it("rebuilds the accepted decision from durable task data instead of failing setup", async () => {
    const f = await fixture("accepted");
    const envelope = await f.build();
    expect(envelope.trigger).toEqual(expect.objectContaining({ interactionId: f.interactionId, sourceRunId: f.producerRunId }));
    expect(envelope.interactionOutcomes).toEqual([expect.objectContaining({ id: f.interactionId, status: "accepted" })]);
    expect(envelope.unresolvedInteractionIds).toEqual([]);
    // The parent run is provenance only: its summary and receipts stay out of the card's envelope.
    expect(envelope.completedWork).toBeNull();
    expect(envelope.completedActions).toEqual([]);
    expect(JSON.stringify(envelope)).not.toContain("Parent");
  });

  it("reports the recorded follow-up as completed on the next wake so it is not repeated", async () => {
    const f = await fixture("accepted");
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      contextSnapshot: { issueId: f.cardIssueId, interactionId: f.interactionId },
      resultJson: { apiToolReceipts: { record: { state: "completed", operationId: "record_decision_in_parent", result: "Recorded once." } } },
    });
    const envelope = await f.build();
    expect(envelope.completedActions).toEqual([expect.objectContaining({ operationId: "record_decision_in_parent" })]);
  });

  it("keeps a card without a recorded human answer unresolved", async () => {
    const f = await fixture("pending");
    const envelope = await f.build();
    expect(envelope.unresolvedInteractionIds).toEqual([f.interactionId]);
    expect(envelope.interactionOutcomes).toEqual([]);
  });
});
