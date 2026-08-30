/**
 * Builds the unified Express app — MCP over Streamable HTTP, protocol revision 2026-07-28.
 *
 *   POST /mcp                                     → MCP endpoint (bearer token required)
 *   GET  /                                        → plain-text status page
 *   GET  /healthz                                 → liveness probe
 *   GET  /.well-known/oauth-protected-resource    → RFC 9728 metadata
 *
 * Deliberately contains no `listen()` and no reference to any hosting provider: this is the
 * whole server as a plain Express app, so a long-running process (`index.ts`) and a serverless
 * function (`api/index.ts`) can both use it unchanged. Adding a platform means adding one small
 * adapter, never editing this file.
 *
 * Runs in **stateless mode**: a fresh McpServer and transport are built per request and torn
 * down when it completes. Under 2026-07-28 that is the natural shape rather than an
 * optimisation — the revision removed protocol-level sessions and the `initialize` handshake, so
 * every request carries its own protocol version and capabilities and can land on any instance.
 * It is also precisely what makes serverless hosting work without an external session store.
 */

import { createMcpExpressApp, requireBearerAuth } from "@modelcontextprotocol/express";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import express from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Express, NextFunction, Request, Response } from "express";
import { CURRENT_PROTOCOL_VERSION, SERVER_NAME, VERSION, type Config } from "./config.js";
import { createServer, SUPPORTED_PROTOCOL_VERSIONS } from "./server.js";
import { combinedVerifier } from "./auth.js";
import { validateMirroredHeaders } from "./headerValidation.js";
import { D2LClient } from "./d2l/client.js";
import { streamSubmissionFile, streamTopicFile } from "./d2l/files.js";
import { verifyFileToken } from "./fileUrls.js";
import {
  D2L_IDLE_WINDOW_MS,
  setupPage,
  tokenMatches,
  validateCookie,
  type SessionSnapshot,
} from "./setup.js";
import { signInUWaterloo, WaterlooLoginError, type WaterlooLoginEvent } from "./waterlooLogin.js";
import {
  authorizationServerMetadata,
  beginAuthorize,
  completeAuthorize,
  exchangeToken,
  OAUTH_SCOPE,
  protectedResourceMetadata,
  registerClient,
  type AuthorizeParams,
  type AuthorizeResult,
} from "./oauth.js";

