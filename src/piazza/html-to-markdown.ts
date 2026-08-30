/**
 * Minimal HTML → Markdown converter.
 *
 * Deliberately dependency-free: it must run in both Cloudflare Workers and Node, and every
 * mainstream converter (turndown et al.) needs a DOM that Workers does not provide.
 *
 * The input is TinyMCE output from Piazza, so the tag vocabulary is small and predictable.
 * LaTeX passes through untouched — Piazza stores it as literal `$$…$$` source and Claude reads
 * that natively.
 */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  times: "×",
  le: "≤",
  ge: "≥",
  ne: "≠",
  deg: "°",
  middot: "·",
  bull: "•",
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Convert one ordered/unordered list body into markdown list items. */
function convertListItems(inner: string, ordered: boolean): string {
  let index = 0;
  const items = inner.match(/<li[^>]*>[\s\S]*?(?=<li[^>]*>|$)/gi) ?? [];
  return items
    .map((item) => {
      const body = item.replace(/<\/?li[^>]*>/gi, "").trim();
      index += 1;
      const marker = ordered ? `${index}.` : "-";
      // Indent continuation lines so multi-line items stay inside the bullet.
      const text = convertInline(body).trim().replace(/\n/g, "\n  ");
      return text ? `${marker} ${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Inline-level conversion, applied inside blocks. */
function convertInline(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => wrap(t, "**"))
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => wrap(t, "*"))
    .replace(/<(del|s|strike)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => wrap(t, "~~"))
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, t) => {
      const inner = stripTags(t).trim();
      return inner ? `\`${inner}\`` : "";
    })
    .replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const label = stripTags(text).trim();
      if (!href || href.startsWith("javascript:")) return label;
      return label ? `[${label}](${href})` : href;
    })
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = tag.match(/src=["']([^"']*)["']/i)?.[1];
      const alt = tag.match(/alt=["']([^"']*)["']/i)?.[1] ?? "image";
      return src ? `![${alt}](${src})` : "";
    });
}

/**
 * Wrap text in a markdown delimiter, keeping any surrounding whitespace *outside* it.
 *
 * Markdown ignores `** bold **`, so the delimiters must hug the text — but naively trimming
 * turns `<b>NOT </b>be` into `**NOT**be`, welding two words together. Whitespace is therefore
 * lifted out rather than discarded.
 */
function wrap(text: string, delim: string): string {
  const converted = convertInline(text);
  const [, lead = "", core = "", trail = ""] =
    converted.match(/^(\s*)([\s\S]*?)(\s*)$/) ?? [];
  if (!core) return converted;
  return `${lead}${delim}${core}${delim}${trail}`;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

/**
 * Convert a Piazza HTML fragment to Markdown.
 *
 * Returns an empty string for empty/whitespace-only input so callers can distinguish
 * "no content" from "content that failed to convert".
 */
export function htmlToMarkdown(html: string | undefined | null): string {
  if (!html) return "";

  let out = html;

  // Drop anything non-content outright.
  out = out.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  out = out.replace(/<!--[\s\S]*?-->/g, "");

  // Search results mark matched terms with these literal sentinels rather than tags.
  out = out.replace(/___bold_start___/g, "**").replace(/___bold_end___/g, "**");

  // Preserve code blocks verbatim: pull them out before any other rule can mangle them,
  // and restore at the end.
  const codeBlocks: string[] = [];
  out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, body) => {
    const code = decodeEntities(stripTags(body)).replace(/\n+$/, "");
    codeBlocks.push(code);
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });

  // Lists before generic block handling, so <li> structure survives.
  out = out.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_, inner) => `\n\n${convertListItems(inner, false)}\n\n`);
  out = out.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => `\n\n${convertListItems(inner, true)}\n\n`);

  out = out.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
    const text = convertInline(stripTagsKeepingBreaks(inner)).trim();
    return text ? `\n\n${text.split("\n").map((l) => `> ${l}`).join("\n")}\n\n` : "";
  });

  out = out.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, inner) => {
    const text = convertInline(inner).trim();
    return text ? `\n\n${"#".repeat(Number(level))} ${text}\n\n` : "";
  });

  out = convertInline(out);

  // Block boundaries → blank lines.
  out = out.replace(/<\/(p|div|tr|table|section)\s*>/gi, "\n\n");
  out = out.replace(/<\/(td|th)\s*>/gi, " ");

  out = stripTags(out);
  out = decodeEntities(out);

  // Restore code blocks now that no tag-stripping remains.
  out = out.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => {
    const code = codeBlocks[Number(i)] ?? "";
    return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
  });

  // Piazza emits root-relative URLs for uploads and attachments; absolute ones are actually
  // usable by whoever reads the output.
  out = out.replace(/\]\(\/(?!\/)/g, "](https://piazza.com/");

  return out
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
    .join("\n")
    .trim();
}

/** Like stripTags, but turns <br> and </p> into newlines first. */
function stripTagsKeepingBreaks(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n");
}
