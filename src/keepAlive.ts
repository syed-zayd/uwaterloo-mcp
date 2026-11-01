/**
 * Automated keep-alive service for UWaterloo Learn.
 *
 * Brightspace session cookies expire after 180 minutes of inactivity. Pinging Learn periodically
 * (every 45 minutes) keeps the sliding window alive so the session never expires.
 *
 * If the session ever lapses, the runner can attempt an automatic re-login if saved WatIAM
 * credentials and Duo trusted browser cookies are present in the SessionStore.
 */

import type { Config } from "./config.js";
import { D2LClient } from "./d2l/client.js";
import {
  sessionStore,
  storedWaterlooCredentials,
  syncSession,
} from "./sessionStore.js";
import { signInUWaterloo } from "./waterlooLogin.js";

export const KEEP_ALIVE_INTERVAL_MS = 45 * 60_000; // 45 minutes

/**
 * How often a routine ping's timestamp is written back to the store. Every write is a billed
 * Blob put(), so pings are remembered in memory and only persisted this often — another
 * instance that misses a recent ping just pings Learn once more, which costs nothing.
 */
const PERSIST_PING_INTERVAL_MS = 6 * 60 * 60_000; // 6 hours

/** The last successful ping seen by this instance, whether or not it has been persisted. */
let lastPingAtLocal = 0;

/** When Learn was last pinged, as far as this instance knows. */
export function latestPingAt(record: { lastPingAt?: number | undefined } | null): number {
  return Math.max(lastPingAtLocal, record?.lastPingAt ?? 0);
}

export interface PingResult {
  ok: boolean;
  message: string;
  who?: string;
  reauthenticated?: boolean;
}

/** Pings the live session or attempts automatic re-authentication if it expired. */
export async function pingLearnSession(config: Config): Promise<PingResult> {
  await syncSession(config);
  if (!config.d2l) {
    return { ok: false, message: "No Learn session has been established yet." };
  }

  const client = new D2LClient(config.d2l);
  const status = await client.sessionStatus();
  const store = sessionStore(config);

  if (status.alive) {
    const who = `${status.user.FirstName} ${status.user.LastName}`;
    const now = Date.now();
    lastPingAtLocal = now;
    const persisted = (await store.current())?.lastPingAt ?? 0;
    if (now - persisted >= PERSIST_PING_INTERVAL_MS) {
      await store.update({ lastPingAt: now });
    }
    return {
      ok: true,
      who,
      message: `Session verified active for ${who}. Sliding 3-hour window refreshed.`,
    };
  }

  // Session has lapsed: try automated background sign-in if credentials & browser cookies exist
  const creds = await storedWaterlooCredentials(config);
  const record = await store.current();

  if (creds && record?.browserCookies) {
    console.info("[keep-alive] Session expired; attempting automated re-authentication...");
    try {
      const login = await signInUWaterloo(creds, config.d2lHost, {
        browserCookies: record.browserCookies,
      });
      const newClient = new D2LClient({
        host: config.d2lHost,
        cookie: login.cookie,
        csrfToken: undefined,
      });
      const newStatus = await newClient.sessionStatus();
      if (newStatus.alive) {
        const who = `${newStatus.user.FirstName} ${newStatus.user.LastName}`;
        config.d2l = { host: config.d2lHost, cookie: login.cookie, csrfToken: undefined };
        process.env.D2L_COOKIE = login.cookie;
        lastPingAtLocal = Date.now();
        await store.update({
          cookie: login.cookie,
          browserCookies: login.browserCookies,
          lastPingAt: Date.now(),
        });
        return {
          ok: true,
          who,
          reauthenticated: true,
          message: `Session expired and was automatically restored for ${who}.`,
        };
      }
    } catch (err) {
      console.warn("[keep-alive] Automated re-login failed:", err);
    }
  }

  return { ok: false, message: status.reason };
}

/**
 * Called before MCP requests so serverless deployments (like Vercel) automatically refresh
 * or silently re-authenticate expired sessions when Keep Signed In is enabled.
 */
export async function ensureKeepAliveOnRequest(config: Config): Promise<void> {
  await syncSession(config);
  const store = sessionStore(config);
  const record = await store.current();
  if (!record?.keepAlive || !config.d2l) return;

  const elapsed = Date.now() - latestPingAt(record);
  if (elapsed >= KEEP_ALIVE_INTERVAL_MS) {
    await pingLearnSession(config).catch((err) => {
      console.warn("[keep-alive] On-request refresh error:", err);
    });
  }
}

/** Background interval runner for long-running processes (Node / Docker). */
export function startKeepAliveRunner(config: Config): () => void {
  const store = sessionStore(config);

  // Check once per minute whether a ping is due
  const timer = setInterval(async () => {
    try {
      await syncSession(config);
      const record = await store.current();
      if (!record?.keepAlive || !config.d2l) return;

      const elapsed = Date.now() - latestPingAt(record);
      if (elapsed >= KEEP_ALIVE_INTERVAL_MS) {
        console.info("[keep-alive] Scheduled session ping starting...");
        const result = await pingLearnSession(config);
        console.info("[keep-alive] Ping result:", result.message);
      }
    } catch (err) {
      console.warn("[keep-alive] Scheduled ping error:", err);
    }
  }, 60_000);

  timer.unref?.();
  return () => clearInterval(timer);
}
