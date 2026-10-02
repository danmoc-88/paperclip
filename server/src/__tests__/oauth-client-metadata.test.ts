import { describe, expect, it, vi } from "vitest";

import {
  OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH,
  oauthClientIdMetadataDocument,
  resolveOAuthClientIdMetadataDocumentUrl,
} from "../services/tool-access.js";

const REDIRECT_URI = "https://paperclip.example:42001/api/tools/oauth/callback";
const METADATA_URL = `https://paperclip.example:42001${OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH}`;

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

const asFetch = (impl: unknown) => impl as unknown as typeof fetch;

/** The document this deployment really serves, as the route builds it. */
function servedDocument() {
  return new Response(
    JSON.stringify(
      oauthClientIdMetadataDocument({
        clientId: METADATA_URL,
        redirectUri: REDIRECT_URI,
      }),
    ),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** What Cloudflare Access answers an unauthenticated fetch with. */
function accessLoginRedirect() {
  return new Response(null, {
    status: 302,
    headers: {
      location:
        "https://summer-mountain-f88b.cloudflareaccess.com/cdn-cgi/access/login/paperclip.example",
      "content-type": "text/html",
    },
  });
}

describe("OAuth Client ID Metadata Document selection", () => {
  it("uses a publicly resolved HTTPS callback origin", async () => {
    await expect(
      resolveOAuthClientIdMetadataDocumentUrl(REDIRECT_URI, publicLookup, {
        fetchImpl: asFetch(vi.fn(async () => servedDocument())),
      }),
    ).resolves.toBe(METADATA_URL);
  });

  it("rejects a Tailscale-range hostname so OAuth can fall back to DCR", async () => {
    await expect(
      resolveOAuthClientIdMetadataDocumentUrl(
        "https://paperclip.tailnet.example:42001/api/tools/oauth/callback",
        async () => [{ address: "100.100.100.100", family: 4 }],
      ),
    ).resolves.toBeNull();
  });

  it.each([
    "http://localhost:3100/api/tools/oauth/callback",
    "https://127.0.0.1:3100/api/tools/oauth/callback",
  ])("rejects a non-public callback origin %s", async (redirectUri) => {
    await expect(
      resolveOAuthClientIdMetadataDocumentUrl(redirectUri),
    ).resolves.toBeNull();
  });

  it("probes the document without following redirects", async () => {
    const fetchImpl = vi.fn(async () => servedDocument());
    await resolveOAuthClientIdMetadataDocumentUrl(REDIRECT_URI, publicLookup, {
      fetchImpl: asFetch(fetchImpl),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(METADATA_URL);
    expect(init.redirect).toBe("manual");
  });

  it("falls back to DCR when an access proxy answers with a login redirect", async () => {
    await expect(
      resolveOAuthClientIdMetadataDocumentUrl(REDIRECT_URI, publicLookup, {
        fetchImpl: asFetch(vi.fn(async () => accessLoginRedirect())),
      }),
    ).resolves.toBeNull();
  });

  it.each([
    ["an error status", () => new Response("forbidden", { status: 403 })],
    [
      "a non-JSON body",
      () =>
        new Response("<html>login</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ],
    [
      "a document whose client_id is some other deployment",
      () =>
        new Response(
          JSON.stringify(
            oauthClientIdMetadataDocument({
              clientId: `https://other.example${OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH}`,
              redirectUri: "https://other.example/api/tools/oauth/callback",
            }),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ],
    [
      "a document that does not list this callback",
      () =>
        new Response(
          JSON.stringify(
            oauthClientIdMetadataDocument({
              clientId: METADATA_URL,
              redirectUri:
                "https://paperclip.example:42001/api/tools/oauth/other-callback",
            }),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ],
  ])("falls back to DCR on %s", async (_label, respond) => {
    await expect(
      resolveOAuthClientIdMetadataDocumentUrl(REDIRECT_URI, publicLookup, {
        fetchImpl: asFetch(vi.fn(async () => respond())),
      }),
    ).resolves.toBeNull();
  });

  it.each([
    [
      "a server error",
      () => new Response("boom", { status: 503 }),
    ],
    [
      "a same-origin redirect",
      () =>
        new Response(null, {
          status: 308,
          headers: {
            location: `${OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH}/`,
          },
        }),
    ],
    [
      "a redirect with no location",
      () => new Response(null, { status: 302 }),
    ],
  ])("keeps CIMD on %s, because that is inconclusive", async (_label, respond) => {
    await expect(
      resolveOAuthClientIdMetadataDocumentUrl(REDIRECT_URI, publicLookup, {
        fetchImpl: asFetch(vi.fn(async () => respond())),
      }),
    ).resolves.toBe(METADATA_URL);
  });

  it("keeps CIMD when the probe itself fails, because that is inconclusive", async () => {
    await expect(
      resolveOAuthClientIdMetadataDocumentUrl(REDIRECT_URI, publicLookup, {
        fetchImpl: asFetch(
          vi.fn(async () => {
            throw new Error("ECONNREFUSED");
          }),
        ),
      }),
    ).resolves.toBe(METADATA_URL);
  });

  it("keeps CIMD when the probe times out", async () => {
    await expect(
      resolveOAuthClientIdMetadataDocumentUrl(REDIRECT_URI, publicLookup, {
        timeoutMs: 1,
        fetchImpl: asFetch(
          vi.fn(
            (_url: string, init?: RequestInit) =>
              new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () =>
                  reject(new Error("aborted")),
                );
              }),
          ),
        ),
      }),
    ).resolves.toBe(METADATA_URL);
  });
});
