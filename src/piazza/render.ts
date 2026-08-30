/**
 * Field-selective rendering of Piazza posts.
 *
 * MCP responses compete for the model's context window, so callers choose exactly which fields
 * come back. Two rules shape everything here:
 *
 *  1. **Nothing is emitted that was not asked for.** No headers, labels, or Piazza boilerplate
 *     for absent fields — an unrequested field costs zero tokens.
 *  2. **Cheap and deep fields are distinguished.** Cheap fields come from the feed, which returns
 *     hundreds of posts in one request. Deep fields (`content`, answers, follow-ups) need a
 *     separate fetch per post, so asking for them is what limits how many posts you can get.
 *
 * Two traps this handles, both found by inspecting real API responses:
 *  - Body text lives in `history[0].content` for posts and answers, but in `subject` for
 *    follow-ups and replies.
 *  - Authorship is recorded per revision, not on the node.
 */

import { htmlToMarkdown } from "./html-to-markdown.js";
import type {
  PiazzaContentNode,
  PiazzaFeedItem,
  PiazzaPost,
  PiazzaUser,
} from "./types.js";

export type UserMap = Map<string, PiazzaUser>;

/** Every selectable field. `number` is always present — it is how posts are referenced. */
export const POST_FIELDS = [
  "title",
  "author",
  "created",
  "updated",
  "folders",
  "tags",
  "type",
  "views",
  "answer_status",
  "pinned",
  "snippet",
  "url",
  "activity",
  "content",
  "instructor_answer",
  "student_answer",
  "followups",
  "previous_version",
] as const;

export type PostField = (typeof POST_FIELDS)[number];

/** Fields that require fetching the individual post rather than reading the feed. */
export const DEEP_FIELDS: readonly PostField[] = [
  "content",
  "instructor_answer",
  "student_answer",
  "followups",
  "previous_version",
];

export function needsFullPost(fields: readonly PostField[]): boolean {
  return fields.some((f) => DEEP_FIELDS.includes(f));
}

export interface RenderContext {
  courseId: string;
  users?: UserMap;
}

const STAFF_ROLES = new Set(["professor", "instructor", "ta", "admin"]);

export function isStaff(user: PiazzaUser | undefined): boolean {
  return STAFF_ROLES.has((user?.role ?? "").toLowerCase());
}

function roleLabel(user: PiazzaUser | undefined): string {
  const role = (user?.role ?? "").toLowerCase();
  if (role === "professor") return "Professor";
  if (role === "ta") return "TA";
  if (role === "instructor" || role === "admin") return "Instructor";
  if (role === "student") return "Student";
  return "";
}

/** Piazza stores some names with stray internal whitespace ("Robyn  Bhola"). */
function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/** Trim to minutes; seconds are noise and cost tokens on every row. */
function fmtDate(iso: string | undefined): string {
  if (!iso) return "";
  return iso.replace(/:\d{2}Z?$/, "").replace("T", " ");
}

export function postUrl(courseId: string, postNumber: number | string): string {
  return `https://piazza.com/class/${courseId}/post/${postNumber}`;
}

/** Whether staff wrote the post or answered it. */
export function involvesStaff(item: PiazzaFeedItem): boolean {
  if (item.has_i) return true;
  return (item.tags ?? []).some((t) => t.startsWith("instructor-"));
}

export function isByInstructor(item: PiazzaFeedItem): boolean {
  return (item.tags ?? []).some((t) => t.startsWith("instructor-"));
}

export function isPinned(item: PiazzaFeedItem): boolean {
  return Boolean(item.pin) || (item.tags ?? []).includes("pin");
}

/** System markers Piazza mixes into `tags` alongside real folder names. */
const SYSTEM_TAGS = /^(a\d+|pq\d+|pin|student|instructor-\w+|unanswered|no_history)$/;

function realTags(item: PiazzaFeedItem): string[] {
  return (item.tags ?? []).filter((t) => !SYSTEM_TAGS.test(t));
}

