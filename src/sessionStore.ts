/**
 * Where a Learn session lives between requests.
 *
 * A session established at /setup used to exist only in the memory of the instance that served
 * the page. On a long-running server that is enough until the next restart; on Vercel it is
 * barely anything — the next request can land on a fresh instance that has never heard of it,
 * so a sign-in that succeeded would be followed by tools reporting "not signed in".
 *
 * So a session is written somewhere every instance can read:
 *
 *   - Vercel Blob, when the project has a store connected (BLOB_READ_WRITE_TOKEN is set).
 *   - A file on disk, on a host with a real filesystem (a laptop, a VPS, Render, Railway…).
 *   - Nowhere, on a serverless host with neither — the page says so rather than pretending.
 *
 * Alongside the Brightspace cookie the record can hold the WatIAM login typed into /setup and
 * the sign-in browser's own cookies. The latter carry Duo's "trust this browser" decision, so
 * a later sign-in can often pass without a phone at all.
 *
 * Everything is sealed with AES-256-GCM under a key derived from MCP_AUTH_TOKEN before it
 * leaves the process. The store holds ciphertext; whoever can read it without the token learns
 * nothing, and rotating the token makes old records unreadable rather than silently trusted.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config, PiazzaCredentials, WaterlooCredentials } from "./config.js";

const BLOB_PATHNAME = "uwaterloo-mcp/learn-session.bin";
const RECORD_VERSION = 1;

/**
 * How long an instance trusts what it last read before looking again. Short enough that a
 * sign-in on one instance reaches the others within a request or two; long enough that a burst
 * of tool calls costs one read rather than one each.
 */
const REFRESH_INTERVAL_MS = 5_000;

/** A cookie from the sign-in browser, in the shape puppeteer reads and writes. */
export interface StoredBrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None" | undefined;
}

export interface SessionRecord {
  v: typeof RECORD_VERSION;
  /** Milliseconds since the epoch. Newer records replace older ones, never the reverse. */
  savedAt: number;
  /** The Brightspace Cookie header, when a session has been established. */
  cookie?: string | undefined;
  /** The WatIAM login, only when the person chose to keep it here. */
  waterloo?: WaterlooCredentials | undefined;
  /** Piazza credentials, when configured via /setup. */
  piazza?: PiazzaCredentials | undefined;
  /** UWaterloo, ADFS and Duo cookies from the last successful sign-in. */
  browserCookies?: StoredBrowserCookie[] | undefined;
  /** Whether the auto-ping keep-alive service is active. */
  keepAlive?: boolean | undefined;
  /** Timestamp (ms) of the last successful session keep-alive ping. */
  lastPingAt?: number | undefined;
}

export type StoreKind = "blob" | "file" | "memory";

interface Backend {
  kind: StoreKind;
  read(): Promise<Buffer | null>;
  write(data: Buffer): Promise<void>;
}

function blobBackend(token: string): Backend {
  let detectedAccess: "private" | "public" = "private";
  return {
    kind: "blob",
    async read() {
      const { get, list, BlobNotFoundError } = await import("@vercel/blob");
      let lastErr: unknown = null;

      for (const access of [
        detectedAccess,
        detectedAccess === "private" ? "public" : "private",
      ] as const) {
        try {
          const result = await get(BLOB_PATHNAME, { access, useCache: false, token });
          if (!result) return null;
          if (result.stream) {
            detectedAccess = access;
            return Buffer.from(await new Response(result.stream).arrayBuffer());
          }
        } catch (err) {
          if (err instanceof BlobNotFoundError) return null;
          lastErr = err;
        }
      }

      // Fallback: list() works regardless of whether the store is public or private
      try {
        const { blobs } = await list({ prefix: BLOB_PATHNAME, limit: 5, token });
        const match = blobs.find((b) => b.pathname === BLOB_PATHNAME) ?? blobs[0];
        if (!match) return null;
        const targetUrl = match.downloadUrl || match.url;
        const res = await fetch(targetUrl, {
          headers: { Authorization: `Bearer ${token}`, "Cache-Control": "no-cache" },
        });
        if (res.status === 404) return null;
        if (res.ok) return Buffer.from(await res.arrayBuffer());
      } catch (err) {
        lastErr ??= err;
      }

      if (lastErr) throw lastErr;
      return null;
    },
    async write(data) {
      const { put } = await import("@vercel/blob");
      try {
        await put(BLOB_PATHNAME, data, {
          access: detectedAccess,
          addRandomSuffix: false,
          allowOverwrite: true,
          contentType: "application/octet-stream",
          token,
        });
      } catch {
        const altAccess = detectedAccess === "private" ? "public" : "private";
        await put(BLOB_PATHNAME, data, {
          access: altAccess,
          addRandomSuffix: false,
          allowOverwrite: true,
          contentType: "application/octet-stream",
          token,
        });
        detectedAccess = altAccess;
      }
    },
  };
}

