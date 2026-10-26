/**
 * Streamlined setup and management dashboard for UWaterloo Learn and Piazza.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { StoreKind } from "./sessionStore.js";

export const SETUP_COOKIE = "uwmcp_setup";
export const SETUP_COOKIE_MAX_AGE_SECONDS = 120 * 24 * 60 * 60;

export function setupCookieValue(authToken: string): string {
  return createHmac("sha256", authToken).update("uwaterloo-mcp setup device v1").digest("base64url");
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

export const D2L_IDLE_WINDOW_MS = 180 * 60_000;

export function validateCookie(raw: string): { ok: true; cookie: string } | { ok: false; error: string } {
  const cookie = raw.trim().replace(/^Cookie:\s*/i, "");
  if (!cookie) return { ok: false, error: "Paste the Cookie header value." };

  const names = cookie.split(";").map((p) => p.trim().split("=")[0]);
  for (const required of ["d2lSessionVal", "d2lSecureSessionVal"]) {
    if (!names.includes(required)) {
      return {
        ok: false,
        error: `Invalid Brightspace session — ${required} missing. Copy the Cookie header from a learn.uwaterloo.ca request.`,
      };
    }
  }
  return { ok: true, cookie };
}

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
  who?: string | undefined;
  reason?: string | undefined;
  idleExpiresAt?: string | undefined;
}

export interface PageState {
  authenticated: boolean;
  knownUsername: string | null;
  loginSaved: boolean;
  store: StoreKind;
  session?: SessionSnapshot | undefined;
  piazzaConfigured: boolean;
  piazzaEmail?: string | undefined;
  serverUrl?: string | undefined;
  authToken?: string | undefined;
  keepAliveEnabled?: boolean | undefined;
  lastPingAt?: number | undefined;
  message?: { kind: "error" | "success"; text: string } | undefined;
  tokenEcho?: string | undefined;
}

const KEEP_ALIVE_INTERVAL_MS = 45 * 60_000;

