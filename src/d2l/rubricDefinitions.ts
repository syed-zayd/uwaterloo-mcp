/**
 * Unmarked rubrics — the criteria and level descriptors, before anything is graded.
 *
 * `rubrics.ts` reads a rubric that has already been *filled in* for one submission. This reads
 * the rubric itself: what the work will be judged on and what each level of each criterion
 * requires. Those are different objects behind different APIs, and the second one is the one a
 * student wants while they are still writing.
 *
 * Getting at it takes one page fetch, for the same reason a graded rubric does. The definition
 * lives on `rubrics.api.brightspace.com`, on a per-tenant host whose id appears nowhere a
 * student can look it up — but Brightspace's own preview page carries the absolute URL in its
 * markup, so the page is read once to learn the address and everything after that is JSON.
 *
 * The shape is a small tree: a rubric holds criteria groups, a group holds criteria and the
 * levels shared across them, and each criterion holds one cell per level with that cell's
 * points and description. The cells are what a reader actually needs — "2 points: provides a
 * concrete, realistic and elaborative example" — so they are what this returns.
 */

import type { D2LClient } from "./client.js";
import { richText } from "./format.js";

export interface RubricLevelCell {
  /** Points this level awards for this criterion. */
  points: number | null;
  /** The level's own name. Often "." or empty when a rubric labels only the points. */
  levelName: string | null;
  /** What the work has to do to earn this level. */
  description: string;
}

export interface RubricCriterionDefinition {
  name: string;
  outOf: number | null;
  levels: RubricLevelCell[];
}

export interface RubricCriterionGroup {
  name: string;
  outOf: number | null;
  criteria: RubricCriterionDefinition[];
}

export interface RubricDefinition {
  rubricId: number;
  name: string | null;
  outOf: number | null;
  description: string;
  groups: RubricCriterionGroup[];
}

interface SirenEntity {
  class?: string[];
  rel?: string[];
  properties?: Record<string, unknown>;
  entities?: SirenEntity[];
  links?: Array<{ rel: string[]; href: string }>;
}

/** `/d2l/lp/rubrics/preview.d2l?ou=…&rubricId=…` — where a rubric link lands. */
const PREVIEW_PATH = "/d2l/lp/rubrics/preview.d2l";

/**
 * Finds the rubrics a page links to.
 *
 * Course pages link a rubric either directly at the preview page or through a quicklink that
 * redirects to it; an assignment's own submission page lists the rubrics attached to it. Both
 * spellings are matched here so a caller does not have to know which one a page used.
 */
export async function findRubricPreviews(
  client: D2LClient,
  path: string,
): Promise<Array<{ rubricId: number; url: string }>> {
  const html = await client.fetchText(path).catch(() => "");
  if (!html) return [];

  const unescaped = html.split("\\/").join("/");
  const found = new Map<number, string>();

  for (const match of unescaped.matchAll(
    /\/d2l\/(?:lp\/rubrics\/preview\.d2l|common\/dialogs\/quickLink\/quickLink\.d2l)\?[^"'\\\s<>]+/g,
  )) {
    const url = match[0].replace(/&amp;/g, "&");
    if (url.includes("quickLink") && !/type=rubric/i.test(url)) continue;

    const rubricId = Number(/[?&]rubricId=(\d+)/i.exec(url)?.[1]);
    // A quicklink names the rubric by code rather than id; it is still worth following, and
    // the id arrives with the page it redirects to. Those are keyed by 0 until resolved.
    const key = Number.isFinite(rubricId) && rubricId > 0 ? rubricId : 0;
    if (!found.has(key)) found.set(key, url);
  }

  return [...found].map(([rubricId, url]) => ({ rubricId, url }));
}

/**
 * Reads a rubric definition, following the preview page to the hypermedia service.
 *
 * `pageUrl` is any URL that renders the rubric — a preview link or a quicklink to one. Returns
 * null when the page carries no rubric, which is the normal answer for an activity that has
 * none rather than a failure.
 */
export async function fetchRubricDefinition(
  client: D2LClient,
  pageUrl: string,
): Promise<RubricDefinition | null> {
  const html = await client.fetchText(pageUrl).catch(() => "");
  if (!html) return null;

  const rubricHref = /https:\/\/[a-z0-9-]+\.rubrics\.api\.brightspace\.com\/organizations\/\d+\/\d+/i
    .exec(html.split("\\/").join("/"))?.[0];
  if (!rubricHref) return null;

  const bearer = await client.getBearerToken();
  const get = async (url: string): Promise<SirenEntity | null> => {
    const response = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!response?.ok) return null;
    return (await response.json().catch(() => null)) as SirenEntity | null;
  };

  const root = await get(rubricHref);
  if (!root) return null;

  const groupsHref = linkHref(root, "criteria-groups");
  const groups = groupsHref ? await readGroups(get, groupsHref) : [];

  return {
    rubricId: Number(/\/(\d+)$/.exec(rubricHref)?.[1] ?? 0),
    name: stringOrNull(root.properties?.["name"]),
    outOf: numberOrNull(root.properties?.["outOf"]),
    description: sirenText(root.entities?.find((e) => e.class?.includes("description"))),
    groups,
  };
}

