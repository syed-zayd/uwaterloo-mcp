/**
 * Learn tool registration.
 *
 * Each tool is thin: resolve arguments, call one `src/d2l` function, render text. Anything that
 * needs D2L is registered only when credentials exist, so a client connected to an
 * unconfigured deployment sees `server_info` alone rather than a menu of tools that all fail.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { SERVER_NAME, setupUrl, VERSION, type Config } from "./config.js";
import { D2LClient, D2LAuthError, D2LError, D2LSignedOutError } from "./d2l/client.js";
import { listCourses, resolveCourse, type Course } from "./d2l/courses.js";
import { currentAverage, getGrades, type Grade } from "./d2l/grades.js";
import {
  getContent,
  getTopic,
  listAnnouncements,
  listAssignments,
  listQuizzes,
  type Assignment,
  type ContentItem,
  type Quiz,
} from "./d2l/coursework.js";
import { getUpcoming, type Deadline } from "./d2l/upcoming.js";
import { getClasslist, type ClassMember } from "./d2l/classlist.js";
import {
  getAttemptDetail,
  listQuizAttempts,
  type AnsweredQuestion,
  type QuizAttempt,
} from "./d2l/quizzes.js";
import { getGroup, listGroupCategories } from "./d2l/groups.js";
import {
  countPosts,
  findPost,
  findTopic,
  getTopicPosts,
  listDiscussions,
  summariseThreads,
  type DiscussionPost,
} from "./d2l/discussions.js";
import {
  getSubmissionFile,
  getSubmissionFileMetadata,
  getTopicFile,
  getTopicFileMetadata,
} from "./d2l/files.js";
import { getSubmissionHistory, resolveDropboxFolder } from "./d2l/submissions.js";
import { getAssignmentFeedback, type AssignmentFeedback } from "./d2l/feedback.js";
import { getRubricsForGradeItem, type GradedRubric } from "./d2l/rubrics.js";
import {
  FILE_URL_TTL_SECONDS,
  signFileToken,
  signSubmissionFileToken,
} from "./fileUrls.js";
import { formatDate, text, truncate } from "./d2l/format.js";
import {
  getAnnouncementsOutput,
  getClasslistOutput,
  getCourseContentOutput,
  getDiscussionThreadOutput,
  getFileOutput,
  getFileUrlOutput,
  getGradesOutput,
  getGroupOutput,
  getQuizAttemptsOutput,
  getRubricOutput,
  getSubmissionFileOutput,
  getSubmissionFileUrlOutput,
  getSubmissionsOutput,
  getUpcomingOutput,
  listAssignmentsOutput,
  listCoursesOutput,
  listDiscussionPostsOutput,
  listDiscussionsOutput,
  listGroupsOutput,
  serverInfoOutput,
} from "./schemas.js";

/**
 * Every tool this server registers when D2L is configured.
 *
 * Reported by server_info so a client holding a stale manifest can be spotted: the mismatch
 * between what the server says it has and what the client offers is otherwise invisible.
 */
/**
 * Brightspace's idle timeout. It publishes no session-expiry endpoint, so a validity horizon can
 * only ever be inferred from this, and any request resets it.
 */
const D2L_IDLE_WINDOW_MS = 180 * 60_000;

const ALWAYS_AVAILABLE_TOOL_NAMES = ["server_info"] as const;

const COURSE_TOOL_NAMES = [
  "list_courses",
  "get_grades",
  "get_rubric",
  "list_assignments",
  "get_submissions",
  "get_submission_file",
  "get_submission_file_url",
  "get_course_content",
  "get_file",
  "get_file_url",
  "get_quiz_attempts",
  "get_classlist",
  "list_groups",
  "get_group",
  "list_discussions",
  "list_discussion_posts",
  "get_discussion_thread",
  "get_announcements",
  "get_upcoming",
] as const;

/** Argument accepted wherever a tool needs a course. */
const courseArg = z
  .string()
  .describe("Course id, name, or code — e.g. 1261658, \"CS 247\". Ids come from list_courses.");

export function registerLearnTools(
  server: McpServer,
  config: Config,
  additionalToolNames: readonly string[] = [],
): void {
  // Registered whether or not a session exists. A tool that disappears when signed out leaves
  // the assistant unable to discover why, and unable to tell the user where to fix it; a tool
  // that answers "no session yet, sign in at <url>" is self-explaining.
  const signedIn = config.d2l !== null;
  const client = new D2LClient({
    host: config.d2l?.host ?? config.d2lHost,
    cookie: config.d2l?.cookie ?? "",
    csrfToken: config.d2l?.csrfToken,
    setupUrl: setupUrl(config),
  });
  const registeredNames = [
    ...ALWAYS_AVAILABLE_TOOL_NAMES,
    ...COURSE_TOOL_NAMES,
    ...additionalToolNames,
  ];
  registerServerInfo(server, config, signedIn ? client : null, registeredNames);

  // Course resolution is needed by nearly every tool. The list is fetched per call rather than
  // cached: the server is stateless (a fresh instance per request), so a cache would never be
  // warm, and enrollments change rarely enough that the extra call is not worth complicating.
  const course = async (reference: string): Promise<Course> =>
    resolveCourse(await listCourses(client, { includeInactive: true }), reference);

  registerListCourses(server, client);
  registerGrades(server, client, course);
  registerRubric(server, client, course);
  registerAssignments(server, client, course);
  registerSubmissions(server, client, course, config);
  registerContent(server, client, course);
  registerGetFile(server, client, course);
  registerGetFileUrl(server, client, course, config);
  registerQuizAttempts(server, client, course);
  registerClasslist(server, client, course);
  registerGroups(server, client, course);
  registerDiscussions(server, client, course);
  registerAnnouncements(server, client, course);
  registerUpcoming(server, client);
}

// --------------------------------------------------------------------------- get_file

function registerGetFile(server: McpServer, client: D2LClient, course: CourseResolver): void {
  server.registerTool(
    "get_file",
    {
      title: "Get a course file",
      description:
        "Downloads a file from a course and returns the file itself — same bytes, same name, " +
        "same type — as an attachment the caller can save, open, or unpack. Use it for lecture " +
        "PDFs, assignment starter code, a .zip of provided files, or a .cpp to edit. The file " +
        "is always returned as an embedded resource, including when it contains text. Topic " +
        "ids come from get_course_content, on items where isReadable is true.",
      inputSchema: z.object({
        course: courseArg,
        topic_id: z.number().describe("Topic id of the file, from get_course_content."),
      }),
      outputSchema: getFileOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ course: reference, topic_id }) => {
      try {
        const target = await course(reference);
        const file = await getTopicFile(client, target.id, topic_id);

        const header = [
          `${target.name} — ${file.fileName}`,
          `${file.mimeType}, ${formatBytes(file.bytes)}`,
          file.note ?? null,
        ].filter((l) => l !== null);

        const content: Array<Record<string, unknown>> = [];

        content.push({
          type: "text",
          text: header.join("\n"),
        });

        // The bytes travel as an embedded resource so a client can save the real file. A
        // resource is used rather than a bare content block because only resources carry a
        // uri and mime type, which is what makes writing it to disk unambiguous.
        if (file.blob !== null) {
          content.push({
            type: "resource",
            resource: {
              uri: `d2l://course/${target.id}/topic/${topic_id}/${encodeURIComponent(file.fileName)}`,
              name: file.fileName,
              title: file.fileName,
              mimeType: file.mimeType,
              blob: file.blob,
            },
          });
        }

        return {
          content,
          structuredContent: {
            course: { id: target.id, name: target.name },
            topicId: topic_id,
            fileName: file.fileName,
            mimeType: file.mimeType,
            bytes: file.bytes,
            attached: file.blob !== null,
            note: file.note ?? null,
          },
        } as never;
      } catch (err) {
        const message =
          err instanceof D2LAuthError
            ? `Not signed in to D2L.\n\n${err.message}`
            : err instanceof D2LError
              ? `D2L request failed: ${err.message}`
              : `Error: ${err instanceof Error ? err.message : String(err)}`;
        return { content: [{ type: "text", text: message }], isError: true } as never;
      }
    },
  );
}

// --------------------------------------------------------------------------- get_file_url