function fileBackend(file: string): Backend {
  return {
    kind: "file",
    async read() {
      try {
        return await readFile(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async write(data) {
      await mkdir(path.dirname(file), { recursive: true });
      // Write-then-rename, so a crash mid-write leaves the previous session rather than garbage.
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, data, { mode: 0o600 });
      await rename(temporary, file);
    },
  };
}

function memoryBackend(): Backend {
  let held: Buffer | null = null;
  return {
    kind: "memory",
    async read() {
      return held;
    },
    async write(data) {
      held = data;
    },
  };
}

function findBlobToken(env: Record<string, string | undefined>): string | undefined {
  const direct = env.BLOB_READ_WRITE_TOKEN?.trim();
  if (direct) return direct;
  for (const [key, val] of Object.entries(env)) {
    const trimmed = val?.trim();
    if (!trimmed) continue;
    if (key.endsWith("_READ_WRITE_TOKEN") || trimmed.startsWith("vercel_blob_rw_")) {
      return trimmed;
    }
  }
  return undefined;
}

function chooseBackend(env: Record<string, string | undefined>): Backend {
  const blobToken = findBlobToken(env);
  if (blobToken) return blobBackend(blobToken);
  // Serverless filesystems are read-only, or private to one short-lived instance — a file
  // there would look like persistence while being exactly as forgetful as memory.
  if (env.VERCEL) return memoryBackend();
  return fileBackend(path.resolve(env.LEARN_SESSION_FILE?.trim() || ".learn-session"));
}

function keyFor(secret: string): Buffer {
  return createHash("sha256").update("uwaterloo-mcp session store v1\0").update(secret).digest();
}

function seal(record: SessionRecord, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(record), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function open(data: Buffer, key: Buffer): SessionRecord | null {
  if (data.length < 29) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
    const record = JSON.parse(plain.toString("utf8")) as SessionRecord;
    return record.v === RECORD_VERSION && typeof record.savedAt === "number" ? record : null;
  } catch {
    // Wrong key (the token was rotated) or a damaged record. Either way it is not ours to use.
    return null;
  }
}

export class SessionStore {
  private record: SessionRecord | null = null;
  private lastReadAt = 0;
  private reading: Promise<void> | null = null;
  public lastError: string | null = null;

  constructor(
    private readonly backend: Backend,
    private readonly key: Buffer,
  ) {}

  get kind(): StoreKind {
    return this.backend.kind;
  }

  /** Whether a session written here outlives this process. */
  get persistent(): boolean {
    return this.backend.kind !== "memory";
  }

  /** The newest record any instance has written, re-read at most every REFRESH_INTERVAL_MS. */
  async current(force = false): Promise<SessionRecord | null> {
    if (force || !this.record || Date.now() - this.lastReadAt >= REFRESH_INTERVAL_MS) {
      this.reading ??= this.refresh().finally(() => {
        this.reading = null;
      });
      await this.reading;
    }
    return this.record;
  }

  private async refresh(): Promise<void> {
    try {
      const data = await this.backend.read();
      const stored = data ? open(data, this.key) : null;
      if (stored) {
        if (!this.record) {
          this.record = stored;
        } else if (stored.savedAt >= this.record.savedAt) {
          this.record = { ...this.record, ...stored };
        } else {
          this.record = { ...stored, ...this.record };
        }
      }
      this.lastReadAt = Date.now();
      this.lastError = null;
    } catch (error) {
      // A storage hiccup must not take the tools down with it: keep what this instance knows,
      // and try again on the next request rather than waiting out the interval.
      const msg = error instanceof Error ? error.message : String(error);
      this.lastError = msg;
      console.warn("[session-store] read failed", {
        kind: this.backend.kind,
        error: msg,
      });
    }
  }

  /**
   * Merges `changes` into the newest record and writes it back. Fields that are passed as
   * `undefined` are cleared; fields that are absent are kept.
   */
  async update(changes: Partial<Omit<SessionRecord, "v" | "savedAt">>): Promise<void> {
    const base = (await this.current(true)) ?? this.record ?? { v: RECORD_VERSION, savedAt: 0 };
    const next: SessionRecord = { ...base, ...changes, v: RECORD_VERSION, savedAt: Date.now() };
    try {
      await this.backend.write(seal(next, this.key));
      this.lastError = null;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.lastError = msg;
      throw error;
    }
    this.record = next;
    this.lastReadAt = Date.now();
  }
}

/** One store per config object — i.e. per process, since a config is built once at boot. */
const stores = new WeakMap<Config, SessionStore>();

export function sessionStore(config: Config): SessionStore {
  let store = stores.get(config);
  if (!store) {
    // Without an access token there is nothing secret to derive a key from. That is the
    // explicitly unauthenticated local-testing mode, so memory is the honest choice.
    store = config.authToken
      ? new SessionStore(chooseBackend(process.env), keyFor(config.authToken))
      : new SessionStore(memoryBackend(), keyFor(""));
    stores.set(config, store);
  }
  return store;
}

/**
 * Brings `config` up to date with the shared store before a request uses it.
 *
 * A session established on another instance (or before a restart) is adopted here. A record
 * older than the session this process already holds never replaces it.
 */
let adoptedSavedAt = 0;

export async function syncSession(config: Config, force = false): Promise<void> {
  const record = await sessionStore(config).current(force);
  if (!record) return;

  if (record.cookie && (force || record.savedAt > adoptedSavedAt || !config.d2l)) {
    if (config.d2l?.cookie !== record.cookie) {
      config.d2l = { host: config.d2lHost, cookie: record.cookie, csrfToken: undefined };
    }
    adoptedSavedAt = Math.max(adoptedSavedAt, record.savedAt);
  }

  if (record.piazza) {
    config.piazza = record.piazza;
  } else if (!process.env.PIAZZA_EMAIL) {
    config.piazza = null;
  }
}

/** The WatIAM login to sign in with: the environment's, else one saved from /setup. */
export async function storedWaterlooCredentials(
  config: Config,
): Promise<WaterlooCredentials | null> {
  if (config.waterloo) return config.waterloo;
  return (await sessionStore(config).current())?.waterloo ?? null;
}

/** The Piazza login to sign in with: the environment's, else one saved from /setup. */
export async function storedPiazzaCredentials(
  config: Config,
): Promise<PiazzaCredentials | null> {
  if (config.piazza) return config.piazza;
  return (await sessionStore(config).current())?.piazza ?? null;
}
