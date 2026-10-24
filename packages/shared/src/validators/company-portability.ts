import { agentAppearanceSchema } from "../agent-appearance.js";
import { z } from "zod";
import { PERMISSION_KEYS } from "../constants.js";
import {
  issueCommentAuthorTypeSchema,
  issueCommentMetadataSchema,
  issueCommentPresentationSchema,
} from "./issue.js";
import { routineVariableSchema } from "./routine.js";

// Leading collection bounds for the company portability contracts. The import
// body is already capped (64 MiB inline), but an unbounded `z.array` or a typed
// `z.record` still makes Zod build one issue per invalid element or key. Zod v4
// only aborts before parsing elements when a size bound is the leading check on
// the collection (4.6.6+), so these `.max()` calls stay ahead of any
// default/optional and the typed records use a pre-parse key count.
//
// The ceilings are abuse guards, not derived product limits. Each one is set
// well above a typical package, but an unusually large package can exceed an
// entry-count ceiling while still fitting the body cap. The import path
// validates the count itself and reports it as a validation error.
export const PORTABILITY_MANIFEST_COLLECTION_LIMIT = 50_000;
export const PORTABILITY_ENTITY_COLLECTION_LIMIT = 5_000;
export const PORTABILITY_ROUTINE_COLLECTION_LIMIT = 1_000;
export const PORTABILITY_SELECTOR_LIMIT = 100_000;
export const PORTABILITY_INLINE_FILE_LIMIT = 50_000;
export const PORTABILITY_OVERRIDE_MAP_LIMIT = 5_000;

