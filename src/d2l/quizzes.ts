/**
 * Quiz attempts, and which questions were answered correctly.
 *
 * This is the one place the server parses HTML rather than reading an API, and it is deliberate.
 * Valence exposes `quizzes/(id)/attempts/`, but a student calling it gets
 * `403 Not authorized for Quizzing.GradeAttempts` — the route is for instructors marking work,
 * not for a learner reading their own result. There is no student-facing equivalent, and unlike
 * rubrics there is no hypermedia service behind the page either: quizzing is still the older
 * server-rendered UI.
 *
 * So the attempt page is parsed. The markup is stable in the way that matters — each option is a
 * table row whose first cell carries a verdict icon and whose second carries the student's
 * selection — but it is markup, and it will break if D2L rewrites the page. When that happens,
 * or when a real API appears, this module is the only thing that needs replacing.
 */

import type { D2LClient } from "./client.js";
import { htmlToText } from "./format.js";

export interface QuizAttempt {
  attemptId: number;
  attemptNumber: number;
  score: number | null;
  outOf: number | null;
}

/**
 * How a question was answered, which determines what can be said about it.
 *
 * `choice` covers anything with selectable options — multiple choice, true/false, select-all.
 * `matching` uses dropdowns and reports only per-pairing verdicts. `written` is free response,
 * marked by a human, so the page shows the student's text and no verdict at all.
 */
export type QuestionType = "choice" | "matching" | "written";

/** One option on a multiple-choice question, and how it fared. */
export interface Option {
  text: string;
  /** Whether the marking scheme accepts this option. */
  isCorrect: boolean;
  /** Whether the student picked it. */
  selected: boolean;
}

export interface AnsweredQuestion {
  number: number;
  text: string;
  type: QuestionType;
  /**
   * True when the student selected exactly the options marked correct.
   *
   * Null only for free response, where the page carries no verdict — not a failure to parse,
   * but a question a marker has to judge.
   */
  isCorrect: boolean | null;
  /**
   * Every option offered, in the order shown, for `choice` questions.
   *
   * The chosen options alone are often unreadable — an answer of "F) Just A) and C) above"
   * means nothing without A and C — so the whole list travels with the question. Empty for
   * matching and free response, which have no options.
   */
  options: Option[];
  /** The options chosen, the pairings made, or the text written. */
  yourAnswers: string[];
  /** What the marking scheme accepts. Empty for free response. */
  correctAnswers: string[];
}

export interface AttemptDetail {
  attemptId: number;
  quizId: number;
  quizName: string | null;
  score: number | null;
  outOf: number | null;
  questions: AnsweredQuestion[];
  correctCount: number;
  incorrectCount: number;
}

/**
 * The attempts a student has made on one quiz.
 *
 * Read from the submissions page, whose rows carry the attempt id in a link and the score
 * beside it.
 */
