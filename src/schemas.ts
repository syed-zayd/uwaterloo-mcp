/**
 * Output schemas for the tools.
 *
 * Declaring `outputSchema` is a commitment, not a hint: the spec requires that a tool which
 * advertises one returns `structuredContent` conforming to it. In exchange the client gets data
 * it can validate and address by field rather than having to parse prose.
 *
 * Both forms are returned. The text block stays the primary rendering — it carries the
 * relative dates, the flags, and the framing that make a result readable — while
 * `structuredContent` carries the same facts in a form a program can use. The SDK appends a
 * serialized copy automatically when a tool returns only structured content, so returning both
 * explicitly is what keeps the readable version.
 *
 * Every tool declares one. Even the ones whose payload is a file or a page of prose have
 * facts worth addressing — a filename, a mime type, whether the session is alive — and a
 * caller should not have to parse them back out of a sentence.
 */

import * as z from "zod";

/** ISO 8601 timestamps, or null where D2L supplies no date. */
const timestamp = z.string().nullable().describe("ISO 8601 UTC timestamp, or null if unset.");

export const courseSchema = z.object({
  id: z.number().describe("Org unit id — pass this to other tools."),
  name: z.string(),
  code: z.string().nullable(),
  isActive: z.boolean().describe("Whether the user can currently access the course."),
  isPinned: z.boolean(),
  startDate: timestamp,
  endDate: timestamp,
  lastAccessed: timestamp,
});

export const listCoursesOutput = z.object({
  courses: z.array(courseSchema),
});

export const gradeSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** What Brightspace shows, which may be a letter or a curved value. */
  displayed: z.string().nullable(),
  points: z.number().nullable().describe("Null when the item has not been graded."),
  outOf: z.number().nullable(),
  percentage: z.number().nullable(),
  weight: z.number().nullable().describe("Share of the final grade, when the gradebook is weighted."),
  isBonus: z.boolean(),
  activity: z.object({toolId:z.number(),toolItemId:z.number(),kind:z.string()}).nullable().optional().describe("Backing activity, when present. Its presence means get_rubric may find a graded rubric."),
  isCategory: z
    .boolean()
    .describe(
      "True for a subtotal row such as 'Quizzes'. Its points are marks banked toward the " +
        "final grade, not a score, and it already contains its children — do not add it to them.",
    ),
  gradedPercentage: z
    .number()
    .nullable()
    .optional()
    .describe("Categories only: average across the members graded so far."),
  gradedCount: z
    .number()
    .optional()
    .describe("Categories only: how many members that average is over."),
  comments: z.string(),
  lastModified: timestamp,
});

export const gradedRubricSchema = z.object({
  rubricName: z.string().nullable(),
  activityName: z.string().nullable(),
  score: z.number().nullable(),
  outOf: z.number().nullable(),
  overallFeedback: z.string(),
  criteria: z.array(
    z.object({
      name: z.string(),
      score: z.number().nullable(),
      outOf: z.number().nullable(),
      levelName: z.string().nullable().describe("The achievement level the instructor selected."),
      feedback: z.string(),
    }),
  ),
});

export const getRubricOutput = z.object({
  course: z.object({ id: z.number(), name: z.string() }),
  gradeItem: z.object({ id: z.string(), name: z.string() }).nullable(),
  rubrics: z.array(gradedRubricSchema),
});

export const rubricCriterionSchema = z.object({
  name: z.string(),
  level: z.string().nullable().describe("The achievement level the instructor selected."),
  score: z.number().nullable(),
  outOf: z.number().nullable(),
  feedback: z.string(),
});

export const assignmentFeedbackSchema = z.object({
  folderId: z.number(),
  folderName: z.string(),
  score: z.number().nullable(),
  outOf: z.number().nullable(),
  comment: z.string().describe("What the instructor wrote. Empty when they left no comment."),
  isGraded: z.boolean(),
  gradedSymbol: z.string().nullable(),
  rubrics: z.array(rubricCriterionSchema),
  attachments: z.array(z.string()).describe("Files the instructor attached to the feedback."),
  submittedAt: timestamp,
  submittedFiles: z.array(z.string()),
});

export const getGradesOutput = z.object({
  course: z.object({ id: z.number(), name: z.string() }),
  grades: z.array(gradeSchema),
  /** Weighted by category when the gradebook defines them. */
  average: z.number().nullable(),
  finalGrade: z.string().nullable(),
  feedback: z
    .array(assignmentFeedbackSchema)
    .describe(
      "Instructor feedback from submitted assignments. This is where written comments and " +
        "rubric marks live — the grade items themselves almost never carry them.",
    ),
});

