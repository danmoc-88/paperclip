import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { LOW_TRUST_QUARANTINED_BODY } from "./source-trust.js";
import {
  COMPACT_MESSAGE_BODY_MAX_CHARS,
  RUN_CONTEXT_COMPACTION_MARKER_KEY,
  compactTerminalRunContextSnapshot,
  createRunContextCompactionSweep,
  deliveredMessageMatches,
} from "./run-context-compaction.js";

const longBody = "Please summarize the launch thread. ".repeat(40);
const message = (id: string, body: string, extra: Record<string, unknown> = {}) => ({
  id,
  authorType: "user",
  authorId: "local-board",
  createdByRunId: null,
  body,
  createdAt: "2026-10-14T10:00:00.000Z",
  updatedAt: "2026-10-14T10:00:00.000Z",
  deleted: false,
  sourceTrust: null,
  ...extra,
});
const envelope = () => ({
  version: 1,
  issueId: "issue-1",
  objective: "Summarize the launch thread.",
  originCommentIds: ["c1"],
  completedWork: { summary: "Read notes" },
  messages: [message("c1", longBody), message("c2", "ok"), message("c3", LOW_TRUST_QUARANTINED_BODY)],
  resumeDelta: { baseRunId: "prev", messages: [message("c1", longBody)] },
});
const fullSnapshot = () => ({
  issueId: "issue-1",
  taskId: "issue-1",
  taskKey: "SAK-1",
  wakeReason: "issue_commented",
  commentId: "c1",
  executionContinuation: envelope(),
  paperclipWake: {
    reason: "issue_commented",
    comments: [{ id: "c1", body: longBody }],
    executionContinuation: envelope(),
  },
  paperclipTaskMarkdown: "t".repeat(11_000),
  paperclipTaskMarkdownCompact: "t".repeat(6_000),
  paperclipTaskMarkdownAssignment: "a".repeat(7_000),
  paperclipTaskMarkdownAssignmentCompact: "a".repeat(2_000),
  paperclipFreshSessionHandoffMarkdown: "h".repeat(15_000),
  paperclipIssue: { id: "issue-1", title: "Launch" },
});

describe("compactTerminalRunContextSnapshot", () => {
  it("drops rendered text and long bodies, keeps routing keys and everything a successor reads", () => {
    const input = fullSnapshot();
    const before = JSON.stringify(input);
    const { changed, snapshot } = compactTerminalRunContextSnapshot(input, new Date("2026-10-14T12:00:00Z"));
    expect(JSON.stringify(input)).toBe(before);
    expect(changed).toBe(true);
    const out = snapshot as Record<string, any>;
    expect(out).toMatchObject({
      issueId: "issue-1",
      taskId: "issue-1",
      taskKey: "SAK-1",
      wakeReason: "issue_commented",
      commentId: "c1",
      paperclipIssue: { id: "issue-1", title: "Launch" },
    });
    for (const key of [
      "paperclipTaskMarkdown",
      "paperclipTaskMarkdownCompact",
      "paperclipTaskMarkdownAssignment",
      "paperclipTaskMarkdownAssignmentCompact",
      "paperclipFreshSessionHandoffMarkdown",
    ]) expect(out).not.toHaveProperty(key);
    for (const ec of [out.executionContinuation, out.paperclipWake.executionContinuation]) {
      expect(ec).toMatchObject({
        objective: "Summarize the launch thread.",
        originCommentIds: ["c1"],
        completedWork: { summary: "Read notes" },
      });
      expect(ec.messages[0]).not.toHaveProperty("body");
      expect(ec.messages[0]).toMatchObject({ id: "c1", bodyOmitted: true, bodyChars: longBody.length, authorId: "local-board" });
      expect(ec.messages[1]).toEqual(message("c2", "ok"));
      expect(ec.messages[2].body).toBe(LOW_TRUST_QUARANTINED_BODY);
      expect(ec.resumeDelta.messages[0]).toMatchObject({ id: "c1", bodyOmitted: true });
    }
    // The wake's own comment list is small and read by summaries; it stays.
    expect(out.paperclipWake.comments).toEqual([{ id: "c1", body: longBody }]);
    expect(out[RUN_CONTEXT_COMPACTION_MARKER_KEY]).toEqual({
      version: 1,
      compactedAt: "2026-10-14T12:00:00.000Z",
      omittedKeys: [
        "paperclipTaskMarkdown",
        "paperclipTaskMarkdownCompact",
        "paperclipTaskMarkdownAssignment",
        "paperclipTaskMarkdownAssignmentCompact",
        "paperclipFreshSessionHandoffMarkdown",
      ],
      omittedMessageBodies: 4,
    });
    expect(JSON.stringify(out).length).toBeLessThan(before.length / 5);
  });

  it("is idempotent and leaves small snapshots untouched", () => {
    const first = compactTerminalRunContextSnapshot(fullSnapshot()).snapshot;
    expect(compactTerminalRunContextSnapshot(first)).toEqual({ changed: false, snapshot: first });
    const small = { issueId: "i", executionContinuation: { messages: [message("c", "short")] } };
    expect(compactTerminalRunContextSnapshot(small)).toEqual({ changed: false, snapshot: small });
    expect(compactTerminalRunContextSnapshot(null)).toEqual({ changed: false, snapshot: null });
  });

  it("keeps a body at exactly the limit verbatim", () => {
    const body = "x".repeat(COMPACT_MESSAGE_BODY_MAX_CHARS);
    const snapshot = { executionContinuation: { messages: [message("c", body)] } };
    expect(compactTerminalRunContextSnapshot(snapshot).changed).toBe(false);
  });
});

