/**
 * The things a course page links, which the content listing cannot see.
 *
 * `get_course_content` walks the module tree, so it lists topics. But a course's real material
 * is often not a topic at all: an assignment template, a policy PDF, a handout sits in the
 * course's content directory and is reached only by a link inside some page's HTML. Nothing in
 * the module tree mentions it, so to a caller reading the listing it does not exist.
 *
 * This reads one page and reports what it points at: files in the course directory, quicklinks
 * to other course material, and links off the site. That turns "there is an assignment page"
 * into "here is the template it tells you to use, at this path", which is the step a reader
 * otherwise has to make by scraping HTML themselves.
 */

import type { D2LClient } from "./client.js";

export type PageLinkKind = "file" | "quicklink" | "internal" | "external";

export interface PageLink {
  kind: PageLinkKind;
  /** The link's visible text, collapsed to one line. */
  label: string;
  /** For a file: the course path `get_file` takes. */
  path: string | null;
  /** For a quicklink or an external link: the URL as it resolves. */
  url: string | null;
  /** For a quicklink: what it says it points at, and its code. */
  linkType: string | null;
  code: string | null;
}

/**
 * Lists what one page links.
 *
 * `pagePath` is the topic's own `/content/enforced/...` URL, which is also what relative hrefs
 * inside the page resolve against — a page linking `../../media/x.docx` means a path relative
 * to itself, and without the page's own location that link cannot be turned into a usable one.
 */
export async function listPageLinks(
  client: D2LClient,
  courseId: number,
  pagePath: string,
): Promise<PageLink[]> {
  const html = await client.fetchText(pagePath);
  return extractLinks(html, courseId, pagePath);
}

/** Pure half of the above, so the parsing can be exercised without a session. */
export function extractLinks(html: string, courseId: number, pagePath: string): PageLink[] {
  const unescaped = html.split("\\/").join("/");
  const seen = new Set<string>();
  const links: PageLink[] = [];

  for (const match of unescaped.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = (match[1] ?? "").replace(/&amp;/g, "&").trim();
    const label = (match[2] ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Fragments and mailto links are not material; they are navigation and addresses.
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) continue;

    const link = classify(href, label, courseId, pagePath);
    const key = `${link.kind}:${link.path ?? link.url ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(link);
  }

  return links;
}

function classify(href: string, label: string, courseId: number, pagePath: string): PageLink {
  const base = { label, path: null, url: null, linkType: null, code: null };

  if (/quickLink\.d2l/i.test(href)) {
    return {
      ...base,
      kind: "quicklink",
      url: href,
      linkType: /[?&]type=(\w+)/i.exec(href)?.[1]?.toLowerCase() ?? null,
      code: /[?&]rcode=([\w-]+)/i.exec(href)?.[1] ?? null,
    };
  }

  const path = toCoursePath(href, pagePath);
  if (path?.startsWith(`/content/enforced/${courseId}-`)) {
    return { ...base, kind: "file", path };
  }
  if (path) {
    return { ...base, kind: "internal", url: path };
  }

  return { ...base, kind: "external", url: href };
}

/**
 * Resolves an href to a host-relative path, or null when it points off the site.
 *
 * Relative links are the common case inside a course page and the reason this needs the page's
 * own location: `../../media/x.docx` is only meaningful against it. `URL` does the walking,
 * including the `..` segments, so the result is already normalised.
 */
function toCoursePath(href: string, pagePath: string): string | null {
  const host = "https://learn.invalid";
  let resolved: URL;
  try {
    resolved = new URL(href, host + pagePath);
  } catch {
    return null;
  }

  // An absolute link to Brightspace itself is still course material; one to anywhere else is
  // not. Both parse, so the host is what separates them.
  if (resolved.origin !== host) {
    return /(^|\.)learn\.uwaterloo\.ca$/i.test(resolved.hostname)
      ? resolved.pathname + resolved.search
      : null;
  }
  return resolved.pathname + resolved.search;
}
