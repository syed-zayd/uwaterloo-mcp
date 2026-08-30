/**
 * Graded rubrics.
 *
 * Rubrics are not part of the Valence API a student can reach: `/rubrics/` and
 * `/grades/(id)/rubricAssessments/` both answer 404 for a non-instructor. What the browser
 * actually opens is a popup backed by a separate hypermedia service —
 * `assessments.api.brightspace.com` — which speaks Siren and authenticates with the bearer
 * token minted from the session cookie, not with the cookie itself.
 *
 * One page fetch is unavoidable. The service authorises on a signed URL whose middle segment
 * is a 32-byte HMAC: a forged signature is rejected with 400 and an omitted one with 404, and
 * no endpoint lists a user's assessments, so the href can only come from the page that already
 * contains it. Everything after that point is JSON.
 *
 * The shape is a small graph rather than a document: the assessment lists link pairs, one to
 * the criterion definition (its name and maximum) and one to the assessment of that criterion
 * (the score awarded). Both halves are needed — the assessment alone is numeric ids and
 * scores, with nothing a reader could identify.
 *
 * Because this costs a page fetch plus two requests per criterion, it is a separate tool
 * rather than part of `get_grades`; a course with several rubric-graded items would otherwise
 * make one gradebook lookup cost dozens of round trips.
 */

import type { D2LClient } from "./client.js";
import { richText, truncate } from "./format.js";

/** EVAL_T values, as they appear in the popup URL. */
export const EVAL_TYPE = {
  dropbox: 1,
  quiz: 2,
  discussion: 5,
} as const;

export interface RubricCriterion {
  name: string;
  score: number | null;
  outOf: number | null;
  levelName: string | null;
  feedback: string;
}

export interface GradedRubric {
  rubricName: string | null;
  activityName: string | null;
  score: number | null;
  outOf: number | null;
  overallFeedback: string;
  criteria: RubricCriterion[];
}

interface SirenEntity {
  class?: string[];
  rel?: string[];
  properties?: Record<string, unknown>;
  entities?: SirenEntity[];
  links?: Array<{ rel: string[]; href: string }>;
}

/**
 * Finds the graded-rubric popup a page links to.
 *
 * Brightspace renders `D2L.LP.Web.UI.Html.Dom.OpenWindow(... rubrics_assessment_results.d2l ...)`
 * into the page's script payload, JSON-escaped. Reading it back is how we learn both the rubric
 * id and the exact query string, neither of which is derivable from the grade item.
 */
export async function findRubricPopups(
  client: D2LClient,
  path: string,
): Promise<Array<{ rubricId: number; url: string }>> {
  const html = await client.fetchText(path).catch(() => "");
  if (!html) return [];

  const unescaped = html.split("\\/").join("/");
  const found = new Map<number, string>();

  for (const match of unescaped.matchAll(
    /\/d2l\/lms\/competencies\/rubric\/rubrics_assessment_results\.d2l\?[^"'\\\s]+/g,
  )) {
    const url = match[0].replace(/&amp;/g, "&");
    const rubricId = Number(/[?&]rubricId=(\d+)/.exec(url)?.[1]);
    if (Number.isFinite(rubricId) && rubricId > 0 && !found.has(rubricId)) {
      found.set(rubricId, url);
    }
  }

  return [...found].map(([rubricId, url]) => ({ rubricId, url }));
}

/** Reads the signed `assessment-href` the popup hands to its rubric component. */
export async function findAssessmentHref(client: D2LClient, popupUrl: string): Promise<string | null> {
  const html = await client.fetchText(popupUrl).catch(() => "");
  const href = /assessment-href="([^"]+)"/.exec(html)?.[1];
  return href ? href.replace(/&amp;/g, "&") : null;
}

/**
 * Fetches a graded rubric, resolving every criterion to a name and a score.
 *
 * Criterion pairs are fetched together: a rubric with eight criteria would otherwise cost
 * sixteen sequential round trips.
 */
