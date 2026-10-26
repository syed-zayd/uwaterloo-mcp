/**
 * Local entry point — runs the server as a long-lived process.
 *
 * Transport only: everything the server actually does lives in `app.ts`, which this shares
 * verbatim with the serverless adapter in `api/index.ts`. Nothing here is imported by any
 * hosting platform.
 */

import { appendFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { loadEnvFile } from "node:process";
import { createApp } from "./app.js";
import { loadConfig, SERVER_NAME, VERSION, type Config } from "./config.js";
import { startKeepAliveRunner } from "./keepAlive.js";

for (const envFile of [".env.local", ".env"]) {
  if (existsSync(envFile)) loadEnvFile(envFile);
}

if (!process.env.MCP_AUTH_TOKEN && process.env.MCP_ALLOW_UNAUTHENTICATED !== "true") {
  const generated = randomBytes(32).toString("base64url");
  process.env.MCP_AUTH_TOKEN = generated;
  try {
    appendFileSync(".env", `\nMCP_AUTH_TOKEN="${generated}"\n`, "utf8");
    console.log(`[${SERVER_NAME}] generated server token and saved to .env: ${generated}`);
  } catch {
    console.log(`[${SERVER_NAME}] generated in-memory server token: ${generated}`);
  }
}

const result = loadConfig(process.env);
if (!result.ok) {
  console.error(`[${SERVER_NAME} v${VERSION}] refusing to start:`);
  for (const problem of result.problems) console.error(`  • ${problem}`);
  process.exit(1);
}
const config: Config = result.config;
for (const warning of result.warnings) console.warn(`[${SERVER_NAME}] WARNING: ${warning}`);

const app = createApp(config);
const stopKeepAlive = startKeepAliveRunner(config);

const httpServer = app.listen(config.port, config.host, () => {
  console.log(`[${SERVER_NAME} v${VERSION}] listening on http://${config.host}:${config.port}`);
  console.log(`[${SERVER_NAME}] MCP endpoint: http://${config.host}:${config.port}/mcp`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[${SERVER_NAME}] ${signal} received, shutting down.`);
    stopKeepAlive();
    httpServer.close(() => process.exit(0));
  });
}
