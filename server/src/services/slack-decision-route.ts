import { and, eq, ne } from "drizzle-orm";
import { chatActions, chatEndpoints, type Db } from "@paperclipai/db";
import { z } from "zod";

const ROUTE_KIND = "slack_decision_route";
const ROUTE_KEY = "slack-decision-route";
const id = z.string().min(1).max(255);

const routeSchema = z.object({
  enabled: z.literal(true),
  workspaceId: id,
  appId: id,
  slackUserId: id,
  channelId: id,
  userId: id,
  publicBaseUrl: z.string().url(),
}).strict();

export interface SlackDecisionRoute {
  companyId: string;
  endpointId: string;
  workspaceId: string;
  appId: string;
  slackUserId: string;
  channelId: string;
  userId: string;
  publicBaseUrl: string;
}

type Reader = Pick<Db, "select">;

function publicOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/** One granted company route, or none. Missing, revoked, duplicated, or
 * malformed configuration is fail-closed. This reader never returns a secret.
 */
export async function loadEnabledSlackDecisionRoute(
  db: Reader,
  companyId: string,
  endpointId?: string,
  lock = false,
): Promise<SlackDecisionRoute | null> {
  const query = db.select({ action: chatActions, endpoint: chatEndpoints }).from(chatActions)
    .innerJoin(chatEndpoints, and(
      eq(chatEndpoints.id, chatActions.endpointId),
      eq(chatEndpoints.companyId, chatActions.companyId),
    ))
    .where(and(
      eq(chatActions.companyId, companyId),
      eq(chatActions.kind, ROUTE_KIND),
      eq(chatActions.providerActionId, ROUTE_KEY),
      eq(chatActions.status, "granted"),
      eq(chatEndpoints.provider, "slack"),
      ne(chatEndpoints.status, "archived"),
      ...(endpointId ? [eq(chatActions.endpointId, endpointId)] : []),
    ));
  const rows = await (lock ? query.for("share", { of: chatActions }) : query);
  if (rows.length !== 1) return null;
  const parsed = routeSchema.safeParse(rows[0]!.action.payload);
  const origin = parsed.success ? publicOrigin(parsed.data.publicBaseUrl) : null;
  if (!parsed.success || !origin) return null;
  return {
    companyId,
    endpointId: rows[0]!.action.endpointId,
    workspaceId: parsed.data.workspaceId,
    appId: parsed.data.appId,
    slackUserId: parsed.data.slackUserId,
    channelId: parsed.data.channelId,
    userId: parsed.data.userId,
    publicBaseUrl: origin,
  };
}
