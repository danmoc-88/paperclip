import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ISSUE_STATUSES } from "../constants.js";
import { LOW_TRUST_REVIEW_PRESET } from "../trust-policy.js";
import {
  ISSUE_COMPLETED_STAGE_LIMIT,
  ISSUE_DEPENDENCY_LIMIT,
  ISSUE_EXECUTION_STAGE_LIMIT,
  ISSUE_EXECUTION_STAGE_PARTICIPANT_LIMIT,
  ISSUE_LABEL_LIMIT,
  checkoutIssueSchema,
  createIssueSchema,
  updateIssueSchema,
} from "./issue.js";
import { TRUST_BOUNDARY_COLLECTION_LIMIT } from "./trust-policy.js";
import {
  PORTABILITY_ENTITY_COLLECTION_LIMIT,
  PORTABILITY_MANIFEST_COLLECTION_LIMIT,
  PORTABILITY_OVERRIDE_MAP_LIMIT,
  companyPortabilityImportSchema,
  portabilityManifestSchema,
} from "./company-portability.js";

const guid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function expectSingleIssue(
  result: z.ZodSafeParseResult<unknown>,
  path: (string | number)[],
  code: "too_big" | "custom" = "too_big",
) {
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues).toHaveLength(1);
  expect(result.error.issues[0]?.code).toBe(code);
  expect(result.error.issues[0]?.path).toEqual(path);
}

