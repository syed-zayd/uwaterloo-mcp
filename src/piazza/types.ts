/**
 * Types for Piazza's undocumented API.
 *
 * Derived from observing the web client, so fields are optional far more often than feels
 * natural — several appear only on certain post types (e.g. `has_i` is absent on notes).
 * Treat everything as best-effort and never assume presence.
 */

export interface PiazzaCourse {
  id: string;
  /** Course code, e.g. "CS 240". */
  num?: string;
  /** Full title. */
  name?: string;
  /** e.g. "Spring 2026". */
  term?: string;
  student_count?: number;
  instructors?: Array<{ id: string; name: string }>;
}

export interface PiazzaProfile {
  all_classes?: Record<string, PiazzaCourse>;
  /** Courses where the user is enrolled as a student, keyed by course id. */
  courses_stud?: Record<string, unknown>;
  /** Courses where the user is staff. */
  courses_inst?: Record<string, unknown>;
  school?: string;
}

export interface PiazzaUser {
  id: string;
  name?: string;
  /** "student" | "ta" | "professor" | "instructor" */
  role?: string;
  admin?: boolean;
  photo_url?: string | null;
}

/** One entry in a post's activity timeline. */
export interface PiazzaLogEntry {
  /** ISO timestamp. */
  t: string;
  /** Actor user id. */
  u: string;
  /** Event kind. */
  n:
    | "create"
    | "update"
    | "followup"
    | "feedback"
    | "i_answer"
    | "i_answer_update"
    | "s_answer"
    | "s_answer_update"
    | (string & {});
}

/** A feed item — the summary form returned by feed and search methods. */
export interface PiazzaFeedItem {
  id: string;
  /** Human-facing post number, what "@123" refers to. */
  nr: number;
  type?: "question" | "note" | "poll" | (string & {});
  subject?: string;
  content_snipet?: string;
  /** Search results only. */
  highlighted_snipet?: string;
  folders?: string[];
  tags?: string[];
  /** Activity timeline — the cheap way to see what changed without fetching the thread. */
  log?: PiazzaLogEntry[];
  modified?: string;
  updated?: string;
  created?: string;
  /** Has an instructor answer. Absent on notes — treat missing as false. */
  has_i?: boolean;
  /** Has a student answer. Absent on notes — treat missing as false. */
  has_s?: boolean;
  /** Number of follow-ups still lacking a reply. */
  no_answer_followup?: number;
  no_answer?: number;
  unique_views?: number;
  num_favorites?: number;
  is_new?: boolean;
  bucket_name?: string;
  status?: string;
  pin?: number;
}

/** One revision of a post or answer. Newest first. */
export interface PiazzaRevision {
  subject?: string;
  content?: string;
  uid?: string;
  created?: string;
  anon?: string;
}

/**
 * A node in a thread: the root post, an answer, a follow-up, or a reply.
 *
 * Text location differs by type — answers and root posts keep it in `history[0].content`,
 * while follow-ups and replies put it directly in `subject`. See `nodeText` in flatten.ts.
 */
export interface PiazzaContentNode {
  id: string;
  type?: "question" | "note" | "poll" | "i_answer" | "s_answer" | "followup" | "feedback" | (string & {});
  subject?: string;
  content?: string;
  history?: PiazzaRevision[];
  children?: PiazzaContentNode[];
  created?: string;
  updated?: string;
  uid?: string;
  /** "no" | "stud" | "full" — anonymous nodes expose no uid. */
  anon?: string;
  /** Per-thread alias for an anonymous author, e.g. "a_2". */
  uid_a?: string;
  /** Students who marked this a good question/note. */
  tag_good?: PiazzaUser[];
  /** Instructors who endorsed this answer. */
  tag_endorse?: PiazzaUser[];
  is_tag_endorse?: boolean;
  no_upvotes?: number;
  folders?: string[];
  tags?: string[];
  history_size?: number;
  /** On a follow-up: how many replies are still outstanding. Non-zero means unresolved. */
  no_answer?: number;
}

/** Full thread as returned by content.get. */
export interface PiazzaPost extends PiazzaContentNode {
  nr: number;
  unique_views?: number;
  no_answer?: number;
  no_answer_followup?: number;
  change_log?: Array<{ type?: string; uid?: string; when?: string; cid?: string }>;
  bucket_name?: string;
  status?: string;
}

export interface PiazzaFeedResponse {
  feed?: PiazzaFeedItem[];
  more?: boolean;
  sort?: string;
  /** Folder/tag vocabulary with per-folder counts. */
  tags?: {
    popular?: string[];
    instructor?: string[];
    popular_count?: Record<string, number>;
    instructor_count?: Record<string, number>;
    instructor_upd?: Record<string, number>;
  };
}

/**
 * Filters accepted by network.filter_feed. Each flag is sent as 1 when enabled.
 *
 * Note there is no "written or answered by staff" flag — filter_feed's own `instructors=1` means
 * authored-by-staff only, which excludes instructor answers on student questions. That filtering
 * is therefore done in the tool layer instead.
 */
export interface FeedFilters {
  /** Restrict to one folder, e.g. "exam". */
  folder?: string;
  /** Only posts with unresolved follow-ups. */
  unresolved?: boolean;
  /** Only unread posts. */
  unread?: boolean;
  /** Only your own posts. */
  my_posts?: boolean;
}
