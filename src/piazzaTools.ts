/**
 * Piazza tool definitions for the unified gateway.
 *
 * Four tools, deliberately:
 *
 *   piazza_list_courses  →  which courses exist          (no guessing course names)
 *   piazza_list_folders  →  which folders a course uses  (no hallucinating folder names)
 *   piazza_search_posts  →  find posts, any criteria     (the main endpoint)
 *   piazza_get_posts     →  read specific posts in full  (one number or many)
 *
 * `piazza_search_posts` carries every filter Piazza supports rather than splitting them across tools,
 * because a model choosing between six similar tools picks wrong far more often than it fills in
 * an optional parameter.
 *
 * Both search and read take an `include` list naming the fields to return. Responses are large
 * relative to a context window, so the caller decides what it can afford: titles alone for a
 * sweep of every post, full threads for the handful worth reading.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { PiazzaError, type PiazzaClient } from "./piazza/client.js";
import {
  collectUserIds,
  involvesStaff,
  isByInstructor,
  isPinned,
  needsFullPost,
  POST_FIELDS,
  renderPost,
  renderSummary,
  type PostField,
} from "./piazza/render.js";
import { withSession, type Credentials } from "./piazza/session.js";
import type { PiazzaCourse, PiazzaFeedItem } from "./piazza/types.js";

/** Summaries are a line each, so a whole course fits comfortably. */
const MAX_SUMMARY_LIMIT = 500;
const DEFAULT_SUMMARY_LIMIT = 50;

/**
 * Bounds on reads that fetch whole threads.
 *
 * The real constraint is size, not count — fifteen terse threads are trivial while fifteen long
 * ones are enormous. Threads accumulate until the character budget is spent, then the response
 * reports how many remain and how to continue.
 */
const MAX_FULL_POSTS = 40;
const FULL_CHAR_BUDGET = 180_000;

/** Compact index: enough to decide what is worth reading, nothing more. */
const DEFAULT_SEARCH_FIELDS: PostField[] = [
  "title",
  "author",
  "updated",
  "folders",
  "answer_status",
  "pinned",
];

/** Reading a specific post implies wanting the whole discussion. */
const DEFAULT_READ_FIELDS: PostField[] = [
  "title",
  "author",
  "created",
  "updated",
  "folders",
  "type",
  "views",
  "url",
  "content",
  "instructor_answer",
  "student_answer",
  "followups",
];

type TextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const text = (body: string): TextResult => ({ content: [{ type: "text", text: body }] });

async function withPiazzaSession(
  creds: Credentials,
  run: (client: PiazzaClient) => Promise<TextResult>,
): Promise<TextResult> {
  try {
    return await withSession(creds, run);
  } catch (error) {
    const message =
      error instanceof PiazzaError
        ? `Piazza request failed: ${error.message}`
        : `Piazza request failed: ${error instanceof Error ? error.message : String(error)}`;
    return { ...text(message), isError: true };
  }
}

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

export const PIAZZA_TOOL_NAMES = [
  "piazza_list_courses",
  "piazza_list_folders",
  "piazza_search_posts",
  "piazza_get_posts",
] as const;

const fieldEnum = z.enum(POST_FIELDS);

const includeParam = z
  .array(fieldEnum)
  .optional()
  .describe(
    "Which fields to return. Cheap fields (title, author, created, updated, folders, tags, type, " +
      "views, answer_status, pinned, snippet, url, activity) come from the feed and cost little, " +
      "so hundreds of posts can be listed at once. Deep fields (content, instructor_answer, " +
      "student_answer, followups, previous_version) require fetching each post individually and " +
      "are far larger, so asking for them limits how many posts you get back.",
  );

function courseLabel(course: PiazzaCourse): string {
  return [course.num, course.term].filter(Boolean).join(" · ") || course.id;
}

