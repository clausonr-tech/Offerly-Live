// What kind of calendar entry an imported one is, read from its title.
//
// An imported calendar used to land entirely as "personal", which silenced
// every prompt the app has: an imported "Evercore Superday" got no prep and no
// thank-you, an imported coffee chat no thank-you. So each entry is read the
// way the prompts already read a Google entry - the same interview and
// conversation detectors - and filed as the most likely type, marked as the
// app's guess ("detected") with the words that decided it, so the student can
// change it and their choice is final.
//
// Pure: no database.

import {
  CONVERSATION_OVER_INTERVIEW,
  COURSE_CODE,
  interviewEvidence,
  looksLikeInterview,
} from "@/lib/interview-prep-words";

export type GuessedType = "interview" | "coffee_chat" | "meeting" | "deadline" | "info_session" | "personal";

export type TypeGuess = {
  type: GuessedType;
  /** The words that decided it, or null for the "personal" default. */
  evidence: string | null;
};

/** A date an application, or a step of one, is due by. "Due" alone is not
 *  enough - "PSET 3 due", "Rent due" are not applications. */
const DEADLINE =
  /\b(?:deadline|apply by|applications? (?:close|closes|due)|submit(?:ted)? by|last day to apply|(?:app|application|hirevue|hire vue|assessment|online test|test|cover letter|resume|cv|oa)s? (?:is )?due)\b/i;

/** Not the event itself: getting there, preparing for it, or its cancellation. */
const NOT_THE_EVENT =
  /^\s*(?:cancell?ed|canceled|declined)\s*:|^\s*(?:send|email|e-mail|write|reply|respond|follow up|remind(?:er)?)\b|\b(?:travel|flight|fly(?:ing)? to|train to|drive to|hotel|check[- ]?in at|uber|lyft|prep|practice|practise|mock|debrief|rehearsal)\b/i;

/** A group gathering, however it is billed. */
const GROUP_GATHERING = /\b(?:social|mixer|night|reception|group|happy hour|dinner series|panel)\b/i;

/** A firm or club event the student attends with many others. */
const EVENT = new RegExp(
  "\\b(?:" +
    [
      "info(?:rmation)? session",
      "info sesh",
      "webinar",
      "recruiting (?:event|night|reception|dinner)",
      "career fair",
      "networking (?:night|event|reception|mixer|happy hour)",
      "open house",
      "firm presentation",
      "meet the firm",
      "office visit",
      "diversity (?:event|summit|forum)",
      "insight (?:day|week|program)",
      "panel",
      "conference",
      "summit",
      "trek",
    ].join("|") +
    ")\\b",
  "i",
);

/** A one-to-one conversation by its medium or its word. */
const MEETING = new RegExp(
  "\\b(?:" +
    [
      "call",
      "chat",
      "meeting",
      "mtg",
      "zoom",
      "google meet",
      "teams (?:call|meeting)",
      "facetime",
      "phone",
      "1:1",
      "one[- ]on[- ]one",
      "catch[- ]?up",
      "sync",
      "intro",
      "check[- ]?in",
      "lunch with",
      "dinner with",
      "drinks with",
      "meet with",
    ].join("|") +
    ")\\b",
  "i",
);

/** The student's own life: school, health, errands, family. */
const PERSONAL = /\b(?:class(?:es)?|lecture|seminar|recitation|lab|midterm|final exam|exam|quiz|homework|problem set|study(?:ing)?|office hours|gym|workout|practice|dentist|doctor|birthday|flight|travel|mom|dad|family)\b/i;

/**
 * The type an imported entry most likely is.
 *
 * In order, strongest evidence first: something due; an interview (the same
 * detector interview prep uses - "mock interview" and "interview prep" are
 * not interviews); a one-to-one coffee chat; a firm or club event; a meeting;
 * and, when nothing says otherwise, the student's own time.
 */
export function guessEventType(title: string, notes?: string | null): TypeGuess {
  const t = title.trim();
  if (!t) return { type: "personal", evidence: null };

  // Cancelled, travel to it, or preparing for it: the student's own time,
  // not the interview or the chat - no prep prompt for the flight, no
  // thank-you for the practice round.
  const notIt = NOT_THE_EVENT.exec(t);
  if (notIt) return { type: "personal", evidence: notIt[0] };

  const due = DEADLINE.exec(t);
  if (due) return { type: "deadline", evidence: due[0] };

  // Coursework before anything that could read as a meeting or an interview.
  const course = COURSE_CODE.exec(t);
  if (course) return { type: "personal", evidence: course[0] };

  if (!CONVERSATION_OVER_INTERVIEW.test(t) && looksLikeInterview(t, notes)) {
    return { type: "interview", evidence: interviewEvidence(t, notes) };
  }

  const coffee = CONVERSATION_OVER_INTERVIEW.exec(t) ?? /[☕\u{1F91D}]/u.exec(t);
  // A coffee "social" or "chat night" is a room full of people - an event.
  const gathering = GROUP_GATHERING.exec(t);
  if (coffee && gathering) return { type: "info_session", evidence: `${coffee[0]} ${gathering[0]}` };
  if (coffee) return { type: "coffee_chat", evidence: coffee[0] };

  const event = EVENT.exec(t);
  if (event) return { type: "info_session", evidence: event[0] };

  const personal = PERSONAL.exec(t);
  if (personal) return { type: "personal", evidence: personal[0] };

  const meeting = MEETING.exec(t);
  if (meeting) return { type: "meeting", evidence: meeting[0] };

  return { type: "personal", evidence: null };
}