export async function fetchGradedRubric(
  client: D2LClient,
  assessmentHref: string,
): Promise<GradedRubric | null> {
  const bearer = await client.getBearerToken();
  const get = async (url: string): Promise<SirenEntity | null> => {
    const response = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!response?.ok) return null;
    return (await response.json().catch(() => null)) as SirenEntity | null;
  };

  const root = await get(assessmentHref);
  if (!root) return null;

  const overall = root.entities?.find((e) => e.class?.includes("overall-feedback"));
  const linkGroups = (root.entities ?? []).filter((e) =>
    e.class?.includes("criterion-assessment-links"),
  );

  const criteria = await Promise.all(
    linkGroups.map(async (group): Promise<RubricCriterion | null> => {
      const criterionHref = group.links?.find((l) => l.rel.some((r) => r.endsWith("/criterion")))?.href;
      const assessedHref = group.links?.find((l) =>
        l.rel.some((r) => r.endsWith("/assessment-criterion")),
      )?.href;
      if (!criterionHref || !assessedHref) return null;

      const [definition, assessed] = await Promise.all([get(criterionHref), get(assessedHref)]);
      if (!definition) return null;

      const selected = assessed?.entities?.find((e) => e.class?.includes("selected"));
      const feedbackEntity = assessed?.entities?.find((e) => e.class?.includes("richtext"));

      return {
        // Rubric criterion names routinely contain hard line breaks from the editor.
        name: String(definition.properties?.["name"] ?? "(unnamed)").replace(/\s+/g, " ").trim(),
        score: numberOrNull(assessed?.properties?.["score"] ?? selected?.properties?.["score"]),
        outOf: numberOrNull(definition.properties?.["outOf"]),
        levelName: stringOrNull(selected?.properties?.["name"]),
        feedback: truncate(sirenText(feedbackEntity), 400),
      };
    }),
  );

  return {
    rubricName: stringOrNull(root.properties?.["rubricName"]),
    activityName: stringOrNull(root.properties?.["activityName"]),
    score: numberOrNull(root.properties?.["score"]),
    outOf: criteria.reduce((sum, c) => sum + (c?.outOf ?? 0), 0) || null,
    overallFeedback: sirenText(overall),
    criteria: criteria.filter((c): c is RubricCriterion => c !== null),
  };
}

/** Siren rich text uses lowercase `text`/`html`, unlike the Valence API's capitalised form. */
function sirenText(entity: SirenEntity | undefined): string {
  const text = entity?.properties?.["text"];
  if (typeof text === "string" && text.trim()) return text.trim();
  const html = entity?.properties?.["html"];
  return typeof html === "string" ? richText({ Html: html }) : "";
}

/**
 * Reads every graded rubric attached to a grade item.
 *
 * `AssociatedTool` on the grade object says which activity backs it — `ToolId` 3000 is a
 * discussion topic, 1 a dropbox folder — and that activity's page carries the signed popup
 * links. A grade item with no associated tool, or one whose page shows no rubric, yields an
 * empty array rather than an error: not being rubric-graded is normal.
 */
export async function getRubricsForGradeItem(
  client: D2LClient,
  courseId: number,
  gradeItem: { Id: number; Name: string; AssociatedTool?: { ToolId?: number; ToolItemId?: number } | null },
): Promise<GradedRubric[]> {
  const tool = gradeItem.AssociatedTool;
  if (!tool?.ToolItemId) return [];

  // Only the activity types whose pages are known to embed the rubric popup.
  const page =
    tool.ToolId === 3000
      ? `/d2l/le/${courseId}/discussions/topics/${tool.ToolItemId}/View`
      : tool.ToolId === 1
        ? `/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${tool.ToolItemId}&ou=${courseId}`
        : null;
  if (!page) return [];

  const popups = await findRubricPopups(client, page);
  const rubrics = await Promise.all(
    popups.map(async (popup) => {
      const href = await findAssessmentHref(client, popup.url);
      return href ? fetchGradedRubric(client, href) : null;
    }),
  );

  return rubrics.filter((r): r is GradedRubric => r !== null && r.criteria.length > 0);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
