/**
 * Course enrollments.
 *
 * Every other tool needs a course id, and a model cannot guess one, so this is the entry point
 * to the whole server: it lists the courses the signed-in user is enrolled in, with the ids the
 * other tools take.
 */

import type { D2LClient } from "./client.js";
import type { MyOrgUnitInfo } from "./types.js";

/** Org unit type 3 is a course offering; the rest are semesters, departments, and templates. */
const COURSE_OFFERING_TYPE = 3;

export interface Course {
  id: number;
  name: string;
  code: string | null;
  isActive: boolean;
  startDate: string | null;
  endDate: string | null;
  lastAccessed: string | null;
  isPinned: boolean;
}

export async function listCourses(
  client: D2LClient,
  options: { includeInactive?: boolean } = {},
): Promise<Course[]> {
  const enrollments = await client.paged<MyOrgUnitInfo>(
    `/enrollments/myenrollments/?orgUnitTypeId=${COURSE_OFFERING_TYPE}`,
  );

  const courses = enrollments
    .filter((e) => e.OrgUnit?.Type?.Id === COURSE_OFFERING_TYPE)
    .map(
      (e): Course => ({
        id: e.OrgUnit.Id,
        name: e.OrgUnit.Name,
        code: e.OrgUnit.Code,
        // `CanAccess` is the meaningful signal: a course can be "active" by date yet closed to
        // the student, and vice versa during an extension.
        isActive: e.Access?.CanAccess !== false && e.Access?.IsActive !== false,
        startDate: e.Access?.StartDate ?? null,
        endDate: e.Access?.EndDate ?? null,
        lastAccessed: e.Access?.LastAccessed ?? null,
        isPinned: e.PinDate !== null && e.PinDate !== undefined,
      }),
    );

  const filtered = options.includeInactive ? courses : courses.filter((c) => c.isActive);

  // Pinned first (the user chose those), then most recently visited: both are better proxies
  // for "the course I mean" than alphabetical order.
  return filtered.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    const at = a.lastAccessed ? Date.parse(a.lastAccessed) : 0;
    const bt = b.lastAccessed ? Date.parse(b.lastAccessed) : 0;
    if (at !== bt) return bt - at;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Resolves a user-supplied course reference to an id.
 *
 * Models routinely pass "CS 240" or "Earth 270" rather than an id, and a wrong id silently
 * returns another course's data, so matching is deliberately conservative: exact id, then exact
 * code, then unambiguous substring. An ambiguous match is an error rather than a guess.
 */
export function resolveCourse(courses: Course[], reference: string): Course {
  const query = reference.trim();

  const byId = courses.find((c) => String(c.id) === query);
  if (byId) return byId;

  const normalise = (value: string): string => value.toLowerCase().replace(/[\s_-]+/g, "");
  const target = normalise(query);

  const exact = courses.filter(
    (c) => (c.code && normalise(c.code) === target) || normalise(c.name) === target,
  );
  if (exact.length === 1) return exact[0]!;

  const partial = courses.filter(
    (c) => normalise(c.name).includes(target) || (c.code && normalise(c.code).includes(target)),
  );
  if (partial.length === 1) return partial[0]!;

  if (partial.length > 1) {
    const options = partial.map((c) => `${c.name} (id ${c.id})`).join(", ");
    throw new Error(`"${reference}" matches several courses: ${options}. Use the course id.`);
  }

  const available = courses.map((c) => `${c.name} (id ${c.id})`).join(", ");
  throw new Error(
    `No course matches "${reference}". Available courses: ${available || "none found"}.`,
  );
}
