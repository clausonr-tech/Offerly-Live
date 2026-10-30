// The model half of the drafter's suggestions: natural phrasing for the facts
// the rules found, and answers to the open questions ("what do you want to
// learn from them?") from the same facts - one call per student and
// recipient, cached by draft-suggestions-db.ts.
//
// The prompt and the parser are pure and exported, so what the model is told
// and what the student is shown can both be tested without a call.

import { findBlockedLanguage } from "@/lib/content-limits";
import { CATEGORY_LABELS } from "@/lib/firm-metadata";
import {
  SUGGESTED_FIELDS,
  clip,
  type Connection,
  type SuggestedField,
  type SuggestionRecipient,
  type SuggestionSet,
  type SuggestionStudent,
} from "@/lib/draft-suggestions";

/** What each field asks, in the words the form uses - so the model answers
 *  the question the student actually sees. */
const FIELD_QUESTIONS: Record<SuggestedField, string> = {
  specificReason: "What you and this person have in common",
  introReason: "Why them? (why this person in particular)",
  financeInterest: "What part of finance draws you?",
  wantToLearn: "What do you want to learn from this person?",
  personalConnection: "How does it connect to you? (the student's own tie to it)",
  interviewTeam: "Firm and team",
};

export const SUGGESTION_SYSTEM =
  "You suggest answers a college student can put in the boxes of an outreach-email form, about one real person " +
  "they are writing to. The student reads each suggestion and chooses whether to use it.\n\n" +
  "RULES:\n" +
  "- Use ONLY the facts under STUDENT, RECIPIENT and CONNECTIONS. Never invent anything about either person: no " +
  "schools, clubs, places, employers, dates, deals, groups or opinions that are not written there.\n" +
  "- Common ground (specificReason, introReason) comes ONLY from CONNECTIONS. If CONNECTIONS is empty, return an " +
  "empty string for both - never manufacture a connection from the target industry or the firm.\n" +
  "- Write each answer the way a student jots notes in a form: short, specific, first person where it is about " +
  "them, under 25 words, no greeting, no full email, no quotation marks.\n" +
  "- wantToLearn: one or two concrete things this person's role, team, firm or path could teach, grounded in what " +
  "is written about them.\n" +
  "- personalConnection and financeInterest: from the student's own profile only. Empty if the profile says " +
  "nothing relevant.\n" +
  "- Tone: genuine and humble. No flattery, no buzzwords, no em dashes.\n" +
  "- NOTHING HATEFUL OR PROFANE: never write profanity, a slur, or anything that demeans people for their race, " +
  "ethnicity, religion, gender, sexuality, disability or background, even when the facts contain it.\n" +
  "- An empty string is always a correct answer when the facts do not support one.\n\n" +
  "Reply with one JSON object and nothing else, with exactly these keys: " +
  SUGGESTED_FIELDS.join(", ") +
  ".";

/** One labelled fact on one line. Whitespace collapsed, so a background that
 *  runs over several lines cannot start a section of its own in the prompt. */
const line = (label: string, value: unknown) => {
  if (value === null || value === undefined) return null;
  const text = (Array.isArray(value) ? value.filter(Boolean).join(", ") : String(value))
    .replace(/\s+/g, " ")
    // Nor can a fact borrow a section's heading ("CONNECTIONS (verified on
    // both sides):") to pass itself off as one.
    .replace(/\b(?:STUDENT|RECIPIENT|CONNECTIONS|THE FORM'S QUESTIONS)\b[^:]{0,40}:/gi, "")
    .trim();
  return text ? `${label}: ${text}` : null;
};

/** The user message: both sides' facts and the connections, as labelled lines. */
export function suggestionPrompt(
  student: SuggestionStudent,
  recipient: SuggestionRecipient,
  connections: Connection[],
): string {
  const studentFacts = [
    line("School", student.school),
    line("Graduating", student.gradYear),
    line("Major", student.major),
    line("Hometown", student.hometown),
    line("Clubs and activities", student.clubsAndActivities),
    line("Interests", student.interests),
    line("Prior experience", student.priorExperience),
    // By name, not the database key: "Investment Banking", not investment_banking.
    line(
      "Sectors they are recruiting for",
      [...new Set(student.preferredCategories ?? [])].map(
        (c) => CATEGORY_LABELS[c as keyof typeof CATEGORY_LABELS] ?? c.replace(/_/g, " "),
      ),
    ),
    line("Group they want", student.targetGroup),
    line("Why finance", student.motivations),
    line("Something they are proud of", student.proudExperience),
  ].filter(Boolean);
  const recipientFacts = [
    line("Name", recipient.name),
    line("Firm", recipient.firm),
    line("Role", recipient.role),
    line("Group", recipient.group),
    line("School", recipient.school),
    line("Graduated", recipient.gradYear),
    line("City", recipient.currentCity),
    line("Background", recipient.background),
    line("Notes", recipient.notes),
  ].filter(Boolean);
  const found = connections.length
    ? connections.map((c) => `- ${c.note} (${c.kind})`).join("\n")
    : "(none found)";
  const asked = SUGGESTED_FIELDS.map((f) => `- ${f}: ${FIELD_QUESTIONS[f]}`).join("\n");

  return (
    `STUDENT:\n${studentFacts.join("\n") || "(nothing on file)"}\n\n` +
    `RECIPIENT:\n${recipientFacts.join("\n")}\n\n` +
    `CONNECTIONS (verified on both sides):\n${found}\n\n` +
    `THE FORM'S QUESTIONS:\n${asked}`
  );
}

/**
 * The model's answer as suggestions the student may be shown.
 *
 * Forgiving about the wrapping (a code fence, prose around the object) and
 * strict about the contents: unknown keys dropped, blanks dropped, anything
 * too long clipped, and anything the language check blocks dropped - model
 * output shown to a person goes through the same check as what people type.
 * Common ground with no connection behind it is dropped too, whatever the
 * model says: that is the one field where a guess reaches a real inbox.
 */
export function parseSuggestions(raw: string, connections: Connection[]): SuggestionSet {
  // The object from the first "{" to whichever "}" closes it: prose after it
  // may carry braces of its own, and a trailing comma is forgiven.
  const start = raw.indexOf("{");
  if (start < 0) return {};
  let data: unknown;
  for (let end = raw.lastIndexOf("}"); end > start && data === undefined; end = raw.lastIndexOf("}", end - 1)) {
    try {
      data = JSON.parse(raw.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1"));
    } catch {
      // try the next "}" in
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};

  const out: SuggestionSet = {};
  for (const field of SUGGESTED_FIELDS) {
    const value = (data as Record<string, unknown>)[field];
    if (typeof value !== "string") continue;
    let text = value.replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
    text = text.replace(/^["'“”]+|["'“”]+$/g, "").trim();
    if (!text) continue;
    if (findBlockedLanguage(text)) continue;
    if ((field === "specificReason" || field === "introReason") && connections.length === 0) continue;
    text = clip(text);
    out[field] = {
      text,
      source: "ai",
      basis: field === "specificReason" || field === "introReason" ? connections.slice(0, 2).map((c) => c.label) : [],
    };
  }
  return out;
}
