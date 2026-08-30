/**
 * Shapes returned by the Valence API.
 *
 * These cover only the fields the tools actually read. Valence returns a great deal more, and
 * transcribing all of it would be noise — every block here is declared from the published
 * schema at docs.valence.desire2learn.com, narrowed to what we use.
 */

export interface OrgUnitInfo {
  Id: number;
  Type: { Id: number; Code: string; Name: string };
  Name: string;
  Code: string | null;
  HomeUrl: string | null;
  ImageUrl: string | null;
}

export interface MyOrgUnitInfo {
  OrgUnit: OrgUnitInfo;
  Access: {
    IsActive: boolean;
    StartDate: string | null;
    EndDate: string | null;
    CanAccess: boolean;
    ClasslistRoleName: string | null;
    LISRoles: string[];
    LastAccessed: string | null;
  };
  PinDate: string | null;
}

export interface GradeValue {
  DisplayedGrade: string | null;
  GradeObjectIdentifier: string;
  GradeObjectName: string;
  GradeObjectType: number;
  GradeObjectTypeName: string;
  PointsNumerator?: number | null;
  PointsDenominator?: number | null;
  WeightedDenominator?: number | null;
  WeightedNumerator?: number | null;
  Comments?: { Text: string; Html: string } | null;
  LastModified?: string | null;
}

export interface GradeObject {
  Id: number;
  Name: string;
  ShortName: string | null;
  GradeType: string;
  CategoryId: number | null;
  Description?: { Text: string; Html: string } | null;
  MaxPoints?: number | null;
  Weight?: number | null;
  IsBonus?: boolean;
  /** ToolId 3000 is a discussion topic, 1 a dropbox folder. */
  AssociatedTool?: { ToolId?: number; ToolItemId?: number } | null;
  ExcludeFromFinalGradeCalculation?: boolean;
}

export interface DropboxFolder {
  Id: number;
  CategoryId?: number | null;
  Name: string;
  DueDate: string | null;
  Availability: { StartDate: string | null; EndDate: string | null } | null;
  TotalUsersWithSubmissions?: number;
  TotalUsersWithFeedback?: number;
  GradeItemId: number | null;
  Assessment?: { ScoreDenominator: number | null } | null;
  CustomInstructions?: { Text: string; Html: string } | null;
  GroupTypeId?: number | null;
  DropboxType?: number | null;
  SubmissionType?: number | null;
  Attachments?: Array<{ FileId: number; FileName: string; Size: number }> | null;
  LinkAttachments?: Array<{
    LinkId: number;
    LinkName: string;
    Href: string | null;
  }> | null;
}

/**
 * A node in the content tree.
 *
 * Modules and topics share one shape here because that is how Brightspace actually returns
 * them: `content/root/` and `content/modules/(id)/structure/` both yield objects keyed on `Id`
 * with a numeric `Type` (1 = topic, 0 = module), *not* the `ModuleId`/`TopicId` split the
 * published schema describes. `Structure` carries a module's children inline, so a whole
 * subtree usually arrives in one response.
 */
export interface ContentNode {
  Id: number;
  Title: string;
  ShortTitle?: string | null;
  /** 0 for a module (a folder), 1 for a topic (a file, link, or page). */
  Type: number;
  /** File, link, or page type. See ACTIVITY_TYPE. */
  ActivityType?: number | null;
  /** Site-relative path for a file topic; absolute for an external link. */
  Url?: string | null;
  IsHidden?: boolean;
  IsLocked?: boolean;
  IsBroken?: boolean;
  Description?: { Text?: string; Html?: string } | null;
  ModuleStartDate?: string | null;
  ModuleEndDate?: string | null;
  ModuleDueDate?: string | null;
  StartDate?: string | null;
  EndDate?: string | null;
  DueDate?: string | null;
  GradeItemId?: number | null;
  LastModifiedDate?: string | null;
  ParentModuleId?: number | null;
  /** Children, present on modules. Absent when a module has not been expanded. */
  Structure?: ContentNode[] | null;
}

/** Type 1 is a topic — something with content behind it — and 0 is a containing module. */
export const CONTENT_TYPE_TOPIC = 1;

export interface NewsItem {
  Id: number;
  Title: string;
  Body: { Text: string; Html: string };
  StartDate: string | null;
  EndDate: string | null;
  IsHidden: boolean;
  IsGlobal: boolean;
}

export interface QuizInfo {
  QuizId: number;
  Name: string;
  IsActive: boolean;
  StartDate: string | null;
  EndDate: string | null;
  DueDate: string | null;
  AttemptsAllowed?: { IsUnlimited: boolean; NumberOfAttemptsAllowed: number | null } | null;
}

/** Valence encodes content type as a number; these are the values we surface. */
export const ACTIVITY_TYPE: Record<number, string> = {
  1: "File",
  2: "Link",
  3: "Assignment",
  4: "Quiz",
  5: "Discussion",
  6: "Survey",
  7: "SCORM",
  8: "Checklist",
  9: "Self assessment",
  10: "LTI",
};
