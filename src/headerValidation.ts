/**
 * Header/body cross-validation for MCP 2026-07-28.
 *
 * That revision mirrors selected JSON-RPC body fields into HTTP headers (`Mcp-Method`,
 * `Mcp-Name`, `Mcp-Param-*`) so intermediaries can route without parsing the body. It then
 * requires servers to reject any request where a header disagrees with the body, with HTTP 400
 * and JSON-RPC error `-32020` (`HeaderMismatch`).
 *
 * This is a real security control, not bookkeeping: without it a load balancer can route on
 * `Mcp-Name: safe_tool` while the server executes `dangerous_tool` from the body, so any
 * policy an intermediary enforces (routing, rate limiting, tenant isolation, audit) can be
 * bypassed by lying in one of the two places.
 *
 * SDK v2.0.0 parses these headers but does not enforce the comparison — verified against the
 * running server, where both a mismatched `Mcp-Name` and a mismatched `Mcp-Method` executed
 * the body's tool with HTTP 200. This middleware supplies the missing check and can be deleted
 * once the SDK enforces it upstream.
 */

import type { Request, Response, NextFunction } from "express";

/** JSON-RPC error code reserved by the MCP spec for header/body disagreement. */
const HEADER_MISMATCH = -32020;

/** Decodes the `=?base64?…?=` sentinel the spec defines for header-unsafe values. */
function decodeHeaderValue(raw: string): string {
  if (raw.startsWith("=?base64?") && raw.endsWith("?=")) {
    const encoded = raw.slice("=?base64?".length, -"?=".length);
    try {
      return Buffer.from(encoded, "base64").toString("utf8");
    } catch {
      return raw;
    }
  }
  return raw;
}

function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return first === undefined ? undefined : decodeHeaderValue(first);
}

/** Methods whose `Mcp-Name` mirrors a body field, and which body field it mirrors. */
const NAME_SOURCE: Record<string, "name" | "uri"> = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
};

/**
 * Rejects requests whose mirrored headers contradict the JSON-RPC body.
 *
 * Only applies to protocol revisions that define the headers (2026-07-28 and later); older
 * clients never send them and must not be failed for their absence. Requires a parsed body, so
 * mount it after the JSON body parser.
 */
export function validateMirroredHeaders(minimumVersion = "2026-07-28") {
  return function headerValidationMiddleware(req: Request, res: Response, next: NextFunction): void {
    const protocolVersion = headerValue(req, "mcp-protocol-version");
    // Date-shaped revisions compare correctly as strings.
    if (!protocolVersion || protocolVersion < minimumVersion) {
      next();
      return;
    }

    const body = req.body as { method?: unknown; params?: Record<string, unknown> } | undefined;
    // Notifications and malformed bodies are the transport's problem, not ours.
    if (!body || typeof body.method !== "string") {
      next();
      return;
    }

    const reject = (message: string): void => {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: HEADER_MISMATCH, message },
        id: (req.body as { id?: unknown })?.id ?? null,
      });
    };

    const methodHeader = headerValue(req, "mcp-method");
    if (methodHeader === undefined) {
      reject("Header mismatch: Mcp-Method header is required.");
      return;
    }
    if (methodHeader !== body.method) {
      reject(
        `Header mismatch: Mcp-Method header value '${methodHeader}' does not match body value '${body.method}'.`,
      );
      return;
    }

    const nameField = NAME_SOURCE[body.method];
    if (nameField) {
      const expected = body.params?.[nameField];
      const nameHeader = headerValue(req, "mcp-name");
      if (nameHeader === undefined) {
        reject(`Header mismatch: Mcp-Name header is required for ${body.method}.`);
        return;
      }
      if (typeof expected === "string" && nameHeader !== expected) {
        reject(
          `Header mismatch: Mcp-Name header value '${nameHeader}' does not match body value '${expected}'.`,
        );
        return;
      }
    }

    // Mcp-Param-* headers mirror tool arguments annotated with `x-mcp-header`. We do not yet
    // publish any such annotation, so any Mcp-Param-* header is unexpected by definition;
    // per the spec, values must still match the body when present.
    const args = body.params?.["arguments"];
    if (body.method === "tools/call" && args && typeof args === "object") {
      for (const [header, raw] of Object.entries(req.headers)) {
        if (!header.toLowerCase().startsWith("mcp-param-")) continue;
        const paramName = header.slice("mcp-param-".length);
        const record = args as Record<string, unknown>;
        const match = Object.keys(record).find((k) => k.toLowerCase() === paramName.toLowerCase());
        if (match === undefined) continue;

        const provided = decodeHeaderValue(Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? ""));
        const actual = record[match];
        // Numbers compare numerically so that `42` and `42.0` agree, per the spec's note.
        const equal =
          typeof actual === "number"
            ? Number(provided) === actual
            : provided === String(actual);
        if (!equal) {
          reject(
            `Header mismatch: ${header} header value '${provided}' does not match body value '${String(actual)}'.`,
          );
          return;
        }
      }
    }

    next();
  };
}
