/**
 * Submission history read from the page a student sees, for folders the API refuses.
 *
 * Once a dropbox folder is past its end date, Brightspace answers the student
 * `.../submissions/mysubmissions/` route with 403 "Not Authorized" — yet the same student can
 * still open Dropbox → View History in the browser and download every file they submitted.
 * This reads that page with the same session, so the connector sees what the student sees.
 */

import type { D2LClient } from "./client.js";
import { htmlToText } from "./format.js";

export interface HistoryPageFile {
  id: number | null;
  name: string;
  /** Size as the page prints it, e.g. "28.47 KB". */
  sizeText: string | null;
  /** Site-relative link the page uses to download this file. */
  href: string;
}

export interface HistoryPageSubmission {
  id: number;
  /** As the page prints it, in the institution's local time, e.g. "Sep 20, 2026 5:43 PM". */
  submittedAt: string | null;
  comment: string;
  files: HistoryPageFile[];
}

export function historyPagePath(courseId: number, folderId: number): string {
  return `/d2l/lms/dropbox/user/folders_history.d2l?db=${folderId}&grpid=0&isprv=0&bp=0&ou=${courseId}`;
}

const FILE_ID_PARAMS = ["fid", "fileid", "file_id", "fileId", "FileId", "fId"];

function decode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function fileIdFrom(href: string): number | null {
  // learn.uwaterloo.ca links files as /d2l/common/viewFile.d2lfile/Database/<base64 id>/<name>,
  // e.g. MTIzNDU2 -> 123456, which is the same FileId the Valence API uses.
  const encoded = /viewFile\.d2lfile\/Database\/([A-Za-z0-9+/=_-]+)\//i.exec(href)?.[1];
  if (encoded) {
    const decoded = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    if (/^\d+$/.test(decoded)) return Number(decoded);
  }
  const query = href.split("?")[1] ?? "";
  const params = new URLSearchParams(query);
  for (const key of FILE_ID_PARAMS) {
    const value = params.get(key);
    if (value && /^\d+$/.test(value)) return Number(value);
  }
  const path = /\/files?\/(\d+)/i.exec(href);
  return path ? Number(path[1]) : null;
}

const DATE = /([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4}(?:,| at)? \d{1,2}:\d{2} ?[AP]M)/;

/** Splits the page into submission rows and pulls ids, dates, comments and file links. */
export function parseHistoryPage(html: string): HistoryPageSubmission[] {
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  const submissions: HistoryPageSubmission[] = [];

  for (const row of rows) {
    const cells = row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? [];
    if (cells.length === 0) continue;
    const firstText = htmlToText(cells[0]!).trim();
    if (!/^\d{4,}$/.test(firstText)) continue;

    const files: HistoryPageFile[] = [];
    for (const anchor of row.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const href = /href\s*=\s*"([^"]+)"/i.exec(anchor[1]!)?.[1];
      const name = htmlToText(anchor[2]!).trim();
      if (!href || !name || href.startsWith("#") || /^javascript:/i.test(href)) continue;
      if (!/\.[A-Za-z0-9]{1,6}$/.test(name)) continue;
      const decoded = decode(href);
      const after = row.slice(row.indexOf(anchor[0]) + anchor[0].length);
      const size = /\(([\d.,]+\s*[KMG]?B)\)/i.exec(htmlToText(after.slice(0, 200)))?.[1] ?? null;
      files.push({ id: fileIdFrom(decoded), name, sizeText: size, href: decoded });
    }

    // The page prints local (institution) time with no zone, so keep it exactly as shown rather
    // than inventing an offset.
    const rowText = htmlToText(row).replace(/\s+/g, " ");
    const date = DATE.exec(rowText)?.[1] ?? null;

    submissions.push({
      id: Number(firstText),
      submittedAt: date,
      comment: "",
      files,
    });
  }
  return submissions;
}

/** A short, readable account of a page this parser could not make sense of. */
export function describeUnparsedPage(html: string): string {
  const links = [...html.matchAll(/href\s*=\s*"([^"]+)"/gi)]
    .map((match) => decode(match[1]!))
    .filter((href) => /dropbox|file|download/i.test(href))
    .slice(0, 15);
  const tables = (html.match(/<table[\s\S]*?<\/table>/gi) ?? [])
    .map((table) => htmlToText(table).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 3);
  return [
    `Tables: ${tables.join(" || ").slice(0, 1500) || "none"}`,
    `Links: ${links.join(" , ") || "none"}`,
  ].join("\n");
}

export async function readHistoryPage(
  client: D2LClient,
  courseId: number,
  folderId: number,
): Promise<{ submissions: HistoryPageSubmission[]; html: string }> {
  const html = await client.fetchText(historyPagePath(courseId, folderId));
  return { submissions: parseHistoryPage(html), html };
}