export const assignmentSchema = z.object({
  id: z.number(),
  name: z.string(),
  dueDate: timestamp,
  availableFrom: timestamp,
  availableUntil: timestamp,
  outOf: z.number().nullable(),
  submitted: z
    .boolean()
    .nullable()
    .describe("Null when D2L does not disclose submission state to the student."),
  hasFeedback: z.boolean().nullable(),
  isGroup: z.boolean(),
  instructions: z.string(),
});

export const quizSchema = z.object({
  id: z.number().describe("Quiz id — pass to get_quiz_attempts."),
  name: z.string(),
  dueDate: timestamp,
  startDate: timestamp.describe("When the quiz opens."),
  endDate: timestamp.describe("When it closes, after which it can no longer be attempted."),
  attempts: z.string().nullable().describe("How many attempts are allowed."),
});

export const listAssignmentsOutput = z.object({
  course: z.object({ id: z.number(), name: z.string() }),
  assignments: z.array(assignmentSchema),
  quizzes: z.array(quizSchema),
});

const assignmentAttachmentSchema = z.object({
  id: z.number(),
  name: z.string(),
  size: z.number(),
});

export const getSubmissionsOutput = z.object({
  course: z.object({ id: z.number(), name: z.string() }),
  assignment: z.object({
    id: z.number(),
    name: z.string(),
    instructions: z.string(),
    dueDate: timestamp,
    availableFrom: timestamp,
    availableUntil: timestamp,
    outOf: z.number().nullable(),
    isGroup: z.boolean(),
    submissionType: z.enum(["file", "text", "on_paper", "observed", "file_or_text", "unknown"]),
    instructionFiles: z.array(assignmentAttachmentSchema),
    instructionLinks: z.array(
      z.object({ id: z.number(), name: z.string(), url: z.string().nullable() }),
    ),
  }),
  entity: z
    .object({ id: z.number(), type: z.enum(["user", "group"]), name: z.string() })
    .nullable()
    .describe("The student or group whose work these attempts contain."),
  status: z.enum(["unsubmitted", "submitted", "draft", "published", "unknown"]),
  completedAt: timestamp,
  submissionCount: z.number(),
  submissions: z.array(
    z.object({
      id: z.number().describe("Submission id — needed with fileId to retrieve one submitted file."),
      number: z.number().describe("Chronological attempt number, oldest first."),
      submittedAt: timestamp,
      submittedBy: z.object({ id: z.string(), name: z.string() }),
      comment: z.string().describe("The comment entered when this particular attempt was submitted."),
      files: z.array(
        z.object({
          id: z.number().describe("File id — pass with this submission's id to get_submission_file."),
          name: z.string(),
          size: z.number(),
          isRead: z.boolean(),
          isFlagged: z.boolean(),
          isDeleted: z.boolean(),
        }),
      ),
    }),
  ),
  feedback: z
    .object({
      score: z.number().nullable(),
      outOf: z.number().nullable(),
      comment: z.string(),
      isGraded: z.boolean(),
      gradedSymbol: z.string().nullable(),
      rubrics: z.array(rubricCriterionSchema),
      attachments: z.array(assignmentAttachmentSchema),
      links: z.array(
        z.object({
          id: z.number(),
          name: z.string(),
          type: z.string(),
          url: z.string().nullable(),
        }),
      ),
    })
    .nullable()
    .describe("Published instructor feedback for the assignment as a whole."),
});

export const getSubmissionFileOutput = z.object({
  course: z.object({ id: z.number(), name: z.string() }),
  assignment: z.object({ id: z.number(), name: z.string() }),
  submissionId: z.number(),
  fileId: z.number(),
  fileName: z.string(),
  mimeType: z.string(),
  bytes: z.number(),
  attached: z.boolean(),
  note: z.string().nullable(),
});

export const getSubmissionFileUrlOutput = z.object({
  course: z.object({ id: z.number(), name: z.string() }),
  assignment: z.object({ id: z.number(), name: z.string() }),
  submissionId: z.number(),
  fileId: z.number(),
  fileName: z.string(),
  mimeType: z.string(),
  bytes: z.number().nullable(),
  url: z.string(),
  expiresAt: z.string(),
});

export const contentItemSchema = z.object({
  id: z.number().describe("Topic id — pass to get_file for items where isReadable is true."),
  title: z.string(),
  kind: z.enum(["module", "topic"]),
  depth: z.number().describe("Nesting level, 0 for a top-level module."),
  type: z.string().nullable().describe("File, Link, Assignment, Quiz, and so on."),
  url: z.string().nullable().describe("Where the item points, for links and external tools."),
  isReadable: z.boolean().describe("Whether get_file can download this item."),
  isLocked: z.boolean(),
  dueDate: timestamp,
});