describe("zod leading collection limits", () => {
  it("stops before element parsing when the size bound leads the checks", () => {
    let elementParses = 0;
    const element = z.string().refine(() => {
      elementParses += 1;
      return true;
    });
    const schema = z.array(element).max(5);

    elementParses = 0;
    const over = schema.safeParse(Array.from({ length: 5_000 }, () => "x"));
    expect(over.success).toBe(false);
    expect(elementParses).toBe(0);

    elementParses = 0;
    const atLimit = schema.safeParse(Array.from({ length: 5 }, () => "x"));
    expect(atLimit.success).toBe(true);
    expect(elementParses).toBe(5);
  });

  it("keeps the leading-cap contract: a refine before max disarms the early stop", () => {
    let elementParses = 0;
    const element = z.string().refine(() => {
      elementParses += 1;
      return true;
    });
    // Regression guard for the ordering rule. Every limit in the validators
    // must stay ahead of any refine; this documents the failure mode.
    const refineFirst = z
      .array(element)
      .refine(() => true)
      .max(5);

    elementParses = 0;
    const result = refineFirst.safeParse(Array.from({ length: 5_000 }, () => "x"));
    expect(result.success).toBe(false);
    expect(elementParses).toBe(5_000);
  });

  it("rejects over-limit issue collections before parsing their elements", () => {
    const overBlockers = Array.from(
      { length: ISSUE_DEPENDENCY_LIMIT + 1 },
      () => "not-a-guid",
    );
    expectSingleIssue(
      createIssueSchema.safeParse({ title: "Task", blockedByIssueIds: overBlockers }),
      ["blockedByIssueIds"],
    );

    const overLabels = Array.from(
      { length: ISSUE_LABEL_LIMIT + 1 },
      (_, index) => guid(index),
    );
    expectSingleIssue(updateIssueSchema.safeParse({ labelIds: overLabels }), [
      "labelIds",
    ]);

    const overStatuses = Array.from(
      { length: ISSUE_STATUSES.length + 1 },
      () => "todo",
    );
    expectSingleIssue(
      checkoutIssueSchema.safeParse({
        agentId: guid(1),
        expectedStatuses: overStatuses,
      }),
      ["expectedStatuses"],
    );
  });

  it("accepts the exact limit and still reports element type errors below it", () => {
    const atLimit = Array.from({ length: ISSUE_DEPENDENCY_LIMIT }, (_, index) =>
      guid(index),
    );
    expect(
      createIssueSchema.safeParse({ title: "Task", blockedByIssueIds: atLimit })
        .success,
    ).toBe(true);

    const typeError = createIssueSchema.safeParse({
      title: "Task",
      blockedByIssueIds: ["not-a-guid"],
    });
    expect(typeError.success).toBe(false);
    if (!typeError.success) {
      expect(typeError.error.issues).toHaveLength(1);
      expect(typeError.error.issues[0]?.code).not.toBe("too_big");
      expect(typeError.error.issues[0]?.path).toEqual(["blockedByIssueIds", 0]);
    }

    const atStatusLimit = Array.from(
      { length: ISSUE_STATUSES.length },
      () => "todo",
    );
    expect(
      checkoutIssueSchema.safeParse({
        agentId: guid(1),
        expectedStatuses: atStatusLimit,
      }).success,
    ).toBe(true);
  });

  it("bounds the collections nested inside an issue execution policy", () => {
    const overStages = Array.from(
      { length: ISSUE_EXECUTION_STAGE_LIMIT + 1 },
      () => ({ type: "approval" }),
    );
    expectSingleIssue(
      createIssueSchema.safeParse({
        title: "Task",
        executionPolicy: { stages: overStages },
      }),
      ["executionPolicy", "stages"],
    );

    const overParticipants = Array.from(
      { length: ISSUE_EXECUTION_STAGE_PARTICIPANT_LIMIT + 1 },
      () => ({}),
    );
    expectSingleIssue(
      createIssueSchema.safeParse({
        title: "Task",
        executionPolicy: {
          stages: [{ type: "approval", participants: overParticipants }],
        },
      }),
      ["executionPolicy", "stages", 0, "participants"],
    );

    const overTrustBoundary = Array.from(
      { length: TRUST_BOUNDARY_COLLECTION_LIMIT + 1 },
      (_, index) => guid(index),
    );
    expectSingleIssue(
      createIssueSchema.safeParse({
        title: "Task",
        executionPolicy: {
          authorizationPolicy: {
            trustBoundary: {
              mode: LOW_TRUST_REVIEW_PRESET,
              issueIds: overTrustBoundary,
            },
          },
        },
      }),
      [
        "executionPolicy",
        "authorizationPolicy",
        "trustBoundary",
        "issueIds",
      ],
    );
  });

  it("rejects an oversized company manifest array before parsing entries", () => {
    const overAgents = Array.from(
      { length: PORTABILITY_MANIFEST_COLLECTION_LIMIT + 1 },
      () => ({}),
    );
    expectSingleIssue(
      portabilityManifestSchema.safeParse({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        source: null,
        includes: {
          company: false,
          agents: false,
          projects: false,
          issues: false,
          skills: false,
        },
        company: null,
        sidebar: null,
        agents: overAgents,
      }),
      ["agents"],
    );
  });

  it("keeps a normal company manifest valid under the new bounds", () => {
    const result = portabilityManifestSchema.safeParse({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: null,
      includes: {
        company: false,
        agents: false,
        projects: false,
        issues: false,
        skills: false,
      },
      company: null,
      sidebar: null,
      agents: [
        {
          slug: "ceo",
          name: "CEO",
          path: "agents/ceo/AGENTS.md",
          skills: [],
          role: "ceo",
          title: null,
          icon: null,
          capabilities: null,
          reportsToSlug: null,
          adapterType: "claude",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
          permissionGrants: [],
          budgetMonthlyCents: 0,
          metadata: null,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("gates oversized inline file maps and override maps before entry parsing", () => {
    const overFiles = Object.fromEntries(
      Array.from({ length: 50_001 }, (_, index) => [`file-${index}`, "x"]),
    );
    expectSingleIssue(
      companyPortabilityImportSchema.safeParse({
        source: { type: "inline", files: overFiles },
        target: { mode: "new_company" },
      }),
      ["source", "files"],
      "custom",
    );

    const overOverrides = Object.fromEntries(
      Array.from({ length: PORTABILITY_OVERRIDE_MAP_LIMIT + 1 }, (_, index) => [
        `agent-${index}`,
        "renamed",
      ]),
    );
    expectSingleIssue(
      companyPortabilityImportSchema.safeParse({
        source: { type: "inline", files: {} },
        target: { mode: "new_company" },
        nameOverrides: overOverrides,
      }),
      ["nameOverrides"],
      "custom",
    );
  });

  it("accepts an inline import at the file-map and override-map limits", () => {
    const files = Object.fromEntries(
      Array.from({ length: 50_000 }, (_, index) => [`file-${index}`, "x"]),
    );
    const overrides = Object.fromEntries(
      Array.from({ length: PORTABILITY_OVERRIDE_MAP_LIMIT }, (_, index) => [
        `agent-${index}`,
        "renamed",
      ]),
    );
    const result = companyPortabilityImportSchema.safeParse({
      source: { type: "inline", files },
      target: { mode: "new_company" },
      nameOverrides: overrides,
    });
    expect(result.success).toBe(true);
  });

  it("documents the entity collection limit used for nested issue lists", () => {
    expect(PORTABILITY_ENTITY_COLLECTION_LIMIT).toBe(5_000);
    expect(ISSUE_COMPLETED_STAGE_LIMIT).toBe(ISSUE_EXECUTION_STAGE_LIMIT * 2);
  });
});