/** Authorship is per revision; a node's own uid/anon are usually undefined. */
function authorInfo(node: PiazzaContentNode): { uid?: string; anon?: string } {
  const original = node.history?.[node.history.length - 1];
  return { uid: node.uid ?? original?.uid, anon: node.anon ?? original?.anon };
}

function nameFor(uid: string | undefined, anon: string | undefined, users?: UserMap): string {
  const anonymity = (anon ?? "no").toLowerCase();
  if (anonymity !== "no" && anonymity !== "") return "Anonymous";
  const user = uid ? users?.get(uid) : undefined;
  if (!user?.name) return uid ? "Unknown" : "Unknown";
  const role = roleLabel(user);
  return role ? `${cleanName(user.name)} (${role})` : cleanName(user.name);
}

function authorOf(node: PiazzaContentNode, users?: UserMap): string {
  const { uid, anon } = authorInfo(node);
  return nameFor(uid, anon, users);
}

/** The original poster of a feed item, taken from its `create` log entry. */
function feedAuthor(item: PiazzaFeedItem, users?: UserMap): string {
  const created = (item.log ?? []).find((e) => e.n === "create") ?? (item.log ?? [])[0];
  return nameFor(created?.u, undefined, users);
}

/**
 * Extract a node's text. The fallback chain is ordered most- to least-specific rather than
 * switching on `type`, so an unfamiliar node type still yields its text instead of nothing.
 */
export function nodeText(node: PiazzaContentNode): string {
  const fromHistory = node.history?.[0]?.content;
  if (fromHistory?.trim()) return htmlToMarkdown(fromHistory);
  if (node.content?.trim()) return htmlToMarkdown(node.content);
  if (node.subject?.trim()) return htmlToMarkdown(node.subject);
  return "";
}

function nodeTitle(node: PiazzaContentNode): string {
  const fromHistory = node.history?.[node.history.length - 1]?.subject;
  const raw = fromHistory?.trim() ? fromHistory : node.subject;
  return htmlToMarkdown(raw).replace(/\n+/g, " ").trim();
}

/** Every user id in a thread, so roles can be resolved in one batched call. */
export function collectUserIds(node: PiazzaContentNode, into: Set<string> = new Set()): string[] {
  if (node.uid) into.add(node.uid);
  for (const rev of node.history ?? []) if (rev.uid) into.add(rev.uid);
  for (const e of node.tag_endorse ?? []) if (e.id) into.add(e.id);
  for (const child of node.children ?? []) collectUserIds(child, into);
  return [...into];
}

/**
 * Endorsement marker.
 *
 * `tag_endorse` mixes instructor endorsements with student "helpful" votes, and conflating them
 * is misleading: an instructor endorsement means the course vouches for the answer, while a
 * student vote means other students liked it. Only the former is reported as ENDORSED.
 */
function endorsement(node: PiazzaContentNode, users?: UserMap): string {
  const endorsers = (node.tag_endorse ?? []).map((e) => users?.get(e.id) ?? e);
  const staff = endorsers.filter(isStaff);
  const students = endorsers.length - staff.length;

  const parts: string[] = [];
  if (staff.length > 0) {
    const names = staff.map((u) => `${cleanName(u.name ?? "instructor")} (${roleLabel(u)})`);
    parts.push(`ENDORSED by ${names.join(", ")}`);
  } else if (node.is_tag_endorse) {
    parts.push("ENDORSED by an instructor");
  }
  if (students > 0) parts.push(`${students} student${students === 1 ? "" : "s"} found this helpful`);

  return parts.length > 0 ? ` [${parts.join("; ")}]` : "";
}

function answerStatus(item: PiazzaFeedItem): string {
  const bits: string[] = [];
  if (item.has_i) bits.push("instructor-answered");
  else if (item.has_s) bits.push("student-answered");
  else if (item.type === "question") bits.push("unanswered");
  if ((item.no_answer_followup ?? 0) > 0) bits.push(`${item.no_answer_followup} open follow-ups`);
  return bits.join(", ");
}

const ACTIVITY_LABELS: Record<string, string> = {
  create: "created",
  update: "edited",
  followup: "follow-up",
  feedback: "reply",
  i_answer: "instructor answer",
  i_answer_update: "instructor answer edited",
  s_answer: "student answer",
  s_answer_update: "student answer edited",
};

