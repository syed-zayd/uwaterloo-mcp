/**
 * OAuth 2.1 authorization server, scoped to a single-tenant MCP deployment.
 *
 * Implements just enough of RFC 6749 / 7591 / 8414 / 9728 (plus PKCE, RFC 7636) for a remote
 * MCP client to authenticate. ChatGPT refuses to add a connector that only accepts a static
 * bearer token — it probes for discovery documents and, finding none, reports "does not
 * implement OAuth" — so this exists to satisfy that flow.
 *
 * Three design decisions worth knowing:
 *
 *  1. **Everything is stateless.** Authorization codes, access tokens, and client credentials
 *     are HMAC-signed payloads rather than database rows, because the server runs on serverless
 *     platforms with no shared store. A token is valid precisely because it verifies against the
 *     signing secret.
 *
 *  2. **Registration is open, authorization is not.** RFC 7591 dynamic registration accepts any
 *     client, since ChatGPT invents its own client_id and cannot know a secret in advance.
 *     Registration is therefore not the security boundary — `/authorize` is, and it requires the
 *     operator's own token before any code is issued.
 *
 *  3. **`/authorize` asks for the deployment token.** There is exactly one legitimate user (the
 *     person who deployed this), so rather than a username/password form it presents a single
 *     field for the token they already hold. Issuing a code needs that token *and* the PKCE
 *     verifier is needed to redeem it.
 */

import { createHmac, createHash, timingSafeEqual, randomBytes } from "node:crypto";

const CODE_TTL_SECONDS = 120;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export const OAUTH_SCOPE = "d2l:read";

// --------------------------------------------------------------------------- signing helpers

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** `<base64url payload>.<base64url signature>` */
function sign(payload: object, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/** Verify signature and expiry. Returns null on any failure — callers must not distinguish why. */
function verify<T extends { exp: number }>(token: string, secret: string): T | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (!constantTimeEqual(provided, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    if (typeof payload.exp !== "number" || payload.exp < nowSeconds()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function sha256b64url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

// --------------------------------------------------------------------------- documents

export function authorizationServerMetadata(origin: string): object {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    // Retained for backwards compatibility: RFC 7591 registration is deprecated as of
    // 2026-07-28 in favour of Client ID Metadata Documents, but clients including ChatGPT
    // still register this way, and the spec keeps it available for exactly that reason.
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    // `none` covers ChatGPT's public-client exchange; the others suit clients that do hold a
    // secret from registration.
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [OAUTH_SCOPE],
    // RFC 9207: we return `iss` on authorization responses, so we must advertise it.
    authorization_response_iss_parameter_supported: true,
    // RFC 8707: tokens are audience-bound to this MCP server.
    resource_indicators_supported: true,
    // draft-ietf-oauth-client-id-metadata-document-00, the mechanism that supersedes DCR.
    client_id_metadata_document_supported: true,
  };
}

export function protectedResourceMetadata(origin: string): object {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: [OAUTH_SCOPE],
  };
}

// --------------------------------------------------------------------------- registration

export interface RegistrationRequest {
  redirect_uris?: unknown;
  client_name?: unknown;
  token_endpoint_auth_method?: unknown;
}

/**
 * RFC 7591 dynamic client registration.
 *
 * Accepts any client: ChatGPT generates its own identity on first connect and has no way to
 * present a pre-agreed secret. The issued client_id is a signed record of the redirect URIs, so
 * `/authorize` can verify a callback belongs to the client that registered it without storing
 * anything.
 */
export function registerClient(
  body: RegistrationRequest,
  secret: string,
): { status: number; payload: object } {
  const uris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === "string")
    : [];

  if (uris.length === 0) {
    return {
      status: 400,
      payload: { error: "invalid_redirect_uri", error_description: "redirect_uris is required." },
    };
  }

  for (const uri of uris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return {
        status: 400,
        payload: { error: "invalid_redirect_uri", error_description: `Not a valid URL: ${uri}` },
      };
    }
    // Loopback callbacks are how local MCP clients receive the code; everything else must be
    // HTTPS so a code is never sent over plaintext.
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
    if (parsed.protocol !== "https:" && !loopback) {
      return {
        status: 400,
        payload: {
          error: "invalid_redirect_uri",
          error_description: `redirect_uri must use https (or loopback): ${uri}`,
        },
      };
    }
  }

  const authMethod =
    typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none";

  // The client_id *is* the record: signed, so it cannot be forged, and self-describing, so no
  // storage is needed on a serverless platform.
  const clientId = sign(
    { typ: "client", exp: nowSeconds() + 10 * 365 * 24 * 60 * 60, ru: uris, am: authMethod },
    secret,
  );

  const payload: Record<string, unknown> = {
    client_id: clientId,
    client_id_issued_at: nowSeconds(),
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: authMethod,
    scope: OAUTH_SCOPE,
  };

  if (typeof body.client_name === "string") payload["client_name"] = body.client_name;

  // Confidential clients get a secret derived from their id, so it never needs storing either.
  if (authMethod !== "none") {
    payload["client_secret"] = sha256b64url(`${secret}:client-secret:${clientId}`);
    payload["client_secret_expires_at"] = 0; // never expires
  }

  return { status: 201, payload };
}

