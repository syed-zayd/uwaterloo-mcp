/**
 * Course file paths, and why they need validating.
 *
 * Not every file in a course is a content topic. Course pages routinely link straight at
 * something under `/content/enforced/<orgUnitId>-<code>/` — an assignment template, a policy
 * PDF, a starter archive — and those files have no topic id to ask for. `get_course_content`
 * hands back the same kind of path in each topic's `url`, so the shape is already in the
 * caller's hands; what was missing was a way to hand one back and get the file.
 *
 * The path comes from outside, which is the whole problem. `D2LClient.fetchRaw` will fetch any
 * path on the Brightspace host with the operator's session attached, so an unchecked path turns
 * this server into an open proxy for that session — every API route, every other course, every
 * page the signed-in user can reach. Worse, `get_file_url` mints links that carry no
 * credentials of their own, so such a path would be reachable by anyone holding the link.
 *
 * Hence one narrow rule, enforced here and re-enforced when a signed link is redeemed: a path
 * must name a file inside the enforced content directory of the course the caller named. That
 * is exactly the set of files a student can already open by clicking a link in that course, and
 * nothing else.
 */

/** `/content/enforced/1285415-PD10_081_cel_1269/toc/…` — the prefix every course file shares. */
const ENFORCED_ROOT = "/content/enforced/";

export class CourseFilePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CourseFilePathError";
  }
}

/**
 * Canonicalises a course file path, or explains why it is not one.
 *
 * Accepts what a caller realistically has: a path copied from a topic's `url`, or a full
 * `https://learn.uwaterloo.ca/...` link copied out of a course page's HTML. Query strings and
 * fragments are dropped — they are never part of which file is being named — and percent
 * encoding is left exactly as given, because decoding it here would let `%2e%2e` walk out of
 * the directory that the check below is defending.
 *
 * @param courseId Org unit id of the course the caller asked for.
 * @param host     Base URL of the Brightspace instance, e.g. `https://learn.uwaterloo.ca`.
 * @param input    A path or absolute URL naming the file.
 */
export function resolveCourseFilePath(courseId: number, host: string, input: string): string {
  const raw = input.trim();
  if (!raw) throw new CourseFilePathError("No file path was given.");

  const path = toHostRelativePath(raw, host);

  // Backslashes are separators to some servers and ordinary characters to others; rejecting
  // them outright avoids having to know which Brightspace is today.
  if (path.includes("\\")) {
    throw new CourseFilePathError("A course file path cannot contain a backslash.");
  }
  if (path.includes("\0")) {
    throw new CourseFilePathError("A course file path cannot contain a null byte.");
  }

  // `..` is rejected rather than resolved. Resolving it would mean deciding what a traversal
  // that lands back inside the course directory ought to do, and there is no such path worth
  // supporting — a real link never contains one.
  //
  // Each segment is tested decoded as well as raw. `%2e%2e` survives every URL parser between
  // here and Brightspace untouched, so checking only the raw text would leave the decision of
  // whether it means `..` to whichever server receives it — which is not a decision to
  // delegate. Note this decodes for the *test* only; the path sent on the wire keeps its
  // original encoding, since re-encoding it would be a second chance to get it wrong.
  if (path.split("/").some(isDotSegment)) {
    throw new CourseFilePathError(
      "A course file path cannot contain '.' or '..' segments, encoded or otherwise. Use the " +
        "path exactly as it appears in the course — for example " +
        "/content/enforced/123456-CS_247/notes/week1.pdf.",
    );
  }

  const prefix = `${ENFORCED_ROOT}${courseId}-`;
  if (!path.startsWith(prefix)) {
    throw new CourseFilePathError(
      `That path is not a file in this course. It must begin with '${prefix}' — the enforced ` +
        "content directory for the course you named. Files elsewhere on Brightspace, including " +
        "other courses, are deliberately out of reach of this tool.",
    );
  }
  if (path.length === prefix.length || path.endsWith("/")) {
    throw new CourseFilePathError("That path names a directory, not a file.");
  }

  return path;
}

/**
 * Reduces an absolute URL to a host-relative path, rejecting anything pointing elsewhere.
 *
 * A protocol-relative `//evil.test/x` parses as an absolute URL with a different host, and a
 * bare `evil.test/x` is not a path at all, so both fall out of the same check.
 */
function toHostRelativePath(raw: string, host: string): string {
  if (raw.startsWith("/") && !raw.startsWith("//")) {
    return stripQuery(raw);
  }

  let url: URL;
  try {
    url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
  } catch {
    throw new CourseFilePathError(
      "A course file path must start with '/' — for example " +
        "/content/enforced/123456-CS_247/notes/week1.pdf.",
    );
  }

  const expected = new URL(host);
  if (url.protocol !== expected.protocol || url.host !== expected.host) {
    throw new CourseFilePathError(
      `That link points at ${url.host}, not ${expected.host}. Only files on this Brightspace ` +
        "instance can be fetched.",
    );
  }
  return url.pathname;
}

/**
 * True for `.` and `..`, however they are spelled.
 *
 * Percent-decoding can be applied more than once by a chain of servers, so a segment is decoded
 * repeatedly until it stops changing rather than exactly once — `%252e%252e` is `%2e%2e` after
 * one pass and `..` after two. Malformed encoding fails to decode and is judged as it stands.
 */
function isDotSegment(segment: string): boolean {
  let value = segment;
  for (let pass = 0; pass < 4; pass += 1) {
    if (value === "." || value === "..") return true;
    if (!value.includes("%")) return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return false;
    }
    if (decoded === value) return false;
    value = decoded;
  }
  return value === "." || value === "..";
}

function stripQuery(path: string): string {
  const cut = path.search(/[?#]/);
  return cut === -1 ? path : path.slice(0, cut);
}

/** The file's own name, for the rare response that arrives without a Content-Disposition. */
export function fileNameFromPath(path: string): string {
  const last = path.split("/").pop() ?? "";
  try {
    return decodeURIComponent(last) || "file";
  } catch {
    return last || "file";
  }
}
