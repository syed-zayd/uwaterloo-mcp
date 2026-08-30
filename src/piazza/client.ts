/**
 * Piazza API client.
 *
 * Piazza publishes no API. Everything here was derived from observing the web client
 * (see README "API notes") and is therefore liable to break without warning.
 *
 * Uses only `fetch` and web-standard APIs so it runs unchanged in Workers and Node.
 */

import type {
  FeedFilters,
  PiazzaCourse,
  PiazzaFeedItem,
  PiazzaFeedResponse,
  PiazzaPost,
  PiazzaProfile,
  PiazzaUser,
} from "./types.js";

const BASE = "https://piazza.com";

// Piazza serves different markup to unrecognised clients; present as a normal browser.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/**
 * `stage` separates failures that a retry could fix from ones it cannot.
 *
 *  - `session` — the session lapsed; re-login and try again.
 *  - `api`     — Piazza rejected the request itself (bad post number, no permission). Retrying
 *                changes nothing, and the caller should surface it rather than escalate.
 */
export class PiazzaError extends Error {
  constructor(
    message: string,
    readonly stage: "login" | "csrf" | "session" | "api",
    readonly detail?: unknown,
  ) {
    // Detail is folded into the message so it survives the trip through MCP, which only carries
    // `message` back to the caller. Without it, a failure in a deployed connector is a dead end.
    super(detail ? `${message}\n  [${stage}] ${String(detail).slice(0, 500)}` : message);
    this.name = "PiazzaError";
  }
}

/** Everything needed to make authenticated calls. Serializable, so it can be cached. */
export interface PiazzaSession {
  /** Ready-made `Cookie` header value. */
  cookie: string;
  /** Value for the `CSRF-Token` request header. */
  csrfToken: string;
  createdAt: number;
}

type Jar = Map<string, string>;

