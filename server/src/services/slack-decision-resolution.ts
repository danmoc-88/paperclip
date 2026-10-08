import { activityLog, type Db } from "@paperclipai/db";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import { issueThreadInteractionService, type InteractionResolutionMutationOptions } from "./issue-thread-interactions.js";
import {
  mapSlackDecisionResolution,
  slackDecisionSourceDigest,
  SlackDecisionPolicyError,
  type SlackDecisionDisclosure,
} from "./slack-decision-policy.js";

type Transaction = Parameters<NonNullable<InteractionResolutionMutationOptions["validateLockedInteraction"]>>[0];

/** Loaded from a durable server-owned action, never directly from callback JSON. */
export interface SlackDecisionAction {
  id: string;
  companyId: string;
  issueId: string;
  interactionId: string;
  sourceDigest: string;
  userId: string;
  workspaceId: string;
  slackUserId: string;
  channelId: string;
  appId: string;
  messageTimestamp: string;
  operation: "accept" | "reject" | "answer";
  receivedAt: Date;
}

export interface SlackDecisionResolutionDependencies {
  enabled: boolean;
  /** Protected disclosure policy; must not read classification from card payloads. */
  loadDisclosure: (db: Db | Transaction, action: SlackDecisionAction) => Promise<SlackDecisionDisclosure | null>;
  /** Recheck current membership, configured identity/route and expiry, then claim
   * the opaque action exactly once in this transaction. Throw on any mismatch.
   * The transport implementing this contract is supplied in the adapter PR. */
  authorizeAndConsume: (tx: Transaction, action: SlackDecisionAction) => Promise<void>;
  now?: () => Date;
}

/** No endpoint or default transport is registered by this service. */
export function slackDecisionResolutionService(db: Db, dependencies: SlackDecisionResolutionDependencies) {
  const interactions = issueThreadInteractionService(db);
  const now = dependencies.now ?? (() => new Date());
  return {
    async resolve(action: SlackDecisionAction, input: unknown) {
      if (dependencies.enabled !== true || !Number.isFinite(action.receivedAt.getTime())) {
        throw new SlackDecisionPolicyError();
      }
      const current = await interactions.getById(action.interactionId);
      if (!current || current.companyId !== action.companyId || current.issueId !== action.issueId || slackDecisionSourceDigest(current) !== action.sourceDigest) {
        throw new SlackDecisionPolicyError();
      }
      const context = {
        companyId: action.companyId, userId: action.userId, now: now(),
        disclosure: await dependencies.loadDisclosure(db, action),
      };
      const mapped = mapSlackDecisionResolution(current, context, action.operation, input);
      let checked: IssueThreadInteraction | null = null;
      const options: InteractionResolutionMutationOptions = {
        validateLockedInteraction: async (tx, locked) => {
          if (slackDecisionSourceDigest(locked) !== action.sourceDigest) throw new SlackDecisionPolicyError();
          const lockedMapping = mapSlackDecisionResolution(locked, {
            ...context, now: now(), disclosure: await dependencies.loadDisclosure(tx, action),
          }, action.operation, input);
          if (JSON.stringify(lockedMapping) !== JSON.stringify(mapped)) throw new SlackDecisionPolicyError();
          await dependencies.authorizeAndConsume(tx, action);
          checked = locked;
        },
        afterResolveInTransaction: async (tx, resolved) => {
          if (!checked || resolved.resolvedByUserId !== action.userId) throw new SlackDecisionPolicyError();
          const target = checked.kind === "request_confirmation" ? checked.payload.target : null;
          // Labels come exclusively from the classified source, never from
          // provider display names, free-text answers, rejection reasons or logs.
          const actionLabel = checked.kind === "request_confirmation"
            ? action.operation === "accept" ? checked.payload.acceptLabel ?? "Zatwierdź" : checked.payload.rejectLabel ?? "Odrzuć"
            : "Odpowiedz";
          await tx.insert(activityLog).values({
            companyId: action.companyId, actorType: "user", actorId: action.userId,
            responsibleUserId: action.userId,
            action: "slack.decision_resolved", entityType: "issue_thread_interaction", entityId: resolved.id,
            details: {
              issueId: action.issueId, interactionId: resolved.id, actionId: action.id,
              workspaceId: action.workspaceId, slackUserId: action.slackUserId,
              channelId: action.channelId, appId: action.appId, messageTimestamp: action.messageTimestamp,
              operation: action.operation, actionLabel,
              ...(mapped.method === "answerQuestions" ? { selections: mapped.input.answers.map((answer) => ({
                questionId: answer.questionId, optionIds: answer.optionIds,
              })) } : {}),
              receivedAt: action.receivedAt.toISOString(), resolvedAt: resolved.resolvedAt,
              revisionId: target?.type === "issue_document" ? target.revisionId : null,
            },
          });
        },
      };
      const issue = { id: action.issueId, companyId: action.companyId, projectId: null, goalId: null };
      const actor = { userId: action.userId };
      switch (mapped.method) {
        case "acceptInteraction": return interactions.acceptInteraction(issue, current.id, mapped.input, actor, options);
        case "rejectInteraction": return interactions.rejectInteraction(issue, current.id, mapped.input, actor, options);
        case "answerQuestions": return interactions.answerQuestions(issue, current.id, mapped.input, actor, options);
      }
    },
  };
}
