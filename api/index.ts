/**
 * Vercel entry point.
 *
 * `vercel.json` rewrites every path here, and the Express app does its own routing — so this
 * file is a genuine adapter, not a second implementation. Swapping to Render, Railway, Fly, or a
 * plain VPS means using `src/index.ts` instead and deleting nothing.
 *
 * The stateless transport is what makes serverless viable: no session store, no instance
 * affinity, each invocation self-contained.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "../src/app.js";
import { loadConfig, SERVER_NAME, VERSION } from "../src/config.js";

const result = loadConfig(process.env);

// Built once per warm instance rather than per request.
const app = result.ok ? createApp(result.config) : null;

if (!result.ok) {
  console.error(`[${SERVER_NAME} v${VERSION}] not configured:`);
  for (const problem of result.problems) console.error(`  • ${problem}`);
}

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  if (!app) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(
      [
        `${SERVER_NAME} MCP server v${VERSION} — NOT CONFIGURED`,
        "",
        ...(result.ok ? [] : result.problems.map((p) => `  • ${p}`)),
      ].join("\n"),
    );
    return;
  }

  // Express is itself a (req, res) handler, so it can be invoked directly.
  app(req as never, res as never);
}
