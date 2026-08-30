/**
 * Grades.
 *
 * Valence exposes grades in two halves that have to be joined: `grades/` describes the grade
 * items an instructor defined (name, max points, weight), while `grades/values/myGradeValues/`
 * holds what the student actually scored. Neither is much use alone — a value knows its own
 * name but not what it was out of unless the item says so.
 */

import type { D2LClient } from "./client.js";
import { richText } from "./format.js";
import type { GradeObject, GradeValue } from "./types.js";

export interface Grade {
  id: string;
  name: string;
  displayed: string | null;
  points: number | null;
  outOf: number | null;
  weight: number | null;
  percentage: number | null;
  comments: string;
  lastModified: string | null;
  isBonus: boolean;
  /**
   * True for a category subtotal ("Quizzes") rather than a single assessment.
   *
   * Valence returns these alongside real grades in the same list. They must not be averaged
   * with their own children — a category counts its members once already, so including it
   * double-counts — but they are worth showing, because the category total is what actually
   * feeds the final grade.
   */
  isCategory: boolean;
  /**
   * The activity backing this grade item, when there is one.
   *
   * Its presence is what makes a rubric reachable — `get_rubric` needs it to find the page
   * carrying the signed assessment link — so it is surfaced rather than kept internal.
   */
  activity?: { toolId: number; toolItemId: number; kind: string } | null;
  /**
   * Categories only: performance across the members that have been graded, ignoring the ones
   * that have not. `percentage` on a category counts ungraded work as zero, which answers
   * "how much of this category have I banked" — a different and less useful question than
   * "how am I doing in it".
   */
  gradedPercentage?: number | null;
  /** Categories only: how many members are graded so far. */
  gradedCount?: number;
}

export interface GradeReport {
  grades: Grade[];
  final: { displayed: string | null; points: number | null; outOf: number | null } | null;
}

/** Only the tools whose activity pages are known to expose a graded rubric. */
const TOOL_KINDS: Record<number, string> = { 1: "assignment", 2: "quiz", 3000: "discussion" };

function describeActivity(
  tool: { ToolId?: number; ToolItemId?: number } | null | undefined,
): Grade["activity"] {
  if (!tool?.ToolId || !tool.ToolItemId) return null;
  const kind = TOOL_KINDS[tool.ToolId];
  return kind ? { toolId: tool.ToolId, toolItemId: tool.ToolItemId, kind } : null;
}