describe("deliveredMessageMatches", () => {
  const current = message("c1", longBody) as Parameters<typeof deliveredMessageMatches>[1];
  const compacted = (compactTerminalRunContextSnapshot({
    executionContinuation: { messages: [message("c1", longBody)] },
  }).snapshot as any).executionContinuation.messages[0];

  it("treats a compacted delivery of the same comment as delivered", () => {
    expect(deliveredMessageMatches(message("c1", longBody), current)).toBe(true);
    expect(deliveredMessageMatches(compacted, current)).toBe(true);
  });

  it("still detects edits, deletion, trust changes and quarantine release", () => {
    expect(deliveredMessageMatches(compacted, { ...current, updatedAt: "2026-10-14T11:00:00.000Z" })).toBe(false);
    expect(deliveredMessageMatches(compacted, { ...current, body: "", deleted: true })).toBe(false);
    expect(deliveredMessageMatches(compacted, { ...current, sourceTrust: { disposition: "quarantined" } })).toBe(false);
    expect(deliveredMessageMatches(compacted, { ...current, body: `${longBody}!` })).toBe(false);
    // Delivered as the quarantine placeholder (kept verbatim), now raw.
    const quarantined = message("c1", LOW_TRUST_QUARANTINED_BODY);
    expect(deliveredMessageMatches(quarantined, current)).toBe(false);
    // Delivered raw (compacted), now quarantined.
    expect(deliveredMessageMatches(compacted, { ...current, body: LOW_TRUST_QUARANTINED_BODY })).toBe(false);
  });

  it("does not accept a record that lost its body without the compaction marker fields", () => {
    const { body: _body, ...bodyless } = message("c1", longBody);
    expect(deliveredMessageMatches(bodyless, current)).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("run context compaction sweep", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const now = new Date("2026-10-14T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-run-context-compaction-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Compaction", issuePrefix: "CMP" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Exec", role: "engineer", adapterType: "process" });
  }, 120_000);
  afterAll(async () => {
    await database?.cleanup();
  });

  const insertRun = async (status: string, finishedAt: Date | null, snapshot: Record<string, unknown> = fullSnapshot()) => {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      status,
      finishedAt,
      updatedAt: finishedAt ?? now,
      contextSnapshot: snapshot,
    });
    return id;
  };
  const snapshotOf = async (id: string) =>
    (await db.select({ c: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!.c as Record<string, any>;

  it("compacts only terminal runs past the age threshold, and a repeat pass changes nothing", async () => {
    const old = await insertRun("succeeded", hoursAgo(5));
    const oldFailed = await insertRun("failed", hoursAgo(3));
    const fresh = await insertRun("succeeded", new Date(now.getTime() - 10 * 60_000));
    const running = await insertRun("running", null);
    const queued = await insertRun("queued", null);
    const sweep = createRunContextCompactionSweep(db, { now: () => now, batchSize: 1 });
    // Small batches page through with the cursor.
    let total = 0;
    for (let i = 0; i < 5; i++) total += (await sweep.sweep()).compacted;
    expect(total).toBe(2);
    for (const id of [old, oldFailed]) {
      const snap = await snapshotOf(id);
      expect(snap[RUN_CONTEXT_COMPACTION_MARKER_KEY]).toBeTruthy();
      expect(snap.issueId).toBe("issue-1");
      expect(snap).not.toHaveProperty("paperclipTaskMarkdown");
    }
    for (const id of [fresh, running, queued]) {
      expect(await snapshotOf(id)).toEqual(fullSnapshot());
    }
    // Recovery/restart: a fresh cursor re-reads everything and changes nothing.
    sweep.resetCursor();
    const before = await snapshotOf(old);
    const repeat = await sweep.sweep();
    expect(repeat.compacted).toBe(0);
    expect(await snapshotOf(old)).toEqual(before);
    // The fresh run becomes eligible once it ages.
    const later = createRunContextCompactionSweep(db, { now: () => new Date(now.getTime() + 2 * 3_600_000) });
    expect((await later.sweep()).compacted).toBe(1);
    expect((await snapshotOf(fresh))[RUN_CONTEXT_COMPACTION_MARKER_KEY]).toBeTruthy();
    expect(await snapshotOf(running)).toEqual(fullSnapshot());
  });

  it("never overwrites a concurrent context write and retries the row later", async () => {
    await db.delete(heartbeatRuns);
    const id = await insertRun("succeeded", hoursAgo(4));
    let raced = false;
    const racingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "update" && !raced) {
          return (table: unknown) => {
            raced = true;
            // Simulates chat completion delivery appending a key between read and write.
            const lateWrite = target
              .update(heartbeatRuns)
              .set({ contextSnapshot: { ...fullSnapshot(), chatCompletionDeliveryIds: ["d1"] } })
              .where(eq(heartbeatRuns.id, id));
            const builder = target.update(table as typeof heartbeatRuns);
            return {
              set: (values: any) => ({
                where: (cond: any) => ({
                  returning: async (cols: any) => {
                    await lateWrite;
                    return builder.set(values).where(cond).returning(cols);
                  },
                }),
              }),
            };
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;
    const sweep = createRunContextCompactionSweep(racingDb, { now: () => now });
    const first = await sweep.sweep();
    expect(first).toMatchObject({ compacted: 0, skippedConcurrentWrite: 1 });
    const afterRace = await snapshotOf(id);
    expect(afterRace.chatCompletionDeliveryIds).toEqual(["d1"]);
    expect(afterRace.paperclipTaskMarkdown).toBeDefined();
    const second = await sweep.sweep();
    expect(second.compacted).toBe(1);
    const final = await snapshotOf(id);
    expect(final.chatCompletionDeliveryIds).toEqual(["d1"]);
    expect(final[RUN_CONTEXT_COMPACTION_MARKER_KEY]).toBeTruthy();
  });

  it("skips a run that left the terminal state between read and write", async () => {
    await db.delete(heartbeatRuns);
    const id = await insertRun("failed", hoursAgo(4));
    let flipped = false;
    const flippingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "update" && !flipped) {
          flipped = true;
          return (table: unknown) => {
            const builder = target.update(table as typeof heartbeatRuns);
            return {
              set: (values: any) => ({
                where: (cond: any) => ({
                  returning: async (cols: any) => {
                    await target.update(heartbeatRuns).set({ status: "scheduled_retry" }).where(eq(heartbeatRuns.id, id));
                    return builder.set(values).where(cond).returning(cols);
                  },
                }),
              }),
            };
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;
    const result = await createRunContextCompactionSweep(flippingDb, { now: () => now }).sweep();
    expect(result.compacted).toBe(0);
    expect(await snapshotOf(id)).toEqual(fullSnapshot());
  });
});
