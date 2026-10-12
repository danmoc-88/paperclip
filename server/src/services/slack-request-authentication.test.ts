import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { slackRequestSignatureIsValid } from "./slack-request-authentication.js";

const secret = "test-signing-secret";
const now = 1_800_000_000_000;
const body = new TextEncoder().encode('payload=%7B%22text%22%3A%22Za%C5%BC%C3%B3%C5%82%C4%87%22%7D');
function signed(timestamp = String(now / 1000), bytes: Uint8Array = body, key = secret) {
  return { headers: new Headers({
    "X-Slack-Request-Timestamp": timestamp,
    "X-Slack-Signature": `v0=${createHmac("sha256", key).update(`v0:${timestamp}:`).update(bytes).digest("hex")}`,
  }) };
}

describe("Slack request authentication", () => {
  it("authenticates the captured bytes without decoding or reserializing them", () => {
    expect(slackRequestSignatureIsValid(signed(), body, secret, now)).toBe(true);
    expect(slackRequestSignatureIsValid(signed(), new TextDecoder().decode(body), secret, now)).toBe(true);
    expect(slackRequestSignatureIsValid(signed(), decodeURIComponent(new TextDecoder().decode(body)), secret, now)).toBe(false);
    expect(slackRequestSignatureIsValid(signed(), new Uint8Array([...body, 32]), secret, now)).toBe(false);
  });

  it.each([-300, 300])("accepts the exact timestamp boundary (%s seconds)", (offset) => {
    expect(slackRequestSignatureIsValid(signed(String(now / 1000 + offset)), body, secret, now)).toBe(true);
  });

  it.each([-301, 301])("rejects old and future requests (%s seconds)", (offset) => {
    expect(slackRequestSignatureIsValid(signed(String(now / 1000 + offset)), body, secret, now)).toBe(false);
  });

  it("does not round away an expired fractional second", () => {
    expect(slackRequestSignatureIsValid(signed(String(now / 1000 - 300)), body, secret, now + 1)).toBe(false);
  });

  it.each(["", "1800000000.5", "1.8e9", "+1800000000", "NaN", "Infinity", "99999999999999"])("rejects malformed timestamp %s even when signed", (timestamp) => {
    expect(slackRequestSignatureIsValid(signed(timestamp), body, secret, now)).toBe(false);
  });

  it.each(["", "v0=", "v1=" + "a".repeat(64), "v0=" + "g".repeat(64), "v0=" + "a".repeat(63), "v0=" + "a".repeat(65)])("rejects malformed signatures without throwing (%s)", (signature) => {
    const request = signed();
    request.headers.set("x-slack-signature", signature);
    expect(slackRequestSignatureIsValid(request, body, secret, now)).toBe(false);
  });

  it("rejects missing or rotated secrets and a broken clock", () => {
    expect(slackRequestSignatureIsValid(signed(undefined, body, ""), body, "", now)).toBe(false);
    expect(slackRequestSignatureIsValid(signed(), body, "rotated", now)).toBe(false);
    expect(slackRequestSignatureIsValid(signed(), body, secret, NaN)).toBe(false);
    expect(slackRequestSignatureIsValid({ headers: new Headers() }, body, secret, now)).toBe(false);
  });
});