// Zod bounds arrays, sets, and maps before parsing elements, but not records.
// Count the keys before the record parses its values, so an oversized map fails
// with one issue and parses no entry. The `.pipe` does not run the record schema
// once the key-count check adds an issue.
function boundedRecordKeys<T extends z.ZodTypeAny>(
  recordSchema: T,
  maxKeys: number,
  label: string,
): T {
  return z
    .unknown()
    .superRefine((value, ctx) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return;
      }
      const keyCount = Object.keys(value as Record<string, unknown>).length;
      if (keyCount > maxKeys) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must have at most ${maxKeys} entries`,
        });
      }
    })
    .pipe(recordSchema) as unknown as T;
}

export const portabilityIncludeSchema = z
  .object({
    company: z.boolean().optional(),
    agents: z.boolean().optional(),
    projects: z.boolean().optional(),
    issues: z.boolean().optional(),
    skills: z.boolean().optional(),
  })
  .partial();

export const portabilityEnvInputSchema = z.object({
  key: z.string().min(1),
  description: z.string().nullable(),
  agentSlug: z.string().min(1).nullable(),
  projectSlug: z.string().min(1).nullable(),
  kind: z.enum(["secret", "plain"]),
  requirement: z.enum(["required", "optional"]),
  defaultValue: z.string().nullable(),
  portability: z.enum(["portable", "system_dependent"]),
});

export const portabilityFileEntrySchema = z.union([
  z.string(),
  z.object({
    encoding: z.literal("base64"),
    data: z.string(),
    contentType: z.string().min(1).optional().nullable(),
  }),
]);

// Deliberately non-strict: packages exported by older versions still carry
// retired company keys such as `brandColor` and `attachmentMaxBytes`. Zod
// strips keys the schema does not name, so those bundles keep importing —
// the retired settings are simply ignored.
export const portabilityCompanyManifestEntrySchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  logoPath: z.string().nullable(),
  requireBoardApprovalForNewAgents: z.boolean(),
  feedbackDataSharingEnabled: z.boolean().default(false),
  feedbackDataSharingConsentAt: z.string().datetime().nullable().default(null),
  feedbackDataSharingConsentByUserId: z.string().nullable().default(null),
  feedbackDataSharingTermsVersion: z.string().nullable().default(null),
});

export const portabilitySidebarOrderSchema = z.object({
  agents: z
    .array(z.string().min(1))
    .max(PORTABILITY_MANIFEST_COLLECTION_LIMIT)
    .default([]),
  projects: z
    .array(z.string().min(1))
    .max(PORTABILITY_MANIFEST_COLLECTION_LIMIT)
    .default([]),
});

export const portabilityLabelManifestEntrySchema = z.object({
  name: z.string().min(1),
  color: z.string().min(1),
});

export const portabilityBlobManifestEntrySchema = z.object({
  sha256: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  contentType: z.string().min(1),
});

export const portabilityAgentManifestEntrySchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  skills: z
    .array(z.string().min(1))
    .max(PORTABILITY_ENTITY_COLLECTION_LIMIT)
    .default([]),
  role: z.string().min(1),
  title: z.string().nullable(),
  icon: z.string().nullable(),
  appearance: agentAppearanceSchema.nullable().optional(),
  capabilities: z.string().nullable(),
  reportsToSlug: z.string().min(1).nullable(),
  adapterType: z.string().min(1),
  adapterConfig: z.record(z.string(), z.unknown()),
  runtimeConfig: z.record(z.string(), z.unknown()),
  permissions: z.record(z.string(), z.unknown()),
  permissionGrants: z.array(z.object({
    permissionKey: z.enum(PERMISSION_KEYS),
    scope: z.record(z.string(), z.unknown()).nullable().default(null),
  })).max(PORTABILITY_ENTITY_COLLECTION_LIMIT).default([]),
  budgetMonthlyCents: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});

export const portabilitySkillManifestEntrySchema = z.object({
  key: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  description: z.string().nullable(),
  sourceType: z.string().min(1),
  sourceLocator: z.string().nullable(),
  sourceRef: z.string().nullable(),
  trustLevel: z.string().nullable(),
  compatibility: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  fileInventory: z.array(z.object({
    path: z.string().min(1),
    kind: z.string().min(1),
  })).max(PORTABILITY_ENTITY_COLLECTION_LIMIT).default([]),
});

export const portabilityProjectManifestEntrySchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  description: z.string().nullable(),
  ownerAgentSlug: z.string().min(1).nullable(),
  leadAgentSlug: z.string().min(1).nullable(),
  targetDate: z.string().nullable(),
  color: z.string().nullable(),
  status: z.string().nullable(),
  executionWorkspacePolicy: z.record(z.string(), z.unknown()).nullable(),
  workspaces: z.array(z.object({
    key: z.string().min(1),
    name: z.string().min(1),
    sourceType: z.string().nullable(),
    repoUrl: z.string().nullable(),
    repoRef: z.string().nullable(),
    defaultRef: z.string().nullable(),
    visibility: z.string().nullable(),
    setupCommand: z.string().nullable(),
    cleanupCommand: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    isPrimary: z.boolean(),
  })).max(PORTABILITY_ENTITY_COLLECTION_LIMIT).default([]),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});

export const portabilityIssueRoutineTriggerManifestEntrySchema = z.object({
  kind: z.string().min(1),
  label: z.string().nullable(),
  enabled: z.boolean(),
  cronExpression: z.string().nullable(),
  timezone: z.string().nullable(),
  signingMode: z.string().nullable(),
  replayWindowSec: z.number().int().nullable(),
});

export const portabilityIssueRoutineManifestEntrySchema = z.object({
  concurrencyPolicy: z.string().nullable(),
  catchUpPolicy: z.string().nullable(),
  variables: z
    .array(routineVariableSchema)
    .max(PORTABILITY_ROUTINE_COLLECTION_LIMIT)
    .nullable()
    .optional(),
  triggers: z
    .array(portabilityIssueRoutineTriggerManifestEntrySchema)
    .max(PORTABILITY_ROUTINE_COLLECTION_LIMIT)
    .default([]),
});

export const portabilityIssueCommentManifestEntrySchema = z.object({
  body: z.string().min(1),
  authorType: issueCommentAuthorTypeSchema,
  authorAgentSlug: z.string().min(1).nullable(),
  authorUserId: z.string().nullable(),
  presentation: issueCommentPresentationSchema.nullable(),
  metadata: issueCommentMetadataSchema.nullable(),
  createdAt: z.string().datetime().nullable(),
});

export const portabilityIssueDocumentManifestEntrySchema = z.object({
  key: z.string().min(1),
  title: z.string().nullable(),
  format: z.string().min(1),
  path: z.string().min(1),
});

export const portabilityIssueWorkProductManifestEntrySchema = z.object({
  type: z.string().min(1),
  provider: z.string().min(1),
  externalId: z.string().nullable(),
  title: z.string().min(1),
  url: z.string().nullable(),
  status: z.string().min(1),
  reviewState: z.string().min(1),
  isPrimary: z.boolean().default(false),
  healthStatus: z.string().min(1),
  summary: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});

export const portabilityIssueMonitorManifestEntrySchema = z.object({
  notes: z.string().nullable(),
  scheduledBy: z.string().nullable(),
  hadSchedule: z.boolean().default(false),
});

export const portabilityIssueAttachmentManifestEntrySchema = z.object({
  sha256: z.string().min(1),
  contentType: z.string().min(1),
  originalFilename: z.string().nullable(),
  byteSize: z.number().int().nonnegative(),
  commentIndex: z.number().int().nonnegative().nullable().default(null),
});

export const portabilityIssueManifestEntrySchema = z.object({
  slug: z.string().min(1),
  identifier: z.string().min(1).nullable(),
  title: z.string().min(1),
  path: z.string().min(1),
  projectSlug: z.string().min(1).nullable(),
  projectWorkspaceKey: z.string().min(1).nullable(),
  assigneeAgentSlug: z.string().min(1).nullable(),
  description: z.string().nullable(),
  recurring: z.boolean().default(false),
  routine: portabilityIssueRoutineManifestEntrySchema.nullable(),
  legacyRecurrence: z.record(z.string(), z.unknown()).nullable(),
  status: z.string().nullable(),
  priority: z.string().nullable(),
  labelIds: z
    .array(z.string().min(1))
    .max(PORTABILITY_ENTITY_COLLECTION_LIMIT)
    .default([]),
  labelNames: z
    .array(z.string().min(1))
    .max(PORTABILITY_ENTITY_COLLECTION_LIMIT)
    .default([]),
  billingCode: z.string().nullable(),
  executionWorkspaceSettings: z.record(z.string(), z.unknown()).nullable(),
  assigneeAdapterOverrides: z.record(z.string(), z.unknown()).nullable(),
  comments: z
    .array(portabilityIssueCommentManifestEntrySchema)
    .max(PORTABILITY_ENTITY_COLLECTION_LIMIT)
    .default([]),
  blockedBy: z
    .array(z.string().min(1))
    .max(PORTABILITY_ENTITY_COLLECTION_LIMIT)
    .default([]),
  documents: z
    .array(portabilityIssueDocumentManifestEntrySchema)
    .max(PORTABILITY_ENTITY_COLLECTION_LIMIT)
    .default([]),
  workProducts: z
    .array(portabilityIssueWorkProductManifestEntrySchema)
    .max(PORTABILITY_ENTITY_COLLECTION_LIMIT)
    .default([]),
  monitor: portabilityIssueMonitorManifestEntrySchema.nullable().default(null),
  attachments: z
    .array(portabilityIssueAttachmentManifestEntrySchema)
    .max(PORTABILITY_ENTITY_COLLECTION_LIMIT)
    .default([]),
  parentSlug: z.string().min(1).nullable().optional(),
  createdAt: z.string().datetime().nullable().optional(),
  updatedAt: z.string().datetime().nullable().optional(),
  startedAt: z.string().datetime().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
  cancelledAt: z.string().datetime().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});

export const portabilityManifestSchema = z.object({
  schemaVersion: z.number().int().positive(),
  generatedAt: z.string().datetime(),
  source: z
    .object({
      companyId: z.string().guid(),
      companyName: z.string().min(1),
    })
    .nullable(),
  includes: z.object({
    company: z.boolean(),
    agents: z.boolean(),
    projects: z.boolean(),
    issues: z.boolean(),
    skills: z.boolean(),
  }),
  company: portabilityCompanyManifestEntrySchema.nullable(),
  sidebar: portabilitySidebarOrderSchema.nullable(),
  labels: z
    .array(portabilityLabelManifestEntrySchema)
    .max(PORTABILITY_MANIFEST_COLLECTION_LIMIT)
    .default([]),
  blobs: z
    .array(portabilityBlobManifestEntrySchema)
    .max(PORTABILITY_MANIFEST_COLLECTION_LIMIT)
    .default([]),
  agents: z
    .array(portabilityAgentManifestEntrySchema)
    .max(PORTABILITY_MANIFEST_COLLECTION_LIMIT),
  skills: z
    .array(portabilitySkillManifestEntrySchema)
    .max(PORTABILITY_MANIFEST_COLLECTION_LIMIT)
    .default([]),
  projects: z
    .array(portabilityProjectManifestEntrySchema)
    .max(PORTABILITY_MANIFEST_COLLECTION_LIMIT)
    .default([]),
  issues: z
    .array(portabilityIssueManifestEntrySchema)
    .max(PORTABILITY_MANIFEST_COLLECTION_LIMIT)
    .default([]),
  envInputs: z
    .array(portabilityEnvInputSchema)
    .max(PORTABILITY_MANIFEST_COLLECTION_LIMIT)
    .default([]),
});

export const portabilitySourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("inline"),
    rootPath: z.string().min(1).optional().nullable(),
    files: boundedRecordKeys(
      z.record(z.string(), portabilityFileEntrySchema),
      PORTABILITY_INLINE_FILE_LIMIT,
      "files",
    ),
    // Self-describing completeness count. The client sets this to
    // `Object.keys(files).length`; the import path rejects the payload when the
    // received file set is smaller, so a truncated or re-framed body fails
    // closed instead of importing a fragment. Optional for backwards
    // compatibility with callers that predate the check.
    expectedFileCount: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("github"),
    url: z.string().url(),
  }),
]);

export const portabilityTargetSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("new_company"),
    newCompanyName: z.string().min(1).optional().nullable(),
  }),
  z.object({
    mode: z.literal("existing_company"),
    companyId: z.string().guid(),
  }),
]);

export const portabilityAgentSelectionSchema = z.union([
  z.literal("all"),
  z.array(z.string().min(1)).max(PORTABILITY_SELECTOR_LIMIT),
]);

export const portabilityCollisionStrategySchema = z.enum(["rename", "skip", "replace"]);

export const companyPortabilityExportSchema = z.object({
  include: portabilityIncludeSchema.optional(),
  agents: z.array(z.string().min(1)).max(PORTABILITY_SELECTOR_LIMIT).optional(),
  skills: z.array(z.string().min(1)).max(PORTABILITY_SELECTOR_LIMIT).optional(),
  projects: z.array(z.string().min(1)).max(PORTABILITY_SELECTOR_LIMIT).optional(),
  issues: z.array(z.string().min(1)).max(PORTABILITY_SELECTOR_LIMIT).optional(),
  projectIssues: z.array(z.string().min(1)).max(PORTABILITY_SELECTOR_LIMIT).optional(),
  selectedFiles: z.array(z.string().min(1)).max(PORTABILITY_SELECTOR_LIMIT).optional(),
  expandReferencedSkills: z.boolean().optional(),
  sidebarOrder: portabilitySidebarOrderSchema.partial().optional(),
});

export type CompanyPortabilityExport = z.infer<typeof companyPortabilityExportSchema>;

export const companyPortabilityPreviewSchema = z.object({
  source: portabilitySourceSchema,
  include: portabilityIncludeSchema.optional(),
  target: portabilityTargetSchema,
  agents: portabilityAgentSelectionSchema.optional(),
  collisionStrategy: portabilityCollisionStrategySchema.optional(),
  nameOverrides: boundedRecordKeys(
    z.record(z.string().min(1), z.string().min(1)),
    PORTABILITY_OVERRIDE_MAP_LIMIT,
    "nameOverrides",
  ).optional(),
  selectedFiles: z.array(z.string().min(1)).max(PORTABILITY_SELECTOR_LIMIT).optional(),
});

export type CompanyPortabilityPreview = z.infer<typeof companyPortabilityPreviewSchema>;

export const portabilityAdapterOverrideSchema = z.object({
  adapterType: z.string().min(1),
  adapterConfig: z.record(z.string(), z.unknown()).optional(),
});

export const companyPortabilityImportSchema = companyPortabilityPreviewSchema.extend({
  adapterOverrides: boundedRecordKeys(
    z.record(z.string().min(1), portabilityAdapterOverrideSchema),
    PORTABILITY_OVERRIDE_MAP_LIMIT,
    "adapterOverrides",
  ).optional(),
  secretValues: boundedRecordKeys(
    z.record(z.string().min(1), z.string()),
    PORTABILITY_OVERRIDE_MAP_LIMIT,
    "secretValues",
  ).optional(),
  pauseAutomations: z.boolean().optional(),
});

export type CompanyPortabilityImport = z.infer<typeof companyPortabilityImportSchema>;
