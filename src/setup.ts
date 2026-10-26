/**
 * The Learn session page — the only place a UWaterloo session is established.
 *
 * It is built to be used from a phone: the WatIAM login is an ordinary form a password manager
 * can fill, the device is remembered so the server's token is typed once, and signing in leaves
 * nothing to do but enter Duo's three-digit code.
 *
 * Every other secret is deploy-time configuration that never changes. A Brightspace session is
 * the exception: it expires, and renewing it means passing Duo, which needs a person with a
 * browser. Deliberately no MCP tool can do this. A tool call runs under a client timeout, has to
 * relay a Duo code through whatever the client chooses to render, and dies with its response —
 * a browser tab has none of those limits, so the assistant's whole job is to send someone here.
 *
 * Nothing here writes to the hosting environment. A session is kept in the server's session
 * store (see sessionStore.ts); where that store cannot outlive the process, the page says so.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { StoreKind } from "./sessionStore.js";

/** Name of the cookie that lets a device skip retyping the server's access token. */
export const SETUP_COOKIE = "uwmcp_setup";
/** How long a device stays remembered. A term, roughly — long enough to never think about. */
export const SETUP_COOKIE_MAX_AGE_SECONDS = 120 * 24 * 60 * 60;

/**
 * The remembered-device cookie's value. Derived from the access token rather than equal to it,
 * so the token itself is never stored in a browser — and rotating the token forgets every
 * remembered device at once.
 */
export function setupCookieValue(authToken: string): string {
  return createHmac("sha256", authToken).update("uwaterloo-mcp setup device v1").digest("base64url");
}

/** Reads one cookie from a raw Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/**
 * Brightspace's idle timeout. It publishes no session-expiry endpoint, so a validity horizon can
 * only ever be inferred from this — and any request, including this page's own check, resets it.
 */
export const D2L_IDLE_WINDOW_MS = 180 * 60_000;

/** Only the two cookies that actually authenticate are required. */
export function validateCookie(raw: string): { ok: true; cookie: string } | { ok: false; error: string } {
  const cookie = raw.trim().replace(/^Cookie:\s*/i, "");
  if (!cookie) return { ok: false, error: "Paste the Cookie header value." };

  const names = cookie.split(";").map((p) => p.trim().split("=")[0]);
  for (const required of ["d2lSessionVal", "d2lSecureSessionVal"]) {
    if (!names.includes(required)) {
      return {
        ok: false,
        error:
          `That does not look like a Brightspace session — ${required} is missing. Copy the ` +
          `whole Cookie header from a learn.uwaterloo.ca request.`,
      };
    }
  }
  return { ok: true, cookie };
}

/** Constant-time compare for the page's own access token. */
export function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

export interface SessionSnapshot {
  alive: boolean;
  /** Who the session belongs to, when it is alive. */
  who?: string | undefined;
  /** Why it is not usable, when it is not. */
  reason?: string | undefined;
  /** Estimated ISO time the session lapses if nothing touches it. Only meaningful when alive. */
  idleExpiresAt?: string | undefined;
}

export interface PageState {
  authenticated: boolean;
  /**
   * The WatIAM username the server already knows a password for — from the environment or saved
   * from an earlier sign-in here — or null, in which case the page asks for both.
   */
  knownUsername: string | null;
  /** Whether the known login came from /setup (and so can be forgotten from here). */
  loginSaved: boolean;
  /** Where sessions are kept, which decides whether one survives this instance. */
  store: StoreKind;
  session?: SessionSnapshot | undefined;
  message?: { kind: "error" | "success"; text: string } | undefined;
  /**
   * The access token, carried in a hidden field so later steps do not ask for it again. The page
   * is served over HTTPS to someone who already holds this token, so echoing it reveals nothing.
   */
  tokenEcho?: string | undefined;
}

