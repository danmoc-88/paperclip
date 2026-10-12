import { createHmac, timingSafeEqual } from "node:crypto";

/** Verify the captured bytes before parsing form or JSON fields. No fallback to
 * verification tokens, reconstructed JSON, user names, or response URLs.
 * https://docs.slack.dev/authentication/verifying-requests-from-slack/
 */
export function slackRequestSignatureIsValid(
  request: Pick<Request, "headers">,
  body: string | Uint8Array,
  signingSecret: string,
  nowMs = Date.now(),
): boolean {
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature");
  if (!signingSecret || !timestamp || !signature || !Number.isFinite(nowMs)) return false;
  if (!/^\d{1,12}$/.test(timestamp) || !/^v0=[a-f0-9]{64}$/.test(signature)) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(nowMs / 1000 - timestampSeconds) > 300) return false;
  const expected = createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:`)
    .update(body)
    .digest();
  return timingSafeEqual(Buffer.from(signature.slice(3), "hex"), expected);
}
