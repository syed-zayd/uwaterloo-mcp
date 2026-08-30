/**
 * Discussions.
 *
 * Brightspace nests these three deep: a course has forums, a forum has topics, and a topic
 * holds posts that reply to one another. The API mirrors that — posts are fetched per
 * forum-and-topic, not per topic alone — so a caller holding only a topic id has to be told
 * which forum owns it before anything can be read.
 *
 * Replies are reconstructed from `ParentPostId`. The `ReplyPostIds` field looks like it should
 * serve, but comes back empty even on posts that plainly have replies.
 */

import type { D2LClient } from "./client.js";
import { richText } from "./format.js";

export interface DiscussionForum {
  id: number;
  name: string;
  description: string;
  isLocked: boolean;
  topics: DiscussionTopic[];
}

export interface DiscussionTopic {
  id: number;
  forumId: number;
  name: string;
  description: string;
  isLocked: boolean;
  /** Set when the topic is graded. */
  scoreOutOf: number | null;
  dueDate: string | null;
  startDate: string | null;
  endDate: string | null;
  /** How many posts have been made, when Brightspace reports it. */
  postCount: number | null;
}

export interface DiscussionPost {
  id: number;
  topicId: number;
  threadId: number;
  parentPostId: number | null;
  subject: string;
  body: string;
  author: string;
  postedAt: string | null;
  isRead: boolean;
  isAnonymous: boolean;
  isPinned: boolean;
  attachmentCount: number;
  wordCount: number | null;
  /** Replies to this post, nested to whatever depth the conversation reached. */
  replies: DiscussionPost[];
}

interface RawForum {
  ForumId: number;
  Name: string;
  Description?: { Text?: string; Html?: string } | null;
  IsLocked?: boolean;
  IsHidden?: boolean;
}

interface RawTopic {
  TopicId: number;
  ForumId: number;
  Name: string;
  Description?: { Text?: string; Html?: string } | null;
  IsLocked?: boolean;
  IsHidden?: boolean;
  ScoreOutOf?: number | null;
  DueDate?: string | null;
  StartDate?: string | null;
  EndDate?: string | null;
  ScoredCount?: number | null;
}

interface RawPost {
  PostId: number;
  TopicId: number;
  ThreadId: number;
  ParentPostId?: number | null;
  Subject?: string | null;
  Message?: { Text?: string; Html?: string } | null;
  PostingUserDisplayName?: string | null;
  PostingUserId?: number | null;
  DatePosted?: string | null;
  IsRead?: boolean;
  IsAnonymous?: boolean;
  IsDeleted?: boolean;
  ThreadIsPinned?: boolean;
  AttachmentCount?: number;
  WordCount?: number | null;
}

/** Every forum in a course, each with its topics. */
export async function listDiscussions(
  client: D2LClient,
  courseId: number,
): Promise<DiscussionForum[]> {
  const forums = await client.le<RawForum[]>(`/${courseId}/discussions/forums/`);

  // Topics are fetched per forum, in parallel: a course with several forums would otherwise
  // pay for each round trip in sequence.
  const withTopics = await Promise.all(
    forums
      .filter((forum) => !forum.IsHidden)
      .map(async (forum): Promise<DiscussionForum> => {
        const topics = await client
          .le<RawTopic[]>(`/${courseId}/discussions/forums/${forum.ForumId}/topics/`)
          .catch(() => [] as RawTopic[]);

        return {
          id: forum.ForumId,
          name: forum.Name,
          description: richText(forum.Description),
          isLocked: forum.IsLocked === true,
          topics: topics.filter((t) => !t.IsHidden).map(toTopic),
        };
      }),
  );

  return withTopics;
}

function toTopic(topic: RawTopic): DiscussionTopic {
  return {
    id: topic.TopicId,
    forumId: topic.ForumId,
    name: topic.Name,
    description: richText(topic.Description),
    isLocked: topic.IsLocked === true,
    scoreOutOf: topic.ScoreOutOf ?? null,
    dueDate: topic.DueDate ?? null,
    startDate: topic.StartDate ?? null,
    endDate: topic.EndDate ?? null,
    postCount: topic.ScoredCount ?? null,
  };
}

/**
 * Finds which forum owns a topic.
 *
 * Posts cannot be fetched without the forum id, and a caller naturally has only the topic id —
 * it is what the topic list and the gradebook both hand out.
 */
export async function findTopic(
  client: D2LClient,
  courseId: number,
  topicId: number,
): Promise<{ forum: DiscussionForum; topic: DiscussionTopic } | null> {
  const forums = await listDiscussions(client, courseId);
  for (const forum of forums) {
    const topic = forum.topics.find((t) => t.id === topicId);
    if (topic) return { forum, topic };
  }
  return null;
}