export async function listQuizAttempts(
  client: D2LClient,
  courseId: number,
  quizId: number,
): Promise<QuizAttempt[]> {
  const html = await client.fetchText(
    `/d2l/lms/quizzing/user/quiz_submissions.d2l?ou=${courseId}&qi=${quizId}`,
  );
  const unescaped = html.split("\\/").join("/").replace(/&amp;/g, "&");

  const attempts = new Map<number, QuizAttempt>();
  for (const match of unescaped.matchAll(/quiz_submissions_attempt\.d2l\?[^"'\\\s]*\bai=(\d+)/g)) {
    const attemptId = Number(match[1]);
    if (attempts.has(attemptId)) continue;

    // The score sits in the same table row as the link. Reading a window after the link is
    // cruder than walking the DOM but survives the surrounding markup changing.
    const window = unescaped.slice(match.index!, match.index! + 1200);
    const plain = htmlToText(window).replace(/\s+/g, " ");
    const scored = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(plain);
    const numbered = /Attempt\s+(\d+)/i.exec(plain);

    attempts.set(attemptId, {
      attemptId,
      attemptNumber: numbered ? Number(numbered[1]) : attempts.size + 1,
      score: scored ? Number(scored[1]) : null,
      outOf: scored ? Number(scored[2]) : null,
    });
  }

  return [...attempts.values()].sort((a, b) => a.attemptNumber - b.attemptNumber);
}

export async function getAttemptDetail(
  client: D2LClient,
  courseId: number,
  quizId: number,
  attemptId: number,
): Promise<AttemptDetail> {
  const html = await client.fetchText(
    `/d2l/lms/quizzing/user/quiz_submissions_attempt.d2l?isprv=&qi=${quizId}&ai=${attemptId}` +
      `&isInPopup=0&cfql=0&fromQB=0&fromSubmissionsList=1&ou=${courseId}`,
  );

  const questions = parseQuestions(html);
  const overall = attemptScore(html);

  return {
    attemptId,
    quizId,
    quizName: /<title>([^<]*)<\/title>/.exec(html)?.[1]?.split(" - ")[0]?.trim() ?? null,
    score: overall ? Number(overall[1]) : null,
    outOf: overall ? Number(overall[2]) : null,
    questions,
    correctCount: questions.filter((q) => q.isCorrect === true).length,
    incorrectCount: questions.filter((q) => q.isCorrect === false).length,
  };
}

/**
 * The score for this attempt.
 *
 * Anchored on the "Attempt Score" label because the page also shows an overall grade across
 * attempts just below it, and on a multi-attempt quiz the two differ.
 */
function attemptScore(html: string): RegExpExecArray | null {
  const label = html.indexOf("Attempt Score");
  if (label === -1) return null;
  const area = htmlToText(html.slice(label, label + 2000)).replace(/\s+/g, " ");
  return /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(area);
}

/**
 * Splits the page at each "Question N" heading and reads the options beneath it.
 *
 * Two independent markers per option carry the answer: a verdict icon saying whether the option
 * is one of the correct ones, and a checkbox image saying whether the student picked it.
 * Comparing the two sets is what decides whether the question was right — the page never states
 * that directly.
 */
export function parseQuestions(html: string): AnsweredQuestion[] {
  const headings = [...html.matchAll(/Question\s+(\d+)/g)];
  const questions: AnsweredQuestion[] = [];

  for (let i = 0; i < headings.length; i++) {
    const start = headings[i]!.index!;
    const end = headings[i + 1]?.index ?? html.length;
    const block = html.slice(start, end);

    const options = parseOptions(block);
    const chosen = options.filter((o) => o.selected).map((o) => o.text);
    const correct = options.filter((o) => o.isCorrect).map((o) => o.text);

    const type = questionType(block, options);
    const pairings = type === "matching" ? parseMatching(block) : [];

    questions.push({
      number: Number(headings[i]![1]),
      text: questionText(block),
      type,
      isCorrect: verdict(block, options, chosen, correct),
      options,
      yourAnswers:
        type === "written"
          ? // Free response has no options to select, so the response itself is the answer.
            writtenAnswer(block)
          : type === "matching"
            ? pairings.map((p) => `${p.item} → ${p.chosen}`)
            : chosen,
      correctAnswers:
        type === "matching"
          ? // Only the misplaced ones: the page states the right term for those alone, and
            // repeating the pairings already shown as correct says nothing new.
            pairings
              .filter((p) => !p.isCorrect && p.correct !== null)
              .map((p) => `${p.item} → ${p.correct}`)
          : correct,
    });
  }

  return questions;
}

/** Distinguished by which markers the page carries, since the type is never stated. */
function questionType(block: string, options: Option[]): QuestionType {
  if (options.length > 0) return "choice";
  if (/alt="(Correct|Incorrect) Response"/.test(block)) return "matching";
  return "written";
}

/**
 * Whether the question was answered correctly.
 *
 * Choice questions state it indirectly: compare what the student selected against what the
 * scheme marks correct. Matching questions have no selectable options — only one verdict icon
 * per pairing — so the absence of any "Incorrect Response" is the answer.
 *
 * Free response gets null, because a human marks it and the page shows no verdict. That is a
 * property of the question, not a gap in the parsing.
 */
function verdict(
  block: string,
  options: Option[],
  chosen: string[],
  correct: string[],
): boolean | null {
  if (options.length > 0) return sameSet(chosen, correct);
  if (/alt="Incorrect Response"/.test(block)) return false;
  if (/alt="Correct Response"/.test(block)) return true;
  return null;
}

/** One row of a matching question: an item, and the term the student put against it. */
interface Pairing {
  item: string;
  chosen: string;
  /** The term that belonged there. Stated by the page only where the student got it wrong. */
  correct: string | null;
  isCorrect: boolean;
}

/**
 * Reads a matching question, which the page lays out as two tables side by side.
 *
 * The left one has a row per item: a verdict icon, the number the student chose in `__2__`
 * form, and the item's text. Where the student was wrong, the number that belonged there
 * follows in parentheses. The right one is the key — the numbered terms those refer to — so
 * the numbers are resolved back into terms and never surface.
 */
function parseMatching(block: string): Pairing[] {
  const key = new Map<string, string>();
  for (const term of block.matchAll(
    /<strong>(\d+)<\/strong>\s*\.[\s\S]{0,400}?<d2l-html-block[^>]*\bhtml="([^"]*)"/g,
  )) {
    key.set(term[1]!, htmlToText(decodeEntities(term[2]!)).replace(/\s+/g, " ").trim());
  }

  const pairings: Pairing[] = [];
  for (const row of block.matchAll(
    /alt="(Correct|Incorrect) Response"[\s\S]{0,400}?class="ds_d">(\d+)<([\s\S]{0,400}?)<d2l-html-block[^>]*\bhtml="([^"]*)"/g,
  )) {
    const answer = /<strong>\((\d+)\)<\/strong>/.exec(row[3]!)?.[1];
    pairings.push({
      item: htmlToText(decodeEntities(row[4]!)).replace(/\s+/g, " ").trim(),
      chosen: key.get(row[2]!) ?? row[2]!,
      correct: answer !== undefined ? (key.get(answer) ?? answer) : null,
      isCorrect: row[1] === "Correct",
    });
  }

  return pairings;
}

