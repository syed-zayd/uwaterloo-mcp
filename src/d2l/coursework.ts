/**
 * Assignments, quizzes, announcements, and content.
 *
 * These are separate Valence resources but share a shape — a titled thing with dates and
 * optional body text — so they live together and are rendered the same way.
 */

import type { D2LClient } from "./client.js";
import { richText, truncate } from "./format.js";
import type { ContentNode, DropboxFolder, NewsItem, QuizInfo } from "./types.js";
import { ACTIVITY_TYPE, CONTENT_TYPE_TOPIC } from "./types.js";

// --------------------------------------------------------------------------- assignments

export interface Assignment {
  id: number;
  name: string;
  dueDate: string | null;
  availableFrom: string | null;
  availableUntil: string | null;
  outOf: number | null;
  /**
   * Whether the user has submitted — `null` when D2L declines to say.
   *
   * Brightspace returns `-1` for the submission counters when the caller is a student, since
   * the totals are an instructor-facing statistic. Reading that as zero would report "not
   * submitted" for work that has been handed in, which is the worst possible direction for
   * this particular error, so an unknown stays unknown.
   */
  submitted: boolean | null;
  hasFeedback: boolean | null;
  instructions: string;
  isGroup: boolean;
}

/** Brightspace uses -1 for "not disclosed to this caller" on instructor-facing counters. */
function disclosedCount(value: number | undefined): boolean | null {
  if (value === undefined || value < 0) return null;
  return value > 0;
}

export async function listAssignments(client: D2LClient, courseId: number): Promise<Assignment[]> {
  const folders = await client.le<DropboxFolder[]>(`/${courseId}/dropbox/folders/`);

  return folders
    .map(
      (f): Assignment => ({
        id: f.Id,
        name: f.Name,
        dueDate: f.DueDate,
        availableFrom: f.Availability?.StartDate ?? null,
        availableUntil: f.Availability?.EndDate ?? null,
        outOf: f.Assessment?.ScoreDenominator ?? null,
        submitted: disclosedCount(f.TotalUsersWithSubmissions),
        hasFeedback: disclosedCount(f.TotalUsersWithFeedback),
        instructions: richText(f.CustomInstructions),
        isGroup: f.GroupTypeId != null,
      }),
    )
    .sort(byDueDate);
}

// --------------------------------------------------------------------------- quizzes

export interface Quiz {
  id: number;
  name: string;
  dueDate: string | null;
  startDate: string | null;
  endDate: string | null;
  attempts: string | null;
}

export async function listQuizzes(client: D2LClient, courseId: number): Promise<Quiz[]> {
  // Quizzes are paged in some versions and a bare array in others; both are handled.
  const response = await client.le<QuizInfo[] | { Objects?: QuizInfo[] }>(`/${courseId}/quizzes/`);
  const quizzes = Array.isArray(response) ? response : (response.Objects ?? []);

  return quizzes
    .map(
      (q): Quiz => ({
        id: q.QuizId,
        name: q.Name,
        dueDate: q.DueDate,
        startDate: q.StartDate,
        endDate: q.EndDate,
        attempts: q.AttemptsAllowed
          ? q.AttemptsAllowed.IsUnlimited
            ? "unlimited"
            : String(q.AttemptsAllowed.NumberOfAttemptsAllowed ?? "?")
          : null,
      }),
    )
    .sort(byDueDate);
}

// --------------------------------------------------------------------------- announcements

export interface Announcement {
  id: number;
  title: string;
  body: string;
  startDate: string | null;
  endDate: string | null;
}

export async function listAnnouncements(
  client: D2LClient,
  courseId: number,
  options: { maxBodyChars?: number } = {},
): Promise<Announcement[]> {
  const items = await client.le<NewsItem[]>(`/${courseId}/news/`);
  const max = options.maxBodyChars ?? 1500;

  return items
    .filter((n) => !n.IsHidden)
    .map(
      (n): Announcement => ({
        id: n.Id,
        title: n.Title,
        body: truncate(richText(n.Body), max),
        startDate: n.StartDate,
        endDate: n.EndDate,
      }),
    )
    .sort((a, b) => Date.parse(b.startDate ?? "0") - Date.parse(a.startDate ?? "0"));
}

// --------------------------------------------------------------------------- content