function registerGetFileUrl(
  server: McpServer,
  client: D2LClient,
  course: CourseResolver,
  config: Config,
): void {
  server.registerTool(
    "get_file_url",
    {
      title: "Get a download link for a course file",
      description:
        "Returns a temporary download link for a file instead of the file itself. Use " +
        "get_file first — it attaches the real file, which is better in every way. This exists " +
        "only for clients that cannot accept an attached file: if get_file reports that the " +
        "file type is unsupported, or hands back text where a file was wanted, call this and " +
        "download the link into your environment (for example with curl). The link needs no " +
        "credentials and expires after 10 minutes, so fetch it promptly rather than saving it.",
      inputSchema: z.object({
        course: courseArg,
        topic_id: z.number().describe("Topic id of the file, from get_course_content."),
      }),
      outputSchema: getFileUrlOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ course: reference, topic_id }) =>
      guardStructured(async () => {
        const target = await course(reference);
        if (!config.authToken || !config.publicUrl) {
          throw new Error(
            "This deployment cannot issue download links because it has no public URL " +
              "configured. Use get_file instead.",
          );
        }

        // Only the metadata is fetched here — the bytes are fetched again when the link is
        // followed. Downloading twice would double the work for a link that may never be used.
        const meta = await getTopicFileMetadata(client, target.id, topic_id);
        const token = signFileToken(target.id, topic_id, config.authToken);
        const url = `${config.publicUrl}/file/${token}`;
        const expiresAt = new Date(Date.now() + FILE_URL_TTL_SECONDS * 1000).toISOString();

        return {
          text: [
            `${target.name} — ${meta.fileName}`,
            `${meta.mimeType}${meta.bytes ? `, ${formatBytes(meta.bytes)}` : ""}`,
            "",
            url,
            "",
            `Link expires ${formatDate(expiresAt)}. Download it into your environment — for`,
            `example: curl -L -o "${meta.fileName}" "${url}"`,
          ].join("\n"),
          data: {
            course: { id: target.id, name: target.name },
            topicId: topic_id,
            fileName: meta.fileName,
            mimeType: meta.mimeType,
            bytes: meta.bytes,
            url,
            expiresAt,
          },
        };
      }),
  );
}