function termRank(term: string | undefined): number {
  if (!term) return 0;
  const year = Number(term.match(/\d{4}/)?.[0] ?? 0);
  const season = term.toLowerCase();
  const offset = season.includes("winter")
    ? 0
    : season.includes("spring")
      ? 1
      : season.includes("summer")
        ? 2
        : season.includes("fall")
          ? 3
          : 0;
  return year * 10 + offset;
}

/**
 * Courses in the newest term that has actually started.
 *
 * "My courses" means the ones running now, but the API returns every course ever joined, and a
 * student who pre-registers would otherwise get empty future shells.
 */
async function currentCourses(client: PiazzaClient): Promise<PiazzaCourse[]> {
  const courses = await client.getCourses();
  if (courses.length === 0) return [];

  const now = new Date();
  const currentRank = termRank(
    `${["Winter", "Spring", "Summer", "Fall"][Math.floor(now.getMonth() / 3)]} ${now.getFullYear()}`,
  );
  const started = courses.filter((c) => termRank(c.term) > 0 && termRank(c.term) <= currentRank);

  const pool = started.length > 0 ? started : courses;
  const newest = Math.max(...pool.map((c) => termRank(c.term)));
  return pool.filter((c) => termRank(c.term) === newest);
}

/** Accepts an internal id, a course code ("CS 240", "cs240"), or part of the title. */
async function resolveCourse(client: PiazzaClient, ref: string): Promise<PiazzaCourse> {
  const courses = await client.getCourses();
  const exact = courses.find((c) => c.id === ref);
  if (exact) return exact;

  const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/[\s_-]/g, "");
  const target = norm(ref);

  const byCode = courses.find((c) => norm(c.num) === target);
  if (byCode) return byCode;

  const partial = courses.find((c) => norm(c.num).includes(target) || norm(c.name).includes(target));
  if (partial) return partial;

  const current = await currentCourses(client);
  const listing = (current.length > 0 ? current : courses.slice(0, 15))
    .map((c) => `  ${c.num ?? "?"} (${c.term ?? "?"})`)
    .join("\n");
  throw new Error(
    `No course matching "${ref}". ${current.length > 0 ? "Current courses" : "Courses"}:\n${listing}\n` +
      "Call piazza_list_courses for the full list.",
  );
}

async function availableFolders(client: PiazzaClient, nid: string): Promise<string[]> {
  const feed = await client.getFeed(nid, { limit: 1 });
  const names = new Set([
    ...(feed.tags?.popular ?? []),
    ...Object.keys(feed.tags?.popular_count ?? {}),
    ...Object.keys(feed.tags?.instructor_count ?? {}),
  ]);
  return [...names].sort();
}

/**
 * Parse "7d", "24h", "2w", "3m", "today", or a date into a cutoff.
 *
 * Throws rather than falling back on anything it does not understand. Silently substituting a
 * default turns "did the prof post today?" into a seven-day answer, and `new Date("7")` into the
 * year 2001 — both wrong in ways nothing downstream can detect.
 */