interface ClientRecord {
  exp: number;
  typ?: string;
  ru?: string[];
  am?: string;
}

export function parseClientId(clientId: string, secret: string): ClientRecord | null {
  const record = verify<ClientRecord>(clientId, secret);
  return record?.typ === "client" ? record : null;
}

/**
 * Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document-00).
 *
 * The mechanism that supersedes dynamic registration in 2026-07-28: instead of registering,
 * a client uses an HTTPS URL as its `client_id` and serves its own metadata there. We fetch
 * that document and read the redirect URIs out of it.
 *
 * Returns null when the id is not a URL, so callers can fall through to a registered client.
 */
export async function resolveClientIdMetadata(clientId: string): Promise<ClientRecord | null> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  // Only https URLs are client-id metadata documents; anything else is a registered id.
  if (url.protocol !== "https:") return null;

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
      redirect: "error", // a redirect would let the document be served from another origin
    });
    if (!response.ok) return null;

    const doc = (await response.json()) as { client_id?: unknown; redirect_uris?: unknown };

    // The document MUST self-identify with the same URL, else any site could claim any id.
    if (typeof doc.client_id !== "string" || doc.client_id !== clientId) return null;

    const uris = Array.isArray(doc.redirect_uris)
      ? doc.redirect_uris.filter((u): u is string => typeof u === "string")
      : [];
    if (uris.length === 0) return null;

    return { exp: nowSeconds() + 300, typ: "client", ru: uris, am: "none" };
  } catch {
    return null;
  }
}

/** Resolves a client_id by either mechanism: a CIMD URL, or an id we issued at /register. */
export async function resolveClient(clientId: string, secret: string): Promise<ClientRecord | null> {
  return (await resolveClientIdMetadata(clientId)) ?? parseClientId(clientId, secret);
}

// --------------------------------------------------------------------------- authorize

export interface AuthorizeParams {
  responseType: string | null;
  clientId: string | null;
  redirectUri: string | null;
  state: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  scope: string | null;
  /** RFC 8707 resource indicator: which MCP server the token is for. */
  resource: string | null;
}

export type AuthorizeResult =
  | { kind: "error"; status: number; message: string }
  | { kind: "redirect"; location: string }
  | { kind: "prompt"; html: string };

/**
 * Validates an authorization request. Returns a consent page rather than a code: the operator
 * proves who they are by entering their deployment token, which `completeAuthorize` checks.
 */
