/**
 * Deadlines across every course.
 *
 * "What is due this week?" is the question a student actually asks, and answering it per-course
 * makes a model run one tool per course and stitch the results together — slow, and easy to get
 * wrong by forgetting a course. This gathers assignments and quizzes from every active course
 * at once and returns one ordered list.
 */

import type { D2LClient } from "./client.js";
import { listAssignments, listQuizzes } from "./coursework.js";
import { listCourses, type Course } from "./courses.js";

export interface Deadline {
  courseId: number;
  courseName: string;
  kind: "assignment" | "quiz";
  id: number;
  name: string;
  dueDate: string;
  /** `null` when D2L does not disclose submission state to the student. */
  submitted: boolean | null;
  outOf: number | null;
}

export async function getUpcoming(
  client: D2LClient,
  options: { withinDays?: number; includeSubmitted?: boolean; includeOverdue?: boolean } = {},
): Promise<{ deadlines: Deadline[]; courses: Course[]; failures: string[] }> {
  const withinDays = options.withinDays ?? 14;
  const courses = await listCourses(client);

  const now = Date.now();
  const horizon = now + withinDays * 24 * 60 * 60 * 1000;
  // A little slack behind "now" so something that closed hours ago still shows as overdue.
  const floor = options.includeOverdue === false ? now : now - 7 * 24 * 60 * 60 * 1000;

  const failures: string[] = [];

  // One course failing — a permissions quirk, a tool the instructor disabled — must not lose
  // the deadlines from every other course, so each is settled independently.
  const perCourse = await Promise.all(
    courses.map(async (course): Promise<Deadline[]> => {
      const [assignments, quizzes] = await Promise.all([
        listAssignments(client, course.id).catch(() => {
          failures.push(`${course.name}: assignments unavailable`);
          return [];
        }),
        listQuizzes(client, course.id).catch(() => {
          // Quizzes are commonly switched off entirely; that is not worth reporting.
          return [];
        }),
      ]);

      const deadlines: Deadline[] = [];

      for (const a of assignments) {
        if (!a.dueDate) continue;
        deadlines.push({
          courseId: course.id,
          courseName: course.name,
          kind: "assignment",
          id: a.id,
          name: a.name,
          dueDate: a.dueDate,
          submitted: a.submitted,
          outOf: a.outOf,
        });
      }

      for (const q of quizzes) {
        const due = q.dueDate ?? q.endDate;
        if (!due) continue;
        deadlines.push({
          courseId: course.id,
          courseName: course.name,
          kind: "quiz",
          id: q.id,
          name: q.name,
          dueDate: due,
          // Quiz attempts are a separate resource; nothing here says whether it was taken.
          submitted: null,
          outOf: null,
        });
      }

      return deadlines;
    }),
  );

  const deadlines = perCourse
    .flat()
    .filter((d) => {
      const at = Date.parse(d.dueDate);
      if (Number.isNaN(at) || at < floor || at > horizon) return false;
      // Only hide work D2L positively confirms was submitted. An unknown stays visible: a
      // missed deadline is far more costly than a redundant reminder.
      if (!options.includeSubmitted && d.submitted === true) return false;
      return true;
    })
    .sort((a, b) => Date.parse(a.dueDate) - Date.parse(b.dueDate));

  return { deadlines, courses, failures };
}