function absorbCookies(res: Response, jar: Jar): void {
  // getSetCookie() splits multiple Set-Cookie headers correctly; a plain .get() would join them
  // into one comma-separated string and corrupt any cookie whose value contains a comma.
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const entry of raw) {
    const pair = entry.split(";", 1)[0];
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    // Servers clear cookies by setting them empty; drop rather than store those.
    if (value === "" || value === '""') jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeader(jar: Jar): string {
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Extract a hidden form input's value. */
function formValue(html: string, name: string): string | null {
  const re = new RegExp(`<input[^>]*name=["']${name}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  return tag.match(/value=["']([^"']*)["']/i)?.[1] ?? null;
}

/**
 * Extract the API CSRF token from a rendered page.
 *
 * It ships as `<meta name="csrf_token" content="…">`; page JS copies that into
 * `window.CSRF_TOKEN`, which is what ajax.js sends as the `CSRF-Token` header. The meta tag is
 * present *only* when authenticated — logged-out pages carry a same-named hidden input inside
 * the login form instead — which makes its presence a reliable signal that login worked.
 */
function pageCsrfToken(html: string): string | null {
  const meta = html.match(
    /<meta[^>]+name=["']csrf_token["'][^>]*content=["']([^"']+)["']/i,
  )?.[1];
  if (meta) return meta;

  // Fallback for any page that assigns it directly.
  return html.match(/CSRF_TOKEN\s*=\s*["']([^"']+)["']/)?.[1] ?? null;
}

export class PiazzaClient {
  private jar: Jar = new Map();
  private csrfToken = "";
  /** uid → user, per course. Roles never change mid-session, so caching is safe. */
  private userCache = new Map<string, Map<string, PiazzaUser>>();

  constructor(private session?: PiazzaSession) {
    if (session) {
      this.csrfToken = session.csrfToken;
      for (const part of session.cookie.split(";")) {
        const eq = part.indexOf("=");
        if (eq > 0) this.jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
      }
    }
  }

  /** Snapshot the session so it can be cached and reused without logging in again. */
  getSession(): PiazzaSession {
    return { cookie: cookieHeader(this.jar), csrfToken: this.csrfToken, createdAt: Date.now() };
  }

  /** Cookie names only — safe to log. */
  cookieNames(): string[] {
    return [...this.jar.keys()];
  }

  private async requestOnce(path: string, init: RequestInit = {}): Promise<Response> {
    const target = path.startsWith("http") ? path : `${BASE}${path}`;
    const res = await fetch(target, {
      ...init,
      redirect: "manual",
      headers: {
        "User-Agent": USER_AGENT,
        ...(this.jar.size > 0 ? { Cookie: cookieHeader(this.jar) } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    absorbCookies(res, this.jar);
    return res;
  }

  /**
   * Fetch, following redirects by hand so cookies set along the way are captured.
   *
   * Redirects have to be manual: the login POST answers 302 and the session cookie arrives on
   * that hop, so an automatic follow would work but would hide which hop set what — and runtimes
   * differ in whether they resend the body. Following explicitly behaves identically on Workers
   * and Node, which is the whole point of a portable client.
   */
  private async request(path: string, init: RequestInit = {}, maxHops = 5): Promise<Response> {
    let res = await this.requestOnce(path, init);
    let hops = 0;

    while (hops < maxHops && res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) break;

      // 302/303 after a POST become a GET, per browser behaviour.
      const next = new URL(location, BASE).toString();
      res = await this.requestOnce(next, {
        method: "GET",
        headers: { Referer: `${BASE}/` },
      });
      hops += 1;
    }

    return res;
  }

  /**
   * Log in with email + password.
   *
   * Login is a plain HTML form POST to /class — there is no `user.login` API method. The token
   * in that form is *not* the one API calls use, so a second fetch of the authenticated page is
   * required to pick up `window.CSRF_TOKEN`.
   */
  async login(email: string, password: string): Promise<PiazzaSession> {
    const trace: string[] = [];

    const landing = await this.request("/");
    const landingHtml = await landing.text();
    trace.push(`GET / → ${landing.status}, ${landingHtml.length}B, cookies=[${this.cookieNames()}]`);

    if (!landing.ok) {
      throw new PiazzaError(`Could not load piazza.com (HTTP ${landing.status})`, "login", trace.join(" | "));
    }

    const formToken = formValue(landingHtml, "csrf_token");
    if (!formToken) {
      throw new PiazzaError(
        "No csrf_token in the login form — Piazza's login page markup has changed.",
        "login",
        trace.join(" | "),
      );
    }

    // The homepage form carries from="/signup", which lands the session on a marketing page with
    // no csrf_token meta tag. Ask to be sent to /class instead — that is the authenticated page
    // the token lives on.
    const body = new URLSearchParams({
      from: "/class",
      email,
      password,
      remember: "on",
      csrf_token: formToken,
    });

    const res = await this.request("/class", {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${BASE}/`,
      },
    });

    if (res.status >= 500) {
      throw new PiazzaError(`Login failed — Piazza returned HTTP ${res.status}`, "login");
    }

    // Piazza returns 200 for bad credentials and re-renders the login form, so success is
    // judged by the content: the POST response already *is* the authenticated class page, and
    // only authenticated pages carry the csrf_token meta tag.
    const html = await res.text();
    trace.push(
      `POST /class → ${res.status}${res.headers.get("location") ? ` →${res.headers.get("location")}` : ""}, ` +
        `${html.length}B, cookies=[${this.cookieNames()}]`,
    );

    const token = pageCsrfToken(html);
    if (token) {
      this.csrfToken = token;
      return this.getSession();
    }

    // Fall back to fetching the page separately, in case the POST answered with a redirect
    // rather than the full page.
    const followUp = await this.request("/class");
    const followUpHtml = await followUp.text();
    trace.push(`GET /class → ${followUp.status}, ${followUpHtml.length}B`);

    const retryToken = pageCsrfToken(followUpHtml);
    if (retryToken) {
      this.csrfToken = retryToken;
      return this.getSession();
    }

    const rejected = /name=["']password["']/i.test(html) || /name=["']password["']/i.test(followUpHtml);
    throw new PiazzaError(
      rejected
        ? "Piazza rejected the credentials — the login form was returned again. Check PIAZZA_EMAIL and PIAZZA_PASSWORD."
        : "Logged in, but no csrf_token meta tag was found — Piazza's page markup may have changed.",
      "login",
      trace.join(" | "),
    );
  }

  /**
   * Call a Piazza API method.
   *
   * Responses are `{ result, error }` with HTTP 200 even for application errors, so the body
   * must be inspected rather than the status.
   */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.csrfToken) {
      throw new PiazzaError("No CSRF token — call login() first.", "csrf");
    }

    const aid =
      Date.now().toString(36) + Math.round(Math.random() * 1679616).toString(36);

    const res = await this.request(`/logic/api?method=${encodeURIComponent(method)}&aid=${aid}`, {
      method: "POST",
      body: JSON.stringify({ method, params }),
      headers: {
        "Content-Type": "application/json",
        "CSRF-Token": this.csrfToken,
        Referer: `${BASE}/class`,
      },
    });

    const text = await res.text();
    let payload: { result?: T; error?: unknown };
    try {
      payload = JSON.parse(text);
    } catch {
      // An HTML body here almost always means the session lapsed and we were served a login page.
      throw new PiazzaError(
        `${method} returned non-JSON (HTTP ${res.status}) — session likely expired.`,
        "session",
        text.slice(0, 200),
      );
    }

    if (payload.error) {
      throw new PiazzaError(`${method} failed: ${JSON.stringify(payload.error)}`, "api", payload.error);
    }
    return payload.result as T;
  }

  // ---------------------------------------------------------------------------
  // Typed wrappers
  // ---------------------------------------------------------------------------

  async getProfile(): Promise<PiazzaProfile> {
    return this.call<PiazzaProfile>("user_profile.get_profile");
  }

  /** Enrolled courses, newest term first where the term can be parsed. */
  async getCourses(): Promise<PiazzaCourse[]> {
    const profile = await this.getProfile();
    const courses = Object.values(profile.all_classes ?? {});
    return courses.sort((a, b) => termRank(b.term) - termRank(a.term));
  }

  async getFeed(
    nid: string,
    opts: { limit?: number; offset?: number; sort?: string } = {},
  ): Promise<PiazzaFeedResponse> {
    return this.call<PiazzaFeedResponse>("network.get_my_feed", {
      nid,
      limit: opts.limit ?? 100,
      offset: opts.offset ?? 0,
      sort: opts.sort ?? "date_desc",
    });
  }

  /** Server-side filtered feed. Flags are only sent when true — Piazza treats presence as on. */
  async filterFeed(nid: string, filters: FeedFilters = {}): Promise<PiazzaFeedResponse> {
    const params: Record<string, unknown> = { nid, sort: "date_desc" };
    if (filters.folder) {
      params.folder = 1;
      params.filter_folder = filters.folder;
    }
    for (const flag of ["unresolved", "unread", "my_posts"] as const) {
      if (filters[flag]) params[flag] = 1;
    }
    return this.call<PiazzaFeedResponse>("network.filter_feed", params);
  }

  /**
   * Full-text search.
   *
   * Deliberately does not pass `sort` — forcing `date_desc` and then truncating discards the
   * canonical old answer, which is usually the one worth finding. Piazza's own default ordering
   * is relevance-based.
   */
  async search(nid: string, query: string): Promise<PiazzaFeedItem[]> {
    const result = await this.call<PiazzaFeedItem[] | PiazzaFeedResponse>("network.search", {
      nid,
      query,
    });
    // Observed as a bare array, but tolerate the wrapped form other feed methods use.
    return Array.isArray(result) ? result : (result.feed ?? []);
  }

  /** One thread by its human-facing post number. */
  async getPost(nid: string, postNumber: number | string): Promise<PiazzaPost> {
    return this.call<PiazzaPost>("content.get", { nid, cid: String(postNumber) });
  }

  /**
   * Resolve user ids to names and roles, memoized per course.
   *
   * Roles are not present on posts, so this is the only way to tell an instructor answer from a
   * student one. Ids already seen are served from cache, and only the remainder are requested.
   */
  async resolveUsers(nid: string, ids: string[]): Promise<Map<string, PiazzaUser>> {
    let cache = this.userCache.get(nid);
    if (!cache) {
      cache = new Map<string, PiazzaUser>();
      this.userCache.set(nid, cache);
    }

    const missing = [...new Set(ids)].filter((id) => id && !cache!.has(id));
    if (missing.length > 0) {
      try {
        const users = await this.call<PiazzaUser[]>("network.get_users", { nid, ids: missing });
        for (const user of users ?? []) if (user?.id) cache.set(user.id, user);
      } catch {
        // Role resolution is an enhancement, not a requirement — a thread still reads fine with
        // unresolved authors, so never let this fail the whole request.
      }
    }

    return cache;
  }
}

/** Rank a term string so courses can be ordered newest-first. */
function termRank(term: string | undefined): number {
  if (!term) return 0;
  const year = Number(term.match(/\d{4}/)?.[0] ?? 0);
  const season = term.toLowerCase();
  const offset = season.includes("winter")
    ? 0
    : season.includes("spring")
      ? 1
      : season.includes("summer")
        ? 2
        : season.includes("fall")
          ? 3
          : 0;
  return year * 10 + offset;
}
