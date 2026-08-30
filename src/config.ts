/**
 * Configuration loading and validation.
 *
 * Learn and Piazza credentials are optional so a fresh deployment can boot into the setup
 * flow. The HTTP surface and its access token are validated eagerly: a deployment must never
 * expose either account because an environment variable was forgotten.
 */

export const SERVER_NAME = "uwaterloo";
export const VERSION = "1.0.0";

/** The current MCP specification revision. See SUPPORTED_PROTOCOL_VERSIONS in server.ts. */
export const CURRENT_PROTOCOL_VERSION = "2026-07-28";

/** Minimum length for MCP_AUTH_TOKEN. Short tokens are guessable and this is the only guard. */
const MIN_TOKEN_LENGTH = 24;

export interface Config {
  port: number;
  /**
   * Interface to bind. Defaults to 127.0.0.1, which also switches on the SDK's automatic
   * localhost DNS-rebinding protection. Hosted deployments need 0.0.0.0.
   */
  host: string;
  /** Bearer token required on /mcp. `null` means auth is explicitly disabled. */
  authToken: string | null;
  /**
   * Origin hostnames permitted by the DNS-rebinding check. Empty means the SDK's default
   * applies (localhost-only when bound locally; unrestricted when bound to 0.0.0.0, where the
   * bearer token is the guard instead).
   */
  allowedOrigins: string[];
  /** Host header values permitted when bound to a non-localhost interface. */
  allowedHosts: string[];
  /** Public base URL, used to build OAuth discovery documents. */
  publicUrl: string | null;
  /**
   * True on a managed platform that assigns the hostname and terminates TLS. Skips Host
   * validation, which would otherwise reject the platform's own generated domain and break a
   * deploy the user never had a chance to configure.
   */
  trustPlatformHost: boolean;
  /** True when running behind a platform proxy, so X-Forwarded-* headers are authoritative. */
  trustProxy: boolean;
  /**
   * D2L credentials. Null when unconfigured — the server still starts and serves `server_info`,
   * so a fresh deployment can be connected and diagnosed before credentials are added.
   */
  d2l: D2LCredentials | null;
  /** Brightspace base URL even when no session cookie has been configured yet. */
  d2lHost: string;
  /**
   * Optional UWaterloo credentials, used only by the /setup page.
   * They never cross the MCP boundary: no tool reads them and no tool can sign in.
   */
  waterloo: WaterlooCredentials | null;
  /** Piazza login used only by the Piazza client and never exposed through MCP. */
  piazza: PiazzaCredentials | null;
}

export interface D2LCredentials {
  host: string;
  cookie: string;
  csrfToken: string | undefined;
}

export interface WaterlooCredentials {
  username: string;
  password: string;
}

export interface PiazzaCredentials {
  email: string;
  password: string;
}

export type ConfigResult =
  | { ok: true; config: Config; warnings: string[] }
  | { ok: false; problems: string[] };

type EnvLike = Record<string, string | undefined>;

/**
 * Absolute URL of the /setup page. Quoted in auth errors, so it must be something a person can
 * paste into a browser — never a relative path.
 */
export function setupUrl(config: Config): string {
  const base = config.publicUrl ?? `http://127.0.0.1:${config.port}`;
  return new URL("/setup", base).href;
}