/**
 * Condensed activity timeline. Repeated identical events are collapsed — a post edited eleven
 * times otherwise produces eleven near-identical lines and buries everything else.
 */
function activityLine(item: PiazzaFeedItem, users?: UserMap, since?: Date): string {
  const events = (item.log ?? []).filter((e) => !since || (e.t && new Date(e.t) >= since));
  if (events.length === 0) return "";

  const grouped = new Map<string, { event: string; uid: string; count: number; latest: string }>();
  for (const e of events) {
    const key = `${e.n} ${e.u}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      if (e.t > existing.latest) existing.latest = e.t;
    } else {
      grouped.set(key, { event: e.n, uid: e.u, count: 1, latest: e.t });
    }
  }

  return [...grouped.values()]
    .sort((a, b) => (a.latest < b.latest ? 1 : -1))
    .map((g) => {
      const who = users?.get(g.uid);
      const label = ACTIVITY_LABELS[g.event] ?? g.event;
      const times = g.count > 1 ? `×${g.count}` : "";
      const byline = who?.name ? ` by ${cleanName(who.name)}` : "";
      return `${fmtDate(g.latest)} ${label}${times}${byline}`;
    })
    .join("; ");
}

/**
 * One-line summary containing only the requested cheap fields.
 *
 * Format is `@nr` followed by ` · `-separated values, so a listing of hundreds stays scannable
 * and costs a few tokens per post.
 */
export function renderSummary(
  item: PiazzaFeedItem,
  fields: readonly PostField[],
  ctx: RenderContext,
  since?: Date,
): string {
  const want = new Set(fields);
  const head: string[] = [];

  if (want.has("pinned") && isPinned(item)) head.push("[PINNED]");
  head.push(`@${item.nr}`);
  if (want.has("type") && item.type) head.push(`(${item.type})`);
  if (want.has("title")) head.push(nodeTitle(item as PiazzaContentNode) || "(no subject)");

  const meta: string[] = [];
  if (want.has("author")) meta.push(feedAuthor(item, ctx.users));
  if (want.has("created") && item.created) meta.push(`created ${fmtDate(item.created)}`);
  if (want.has("updated")) {
    const when = item.modified ?? item.updated ?? item.created;
    if (when) meta.push(fmtDate(when));
  }
  if (want.has("folders") && item.folders?.length) meta.push(item.folders.join("/"));
  if (want.has("tags")) {
    const tags = realTags(item);
    if (tags.length) meta.push(`tags: ${tags.join(",")}`);
  }
  if (want.has("views") && typeof item.unique_views === "number") meta.push(`${item.unique_views} views`);
  if (want.has("answer_status")) {
    const status = answerStatus(item);
    if (status) meta.push(status);
  }
  if (want.has("url")) meta.push(postUrl(ctx.courseId, item.nr));

  const lines = [head.join(" ") + (meta.length ? `  ·  ${meta.join(" · ")}` : "")];

  if (want.has("activity")) {
    const activity = activityLine(item, ctx.users, since);
    if (activity) lines.push(`    ${activity}`);
  }
  if (want.has("snippet")) {
    const snip = htmlToMarkdown(item.highlighted_snipet ?? item.content_snipet)
      .replace(/\n+/g, " ")
      .trim();
    if (snip) lines.push(`    ${snip.slice(0, 220)}`);
  }

  return lines.join("\n");
}

/**
 * Full rendering of a fetched thread, again limited to requested fields.
 *
 * Endorsements always accompany an answer that has one — they are what distinguishes the
 * authoritative answer from a plausible one, and are useless if omitted.
 */
export function renderPost(
  post: PiazzaPost,
  fields: readonly PostField[],
  ctx: RenderContext,
): string {
  const want = new Set(fields);
  const out: string[] = [];

  const head: string[] = [];
  if (want.has("pinned") && (post.tags ?? []).includes("pin")) head.push("[PINNED]");
  head.push(`@${post.nr}`);
  if (want.has("type") && post.type) head.push(`(${post.type})`);
  if (want.has("title")) head.push(nodeTitle(post) || "(no subject)");
  out.push(`# ${head.join(" ")}`);

  const meta: string[] = [];
  if (want.has("author")) meta.push(authorOf(post, ctx.users));
  if (want.has("created")) {
    const created = post.history?.[post.history.length - 1]?.created ?? post.created;
    if (created) meta.push(`created ${fmtDate(created)}`);
  }
  if (want.has("updated")) {
    const updated = post.history?.[0]?.created ?? post.updated;
    if (updated) meta.push(`updated ${fmtDate(updated)}`);
  }
  if (want.has("folders") && post.folders?.length) meta.push(post.folders.join("/"));
  if (want.has("tags")) {
    const tags = (post.tags ?? []).filter((t) => !SYSTEM_TAGS.test(t));
    if (tags.length) meta.push(`tags: ${tags.join(",")}`);
  }
  if (want.has("views") && typeof post.unique_views === "number") meta.push(`${post.unique_views} views`);
  if (want.has("url")) meta.push(postUrl(ctx.courseId, post.nr));
  if (meta.length) out.push(meta.join(" · "));

  if (want.has("activity") && post.change_log?.length) {
    const events = post.change_log
      .slice(0, 12)
      .map((c) => {
        const who = c.uid ? users(ctx, c.uid) : "";
        return `${fmtDate(c.when)} ${ACTIVITY_LABELS[c.type ?? ""] ?? c.type ?? "change"}${who ? ` by ${who}` : ""}`;
      })
      .join("; ");
    if (events) out.push(events);
  }

  if (want.has("content")) {
    const body = nodeText(post);
    if (body) out.push("", body);
  }

  if (want.has("previous_version")) {
    const previous = post.history?.[1];
    const previousText = previous ? htmlToMarkdown(previous.content) : "";
    if (previousText) out.push("", `## Previous version (${fmtDate(previous!.created)})`, previousText);
  }

  const children = post.children ?? [];

  if (want.has("instructor_answer")) {
    for (const node of children.filter((c) => c.type === "i_answer")) {
      out.push(
        "",
        `## Instructor answer — ${authorOf(node, ctx.users)} · ${fmtDate(node.updated ?? node.created)}${endorsement(node, ctx.users)}`,
      );
      const body = nodeText(node);
      if (body) out.push(body);
    }
  }

  if (want.has("student_answer")) {
    for (const node of children.filter((c) => c.type === "s_answer")) {
      out.push(
        "",
        `## Student answer — ${authorOf(node, ctx.users)} · ${fmtDate(node.updated ?? node.created)}${endorsement(node, ctx.users)}`,
      );
      const body = nodeText(node);
      if (body) out.push(body);
    }
  }

  if (want.has("followups")) {
    let index = 0;
    for (const node of children.filter((c) => c.type === "followup")) {
      index += 1;
      const unresolved = (node.no_answer ?? 0) > 0 ? " · UNRESOLVED" : "";
      out.push(
        "",
        `## Follow-up ${index} — ${authorOf(node, ctx.users)} · ${fmtDate(node.created)}${unresolved}`,
      );
      const body = nodeText(node);
      if (body) out.push(body);

      for (const reply of node.children ?? []) {
        out.push(
          "",
          `### Reply — ${authorOf(reply, ctx.users)} · ${fmtDate(reply.created)}${endorsement(reply, ctx.users)}`,
        );
        const replyBody = nodeText(reply);
        if (replyBody) out.push(replyBody);
      }
    }
  }

  if (want.has("answer_status")) {
    const hasInstructor = children.some((c) => c.type === "i_answer");
    const hasStudent = children.some((c) => c.type === "s_answer");
    const status = hasInstructor
      ? "instructor-answered"
      : hasStudent
        ? "student-answered"
        : post.type === "question"
          ? "unanswered"
          : "";
    if (status) out.push("", status);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function users(ctx: RenderContext, uid: string): string {
  const user = ctx.users?.get(uid);
  return user?.name ? cleanName(user.name) : "";
}