export async function getGrades(client: D2LClient, courseId: number): Promise<GradeReport> {
  // Fetched together: the two halves are independent, and a course with many grade items
  // otherwise pays for two sequential round trips.
  const [values, objects, final] = await Promise.all([
    client.le<GradeValue[]>(`/${courseId}/grades/values/myGradeValues/`).catch(() => []),
    client.le<GradeObject[]>(`/${courseId}/grades/`).catch(() => []),
    client
      .le<GradeValue>(`/${courseId}/grades/final/values/myGradeValue`)
      .catch(() => null),
  ]);

  const byId = new Map(objects.map((o) => [String(o.Id), o]));

  const grades = values.map((value): Grade => {
    const object = byId.get(String(value.GradeObjectIdentifier));
    const points = value.PointsNumerator ?? null;
    const outOf = value.PointsDenominator ?? object?.MaxPoints ?? null;

    // For a category, the weighted pair is marks-toward-the-final-grade: `14.22 / 25` means
    // quizzes are worth 25% of the course and 14.22 of those points are banked. The raw pair
    // normalises that to 100 ("56.9/100"), which looks like a score and is not one.
    const isCategory = value.GradeObjectTypeName === "Category";
    const weightedNumerator = value.WeightedNumerator ?? null;
    const weightedDenominator = value.WeightedDenominator ?? null;

    return {
      id: String(value.GradeObjectIdentifier),
      name: value.GradeObjectName || object?.Name || "(unnamed)",
      displayed: value.DisplayedGrade ?? null,
      points: isCategory ? weightedNumerator : points,
      outOf: isCategory ? weightedDenominator : outOf,
      weight: object?.Weight ?? (isCategory ? weightedDenominator : null),
      // Derived from the same pair that is displayed, so the percentage cannot contradict the
      // points beside it. For a category that means the weighted pair, not the raw one.
      percentage: isCategory
        ? weightedNumerator !== null && weightedDenominator
          ? (weightedNumerator / weightedDenominator) * 100
          : null
        : points !== null && outOf
          ? (points / outOf) * 100
          : null,
      // Read through richText, not `.Text`: Brightspace fills the HTML half and leaves the
      // plain-text half empty, so reading `.Text` directly loses every instructor comment.
      comments: richText(value.Comments),
      lastModified: value.LastModified ?? null,
      isBonus: object?.IsBonus ?? false,
      isCategory,
      activity: describeActivity(object?.AssociatedTool),
    };
  });

  // Only what the values endpoint returns is reported. An item the instructor defined but has
  // not marked is absent from that list, and inventing a row for it invites the reader to
  // treat a blank as a zero — which is a different and much worse claim. A real zero, such as
  // a missed quiz, does come back as a value and appears normally.

  // A category's weighted pair counts its ungraded members as zero, so "14.22/25" understates
  // performance whenever work is outstanding. Averaging the children that *are* graded gives
  // the number a student actually wants: how they are doing on the quizzes so far.
  const childrenByCategory = new Map<string, Grade[]>();
  for (const object of objects) {
    if (object.CategoryId == null) continue;
    const child = grades.find((g) => g.id === String(object.Id));
    if (!child || child.percentage === null) continue;
    const key = String(object.CategoryId);
    childrenByCategory.set(key, [...(childrenByCategory.get(key) ?? []), child]);
  }

  for (const grade of grades) {
    if (!grade.isCategory) continue;
    const children = childrenByCategory.get(grade.id) ?? [];
    if (children.length === 0) continue;

    const points = children.reduce((sum, c) => sum + (c.points ?? 0), 0);
    const outOf = children.reduce((sum, c) => sum + (c.outOf ?? 0), 0);
    grade.gradedPercentage = outOf > 0 ? (points / outOf) * 100 : null;
    grade.gradedCount = children.length;
  }

  return {
    grades,
    final: final
      ? {
          displayed: final.DisplayedGrade ?? null,
          points: final.PointsNumerator ?? null,
          outOf: final.PointsDenominator ?? null,
        }
      : null,
  };
}

/**
 * Weighted average of everything graded so far.
 *
 * This answers "how am I doing?" — deliberately *not* the same as a final grade, which counts
 * unmarked work as zero. Bonus items are excluded from the denominator so they can only help,
 * which is how Brightspace treats them.
 */
export function currentAverage(grades: Grade[]): number | null {
  // Categories carry the course's real weighting — "quizzes are 25% of the final grade" — so
  // when they exist they are the correct basis: average each category's achieved percentage
  // weighted by what it is worth, ignoring categories with nothing graded yet. Using the
  // individual items instead would weight a 5% quiz the same as a 40% exam.
  const categories = grades.filter(
    (g) => g.isCategory && g.gradedPercentage != null && g.outOf,
  );
  if (categories.length > 0) {
    const weight = categories.reduce((sum, c) => sum + (c.outOf ?? 0), 0);
    if (weight > 0) {
      return categories.reduce((sum, c) => sum + c.gradedPercentage! * (c.outOf ?? 0), 0) / weight;
    }
  }

  // No categories: fall back to the individual items.
  const scored = grades.filter((g) => g.percentage !== null && !g.isBonus && !g.isCategory);
  if (scored.length === 0) return null;

  const weighted = scored.filter((g) => g.weight !== null && g.weight > 0);
  if (weighted.length > 0) {
    const total = weighted.reduce((sum, g) => sum + g.weight!, 0);
    if (total > 0) {
      return weighted.reduce((sum, g) => sum + g.percentage! * g.weight!, 0) / total;
    }
  }

  // No weights defined: fall back to points earned over points possible, which matches how a
  // points-based gradebook actually totals.
  const points = scored.reduce((sum, g) => sum + (g.points ?? 0), 0);
  const outOf = scored.reduce((sum, g) => sum + (g.outOf ?? 0), 0);
  return outOf > 0 ? (points / outOf) * 100 : null;
}