function inlineScriptValue(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function beginWaterlooSetupProgress(res: Response): void {
  res.status(200).set({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>UWaterloo sign-in</title><style>
:root{color-scheme:light dark}body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;max-width:34rem;margin:8vh auto;padding:0 1.25rem;line-height:1.55}h1{font-size:1.35rem}.card{border:1px solid #bbb;border-radius:.65rem;padding:1.2rem;margin-top:1.2rem}.code{font:700 3rem/1 ui-monospace,monospace;letter-spacing:.3em;margin:.5rem 0 1rem;color:#1675d1}p{color:#666}.error{color:#b42318}.success{color:#16794b}a{color:#1675d1}
</style></head><body><h1>Signing in to UWaterloo Learn</h1>
<div class="card"><p id="status">Opening UWaterloo and waiting for Duo…</p>
<div id="code-panel" hidden><div class="code" id="duo-code"></div><strong>Enter this code in Duo Mobile now.</strong></div>
<p id="return" hidden><a href="/setup">Return to setup</a></p></div>
<script>
window.waterlooCode=(code,waiting)=>{document.getElementById("duo-code").textContent=code;document.getElementById("code-panel").hidden=false;document.getElementById("status").textContent=waiting?("Still waiting for Duo approval ("+waiting+"s)."):"Duo is waiting for the verification code."};
window.waterlooDone=(kind,message)=>{document.getElementById("code-panel").hidden=true;const status=document.getElementById("status");status.className=kind;status.textContent=message;document.getElementById("return").hidden=false};
</script>`);
}

function writeWaterlooSetupCode(res: Response, event: WaterlooLoginEvent): void {
  // Each write also keeps the streamed response from being buffered shut by an idle proxy.
  const waiting = event.type === "duo_waiting" ? event.secondsWaiting : 0;
  res.write(
    `<script>window.waterlooCode(${inlineScriptValue(event.code)},${waiting})</script>`,
  );
}

function finishWaterlooSetupProgress(
  res: Response,
  kind: "error" | "success",
  message: string,
): void {
  res.end(
    `<script>window.waterlooDone(${inlineScriptValue(kind)},${inlineScriptValue(message)})</script></body></html>`,
  );
}

/** Collects the OAuth authorization parameters from a query string or form body. */
function authorizeParams(source: Record<string, string | undefined>): AuthorizeParams {
  return {
    responseType: source["response_type"] ?? null,
    clientId: source["client_id"] ?? null,
    redirectUri: source["redirect_uri"] ?? null,
    state: source["state"] ?? null,
    codeChallenge: source["code_challenge"] ?? null,
    codeChallengeMethod: source["code_challenge_method"] ?? null,
    scope: source["scope"] ?? null,
    resource: source["resource"] ?? null,
  };
}

/**
 * `/setup` — establish the Learn session.
 *
 * Guarded by the same token that guards `/mcp`: whoever can call the tools can already read
 * every course, so this grants no new access, and it keeps the number of secrets at one.
 *
 * Nothing else is configurable here. The MCP token and the Piazza and WatIAM logins are
 * deploy-time environment variables that never change while the server runs; only a Brightspace
 * session expires on its own, and only it needs a way back in without a redeploy.
 */
function registerSetupRoute(app: Express, config: Config): void {
  const form = express.urlencoded({ extended: false, limit: "16kb" });
  const setupState = () => ({ waterlooConfigured: config.waterloo !== null });

  app.use("/setup", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  /** A live probe, not a cached guess — and the probe itself resets the idle window it reports. */
  const describeSession = async (): Promise<SessionSnapshot> => {
    if (!config.d2l) {
      return { alive: false, reason: "No session has been established on this server yet." };
    }
    const status = await new D2LClient(config.d2l).sessionStatus();
    return status.alive
      ? {
          alive: true,
          who: `${status.user.FirstName} ${status.user.LastName}`,
          idleExpiresAt: new Date(Date.now() + D2L_IDLE_WINDOW_MS).toISOString(),
        }
      : { alive: false, reason: status.reason };
  };

  /** Adopts a cookie only after Brightspace confirms it, so a bad paste cannot break a good session. */
  const adopt = async (cookie: string): Promise<{ ok: true; who: string } | { ok: false; error: string }> => {
    const credentials = { host: config.d2lHost, cookie, csrfToken: undefined };
    const status = await new D2LClient(credentials).sessionStatus();
    if (!status.alive) {
      return {
        ok: false,
        error:
          "Brightspace rejected that session. It may have already expired. The server's " +
          "existing session was left alone.",
      };
    }
    config.d2l = credentials;
    process.env.D2L_COOKIE = cookie;
    return { ok: true, who: `${status.user.FirstName} ${status.user.LastName}` };
  };

  app.get("/setup", (_req, res) => {
    res.type("html").send(setupPage({ ...setupState(), authenticated: false }));
  });

  app.post("/setup", form, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const provided = (body["token"] ?? "").trim();

    if (config.authToken && !tokenMatches(provided, config.authToken)) {
      res.status(401).type("html").send(
        setupPage({
          ...setupState(),
          authenticated: false,
          message: { kind: "error", text: "That token is not correct." },
        }),
      );
      return;
    }

    const action = body["action"];
    // First POST proves identity; the session forms are only shown afterwards. "check" lands
    // here too — re-probing and re-rendering is exactly what it does.
    if (action === undefined || action === "check") {
      res.type("html").send(
        setupPage({
          ...setupState(),
          authenticated: true,
          tokenEcho: provided,
          session: await describeSession(),
        }),
      );
      return;
    }

    if (action === "waterloo") {
      if (!config.waterloo) {
        res.type("html").send(
          setupPage({
            ...setupState(),
            authenticated: true,
            tokenEcho: provided,
            message: {
              kind: "error",
              text:
                "This server has no WatIAM credentials. Set UWATERLOO_USERNAME and " +
                "UWATERLOO_PASSWORD in its environment, or paste a cookie instead.",
            },
          }),
        );
        return;
      }

      // Duo takes as long as it takes, so the response streams: headers and the waiting page
      // go out first, then the three-digit code, then the outcome.
      beginWaterlooSetupProgress(res);
      let login: Awaited<ReturnType<typeof signInUWaterloo>>;
      try {
        login = await signInUWaterloo(
          config.waterloo,
          config.d2lHost,
          undefined,
          (event) => writeWaterlooSetupCode(res, event),
        );
      } catch (error) {
        finishWaterlooSetupProgress(
          res,
          "error",
          error instanceof WaterlooLoginError
            ? error.message
            : "UWaterloo sign-in failed without changing the existing Learn session.",
        );
        return;
      }

      const adopted = await adopt(login.cookie);
      finishWaterlooSetupProgress(
        res,
        adopted.ok ? "success" : "error",
        adopted.ok
          ? `Signed in to UWaterloo Learn as ${adopted.who}. Learn tools work now. This session ` +
              "is held in memory — set D2L_COOKIE in your environment to keep it across restarts."
          : adopted.error,
      );
      return;
    }

    if (action !== "cookie") {
      res.status(400).type("text/plain").send("Unknown setup action.");
      return;
    }

    const validated = validateCookie(body["cookie"] ?? "");
    if (!validated.ok) {
      res.type("html").send(
        setupPage({
          ...setupState(),
          authenticated: true,
          tokenEcho: provided,
          message: { kind: "error", text: validated.error },
        }),
      );
      return;
    }

    const adopted = await adopt(validated.cookie);
    res.type("html").send(
      setupPage({
        ...setupState(),
        authenticated: true,
        tokenEcho: provided,
        message: adopted.ok
          ? {
              kind: "success",
              text:
                `Session accepted — signed in as ${adopted.who}. Learn tools work now. This ` +
                "session is held in memory; set D2L_COOKIE in your environment to keep it " +
                "across restarts.",
            }
          : { kind: "error", text: adopted.error },
        session: await describeSession(),
      }),
    );
  });
}

/**
 * `/file/:token` — serves one course file over plain HTTP.
 *
 * The fallback for clients that cannot accept an embedded resource. Deliberately unauthenticated
 * in the usual sense: the caller is an AI sandbox running `curl`, which has no bearer token. The
 * signed token in the path is the credential — it names one file, expires in minutes, and cannot
 * be altered without invalidating the signature.
 */
function registerFileDownloadRoute(app: Express, config: Config): void {
  app.get("/file/:token", async (req, res) => {
    if (!config.d2l || !config.authToken) {
      res.status(503).type("text/plain").send("This server is not configured to serve files.");
      return;
    }

    const grant = verifyFileToken(req.params.token ?? "", config.authToken);
    if (!grant) {
      res.status(403).type("text/plain").send("This download link is invalid or has expired.");
      return;
    }

    try {
      // A pass-through: the bytes go from D2L to the caller without being buffered or stored
      // here, so a large file costs no more memory than a small one and nothing is retained
      // after the response ends.
      const client = new D2LClient(config.d2l);
      const file =
        grant.kind === "topic"
          ? await streamTopicFile(client, grant.courseId, grant.topicId)
          : await streamSubmissionFile(
              client,
              grant.courseId,
              grant.folderId,
              grant.submissionId,
              grant.fileId,
            );

      // Both filename forms, so a client that understands neither RFC 5987 nor quoting still
      // ends up with a sensible name rather than the token.
      const encoded = encodeURIComponent(file.fileName);
      res.status(200).set({
        "Content-Type": file.mimeType,
        "Content-Disposition": `attachment; filename="${file.fileName.replace(/"/g, "")}"; filename*=UTF-8''${encoded}`,
        // A signed URL is single-purpose and short-lived; caching it anywhere is wrong.
        "Cache-Control": "no-store",
        ...(file.bytes !== null ? { "Content-Length": String(file.bytes) } : {}),
      });

      await pipeline(Readable.fromWeb(file.body as Parameters<typeof Readable.fromWeb>[0]), res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Headers are already sent once streaming has begun; the only honest signal left is to
      // break the connection so the client sees a truncated download rather than a valid file.
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.status(502).type("text/plain").send(`Could not fetch the file from D2L. ${message}`);
    }
  });
}