function renderSession(session: SessionSnapshot | undefined, token: string): string {
  if (!session) return "";

  const body = session.alive
    ? `<p class="verdict ok">Session is valid${session.who ? ` — signed in as ${escapeHtml(session.who)}` : ""}.</p>
       <p>Brightspace ends a session after 180 minutes with no activity, and it publishes no
         expiry, so this is an estimate rather than a promise. Checking just now reset the clock:
         left completely alone it lapses around
         <b>${escapeHtml(new Date(session.idleExpiresAt ?? Date.now()).toLocaleTimeString())}</b>.
         Anything you do through the MCP server pushes that out again.</p>`
    : `<p class="verdict bad">No usable session.</p>
       ${session.reason ? `<p>${escapeHtml(session.reason)}</p>` : ""}
       <p>Sign in below, and the Learn tools start working immediately — there is nothing to
         redeploy and nothing to paste back into your assistant.</p>`;

  return `<section class="first">
      <h2>Status</h2>
      ${body}
      <form method="POST">
        <input type="hidden" name="token" value="${token}">
        <input type="hidden" name="action" value="check">
        <button type="submit" class="secondary">Check again</button>
      </form>
    </section>`;
}

function renderStoreWarning(store: StoreKind): string {
  if (store !== "memory") return "";
  return `<p class="note warn">This server has nowhere to keep a session, so one only lasts as
      long as the instance that made it — on Vercel that can be minutes. Fix it once: in the
      Vercel project open <b>Storage → Create → Blob</b>, choose <b>Private</b>, connect it to this
      project, and redeploy.</p>`;
}

function renderSignIn(state: PageState, token: string): string {
  const intro = `<p>Opens UWaterloo's sign-in on the server. The page then shows a three-digit
      code: type it into Duo Mobile and you are done. When Duo already trusts this server it
      finishes without asking.</p>`;

  if (state.knownUsername) {
    return `<section>
        <h2>Sign in with UWaterloo</h2>
        ${intro}
        <form method="POST">
          <input type="hidden" name="token" value="${token}">
          <input type="hidden" name="action" value="waterloo">
          <button type="submit">Sign in as ${escapeHtml(state.knownUsername)}</button>
        </form>
        ${
          state.loginSaved
            ? `<form method="POST">
                 <input type="hidden" name="token" value="${token}">
                 <input type="hidden" name="action" value="forget">
                 <button type="submit" class="link">Forget this login</button>
               </form>`
            : ""
        }
      </section>`;
  }

  // Standard autocomplete names, so a phone's password manager fills both fields in one tap.
  return `<section>
      <h2>Sign in with UWaterloo</h2>
      ${intro}
      <form method="POST">
        <input type="hidden" name="token" value="${token}">
        <input type="hidden" name="action" value="waterloo">
        <label for="username">WatIAM username (e.g. jw25smit@uwaterloo.ca)</label>
        <input id="username" name="username" autocomplete="username" autocapitalize="none"
          spellcheck="false" placeholder="jsmith" required>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <label class="check"><input type="checkbox" name="remember" value="1" checked>
          Remember this login on the server, so next time is one tap</label>
        <button type="submit">Sign in with UWaterloo and Duo</button>
      </form>
    </section>`;
}