/** Collapses whitespace so the same comment matches whichever endpoint it arrived from. */
function normaliseComment(comment: string): string {
  return comment.replace(/\s+/g, " ").trim();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Wraps a tool body so D2L failures become readable text rather than protocol errors.
 *
 * An expired cookie is the single most likely failure in normal use, and it must produce an
 * instruction the user can act on, not a stack trace.
 */
async function guard(run: () => Promise<string>): Promise<ReturnType<typeof text>> {
  try {
    return text(await run());
  } catch (err) {
    if (err instanceof D2LAuthError) return text(`Not signed in to D2L.\n\n${err.message}`);
    if (err instanceof D2LError) return text(`D2L request failed: ${err.message}`);
    return text(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Like `guard`, for tools that also return structured content.
 *
 * The failure path deliberately returns text with `isError` and no `structuredContent`: a
 * failure has no data to report, and inventing an empty object that satisfies the schema would
 * be indistinguishable from a genuinely empty result.
 */
async function guardStructured<T>(
  run: () => Promise<{ text: string; data: T }>,
): Promise<{ content: [{ type: "text"; text: string }]; structuredContent?: T; isError?: boolean }> {
  try {
    const { text: body, data } = await run();
    return { content: [{ type: "text", text: body }], structuredContent: data };
  } catch (err) {
    const message =
      // Both auth errors already read as complete instructions naming the /setup URL. Prefixing
      // them buries the one line the user actually has to act on.
      err instanceof D2LSignedOutError || err instanceof D2LAuthError
        ? err.message
        : err instanceof D2LError
          ? `D2L request failed: ${err.message}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

// --------------------------------------------------------------------------- server_info

function registerServerInfo(
  server: McpServer,
  config: Config,
  client: D2LClient | null,
  registeredTools: readonly string[],
): void {
  server.registerTool(
    "server_info",
    {
      title: "Server info",
      description:
        "Health check for the unified gateway. Reports which integrations are configured and " +
        "whether the Learn session is currently working. Use this first when a tool fails.",
      inputSchema: z.object({}),
      outputSchema: serverInfoOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const serverTime = new Date().toISOString();
      const lines = [
        `${SERVER_NAME} MCP server v${VERSION} — connection OK.`,
        `Server time: ${serverTime}`,
        "",
        // Listing the tools this server actually registered turns a stale client cache into
        // something diagnosable: if the caller can see server_info but claims the others do
        // not exist, the mismatch is visible in the same response rather than being invisible.
        `Tools registered on this server (${registeredTools.length}): ${registeredTools.join(", ")}`,
        "If your client only offers some of these, it is holding a cached tool list — remove",
        "and re-add the connector, or start a new conversation, to refresh it.",
        "",
        config.piazza
          ? "Piazza: configured. All Piazza tools are available."
          : "Piazza: NOT configured. Set PIAZZA_EMAIL and PIAZZA_PASSWORD to enable Piazza tools.",
        "",
      ];

      if (!client || !config.d2l) {
        lines.push(
          "Learn: NOT SIGNED IN. Learn tools will report the same until someone signs in.",
          `Give the user this link and ask them to sign in: ${setupUrl(config)}`,
          "When they say they are done, retry whatever they originally asked for.",
        );
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          structuredContent: {
            server: SERVER_NAME,
            version: VERSION,
            serverTime,
            tools: [...registeredTools],
            d2l: {
              configured: false,
              waterlooSignInConfigured: config.waterloo !== null,
              host: config.d2lHost,
              sessionAlive: null,
              signedInAs: null,
            },
            piazza: { configured: config.piazza !== null },
          },
        } as never;
      }

      // Checking live rather than reporting mere configuration: "a cookie is set" and "the
      // cookie still works" are different facts, and only the second one matters.
      const status = await client.sessionStatus();
      const signedInAs = status.alive
        ? `${status.user.FirstName} ${status.user.LastName} (${status.user.UniqueName})`
        : null;

      if (status.alive) {
        lines.push(
          `Learn: signed in to ${config.d2l.host} as ${signedInAs}.`,
          "The Learn session is active. All Learn tools are available.",
        );
      } else {
        lines.push(
          `Learn: configured for ${config.d2l.host}, but the session is NOT working.`,
          "",
          status.reason,
        );
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: {
          server: SERVER_NAME,
          version: VERSION,
          serverTime,
          tools: [...registeredTools],
          d2l: {
            configured: true,
            waterlooSignInConfigured: config.waterloo !== null,
            host: config.d2l.host,
            sessionAlive: status.alive,
            signedInAs,
          },
          piazza: { configured: config.piazza !== null },
        },
      } as never;
    },
  );
}

// --------------------------------------------------------------------------- list_courses

function registerListCourses(server: McpServer, client: D2LClient): void {
  server.registerTool(
    "list_courses",
    {
      title: "List courses",
      description:
        "Lists the user's D2L courses with their ids. Call this first — every other tool " +
        "takes a course, and the ids come from here. Pinned and recently visited courses are " +
        "listed first.",
      inputSchema: z.object({
        include_inactive: z
          .boolean()
          .optional()
          .describe("Include closed or past courses. Defaults to false (current courses only)."),
      }),
      outputSchema: listCoursesOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ include_inactive }) =>
      guardStructured(async () => {
        const courses = await listCourses(client, { includeInactive: include_inactive ?? false });
        const body =
          courses.length === 0
            ? include_inactive
              ? "No courses found on this D2L account."
              : "No active courses. Call again with include_inactive: true to see past courses."
            : `${courses.length} course(s):\n\n${courses.map(renderCourse).join("\n\n")}`;
        return { text: body, data: { courses } };
      }),
  );
}

function renderCourse(course: Course): string {
  const flags = [course.isPinned ? "PINNED" : null, course.isActive ? null : "INACTIVE"]
    .filter(Boolean)
    .join(" ");

  return [
    `${course.name}${flags ? `  [${flags}]` : ""}`,
    `  id: ${course.id}${course.code ? `   code: ${course.code}` : ""}`,
    course.endDate ? `  ends: ${formatDate(course.endDate)}` : null,
    course.lastAccessed ? `  last opened: ${formatDate(course.lastAccessed)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// --------------------------------------------------------------------------- get_grades

type CourseResolver = (reference: string) => Promise<Course>;

function registerGrades(server: McpServer, client: D2LClient, course: CourseResolver): void {
  server.registerTool(
    "get_grades",
    {
      title: "Get grades",
      description:
        "Grades for one course: every graded item with points and percentage, the running " +
        "average, the final grade if released, and the instructor's written feedback on " +
        "submitted assignments. Only items that have actually been marked appear — a zero is a " +
        "real mark and is shown, while work not yet graded is simply absent. Items backed by " +
        "an activity are marked [rubric?] for get_rubric, and quizzes can be opened with " +
        "get_quiz_attempts to see which questions were right or wrong.",
      inputSchema: z.object({
        course: courseArg,
        include_feedback: z
          .boolean()
          .optional()
          .describe(
            "Fetch written feedback from submitted assignments. Defaults to true; set false " +
              "to skip the extra requests when only scores are needed.",
          ),
      }),
      outputSchema: getGradesOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ course: reference, include_feedback }) =>
      guardStructured(async () => {
        const target = await course(reference);
        // Fetched together: feedback lives on a different resource from grades, and a course
        // with several assignments would otherwise pay for each round trip in sequence.
        const [{ grades, final }, feedback] = await Promise.all([
          getGrades(client, target.id),
          include_feedback === false
            ? Promise.resolve([])
            : getAssignmentFeedback(client, target.id).catch(() => []),
        ]);
        const average = currentAverage(grades);
        const data = {
          course: { id: target.id, name: target.name },
          grades,
          average,
          finalGrade: final?.displayed ?? null,
          feedback,
        };

        if (grades.length === 0) {
          return {
            text: `${target.name}: no grade items. The instructor may not have set up a gradebook.`,
            data,
          };
        }

        const lines = [`${target.name} — grades`, ""];
        if (final?.displayed) lines.push(`Final grade: ${final.displayed}`);
        if (average !== null) lines.push(`Average across graded items: ${average.toFixed(1)}%`);
        lines.push("", ...grades.map(renderGrade));


        if (feedback.length > 0) {
          const shown = new Set(
            grades.filter((g) => g.comments).map((g) => normaliseComment(g.comments)),
          );
          lines.push("", "— submissions —");
          for (const item of feedback) lines.push("", renderFeedback(item, shown));
        }

        return { text: lines.join("\n"), data };
      }),
  );
}

/** Brightspace returns weighted marks to nine decimals; two is what a gradebook shows. */
function round(value: number | null): string {
  if (value === null) return "—";
  return String(Math.round(value * 100) / 100);
}

function renderGrade(grade: Grade): string {
  const parts: string[] = [];

  if (grade.points !== null) {
    parts.push(
      grade.outOf !== null ? `${round(grade.points)}/${round(grade.outOf)}` : round(grade.points),
      grade.percentage !== null ? `(${grade.percentage.toFixed(1)}%)` : "",
    );
  } else {
    parts.push(grade.outOf !== null ? `not graded — out of ${grade.outOf}` : "not graded");
  }
  if (grade.weight !== null && !grade.isCategory) parts.push(`weight ${grade.weight}`);
  if (grade.isBonus) parts.push("BONUS");
  // Flagged rather than fetched: reading a rubric costs a page load plus two requests per
  // criterion, which would make one gradebook lookup dozens of round trips.
  if (grade.activity) parts.push(`[rubric? id ${grade.id}]`);

  // A category row is a weighting, not a mark: "14.22/25" means quizzes are worth 25% of the
  // final grade and 14.22 points are banked. Ungraded members count as zero there, so the
  // achieved percentage is reported separately — otherwise the row reads as a bad score.
  const head = grade.isCategory
    ? `${grade.name}: worth ${round(grade.outOf)}% of the final grade, ` +
      `${round(grade.points)} earned so far` +
      (grade.gradedPercentage != null
        ? `  —  averaging ${grade.gradedPercentage.toFixed(1)}% on the ${grade.gradedCount} graded so far`
        : "")
    : `${grade.name}: ${parts.filter(Boolean).join(" ")}`;
  // The displayed grade is authoritative when it disagrees with the raw points — a letter
  // scheme or a curve lives there and nowhere else.
  const displayed =
    grade.displayed && !head.includes(grade.displayed) ? `\n  shows as: ${grade.displayed}` : "";
  // Instructor feedback is often several paragraphs and is usually the most useful thing on
  // the row, so it is given room and indented — an unindented continuation line reads as
  // another grade item.
  const comment = grade.comments
    ? `\n  feedback: ${truncate(grade.comments, 2000).replace(/\n+/g, "\n    ")}`
    : "";
  return head + displayed + comment;
}

/**
 * Renders one submission.
 *
 * `alreadyShown` holds the comments already printed on the grade rows. Brightspace stores the
 * same instructor comment against both the grade item and the submission, so without this the
 * reader gets the identical paragraph twice. What this section adds that the grade row cannot
 * is the submission itself — when it was handed in, and which files.
 */
function renderFeedback(item: AssignmentFeedback, alreadyShown: ReadonlySet<string>): string {
  const score =
    item.score !== null
      ? `${item.score}${item.outOf !== null ? `/${item.outOf}` : ""}`
      : item.isGraded
        ? (item.gradedSymbol ?? "graded")
        : "not graded";

  const lines = [`${item.folderName}: ${score}`];
  if (item.submittedAt) lines.push(`  submitted: ${formatDate(item.submittedAt)}`);
  if (item.submittedFiles.length > 0) {
    lines.push(`  your files: ${item.submittedFiles.join(", ")}`);
  }
  if (item.comment && !alreadyShown.has(normaliseComment(item.comment))) {
    lines.push(`  feedback: ${item.comment.replace(/\n+/g, "\n    ").trim()}`);
  }
  for (const criterion of item.rubrics) {
    const mark = criterion.score !== null
      ? ` ${criterion.score}${criterion.outOf !== null ? `/${criterion.outOf}` : ""}`
      : "";
    lines.push(
      `  rubric — ${criterion.name}: ${criterion.level ?? "—"}${mark}` +
        (criterion.feedback ? `\n      ${criterion.feedback.replace(/\n+/g, " ").trim()}` : ""),
    );
  }
  if (item.attachments.length > 0) {
    lines.push(`  instructor attached: ${item.attachments.join(", ")}`);
  }
  return lines.join("\n");
}

// --------------------------------------------------------------------------- get_rubric

function registerRubric(server: McpServer, client: D2LClient, course: CourseResolver): void {
  server.registerTool(
    "get_rubric",
    {
      title: "Get a graded rubric",
      description:
        "The marked rubric for one grade item: each criterion with the points awarded, the " +
        "level selected, and any per-criterion feedback — the same breakdown the Brightspace " +
        "rubric popup shows. Use the grade item id from get_grades, on items marked [rubric?].",
      inputSchema: z.object({
        course: courseArg,
        grade_item_id: z
          .number()
          .describe("Id of the grade item, from get_grades (the number after 'rubric? id')."),
      }),
      outputSchema: getRubricOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ course: reference, grade_item_id }) =>
      guardStructured<z.infer<typeof getRubricOutput>>(async () => {
        const target = await course(reference);
        const { grades } = await getGrades(client, target.id);
        const item = grades.find((g) => g.id === String(grade_item_id));

        if (!item) {
          return {
            text: `${target.name}: no grade item with id ${grade_item_id}. Call get_grades to see the ids.`,
            data: { course: { id: target.id, name: target.name }, gradeItem: null, rubrics: [] },
          };
        }
        if (!item.activity) {
          return {
            text: `"${item.name}" is not backed by an activity, so it has no rubric to show.`,
            data: {
              course: { id: target.id, name: target.name },
              gradeItem: { id: item.id, name: item.name },
              rubrics: [],
            },
          };
        }

        const rubrics = await getRubricsForGradeItem(client, target.id, {
          Id: Number(item.id),
          Name: item.name,
          AssociatedTool: { ToolId: item.activity.toolId, ToolItemId: item.activity.toolItemId },
        });

        const data = {
          course: { id: target.id, name: target.name },
          gradeItem: { id: item.id, name: item.name },
          rubrics,
        };

        if (rubrics.length === 0) {
          return {
            text:
              `"${item.name}" has no graded rubric. The instructor may have marked it without ` +
              "one, or not released the rubric yet.",
            data,
          };
        }

        return { text: [`${target.name} — ${item.name}`, "", ...rubrics.map(renderRubric)].join("\n"), data };
      }),
  );
}

function renderRubric(rubric: GradedRubric): string {
  const lines = [
    `${rubric.rubricName ?? "Rubric"}${rubric.activityName ? ` — ${rubric.activityName}` : ""}`,
    rubric.score !== null
      ? `Total: ${rubric.score}${rubric.outOf !== null ? `/${rubric.outOf}` : ""}`
      : "Total: not scored",
    "",
  ];

  for (const criterion of rubric.criteria) {
    const mark =
      criterion.score !== null
        ? `${criterion.score}${criterion.outOf !== null ? `/${criterion.outOf}` : ""}`
        : "not scored";
    lines.push(
      `  ${criterion.name}: ${mark}${criterion.levelName ? `  (${criterion.levelName})` : ""}`,
    );
    if (criterion.feedback) lines.push(`      ${criterion.feedback.replace(/\n+/g, " ").trim()}`);
  }

  if (rubric.overallFeedback) {
    lines.push("", `Overall: ${rubric.overallFeedback.replace(/\n+/g, " ").trim()}`);
  }
  return lines.join("\n");
}

// --------------------------------------------------------------------------- assignments

function registerAssignments(server: McpServer, client: D2LClient, course: CourseResolver): void {
  server.registerTool(
    "list_assignments",
    {
      title: "List assignments",
      description:
        "Assignment folders for one course, earliest due date first, showing whether the user " +
        "has submitted and whether feedback is available. Set include_quizzes to add quizzes " +
        "and tests.",
      inputSchema: z.object({
        course: courseArg,
        include_quizzes: z.boolean().optional().describe("Also list quizzes. Defaults to false."),
        only_outstanding: z
          .boolean()
          .optional()
          .describe("Only items not yet submitted. Defaults to false."),
      }),
      outputSchema: listAssignmentsOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ course: reference, include_quizzes, only_outstanding }) =>
      guardStructured(async () => {
        const target = await course(reference);
        let assignments = await listAssignments(client, target.id);
        if (only_outstanding) assignments = assignments.filter((a) => !a.submitted);
        const quizzes = include_quizzes
          ? await listQuizzes(client, target.id).catch(() => [])
          : [];

        const lines = [`${target.name} — assignments`, ""];
        if (assignments.length === 0) {
          lines.push(only_outstanding ? "Nothing outstanding." : "No assignment folders.");
        } else {
          lines.push(...assignments.map(renderAssignment));
        }

        if (include_quizzes) {
          lines.push("", `— quizzes (${quizzes.length}) —`);
          for (const quiz of quizzes) {
            const due = quiz.dueDate ?? quiz.endDate;
            lines.push(
              `${quiz.name}: ${due ? `due ${formatDate(due)}` : "no due date"}` +
                (quiz.attempts ? `  attempts: ${quiz.attempts}` : ""),
            );
          }
        }

        return {
          text: lines.join("\n"),
          data: { course: { id: target.id, name: target.name }, assignments, quizzes },
        };
      }),
  );
}

function renderAssignment(a: Assignment): string {
  // `null` means D2L withheld the counter rather than reporting zero, so say so instead of
  // asserting the work was never handed in.
  const status =
    a.submitted === null
      ? "submission status not shown by D2L"
      : a.submitted
        ? a.hasFeedback
          ? "SUBMITTED, feedback ready"
          : "SUBMITTED"
        : "not submitted";
  return [
    `${a.name}${a.isGroup ? " [group]" : ""}`,
    `  due: ${formatDate(a.dueDate)}   ${status}${a.outOf !== null ? `   out of ${a.outOf}` : ""}`,
    a.availableUntil ? `  closes: ${formatDate(a.availableUntil)}` : null,
    a.instructions ? `  ${truncate(a.instructions, 300).replace(/\n/g, "\n  ")}` : null,
    `  id: ${a.id}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// --------------------------------------------------------------------------- submissions

function registerSubmissions(
  server: McpServer,
  client: D2LClient,
  course: CourseResolver,
  config: Config,
): void {
  const assignmentArg = z
    .string()
    .describe("Assignment name or id, from list_assignments — e.g. \"Individual Case Study\".");
  const submissionIdArg = z
    .number()
    .int()
    .positive()
    .describe("Submission id from get_submissions. Each attempt has a different id.");
  const fileIdArg = z
    .number()
    .int()
    .positive()
    .describe("File id from that attempt in get_submissions.");

  server.registerTool(
    "get_submissions",
    {
      title: "Get assignment submissions",
      description:
        "Every submission attempt the user made for one assignment, oldest first. Returns the " +
        "assignment instructions, each attempt's date and comment, every submitted file with " +
        "the ids needed by get_submission_file, and published instructor feedback. It never " +
        "collapses multiple attempts into only the latest one. For group assignments it returns " +
        "the submissions made by the user's group.",
      inputSchema: z.object({ course: courseArg, assignment: assignmentArg }),
      outputSchema: getSubmissionsOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ course: reference, assignment }) =>
      guardStructured(async () => {
        const target = await course(reference);
        const folder = await resolveDropboxFolder(client, target.id, assignment);
        const history = await getSubmissionHistory(client, target.id, folder);
        const data = {
          course: { id: target.id, name: target.name },
          ...history,
          submissionCount: history.submissions.length,
        };

        const lines = [
          `${target.name} — ${history.assignment.name}`,
          `Assignment id: ${history.assignment.id}`,
          history.assignment.dueDate ? `Due: ${formatDate(history.assignment.dueDate)}` : "No due date",
          history.assignment.isGroup && history.entity
            ? `Group: ${history.entity.name} (id ${history.entity.id})`
            : null,
        ].filter((line): line is string => line !== null);

        if (history.assignment.instructions) {
          lines.push("", "Instructions", truncate(history.assignment.instructions, 5000));
        }
        if (history.assignment.instructionFiles.length > 0) {
          lines.push(
            "",
            `Instruction files: ${history.assignment.instructionFiles.map((file) => file.name).join(", ")}`,
          );
        }
        for (const link of history.assignment.instructionLinks) {
          lines.push(`Instruction link: ${link.name}${link.url ? ` — ${link.url}` : ""}`);
        }

        lines.push("", `Submissions: ${history.submissions.length}`);
        if (history.submissions.length === 0) lines.push("No submissions have been made.");

        for (const submission of history.submissions) {
          lines.push(
            "",
            `Submission ${submission.number} — id ${submission.id}` +
              (submission.submittedAt ? ` — ${formatDate(submission.submittedAt)}` : ""),
            `  submitted by: ${submission.submittedBy.name}`,
          );
          if (submission.comment) {
            lines.push(`  comment: ${submission.comment.replace(/\n+/g, "\n    ")}`);
          }
          if (submission.files.length === 0) {
            lines.push("  files: none");
          } else {
            lines.push("  files:");
            for (const file of submission.files) {
              lines.push(
                `    ${file.name} (${formatBytes(file.size)}) — file_id ${file.id}` +
                  (file.isDeleted ? " [deleted]" : ""),
              );
            }
          }
        }

        if (history.feedback) {
          const feedback = history.feedback;
          const score =
            feedback.score !== null
              ? `${feedback.score}${feedback.outOf !== null ? `/${feedback.outOf}` : ""}`
              : feedback.isGraded
                ? (feedback.gradedSymbol ?? "graded")
                : "not graded";
          lines.push("", `Feedback: ${score}`);
          if (feedback.comment) lines.push(feedback.comment);
          for (const criterion of feedback.rubrics) {
            const mark =
              criterion.score !== null
                ? ` ${criterion.score}${criterion.outOf !== null ? `/${criterion.outOf}` : ""}`
                : "";
            lines.push(
              `  ${criterion.name}: ${criterion.level ?? "—"}${mark}` +
                (criterion.feedback ? `\n    ${criterion.feedback}` : ""),
            );
          }
          if (feedback.attachments.length > 0) {
            lines.push(`  instructor files: ${feedback.attachments.map((file) => file.name).join(", ")}`);
          }
          for (const link of feedback.links) {
            lines.push(`  instructor link: ${link.name}${link.url ? ` — ${link.url}` : ""}`);
          }
        }

        return { text: lines.join("\n"), data };
      }),
  );

  server.registerTool(
    "get_submission_file",
    {
      title: "Get a submitted assignment file",
      description:
        "Returns one file from one assignment submission as the original embedded file — same " +
        "bytes, name, and type. Use get_submissions first, then pass the assignment, submission " +
        "id, and file id it returned. The caller can save, open, compile, edit, or unpack the " +
        "file. Use get_submission_file_url only if the client cannot accept embedded resources.",
      inputSchema: z.object({
        course: courseArg,
        assignment: assignmentArg,
        submission_id: submissionIdArg,
        file_id: fileIdArg,
      }),
      outputSchema: getSubmissionFileOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ course: reference, assignment, submission_id, file_id }) => {
      try {
        const target = await course(reference);
        const folder = await resolveDropboxFolder(client, target.id, assignment);
        const file = await getSubmissionFile(
          client,
          target.id,
          folder.Id,
          submission_id,
          file_id,
        );
        const header = [
          `${target.name} — ${folder.Name} — ${file.fileName}`,
          `${file.mimeType}, ${formatBytes(file.bytes)}`,
          file.note ?? null,
        ].filter((line): line is string => line !== null);
        const content: Array<Record<string, unknown>> = [{ type: "text", text: header.join("\n") }];

        if (file.blob !== null) {
          content.push({
            type: "resource",
            resource: {
              uri:
                `d2l://course/${target.id}/assignment/${folder.Id}/submission/${submission_id}` +
                `/file/${file_id}/${encodeURIComponent(file.fileName)}`,
              name: file.fileName,
              title: file.fileName,
              mimeType: file.mimeType,
              blob: file.blob,
            },
          });
        }

        return {
          content,
          structuredContent: {
            course: { id: target.id, name: target.name },
            assignment: { id: folder.Id, name: folder.Name },
            submissionId: submission_id,
            fileId: file_id,
            fileName: file.fileName,
            mimeType: file.mimeType,
            bytes: file.bytes,
            attached: file.blob !== null,
            note: file.note ?? null,
          },
        } as never;
      } catch (err) {
        const message =
          err instanceof D2LAuthError
            ? `Not signed in to D2L.\n\n${err.message}`
            : err instanceof D2LError
              ? `D2L request failed: ${err.message}`
              : `Error: ${err instanceof Error ? err.message : String(err)}`;
        return { content: [{ type: "text", text: message }], isError: true } as never;
      }
    },
  );

  server.registerTool(
    "get_submission_file_url",
    {
      title: "Get a submitted assignment file URL",
      description:
        "Fallback for clients that cannot accept the embedded resource from get_submission_file. " +
        "Returns a credential-free URL that streams the same submitted file and expires after " +
        "10 minutes. Download it promptly into the client's environment with curl or equivalent.",
      inputSchema: z.object({
        course: courseArg,
        assignment: assignmentArg,
        submission_id: submissionIdArg,
        file_id: fileIdArg,
      }),
      outputSchema: getSubmissionFileUrlOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ course: reference, assignment, submission_id, file_id }) =>
      guardStructured(async () => {
        const target = await course(reference);
        const folder = await resolveDropboxFolder(client, target.id, assignment);
        if (!config.authToken || !config.publicUrl) {
          throw new Error(
            "This deployment cannot issue download links because it has no public URL configured. " +
              "Use get_submission_file instead.",
          );
        }

        const meta = await getSubmissionFileMetadata(
          client,
          target.id,
          folder.Id,
          submission_id,
          file_id,
        );
        const token = signSubmissionFileToken(
          target.id,
          folder.Id,
          submission_id,
          file_id,
          config.authToken,
        );
        const url = `${config.publicUrl}/file/${token}`;
        const expiresAt = new Date(Date.now() + FILE_URL_TTL_SECONDS * 1000).toISOString();
        const data = {
          course: { id: target.id, name: target.name },
          assignment: { id: folder.Id, name: folder.Name },
          submissionId: submission_id,
          fileId: file_id,
          fileName: meta.fileName,
          mimeType: meta.mimeType,
          bytes: meta.bytes,
          url,
          expiresAt,
        };

        return {
          text: [
            `${target.name} — ${folder.Name} — ${meta.fileName}`,
            `${meta.mimeType}${meta.bytes !== null ? `, ${formatBytes(meta.bytes)}` : ""}`,
            "",
            url,
            "",
            `Link expires ${formatDate(expiresAt)}.`,
          ].join("\n"),
          data,
        };
      }),
  );
}