/**
 * Every post in a topic, arranged as threads.
 *
 * The API returns one flat list including replies, so the whole conversation arrives in a
 * single request and the tree is built here rather than by walking it.
 */
export async function getTopicPosts(
  client: D2LClient,
  courseId: number,
  forumId: number,
  topicId: number,
): Promise<DiscussionPost[]> {
  const raw = await client.le<RawPost[]>(
    `/${courseId}/discussions/forums/${forumId}/topics/${topicId}/posts/`,
  );

  const posts = new Map<number, DiscussionPost>();
  for (const post of raw) {
    if (post.IsDeleted) continue;
    posts.set(post.PostId, {
      id: post.PostId,
      topicId: post.TopicId,
      threadId: post.ThreadId,
      parentPostId: post.ParentPostId ?? null,
      subject: (post.Subject ?? "").trim(),
      body: richText(post.Message),
      author: post.IsAnonymous
        ? "(anonymous)"
        : (post.PostingUserDisplayName ?? String(post.PostingUserId ?? "unknown")),
      postedAt: post.DatePosted ?? null,
      isRead: post.IsRead === true,
      isAnonymous: post.IsAnonymous === true,
      isPinned: post.ThreadIsPinned === true,
      attachmentCount: post.AttachmentCount ?? 0,
      wordCount: post.WordCount ?? null,
      replies: [],
    });
  }

  // Attach each reply to its parent. A reply whose parent was deleted would otherwise vanish
  // with it, so it is promoted to the top level instead of being dropped.
  const roots: DiscussionPost[] = [];
  for (const post of posts.values()) {
    const parent = post.parentPostId !== null ? posts.get(post.parentPostId) : undefined;
    if (parent) parent.replies.push(post);
    else roots.push(post);
  }

  const byDate = (a: DiscussionPost, b: DiscussionPost): number =>
    Date.parse(a.postedAt ?? "0") - Date.parse(b.postedAt ?? "0");

  // Replies read chronologically; threads newest first, which is how the topic page shows them.
  const sortReplies = (post: DiscussionPost): void => {
    post.replies.sort(byDate);
    post.replies.forEach(sortReplies);
  };
  roots.forEach(sortReplies);

  return roots.sort((a, b) => byDate(b, a));
}

export interface ThreadSummary {
  postId: number;
  threadId: number;
  subject: string;
  author: string;
  postedAt: string | null;
  /** First line or so of the post, for deciding whether to open it. */
  preview: string;
  wordCount: number | null;
  replyCount: number;
  unreadReplies: number;
  lastReplyAt: string | null;
  lastReplyBy: string | null;
  isPinned: boolean;
  attachmentCount: number;
}

/**
 * One row per conversation, without the conversation itself.
 *
 * A topic in a real class runs to hundreds of posts — this one is 298 KB of bodies across 144
 * posts, and a large course is several times that — so the list deliberately carries none of
 * them. It carries what the Brightspace topic page shows when deciding what to open: who
 * posted, when, how long it is, how many replies, and how many are unread.
 *
 * Replies are excluded entirely rather than summarised. Brightspace copies the root subject
 * onto every reply, so a flat list would repeat the same title dozens of times with nothing to
 * tell the rows apart.
 */
export function summariseThreads(threads: DiscussionPost[]): ThreadSummary[] {
  return threads.map((thread) => {
    const replies = flatten(thread).slice(1);
    const newest = replies.reduce<DiscussionPost | null>(
      (latest, reply) =>
        latest === null || Date.parse(reply.postedAt ?? "0") > Date.parse(latest.postedAt ?? "0")
          ? reply
          : latest,
      null,
    );

    return {
      postId: thread.id,
      threadId: thread.threadId,
      subject: thread.subject || "(no subject)",
      author: thread.author,
      postedAt: thread.postedAt,
      preview: preview(thread.body),
      wordCount: thread.wordCount,
      replyCount: replies.length,
      unreadReplies: replies.filter((reply) => !reply.isRead).length,
      lastReplyAt: newest?.postedAt ?? null,
      lastReplyBy: newest?.author ?? null,
      isPinned: thread.isPinned,
      attachmentCount: thread.attachmentCount,
    };
  });
}

/** Every post in a thread, root first. */
function flatten(post: DiscussionPost): DiscussionPost[] {
  return [post, ...post.replies.flatMap(flatten)];
}

/** Enough to tell one post from another, cut at a word boundary. */
function preview(body: string, max = 200): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Finds one post and its replies within an already-built thread list. */
export function findPost(posts: DiscussionPost[], postId: number): DiscussionPost | null {
  for (const post of posts) {
    if (post.id === postId) return post;
    const found = findPost(post.replies, postId);
    if (found) return found;
  }
  return null;
}

/** Total posts in a thread, counting the root. */
export function countPosts(post: DiscussionPost): number {
  return 1 + post.replies.reduce((sum, reply) => sum + countPosts(reply), 0);
}