function parseDate(value: string, paramName: string): Date {
  const v = value.trim().toLowerCase();
  if (v === "today") return new Date(Date.now() - 86_400_000);
  if (v === "yesterday") return new Date(Date.now() - 2 * 86_400_000);

  const rel = v.match(/^(\d+)\s*([hdwm])$/);
  if (rel) {
    const ms = { h: 3_600_000, d: 86_400_000, w: 604_800_000, m: 2_592_000_000 }[
      rel[2] as "h" | "d" | "w" | "m"
    ];
    return new Date(Date.now() - Number(rel[1]) * ms);
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  throw new Error(
    `Could not understand ${paramName}="${value}". Use a number with h/d/w/m ("24h", "7d", "2w", "3m"), ` +
      `"today", "yesterday", or a date like "2026-07-01".`,
  );
}

function lastActivity(item: PiazzaFeedItem): string {
  return item.modified ?? item.updated ?? item.created ?? "";
}

/**
 * Fetch whole threads within a size budget.
 *
 * A bad post number should not lose the other threads, but an expired session must propagate or
 * `withSession` never gets to re-login and every post fails identically.
 */
async function readThreads(
  client: PiazzaClient,
  course: PiazzaCourse,
  numbers: Array<number | string>,
  fields: readonly PostField[],
): Promise<{ body: string; read: number; truncated: boolean }> {
  const sections = await Promise.all(
    numbers.map(async (raw) => {
      // Accept "@129" as well as 129 — the listing format is what a model copies from.
      const nr = String(raw).replace(/^@/, "").trim();
      try {
        const post = await client.getPost(course.id, nr);
        const users = await client.resolveUsers(course.id, collectUserIds(post));
        return renderPost(post, fields, { courseId: course.id, users });
      } catch (err) {
        // A dead session must propagate so withSession can re-login; a rejected post number
        // should not lose the other threads in the batch.
        if (err instanceof PiazzaError && (err.stage === "session" || err.stage === "csrf")) throw err;
        // Say why this is most likely happening: post numbers are identifiers, not an index,
        // so a number that was guessed rather than looked up usually does not exist.
        return (
          `# @${nr}\nNo such post in ${courseLabel(course)}. Post numbers are identifiers, not ` +
          `sequential positions — use piazza_search_posts to find real ones (shown as @123).`
        );
      }
    }),
  );

  // Spend the budget in order, so what comes back is a prefix of what was asked for.
  const kept: string[] = [];
  let used = 0;
  for (const section of sections) {
    if (kept.length > 0 && used + section.length > FULL_CHAR_BUDGET) break;
    kept.push(section);
    used += section.length;
  }

  return { body: kept.join("\n\n---\n\n"), read: kept.length, truncated: kept.length < sections.length };
}

export function registerPiazzaTools(server: McpServer, creds: Credentials): void {
  // ------------------------------------------------------------------ courses
  server.registerTool(
    "piazza_list_courses",
    {
      title: "List Piazza courses",
      description:
        "List every course this account is enrolled in. Courses from the current term are marked CURRENT — those are what a student means by 'my courses'. Call this first when you do not already know the exact course; do not guess course names. Use the course code (e.g. 'CS 240') for the other tools.",
      inputSchema: {},
      annotations: readOnly,
    },
    async (): Promise<TextResult> =>
      withPiazzaSession(creds, async (client) => {
        const courses = await client.getCourses();
        if (courses.length === 0) return text("No Piazza courses found for this account.");

        const current = new Set((await currentCourses(client)).map((c) => c.id));
        const lines = courses.map((c) => {
          const staff = c.instructors?.map((i) => i.name).filter(Boolean).slice(0, 3).join(", ");
          return (
            `${current.has(c.id) ? "[CURRENT] " : ""}${c.num ?? "(no code)"} · ${c.term ?? "?"} — ${c.name ?? ""}` +
            (staff ? `\n    staff: ${staff}` : "")
          );
        });

        return text(
          `${courses.length} courses:\n\n${lines.join("\n")}\n\n` +
            "Next: piazza_list_folders(course) to see topics, or piazza_search_posts(course) to find posts.",
        );
      }),
  );

  // ------------------------------------------------------------------ folders
  server.registerTool(
    "piazza_list_folders",
    {
      title: "List a course's folders",
      description:
        "List the folders (tags) a course uses, with post counts. Folder names differ between courses — one uses 'exam', another 'exam1'/'exam2', another 'midterm'. Call this before passing `folder` to piazza_search_posts; never guess a folder name.",
      inputSchema: { course: z.string().describe('Course code or id, e.g. "CS 240"') },
      annotations: readOnly,
    },
    async ({ course }): Promise<TextResult> =>
      withPiazzaSession(creds, async (client) => {
        const resolved = await resolveCourse(client, course);
        const feed = await client.getFeed(resolved.id, { limit: 1 });

        const counts = feed.tags?.popular_count ?? {};
        const staffCounts = feed.tags?.instructor_count ?? {};
        const names = new Set([
          ...(feed.tags?.popular ?? []),
          ...Object.keys(counts),
          ...Object.keys(staffCounts),
        ]);
        if (names.size === 0) return text(`${courseLabel(resolved)} — no folders found.`);

        const lines = [...names].sort().map((n) => {
          const bits = [
            counts[n] !== undefined ? `${counts[n]} posts` : "",
            staffCounts[n] ? `${staffCounts[n]} by staff` : "",
          ].filter(Boolean);
          return `  ${n}${bits.length ? ` — ${bits.join(", ")}` : ""}`;
        });

        return text(
          `${courseLabel(resolved)} folders:\n\n${lines.join("\n")}\n\n` +
            "Pass one of these names as the `folder` argument to piazza_search_posts.",
        );
      }),
  );

  // ------------------------------------------------------------------- search
  server.registerTool(
    "piazza_search_posts",
    {
      title: "Find posts in a course",
      description:
        "The main tool for finding posts. Only `course` is required — with nothing else it returns every post in the course, newest first. " +
        "Add `query` for keyword search, `folder` to scope to a topic (get exact names from piazza_list_folders), `type` for questions vs notes vs polls, " +
        "`by_instructors` or `instructor_answered` for staff content, `since`/`until` for a time range, and the status flags for unanswered or unread posts. Filters combine. " +
        "Use `include` to control what comes back: the default is a compact index (title, author, date, folders, answer status) — cheap enough to list every post in a course. " +
        "Add `content`, `instructor_answer`, `student_answer` or `followups` to read posts in the same call, which is much larger and therefore limited to fewer posts. " +
        "A common pattern is to sweep with the default fields, then re-read the relevant post numbers with piazza_get_posts.",
      inputSchema: {
        course: z.string().describe('Course code or id, e.g. "CS 240". Get it from piazza_list_courses.'),
        query: z
          .string()
          .optional()
          .describe("Keyword search. Omit to return all posts matching the other filters."),
        folder: z
          .string()
          .optional()
          .describe("Restrict to one folder. Must be an exact name from piazza_list_folders."),
        type: z
          .enum(["question", "note", "poll"])
          .optional()
          .describe("question = student question; note = announcement; poll = survey."),
        by_instructors: z
          .boolean()
          .optional()
          .describe("Only posts written by a professor or TA (announcements, clarifications)."),
        instructor_answered: z
          .boolean()
          .optional()
          .describe("Only posts that have an instructor answer. Use for confirmed, authoritative answers."),
        unanswered: z.boolean().optional().describe("Only questions with no answer of any kind yet."),
        unread: z.boolean().optional().describe("Only posts you have not read."),
        mine: z.boolean().optional().describe("Only posts you wrote."),
        pinned: z.boolean().optional().describe("Only pinned posts — usually exams and key logistics."),
        open_followups: z
          .boolean()
          .optional()
          .describe("Only posts with follow-up questions nobody has replied to."),
        since: z
          .string()
          .optional()
          .describe('Only posts active on or after this: "24h", "7d", "2w", "3m", "today", or "2026-07-01".'),
        until: z.string().optional().describe("Only posts active on or before this. Same formats as `since`."),
        include: includeParam,
        sort: z
          .enum(["newest", "oldest", "views"])
          .optional()
          .describe(
            "newest (default) = most recent activity first, pinned on top. oldest = creation order, for reading a course chronologically. views = most-viewed first, a good proxy for importance.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_SUMMARY_LIMIT)
          .optional()
          .describe(
            `Default ${DEFAULT_SUMMARY_LIMIT}, max ${MAX_SUMMARY_LIMIT}. Raise it to sweep a whole course. Reduced automatically when deep fields are requested.`,
          ),
        offset: z.number().int().min(0).optional().describe("Skip this many results, for paging."),
      },
      annotations: readOnly,
    },
    async (args): Promise<TextResult> =>
      withPiazzaSession(creds, async (client) => {
        const resolved = await resolveCourse(client, args.course);
        const fields = (args.include ?? DEFAULT_SEARCH_FIELDS) as PostField[];
        const deep = needsFullPost(fields);

        const cap = deep
          ? Math.min(args.limit ?? MAX_FULL_POSTS, MAX_FULL_POSTS)
          : (args.limit ?? DEFAULT_SUMMARY_LIMIT);
        const skip = args.offset ?? 0;

        let folderName: string | undefined;
        if (args.folder) {
          const known = await availableFolders(client, resolved.id);
          const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");
          // A folder missing from the tag counts may still exist, so try the requested name.
          folderName = known.find((f) => norm(f) === norm(args.folder!)) ?? args.folder;
        }

        // Keyword search and browsing use different endpoints; both yield feed items.
        let items: PiazzaFeedItem[];
        if (args.query) {
          items = await client.search(resolved.id, args.query);
          if (folderName) {
            const wanted = folderName;
            items = items.filter((i) => (i.folders?.length ? i.folders : (i.tags ?? [])).includes(wanted));
          }
        } else if (folderName || args.unread || args.mine || args.open_followups) {
          items =
            (
              await client.filterFeed(resolved.id, {
                folder: folderName,
                unread: args.unread,
                my_posts: args.mine,
                unresolved: args.open_followups,
              })
            ).feed ?? [];
        } else {
          items = (await client.getFeed(resolved.id, { limit: MAX_SUMMARY_LIMIT })).feed ?? [];
        }

        // Filters Piazza cannot apply server-side.
        if (args.type) items = items.filter((i) => i.type === args.type);
        if (args.by_instructors) items = items.filter(isByInstructor);
        if (args.instructor_answered) items = items.filter((i) => Boolean(i.has_i));
        if (args.pinned) items = items.filter(isPinned);
        // Only questions can be unanswered; notes and polls have no answer slot.
        if (args.unanswered) items = items.filter((i) => i.type === "question" && !i.has_i && !i.has_s);

        const since = args.since ? parseDate(args.since, "since") : undefined;
        const until = args.until ? parseDate(args.until, "until") : undefined;
        if (since) items = items.filter((i) => lastActivity(i) && new Date(lastActivity(i)) >= since);
        if (until) items = items.filter((i) => lastActivity(i) && new Date(lastActivity(i)) <= until);

        // Search results arrive in relevance order; preserve it unless a sort was requested.
        const sort = args.sort ?? (args.query ? undefined : "newest");
        if (sort === "oldest") {
          items = [...items].sort((a, b) => (a.created ?? "") < (b.created ?? "") ? -1 : 1);
        } else if (sort === "views") {
          items = [...items].sort((a, b) => (b.unique_views ?? 0) - (a.unique_views ?? 0));
        } else if (sort === "newest") {
          items = [...items].sort((a, b) => {
            const pinDiff = Number(isPinned(b)) - Number(isPinned(a));
            if (pinDiff !== 0) return pinDiff;
            return lastActivity(a) < lastActivity(b) ? 1 : -1;
          });
        }

        const total = items.length;
        const page = items.slice(skip, skip + cap);

        const scope = [
          args.query ? `"${args.query}"` : "",
          folderName ? `folder ${folderName}` : "",
          args.type ?? "",
          args.by_instructors ? "by instructors" : "",
          args.instructor_answered ? "instructor-answered" : "",
          args.unanswered ? "unanswered" : "",
          args.pinned ? "pinned" : "",
          args.unread ? "unread" : "",
          args.mine ? "mine" : "",
          args.open_followups ? "open follow-ups" : "",
          args.since ? `since ${args.since}` : "",
          args.until ? `until ${args.until}` : "",
        ]
          .filter(Boolean)
          .join(", ");

        if (page.length === 0) {
          // A misspelled folder is the most likely cause of an empty result, so answer it with
          // the real folder names rather than making the caller run another tool to find out.
          const folderHint = folderName
            ? `\nFolders in this course: ${(await availableFolders(client, resolved.id)).join(", ")}`
            : "";
          return text(
            `${courseLabel(resolved)} — no posts matched${scope ? ` (${scope})` : ""}.${folderHint}\n` +
              "Remove a filter or try different keywords.",
          );
        }

        const header = `${courseLabel(resolved)} — ${skip + 1}–${skip + page.length} of ${total}${scope ? ` (${scope})` : ""}`;
        const remaining = total - (skip + page.length);

        if (deep) {
          // readThreads resolves each thread's own authors, so no pre-resolution is needed here.
          const { body, read, truncated } = await readThreads(client, resolved, page.map((i) => i.nr), fields);
          const footer =
            truncated || remaining > 0
              ? `\n\n---\nRead ${read}${truncated ? " (size limit reached)" : ""}. ` +
                `${total - (skip + read)} remain — call again with offset=${skip + read}.`
              : "\n\n---\nThat is every post matching this query.";
          return text(`${header}\n\n${body}${footer}`);
        }

        const users = await client.resolveUsers(
          resolved.id,
          page.flatMap((i) => (i.log ?? []).map((e) => e.u)).filter(Boolean),
        );
        const ctx = { courseId: resolved.id, users };
        const body = page.map((i) => renderSummary(i, fields, ctx, since)).join("\n");
        const footer =
          remaining > 0
            ? `\n\n${remaining} more match. Call again with offset=${skip + page.length}, or raise limit (max ${MAX_SUMMARY_LIMIT}).`
            : "\n\nThat is every post matching this query.";

        return text(
          `${header}\n\n${body}${footer}\n` +
            `Next: piazza_get_posts(course, [${page.slice(0, 5).map((i) => i.nr).join(", ")}]) to read any of these.`,
        );
      }),
  );

  // --------------------------------------------------------------------- read
  server.registerTool(
    "piazza_get_posts",
    {
      title: "Read known posts in full",
      description:
        "Read posts you have already identified, by their post number. " +
        "Post numbers are NOT sequential and NOT enumerable — they are identifiers, and most numbers in a range do not exist. " +
        "Always get them from piazza_search_posts first, where they appear as @123 in the results; never guess a number or iterate 1,2,3. " +
        "Returns the original post, instructor and student answers, and follow-up discussion, with endorsements marked. " +
        "Use `include` to take only part of that — e.g. just `content` and `instructor_answer` when follow-up chatter is not needed. " +
        "Batch every number you want into one call rather than calling repeatedly.",
      inputSchema: {
        course: z.string().describe('Course code or id, e.g. "CS 240"'),
        post_numbers: z
          .array(z.union([z.number().int(), z.string()]))
          .min(1)
          .max(MAX_FULL_POSTS)
          .describe(
            `Post numbers taken from piazza_search_posts results, where they are shown as @123. ` +
              `E.g. [129, 190]. Up to ${MAX_FULL_POSTS} per call. Do not invent numbers.`,
          ),
        include: includeParam,
      },
      annotations: readOnly,
    },
    async ({ course, post_numbers, include }): Promise<TextResult> =>
      withPiazzaSession(creds, async (client) => {
        const resolved = await resolveCourse(client, course);
        const fields = (include ?? DEFAULT_READ_FIELDS) as PostField[];
        const { body, read, truncated } = await readThreads(client, resolved, post_numbers, fields);
        const footer = truncated
          ? `\n\n---\nRead ${read} of ${post_numbers.length} (size limit reached). Request the rest in another call.`
          : "";
        return text(`${body}${footer}`);
      }),
  );

}
