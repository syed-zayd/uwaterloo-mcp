/**
 * Instructor feedback on submitted work.
 *
 * The grades endpoint carries a `Comments` field, but on a real gradebook it is empty: an
 * instructor marking an assignment writes into the *dropbox* feedback, not the grade item's
 * comment box. Reading grades alone therefore reports a score with no explanation, which is
 * usually the part a student actually wants.
 *
 * Feedback lives on the submission, at `dropbox/folders/(id)/submissions/`, together with the
 * rubric assessment and the files the user handed in.
 */

import type { D2LClient } from "./client.js";
import { richText, truncate } from "./format.js";
import type { DropboxFolder } from "./types.js";

export interface RubricCriterion {
  name: string;
  level: string | null;
  score: number | null;
  outOf: number | null;
  feedback: string;
}

export interface AssignmentFeedback {
  folderId: number;
  folderName: string;
  score: number | null;
  outOf: number | null;
  /** What the instructor wrote. Empty when they left no comment. */
  comment: string;
  isGraded: boolean;
  gradedSymbol: string | null;
  rubrics: RubricCriterion[];
  /** Files the instructor attached to the feedback, if any. */
  attachments: string[];
  submittedAt: string | null;
  submittedFiles: string[];
}

interface SubmissionEntity {
  Entity?: { EntityId?: number; DisplayName?: string };
  Status?: number;
  CompletionDate?: string | null;
  Feedback?: {
    Score?: number | null;
    IsGraded?: boolean;
    GradedSymbol?: string | null;
    Feedback?: { Text?: string; Html?: string } | null;
    Files?: Array<{ FileName?: string }> | null;
    RubricAssessments?: Array<{
      RubricId?: number;
      Criteria?: Array<{
        CriterionId?: number;
        Name?: string;
        LevelName?: string | null;
        Score?: number | null;
        OutOf?: number | null;
        Feedback?: { Text?: string; Html?: string } | null;
      }> | null;
    }> | null;
  } | null;
  Submissions?: Array<{
    SubmissionDate?: string;
    Files?: Array<{ FileName?: string }> | null;
  }> | null;
}

/**
 * Feedback for every assignment in a course.
 *
 * The submissions endpoint returns one entry per user for an instructor and only the caller's
 * own for a student, so no filtering by user id is needed — but folders the user never
 * submitted to simply yield nothing, and are skipped rather than reported as empty.
 */
export async function getAssignmentFeedback(
  client: D2LClient,
  courseId: number,
): Promise<AssignmentFeedback[]> {
  const folders = await client.le<DropboxFolder[]>(`/${courseId}/dropbox/folders/`);

  const results = await Promise.all(
    folders.map(async (folder): Promise<AssignmentFeedback | null> => {
      const submissions = await client
        .le<SubmissionEntity[]>(`/${courseId}/dropbox/folders/${folder.Id}/submissions/`)
        .catch(() => [] as SubmissionEntity[]);

      const mine = submissions[0];
      if (!mine) return null;

      const feedback = mine.Feedback ?? null;
      const comment = richText(feedback?.Feedback);
      const rubrics = extractRubrics(feedback?.RubricAssessments ?? null);
      const latest = mine.Submissions?.[0];

      // A folder with no score, no comment, no rubric and no submission has nothing to say.
      const hasAnything =
        feedback?.Score != null || comment || rubrics.length > 0 || latest !== undefined;
      if (!hasAnything) return null;

      return {
        folderId: folder.Id,
        folderName: folder.Name,
        score: feedback?.Score ?? null,
        outOf: folder.Assessment?.ScoreDenominator ?? null,
        comment,
        isGraded: feedback?.IsGraded === true,
        gradedSymbol: feedback?.GradedSymbol ?? null,
        rubrics,
        attachments: (feedback?.Files ?? []).map((f) => f.FileName ?? "").filter(Boolean),
        submittedAt: latest?.SubmissionDate ?? mine.CompletionDate ?? null,
        submittedFiles: (latest?.Files ?? []).map((f) => f.FileName ?? "").filter(Boolean),
      };
    }),
  );

  return results.filter((r): r is AssignmentFeedback => r !== null);
}

export function extractRubrics(
  assessments: NonNullable<SubmissionEntity["Feedback"]>["RubricAssessments"],
): RubricCriterion[] {
  if (!assessments?.length) return [];

  return assessments.flatMap((assessment) =>
    (assessment.Criteria ?? []).map((criterion) => ({
      name: criterion.Name ?? "(unnamed criterion)",
      level: criterion.LevelName ?? null,
      score: criterion.Score ?? null,
      outOf: criterion.OutOf ?? null,
      // Per-criterion feedback is often the most specific thing an instructor writes.
      feedback: truncate(richText(criterion.Feedback), 600),
    })),
  );
}
