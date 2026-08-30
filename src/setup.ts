/**
 * The Learn session page — the only place a UWaterloo session is established.
 *
 * Every other secret is deploy-time configuration that never changes. A Brightspace session is
 * the exception: it expires, and renewing it means passing Duo, which needs a person with a
 * browser. Deliberately no MCP tool can do this. A tool call runs under a client timeout, has to
 * relay a Duo code through whatever the client chooses to render, and dies with its response —
 * a browser tab has none of those limits, so the assistant's whole job is to send someone here.
 *
 * Nothing here writes to the hosting environment. A session applies to the running server
 * immediately and is lost on restart; the page says so, and says where to put D2L_COOKIE to
 * make it stick.
 */

import { timingSafeEqual } from "node:crypto";

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
  /** Whether UWATERLOO_USERNAME and UWATERLOO_PASSWORD are configured, enabling the Duo flow. */
  waterlooConfigured: boolean;
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

export function setupPage(state: PageState): string {
  const banner = state.message
    ? `<div class="${state.message.kind}">${escapeHtml(state.message.text)}</div>`
    : "";
  const token = escapeHtml(state.tokenEcho ?? "");

  const signIn = state.waterlooConfigured
    ? `<section>
         <h2>Sign in with UWaterloo</h2>
         <p>Uses the WatIAM credentials already configured on this server. The next page shows
           UWaterloo's three-digit Duo code — enter it in Duo Mobile and it finishes on its own.</p>
         <form method="POST">
           <input type="hidden" name="token" value="${token}">
           <input type="hidden" name="action" value="waterloo">
           <button type="submit">Sign in with UWaterloo and Duo</button>
         </form>
       </section>`
    : `<section>
         <h2>Sign in with UWaterloo</h2>
         <p>Unavailable — this server has no WatIAM credentials. Set
           <code>UWATERLOO_USERNAME</code> and <code>UWATERLOO_PASSWORD</code> in its environment
           to enable it, or paste a cookie below.</p>
       </section>`;

  const body = !state.authenticated
    ? `<p>Enter this server's access token to continue.</p>
       <form method="POST">
         <label for="token">Server access token</label>
         <input id="token" name="token" type="password" autocomplete="off" autofocus required>
         <button type="submit">Continue</button>
       </form>`
    : `${renderSession(state.session, token)}
       ${signIn}
       <section>
         <h2>Or paste a session cookie</h2>
         <p>The fallback for when the automated sign-in cannot run — a headless browser is not
           available on every host, and UWaterloo's login page changes from time to time.</p>
         <form method="POST">
           <input type="hidden" name="token" value="${token}">
           <input type="hidden" name="action" value="cookie">
           <label for="cookie">Cookie header</label>
           <textarea id="cookie" name="cookie" rows="4" placeholder="d2lSessionVal=…; d2lSecureSessionVal=…" required></textarea>
           <button type="submit">Use this session</button>
         </form>
         <details>
           <summary>Where do I find this?</summary>
           <ol>
             <li>Open <code>learn.uwaterloo.ca</code> and sign in.</li>
             <li>Press <kbd>F12</kbd>, open the <b>Network</b> tab, reload the page.</li>
             <li>Click any request to <code>learn.uwaterloo.ca</code>.</li>
             <li>Under <b>Request Headers</b>, copy the whole <code>Cookie:</code> value.</li>
           </ol>
         </details>
         <p class="note">A session established here is held by the running server and is lost
           when it restarts. To keep one across restarts, set <code>D2L_COOKIE</code> in your
           host's environment — on Vercel that is <b>Project → Settings → Environment
           Variables</b>, followed by a redeploy.</p>
       </section>`;

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
  details { margin-top: 1.5rem; font-size: .87rem; color: #777; }
  section { border-top: 1px solid #ddd; margin-top: 2rem; padding-top: 1.5rem; }
  section.first { border-top: 0; margin-top: 1rem; padding-top: 0; }
  code, kbd { font-family: ui-monospace, monospace; font-size: .85em; }
  @media (prefers-color-scheme: dark) {
    .error { background: #3b1c1a; color: #f2b8b3; }
    .success { background: #16301f; color: #a7d8b8; }
    .verdict.ok { color: #a7d8b8; }
    .verdict.bad { color: #f2b8b3; }
    section, .note { border-color: #333; }
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
