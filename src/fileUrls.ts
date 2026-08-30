/**
 * Signed, short-lived download URLs.
 *
 * The preferred way to hand over a file is an embedded resource on the tool result — the bytes
 * travel with the response and no second request is needed. Not every client can accept one:
 * some refuse binary content types outright, and others flatten a file back into text, which
 * defeats the point of fetching it.
 *
 * For those, the server hands out a URL instead. The client's own sandbox fetches it, and the
 * file lands on that sandbox's disk as a real file it can open, compile, or unpack.
 *
 * The URL carries its own authorisation. A sandbox `curl` has no bearer token, so requiring one
 * would make the fallback useless — instead the path contains an HMAC-signed payload naming
 * exactly one file and an expiry. It cannot be edited to reach a different file, cannot be
 * guessed, and stops working shortly after it is issued.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Long enough for a client to fetch, short enough that a leaked link is not a standing key.
 *
 * Nothing is stored to expire — the lifetime is signed into the token itself, so an old link
 * simply stops verifying. The server never holds a file or a list of outstanding URLs.
 */
export const FILE_URL_TTL_SECONDS = 10 * 60;

interface FileTokenPayload {
  /** Org unit id. */
  c: number;
  /** Kind: omitted for legacy course-topic links, `s` for a submitted assignment file. */
  k?: "s";
  /** Topic id. */
  t?: number;
  /** Dropbox folder, submission and file ids. */
  d?: number;
  s?: number;
  f?: number;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** `<base64url payload>.<base64url signature>` */
export function signFileToken(courseId: number, topicId: number, secret: string): string {
  const payload: FileTokenPayload = {
    c: courseId,
    t: topicId,
    exp: nowSeconds() + FILE_URL_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function signSubmissionFileToken(
  courseId: number,
  folderId: number,
  submissionId: number,
  fileId: number,
  secret: string,
): string {
  const payload: FileTokenPayload = {
    k: "s",
    c: courseId,
    d: folderId,
    s: submissionId,
    f: fileId,
    exp: nowSeconds() + FILE_URL_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export type FileGrant =
  | { kind: "topic"; courseId: number; topicId: number }
  | {
      kind: "submission";
      courseId: number;
      folderId: number;
      submissionId: number;
      fileId: number;
    };

/**
 * Verifies a token and returns what it authorises.
 *
 * Returns null on any failure without distinguishing why: a caller learning that a signature
 * was valid but expired, versus never valid at all, gains nothing legitimate.
 */
export function verifyFileToken(
  token: string,
  secret: string,
): FileGrant | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");

  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return null;
  }
  if (!timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as FileTokenPayload;
    if (typeof payload.exp !== "number" || payload.exp < nowSeconds()) return null;
    if (typeof payload.c !== "number") return null;
    if (payload.k === "s") {
      if (
        typeof payload.d !== "number" ||
        typeof payload.s !== "number" ||
        typeof payload.f !== "number"
      ) {
        return null;
      }
      return {
        kind: "submission",
        courseId: payload.c,
        folderId: payload.d,
        submissionId: payload.s,
        fileId: payload.f,
      };
    }
    if (typeof payload.t !== "number") return null;
    return { kind: "topic", courseId: payload.c, topicId: payload.t };
  } catch {
    return null;
  }
}