export const serverInfoOutput = z.object({
  server: z.string(),
  version: z.string(),
  serverTime: z.string().describe("ISO 8601 UTC timestamp."),
  tools: z
    .array(z.string())
    .describe(
      "Every tool this server registers. A client offering fewer than these is holding a " +
        "cached tool list and should re-add the connector.",
    ),
  d2l: z.object({
    configured: z.boolean(),
    waterlooSignInConfigured: z
      .boolean()
      .describe("Whether server-side WatIAM credentials are configured, enabling /setup to sign in."),
    host: z.string().nullable(),
    sessionAlive: z
      .boolean()
      .nullable()
      .describe("Checked live. Null when no credentials are configured to check."),
    signedInAs: z.string().nullable(),
  }),
  piazza: z.object({
    configured: z.boolean(),
  }),
});

export const getFileOutput = z.object({
  course: z.object({ id: z.number(), name: z.string() }),
  topicId: z.number(),
  fileName: z.string().describe("The file's real name on Brightspace, e.g. goose.cc."),
  mimeType: z.string(),
  bytes: z.number().describe("Size of the file itself, before base64 encoding."),
  attached: z
    .boolean()
    .describe(
      "True when the file's bytes are included as an embedded resource in this result. " +
        "False only when it was too large to return.",
    ),
  note: z.string().nullable().describe("Set when something prevented the file being attached."),
});

export const getFileUrlOutput = z.object({
  course: z.object({ id: z.number(), name: z.string() }),
  topicId: z.number(),
  fileName: z.string(),
  mimeType: z.string(),
  bytes: z.number().nullable().describe("Null when D2L did not report a size."),
  url: z.string().describe("Download it with curl or an equivalent. No credentials needed."),
  expiresAt: z.string().describe("ISO 8601 UTC timestamp. The link stops working after this."),
});

export const getCourseContentOutput = z.object({
  course: z.object({ id: z.number(), name: z.string() }),
  items: z.array(contentItemSchema),
});

export const listDiscussionsOutput = z.object({
  course: z.object({ id: z.number(), name: z.string() }),
  forums: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      description: z.string(),
      isLocked: z.boolean(),
      topics: z.array(
        z.object({
          id: z.number().describe("Topic id — pass to list_discussion_posts."),
          forumId: z.number(),
          name: z.string(),
          description: z.string(),
          isLocked: z.boolean(),
          scoreOutOf: z.number().nullable().describe("Set when the topic is graded."),
          dueDate: timestamp,
          startDate: timestamp,
          endDate: timestamp,
          postCount: z.number().describe("Threads and replies together."),
        }),
      ),
    }),
  ),
});

export const listDiscussionPostsOutput = z.object({
  course: z.object({ id: z.number(), name: z.string() }),
  topic: z.object({ id: z.number(), name: z.string(), description: z.string() }),
  threads: z.array(
    z.object({
      postId: z.number().describe("Pass to get_discussion_thread to read the conversation."),
      threadId: z.number().nullable(),
      subject: z.string(),
      author: z.string(),
      postedAt: timestamp,
      preview: z.string().describe("Opening of the post only. The full text is in the thread."),
      wordCount: z.number().nullable(),
      replyCount: z.number(),
      unreadReplies: z.number(),
      lastReplyAt: timestamp,
      lastReplyBy: z.string().nullable(),
      isPinned: z.boolean(),
      attachmentCount: z.number(),
    }),
  ),
  totalThreads: z.number().describe("Threads in the topic, before any limit was applied."),
  returned: z.number(),
});

/** Recursive, because a reply can itself be replied to. */
const discussionPostSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    id: z.number(),
    topicId: z.number(),
    threadId: z.number().nullable(),
    parentPostId: z.number().nullable().describe("Null on the post that started the thread."),
    subject: z.string(),
    author: z.string(),
    postedAt: timestamp,
    body: z.string(),
    isRead: z.boolean(),
    isAnonymous: z.boolean(),
    isPinned: z.boolean(),
    attachmentCount: z.number(),
    wordCount: z.number().nullable(),
    replies: z.array(discussionPostSchema),
  }),
);

export const getDiscussionThreadOutput = z.object({
  course: z.object({ id: z.number(), name: z.string() }),
  topic: z.object({ id: z.number(), name: z.string() }),
  thread: discussionPostSchema.nullable(),
  totalPosts: z.number().describe("The root post plus every reply beneath it."),
});

