import { and, eq, ne } from "drizzle-orm";
import { activityLog, chatActions, chatEndpoints, issueThreadInteractions, type Db } from "@paperclipai/db";
import { updateSlackDecisionDisclosureSchema } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { isSlackDecisionAllowed, slackDecisionSourceDigest, type SlackDecisionDisclosure } from "./slack-decision-policy.js";

type Reader = Pick<Db, "select">;
const KIND = "slack_decision_disclosure";
const recordKey = (interactionId: string) => `slack-decision-disclosure:${interactionId}`;

/** A disclosure is a Board-owned classification of exact source content, not an
 * assertion supplied by its author or Slack. The existing durable action ledger
 * stores this administrative action separately from provider callback actions.
 * No source text is copied here. Missing, revoked or malformed records deny.
 */
export async function loadSlackDecisionDisclosure(
  reader: Reader,
  scope: { companyId: string; endpointId: string; interactionId: string },
  lock = false,
): Promise<SlackDecisionDisclosure | null> {
  const query = reader.select({ action: chatActions }).from(chatActions)
    .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatActions.endpointId), eq(chatEndpoints.companyId, chatActions.companyId)))
    .where(and(
      eq(chatActions.companyId, scope.companyId), eq(chatActions.endpointId, scope.endpointId),
      eq(chatActions.providerActionId, recordKey(scope.interactionId)), eq(chatActions.kind, KIND),
      eq(chatActions.status, "granted"), eq(chatEndpoints.provider, "slack"), ne(chatEndpoints.status, "archived"),
    ));
  // Resolver holds the interaction lock first. Retain the disclosure lock until
  // its resolution commits so revocation cannot slip between check and write.
  const [row] = await (lock ? query.for("share", { of: chatActions }) : query);
  if (!row) return null;
  const parsed = updateSlackDecisionDisclosureSchema.safeParse(row.action.payload);
  if (!parsed.success || !parsed.data.disclosure) return null;
  return { companyId: scope.companyId, interactionId: scope.interactionId, ...parsed.data.disclosure };
}

export function slackDecisionDisclosureService(db: Db) {
  return {
    /** Call only after Board + company + connection-manager authorization. */
    async update(endpointId: string, interactionId: string, input: unknown, userId: string) {
      const parsed = updateSlackDecisionDisclosureSchema.parse(input);
      return db.transaction(async (tx) => {
        const [endpoint] = await tx.select().from(chatEndpoints).where(and(
          eq(chatEndpoints.id, endpointId), eq(chatEndpoints.provider, "slack"),
        ));
        if (!endpoint || endpoint.status === "archived") throw notFound("Slack endpoint not found");
        const [locked] = await tx.select().from(issueThreadInteractions).where(and(
          eq(issueThreadInteractions.id, interactionId), eq(issueThreadInteractions.companyId, endpoint.companyId),
        )).for("update");
        if (!locked) throw notFound("Interaction not found");
        const source = await issueThreadInteractionService(tx as unknown as Db).getById(interactionId);
        if (!source) throw notFound("Interaction not found");
        if (parsed.disclosure) {
          if (slackDecisionSourceDigest(source) !== parsed.disclosure.sourceDigest) throw conflict("The card changed; refresh before classifying it");
          if (!isSlackDecisionAllowed(source, { companyId: endpoint.companyId, userId, now: new Date(),
            disclosure: { companyId: endpoint.companyId, interactionId, ...parsed.disclosure } })) throw unprocessable("This card cannot be disclosed to Slack");
        }
        const now = new Date();
        const values = { companyId: endpoint.companyId, endpointId, kind: KIND,
          providerActionId: recordKey(interactionId), payload: parsed,
          status: parsed.disclosure ? "granted" : "revoked", updatedAt: now };
        await tx.insert(chatActions).values(values).onConflictDoUpdate({
          target: [chatActions.endpointId, chatActions.providerActionId], set: values,
        });
        await tx.insert(activityLog).values({ companyId: endpoint.companyId, actorType: "user", actorId: userId,
          action: "slack.decision_disclosure_updated", entityType: "issue_thread_interaction", entityId: interactionId,
          details: { endpointId, status: values.status, sourceDigest: parsed.disclosure?.sourceDigest ?? null } });
        return { interactionId, endpointId, status: values.status };
      });
    },
  };
}
