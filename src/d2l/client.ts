/**
 * D2L Brightspace API client.
 *
 * Authenticates with a browser session cookie rather than a registered OAuth application.
 * That is a deliberate choice, not a shortcut: registering a Valence OAuth app requires the
 * Manage Extensibility admin tool, which students do not have. The web UI itself calls
 * `/d2l/api/` with nothing but its session cookie, so the same routes are available to us on
 * exactly the permissions the signed-in user already has.
 *
 * The session is normally supplied by the operator (see README). UWaterloo deployments can
 * optionally obtain the same cookie through the /setup page; this client deliberately knows
 * nothing about that browser flow and continues to consume an ordinary Cookie header.
 */

import { CURRENT_PROTOCOL_VERSION } from "../config.js";

/**
 * Valence splits its API into independently versioned product components.
 *
 * These are the latest versions `learn.uwaterloo.ca` reports from its public
 * `/d2l/api/versions/` endpoint, which is worth re-checking after a Brightspace upgrade: newer
 * revisions add fields rather than remove them, so an old pin silently loses data instead of
 * failing. `versions()` below reads the live list.
 */
const LP_VERSION = "1.62"; // Learning Platform: users, enrollments, org units
const LE_VERSION = "1.96"; // Learning Environment: grades, content, assignments, news

export interface D2LConfig {
  /** Base URL of the Brightspace instance, e.g. https://learn.uwaterloo.ca */
  host: string;
  /** Raw Cookie header captured from a signed-in browser session. */
  cookie: string;
  /** Value of the X-Csrf-Token header, required for non-GET requests. */
  csrfToken?: string | undefined;
  /**
   * Absolute URL of this server's /setup page, quoted verbatim in every auth failure.
   *
   * Signing in is a browser errand — it needs Duo and a human — so the only useful thing an
   * auth error can do is name the exact page that fixes it. Relative advice is useless to an
   * assistant relaying the message to someone who has to click it.
   */
  setupUrl?: string | undefined;
}

export class D2LError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "D2LError";
  }
}

/**
 * Thrown when the session cookie is missing, expired, or rejected.
 *
 * The message is the whole value of this class: an expired session is the one failure a user
 * will actually hit, and it is fixable in about a minute — but only if they are told how.
 */
/** Shared tail: the one action that resolves any Learn auth failure. */
function howToSignIn(setupUrl: string | undefined): string[] {
  const page = setupUrl ?? "the /setup page on this server";
  return [
    `Sign in here: ${page}`,
    "",
    "Give that link to the user. The page signs in through UWaterloo and Duo, or takes a",
    "session cookie pasted by hand. Once they say they have signed in, run the same",
    "request again.",
  ];
}

/** No session has been established yet on this server. */
export class D2LSignedOutError extends D2LError {
  constructor(url: string, setupUrl?: string) {
    super(
      ["This server has no UWaterloo Learn session yet.", "", ...howToSignIn(setupUrl)].join("\n"),
      401,
      url,
    );
    this.name = "D2LSignedOutError";
  }
}

export class D2LAuthError extends D2LError {
  constructor(url: string, status: number, setupUrl?: string) {
    super(
      [
        "D2L rejected the session — it has expired or been signed out.",
        "",
        ...howToSignIn(setupUrl),
        "",
        "Sessions stay alive while they are being used, so this should be rare once the server",
        "is in regular use.",
      ].join("\n"),
      status,
      url,
    );
    this.name = "D2LAuthError";
  }
}

export class D2LClient {
  /**
   * Cached per instance, which on serverless means per request. Both are cheap to re-fetch and
   * caching them across requests would mean holding credentials in memory between users.
   */
  private xsrfToken: string | undefined;
  private bearerToken: { value: string; expiresAt: number } | undefined;

  constructor(private readonly config: D2LConfig) {
    this.xsrfToken = config.csrfToken;
  }

  get host(): string {
    return this.config.host;
  }

  /**
   * Fetches the XSRF token the way the web UI does.
   *
   * `d2lfetch-auth.js` in the capture reads `localStorage["XSRF.Token"]` and, on a miss, GETs
   * `/d2l/lp/auth/xsrf-tokens` for `{ referrerToken }`. Doing the same means the operator only
   * ever has to supply a cookie — the token that pairs with it is derived.
   */
  private async getXsrfToken(): Promise<string> {
    if (this.xsrfToken) return this.xsrfToken;

    const token = await this.request<{ referrerToken: string }>("/d2l/lp/auth/xsrf-tokens");
    this.xsrfToken = token.referrerToken;
    return this.xsrfToken;
  }