// --------------------------------------------------------------------------- content

function registerContent(server: McpServer, client: D2LClient, course: CourseResolver): void {
  server.registerTool(
    "get_course_content",
    {
      title: "Get course content",
      description:
        "The course's complete content outline — every module and the pages, files, and links " +
        "inside them, in the order the instructor arranged them. Always returns everything, so " +
        "read the list and pick what you need rather than guessing at a search term. Items " +
        "where isReadable is true can be opened with get_file.",
      inputSchema: z.object({ course: courseArg }),
      outputSchema: getCourseContentOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ course: reference }) =>
      guardStructured(async () => {
        const target = await course(reference);
        const items = await getContent(client, target.id);
        const data = { course: { id: target.id, name: target.name }, items };

        if (items.length === 0) {
          return { text: `${target.name}: the content outline is empty.`, data };
        }

        return {
          text: [
            `${target.name} — content (${items.length} items)`,
            "",
            ...items.map((i) => renderContentItem(i, client.host)),
          ].join("\n"),
          data,
        };
      }),
  );
}

function renderContentItem(item: ContentItem, host: string): string {
  const indent = "  ".repeat(item.depth);
  if (item.kind === "module") {
    return `${indent}▸ ${item.title}${item.isLocked ? " [locked]" : ""}`;
  }
  const type = item.type ? ` (${item.type})` : "";
  const due = item.dueDate ? `  due ${formatDate(item.dueDate)}` : "";
  return `${indent}· ${item.title}${type}${due}   topic_id: ${item.id}`;
}

