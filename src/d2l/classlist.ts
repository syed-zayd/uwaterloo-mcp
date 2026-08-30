/**
 * Course classlist and groups.
 *
 * The Brightspace classlist page offers search by first name, last name, username or email,
 * plus filters for role, online status and group. None of that is an API — it is a stateful
 * HTML form carrying `d2l_stateScopes` and tab ids, which would be miserable to drive and
 * would break on the next UI change.
 *
 * It does not need to be. The Valence classlist route returns every enrolled person in one
 * request with all the fields those filters act on, so the filtering happens here instead:
 * one predictable request, and searches the UI cannot do (several fields at once) come free.
 *
 * Group membership is the exception — it genuinely lives elsewhere, under group categories,
 * and is fetched separately.
 */

import type { D2LClient } from "./client.js";
import { richText } from "./format.js";

export interface ClassMember {
  id: string;
  displayName: string;
  firstName: string;
  lastName: string;
  /** Institutional email, when the org publishes it. */
  email: string | null;
  username: string | null;
  /**
   * The institution's own label — "Instructor", "TA - Level 4", "Staff/Librarian".
   *
   * Passed through verbatim rather than mapped onto a fixed set: each institution invents its
   * own, so no mapping could be right everywhere.
   */
  role: string;
  pronouns: string | null;
  lastAccessed: string | null;
  isOnline: boolean;
  /** Groups this person belongs to, when group data was fetched. */
  groups: string[];
}

export interface CourseGroup {
  id: number;
  name: string;
  code: string | null;
  description: string;
  categoryId: number;
  categoryName: string;
  /** User ids, which map onto ClassMember.id. */
  memberIds: string[];
}

interface RawClasslistUser {
  Identifier: string;
  DisplayName?: string | null;
  FirstName?: string | null;
  LastName?: string | null;
  Email?: string | null;
  Username?: string | null;
  RoleId?: number | null;
  ClasslistRoleDisplayName?: string | null;
  Pronouns?: string | null;
  LastAccessed?: string | null;
  IsOnline?: boolean;
}

interface RawGroupCategory {
  GroupCategoryId: number;
  Name?: string | null;
  Groups?: number[] | null;
}

interface RawGroup {
  GroupId: number;
  Name?: string | null;
  Code?: string | null;
  Description?: { Text?: string; Html?: string } | null;
  Enrollments?: number[] | null;
}

/**
 * A guess at how "teaching" a role is, used only for sort order.
 *
 * Deliberately not used for filtering. Role labels are strings each institution invents —
 * "TA - Level 4", "Staff/Librarian", "Group Manager" are UWaterloo's — so any pattern here is
 * a guess. Getting the order slightly wrong is cosmetic; getting a filter wrong would
 * silently hide people.
 */
function sortRank(role: string): number {
  if (/instructor|professor|lecturer|faculty/i.test(role) && !/\bTA\b/i.test(role)) return 0;
  if (/\bTA\b|teaching assistant|marker|grader/i.test(role)) return 1;
  if (/librarian|staff|manager|coordinator|admin/i.test(role)) return 2;
  if (/\bguest\b|observer|auditor/i.test(role)) return 4;
  if (/^test\b|\btest (student|user)\b/i.test(role)) return 5;
  return 3;
}

/** Which fields a search term is matched against. */
export type SearchField = "name" | "first_name" | "last_name" | "username" | "email";

export interface ClasslistOptions {
  search?: string | undefined;
  searchIn?: SearchField[] | undefined;
  /** Exact role label, case-insensitive. Role labels come back in `roleCounts`. */
  role?: string | undefined;
  onlineOnly?: boolean | undefined;
  /** Group name, matched loosely — group names are chosen by instructors. */
  group?: string | undefined;
  includeGroups?: boolean | undefined;
}

export interface Classlist {
  members: ClassMember[];
  /** Every distinct role in the course with how many hold it, counted before filtering. */
  roleCounts: Array<{ role: string; count: number }>;
  groups: CourseGroup[];
  totalMembers: number;
  /** How many the filters excluded. */
  filteredOut: number;
}

