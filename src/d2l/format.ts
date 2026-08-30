/**
 * Rendering helpers shared by the tools.
 *
 * Tool results are read by a model, not a browser, so everything here optimises for that:
 * compact plain text, no decoration, dates written so they can be reasoned about without a
 * timezone library, and HTML reduced to readable prose.
 */

/** Converts a Brightspace HTML fragment to plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Prefers the plain-text variant Valence supplies, falling back to stripping the HTML. */
export function richText(value: { Text?: string; Html?: string } | null | undefined): string {
  if (!value) return "";
  if (value.Text && value.Text.trim()) return value.Text.trim();
  if (value.Html) return htmlToText(value.Html);
  return "";
}

/**
 * Formats a UTC timestamp as `2026-08-24 14:30 UTC (in 3 days)`.
 *
 * The relative part matters: a model reading "2026-08-24" cannot reliably tell whether that is
 * upcoming or long past without being told today's date, and it is exactly the question a
 * student is asking.
 */
export function formatDate(value: string | null | undefined, now = new Date()): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const iso = date.toISOString().replace("T", " ").slice(0, 16);
  return `${iso} UTC (${relative(date, now)})`;
}

export function relative(date: Date, now = new Date()): string {
  const ms = date.getTime() - now.getTime();
  const past = ms < 0;
  const minutes = Math.round(Math.abs(ms) / 60000);

  if (minutes < 1) return "now";
  if (minutes < 60) return past ? `${minutes}m ago` : `in ${minutes}m`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return past ? `${hours}h ago` : `in ${hours}h`;

  const days = Math.round(hours / 24);
  if (days < 31) return past ? `${days} days ago` : `in ${days} days`;

  const months = Math.round(days / 30);
  if (months < 12) return past ? `${months} months ago` : `in ${months} months`;
  return past ? `${Math.round(months / 12)}y ago` : `in ${Math.round(months / 12)}y`;
}

/** Truncates to a sentence boundary where possible, so excerpts do not end mid-word. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return `${(stop > max * 0.6 ? cut.slice(0, stop + 1) : cut).trimEnd()}…`;
}

/** A tool result carrying plain text. */
export function text(body: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: body }] };
}