export const getClasslistOutput = z.object({
  course: z.object({ id: z.number(), name: z.string() }),
  members: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      firstName: z.string(),
      lastName: z.string(),
      email: z.string().nullable(),
      username: z.string().nullable(),
      role: z
        .string()
        .describe(
          "The institution's own label, e.g. Instructor or TA - Level 4. Not a fixed set — " +
            "roleCounts lists the ones this course actually uses.",
        ),
      pronouns: z.string().nullable(),
      lastAccessed: timestamp,
      isOnline: z.boolean(),
      groups: z.array(z.string()).describe("Names of the groups this person belongs to."),
    }),
  ),
  roleCounts: z
    .array(z.object({ role: z.string(), count: z.number() }))
    .describe("Every role in the course and how many hold it, counted before any filter."),
  groups: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      code: z.string().nullable(),
      description: z.string(),
      categoryId: z.number(),
      categoryName: z.string().describe("The set this group belongs to, e.g. Project or LEC."),
      memberIds: z.array(z.string()),
    }),
  ),
  totalMembers: z.number().describe("Everyone enrolled, before filters."),
  returned: z.number(),
});

const linkedTopicSchema = z.object({
  id: z.number().describe("Topic id — pass to list_discussion_posts."),
  name: z.string(),
  forumName: z.string(),
});

export const listGroupsOutput = z.object({
  course: z.object({ id: z.number(), name: z.string() }),
  categories: z
    .array(
      z.object({
        id: z.number(),
        name: z.string(),
        description: z.string(),
        maxUsersPerGroup: z.number().nullable().describe("Cap on group size, when the set has one."),
        groups: z.array(
          z.object({
            id: z.number(),
            name: z.string(),
            code: z.string().nullable(),
            description: z.string(),
            memberCount: z.number(),
            isMine: z.boolean().describe("True when the signed-in user is in this group."),
          }),
        ),
        discussionTopics: z
          .array(linkedTopicSchema)
          .describe("Discussion topics restricted to this set — each group sees its own threads."),
      }),
    )
    .describe(
      "Group sets, not groups. A category such as 'Project' contains many groups, one per team.",
    ),
  myGroups: z.array(z.string()).describe("Names of the groups the signed-in user belongs to."),
});

export const getGroupOutput = z.object({
  course: z.object({ id: z.number(), name: z.string() }),
  group: z
    .object({
      id: z.number(),
      name: z.string(),
      code: z.string().nullable(),
      description: z.string(),
      categoryId: z.number(),
      categoryName: z.string().describe("The set this group belongs to."),
      memberCount: z.number(),
      isMine: z.boolean(),
      members: z.array(
        z.object({
          id: z.string(),
          displayName: z.string(),
          email: z.string().nullable(),
          role: z.string(),
          isOnline: z.boolean(),
        }),
      ),
      discussionTopics: z.array(linkedTopicSchema),
    })
    .nullable(),
});

export const getQuizAttemptsOutput = z.object({
  course: z.object({ id: z.number(), name: z.string() }),
  quiz: z.object({ id: z.number(), name: z.string() }),
  attempts: z.array(
    z.object({
      attemptId: z.number(),
      attemptNumber: z.number(),
      score: z.number().nullable(),
      outOf: z.number().nullable(),
    }),
  ),
  attempt: z
    .object({
      attemptId: z.number(),
      score: z.number().nullable(),
      outOf: z.number().nullable(),
      correctCount: z.number(),
      incorrectCount: z.number(),
      questions: z.array(
        z.object({
          number: z.number(),
          text: z.string(),
          type: z
            .enum(["choice", "matching", "written"])
            .describe("Free-response questions are marked by a human and carry no verdict."),
          isCorrect: z
            .boolean()
            .nullable()
            .describe("Null for free response — a marker decides those, so the page shows none."),
          options: z
            .array(
              z.object({
                text: z.string(),
                isCorrect: z.boolean(),
                selected: z.boolean(),
              }),
            )
            .describe(
              "Every option offered, in the order shown. Empty for matching and free response.",
            ),
          yourAnswers: z
            .array(z.string())
            .describe("Options chosen, pairings made, or the text written."),
          correctAnswers: z
            .array(z.string())
            .describe("For matching, only the pairings that were wrong. Empty for free response."),
        }),
      ),
    })
    .nullable()
    .describe("The attempt read in full. Null when the quiz has no attempts."),
});

export const announcementSchema = z.object({
  id: z.number(),
  title: z.string(),
  body: z.string(),
  startDate: timestamp,
  endDate: timestamp.describe("When the announcement stops being shown, if it is set to expire."),
});

export const getAnnouncementsOutput = z.object({
  course: z.object({ id: z.number(), name: z.string() }),
  announcements: z.array(announcementSchema),
});

export const deadlineSchema = z.object({
  courseId: z.number(),
  courseName: z.string(),
  kind: z.enum(["assignment", "quiz"]),
  id: z.number(),
  name: z.string(),
  dueDate: z.string(),
  isOverdue: z.boolean(),
  submitted: z.boolean().nullable(),
  outOf: z.number().nullable(),
});

export const getUpcomingOutput = z.object({
  deadlines: z.array(deadlineSchema),
  withinDays: z.number(),
  coursesChecked: z.number(),
});