  /**
   * Mints a bearer token for the Valence API, as the web UI does for its own calls.
   *
   * Cookie auth alone reaches most routes, but some reject it, so this is the fallback that
   * makes the rest reachable: `POST /d2l/lp/auth/oauth2/token` with `scope=*:*:*` and the XSRF
   * token, exactly as `D2L.LP.Web.Authentication.OAuth2._RequestToken` does.
   */
  async getBearerToken(): Promise<string> {
    if (this.bearerToken && this.bearerToken.expiresAt > Date.now() + 30_000) {
      return this.bearerToken.value;
    }

    const xsrf = await this.getXsrfToken();
    const token = await this.request<{ access_token: string; expires_in?: number }>(
      "/d2l/lp/auth/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Csrf-Token": xsrf,
        },
        body: "scope=*:*:*",
      },
    );

    this.bearerToken = {
      value: token.access_token,
      expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
    };
    return this.bearerToken.value;
  }

  /**
   * Performs an authenticated request against the D2L API.
   *
   * A signed-out session does not reliably return 401 — Brightspace often answers with a 302 to
   * the login page, or with HTML where JSON was expected. Both are treated as auth failures so
   * the caller gets a clear message instead of a JSON parse error.
   */
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.config.host}${path}`;
    // Tools stay registered before anyone has signed in, so that they can say this rather than
    // vanish from the tool list and leave the assistant guessing why.
    if (!this.config.cookie) throw new D2LSignedOutError(url, this.config.setupUrl);

    const headers: Record<string, string> = {
      Cookie: this.config.cookie,
      Accept: "application/json",
      // Brightspace varies its responses for XHR callers; this matches what the web UI sends.
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": `uwaterloo-mcp (MCP ${CURRENT_PROTOCOL_VERSION})`,
      ...((init.headers as Record<string, string>) ?? {}),
    };
    if (this.xsrfToken && init.method && init.method !== "GET" && !headers["X-Csrf-Token"]) {
      headers["X-Csrf-Token"] = this.xsrfToken;
    }

    const response = await fetch(url, {
      ...init,
      headers,
      // A redirect to the login page means the session is dead; following it would return a
      // 200 full of HTML and hide the real problem.
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });

    if (response.status === 401) throw new D2LAuthError(url, response.status, this.config.setupUrl);

    // A 403 usually means the session is fine but the caller lacks a permission — Brightspace
    // answers instructor-only routes that way and names the permission in the body. Calling
    // that an expired cookie sends the user off to re-authenticate a session that works.
    if (response.status === 403) {
      const named = /"detail"\s*:\s*"([^"]+)"/.exec(await response.text().catch(() => ""))?.[1];
      if (named) {
        throw new D2LError(
          `Not permitted: ${named} This route is usually restricted to instructors.`,
          403,
          url,
        );
      }
      throw new D2LAuthError(url, response.status, this.config.setupUrl);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") ?? "";
      if (/login|saml|auth/i.test(location)) throw new D2LAuthError(url, response.status, this.config.setupUrl);
      throw new D2LError(`Unexpected redirect to ${location}`, response.status, url);
    }
    if (response.status === 404) {
      throw new D2LError("Not found. The course or item may not exist, or may not be visible to you.", 404, url);
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new D2LError(`D2L returned ${response.status}. ${detail}`.trim(), response.status, url);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      const body = (await response.text().catch(() => "")).slice(0, 400);
      // A dead session redirects to the sign-in page, which is HTML containing a login URL.
      // But Brightspace also answers HTML for a route the caller may not use at all — an
      // instructor-only endpoint, for instance — and reporting that as "your cookie expired"
      // sends the user off to re-authenticate a session that was never the problem.
      if (looksLikeSignIn(body)) {
        throw new D2LAuthError(url, response.status, this.config.setupUrl);
      }
      throw new D2LError(
        "D2L returned a web page instead of data. This route is usually restricted to " +
          "instructors, or does not exist on this Brightspace version.",
        response.status,
        url,
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Calls a Valence route, falling back to a bearer token if the cookie alone is refused.
   *
   * Most `/d2l/api/` routes accept the session cookie — that is what the capture shows the web
   * UI relying on — but not all of them do. Rather than decide up front which is which, this
   * tries the cheap path and escalates only on rejection. The retry is skipped when the cookie
   * itself is dead, since a bearer token cannot be minted without a live session either.
   */
  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    try {
      return await this.request<T>(path, init);
    } catch (err) {
      if (!(err instanceof D2LAuthError) || this.bearerToken === undefined) {
        // First failure: try once with a bearer token before giving up.
        try {
          const bearer = await this.getBearerToken();
          return await this.request<T>(path, {
            ...init,
            headers: {
              ...((init?.headers as Record<string, string>) ?? {}),
              Authorization: `Bearer ${bearer}`,
            },
          });
        } catch {
          throw err; // report the original failure, which is the more informative one
        }
      }
      throw err;
    }
  }

  /**
   * Fetches a path without parsing it, for binary content.
   *
   * `request` insists on JSON, which is right for the API but wrong for a PDF. This keeps the
   * same auth and the same treatment of a login redirect, and hands back the raw response.
   */
  async fetchRaw(path: string): Promise<Response> {
    const url = `${this.config.host}${path}`;
    const response = await fetch(url, {
      headers: {
        Cookie: this.config.cookie,
        "User-Agent": `uwaterloo-mcp (MCP ${CURRENT_PROTOCOL_VERSION})`,
      },
      // Files redirect to a storage path, so redirects are followed — but a redirect to the
      // sign-in page means the session is dead, which the content type check below catches.
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status === 401 || response.status === 403) {
      throw new D2LAuthError(url, response.status, this.config.setupUrl);
    }
    if (!response.ok) {
      throw new D2LError(`D2L returned ${response.status} for the file.`, response.status, url);
    }
    if ((response.headers.get("content-type") ?? "").includes("text/html")) {
      // HTML is also a legitimate course file type. Inspect a clone so the caller still gets
      // the original bytes, and reject only an actual sign-in page rather than every web page.
      const body = await response.clone().text();
      if (looksLikeSignIn(body)) throw new D2LAuthError(url, response.status, this.config.setupUrl);
    }
    return response;
  }

  /**
   * Fetches a Brightspace page as text.
   *
   * Some things the UI shows have no API a student can reach — a graded rubric, for one — and
   * the only route to them is the page the browser opens. Kept separate from `request` so the
   * JSON path stays strict about content types.
   */
  async fetchText(path: string): Promise<string> {
    const url = path.startsWith("http") ? path : `${this.config.host}${path}`;
    const response = await fetch(url, {
      headers: {
        Cookie: this.config.cookie,
        "User-Agent": `uwaterloo-mcp (MCP ${CURRENT_PROTOCOL_VERSION})`,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new D2LError(`D2L returned ${response.status}.`, response.status, url);
    }
    const body = await response.text();
    if (looksLikeSignIn(body)) {
      throw new D2LAuthError(url, response.status, this.config.setupUrl);
    }
    return body;
  }

  /** Learning Platform route (users, enrollments, org units). */
  lp<T>(path: string, init?: RequestInit): Promise<T> {
    return this.api<T>(`/d2l/api/lp/${LP_VERSION}${path}`, init);
  }

  /** Learning Environment route (grades, content, assignments, news). */
  le<T>(path: string, init?: RequestInit): Promise<T> {
    return this.api<T>(`/d2l/api/le/${LE_VERSION}${path}`, init);
  }

  /**
   * Walks a bookmark-paged collection to completion.
   *
   * Valence paging returns `PagingInfo.HasMoreItems` with a `Bookmark` cursor. `limit` caps the
   * number of round trips so a pathological collection cannot hang a tool call.
   */
  async paged<T>(path: string, limit = 10): Promise<T[]> {
    const items: T[] = [];
    let bookmark: string | undefined;

    for (let page = 0; page < limit; page++) {
      const separator = path.includes("?") ? "&" : "?";
      const url = bookmark ? `${path}${separator}bookmark=${encodeURIComponent(bookmark)}` : path;
      const result = await this.lp<{
        Items?: T[];
        PagingInfo?: { Bookmark?: string; HasMoreItems?: boolean };
      }>(url);

      items.push(...(result.Items ?? []));
      if (!result.PagingInfo?.HasMoreItems || !result.PagingInfo.Bookmark) break;
      bookmark = result.PagingInfo.Bookmark;
    }

    return items;
  }

  /** Confirms the session is valid, returning the signed-in user. */
  whoami(): Promise<WhoAmIUser> {
    return this.lp<WhoAmIUser>("/users/whoami");
  }

  /**
   * Checks whether the session is alive, without throwing.
   *
   * Brightspace expires a session after a period of *inactivity* (180 minutes by default), and
   * the window slides forward on every authenticated request. A server in regular use
   * therefore keeps its own session alive; this call both reports health and counts as the
   * activity that renews it.
   */
  async sessionStatus(): Promise<
    { alive: true; user: WhoAmIUser } | { alive: false; reason: string }
  > {
    try {
      return { alive: true, user: await this.whoami() };
    } catch (err) {
      return {
        alive: false,
        reason: err instanceof D2LError ? err.message : String(err),
      };
    }
  }

  /**
   * Product components and their supported API versions.
   *
   * Unauthenticated — this is the one Valence route that answers without a session, which makes
   * it the way to check whether the versions pinned above have fallen behind.
   */
  versions(): Promise<ProductVersions[]> {
    return this.request<ProductVersions[]>("/d2l/api/versions/");
  }

  /** The versions this client is pinned to. */
  static readonly pinnedVersions = { lp: LP_VERSION, le: LE_VERSION };
}

/**
 * Whether a page is the sign-in screen rather than the thing that was asked for.
 *
 * The obvious test — searching for "sessionExpired" — is wrong: every Brightspace page carries
 * an "Are You Still There?" keep-alive dialog containing that word, so it matches whenever the
 * session is perfectly healthy. What actually distinguishes the sign-in screen is that it
 * *redirects* to the login route, which it does within the first stretch of the document.
 */
function looksLikeSignIn(body: string): boolean {
  const head = body.slice(0, 4000);
  return (
    /window\.location\.replace\(\s*['"]\/d2l\/login/i.test(head) ||
    /<form[^>]+action=['"][^'"]*\/d2l\/lp\/auth\/login/i.test(head) ||
    /\/d2l\/login\?sessionExpired=/i.test(head)
  );
}

export interface ProductVersions {
  ProductCode: string;
  LatestVersion: string;
  SupportedVersions: string[];
}

export interface WhoAmIUser {
  Identifier: string;
  FirstName: string;
  LastName: string;
  UniqueName: string;
  ProfileIdentifier: string;
}