export async function beginAuthorize(
  params: AuthorizeParams,
  secret: string,
  issuer: string,
): Promise<AuthorizeResult> {
  if (!params.redirectUri) {
    return { kind: "error", status: 400, message: "redirect_uri is required." };
  }

  const client = params.clientId ? await resolveClient(params.clientId, secret) : null;
  if (!client) {
    return { kind: "error", status: 400, message: "Unknown or malformed client_id." };
  }
  // Binding the callback to the registration is what stops an attacker redirecting a code to
  // a host they control.
  if (client.ru && !client.ru.some((u) => constantTimeEqual(u, params.redirectUri!))) {
    return { kind: "error", status: 400, message: "redirect_uri does not match this client's registration." };
  }

  // Past this point the client and callback are trusted, so errors go back by redirect.
  // RFC 9207 requires `iss` on error responses too, so a client can tell which AS replied.
  const fail = (error: string, description: string): AuthorizeResult => {
    const location = new URL(params.redirectUri!);
    location.searchParams.set("error", error);
    location.searchParams.set("error_description", description);
    if (params.state) location.searchParams.set("state", params.state);
    location.searchParams.set("iss", issuer);
    return { kind: "redirect", location: location.toString() };
  };

  if (params.responseType !== "code") {
    return fail("unsupported_response_type", "Only the authorization code flow is supported.");
  }
  if (!params.codeChallenge || params.codeChallengeMethod !== "S256") {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }

  return { kind: "prompt", html: consentPage(params) };
}