/** Content URLs are returned site-relative; a bare path is not useful to the reader. */
function absoluteUrl(host: string, url: string): string {
  return url.startsWith("http") ? url : `${host}${url.startsWith("/") ? "" : "/"}${url}`;
}

// --------------------------------------------------------------------------- classlist

function registerClasslist(server: McpServer, client: D2LClient, course: CourseResolver): void {
  server.registerTool(
    "get_classlist",
    {
      title: "Get the classlist",
      description:
        "Everyone enrolled in a course — name, username, email, role, online status, and the " +
        "groups they belong to — with a count per role. Instructors and TAs are listed first. " +
        "Everything is optional: call it with just a course to get the whole class, or narrow " +
        "with search, role, group, or online_only. Use it to find who to contact, to identify " +
        "someone who posted in a discussion, or to see who is in a project group.",
      inputSchema: z.object({
        course: courseArg,
        search: z
          .string()
          .optional()
          .describe("Match against name, username, and email unless search_in narrows it."),
        search_in: z
          .array(z.enum(["name", "first_name", "last_name", "username", "email"]))
          .optional()
          .describe("Which fields `search` looks at. Defaults to name, username, and email."),
        role: z
          .string()
          .optional()
          .describe(
            "Exact role label, e.g. \"Instructor\" or \"TA - Level 4\". The labels for a " +
              "course come back in roleCounts — call without this first to see them.",
          ),
        group: z.string().optional().describe("Only people in a group whose name contains this."),
        online_only: z.boolean().optional().describe("Only people currently online."),
        include_groups: z
          .boolean()
          .optional()
          .describe("Look up group membership. Defaults to true; costs a few extra requests."),
      }),
      outputSchema: getClasslistOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ course: reference, search, search_in, role, group, online_only, include_groups }) =>
      guardStructured(async () => {
        const target = await course(reference);
        const list = await getClasslist(client, target.id, {
          search,
          searchIn: search_in,
          role,
          group,
          onlineOnly: online_only,
          includeGroups: include_groups,
        });

        const data = {
          course: { id: target.id, name: target.name },
          members: list.members,
          roleCounts: list.roleCounts,
          groups: list.groups,
          totalMembers: list.totalMembers,
          returned: list.members.length,
        };

        const filters = [
          search ? `search "${search}"` : null,
          role ? `role "${role}"` : null,
          group ? `group "${group}"` : null,
          online_only ? "online only" : null,
        ].filter(Boolean);

        if (list.members.length === 0) {
          return {
            text:
              filters.length > 0
                ? `${target.name}: nobody matches ${filters.join(", ")}. ` +
                  `The course has ${list.totalMembers} people; roles are: ${list.roleCounts.map((r) => r.role).join(", ")}.`
                : `${target.name}: the classlist is empty or not visible to you.`,
            data,
          };
        }

        const lines = [
          `${target.name} — ${list.totalMembers} enrolled` +
            (filters.length > 0 ? `, ${list.members.length} matching ${filters.join(", ")}` : ""),
          "",
          `Roles: ${list.roleCounts.map((r) => `${r.role} (${r.count})`).join(", ")}`,
        ];

        if (list.groups.length > 0) {
          const byCategory = new Map<string, string[]>();
          for (const g of list.groups) {
            byCategory.set(g.categoryName, [...(byCategory.get(g.categoryName) ?? []), g.name]);
          }
          // Named as sets rather than groups: "Project" is a category holding forty groups, and
          // writing "Project (40)" under a "Groups:" heading reads as one group of forty people.
          lines.push(
            `Group sets: ${[...byCategory]
              .map(([category, names]) => `${category} — ${names.length} group(s)`)
              .join("; ")}`,
            "Use list_groups to see the groups within each set.",
          );
        }
        lines.push("");

        // Grouped by role so the reader sees "these are the two instructors" rather than
        // having to infer it from a flat list.
        let currentRole = "";
        for (const member of list.members) {
          if (member.role !== currentRole) {
            currentRole = member.role;
            lines.push(`— ${currentRole} —`);
          }
          lines.push(renderMember(member));
        }
        return { text: lines.join("\n"), data };
      }),
  );
}