export function setupPage(state: PageState): string {
  const banner = state.message
    ? `<div class="${state.message.kind}">${escapeHtml(state.message.text)}</div>`
    : "";
  const token = escapeHtml(state.tokenEcho ?? "");

  const body = !state.authenticated
    ? `<p>Enter this server's access token to continue.</p>
       <form method="POST">
         <label for="token">Server access token</label>
         <input id="token" name="token" type="password" autocomplete="off" autofocus required>
         <p class="hint">This device is remembered afterwards, so you only enter it once.</p>
         <button type="submit">Continue</button>
       </form>`
    : `${renderSession(state.session, token)}
       ${renderSignIn(state, token)}
       ${renderStoreWarning(state.store)}
       <details class="fallback">
         <summary>Paste a session cookie instead</summary>
         <p>The fallback for when the automated sign-in cannot run — a headless browser is not
           available on every host, and UWaterloo's login page changes from time to time.</p>
         <form method="POST">
           <input type="hidden" name="token" value="${token}">
           <input type="hidden" name="action" value="cookie">
           <label for="cookie">Cookie header</label>
           <textarea id="cookie" name="cookie" rows="4" placeholder="d2lSessionVal=…; d2lSecureSessionVal=…" required></textarea>
           <button type="submit">Use this session</button>
         </form>
         <p>To find it: sign in at <code>learn.uwaterloo.ca</code> on a computer, press
           <kbd>F12</kbd>, open <b>Network</b>, reload, click any request to
           <code>learn.uwaterloo.ca</code>, and copy the whole <code>Cookie:</code> request
           header.</p>
       </details>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UWaterloo MCP — Learn session</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         max-width: 34rem; margin: 8vh auto; padding: 0 1.25rem; line-height: 1.55; }
  h1 { font-size: 1.35rem; margin-bottom: .2rem; }
  h2 { font-size: 1.05rem; margin: 0 0 .2rem; }
  p { color: #666; font-size: .94rem; }
  label { display: block; font-weight: 600; font-size: .88rem; margin: 1.3rem 0 .4rem; }
  input, textarea { width: 100%; padding: .6rem .7rem; font-size: .95rem; box-sizing: border-box;
         border: 1px solid #bbb; border-radius: .4rem; background: transparent; color: inherit;
         font-family: inherit; }
  textarea { font-family: ui-monospace, monospace; font-size: .8rem; }
  button { margin-top: 1rem; width: 100%; padding: .65rem; font-size: 1rem; font-weight: 600;
         border: 0; border-radius: .4rem; background: #2f6feb; color: #fff; cursor: pointer; }
  button.secondary { background: transparent; color: #2f6feb; border: 1px solid currentColor;
         font-weight: 500; padding: .45rem; font-size: .9rem; }
  .verdict { font-weight: 600; font-size: 1rem; }
  .verdict.ok { color: #1c6b38; }
  .verdict.bad { color: #a3241b; }
  .error, .success { padding: .7rem .85rem; border-radius: .4rem; font-size: .9rem; margin: 1rem 0; }
  .error { background: #fdeceb; color: #a3241b; }
  .success { background: #e8f5ec; color: #1c6b38; }
  .note { font-size: .85rem; border-left: 2px solid #ccc; padding-left: .8rem; margin-top: 1.5rem; }
  .note.warn { border-color: #c98a1b; }
  .hint { font-size: .82rem; margin: .4rem 0 0; }
  label.check { display: flex; gap: .5rem; align-items: flex-start; font-weight: 400; color: #666; }
  label.check input { width: auto; margin-top: .3rem; }
  button.link { background: none; color: #2f6feb; width: auto; padding: 0; margin-top: .6rem;
         font-weight: 400; font-size: .85rem; text-decoration: underline; }
  details { margin-top: 1.5rem; font-size: .87rem; color: #777; }
  details.fallback { border-top: 1px solid #ddd; margin-top: 2rem; padding-top: 1.2rem; }
  summary { cursor: pointer; }
  section { border-top: 1px solid #ddd; margin-top: 2rem; padding-top: 1.5rem; }
  section.first { border-top: 0; margin-top: 1rem; padding-top: 0; }
  code, kbd { font-family: ui-monospace, monospace; font-size: .85em; }
  @media (prefers-color-scheme: dark) {
    .error { background: #3b1c1a; color: #f2b8b3; }
    .success { background: #16301f; color: #a7d8b8; }
    .verdict.ok { color: #a7d8b8; }
    .verdict.bad { color: #f2b8b3; }
    section, .note, details.fallback { border-color: #333; }
  }
</style>
</head>
<body>
  <h1>Learn session</h1>
  ${banner}
  ${body}
</body>
</html>`;
}