function sendAuthorizeResult(res: Response, result: AuthorizeResult): void {
  switch (result.kind) {
    case "redirect":
      res.redirect(302, result.location);
      return;
    case "prompt":
      res.type("html").send(result.html);
      return;
    case "error":
      res.status(result.status).type("text/plain").send(result.message);
      return;
  }
}

export function createApp(config: Config): Express {
  /** Base URL used in discovery documents. Falls back to the local bind for dev. */
  const resourceServerUrl = new URL(config.publicUrl ?? `http://localhost:${config.port}`);

  /**
   * Hostnames the DNS-rebinding check will accept.
   *
   * The SDK defaults to localhost-only, which silently breaks every hosted deployment: behind a
   * tunnel or a real domain the `Host` header is the public name, so *all* routes answer
   * `403 Invalid Host` — including the landing page, with no hint as to why. Trusting the
   * hostname the operator already declared in MCP_PUBLIC_URL removes that trap without widening
   * anything: it is the name this server is meant to be reached by.
   *
   * On a platform that assigns the URL for you (Vercel and friends), `trustPlatformHost` skips
   * the check entirely — the platform terminates TLS and routes by hostname, so a forged Host
   * header cannot reach us, and demanding the user configure a name they were given
   * automatically would break one-click deploys.
   */
  const allowedHosts = [
    "localhost",
    "127.0.0.1",
    "[::1]",
    ...(resourceServerUrl.hostname ? [resourceServerUrl.hostname] : []),
    ...config.allowedHosts,
  ];

  // createMcpExpressApp wires up JSON body parsing plus Host/Origin validation. Origin rules
  // stay narrower: browsers send Origin and MCP clients do not, so we widen that list only when
  // the operator explicitly asks.
  // `host` doubles as a policy switch inside createMcpExpressApp: a localhost value turns on
  // automatic Host/Origin validation. Omitting `allowedHosts` therefore does not disable the
  // check, it just falls back to localhost-only — which rejects the platform's own domain. On a
  // managed platform we pass a non-localhost host so no automatic rules are installed at all.
  const app = createMcpExpressApp({
    host: config.trustPlatformHost ? "0.0.0.0" : config.host,
    jsonLimit: "4mb",
    ...(config.trustPlatformHost ? {} : { allowedHosts }),
    ...(config.allowedOrigins.length > 0 ? { allowedOrigins: config.allowedOrigins } : {}),
  });
  app.disable("x-powered-by");
  // Behind a platform proxy, req.protocol must reflect X-Forwarded-Proto so the landing page
  // prints an https:// URL rather than http://.
  if (config.trustProxy) app.set("trust proxy", true);

  app.get("/", (req, res) => {
    const base = config.publicUrl ?? `${req.protocol}://${req.headers.host}`;
    const lines = [
      `${SERVER_NAME} MCP server v${VERSION} — running.`,
      "",
      "To connect this to ChatGPT or Claude, paste these two values:",
      "",
      `  Server URL:  ${base}/mcp`,
    ];

    if (config.authToken === null) {
      lines.push("  Token:       (none — this server is running without authentication)");
    } else {
      lines.push("  Token:       the MCP_AUTH_TOKEN you configured (not shown here)");
    }

    lines.push(
      "",
      `  Setup:       ${base}/setup`,
      "",
      "----",
      "Transport: Streamable HTTP (stateless, MCP 2026-07-28)",
      `Learn:     ${config.d2l ? "configured" : "not configured"}`,
      `Piazza:    ${config.piazza ? "configured" : "not configured"}`,
    );

    res.type("text/plain").send(lines.join("\n"));
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", server: SERVER_NAME, version: VERSION });
  });

  registerSetupRoute(app, config);
  registerFileDownloadRoute(app, config);

  /** Origin this request arrived on — the issuer identity for OAuth documents. */
  const originOf = (req: Request): string =>
    config.publicUrl ?? `${req.protocol}://${req.headers.host}`;

  // Discovery documents are fetched cross-origin by MCP clients, and must never be cached.
  const discovery = (_req: Request, res: Response, next: NextFunction): void => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "no-store");
    next();
  };

  // RFC 9728 Protected Resource Metadata. Clients probe both the bare and resource-suffixed
  // forms, so both are served.
  app.get(
    ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"],
    discovery,
    (req, res) => {
      res.json(protectedResourceMetadata(originOf(req)));
    },
  );

  // RFC 8414 Authorization Server Metadata. Without this, ChatGPT reports that the server
  // "does not implement OAuth" and refuses to add the connector.
  app.get(
    [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/mcp",
      "/.well-known/openid-configuration",
    ],
    discovery,
    (req, res) => {
      res.json(authorizationServerMetadata(originOf(req)));
    },
  );

  if (config.authToken) {
    const staticToken = config.authToken;

    // RFC 7591 dynamic client registration. Deprecated in 2026-07-28 in favour of Client ID
    // Metadata Documents (also supported, in resolveClient) but kept because deployed clients
    // still use it.
    app.post("/register", express.json({ limit: "64kb" }), discovery, (req, res) => {
      const { status, payload } = registerClient(req.body ?? {}, staticToken);
      res.status(status).json(payload);
    });

    app.get("/authorize", async (req, res) => {
      const params = authorizeParams(req.query as Record<string, string | undefined>);
      const result = await beginAuthorize(params, staticToken, originOf(req));
      sendAuthorizeResult(res, result);
    });

    app.post("/authorize", express.urlencoded({ extended: false }), (req, res) => {
      const body = (req.body ?? {}) as Record<string, string | undefined>;
      const params = authorizeParams(body);
      // The deployment token plays two roles here: the value the operator must enter to
      // approve (`expectedToken`), and the HMAC key everything is signed with (`secret`).
      const result = completeAuthorize(
        params,
        body["token"] ?? "",
        /* expectedToken */ staticToken,
        /* secret */ staticToken,
        originOf(req),
        new URL("/mcp", originOf(req)).href,
      );
      sendAuthorizeResult(res, result);
    });

    app.post("/token", express.urlencoded({ extended: false }), discovery, async (req, res) => {
      const form = new URLSearchParams(req.body as Record<string, string>);
      const result = await exchangeToken(form, staticToken, new URL("/mcp", originOf(req)).href);
      if (result.ok) {
        res.json(result.payload);
      } else {
        res.status(result.status).json({ error: result.error, error_description: result.description });
      }
    });
  }

  /** Handles one MCP request with its own server + transport, then disposes of both. */
  async function handleMcp(req: Request, res: Response): Promise<void> {
    const server = createServer(config);
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: never mint or require a session id
      // No tool streams progress any more — signing in happens at /setup, in a browser. SSE
      // stays on regardless: it is the transport the 2026-07-28 revision expects, and turning it
      // off would silently drop any notification a future tool wants to send.
      enableJsonResponse: false,
      supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[${SERVER_NAME}] request failed:`, err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error." },
          id: null,
        });
      }
    }
  }

  // Header/body cross-validation runs after auth (so unauthenticated callers learn nothing
  // about request shape) but before the transport, which does not enforce it in SDK v2.0.0.
  //
  // A dead Learn session is deliberately NOT surfaced as a 401 here. That challenge makes a
  // client re-run this connector's own OAuth, which cannot establish a Brightspace session and
  // leaves the user in a loop. The tools report it instead, naming the /setup URL that can.
  const mcpMiddleware = config.authToken
    ? [
        requireBearerAuth({
          verifier: combinedVerifier(config.authToken, SERVER_NAME, [
            new URL("/mcp", resourceServerUrl).href,
            // The loopback aliases a local deployment is reached by interchangeably.
            ...(config.publicUrl
              ? []
              : [`http://127.0.0.1:${config.port}/mcp`, `http://[::1]:${config.port}/mcp`]),
          ]),
          resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
          requiredScopes: [],
        }),
        validateMirroredHeaders(CURRENT_PROTOCOL_VERSION),
      ]
    : [validateMirroredHeaders(CURRENT_PROTOCOL_VERSION)];

  app.post("/mcp", ...mcpMiddleware, handleMcp);

  // 2026-07-28 removed the GET stream and session teardown. 405 is the documented answer for
  // clients still speaking an older revision.
  for (const method of ["get", "delete"] as const) {
    app[method]("/mcp", (_req, res) => {
      res.status(405).set("Allow", "POST").json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "This server is stateless (MCP 2026-07-28); use POST.",
        },
        id: null,
      });
    });
  }

  return app;
}