export async function getClasslist(
  client: D2LClient,
  courseId: number,
  options: ClasslistOptions = {},
): Promise<Classlist> {
  const [raw, groups] = await Promise.all([
    client.le<RawClasslistUser[]>(`/${courseId}/classlist/`),
    options.includeGroups === false
      ? Promise.resolve([] as CourseGroup[])
      : getCourseGroups(client, courseId).catch(() => [] as CourseGroup[]),
  ]);

  // Inverted once rather than scanned per member: a course with forty groups and hundreds of
  // people would otherwise be a quadratic lookup.
  const groupsByMember = new Map<string, string[]>();
  for (const group of groups) {
    for (const id of group.memberIds) {
      groupsByMember.set(id, [...(groupsByMember.get(id) ?? []), group.name]);
    }
  }

  const everyone = raw.map((user): ClassMember => {
    const id = String(user.Identifier);
    return {
      id,
      displayName:
        user.DisplayName?.trim() || `${user.FirstName ?? ""} ${user.LastName ?? ""}`.trim(),
      firstName: user.FirstName?.trim() ?? "",
      lastName: user.LastName?.trim() ?? "",
      email: user.Email?.trim() || null,
      username: user.Username?.trim() || null,
      role: user.ClasslistRoleDisplayName?.trim() || "Unknown",
      pronouns: user.Pronouns?.trim() || null,
      lastAccessed: user.LastAccessed ?? null,
      isOnline: user.IsOnline === true,
      groups: groupsByMember.get(id) ?? [],
    };
  });

  // Counted across everyone, so the totals stay honest however the list is filtered.
  const counts = new Map<string, number>();
  for (const member of everyone) counts.set(member.role, (counts.get(member.role) ?? 0) + 1);
  const roleCounts = [...counts]
    .map(([role, count]) => ({ role, count }))
    .sort((a, b) => sortRank(a.role) - sortRank(b.role) || b.count - a.count);

  const members = everyone
    .filter((member) => matches(member, options))
    // Brightspace returns no useful order, so one is imposed: whoever runs the course first.
    .sort(
      (a, b) => sortRank(a.role) - sortRank(b.role) || a.displayName.localeCompare(b.displayName),
    );

  return {
    members,
    roleCounts,
    groups,
    totalMembers: everyone.length,
    filteredOut: everyone.length - members.length,
  };
}

function matches(member: ClassMember, options: ClasslistOptions): boolean {
  if (options.onlineOnly && !member.isOnline) return false;

  if (options.role && member.role.toLowerCase() !== options.role.toLowerCase().trim()) {
    return false;
  }

  if (options.group) {
    const needle = options.group.toLowerCase().trim();
    if (!member.groups.some((g) => g.toLowerCase().includes(needle))) return false;
  }

  if (options.search) {
    const needle = options.search.toLowerCase().trim();
    // Defaults to every identifying field, which is what someone holding only a name wants.
    const fields = options.searchIn?.length
      ? options.searchIn
      : (["name", "username", "email"] as SearchField[]);

    const haystacks = fields.flatMap((field): string[] => {
      switch (field) {
        case "name":
          return [member.displayName, `${member.firstName} ${member.lastName}`];
        case "first_name":
          return [member.firstName];
        case "last_name":
          return [member.lastName];
        case "username":
          return [member.username ?? ""];
        case "email":
          return [member.email ?? ""];
      }
    });

    if (!haystacks.some((h) => h.toLowerCase().includes(needle))) return false;
  }

  return true;
}

/**
 * Every group in a course, across all categories.
 *
 * Categories are fetched first, then each category's groups in one request — the collection
 * route returns each group's full enrolment list, so forty project groups cost one call rather
 * than forty.
 */
export async function getCourseGroups(
  client: D2LClient,
  courseId: number,
): Promise<CourseGroup[]> {
  const categories = await client.lp<RawGroupCategory[]>(`/${courseId}/groupcategories/`);

  const perCategory = await Promise.all(
    categories.map(async (category): Promise<CourseGroup[]> => {
      const groups = await client
        .lp<RawGroup[]>(`/${courseId}/groupcategories/${category.GroupCategoryId}/groups/`)
        .catch(() => [] as RawGroup[]);

      return groups.map((group) => ({
        id: group.GroupId,
        name: group.Name?.trim() || `Group ${group.GroupId}`,
        code: group.Code?.trim() || null,
        description: richText(group.Description),
        categoryId: category.GroupCategoryId,
        categoryName: category.Name?.trim() || `Category ${category.GroupCategoryId}`,
        memberIds: (group.Enrollments ?? []).map(String),
      }));
    }),
  );

  return perCategory.flat();
}
