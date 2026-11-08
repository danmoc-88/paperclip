/**
 * End-to-end coverage for the credential sign-up and sign-in that a
 * self-hosted install depends on, driven through the real Better Auth mount
 * against the real Drizzle schema and a migrated Postgres.
 *
 * The other Better Auth suites mount either a stub handler or the in-memory
 * adapter, so neither notices when Better Auth's `account` model grows a field
 * the Drizzle table does not have. The Drizzle adapter validates the model
 * against the schema on every write and throws
 * `The field "<name>" does not exist in the "account" Drizzle schema`, which
 * the mount turns into a 500 with an empty body — a fresh install cannot
 * create its first user at all. This suite is the one that fails when that
 * happens.
 */

import express from "express";
import fs from "node:fs";
import { hashPassword } from "better-auth/crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authAccounts, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createBetterAuthHandler, createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";

const ORIGIN = "http://127.0.0.1:41999";
const EMAIL = "founder@example.com";
const PASSWORD = "correct-horse-battery-staple";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function testConfig(): Config {
  // Only the auth-relevant fields are read by `createBetterAuthInstance`; the
  // rest of `Config` describes storage, backups, and scheduling that the Better
  // Auth instance never looks at.
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: ORIGIN,
    authDisableSignUp: false,
    allowedHostnames: ["127.0.0.1"],
    port: 41999,
  } as unknown as Config;
}

function sessionCookies(response: request.Response): string[] {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.filter((cookie) => cookie.includes("session_token"));
}

describeEmbeddedPostgres("Better Auth credential sign-up against the real schema", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  const originalEnv = {
    secret: process.env.BETTER_AUTH_SECRET,
    rateLimit: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
  };

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-credential-signup-tests";
    // The rate limiter is on by default in `authenticated` mode and would score
    // the sign-up and sign-in this suite issues back to back.
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";

    database = await startEmbeddedPostgresTestDatabase("paperclip-better-auth-signup-");
    db = createDb(database.connectionString);

    // Reconstruct the pre-upgrade schema on this disposable database only.
    const sql = createDb(database.connectionString, { maxConnections: 1 }).$client;
    try {
      await sql`DROP INDEX "account_provider_account_id_uq"`;
      await sql`ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL`;
      await sql`CREATE UNIQUE INDEX "account_issuer_account_id_uq" ON "account" ("issuer", "account_id")`;
      await sql`INSERT INTO "user" (id, name, email, created_at, updated_at)
        VALUES ('legacy-user', 'Existing user', 'existing@example.com', now(), now())`;
      await sql`INSERT INTO "account" (id, issuer, account_id, provider_id, user_id, password, created_at, updated_at)
        VALUES ('legacy-account', 'local:credential', 'legacy-user', 'credential', 'legacy-user', ${await hashPassword(PASSWORD)}, now(), now())`;
      const migration = fs.readFileSync(new URL("../../../packages/db/src/migrations/0295_better_auth_provider_key.sql", import.meta.url), "utf8");
      // The old issuer key allowed an ambiguous provider/account pair.
      await sql`INSERT INTO "account" (id, issuer, account_id, provider_id, user_id, created_at, updated_at)
        VALUES ('conflicting-account', 'other-issuer', 'legacy-user', 'credential', 'legacy-user', now(), now())`;
      await expect(sql.begin(async (tx) => {
        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim()) await tx.unsafe(statement);
        }
      })).rejects.toThrow("Duplicate account provider/account IDs");
      const [column] = await sql`SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'issuer'`;
      expect(column.is_nullable).toBe("NO");
      const rows = await sql`SELECT id FROM "account"`;
      expect(rows).toHaveLength(2);
      // Remove only our synthetic conflicting fixture, then retry the upgrade.
      await sql`DELETE FROM "account" WHERE id = 'conflicting-account'`;
      await sql.begin(async (tx) => {
        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim()) await tx.unsafe(statement);
        }
      });
    } finally {
      await sql.end();
    }

    const auth = createBetterAuthInstance(db, testConfig(), [ORIGIN]);
    app = express();
    // Mounted exactly as `createApp` mounts it, and with no body parser in
    // front of it: Better Auth reads the raw request body itself.
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
    if (originalEnv.secret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalEnv.secret;
    if (originalEnv.rateLimit === undefined) delete process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED;
    else process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = originalEnv.rateLimit;
  });

  it("preserves an existing credential account, login, and session after migration", async () => {
    const accounts = await db.select().from(authAccounts);
    expect(accounts.find((account) => account.id === "legacy-account")?.issuer).toBe("local:credential");
    const signIn = await request(app).post("/api/auth/sign-in/email")
      .set("origin", ORIGIN).send({ email: "existing@example.com", password: PASSWORD });
    expect(signIn.status).toBe(200);
    const cookies = sessionCookies(signIn).map((cookie) => cookie.split(";")[0]);
    expect(cookies.length).toBeGreaterThan(0);
    const session = await request(app).get("/api/auth/get-session").set("Cookie", cookies);
    expect(session.status).toBe(200);
    expect(session.body?.user?.id).toBe("legacy-user");
    const wrongPassword = await request(app).post("/api/auth/sign-in/email")
      .set("origin", ORIGIN).send({ email: "existing@example.com", password: "wrong-password" });
    expect(wrongPassword.status).toBe(401);
  });

  it("creates the user and its credential account, then signs that user in", async () => {
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: EMAIL, password: PASSWORD, name: "Founder" });

    // A missing `account` column fails here with a 500 and an empty body.
    expect(signUp.status).toBe(200);
    expect(signUp.body?.user?.email).toBe(EMAIL);

    // Sign-up has to leave a usable account row behind. A half-created user —
    // a `user` row with no `account` — cannot sign in, cannot sign up again,
    // and cannot reset its password.
    const accounts = await db.select().from(authAccounts);
    expect(accounts).toHaveLength(2);
    const newAccount = accounts.find((account) => account.providerId === "credential" && account.issuer === null);
    expect(newAccount).toMatchObject({
      providerId: "credential",
      issuer: null,
    });
    expect(newAccount?.password).toBeTruthy();

    const signIn = await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: EMAIL, password: PASSWORD });

    expect(signIn.status).toBe(200);
    expect(signIn.body?.user?.email).toBe(EMAIL);
    expect(sessionCookies(signIn).length).toBeGreaterThan(0);
  });
});
