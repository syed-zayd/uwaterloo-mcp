/**
 * A student's assignment submission history.
 *
 * Brightspace calls assignments "dropbox folders" in Valence. The student-facing submissions
 * route is unusually complete: every attempt has its own comment and file list, while the
 * published feedback sits once on the enclosing user/group record. Keeping those levels intact
 * matters for assignments that allow retries — collapsing to the newest submission would hide
 * exactly the earlier code or document an AI may have been asked to compare.
 */

import type { D2LClient } from "./client.js";
import { getCourseGroups } from "./classlist.js";
import { extractRubrics, type RubricCriterion } from "./feedback.js";
import { richText } from "./format.js";
import type { DropboxFolder } from "./types.js";

export interface SubmissionFileRef {
  id: number;
  name: string;
  size: number;
  isRead: boolean;
  isFlagged: boolean;
  isDeleted: boolean;
}

export interface SubmissionAttempt {
  id: number;
  number: number;
  submittedAt: string | null;
  submittedBy: { id: string; name: string };
  comment: string;
  files: SubmissionFileRef[];
}

export interface SubmissionFeedback {
  score: number | null;
  outOf: number | null;
  comment: string;
  isGraded: boolean;
  gradedSymbol: string | null;
  rubrics: RubricCriterion[];
  attachments: Array<{ id: number; name: string; size: number }>;
  links: Array<{ id: number; name: string; type: string; url: string | null }>;
}

export interface AssignmentSubmissionHistory {
  assignment: {
    id: number;
    name: string;
    instructions: string;
    dueDate: string | null;
    availableFrom: string | null;
    availableUntil: string | null;
    outOf: number | null;
    isGroup: boolean;
    submissionType: "file" | "text" | "on_paper" | "observed" | "file_or_text" | "unknown";
    instructionFiles: Array<{ id: number; name: string; size: number }>;
    instructionLinks: Array<{ id: number; name: string; url: string | null }>;
  };
  entity: { id: number; type: "user" | "group"; name: string } | null;
  status: "unsubmitted" | "submitted" | "draft" | "published" | "unknown";
  completedAt: string | null;
  submissions: SubmissionAttempt[];
  feedback: SubmissionFeedback | null;
}

interface RawFile {
  FileId?: number;
  FileName?: string;
  Size?: number;
  IsRead?: boolean;
  isRead?: boolean;
  IsFlagged?: boolean;
  isFlagged?: boolean;
  IsDeleted?: boolean;
}

interface RawEntityDropbox {
  Entity?: {
    EntityId?: number;
    EntityType?: string;
    DisplayName?: string;
    Name?: string;
  };
  Status?: number;
  CompletionDate?: string | null;
  Feedback?: {
    Score?: number | null;
    Feedback?: { Text?: string; Html?: string } | null;
    RubricAssessments?: Parameters<typeof extractRubrics>[0];
    IsGraded?: boolean;
    GradedSymbol?: string | null;
    Files?: RawFile[] | null;
    Links?: Array<{
      Type?: string;
      LinkId?: number;
      LinkName?: string;
      Href?: string | null;
    }> | null;
  } | null;
  Submissions?: Array<{
    Id?: number;
    SubmittedBy?: { Identifier?: string | number; Id?: string | number; DisplayName?: string };
    SubmissionDate?: string | null;
    Comment?: { Text?: string; Html?: string } | null;
    Files?: RawFile[] | null;
  }> | null;
}

const SUBMISSION_TYPES: Record<number, AssignmentSubmissionHistory["assignment"]["submissionType"]> = {
  0: "file",
  1: "text",
  2: "on_paper",
  3: "observed",
  4: "file_or_text",
};

const STATUSES: Record<number, AssignmentSubmissionHistory["status"]> = {
  0: "unsubmitted",
  1: "submitted",
  2: "draft",
  3: "published",
};

/** Resolve a visible assignment by id, exact name, or unambiguous partial name. */
export async function resolveDropboxFolder(
  client: D2LClient,
  courseId: number,
  reference: string,
): Promise<DropboxFolder> {
  const folders = await client.le<DropboxFolder[]>(`/${courseId}/dropbox/folders/`);
  const query = reference.trim();
  const byId = folders.find((folder) => String(folder.Id) === query);
  if (byId) return byId;

  const normalise = (value: string): string => value.toLowerCase().replace(/[\s_-]+/g, "");
  const target = normalise(query);
  const exact = folders.filter((folder) => normalise(folder.Name) === target);
  if (exact.length === 1) return exact[0]!;

  const partial = folders.filter((folder) => normalise(folder.Name).includes(target));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    throw new Error(
      `"${reference}" matches several assignments: ${partial.map((folder) => folder.Name).join(", ")}. Use the assignment id.`,
    );
  }
  throw new Error(`No assignment matches "${reference}". Call list_assignments to see them.`);
}