function renderMember(member: ClassMember): string {
  const details = [
    member.email,
    member.username && member.username !== member.email ? `@${member.username}` : null,
    member.pronouns ? `(${member.pronouns})` : null,
    member.isOnline ? "ONLINE" : null,
    member.groups.length > 0 ? `in ${member.groups.join(", ")}` : null,
  ].filter(Boolean);
  return `  ${member.displayName}${details.length ? `  ·  ${details.join("  ·  ")}` : ""}`;
}
// --------------------------------------------------------------------------- quiz attempts

/**
 * Named so both branches return the same type: with no attempts there is nothing to read, and
 * an inferred type would otherwise fix `attempt` as null from whichever branch came first.
 */
interface QuizAttemptsData {
  course: { id: number; name: string };
  quiz: { id: number; name: string };
  attempts: QuizAttempt[];
  attempt: {
    attemptId: number;
    score: number | null;
    outOf: number | null;
    correctCount: number;
    incorrectCount: number;
    questions: AnsweredQuestion[];
  } | null;
}

function registerQuizAttempts(server: McpServer, client: D2LClient, course: CourseResolver): void {
  server.registerTool(
    "get_quiz_attempts",
    {
      title: "Get quiz attempts",
      description:
        "A quiz attempt question by question: what was asked, what the user answered, what was " +
        "correct, and whether they got it right. This is what the \"View Quiz Attempts\" link " +
        "in Brightspace shows. Use it to work out which topics a user keeps getting wrong " +
        "across their quizzes. Quiz ids come from list_assignments with include_quizzes.",
      inputSchema: z.object({
        course: courseArg,
        quiz: z.string().describe("Quiz name or id, e.g. \"Quiz 1\" or 316951."),
        attempt: z
          .number()
          .optional()
          .describe("Which attempt to read, by number. Defaults to the most recent."),
      }),
      outputSchema: getQuizAttemptsOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ course: reference, quiz: quizRef, attempt: attemptNumber }) =>
      guardStructured(async () => {
        const target = await course(reference);
        const quizzes = await listQuizzes(client, target.id);
        const quiz = resolveQuiz(quizzes, quizRef);

        const attempts = await listQuizAttempts(client, target.id, quiz.id);
        const base = {
          course: { id: target.id, name: target.name },
          quiz: { id: quiz.id, name: quiz.name },
          attempts,
        };

        if (attempts.length === 0) {
          const data: QuizAttemptsData = { ...base, attempt: null };
          return {
            text: `${quiz.name}: no attempts. Either it has not been taken, or the instructor has not released the results.`,
            data,
          };
        }

        const chosen =
          attemptNumber !== undefined
            ? attempts.find((a) => a.attemptNumber === attemptNumber)
            : attempts[attempts.length - 1];
        if (!chosen) {
          throw new Error(
            `${quiz.name} has ${attempts.length} attempt(s); there is no attempt ${attemptNumber}.`,
          );
        }

        const detail = await getAttemptDetail(client, target.id, quiz.id, chosen.attemptId);
        const data: QuizAttemptsData = {
          ...base,
          attempt: {
            attemptId: detail.attemptId,
            score: detail.score,
            outOf: detail.outOf,
            correctCount: detail.correctCount,
            incorrectCount: detail.incorrectCount,
            questions: detail.questions,
          },
        };

        const awaiting = detail.questions.filter((q) => q.isCorrect === null).length;
        const lines = [
          `${target.name} — ${quiz.name}`,
          `Attempt ${chosen.attemptNumber} of ${attempts.length}` +
            (detail.score !== null ? `  ·  ${detail.score}/${detail.outOf}` : "") +
            `  ·  ${detail.correctCount} correct, ${detail.incorrectCount} wrong` +
            (awaiting > 0 ? `, ${awaiting} free response` : ""),
          "",
        ];

        for (const question of detail.questions) {
          const mark =
            question.isCorrect === null ? "—" : question.isCorrect ? "CORRECT" : "WRONG";
          lines.push(`Q${question.number}  ${mark}`, `  ${question.text}`);

          if (question.type === "written") {
            lines.push(`  you wrote: ${truncate(question.yourAnswers.join(" ") || "(nothing)", 600)}`);
          } else if (question.type === "matching") {
            for (const pairing of question.yourAnswers) lines.push(`    ${pairing}`);
            for (const fix of question.correctAnswers) lines.push(`    should be: ${fix}`);
          } else {
            // Every option is listed, not just the chosen one: an answer like "F) Just A) and
            // C) above" is meaningless without the options it refers to.
            for (const option of question.options) {
              const tags = [
                option.selected ? "your answer" : null,
                option.isCorrect ? "correct" : null,
              ].filter((tag) => tag !== null);
              lines.push(`    ${option.text}${tags.length > 0 ? `   (${tags.join(", ")})` : ""}`);
            }
            if (question.options.length === 0) lines.push("    (no options on the page)");
          }
          lines.push("");
        }

        if (attempts.length > 1) {
          lines.push(
            `Other attempts: ${attempts
              .filter((a) => a.attemptId !== chosen.attemptId)
              .map((a) => `#${a.attemptNumber} (${a.score}/${a.outOf})`)
              .join(", ")}`,
          );
        }
        return { text: lines.join("\n"), data };
      }),
  );
}

/** Same conservative matching as course lookup: exact, then unambiguous substring. */
function resolveQuiz(quizzes: Quiz[], reference: string): Quiz {
  const query = reference.trim();
  const byId = quizzes.find((q) => String(q.id) === query);
  if (byId) return byId;

  const normalise = (v: string): string => v.toLowerCase().replace(/[\s_-]+/g, "");
  const target = normalise(query);

  const exact = quizzes.filter((q) => normalise(q.name) === target);
  if (exact.length === 1) return exact[0]!;

  const partial = quizzes.filter((q) => normalise(q.name).includes(target));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    throw new Error(
      `"${reference}" matches several quizzes: ${partial.map((q) => q.name).join(", ")}. Use the quiz id.`,
    );
  }
  throw new Error(
    `No quiz matches "${reference}". Available: ${quizzes.map((q) => q.name).join(", ") || "none"}.`,
  );
}

// --------------------------------------------------------------------------- groups

function registerGroups(server: McpServer, client: D2LClient, course: CourseResolver): void {
  server.registerTool(
    "list_groups",
    {
      title: "List group sets and groups",
      description:
        "The group sets in a course and the groups inside each one. A set such as \"Project\" " +
        "holds one group per team — forty of them in CS 247 — so the set is not itself a group. " +
        "Shows how many people are in each group, which ones the user belongs to, whether " +
        "self-enrolment is open, and any discussion topics restricted to that set.",
      inputSchema: z.object({ course: courseArg }),
      outputSchema: listGroupsOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ course: reference }) =>
      guardStructured(async () => {
        const target = await course(reference);
        const me = await client.whoami().catch(() => null);
        const categories = await listGroupCategories(client, target.id, me?.Identifier ?? null);

        const myGroups = categories.flatMap((c) => c.groups.filter((g) => g.isMine).map((g) => g.name));
        const data = { course: { id: target.id, name: target.name }, categories, myGroups };

        if (categories.length === 0) {
          return { text: `${target.name}: no groups.`, data };
        }

        const lines = [`${target.name} — ${categories.length} group set(s)`, ""];
        for (const category of categories) {
          lines.push(`▸ ${category.name}  —  ${category.groups.length} group(s)`);
          if (category.description) {
            lines.push(`    ${truncate(category.description, 300)}`);
          }

          if (category.maxUsersPerGroup) {
            lines.push(`    max ${category.maxUsersPerGroup} per group`);
          }

          if (category.discussionTopics.length > 0) {
            lines.push(
              `    discussion topics using this set: ${category.discussionTopics
                .map((t) => `${t.name} (topic_id ${t.id})`)
                .join(", ")}`,
            );
          }

          for (const group of category.groups) {
            lines.push(
              `    · ${group.name}  —  ${group.memberCount} member(s)` +
                (group.isMine ? "   ← YOURS" : "") +
                `   group_id: ${group.id}`,
            );
          }
          lines.push("");
        }

        if (myGroups.length > 0) lines.push(`You are in: ${myGroups.join(", ")}`);
        return { text: lines.join("\n"), data };
      }),
  );

  server.registerTool(
    "get_group",
    {
      title: "Get one group",
      description:
        "One group's members, named and with their emails, plus any discussion topics its set " +
        "is restricted to. Accepts a group name or id from list_groups.",
      inputSchema: z.object({
        course: courseArg,
        group: z.string().describe("Group name or id, e.g. \"Pineapple\" or 1286400."),
      }),
      outputSchema: getGroupOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ course: reference, group: groupRef }) =>
      guardStructured(async () => {
        const target = await course(reference);
        const [me, classlist] = await Promise.all([
          client.whoami().catch(() => null),
          // Members come from the classlist so the group's user ids become names and emails;
          // the group endpoint itself returns ids only.
          getClasslist(client, target.id, { includeGroups: false }),
        ]);

        const detail = await getGroup(
          client,
          target.id,
          groupRef,
          classlist.members.map((m) => ({
            id: m.id,
            displayName: m.displayName,
            email: m.email,
            role: m.role,
            isOnline: m.isOnline,
          })),
          me?.Identifier ?? null,
        );

        const data = { course: { id: target.id, name: target.name }, group: detail };

        const lines = [
          `${detail.name}${detail.isMine ? "  ← you are in this group" : ""}`,
          `  part of "${detail.categoryName}" · ${detail.memberCount} member(s)` +
            (detail.code ? ` · code ${detail.code}` : ""),
        ];
        if (detail.description) lines.push(`  ${truncate(detail.description, 300)}`);
        lines.push("");

        for (const member of detail.members) {
          lines.push(
            `  ${member.displayName}` +
              (member.email ? `  ·  ${member.email}` : "") +
              (member.role !== "Student" ? `  ·  ${member.role}` : "") +
              (member.isOnline ? "  ·  ONLINE" : ""),
          );
        }

        if (detail.discussionTopics.length > 0) {
          lines.push(
            "",
            "Discussion topics for this group set:",
            ...detail.discussionTopics.map((t) => `  ${t.name}   topic_id: ${t.id}  (${t.forumName})`),
          );
        }
        return { text: lines.join("\n"), data };
      }),
  );
}

// --------------------------------------------------------------------------- discussions

function registerDiscussions(server: McpServer, client: D2LClient, course: CourseResolver): void {
  server.registerTool(
    "list_discussions",
    {
      title: "List discussion forums and topics",
      description:
        "Every discussion forum in a course and the topics inside it, with their descriptions. " +
        "Call this first — topic ids come from here and feed list_discussion_posts.",
      inputSchema: z.object({ course: courseArg }),
      outputSchema: listDiscussionsOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ course: reference }) =>
      guardStructured(async () => {
        const target = await course(reference);
        const forums = await listDiscussions(client, target.id);
        const data = { course: { id: target.id, name: target.name }, forums };

        if (forums.length === 0) {
          return { text: `${target.name}: no discussion forums.`, data };
        }

        const lines = [`${target.name} — discussions`, ""];
        for (const forum of forums) {
          lines.push(`▸ ${forum.name}${forum.isLocked ? "  [locked]" : ""}`);
          if (forum.description) {
            lines.push(`    ${truncate(forum.description, 400).replace(/\n+/g, "\n    ")}`);
          }
          for (const topic of forum.topics) {
            const marks = [
              topic.scoreOutOf !== null ? `graded /${topic.scoreOutOf}` : null,
              topic.dueDate ? `due ${formatDate(topic.dueDate)}` : null,
              topic.isLocked ? "locked" : null,
            ].filter(Boolean);
            lines.push(
              `    · ${topic.name}   topic_id: ${topic.id}` +
                (marks.length ? `   (${marks.join(", ")})` : ""),
            );
          }
          lines.push("");
        }
        return { text: lines.join("\n"), data };
      }),
  );

  server.registerTool(
    "list_discussion_posts",
    {
      title: "List posts in a discussion topic",
      description:
        "The threads in one discussion topic, newest first — who posted, when, how long, how " +
        "many replies, and an opening preview. Deliberately does not include post bodies or " +
        "replies: a topic in a large class runs to hundreds of posts. Use " +
        "get_discussion_thread on a postId to read one conversation in full.",
      inputSchema: z.object({
        course: courseArg,
        topic_id: z.number().describe("Topic id, from list_discussions."),
        limit: z
          .number()
          .min(1)
          .max(200)
          .optional()
          .describe("How many threads to return, newest first. Defaults to 50."),
        offset: z
          .number()
          .min(0)
          .optional()
          .describe("Skip this many threads, for reading past the first page."),
        author: z
          .string()
          .optional()
          .describe("Only threads started by someone whose name contains this."),
      }),
      outputSchema: listDiscussionPostsOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ course: reference, topic_id, limit, offset, author }) =>
      guardStructured(async () => {
        const target = await course(reference);
        const found = await findTopic(client, target.id, topic_id);
        if (!found) {
          throw new Error(
            `No discussion topic with id ${topic_id} in ${target.name}. Call list_discussions for the ids.`,
          );
        }

        const threads = await getTopicPosts(client, target.id, found.forum.id, topic_id);
        let summaries = summariseThreads(threads);
        if (author) {
          const needle = author.toLowerCase();
          summaries = summaries.filter((t) => t.author.toLowerCase().includes(needle));
        }

        const start = offset ?? 0;
        const page = summaries.slice(start, start + (limit ?? 50));
        const data = {
          course: { id: target.id, name: target.name },
          topic: { id: found.topic.id, name: found.topic.name, description: found.topic.description },
          threads: page,
          totalThreads: summaries.length,
          returned: page.length,
        };

        if (page.length === 0) {
          return {
            text: author
              ? `${found.topic.name}: no threads started by anyone matching "${author}".`
              : `${found.topic.name}: no posts yet.`,
            data,
          };
        }

        const lines = [
          `${found.topic.name} — ${summaries.length} thread(s)` +
            (page.length < summaries.length ? `, showing ${start + 1}-${start + page.length}` : ""),
          "",
        ];
        for (const thread of page) lines.push(renderThreadSummary(thread), "");
        if (start + page.length < summaries.length) {
          lines.push(
            `${summaries.length - start - page.length} more thread(s). Pass offset: ${start + page.length} to continue.`,
          );
        }
        return { text: lines.join("\n"), data };
      }),
  );

  server.registerTool(
    "get_discussion_thread",
    {
      title: "Read a discussion thread",
      description:
        "One discussion thread in full: the original post and every reply beneath it, nested. " +
        "Post ids come from list_discussion_posts.",
      inputSchema: z.object({
        course: courseArg,
        topic_id: z.number().describe("Topic id, from list_discussions."),
        post_id: z.number().describe("postId of the thread to read, from list_discussion_posts."),
      }),
      outputSchema: getDiscussionThreadOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ course: reference, topic_id, post_id }) =>
      guardStructured(async () => {
        const target = await course(reference);
        const found = await findTopic(client, target.id, topic_id);
        if (!found) {
          throw new Error(`No discussion topic with id ${topic_id} in ${target.name}.`);
        }

        const threads = await getTopicPosts(client, target.id, found.forum.id, topic_id);
        const thread = findPost(threads, post_id);
        const data = {
          course: { id: target.id, name: target.name },
          topic: { id: found.topic.id, name: found.topic.name },
          thread,
          totalPosts: thread ? countPosts(thread) : 0,
        };

        if (!thread) {
          return {
            text: `No post with id ${post_id} in "${found.topic.name}". Call list_discussion_posts for the ids.`,
            data,
          };
        }

        return {
          text: [
            `${found.topic.name} — ${countPosts(thread)} post(s)`,
            "",
            renderPost(thread, 0),
          ].join("\n"),
          data,
        };
      }),
  );
}

function renderThreadSummary(thread: ReturnType<typeof summariseThreads>[number]): string {
  const marks = [
    thread.isPinned ? "PINNED" : null,
    thread.unreadReplies > 0 ? `${thread.unreadReplies} unread` : null,
    thread.attachmentCount > 0 ? `${thread.attachmentCount} attachment(s)` : null,
  ].filter(Boolean);

  return [
    `${thread.subject}${marks.length ? `  [${marks.join(", ")}]` : ""}`,
    `  ${thread.author} · ${formatDate(thread.postedAt)}` +
      (thread.wordCount !== null ? ` · ${thread.wordCount} words` : "") +
      ` · ${thread.replyCount} repl${thread.replyCount === 1 ? "y" : "ies"}`,
    thread.lastReplyAt
      ? `  last reply ${formatDate(thread.lastReplyAt)} by ${thread.lastReplyBy}`
      : null,
    thread.preview ? `  ${thread.preview}` : null,
    `  post_id: ${thread.postId}`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * Renders a post and its replies, indenting each level so the shape of the conversation shows.
 *
 * `inheritedSubject` carries the subject already printed above. Brightspace copies the root
 * subject onto every reply, so printing it again would repeat the same line six times and hide
 * the only thing that actually differs — who wrote it. A reply whose subject genuinely differs
 * still gets its own heading.
 */
function renderPost(post: DiscussionPost, depth: number, inheritedSubject = ""): string {
  const pad = "  ".repeat(depth);
  const subject = post.subject || "(no subject)";
  const isEcho = depth > 0 && subject === inheritedSubject;

  const heading = isEcho
    ? `${pad}└ ${post.author} replied`
    : `${pad}${depth === 0 ? "" : "└ "}${subject}`;

  const byline = isEcho
    ? `${pad}  ${formatDate(post.postedAt)}`
    : `${pad}  ${post.author} · ${formatDate(post.postedAt)}`;

  const lines = [
    heading,
    byline + (post.attachmentCount > 0 ? ` · ${post.attachmentCount} attachment(s)` : ""),
    "",
    post.body ? `${pad}  ${post.body.replace(/\n+/g, `\n${pad}  `)}` : `${pad}  (empty post)`,
    "",
  ];
  for (const reply of post.replies) lines.push(renderPost(reply, depth + 1, subject));
  return lines.join("\n");
}

// --------------------------------------------------------------------------- announcements

function registerAnnouncements(server: McpServer, client: D2LClient, course: CourseResolver): void {
  server.registerTool(
    "get_announcements",
    {
      title: "Get announcements",
      description:
        "Announcements (News) posted in a course, newest first. This is where instructors put " +
        "schedule changes, exam details, and corrections.",
      inputSchema: z.object({
        course: courseArg,
        limit: z.number().min(1).max(50).optional().describe("How many to return. Defaults to 10."),
      }),
      outputSchema: getAnnouncementsOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ course: reference, limit }) =>
      guardStructured(async () => {
        const target = await course(reference);
        const announcements = (await listAnnouncements(client, target.id)).slice(0, limit ?? 10);
        const data = { course: { id: target.id, name: target.name }, announcements };

        if (announcements.length === 0) {
          return { text: `${target.name}: no announcements.`, data };
        }

        return {
          text: [
            `${target.name} — announcements`,
            "",
            ...announcements.map((a) =>
              [`${a.title}  (${formatDate(a.startDate)})`, a.body, ""].join("\n"),
            ),
          ].join("\n"),
          data,
        };
      }),
  );
}

// --------------------------------------------------------------------------- upcoming

function registerUpcoming(server: McpServer, client: D2LClient): void {
  server.registerTool(
    "get_upcoming",
    {
      title: "Upcoming deadlines",
      description:
        "Everything due soon across every course, earliest first. This is the right tool for " +
        "\"what do I have due this week\" — it checks all courses at once, so there is no need " +
        "to call list_assignments per course.",
      inputSchema: z.object({
        within_days: z
          .number()
          .min(1)
          .max(120)
          .optional()
          .describe("How far ahead to look. Defaults to 14 days."),
        include_submitted: z
          .boolean()
          .optional()
          .describe("Include work already submitted. Defaults to false."),
      }),
      outputSchema: getUpcomingOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ within_days, include_submitted }) =>
      guardStructured(async () => {
        const days = within_days ?? 14;
        const { deadlines, courses, failures } = await getUpcoming(client, {
          withinDays: days,
          includeSubmitted: include_submitted ?? false,
        });

        const now = Date.now();
        const overdue = deadlines.filter((d) => Date.parse(d.dueDate) < now);
        const ahead = deadlines.filter((d) => Date.parse(d.dueDate) >= now);

        // `isOverdue` is computed here so a client does not have to compare timestamps to
        // work out something the text version states plainly.
        const data = {
          deadlines: deadlines.map((d) => ({ ...d, isOverdue: Date.parse(d.dueDate) < now })),
          withinDays: days,
          coursesChecked: courses.length,
        };

        if (deadlines.length === 0) {
          return {
            text: [
              `Nothing due in the next ${days} days across ${courses.length} course(s).`,
              include_submitted
                ? ""
                : "Submitted work is hidden — pass include_submitted to see it.",
            ]
              .filter(Boolean)
              .join("\n"),
            data,
          };
        }

        const lines = [`Deadlines in the next ${days} days across ${courses.length} course(s):`];
        if (overdue.length > 0) {
          lines.push("", `— OVERDUE (${overdue.length}) —`, ...overdue.map(renderDeadline));
        }
        if (ahead.length > 0) {
          lines.push("", `— UPCOMING (${ahead.length}) —`, ...ahead.map(renderDeadline));
        }
        if (failures.length > 0) {
          lines.push("", `Note: could not read ${failures.join("; ")}.`);
        }
        return { text: lines.join("\n"), data };
      }),
  );
}

function renderDeadline(d: Deadline): string {
  return [
    `${d.name}  [${d.kind}]`,
    `  ${d.courseName}`,
    `  due: ${formatDate(d.dueDate)}${d.submitted === true ? "   SUBMITTED" : ""}${d.outOf !== null ? `   out of ${d.outOf}` : ""}`,
  ].join("\n");
}