async function readGroups(
  get: (url: string) => Promise<SirenEntity | null>,
  groupsHref: string,
): Promise<RubricCriterionGroup[]> {
  const collection = await get(groupsHref);
  const groupEntities = collection?.entities?.filter((e) => e.class?.includes("criteria-group")) ?? [];

  // Groups are read together rather than in sequence: a rubric with four of them would
  // otherwise cost four round trips before the first criterion is known.
  return (
    await Promise.all(
      groupEntities.map(async (group): Promise<RubricCriterionGroup> => {
        const criteriaHref = linkHref(group, "criteria");
        const criteria = criteriaHref ? await readCriteria(get, criteriaHref) : [];
        return {
          name: cleanText(group.properties?.["name"]) ?? "(unnamed)",
          outOf: numberOrNull(group.properties?.["outOf"]),
          criteria,
        };
      }),
    )
  ).filter((group) => group.criteria.length > 0 || group.name !== "(unnamed)");
}

async function readCriteria(
  get: (url: string) => Promise<SirenEntity | null>,
  criteriaHref: string,
): Promise<RubricCriterionDefinition[]> {
  const collection = await get(criteriaHref);
  const entities = collection?.entities?.filter((e) => e.class?.includes("criterion")) ?? [];

  return entities.map((criterion) => {
    const cells = (criterion.entities ?? []).filter((e) => e.class?.includes("criterion-cell"));
    const levels = cells
      .map((cell): RubricLevelCell => {
        const description = cell.entities?.find((e) => e.class?.includes("description"));
        return {
          points: numberOrNull(cell.properties?.["points"]),
          levelName: cleanText(cell.properties?.["levelName"]),
          description: sirenText(description),
        };
      })
      // Highest first, which is the order a rubric is read in and the order a marker works down.
      .sort((a, b) => (b.points ?? 0) - (a.points ?? 0));

    return {
      name: cleanText(criterion.properties?.["name"]) ?? "(unnamed)",
      outOf: numberOrNull(criterion.properties?.["outOf"]),
      levels,
    };
  });
}

/** The href of the first link whose rel ends in `/name`. */
function linkHref(entity: SirenEntity, name: string): string | null {
  const link = entity.links?.find((l) => l.rel.some((rel) => rel.endsWith(`/${name}`)));
  return link?.href ?? null;
}

function sirenText(entity: SirenEntity | undefined): string {
  const text = entity?.properties?.["text"];
  if (typeof text === "string" && text.trim()) return text.replace(/\s+/g, " ").trim();
  const html = entity?.properties?.["html"];
  return typeof html === "string" ? richText({ Html: html }) : "";
}

/** Rubric text routinely carries hard line breaks from the editor; they are noise here. */
function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned || null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Where an activity's rubrics are linked, by the tool that owns it. */
export function activityRubricPage(courseId: number, folderId: number): string {
  return `/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${folderId}&ou=${courseId}`;
}

/** The preview page for a rubric whose id is already known. */
export function rubricPreviewPath(courseId: number, rubricId: number): string {
  return `${PREVIEW_PATH}?ou=${courseId}&rubricId=${rubricId}`;
}
