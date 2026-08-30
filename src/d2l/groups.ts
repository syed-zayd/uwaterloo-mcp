/**
 * Groups.
 *
 * Brightspace has two levels and the names invite confusion. A **category** (D2L also calls it
 * a group set) is the scheme — "Project", "Discussion Groups", a QUEST-imported lecture
 * section. A **group** is one team inside it. CS 247's "Project" category holds forty groups,
 * one per team, so reporting "Project" as though it were a group of forty people is wrong.
 *
 * Discussion topics attach to a *category*, not a group: EARTH 270's "Discussion Post 1" is
 * restricted to the "Discussion Groups" set, and each student sees only their own group's
 * threads. The link is `GroupTypeId` on the topic matching `GroupCategoryId` on the category.
 */

import type { D2LClient } from "./client.js";
import { richText } from "./format.js";
import { getCourseGroups, type CourseGroup } from "./classlist.js";

export interface GroupCategory {
  id: number;
  name: string;
  description: string;
  /** Cap on group size, when the category sets one. */
  maxUsersPerGroup: number | null;
  groups: GroupSummary[];
  /** Discussion topics restricted to this set of groups. */
  discussionTopics: Array<{ id: number; name: string; forumName: string }>;
}

export interface GroupSummary {
  id: number;
  name: string;
  code: string | null;
  description: string;
  memberCount: number;
  /** True when the signed-in user is a member. */
  isMine: boolean;
}

export interface GroupDetail extends GroupSummary {
  categoryId: number;
  categoryName: string;
  members: Array<{
    id: string;
    displayName: string;
    email: string | null;
    role: string;
    isOnline: boolean;
  }>;
  discussionTopics: Array<{ id: number; name: string; forumName: string }>;
}

interface RawCategory {
  GroupCategoryId: number;
  Name?: string | null;
  Description?: { Text?: string; Html?: string } | null;
  MaxUsersPerGroup?: number | null;
}

/**
 * Every group set in a course, with its groups and any discussion topics bound to it.
 *
 * `userId` marks which groups the caller is in — the answer to "who is on my team" starts by
 * knowing which team is yours.
 */
export async function listGroupCategories(
  client: D2LClient,
  courseId: number,
  userId: string | null,
): Promise<GroupCategory[]> {
  const [categories, groups, topicsByCategory] = await Promise.all([
    client.lp<RawCategory[]>(`/${courseId}/groupcategories/`),
    getCourseGroups(client, courseId),
    getGroupLinkedTopics(client, courseId).catch(() => new Map<number, GroupCategory["discussionTopics"]>()),
  ]);

  return categories.map((category): GroupCategory => {
    const mine = groups.filter((g) => g.categoryId === category.GroupCategoryId);
    return {
      id: category.GroupCategoryId,
      name: category.Name?.trim() || `Category ${category.GroupCategoryId}`,
      description: richText(category.Description),
      maxUsersPerGroup: category.MaxUsersPerGroup ?? null,
      groups: mine
        .map((group) => toSummary(group, userId))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
      discussionTopics: topicsByCategory.get(category.GroupCategoryId) ?? [],
    };
  });
}

function toSummary(group: CourseGroup, userId: string | null): GroupSummary {
  return {
    id: group.id,
    name: group.name,
    code: group.code,
    description: group.description,
    memberCount: group.memberIds.length,
    isMine: userId !== null && group.memberIds.includes(userId),
  };
}

/**
 * Discussion topics indexed by the group category they are restricted to.
 *
 * A topic carries `GroupTypeId`, which is a group *category* id despite the name. Where it is
 * set, every student sees only the threads from their own group within that set.
 */
async function getGroupLinkedTopics(
  client: D2LClient,
  courseId: number,
): Promise<Map<number, GroupCategory["discussionTopics"]>> {
  const forums = await client.le<Array<{ ForumId: number; Name?: string | null }>>(
    `/${courseId}/discussions/forums/`,
  );

  const byCategory = new Map<number, GroupCategory["discussionTopics"]>();

  await Promise.all(
    forums.map(async (forum) => {
      const topics = await client
        .le<Array<{ TopicId: number; Name?: string | null; GroupTypeId?: number | null }>>(
          `/${courseId}/discussions/forums/${forum.ForumId}/topics/`,
        )
        .catch(() => []);

      for (const topic of topics) {
        if (!topic.GroupTypeId) continue;
        const entry = {
          id: topic.TopicId,
          name: topic.Name?.trim() ?? "",
          forumName: forum.Name?.trim() ?? "",
        };
        byCategory.set(topic.GroupTypeId, [...(byCategory.get(topic.GroupTypeId) ?? []), entry]);
      }
    }),
  );

  return byCategory;
}

/**
 * One group, resolved by name or id, with its members named rather than left as ids.
 *
 * Matching is exact-then-unambiguous-substring, the same rule course lookup uses: "Pineapple"
 * should find the group, but a term matching four groups is an error rather than a guess.
 */
export async function getGroup(
  client: D2LClient,
  courseId: number,
  reference: string,
  members: Array<{ id: string; displayName: string; email: string | null; role: string; isOnline: boolean }>,
  userId: string | null,
): Promise<GroupDetail> {
  const [groups, topicsByCategory] = await Promise.all([
    getCourseGroups(client, courseId),
    getGroupLinkedTopics(client, courseId).catch(() => new Map<number, GroupCategory["discussionTopics"]>()),
  ]);

  const group = resolveGroup(groups, reference);
  const byId = new Map(members.map((m) => [m.id, m]));

  return {
    ...toSummary(group, userId),
    categoryId: group.categoryId,
    categoryName: group.categoryName,
    members: group.memberIds
      .map((id) => byId.get(id))
      .filter((m): m is (typeof members)[number] => m !== undefined)
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    discussionTopics: topicsByCategory.get(group.categoryId) ?? [],
  };
}

function resolveGroup(groups: CourseGroup[], reference: string): CourseGroup {
  const query = reference.trim();

  const byId = groups.find((g) => String(g.id) === query);
  if (byId) return byId;

  const normalise = (value: string): string => value.toLowerCase().replace(/[\s_-]+/g, "");
  const target = normalise(query);

  const exact = groups.filter((g) => normalise(g.name) === target);
  if (exact.length === 1) return exact[0]!;

  const partial = groups.filter((g) => normalise(g.name).includes(target));
  if (partial.length === 1) return partial[0]!;

  if (partial.length > 1) {
    throw new Error(
      `"${reference}" matches several groups: ${partial.map((g) => g.name).join(", ")}. Use the group id.`,
    );
  }
  throw new Error(
    `No group matches "${reference}". Call list_groups to see them.`,
  );
}
