/**
 * Reads any Learn page the signed-in student can open, the way a browser would.
 *
 * The dedicated tools cover the common routes, but Brightspace has many pages no API
 * reaches: View History, the Rubrics list, feedback popups and more. Each was found one at a
 * time by asking the user for links. This gives an assistant the student's own view of any
 * page, so it can find these itself: the text, every link with its JavaScript handler (which is
 * where Brightspace often keeps ids, e.g. `PreviewRubric('12345', …)`), frames, forms, and the
 * Learn URLs the page's scripts mention.
 *
 * Strictly read-only: one GET on the configured Learn host. It never submits a form or follows
 * a link by itself.
 */

import type { D2LClient } from "./client.js";
import { htmlToText } from "./format.js";

export interface PageLinkInfo {
  text: string;
  href: string | null;
  onclick: string | null;
}

export interface PageRead {
  url: string;
  title: string | null;
  text: string;
  textLength: number;
  textOffset: number;
  textTruncated: boolean;
  links: PageLinkInfo[];
  frames: string[];
  forms: Array<{ action: string | null; method: string; fields: string[] }>;
  scriptUrls: string[];
}

function decode(value: string): string {
  return value
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  if (!match) return null;
  return decode(match[2] ?? match[3] ?? "");
}

/** Accepts a site-relative path or a full URL on the Learn host; nothing else. */
export function normalizeLearnPath(host: string, input: string): string {
  const value = input.trim();
  if (value.startsWith("/")) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`"${input}" is not a URL or a site path starting with "/".`);
  }
  const allowed = new URL(host);
  if (url.protocol !== "https:" || url.host !== allowed.host) {
    throw new Error(`get_page only reads ${allowed.host}. "${url.host}" is not that site.`);
  }
  return url.pathname + url.search;
}

export function parsePage(
  html: string,
  url: string,
  options: { offset?: number; maxChars?: number } = {},
): PageRead {
  const offset = Math.max(0, options.offset ?? 0);
  const maxChars = Math.min(Math.max(options.maxChars ?? 20_000, 1_000), 60_000);

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() ?? null;
  const body = /<body[\s\S]*?>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const fullText = htmlToText(body);
  const text = fullText.slice(offset, offset + maxChars);

  const links: PageLinkInfo[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const tag = match[1] ?? "";
    const href = attr(tag, "href");
    const onclick = attr(tag, "onclick");
    const label = htmlToText(match[2] ?? "").replace(/\s+/g, " ").trim();
    if (!label && !onclick) continue;
    if (href && /^#/.test(href) && !onclick) continue;
    const key = `${label}|${href}|${onclick}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ text: label.slice(0, 200), href, onclick: onclick ? onclick.slice(0, 300) : null });
    if (links.length >= 300) break;
  }

  const frames = [...html.matchAll(/<iframe\b([^>]*)>/gi)]
    .map((match) => attr(match[1] ?? "", "src"))
    .filter((src): src is string => Boolean(src));

  const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].slice(0, 20).map((match) => ({
    action: attr(match[1] ?? "", "action"),
    method: (attr(match[1] ?? "", "method") ?? "get").toLowerCase(),
    fields: [...(match[2] ?? "").matchAll(/<(?:input|select|textarea)\b([^>]*)>/gi)]
      .map((field) => attr(field[1] ?? "", "name"))
      .filter((name): name is string => Boolean(name))
      .slice(0, 40),
  }));

  const scripts = (html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? []).join("\n");
  const scriptUrls = [
    ...new Set(
      (scripts.split("\\/").join("/").match(/\/d2l\/[A-Za-z0-9_./-]+(?:\?[^"'\s<>\\)]*)?/g) ?? []).map(decode),
    ),
  ]
    .filter((path) => !/\.(js|css|png|svg|gif|woff2?)(\?|$)/i.test(path))
    .slice(0, 100);

  return {
    url,
    title,
    text,
    textLength: fullText.length,
    textOffset: offset,
    textTruncated: offset + maxChars < fullText.length,
    links,
    frames,
    forms,
    scriptUrls,
  };
}

export async function readPage(
  client: D2LClient,
  input: string,
  options: { offset?: number; maxChars?: number } = {},
): Promise<PageRead> {
  const path = normalizeLearnPath(client.host, input);
  const html = await client.fetchText(path);
  return parsePage(html, path, options);
}
