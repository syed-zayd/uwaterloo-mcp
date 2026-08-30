/**
 * Bearer-token authentication for the MCP endpoint.
 *
 * The owner can use the configured token directly, while remote clients can exchange an OAuth
 * authorization code for a short-lived audience-bound token. Both paths terminate in the same
 * SDK verifier.
 */

import { timingSafeEqual } from "node:crypto";
import type { AuthInfo, OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { isIssuedAccessToken, OAUTH_SCOPE } from "./oauth.js";

/** Constant-time compare. Length is compared first; it is not usefully secret. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(a, a); // keep the work constant regardless of branch
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Accepts either an OAuth access token this server issued, or the operator's static token.
 *
 * Both are legitimate: remote clients (ChatGPT, Claude) complete the OAuth flow and present an
 * issued token, while local tooling can skip the dance by using the deployment token directly.
 */
export function combinedVerifier(
  staticToken: string,
  clientId: string,
  /**
   * Every hostname this deployment is legitimately reached by. A token is audience-bound to
   * the origin it was issued through, and the same server answers to several — `localhost`
   * and `127.0.0.1` in dev, a platform domain and a custom domain in production — so a token
   * minted via one must not be refused when presented via another. Tokens for anything
   * outside this set are still rejected, which is the confused-deputy defence that matters.
   */
  acceptedResources: string[],
): OAuthTokenVerifier {
  const canonicalResource = acceptedResources[0] ?? "";
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (acceptedResources.some((r) => isIssuedAccessToken(token, staticToken, r))) {
        return {
          token,
          clientId,
          scopes: [OAUTH_SCOPE],
          expiresAt: Math.floor(Date.now() / 1000) + 60 * 60,
          resource: new URL(canonicalResource),
        };
      }
      if (tokensMatch(token, staticToken)) {
        return {
          token,
          clientId,
          scopes: [OAUTH_SCOPE],
          expiresAt: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365,
          resource: new URL(canonicalResource),
        };
      }
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid or expired access token.");
    },
  };
}