/**
 * The student's typed response.
 *
 * The page renders question and answer as separate rich-text blocks, question first, so
 * everything after the first block is what they wrote.
 */
function writtenAnswer(block: string): string[] {
  const blocks = [...block.matchAll(/<d2l-html-block[^>]*\bhtml="([^"]*)"/gi)];
  return blocks
    .slice(1)
    .map((m) => htmlToText(decodeEntities(m[1]!)).replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 0)
    .map((t) => t.slice(0, 2000));
}

/**
 * Each option is a table row: the first cell holds the verdict icon, the second the checkbox
 * and the option's text. They are read as a pair so an option is never credited with a verdict
 * belonging to its neighbour.
 */
function parseOptions(block: string): Option[] {
  const options: Option[] = [];

  // Anchor on the selection marker, then look back for the nearest verdict icon.
  for (const marker of block.matchAll(/alt="(Selected|Unselected)"/g)) {
    const before = block.slice(Math.max(0, marker.index! - 600), marker.index!);
    const verdicts = [...before.matchAll(/alt="(Correct Response|Incorrect Response|Correct Answer)"/g)];
    const nearest = verdicts[verdicts.length - 1]?.[1] ?? null;

    const after = block.slice(marker.index!, marker.index! + 1500);
    const text = optionText(after);
    if (!text) continue;

    options.push({
      text,
      // "Correct Response" and "Correct Answer" both mark an option the scheme accepts;
      // "Incorrect Response" marks one it does not.
      isCorrect: nearest === "Correct Response" || nearest === "Correct Answer",
      selected: marker[1] === "Selected",
    });
  }

  return options;
}

/** Option text lives inside a d2l-html-block, itself HTML-encoded inside an attribute. */
function optionText(fragment: string): string {
  const encoded = /<d2l-html-block[^>]*\bhtml="([^"]*)"/i.exec(fragment)?.[1];
  const source = encoded ? decodeEntities(encoded) : fragment;
  return htmlToText(source).replace(/\s+/g, " ").trim().slice(0, 300);
}

function questionText(block: string): string {
  const encoded = /<d2l-html-block[^>]*\bhtml="([^"]*)"/i.exec(block)?.[1];
  if (encoded) return htmlToText(decodeEntities(encoded)).replace(/\s+/g, " ").trim().slice(0, 600);
  return htmlToText(block).replace(/\s+/g, " ").trim().slice(0, 600);
}

/** Attribute-embedded markup is double-encoded, so entities need one pass before parsing. */
function decodeEntities(value: string): string {
  return value
    .replace(/&amp;#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  const left = new Set(a);
  return b.every((value) => left.has(value));
}
