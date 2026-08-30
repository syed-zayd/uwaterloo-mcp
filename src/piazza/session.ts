/**
 * Cached Piazza login.
 *
 * Deliberately an in-process cache rather than KV/Redis/D1: it works identically on Vercel and
 * Workers, needs no provisioning, and keeps one-click deploys to a single step. The cost is one
 * extra login per cold start, which is a few hundred milliseconds.
 */

import { PiazzaClient, PiazzaError } from "./client.js";

export interface Credentials {
  email: string;
  password: string;
}

/** Piazza sessions outlive this comfortably; re-login is cheap insurance against silent expiry. */
const SESSION_TTL_MS = 45 * 60 * 1000;

let cached: { client: PiazzaClient; createdAt: number; credentialKey: string } | null = null;
let inFlight: { credentialKey: string; promise: Promise<PiazzaClient> } | null = null;

function credentialKey({ email, password }: Credentials): string {
  return `${email}\u0000${password}`;
}

async function login({ email, password }: Credentials): Promise<PiazzaClient> {
  const client = new PiazzaClient();
  await client.login(email, password);
  cached = { client, createdAt: Date.now(), credentialKey: credentialKey({ email, password }) };
  return client;
}

/**
 * Get a logged-in client, reusing the cached session when it is still fresh.
 *
 * Concurrent callers share a single login attempt — without this, a cold start handling several
 * tool calls at once would fire a separate login for each.
 */
export async function getClient(creds: Credentials): Promise<PiazzaClient> {
  const key = credentialKey(creds);
  if (
    cached &&
    cached.credentialKey === key &&
    Date.now() - cached.createdAt < SESSION_TTL_MS
  ) {
    return cached.client;
  }
  if (inFlight?.credentialKey === key) return inFlight.promise;

  const promise = login(creds).finally(() => {
    if (inFlight?.promise === promise) inFlight = null;
  });
  inFlight = { credentialKey: key, promise };
  return promise;
}

/** Drop the cached session so the next call logs in again. */
export function invalidateSession(): void {
  cached = null;
  inFlight = null;
}

/**
 * Run a Piazza operation, retrying once if the session turns out to be dead.
 *
 * Piazza answers an expired session with an HTML login page rather than a 401, which the client
 * surfaces as a non-JSON error. That is indistinguishable from a transient failure at the call
 * site, so it is handled here in one place instead of at every tool.
 */
export async function withSession<T>(
  creds: Credentials,
  fn: (client: PiazzaClient) => Promise<T>,
): Promise<T> {
  const client = await getClient(creds);
  try {
    return await fn(client);
  } catch (err) {
    // Only a dead session is worth retrying. An `api` failure means Piazza rejected the request
    // itself — retrying it just produces the same rejection twice.
    const expired =
      err instanceof PiazzaError && (err.stage === "session" || err.stage === "csrf");
    if (!expired) throw err;

    invalidateSession();
    const fresh = await getClient(creds);
    return fn(fresh);
  }
}
