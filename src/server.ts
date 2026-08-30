/**
 * Builds the MCP server.
 *
 * Nothing transport- or platform-specific belongs here: this module is what an stdio entry
 * point, an HTTP entry point, or a test harness all share.
 */

import {
  McpServer,
  SUPPORTED_PROTOCOL_VERSIONS as SDK_DEFAULT_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/server";
import { CURRENT_PROTOCOL_VERSION, SERVER_NAME, VERSION, type Config } from "./config.js";
import { registerLearnTools } from "./learnTools.js";
import { PIAZZA_TOOL_NAMES, registerPiazzaTools } from "./piazzaTools.js";

/**
 * Protocol revisions this server accepts.
 *
 * `2026-07-28` is the current spec revision. SDK v2.0.0 implements it — `_meta` envelope
 * validation, `resultType`, and header/body cross-checking are all in the package — but ships
 * with the 2025-era list as its default, so it must be opted into explicitly. The SDK defaults
 * follow it so clients that have not migrated keep working; per the SDK's own docs the legacy
 * `initialize` handshake selects the first 2025-era entry, while 2026-era revisions are
 * reached through `server/discover`.
 *
 * This is set on the server rather than the transport because `connect()` pushes the server's
 * list down to the transport, overwriting anything set there directly.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  CURRENT_PROTOCOL_VERSION,
  ...SDK_DEFAULT_PROTOCOL_VERSIONS.filter((v) => v !== CURRENT_PROTOCOL_VERSION),
];

const INSTRUCTIONS = [
  "Read-only access to the user's UWaterloo Learn and Piazza accounts.",
  "",
  "Learn and Piazza are separate integrations. Use list_courses for Learn and",
  "piazza_list_courses for Piazza; never reuse one service's course identifier in the other.",
  "",
  "For Learn, start with list_courses. Grades, assignments, content, and announcements are",
  "per-course. get_upcoming works across every Learn course at once.",
  "",
  "To inspect or improve submitted work: list_assignments, then get_submissions for every",
  "attempt and its file ids, then get_submission_file for the actual file. Use",
  "get_submission_file_url only when the client says embedded resources are unsupported.",
  "Assignment instructions may also live in get_course_content, so inspect both surfaces.",
  "",
  "Two limits worth stating plainly rather than guessing around. This server sees exactly what",
  "the user sees in the browser: an instructor who has not released a grade or published a page",
  "leaves nothing for it to read. And it authenticates with a browser session that expires — if",
  "a tool says it is not signed in, it names a /setup URL: give that link to the user, then",
  "run the same request again once they say they have signed in.",
  "",
  "For Piazza, start with piazza_list_courses, then piazza_list_folders for exact folder names.",
  "Use piazza_search_posts to find post numbers and piazza_get_posts to read selected threads.",
  "Post numbers are identifiers, not a sequence; never guess them.",
].join("\n");

export function createServer(config: Config): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    {
      instructions: INSTRUCTIONS,
      supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
      // The tool list changes when credentials are added or removed, and a client that cached
      // an old manifest keeps calling tools that no longer match the server. A short TTL is
      // stated explicitly rather than relying on the SDK default.
      cacheHints: { "tools/list": { ttlMs: 60_000, cacheScope: "private" } },
    },
  );

  const piazzaToolNames = config.piazza ? PIAZZA_TOOL_NAMES : [];
  registerLearnTools(server, config, piazzaToolNames);
  if (config.piazza) registerPiazzaTools(server, config.piazza);
  return server;
}