/** Every submission attempt made by the current user, or by their group for a group folder. */
export async function getSubmissionHistory(
  client: D2LClient,
  courseId: number,
  folder: DropboxFolder,
): Promise<AssignmentSubmissionHistory> {
  let raw: RawEntityDropbox[];

  if (folder.GroupTypeId != null) {
    const [user, groups] = await Promise.all([client.whoami(), getCourseGroups(client, courseId)]);
    const group = groups.find(
      (candidate) =>
        candidate.categoryId === folder.GroupTypeId &&
        candidate.memberIds.includes(String(user.Identifier)),
    );
    if (!group) {
      throw new Error(
        `${folder.Name} is a group assignment, but the signed-in user is not in one of its groups.`,
      );
    }

    const response = await client.le<RawEntityDropbox | RawEntityDropbox[]>(
      `/${courseId}/dropbox/folders/${folder.Id}/submissions/group/${group.id}`,
    );
    raw = Array.isArray(response) ? response : [response];
  } else {
    raw = await client.le<RawEntityDropbox[]>(
      `/${courseId}/dropbox/folders/${folder.Id}/submissions/mysubmissions/`,
    );
  }

  return makeHistory(folder, raw);
}

function makeHistory(folder: DropboxFolder, entities: RawEntityDropbox[]): AssignmentSubmissionHistory {
  const entity = entities[0];
  const feedback = entity?.Feedback ?? null;
  const attempts = entities
    .flatMap((record) => record.Submissions ?? [])
    .filter((submission) => submission.Id !== undefined)
    .sort(
      (a, b) =>
        Date.parse(a.SubmissionDate ?? "1970-01-01") -
        Date.parse(b.SubmissionDate ?? "1970-01-01"),
    )
    .map(
      (submission, index): SubmissionAttempt => ({
        id: submission.Id!,
        number: index + 1,
        submittedAt: submission.SubmissionDate ?? null,
        submittedBy: {
          id: String(submission.SubmittedBy?.Identifier ?? submission.SubmittedBy?.Id ?? ""),
          name: submission.SubmittedBy?.DisplayName?.trim() || "Unknown",
        },
        comment: richText(submission.Comment),
        files: (submission.Files ?? []).flatMap((file) =>
          file.FileId === undefined ? [] : [toSubmissionFile(file)],
        ),
      }),
    );

  return {
    assignment: {
      id: folder.Id,
      name: folder.Name,
      instructions: richText(folder.CustomInstructions),
      dueDate: folder.DueDate,
      availableFrom: folder.Availability?.StartDate ?? null,
      availableUntil: folder.Availability?.EndDate ?? null,
      outOf: folder.Assessment?.ScoreDenominator ?? null,
      isGroup: folder.GroupTypeId != null,
      submissionType: SUBMISSION_TYPES[folder.SubmissionType ?? -1] ?? "unknown",
      instructionFiles: (folder.Attachments ?? []).map((file) => ({
        id: file.FileId,
        name: file.FileName,
        size: file.Size,
      })),
      instructionLinks: (folder.LinkAttachments ?? []).map((link) => ({
        id: link.LinkId,
        name: link.LinkName,
        url: link.Href,
      })),
    },
    entity: entity?.Entity?.EntityId
      ? {
          id: entity.Entity.EntityId,
          type: entity.Entity.EntityType?.toLowerCase() === "group" ? "group" : "user",
          name:
            entity.Entity.DisplayName?.trim() ||
            entity.Entity.Name?.trim() ||
            `Entity ${entity.Entity.EntityId}`,
        }
      : null,
    status: entity ? (STATUSES[entity.Status ?? -1] ?? "unknown") : "unsubmitted",
    completedAt: entity?.CompletionDate ?? null,
    submissions: attempts,
    feedback: feedback
      ? {
          score: feedback.Score ?? null,
          outOf: folder.Assessment?.ScoreDenominator ?? null,
          comment: richText(feedback.Feedback),
          isGraded: feedback.IsGraded === true,
          gradedSymbol: feedback.GradedSymbol ?? null,
          rubrics: extractRubrics(feedback.RubricAssessments ?? null),
          attachments: (feedback.Files ?? []).flatMap((file) =>
            file.FileId === undefined
              ? []
              : [{ id: file.FileId, name: file.FileName?.trim() || `File ${file.FileId}`, size: file.Size ?? 0 }],
          ),
          links: (feedback.Links ?? []).flatMap((link) =>
            link.LinkId === undefined
              ? []
              : [{
                  id: link.LinkId,
                  name: link.LinkName?.trim() || `Link ${link.LinkId}`,
                  type: link.Type?.trim() || "Unknown",
                  url: link.Href ?? null,
                }],
          ),
        }
      : null,
  };
}

function toSubmissionFile(file: RawFile): SubmissionFileRef {
  return {
    id: file.FileId!,
    name: file.FileName?.trim() || `File ${file.FileId}`,
    size: file.Size ?? 0,
    isRead: file.IsRead ?? file.isRead ?? false,
    isFlagged: file.IsFlagged ?? file.isFlagged ?? false,
    isDeleted: file.IsDeleted === true,
  };
}
