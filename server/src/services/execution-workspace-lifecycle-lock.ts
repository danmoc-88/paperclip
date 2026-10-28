import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Acquire the per-workspace, transaction-scoped Postgres advisory lock. Postgres
// releases the lock when the transaction that holds `tx` commits or rolls back.
// Both the reopen path and the destructive cleanup path acquire the same lock,
// so they never run against the same workspace at the same time, even on
// different server processes.
export async function acquireExecutionWorkspaceLifecycleLock(
  tx: DbTransaction,
  workspaceId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`execution_workspace_lifecycle:${workspaceId}`}, 0))`,
  );
}