export function loadConfig(env: EnvLike): ConfigResult {
  const problems: string[] = [];
  const warnings: string[] = [];

  const portRaw = env.PORT?.trim() || "8787";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`PORT must be an integer 1-65535, got ${JSON.stringify(portRaw)}.`);
  }

  // Auth is opt-out rather than optional: forgetting to set a token must not silently
  // publish an open endpoint, so disabling it requires saying so explicitly.
  const authDisabled = env.MCP_ALLOW_UNAUTHENTICATED?.trim() === "true";
  // Strip only trailing newlines: CLI tools that pipe secrets append one, and a token
  // ending in a real newline does not exist.
  const explicitToken = env.MCP_AUTH_TOKEN?.replace(/[\r\n]+$/, "") || undefined;
  const authToken = explicitToken;

  if (authDisabled) {
    if (explicitToken) {
      problems.push(
        "MCP_ALLOW_UNAUTHENTICATED=true and MCP_AUTH_TOKEN are both set — pick one.",
      );
    }
    warnings.push(
      "Authentication is DISABLED (MCP_ALLOW_UNAUTHENTICATED=true). Use this only for local testing.",
    );
  } else if (!authToken) {
    problems.push(
      "MCP_AUTH_TOKEN is not set. Set it to a random value of at least 24 characters, or set " +
        "MCP_ALLOW_UNAUTHENTICATED=true for local testing.",
    );
  } else if (explicitToken && explicitToken.length < MIN_TOKEN_LENGTH) {
    problems.push(
      `MCP_AUTH_TOKEN is only ${explicitToken.length} characters; use at least ${MIN_TOKEN_LENGTH}.`,
    );
  }

  const platform = env.VERCEL
    ? "vercel"
    : env.RENDER
      ? "render"
      : env.RAILWAY_ENVIRONMENT
        ? "railway"
        : null;
  const host = env.HOST?.trim() || (platform ? "0.0.0.0" : "127.0.0.1");

  const csv = (raw: string | undefined): string[] =>
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  // These are hostnames, not full origins: the SDK matches them port-agnostically.
  const allowedOrigins = csv(env.MCP_ALLOWED_ORIGINS);
  const allowedHosts = csv(env.MCP_ALLOWED_HOSTS);

  // Managed platforms assign the hostname and terminate TLS themselves. Detecting that lets a
  // one-click deploy work with zero configuration: no MCP_PUBLIC_URL, no allowed-hosts list.
  const trustPlatformHost = platform !== null;
  const trustProxy = platform !== null;

  // Vercel exposes the deployment's own hostname; prefer a production alias when present so the
  // printed URL stays stable across deploys.
  const platformUrl = env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`
    : env.VERCEL_URL
      ? `https://${env.VERCEL_URL}`
      : env.RENDER_EXTERNAL_URL || null;

  const publicUrl = env.MCP_PUBLIC_URL?.trim().replace(/\/+$/, "") || platformUrl || null;

  // D2L credentials are optional: an unconfigured deployment still starts and reports its
  // status through server_info, which is what makes a fresh one-click deploy diagnosable.
  const d2lHost = env.D2L_HOST?.trim().replace(/\/+$/, "") || "https://learn.uwaterloo.ca";
  const d2lCookie = env.D2L_COOKIE?.replace(/[\r\n]+$/, "").trim();
  const d2lCsrf = env.D2L_CSRF_TOKEN?.trim();

  if (!/^https?:\/\//.test(d2lHost)) {
    problems.push(`D2L_HOST must start with http:// or https://, got ${JSON.stringify(d2lHost)}.`);
  }

  let d2l: D2LCredentials | null = null;
  if (d2lCookie) {
    if (/^https?:\/\//.test(d2lHost)) {
      d2l = { host: d2lHost, cookie: d2lCookie, csrfToken: d2lCsrf || undefined };
    }
  } else {
    warnings.push(
      "No Learn session yet — Learn tools will say so and link to /setup until someone signs in there.",
    );
  }

  // Passwords are deliberately server-side configuration, never MCP tool arguments. Treat a
  // half-configured login as unavailable rather than preventing the existing cookie path from
  // starting: this feature is an optional recovery mechanism, not a new boot dependency.
  const waterlooUsername = env.UWATERLOO_USERNAME?.trim();
  const waterlooPassword = env.UWATERLOO_PASSWORD?.replace(/[\r\n]+$/, "");
  let waterloo: WaterlooCredentials | null = null;
  if (waterlooUsername && waterlooPassword) {
    waterloo = { username: waterlooUsername, password: waterlooPassword };
  } else if (waterlooUsername || waterlooPassword) {
    warnings.push(
      "UWaterloo sign-in is only partly configured — set both UWATERLOO_USERNAME and " +
      "UWATERLOO_PASSWORD, or remove both. Manual D2L_COOKIE setup is unaffected.",
    );
  }

  const piazzaEmail = env.PIAZZA_EMAIL?.trim();
  const piazzaPassword = env.PIAZZA_PASSWORD?.replace(/[\r\n]+$/, "");
  let piazza: PiazzaCredentials | null = null;
  if (piazzaEmail && piazzaPassword) {
    piazza = { email: piazzaEmail, password: piazzaPassword };
  } else if (piazzaEmail || piazzaPassword) {
    warnings.push(
      "Piazza is only partly configured — set both PIAZZA_EMAIL and PIAZZA_PASSWORD, or remove both.",
    );
  } else {
    warnings.push(
      "Piazza credentials are not set — set PIAZZA_EMAIL and PIAZZA_PASSWORD to enable Piazza tools.",
    );
  }

  if (publicUrl && !/^https?:\/\//.test(publicUrl)) {
    problems.push(`MCP_PUBLIC_URL must start with http:// or https://, got ${JSON.stringify(publicUrl)}.`);
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    warnings,
    config: {
      port,
      host,
      authToken: authDisabled ? null : authToken!,
      allowedOrigins,
      allowedHosts,
      publicUrl,
      trustPlatformHost,
      trustProxy,
      d2l,
      d2lHost,
      waterloo,
      piazza,
    },
  };
}