/** Exchanges the operator's token for an authorization code. */
export function completeAuthorize(
  params: AuthorizeParams,
  providedToken: string,
  expectedToken: string,
  secret: string,
  issuer: string,
  canonicalResource: string,
): AuthorizeResult {
  if (!params.redirectUri || !params.codeChallenge) {
    return { kind: "error", status: 400, message: "Malformed authorization request." };
  }
  if (!constantTimeEqual(providedToken.trim(), expectedToken)) {
    return { kind: "prompt", html: consentPage(params, "That token is not correct.") };
  }

  const code = sign(
    {
      typ: "code",
      exp: nowSeconds() + CODE_TTL_SECONDS,
      cc: params.codeChallenge,
      ru: params.redirectUri,
      // RFC 8707: the audience the eventual token is for. Carried through the code so the
      // token endpoint mints a token bound to the resource actually requested here.
      aud: params.resource ?? canonicalResource,
    },
    secret,
  );

  const location = new URL(params.redirectUri);
  location.searchParams.set("code", code);
  if (params.state) location.searchParams.set("state", params.state);
  location.searchParams.set("iss", issuer);
  return { kind: "redirect", location: location.toString() };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

function consentPage(params: AuthorizeParams, error?: string): string {
  const hidden = (name: string, value: string | null): string =>
    value === null ? "" : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to D2L Learn MCP</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         max-width: 26rem; margin: 12vh auto; padding: 0 1.25rem; line-height: 1.55; }
  h1 { font-size: 1.3rem; margin-bottom: .25rem; }
  p { color: #666; font-size: .93rem; margin-top: 0; }
  label { display: block; font-weight: 600; font-size: .9rem; margin: 1.5rem 0 .4rem; }
  input[type=password] { width: 100%; padding: .6rem .7rem; font-size: 1rem; box-sizing: border-box;
         border: 1px solid #bbb; border-radius: .4rem; background: transparent; color: inherit; }
  button { margin-top: 1.1rem; width: 100%; padding: .65rem; font-size: 1rem; font-weight: 600;
         border: 0; border-radius: .4rem; background: #2f6feb; color: #fff; cursor: pointer; }
  .err { color: #c0362c; font-size: .9rem; margin-top: 1rem; }
  .hint { font-size: .82rem; color: #888; margin-top: 1.4rem; }
</style>
</head>
<body>
  <h1>Connect to D2L Learn</h1>
  <p>Paste this deployment's access token to authorize the connection.</p>
  ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
  <form method="POST" action="/authorize">
    ${hidden("response_type", params.responseType)}
    ${hidden("client_id", params.clientId)}
    ${hidden("redirect_uri", params.redirectUri)}
    ${hidden("state", params.state)}
    ${hidden("code_challenge", params.codeChallenge)}
    ${hidden("code_challenge_method", params.codeChallengeMethod)}
    ${hidden("scope", params.scope)}
    <label for="token">Access token</label>
    <input id="token" name="token" type="password" autocomplete="off" autofocus required>
    <button type="submit">Authorize</button>
  </form>
  <p class="hint">This is the MCP_AUTH_TOKEN configured on the deployment. It is shown on the
  server's home page when the server generated it for you.</p>
</body>
</html>`;
}

// --------------------------------------------------------------------------- token

export type TokenResult =
  | { ok: true; payload: object }
  | { ok: false; status: number; error: string; description: string };

export async function exchangeToken(
  form: URLSearchParams,
  secret: string,
  canonicalResource: string,
): Promise<TokenResult> {
  const grantType = form.get("grant_type");

  const clientId = form.get("client_id");
  if (clientId && !(await resolveClient(clientId, secret))) {
    return { ok: false, status: 401, error: "invalid_client", description: "Unknown client_id." };
  }

  if (grantType === "refresh_token") {
    const token = form.get("refresh_token");
    const payload = token ? verify<{ exp: number; typ?: string; aud?: string }>(token, secret) : null;
    if (payload?.typ !== "refresh") {
      return { ok: false, status: 400, error: "invalid_grant", description: "Refresh token is invalid or expired." };
    }
    return { ok: true, payload: issueTokens(secret, payload.aud ?? canonicalResource) };
  }

  if (grantType !== "authorization_code") {
    return { ok: false, status: 400, error: "unsupported_grant_type", description: "Use authorization_code or refresh_token." };
  }

  const code = form.get("code");
  const verifier = form.get("code_verifier");
  const redirectUri = form.get("redirect_uri");

  if (!code || !verifier) {
    return { ok: false, status: 400, error: "invalid_request", description: "code and code_verifier are required." };
  }

  const payload = verify<{ exp: number; typ?: string; cc?: string; ru?: string; aud?: string }>(code, secret);
  if (payload?.typ !== "code") {
    return { ok: false, status: 400, error: "invalid_grant", description: "Authorization code is invalid or expired." };
  }

  // The code is bound to the redirect_uri it was issued for, so a stolen code cannot be
  // redeemed against a different callback.
  if (redirectUri && payload.ru && !constantTimeEqual(redirectUri, payload.ru)) {
    return { ok: false, status: 400, error: "invalid_grant", description: "redirect_uri does not match the authorization request." };
  }

  if (!payload.cc || !constantTimeEqual(sha256b64url(verifier), payload.cc)) {
    return { ok: false, status: 400, error: "invalid_grant", description: "PKCE verification failed." };
  }

  // RFC 8707: if the token request names a resource, it must be the one the code was issued
  // for — a code for server A must not yield a token for server B.
  const requestedResource = form.get("resource");
  const audience = payload.aud ?? canonicalResource;
  if (requestedResource && !constantTimeEqual(requestedResource, audience)) {
    return { ok: false, status: 400, error: "invalid_target", description: "resource does not match the authorization request." };
  }

  return { ok: true, payload: issueTokens(secret, audience) };
}

function issueTokens(secret: string, audience: string): object {
  const base = { exp: nowSeconds() + ACCESS_TOKEN_TTL_SECONDS, aud: audience };
  return {
    access_token: sign({ ...base, typ: "access", jti: randomBytes(8).toString("hex") }, secret),
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: sign(
      { typ: "refresh", exp: nowSeconds() + REFRESH_TOKEN_TTL_SECONDS, aud: audience, jti: randomBytes(8).toString("hex") },
      secret,
    ),
    scope: OAUTH_SCOPE,
  };
}

/**
 * True when `token` is an access token this server issued *for this server*.
 *
 * The audience check is the confused-deputy defence the spec calls out: a token minted for a
 * different resource must not be accepted here even if we signed it.
 */
export function isIssuedAccessToken(token: string, secret: string, canonicalResource: string): boolean {
  const payload = verify<{ exp: number; typ?: string; aud?: string }>(token, secret);
  if (payload?.typ !== "access") return false;
  return payload.aud === undefined || constantTimeEqual(payload.aud, canonicalResource);
}