export interface ContentItem {
  kind: "module" | "topic";
  id: number;
  title: string;
  depth: number;
  type: string | null;
  url: string | null;
  dueDate: string | null;
  isLocked: boolean;
  /** True when the topic is a file this server can download and read. */
  isReadable: boolean;
}

/** Extensions we can turn into text, when a URL is available to judge by. */
const READABLE_EXTENSION = /\.(pdf|txt|md|html?|csv|json|pptx?|docx?)$/i;
/** Activity types that have a downloadable file behind them (1 = File, 3 = HTML page). */
const FILE_ACTIVITY_TYPES = new Set([1, 3]);

/**
 * Flattens the course content tree, expanding modules as needed.
 *
 * `content/root/` returns only the top-level modules, each with a `Structure` array holding its
 * children — so one request usually yields two levels. Deeper modules arrive unexpanded, and
 * are fetched individually. `maxRequests` bounds that: a large course could otherwise issue
 * dozens of round trips inside a single tool call.
 */
export async function getContent(
  client: D2LClient,
  courseId: number,
  options: { maxRequests?: number } = {},
): Promise<ContentItem[]> {
  let budget = options.maxRequests ?? 25;
  const items: ContentItem[] = [];

  const toItem = (node: ContentNode, depth: number): ContentItem => {
    const isTopic = node.Type === CONTENT_TYPE_TOPIC;
    const url = node.Url ?? null;
    return {
      kind: isTopic ? "topic" : "module",
      id: node.Id,
      title: node.Title,
      depth,
      type: isTopic ? (ACTIVITY_TYPE[node.ActivityType ?? 0] ?? null) : null,
      url,
      dueDate: node.DueDate ?? node.ModuleDueDate ?? node.EndDate ?? node.ModuleEndDate ?? null,
      isLocked: node.IsLocked === true,
      // `Structure` entries carry an ActivityType but no Url, so the type is the reliable
      // signal — judging on the URL alone marked a course's entire slide deck unreadable.
      // A URL is still consulted when present, since it catches file topics whose type is
      // reported as something looser.
      isReadable:
        isTopic &&
        (FILE_ACTIVITY_TYPES.has(node.ActivityType ?? 0) ||
          (!!url && READABLE_EXTENSION.test(url.split("?")[0] ?? ""))),
    };
  };

  const walk = async (nodes: ContentNode[], depth: number): Promise<void> => {
    for (const node of nodes) {
      if (node.IsHidden) continue;

      if (node.Type === CONTENT_TYPE_TOPIC) {
        items.push(toItem(node, depth));
        continue;
      }

      items.push(toItem(node, depth));

      // The `Structure` inlined by `content/root/` is only a stub — id, title, and type, with
      // no ActivityType or Url — so it cannot tell us whether a topic is a readable file.
      // Anything that shallow is refetched from the module's own structure endpoint, which
      // returns complete nodes. Budget bounds the walk: an unbounded one would make a single
      // tool call take minutes on a large course.
      const inlined = node.Structure ?? null;
      const isStub =
        inlined !== null &&
        inlined.some((child) => child.Type === CONTENT_TYPE_TOPIC && child.ActivityType === undefined);

      let children = inlined;
      if ((children === null || isStub) && budget > 0) {
        budget--;
        const fetched = await client
          .le<ContentNode[]>(`/${courseId}/content/modules/${node.Id}/structure/`)
          .catch(() => null);
        if (fetched) children = fetched;
      }
      if (children?.length) await walk(children, depth + 1);
    }
  };

  await walk(await client.le<ContentNode[]>(`/${courseId}/content/root/`), 0);
  return items;
}

/** Fetches one content node, including its description. */
export async function getTopic(
  client: D2LClient,
  courseId: number,
  topicId: number,
): Promise<ContentNode> {
  return client.le<ContentNode>(`/${courseId}/content/topics/${topicId}`);
}

// --------------------------------------------------------------------------- shared

/** Sorts by due date, undated last: an item with no deadline is never the urgent one. */
function byDueDate(a: { dueDate: string | null }, b: { dueDate: string | null }): number {
  if (!a.dueDate && !b.dueDate) return 0;
  if (!a.dueDate) return 1;
  if (!b.dueDate) return -1;
  return Date.parse(a.dueDate) - Date.parse(b.dueDate);
}