function formatLastPing(ms?: number): string {
  if (!ms) return "Never";
  const diffSec = Math.floor((Date.now() - ms) / 1000);
  if (diffSec < 60) return "Just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ${diffMin % 60}m ago`;
  return new Date(ms).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatNextPing(ms?: number): string {
  const base = ms || Date.now();
  const next = base + KEEP_ALIVE_INTERVAL_MS;
  const remaining = next - Date.now();
  if (remaining <= 0) return "Due now";
  const min = Math.round(remaining / 60_000);
  return `in ~${min}m`;
}

export function setupPage(state: PageState): string {
  const banner = state.message
    ? `<div class="banner ${state.message.kind}">${escapeHtml(state.message.text)}</div>`
    : "";
  const token = escapeHtml(state.tokenEcho ?? "");
  const serverUrl = state.serverUrl || "http://localhost:8787/mcp";
  const authToken = state.authToken || "";

  if (!state.authenticated) {
    return layout(`
      <h1>UWaterloo MCP</h1>
      <p class="sub">Enter the server token to manage this instance.</p>
      ${banner}
      <form method="POST" class="card">
        <label for="token">Server Access Token</label>
        <input id="token" name="token" type="password" autocomplete="off" autofocus required>
        <p class="hint">This device will be remembered automatically after signing in.</p>
        <button type="submit">Continue</button>
      </form>
    `);
  }

  const learnActive = state.session?.alive;
  const learnUser = state.session?.who;
  const learnExpires = state.session?.idleExpiresAt
    ? new Date(state.session.idleExpiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : null;

  const claudeDesktopConfig = JSON.stringify(
    {
      mcpServers: {
        uwaterloo: {
          url: serverUrl,
          headers: { Authorization: `Bearer ${authToken}` },
        },
      },
    },
    null,
    2,
  );

  return layout(`
    <header>
      <h1>UWaterloo MCP</h1>
      <p class="sub">Manage Learn and Piazza integrations for Claude and ChatGPT.</p>
    </header>

    ${banner}

    <div class="status-pills">
      <div class="pill ${learnActive ? "ok" : "warn"}">
        <span class="dot"></span>
        Learn: <strong>${learnActive ? `Active (${escapeHtml(learnUser ?? "")})` : "Not signed in"}</strong>
      </div>
      <div class="pill ${state.piazzaConfigured ? "ok" : "off"}">
        <span class="dot"></span>
        Piazza: <strong>${state.piazzaConfigured ? `Connected (${escapeHtml(state.piazzaEmail ?? "")})` : "Not configured"}</strong>
      </div>
    </div>

    <!-- 1. Learn Section -->
    <div class="card">
      <h2>Waterloo Learn</h2>
      ${
        learnActive
          ? `
        <p class="desc">Signed in as <strong>${escapeHtml(learnUser ?? "")}</strong>. Session active until ~<strong>${escapeHtml(learnExpires ?? "")}</strong>.</p>
        
        <div class="keep-alive-panel">
          <div class="keep-alive-row">
            <div>
              <span class="panel-title">Keep Signed In</span>
              <span class="sub-desc">Auto-pings Learn every 45 min to prevent session expiration.</span>
            </div>
            <form method="POST" style="margin:0">
              <input type="hidden" name="token" value="${token}">
              <input type="hidden" name="action" value="toggle_keep_alive">
              <input type="hidden" name="enabled" value="${state.keepAliveEnabled ? "0" : "1"}">
              <button type="submit" class="${state.keepAliveEnabled ? "pill-btn active" : "pill-btn"}">
                ${state.keepAliveEnabled ? "Active" : "Disabled"}
              </button>
            </form>
          </div>
          ${
            state.keepAliveEnabled
              ? `
          <div class="ping-meta">
            <span>Last ping: <strong>${escapeHtml(formatLastPing(state.lastPingAt))}</strong></span>
            <span class="sep">•</span>
            <span>Next ping: <strong>${escapeHtml(formatNextPing(state.lastPingAt))}</strong></span>
            <form method="POST" style="display:inline;margin:0 0 0 auto">
              <input type="hidden" name="token" value="${token}">
              <input type="hidden" name="action" value="ping_now">
              <button type="submit" class="tiny-btn">Ping Now</button>
            </form>
          </div>
          <script>
            setInterval(() => {
              fetch("/api/keep-alive", { credentials: "same-origin" })
                .then((r) => { if (r.ok) location.reload(); })
                .catch(() => {});
            }, 45 * 60 * 1000);
          </script>`
              : ""
          }
        </div>

        <div class="button-row" style="margin-top:1rem">
          <form method="POST" style="display:inline">
            <input type="hidden" name="token" value="${token}">
            <input type="hidden" name="action" value="check">
            <button type="submit" class="secondary">Refresh Status</button>
          </form>
          ${
            state.knownUsername
              ? `
          <form method="POST" style="display:inline">
            <input type="hidden" name="token" value="${token}">
            <input type="hidden" name="action" value="waterloo">
            <button type="submit" class="secondary">Re-authenticate (${escapeHtml(state.knownUsername)})</button>
          </form>`
              : ""
          }
          ${
            state.loginSaved
              ? `
          <form method="POST" style="display:inline">
            <input type="hidden" name="token" value="${token}">
            <input type="hidden" name="action" value="forget">
            <button type="submit" class="text-btn">Forget Login</button>
          </form>`
              : ""
          }
        </div>
      `
          : state.knownUsername
            ? `
        <p class="desc">Ready to sign in as <strong>${escapeHtml(state.knownUsername)}</strong> using saved credentials.</p>
        <form method="POST">
          <input type="hidden" name="token" value="${token}">
          <input type="hidden" name="action" value="waterloo">
          <button type="submit">Sign in with Duo</button>
        </form>
        ${
          state.loginSaved
            ? `
        <form method="POST" style="margin-top:.5rem">
          <input type="hidden" name="token" value="${token}">
          <input type="hidden" name="action" value="forget">
          <button type="submit" class="text-btn">Use different WatIAM account</button>
        </form>`
            : ""
        }
      `
            : `
        <p class="desc">Enter your WatIAM login. The next screen displays the 3-digit Duo code to enter in Duo Mobile.</p>
        <form method="POST">
          <input type="hidden" name="token" value="${token}">
          <input type="hidden" name="action" value="waterloo">
          <label for="username">WatIAM Username</label>
          <input id="username" name="username" type="text" placeholder="jw25smit@uwaterloo.ca" autocomplete="username" required>
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required>
          <label class="check">
            <input type="checkbox" name="remember" value="1" checked> Remember credentials securely on this server
          </label>
          <button type="submit">Sign in with Duo</button>
        </form>
      `
      }

      <details class="fallback">
        <summary>Or paste session cookie</summary>
        <form method="POST" style="margin-top:.8rem">
          <input type="hidden" name="token" value="${token}">
          <input type="hidden" name="action" value="cookie">
          <textarea name="cookie" rows="3" placeholder="d2lSessionVal=...; d2lSecureSessionVal=..." required></textarea>
          <button type="submit" class="secondary" style="margin-top:.5rem">Save Cookie</button>
        </form>
      </details>
    </div>

    <!-- 2. Piazza Section -->
    <div class="card">
      <h2>Piazza</h2>
      ${
        state.piazzaConfigured
          ? `
        <p class="desc">Connected as <strong>${escapeHtml(state.piazzaEmail ?? "")}</strong>. Piazza tools are active.</p>
        <form method="POST">
          <input type="hidden" name="token" value="${token}">
          <input type="hidden" name="action" value="piazza_disconnect">
          <button type="submit" class="secondary">Disconnect / Change Account</button>
        </form>
      `
          : `
        <p class="desc">Optional: add Piazza to search class posts, instructor announcements, and student questions.</p>
        <form method="POST">
          <input type="hidden" name="token" value="${token}">
          <input type="hidden" name="action" value="piazza">
          <label for="pemail">Piazza Email</label>
          <input id="pemail" name="email" type="email" placeholder="name@uwaterloo.ca" required>
          <label for="ppass">Piazza Password</label>
          <input id="ppass" name="password" type="password" required>
          <button type="submit" class="secondary" style="margin-top:1rem">Connect Piazza</button>
        </form>
      `
      }
    </div>

    <!-- 3. Connect Assistant -->
    <div class="card">
      <h2>Connect to Claude / ChatGPT</h2>
      <p class="desc">Use these credentials to connect any AI client to your server.</p>

      <div class="field-copy">
        <label>MCP Endpoint URL</label>
        <div class="input-with-copy">
          <input type="text" readonly value="${escapeHtml(serverUrl)}" id="mcp-url">
          <button type="button" class="copy-btn" onclick="copyText('mcp-url', this)">Copy</button>
        </div>
      </div>

      <div class="field-copy">
        <label>Authorization Token</label>
        <div class="input-with-copy">
          <input type="password" readonly value="${escapeHtml(authToken)}" id="mcp-token">
          <button type="button" class="copy-btn" onclick="copyText('mcp-token', this)">Copy</button>
        </div>
      </div>

      <div class="client-tabs">
        <details>
          <summary><b>Claude Desktop</b> (claude_desktop_config.json)</summary>
          <div class="code-box">
            <pre id="claude-json">${escapeHtml(claudeDesktopConfig)}</pre>
            <button type="button" class="copy-btn" onclick="copyText('claude-json', this)">Copy JSON</button>
          </div>
        </details>
        <details>
          <summary><b>Claude Code CLI</b> (Terminal)</summary>
          <div class="code-box">
            <pre id="claude-cli">claude mcp add uwaterloo ${serverUrl} --header "Authorization: Bearer ${authToken}"</pre>
            <button type="button" class="copy-btn" onclick="copyText('claude-cli', this)">Copy Command</button>
          </div>
        </details>
        <details>
          <summary><b>ChatGPT</b> (Developer Mode)</summary>
          <p class="hint" style="margin:.5rem 0 0">In ChatGPT: <b>Settings &gt; Developer mode &gt; Add MCP Server</b>. Paste the <b>Endpoint URL</b> above, select <b>Bearer Token</b>, and paste your token.</p>
        </details>
        <details>
          <summary><b>Web Clients</b> (Claude.ai / ChatGPT Web)</summary>
          <p class="hint" style="margin:.5rem 0 0">Web browsers require a public HTTPS URL. When running locally or on Docker, expose with a tunnel:<br>
          <code style="display:inline-block;margin:.3rem 0;padding:.2rem .4rem;background:var(--border);border-radius:4px;font-size:.85rem">cloudflared tunnel --url http://localhost:8787</code><br>
          Then connect in your browser using the generated HTTPS URL and Bearer token.</p>
        </details>
      </div>
    </div>
  `);
}

function layout(content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UWaterloo MCP — Setup</title>
<style>
  :root {
    --bg: #f8fafc; --card: #ffffff; --text: #0f172a; --muted: #64748b;
    --border: #e2e8f0; --primary: #2563eb; --primary-hover: #1d4ed8;
    --success: #15803d; --success-bg: #f0fdf4; --warn: #b45309; --warn-bg: #fffbeb;
    --err: #b91c1c; --err-bg: #fef2f2;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0f19; --card: #151d2f; --text: #f8fafc; --muted: #94a3b8;
      --border: #222f47; --primary: #3b82f6; --primary-hover: #2563eb;
      --success: #4ade80; --success-bg: #064e3b33; --warn: #fbbf24; --warn-bg: #78350f33;
      --err: #f87171; --err-bg: #7f1d1d33;
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text); line-height: 1.5;
    max-width: 38rem; margin: 5vh auto; padding: 0 1.25rem 4rem;
  }
  header { margin-bottom: 1.5rem; }
  h1 { font-size: 1.5rem; font-weight: 700; }
  h2 { font-size: 1.15rem; font-weight: 600; margin-bottom: .25rem; }
  p.sub { color: var(--muted); font-size: .95rem; margin-top: .15rem; }
  p.desc { color: var(--muted); font-size: .9rem; margin-bottom: 1rem; }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: .75rem;
    padding: 1.25rem 1.4rem; margin-bottom: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,.04);
  }
  .status-pills { display: flex; gap: .75rem; margin-bottom: 1.25rem; flex-wrap: wrap; }
  .pill {
    display: inline-flex; align-items: center; gap: .45rem; padding: .4rem .75rem;
    border-radius: 9999px; font-size: .85rem; border: 1px solid var(--border); background: var(--card);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #94a3b8; }
  .pill.ok .dot { background: var(--success); }
  .pill.warn .dot { background: var(--warn); }
  .banner { padding: .75rem 1rem; border-radius: .5rem; font-size: .9rem; margin-bottom: 1.25rem; }
  .banner.success { background: var(--success-bg); color: var(--success); border: 1px solid var(--success); }
  .banner.error { background: var(--err-bg); color: var(--err); border: 1px solid var(--err); }
  label { display: block; font-size: .85rem; font-weight: 600; margin: .85rem 0 .3rem; }
  label:first-child { margin-top: 0; }
  input[type="text"], input[type="password"], input[type="email"], input:not([type]), textarea {
    width: 100%; padding: .55rem .75rem; font-size: .92rem; border-radius: .4rem;
    border: 1px solid var(--border); background: transparent; color: inherit; font-family: inherit;
  }
  input:focus, textarea:focus { outline: 2px solid var(--primary); border-color: transparent; }
  label.check {
    display: flex; gap: .5rem; align-items: center; font-size: .85rem; font-weight: 400;
    color: var(--muted); margin: .85rem 0 .4rem; cursor: pointer;
  }
  label.check input { width: auto; }
  button {
    display: inline-flex; align-items: center; justify-content: center;
    padding: .6rem 1.1rem; border-radius: .4rem; font-size: .92rem; font-weight: 600;
    background: var(--primary); color: #fff; border: 0; cursor: pointer; transition: background .15s;
    width: 100%; margin-top: .9rem;
  }
  button:hover { background: var(--primary-hover); }
  button.secondary {
    background: transparent; border: 1px solid var(--border); color: var(--text);
    width: auto; padding: .45rem .85rem; font-size: .85rem; margin-top: 0;
  }
  button.secondary:hover { background: var(--border); }
  button.text-btn {
    background: transparent; border: 0; color: var(--primary); width: auto;
    padding: 0; font-size: .85rem; font-weight: 400; text-decoration: underline; margin-top: .6rem;
  }
  .button-row { display: flex; gap: .6rem; flex-wrap: wrap; align-items: center; margin-top: .5rem; }
  .fallback { margin-top: 1.25rem; border-top: 1px dashed var(--border); padding-top: .9rem; font-size: .88rem; }
  summary { cursor: pointer; color: var(--muted); font-size: .88rem; }
  summary:hover { color: var(--text); }
  .field-copy { margin-top: .8rem; }
  .keep-alive-panel {
    background: var(--bg); border: 1px solid var(--border); border-radius: .5rem;
    padding: .85rem 1rem; margin-top: .85rem;
  }
  .keep-alive-row {
    display: flex; justify-content: space-between; align-items: center; gap: 1rem;
  }
  .panel-title { font-size: .88rem; font-weight: 600; display: block; }
  .sub-desc { font-size: .8rem; color: var(--muted); display: block; margin-top: .1rem; }
  .pill-btn {
    padding: .35rem .75rem; font-size: .8rem; border-radius: 9999px; width: auto;
    border: 1px solid var(--border); background: var(--card); color: var(--muted);
    cursor: pointer; font-weight: 600; transition: all .15s ease; margin-top: 0;
  }
  .pill-btn.active {
    background: var(--success-bg); color: var(--success); border-color: var(--success);
  }
  .pill-btn:hover { border-color: var(--primary); }
  .ping-meta {
    display: flex; align-items: center; gap: .6rem; margin-top: .6rem;
    padding-top: .6rem; border-top: 1px solid var(--border);
    font-size: .8rem; color: var(--muted); flex-wrap: wrap;
  }
  .ping-meta strong { color: var(--text); }
  .sep { color: var(--border); }
  .tiny-btn {
    padding: .2rem .55rem; font-size: .75rem; border-radius: .3rem; width: auto;
    border: 1px solid var(--border); background: var(--card); color: var(--text);
    cursor: pointer; margin-top: 0;
  }
  .tiny-btn:hover { border-color: var(--primary); color: var(--primary); }
  .input-with-copy { display: flex; gap: .4rem; align-items: center; }
  .input-with-copy input { flex: 1; }
  .copy-btn {
    width: auto; margin-top: 0; padding: .5rem .85rem; font-size: .82rem; font-weight: 600;
    background: var(--card); border: 1px solid var(--border); color: var(--text); white-space: nowrap;
  }
  .copy-btn:hover { background: var(--border); }
  .client-tabs { margin-top: 1.25rem; border-top: 1px solid var(--border); padding-top: .75rem; }
  .client-tabs details { margin-top: .6rem; }
  .code-box { position: relative; margin-top: .4rem; }
  pre {
    background: var(--border); padding: .75rem; border-radius: .4rem;
    font-size: .8rem; font-family: ui-monospace, monospace; overflow-x: auto;
  }
  .code-box button { position: absolute; top: .4rem; right: .4rem; margin: 0; padding: .25rem .5rem; font-size: .75rem; }
  .hint { font-size: .8rem; color: var(--muted); }
</style>
<script>
function copyText(elemId, btn) {
  const el = document.getElementById(elemId);
  const text = el.value !== undefined ? el.value : el.innerText;
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.innerText;
    btn.innerText = "Copied!";
    setTimeout(() => { btn.innerText = orig; }, 2000);
  });
}
</script>
</head>
<body>
  ${content}
</body>
</html>`;
}
