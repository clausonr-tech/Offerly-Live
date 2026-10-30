// "You had a coffee chat two hours ago. Send a thank-you."
//
// The cheapest email in recruiting and the one most often forgotten: it takes
// five minutes, it is expected within a day, and nobody remembers it at 9pm.
// So a couple of hours after a chat, a call or an interview ends, the student
// gets one bubble and a row on their to-do list, and the row stays until they
// send it or tick it off.
//
// Two occasions, one prompt. A chat is thanked by name when we know the name.
// An interview is thanked as the interview: the people across the table are
// rarely saved contacts, so the prompt names the round and opens the drafter
// on the right kind of interview thank-you.
//
// Pure: which calendar entries count, who they were with, and when the prompt
// is due, testable without a database or Google. The queries and the Google
// read live in thank-you-db.ts.

import { CONVERSATION_OVER_INTERVIEW, COURSE_CODE, looksLikeInterview } from "@/lib/interview-prep-words";
import { normalizeFirmName } from "@/lib/firm-name";
import { DEFAULT_TIME_ZONE, localDateString, localParts, parseTimeZone, zonedTime } from "@/lib/time-zone";

/** How long after a chat ends before the prompt: long enough to be out of the
 *  room and home, soon enough that the conversation is still fresh. */
export const THANK_YOU_AFTER_HOURS = 2;

/** How far back to look. A thank-you three weeks late is not one to prompt. */
export const THANK_YOU_LOOKBACK_DAYS = 14;

/** How long a chat is taken to last when the calendar gives no end. */
export const DEFAULT_CHAT_MINUTES = 30;

/** ...and an interview, which runs longer: a first round is 45 minutes to an
 *  hour, and prompting mid-answer is worse than prompting late. */
export const DEFAULT_INTERVIEW_MINUTES = 60;

/** An all-day interview entry - a superday blocked out as a date - is due that
 *  evening on the student's own clock, once the last room has emptied. */
export const ALL_DAY_INTERVIEW_DUE_HOUR = 18;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type ChatEvent = {
  /** Stable per calendar entry: "offerly:<id>" or "google:<id>". */
  sourceKey: string;
  title: string;
  /** Offerly's own event type, when it is an Offerly event. */
  type?: string | null;
  /** "student" when the student chose that type - then it is final. */
  typeSource?: string | null;
  /** The contact the student linked to it, when they did. */
  contactId?: string | null;
  startsAt: Date;
  endsAt: Date | null;
  allDay?: boolean;
  /** The entry's notes, when we have them - an invitation often says
   *  "interview" only there. */
  notes?: string | null;
  /** Carries a Zoom, Meet or Teams link: a call, whatever it is titled. */
  videoCall?: boolean;
  /** Everyone else on the invitation, lower-cased. Google entries only. */
  attendeeEmails?: string[];
  /** The same people, with the name the invitation gives each. */
  attendees?: { email: string; name: string | null }[];
  /** The student turned the invitation down - they were not there. */
  declined?: boolean;
  /** One instance of a repeating entry. */
  recurring?: boolean;
  /** Google's kind of entry; anything but "default" is a block of time. */
  eventType?: string;
};

export type ThankOccasion = "chat" | "interview";

export type ThankContact = { id: string; name: string; email?: string | null };

/** One person on the other side of an interview, as the invitation names them. */
export type Interviewer = {
  email: string | null;
  name: string | null;
  /** When they are one of the student's saved contacts. */
  contactId: string | null;
  /** A thank-you has gone to them since the interview began. */
  thanked: boolean;
};

/**
 * Who "Write it" is addressed to. A saved contact opens the drafter with them
 * chosen; anyone else opens "Outside of your matched contacts" with what we
 * know filled in - and nothing we do not know: a blank email is for the
 * student to fill, never a guess.
 */
type ThankRecipient = {
  contactId: string | null;
  name: string | null;
  email: string | null;
  firm: string | null;
};

export type ThankYouPrompt = {
  /** The notification's dedupe key, and what "done" is recorded against. */
  key: string;
  occasion: ThankOccasion;
  title: string;
  startsAt: Date;
  dueAt: Date;
  contact: ThankContact | null;
  href: string;
  /** Who the next note goes to. */
  next: ThankRecipient;
  /** Interviews: everyone the invitation lists, thanked or not. Empty when it
   *  lists nobody (an entry typed into Offerly) - then only the student knows
   *  when everyone is thanked, and "That's everyone" is how they say so. */
  interviewers: Interviewer[];
  /** Interviews: thank-you notes already sent for this one. */
  notesSent: number;
};

// ---------- the word bank ----------
//
// Broad on purpose: a missed thank-you is a lost relationship, and a wrong
// prompt costs one tick. What keeps broad from becoming noisy is the order the
// evidence is weighed in (see isChatEvent), not a short list: a word that
// describes the person ("Dana Reed, dad's friend", "Carlyle Group") must never
// veto the meeting it describes.

/** Build one case-insensitive whole-word alternation from a list. */
function words(list: string[], flags = "i"): RegExp {
  return new RegExp(`\\b(?:${list.join("|")})\\b`, flags);
}

/** Who students have these conversations with, as they write it. */
const ROLES =
  "analyst|associate|banker|recruiter|md|vp|director|partner|principal|trader|alum|alumn(?:us|a|i|ae)|mentor|advisor|adviser";

/**
 * Words that make an entry a one-to-one conversation outright, whatever else
 * the title says: they beat a group word ("Coffee with the Evercore team") and
 * the ordinary words that can also mean errands or family ("Coffee - hold for
 * Dana"). How students actually title these.
 */
const STRONG_CHAT = words([
  "coffee(?: ?chats?| meeting| call)?",
  "virtual coffee",
  "grab(?:bing)? coffee",
  "cup of coffee",
  "informational(?: chat| call| meeting| interview| session)?",
  "info (?:chat|call)",
  "networking (?:call|chat|coffee|lunch|convo)",
  "mentor(?:ship|ing)? (?:call|chat|meeting|session)",
  `(?:${ROLES}) (?:call|chat|coffee|meeting|lunch|zoom)`,
  // The verb first, then the role: "Call with Goldman analyst", "Lunch w/
  // Evercore VP", "Catch up with Penn alum".
  `(?:call|chat|coffee|lunch|breakfast|dinner|drinks|meeting|mtg|catch[- ]?up|zoom|convo)\\s+(?:w/?|with)\\s+(?:[\\w&.'-]+\\s+){0,3}?(?:${ROLES})`,
]);

/** Emoji students put in a title instead of a word: coffee, phone, handshake. */
const CHAT_EMOJI = /[☕\u{1F4DE}☎\u{1F91D}]/u;

/**
 * Conversation words that a group word beats: "Intro meeting - Investment
 * Club" and "Networking - Finance Society" are the student's own club.
 */
const CHAT_WORDS = words([
  "networking(?: meeting)?",
  "intro(?:ductory|duction)? (?:call|chat|meeting|convo|conversation)",
  "career (?:chat|call|conversation|advice|convo)",
  "advice (?:call|chat)",
  "meet and greet",
  "meet ?& ?greet",
  "get to know",
  "reach(?:ed)? out call",
]);

/**
 * The medium the conversation happened on. Counts on its own - "Zoom w/ Evercore
 * analyst" - but a group word beats it: "Team zoom" is a group project.
 */
const CALL_WORDS = words([
  "zoom(?: call| meeting| chat)?",
  "google meet",
  "g ?meet",
  "google hangouts?",
  "hangouts? (?:call|meeting|chat)",
  "teams (?:call|meeting|chat)",
  "ms teams",
  "webex",
  "skype",
  "whereby",
  "phone (?:call|chat|convo|conversation)",
  "video (?:call|chat)",
  "quick (?:call|chat|sync|convo)",
  "\\d{1,3}[- ]?(?:min(?:ute)?s?|mins?|hrs?|hours?) (?:call|chat|meeting|convo|sync|catch[- ]?up)",
]);

/**
 * Words that make an entry a conversation only with someone to have it with:
 * a contact named in the title, a contact on the invitation, or someone else
 * invited. "Call" alone could be anything; "Call with Dana Reed" is not.
 */
const MAYBE_CHAT_WORDS = words([
  "calls?",
  "chats?",
  "catch[- ]?up",
  "catching up",
  "meetings?",
  "meet",
  "mtg",
  "1:1",
  "1-1",
  "1 on 1",
  "one[- ]on[- ]one",
  "sync",
  "intro",
  "convo",
  "conversation",
  "talk",
  "touch ?base",
  "check[- ]?in",
  "connect",
  "lunch",
  "breakfast",
  "brunch",
  "dinner",
  "drinks",
  "tea",
  "walk",
  "meetup",
  "discussion",
  "facetime",
  "follow[- ]?up (?:call|chat|meeting)",
]);

/**
 * How booking tools and people join two names when that is the whole title:
 * "Kai <> Dana Reed", "Dana Reed x Kai", "Dana Reed/Kai", "Kai | Dana Reed".
 */
const NAME_JOINER = /(?:<>|<->|<=>|↔|\s?\/\s?|\s(?:x|X|\||&|\+|and|w\/|with)\s)/;

/** The joiners only a booking tool uses - they mean a call between two people
 *  even when neither is a saved contact. */
const BOOKING_JOINER = /(?:<>|<->|<=>|↔|\s[xX]\s)/;

/**
 * A booking tool's title for a call, with no subject of its own: Calendly's
 * "30 Minute Meeting between Kai and Dana", Google's "Invitation: ...". A call
 * only when someone else was on it.
 */
const BOOKING_TITLE =
  /(?:\b\d{1,3}[- ]?(?:min(?:ute)?s?|mins?|hrs?|hours?)\b.*\b(?:meeting|call|chat)\b|\bbetween\b.+\band\b|^invitation:|^updated invitation:|^accepted:|personal meeting room)/i;

/**
 * Never a conversation to thank someone for, whatever else the title says or
 * whoever was there: school, health, travel, blocks of time, and anything
 * about the thank-you itself.
 */
const NEVER_A_CHAT = words([
  "class(?:es)?(?!\\s+of\\b)",
  "lecture",
  "seminar",
  "office hours?",
  "recitation",
  "discussion section",
  "section \\d+",
  "lab",
  "midterm",
  "final exam",
  "exams?",
  "quiz",
  "homework",
  "hw",
  "p ?set",
  "problem set",
  "study(?:ing)?",
  "study group",
  "tutor(?:ing)?",
  "gym",
  "workout",
  "rehearsal",
  "dentist",
  "doctor",
  "therapy",
  "therapist",
  "haircut",
  "birthday",
  "bday",
  "anniversary",
  "deadline",
  "mock",
  "prep",
  "prepping",
  "preparation",
  "prepare",
  "flight",
  "commute",
  "ooo",
  "out of office",
  "focus time",
  "busy",
  "cancel(?:l?ed)?",
  "postponed",
  "thank[- ]?you (?:note|email|e-mail|message|card)s?",
  "coffee break",
]);

/** Office hours as a course writes it: "ECON OH", "OH - FNCE 100". Capitals
 *  only, so the surname Oh is not read as one. */
const OFFICE_HOURS_ABBR = /(?<!,\s?)\bOHs?\b/;


/**
 * Family and friends. A coffee with Dad is not networking, so these beat even
 * "coffee"; only a real contact beats them - "Call with Dana Reed, mom's
 * coworker" is networking.
 */
const FAMILY = words([
  "mom",
  "mum",
  "mommy",
  "dad",
  "daddy",
  "parents?",
  "family(?!\\s+office)",
  "grandma",
  "grandpa",
  "grandmother",
  "grandfather",
  "grandparents?",
  "brother",
  "sister",
  "siblings?",
  "aunt",
  "uncle",
  "cousins?",
  "girlfriend",
  "boyfriend",
  "gf",
  "bf",
  "roommates?",
  "friends",
]);

/**
 * Words that usually mean it is not a meeting, but describe one often enough -
 * "Lazard restructuring practice", "Coffee - hold for Dana" - that a
 * conversation word or a contact overrides them.
 */
const SOFT_NOT = words([
  "practice",
  "practise",
  "game",
  "travel",
  "due",
  "hold",
  "tentative",
  "block(?:ed)?",
  "appointment",
  "rescheduled",
  "moved",
]);

/**
 * A title that is a to-do rather than a meeting: "Email Dana Reed", "Schedule
 * coffee chat with Sam Ito", "Follow up with Dana Reed".
 */
const TASK_TITLE =
  /^\s*(?:e-?mail|send|text|message|msg|dm|linkedin|remind(?:er)?|to-?do|task|apply|submit|research(?!\s+(?:analyst|associate|coffee|call|chat|team|desk|division|group))|look up|find|write|draft|thank|follow[- ]?up with|reply|respond|schedule|re-?schedule|book|set ?up|confirm|reach out|ask|sign ?up|register|rsvp|plan|invite|prep(?:are)? for)\b/i;

/**
 * Words that make an entry a group of the student's own - a club, a team, a
 * project, an event. They beat the medium ("Team zoom") and the ordinary
 * conversation words ("Intro meeting - Investment Club"), but not a
 * one-to-one word ("Coffee with the Evercore team"), and never a contact
 * ("Call with Dana Reed - Evercore TMT group").
 */
const GROUP_WORDS = words([
  "team",
  "club",
  "society",
  "fraternity",
  "frat",
  "sorority",
  "chapter",
  "board",
  "committee",
  "exec",
  "e-?board",
  "general body",
  "gbm",
  "group",
  "project",
  "standup",
  "stand-up",
  "staff",
  "all[- ]hands",
  "town ?hall",
  "webinar",
  "info session",
  "information session",
  "workshop",
  "panel",
  "career fair",
  "fair",
  "conference",
  "training",
  "orientation",
  "hangout with",
  "party",
  "movie",
]);

/** Offerly event types that are a conversation by definition. */
const CHAT_TYPES = new Set(["coffee_chat", "meeting"]);

/**
 * Interview-shaped entries with nobody across the table: a recorded video
 * round, an online or written test. There is no one to thank, and a note to
 * the recruiter after a HireVue is optional enough that prompting for it
 * would teach the student to ignore the prompt.
 */
const NO_ONE_TO_THANK =
  /\b(?:hire[- ]?vue|one[- ]way video|(?:pre-?)?recorded (?:video )?interviews?|async(?:hronous)? (?:video )?interviews?|on[- ]demand (?:video )?interviews?|spark ?hire|sonru|pymetrics|codility|hacker ?rank|code ?signal|(?:online|numerical|written|verbal) (?:test|assessment|exam|reasoning)s?|modell?ing (?:test|exam|assessment)s?|deadline)\b/i;

/** Which interview thank-you the drafter opens on, read from the title. */
const SUPERDAY_WORDS = /\b(?:super[- ]?days?|assessment (?:cent(?:re|er)|day)s?)\b/i;
const SCREEN_WORDS =
  /\b(?:(?:phone|hr|recruiter|recruiting|initial) screen(?:ing)?s?|screening call|recruiter call)\b/i;

/** A title that says outright it is a one-to-one conversation. It overrules
 *  the interview reading of "Coffee chat re: interview process". */
function namesAConversation(title: string): boolean {
  return CONVERSATION_OVER_INTERVIEW.test(title) || CHAT_EMOJI.test(title);
}


/**
 * The contact a calendar title names, if it names one of theirs by full name.
 * Longest name wins, so "Dana Reed-Smith" is not read as "Dana Reed". A
 * possessive counts: Zoom titles a call "Dana Reed's Zoom Meeting".
 */
export function contactInTitle(title: string, contacts: ThankContact[]): ThankContact | null {
  const haystack = withoutPossessive(normaliseName(title));
  let best: { contact: ThankContact; length: number } | null = null;
  for (const c of contacts) {
    const name = normaliseName(c.name);
    // A single word is a first name, and first names collide.
    if (name.split(" ").length < 2) continue;
    // A hyphen may come before the name when it follows a meeting word
    // ("Coffee chat-Dana Reed") - never inside a name, so "Anne-Marie Lee" is
    // not "Marie Lee" - and never after it, so "Dana Reed-Smith" is not
    // "Dana Reed".
    const at = new RegExp(`(?:^|\\s|\\b(?:${MEETING_BEFORE_HYPHEN})-)${escapeRegExp(name)}(?=\\s|$)`);
    if (at.test(haystack) && (!best || name.length > best.length)) {
      best = { contact: c, length: name.length };
    }
  }
  return best?.contact ?? null;
}

/**
 * A name or title reduced to comparable words, the same way on both sides:
 * one Unicode form (a phone's "José" and a laptop's are different bytes),
 * straight apostrophes (phones type curly ones), no periods ("J.P." is "JP"),
 * other punctuation as spaces, and single spaces.
 */
function normaliseName(text: string): string {
  return stripAccents(text)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/\./g, "")
    .replace(/[^\p{L}\p{M}\p{N}' -]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "José Álvarez" as "Jose Alvarez": students type names without accents. */
function stripAccents(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").normalize("NFKC");
}

/** A possessive dropped: "Dana Reed's", "James Harris'". */
function withoutPossessive(normalised: string): string {
  return normalised.replace(/'s(?= |$)|(?<=s)'(?= |$)/g, "");
}

/** Words a title puts straight before a name with only a hyphen between. */
const MEETING_BEFORE_HYPHEN =
  "coffee|chat|call|meeting|mtg|zoom|lunch|dinner|drinks|intro|sync|catch ?up|1:1|convo|interview|screen|superday|round";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The title with a contact's name taken out, so the name cannot veto the
 * meeting: "Coffee with Dan Hold", "Call with Daniel Oh".
 */
function withoutName(title: string, contact: ThankContact | null): string {
  if (!contact) return title;
  const parts = contact.name
    .normalize("NFKC")
    .trim()
    .split(/[\s.]+/)
    .filter(Boolean)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (parts.length === 0) return title;
  return stripAccents(title).replace(new RegExp(parts.map((p) => stripAccents(p)).join("[\\s.'’-]+"), "giu"), " ");
}

/**
 * The title with a tracked firm's name taken out, so the firm cannot veto its
 * own call: "Intro call - Carlyle Group" is not a group meeting.
 */
function withoutFirm(title: string, firms: readonly TrackedFirm[]): string {
  const firm = firmInTitle(title, firms);
  if (!firm) return title;
  const core = normalizeFirmName(stripAccents(firm)).split(" ").filter(Boolean).map(escapeRegExp);
  if (core.length === 0) return title;
  const pattern = new RegExp(
    `(?:\\bthe\\s+)?\\b${core.join("[\\s\\W]+")}\\b(?:['’]s?)?(?:\\s*(?:group|partners|&\\s*co\\.?|and\\s+co(?:mpany)?|company|llc|inc\\.?|lp))*`,
    "giu",
  );
  return stripAccents(title).replace(pattern, " ");
}

/**
 * Whether this entry is a chat or call worth a thank-you.
 *
 * An Offerly entry filed as a coffee chat or a meeting/call is one. Anything
 * else is weighed in order, the strongest evidence first:
 *
 *   1. never: school, health, travel, a block of time, a to-do, family
 *      (unless a real contact was there);
 *   2. a one-to-one word ("coffee", "informational", "call with an analyst");
 *   3. ordinary vetoes and group words, unless a contact was there;
 *   4. an ordinary conversation word, or the medium it was on;
 *   5. someone to have had it with - a contact invited or named, or anyone
 *      invited to a call.
 *
 * Interviews are never this (their thank-you is its own occasion), nor are
 * all-day entries, declined invitations or repeating entries.
 */
export function isChatEvent(
  event: ChatEvent,
  contact: ThankContact | null,
  /** The contact was on the invitation, not just named in the title. */
  invited: boolean = false,
  /** The student's tracked firms: a firm's own name never vetoes its call. */
  firms: readonly TrackedFirm[] = [],
): boolean {
  if (event.allDay || event.declined) return false;
  if (event.eventType && event.eventType !== "default") return false;
  if (event.type && ["interview", "deadline", "info_session", "personal"].includes(event.type)) return false;
  // Interview wording rules it out - unless the student filed it as a meeting
  // themselves, re-filing a "superday" the detector tagged: then it is a
  // meeting, and thanked as one.
  const studentMeeting = event.typeSource === "student" && event.type === "meeting";
  if (!studentMeeting && !namesAConversation(event.title) && looksLikeInterview(event.title)) return false;
  // Filed as a chat or a meeting by the student: one. Filed so by the app's
  // guess (an imported calendar): read by its words like any other entry, so
  // "Investment Club weekly meeting" is not a thank-you.
  if (event.type && CHAT_TYPES.has(event.type) && event.typeSource !== "detected") return true;
  // A repeating entry is a class, a club or a standing 1:1 - not a
  // conversation to thank someone for every week.
  if (event.recurring) return false;

  const title = event.title;
  // The vetoes read the title without the person's name in it.
  const rest = withoutFirm(withoutName(title, contact), firms);
  const known = !!contact;

  // 1. Never. The to-do check reads the title without the name, so a person
  // called Ping or a firm called Research is not a to-do.
  if (TASK_TITLE.test(rest.replace(/^[\s\-–—:|,.]+/, "")) || NEVER_A_CHAT.test(rest)) return false;
  if (OFFICE_HOURS_ABBR.test(rest) || COURSE_CODE.test(rest)) return false;
  if (FAMILY.test(rest) && !known) return false;

  // 2. One-to-one, outright.
  if (STRONG_CHAT.test(title) || CHAT_EMOJI.test(title)) return true;

  // 3. Vetoes a contact overrules.
  if (!known && (SOFT_NOT.test(rest) || GROUP_WORDS.test(rest))) return false;

  // 4. Conversation words and media.
  if (CHAT_WORDS.test(title) || CALL_WORDS.test(title)) return true;

  // 5. Someone to have had it with.
  const others = event.attendeeEmails?.length ?? 0;
  // A booking tool's title says nothing, but someone else on a call is a call.
  // A few people, not a crowd: "Goldman Sachs x Penn" with forty invited is an event.
  if ((BOOKING_TITLE.test(title) || BOOKING_JOINER.test(title)) && (event.videoCall || others > 0) && others <= 3) {
    return true;
  }
  if (contact) {
    // A contact on the invitation was in the meeting, whatever it is called.
    if (invited) return true;
    // A booking tool titles a call with the two names and nothing else ("Dana
    // Reed and Alex Rivera"); a contact's name plus anyone else invited, or a
    // video link, is a meeting with them.
    return MAYBE_CHAT_WORDS.test(title) || NAME_JOINER.test(title) || !!event.videoCall || others > 0;
  }
  // Nobody we know, but a call word and a few people on it - a video call or
  // a phone call, the banker's medium. Not a meal (a dinner invitation is as
  // likely a date) and not a crowd (five invited is a group meeting).
  if (STRANGER_CALL_WORDS.test(title) && others > 0 && others <= 3) return true;
  // A booking tool's one-to-one call titled with the two names and nothing
  // else - "Alex Rivera and Dana Reed" - with the one other person on it.
  return !!event.videoCall && others === 1 && NAME_JOINER.test(title);
}

/** The conversation words that make a call with someone not yet saved. */
const STRANGER_CALL_WORDS = words([
  "calls?",
  "chats?",
  "catch[- ]?up",
  "meetings?",
  "mtg",
  "1:1",
  "1-1",
  "one[- ]on[- ]one",
  "sync",
  "intro",
  "convo",
  "conversation",
  "touch ?base",
  "check[- ]?in",
  "discussion",
]);

/**
 * The contact on the invitation, if one of theirs was invited. The first in
 * the invitation's order, so the prompt names the person the invite was with.
 */
export function contactInInvite(
  attendeeEmails: readonly string[] | undefined,
  contacts: ThankContact[],
): ThankContact | null {
  if (!attendeeEmails?.length) return null;
  const byEmail = new Map<string, ThankContact>();
  for (const c of contacts) {
    const email = c.email?.trim().toLowerCase();
    if (email && !byEmail.has(email)) byEmail.set(email, c);
  }
  for (const email of attendeeEmails) {
    const hit = byEmail.get(email.trim().toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/**
 * Whether this entry is an interview with someone to thank afterwards.
 *
 * The same test the interview prompts use - filed as an interview, or named
 * one - so the entry that was counted down to is the entry that is thanked
 * for. Recorded rounds and tests are left out: nobody was in the room.
 */
export function isInterviewEvent(event: ChatEvent): boolean {
  if (event.declined) return false;
  if (event.eventType && event.eventType !== "default") return false;
  if (NO_ONE_TO_THANK.test(event.title)) return false;
  if (event.type === "interview") return true;
  // Filed as something else on purpose - a deadline, an info session, a chat.
  // "meeting" is the catch-all a synced entry lands in, so it is still read -
  // unless the student put it there themselves.
  if (event.type && event.type !== "meeting") return false;
  if (event.typeSource === "student") return false;
  // A title that says it is a coffee chat is one, whatever it mentions:
  // "Coffee chat re: interview process".
  if (namesAConversation(event.title)) return false;
  // Notes only for entries Offerly did not file: a meeting the student filed
  // themselves has notes like "ask about the interview process".
  return looksLikeInterview(event.title, event.type ? null : event.notes);
}

/** The drafter box an interview's thank-you opens on. */
export function interviewThankBox(title: string): string {
  if (SUPERDAY_WORDS.test(title)) return "thanks.superday";
  if (SCREEN_WORDS.test(title)) return "thanks.screen";
  return "thanks.interview";
}

/**
 * When the prompt becomes due: a couple of hours after it ends. An all-day
 * interview entry has no end worth the name, so it is due that evening on the
 * student's clock. (An all-day chat never gets this far - it is not a chat.)
 */
export function thankYouDueAt(
  event: Pick<ChatEvent, "startsAt" | "endsAt" | "allDay">,
  occasion: ThankOccasion = "chat",
  timeZone: string = DEFAULT_TIME_ZONE,
): Date {
  // A bad date is never due - selectThankYous skips an invalid due time.
  if (Number.isNaN(event.startsAt.getTime())) return new Date(NaN);
  const zone = parseTimeZone(timeZone);
  if (event.allDay) {
    // A date-only entry arrives as midnight UTC on its date; the digits are
    // the date, not an instant. A superday blocked over two days is due on
    // its last day: Google's all-day end is the day AFTER the last one.
    const start = event.startsAt;
    const end = event.endsAt && !Number.isNaN(event.endsAt.getTime()) ? event.endsAt : null;
    const last = end && end.getTime() - start.getTime() > DAY ? new Date(end.getTime() - DAY) : start;
    return zonedTime(
      last.getUTCFullYear(),
      last.getUTCMonth() + 1,
      last.getUTCDate(),
      ALL_DAY_INTERVIEW_DUE_HOUR,
      0,
      zone,
    );
  }
  const minutes = occasion === "interview" ? DEFAULT_INTERVIEW_MINUTES : DEFAULT_CHAT_MINUTES;
  // An end before the start is bad data, read as no end - otherwise the
  // prompt would fire before the chat has happened.
  const ends =
    event.endsAt && event.endsAt.getTime() >= event.startsAt.getTime()
      ? event.endsAt
      : new Date(event.startsAt.getTime() + minutes * 60_000);
  return new Date(ends.getTime() + THANK_YOU_AFTER_HOURS * HOUR);
}

/** Where "write it" goes: the drafter, on "Say thank you" with the right box
 *  ticked, and addressed to them when we know who it was. */
export function thankYouHref(
  contact: { id: string; name?: string } | null,
  box: string = "thanks.chat",
  /** The prompt's key, for "Outside of your matched contacts": the page looks
   *  up who it was from it, so no name or address ever travels in a URL. */
  key?: string,
): string {
  const base = `occasion=thanks&box=${box}`;
  if (contact) return `/outreach?contact=${contact.id}&${base}`;
  return key ? `/outreach?${base}&thank=${encodeURIComponent(key)}` : `/outreach?${base}`;
}

/** What the bell and the to-do list call the job. */
export function thankYouTitle(
  t: Pick<ThankYouPrompt, "occasion" | "contact"> & Partial<Pick<ThankYouPrompt, "interviewers" | "next">>,
): string {
  const panel = t.occasion === "interview" && (t.interviewers?.length ?? 0) > 1;
  // One person, by name - a saved contact, or the one name the invitation gave.
  const name = t.contact?.name ?? t.next?.name;
  if (name && !panel) return `Thank ${name}`;
  return t.occasion === "interview" ? "Thank your interviewers" : "Send a thank-you";
}

/**
 * The drafter templates that are an interview thank-you. A recorded-round note
 * is not one: it goes to the recruiter about a round nobody sat across from.
 */
export const INTERVIEW_THANK_TEMPLATES: ReadonlySet<string> = new Set([
  "thank_you_interview",
  "thank_you_superday",
  "thank_you_phone_screen",
]);

/**
 * The interviews a sent interview thank-you answers: for each send, the most
 * recent interview that had begun by then - and every other interview that
 * began the same day on the student's clock.
 *
 * Interviewers are rarely saved contacts before the interview, so matching by
 * person misses most of them; matching by time gets the ordinary case right -
 * the thank-you written that evening is for that day's interviews. A superday
 * booked as four back-to-back entries is one day of notes, so the notes close
 * all four; they never reach back to an earlier day's round.
 */
export function interviewsAnswered(
  interviews: { key: string; startsAt: Date }[],
  sends: { at: Date }[],
  timeZone: string = DEFAULT_TIME_ZONE,
): Set<string> {
  const zone = parseTimeZone(timeZone);
  const valid = interviews.filter((i) => !Number.isNaN(i.startsAt.getTime()));
  const byStart = [...valid].sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime());
  const out = new Set<string>();
  for (const send of sends) {
    const latest = byStart.find((i) => i.startsAt.getTime() <= send.at.getTime());
    if (!latest) continue;
    const day = localDateString(latest.startsAt, zone);
    for (const i of byStart) {
      if (i.startsAt.getTime() <= send.at.getTime() && localDateString(i.startsAt, zone) === day) {
        out.add(i.key);
      }
    }
  }
  return out;
}

/**
 * The banner's key for one thank-you on one day of the student's calendar.
 *
 * One per day, not one per entry: the banner drops again every morning the
 * thank-you is still owed, until it is sent or ticked off. The bell keeps one
 * job for it (thankYouKey) - each day's banner bumps that job, never adds one.
 */
export function thankYouFlashKey(key: string, now: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  return `${key}:${localDateString(now, parseTimeZone(timeZone))}`;
}

/** Whole calendar days since it fell due, on the student's clock: 0 the day
 *  it falls due, 1 the day after. */
export function daysOwed(dueAt: Date, now: Date, timeZone: string = DEFAULT_TIME_ZONE): number {
  const zone = parseTimeZone(timeZone);
  const a = localParts(dueAt, zone);
  const b = localParts(now, zone);
  return Math.max(0, Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY));
}

/** The job under the bell, and the record of "done", for one entry. */
export function thankYouKey(sourceKey: string): string {
  return `thank_you:${sourceKey}`;
}

/** What a sent thank-you to this person closes. */
export function thankYouSubjectKey(contactId: string): string {
  return `thanks:${contactId}`;
}

/**
 * The thank-yous owed right now, oldest first.
 *
 * Owed means: a chat, call or interview, over for a couple of hours, inside
 * the lookback, not ticked off, and not already answered - by a thank-you sent
 * to that person since it began or, for an interview, by an interview
 * thank-you sent since (see interviewsAnswered).
 */
/**
 * The tracked firm a calendar title names, if it names one - longest name
 * first, so "Evercore ISI" is not read as "Evercore".
 */
/** A tracked firm: its name, or its name and the other names students use. */
export type TrackedFirm = string | { name: string; aliases?: readonly string[] };

export function firmInTitle(title: string, firms: readonly TrackedFirm[]): string | null {
  // Matched the way interview prep matches them: every run of words in the
  // title, normalised, against the normalised firm names - so "Moelis" finds
  // "Moelis & Company", "JPM" finds "J.P. Morgan", "Jefferies'" finds
  // "Jefferies". Longest run first, so "Evercore ISI" beats "Evercore".
  const byKey = new Map<string, string>();
  for (const f of firms) {
    const name = typeof f === "string" ? f : f.name;
    const labels = typeof f === "string" ? [f] : [f.name, ...(f.aliases ?? [])];
    for (const label of labels) {
      const key = normalizeFirmName(stripAccents(label));
      // One letter is not a name, and would match every "a" in a title.
      if (key.length >= 2 && !byKey.has(key)) byKey.set(key, name);
    }
  }
  if (byKey.size === 0) return null;
  // Brackets opened up first: in a firm's own name "(US)" is a note to drop,
  // but in a calendar title "Coffee chat (Lazard)" the bracket IS the firm.
  const words = normalizeFirmName(stripAccents(title).replace(/[()[\]]/g, " ")).split(" ").filter(Boolean);
  for (let size = Math.min(6, words.length); size >= 1; size--) {
    let best: string | null = null;
    for (let start = 0; start + size <= words.length; start++) {
      // A short name (MS, CS, DB) only as the firm writes it - in capitals.
      // In lower case it is a word: "Coffee with Ms. Chen", "CS 161".
      if (size === 1 && words[start].length <= 3 && !new RegExp(`\\b${words[start].toUpperCase()}\\b(?!\\s*\\d)`).test(title)) continue;
      const hit = byKey.get(normalizeFirmName(words.slice(start, start + size).join(" ")));
      // Two firms of the same word count: the longer name is the more
      // specific one, so the answer does not depend on which came first.
      if (hit && (!best || hit.length > best.length)) best = hit;
    }
    if (best) return best;
  }
  return null;
}

/** Interviews: "2 of 3 thanked", "1 note sent", or null before the first note. */
export function thankYouProgress(
  t: Pick<ThankYouPrompt, "occasion" | "interviewers" | "notesSent">,
): string | null {
  if (t.occasion !== "interview" || t.notesSent === 0) return null;
  const total = t.interviewers.length;
  if (total > 0) {
    const done = Math.min(total, Math.max(t.interviewers.filter((i) => i.thanked).length, t.notesSent));
    return `${done} of ${total} thanked`;
  }
  return `${t.notesSent} note${t.notesSent === 1 ? "" : "s"} sent`;
}

type Sent = {
  contactId: string;
  at: Date;
  /** An interview thank-you template. */
  interview?: boolean;
  /** The address it went to, when the contact has one. */
  email?: string | null;
};

/**
 * The thank-yous owed right now, oldest first.
 *
 * A chat is owed until a thank-you goes to that person after it began.
 *
 * An interview is owed until every interviewer has had one. The invitation
 * says who they were, and a note to that address (or that saved contact)
 * ticks them off; a note that matches nobody is credited to the interview by
 * time (see interviewsAnswered) and counts towards the total. With nobody on
 * the invitation, notes never close it - only the student knows how many
 * people were in the room - so after the first one it asks "anyone else?"
 * until they say that's everyone.
 */
export function selectThankYous({
  events,
  contacts,
  done,
  thanked,
  firms = [],
  now = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
}: {
  events: ChatEvent[];
  contacts: ThankContact[];
  /** Keys the student closed - ticked off, or "That's everyone". */
  done: ReadonlySet<string>;
  /** Thank-you emails the student has sent, to whom, and whether each was an
   *  interview thank-you. */
  thanked: Sent[];
  /** The student's tracked firms, to fill in who an outside note is to. */
  firms?: readonly TrackedFirm[];
  now?: Date;
  /** The student's own clock, for all-day interview entries. */
  timeZone?: string;
}): ThankYouPrompt[] {
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const byEmail = new Map<string, ThankContact>();
  for (const c of contacts) {
    const email = c.email?.trim().toLowerCase();
    if (email && !byEmail.has(email)) byEmail.set(email, c);
  }
  const zone = parseTimeZone(timeZone);
  // An all-day entry's start is a date, not an instant: it began at midnight
  // on the student's clock, not at midnight UTC.
  const begins = (e: ChatEvent): Date =>
    e.allDay && !Number.isNaN(e.startsAt.getTime())
      ? zonedTime(e.startsAt.getUTCFullYear(), e.startsAt.getUTCMonth() + 1, e.startsAt.getUTCDate(), 0, 0, zone)
      : e.startsAt;
  const sendEmail = (t: Sent) => (t.email ?? byId.get(t.contactId)?.email ?? null)?.trim().toLowerCase() ?? null;

  const seen = new Set<string>();
  // One conversation, two entries: the student logged the chat in Offerly
  // (synced to Google under its own id) and also accepted the other person's
  // invitation. The Offerly entry speaks for both; the invitation is dropped
  // when it is with the same person, or is the same kind of thing, within half
  // an hour of it.
  const offerly: {
    sourceKey: string;
    contactId: string | null;
    email: string | null;
    interview: boolean;
    at: number;
    firm: string | null;
  }[] = [];
  for (const event of events) {
    if (!event.sourceKey.startsWith("offerly:")) continue;
    const c =
      (event.contactId ? byId.get(event.contactId) : undefined) ??
      contactInInvite(event.attendeeEmails, contacts) ??
      contactInTitle(event.title, contacts);
    // Only an entry that is itself a chat or an interview speaks for the
    // invitation: a "personal" block linked to Dana must not swallow the chat.
    const isInterview = isInterviewEvent(event);
    if (!isInterview && !isChatEvent(event, c ?? null, false, firms)) continue;
    offerly.push({
      sourceKey: event.sourceKey,
      contactId: c?.id ?? null,
      email: c?.email?.trim().toLowerCase() || null,
      interview: isInterviewEvent(event),
      at: event.startsAt.getTime(),
      firm: firmInTitle(event.title, firms),
    });
  }
  const SAME_SLOT_MS = 30 * 60_000;
  const sameSlot = (event: ChatEvent, occasion: ThankOccasion, contact: ThankContact | null) => {
    const firm = firmInTitle(event.title, firms);
    const t = event.startsAt.getTime();
    // The nearest one, not the first that fits: a superday booked as rounds
    // half an hour apart pairs each invitation with its own round.
    return offerly
      .filter(
      (o) =>
        Math.abs(o.at - event.startsAt.getTime()) <= SAME_SLOT_MS &&
        (occasion === "interview"
          ? o.interview && (!o.firm || !firm || o.firm === firm)
          : !o.interview &&
            // The same person - by record, or by address when the student has
            // two records for them - or an Offerly chat that names nobody,
            // which the invitation then says who it was with.
            (o.contactId === null ||
              (!!contact &&
                (o.contactId === contact.id ||
                  (!!o.email && o.email === contact.email?.trim().toLowerCase()))))),
      )
      .sort((a, b) => Math.abs(a.at - t) - Math.abs(b.at - t))[0];
  };
  // The invitation's people, carried onto the Offerly entry it duplicates.
  const invitedTo = new Map<string, { email: string; name: string | null }[]>();
  for (const event of events) {
    if (!event.sourceKey.startsWith("google:") || !isInterviewEvent(event)) continue;
    const o = sameSlot(event, "interview", null);
    if (!o) continue;
    const people = event.attendees ?? (event.attendeeEmails ?? []).map((email) => ({ email, name: null }));
    invitedTo.set(o.sourceKey, [...(invitedTo.get(o.sourceKey) ?? []), ...people]);
  }

  // ...and the invitation's person carried onto an Offerly chat that named
  // nobody, so the one prompt says who it was with and closes when they are
  // thanked.
  const adopted = new Map<string, ThankContact>();
  for (const event of events) {
    if (!event.sourceKey.startsWith("google:") || isInterviewEvent(event)) continue;
    const who = contactInInvite(event.attendeeEmails, contacts) ?? contactInTitle(event.title, contacts);
    if (!who) continue;
    const o = offerly.find(
      (x) => !x.interview && x.contactId === null && Math.abs(x.at - event.startsAt.getTime()) <= SAME_SLOT_MS,
    );
    if (o && !adopted.has(o.sourceKey)) adopted.set(o.sourceKey, who);
  }

  type Pending = {
    event: ChatEvent;
    key: string;
    occasion: ThankOccasion;
    contact: ThankContact | null;
    people: Interviewer[];
    dueAt: Date;
    owedNow: boolean;
  };
  const pending: Pending[] = [];

  for (const event of events) {
    const key = thankYouKey(event.sourceKey);
    if (seen.has(key)) continue;
    seen.add(key);

    // Who it was with: the contact they linked, else the one on the
    // invitation (an email address is exact), else the one the title names.
    const invitee = contactInInvite(event.attendeeEmails, contacts);
    const contact =
      (event.contactId ? byId.get(event.contactId) : undefined) ??
      invitee ??
      contactInTitle(event.title, contacts) ??
      adopted.get(event.sourceKey) ??
      null;
    // Interview first: an entry that is both ("Interview with Dana Reed") is
    // an interview, and wants the interview thank-you.
    const occasion: ThankOccasion | null = isInterviewEvent(event)
      ? "interview"
      : isChatEvent(event, contact, !!invitee && invitee.id === contact?.id, firms)
        ? "chat"
        : null;
    if (!occasion) continue;
    if (event.sourceKey.startsWith("google:") && sameSlot(event, occasion, contact)) continue;

    // The people across the table: the invitation's list, else the one
    // contact the entry is about.
    const listed = [
      ...(event.attendees ?? (event.attendeeEmails ?? []).map((email) => ({ email, name: null }))),
      ...(invitedTo.get(event.sourceKey) ?? []),
    ]
      .map((a) => ({ email: a.email.trim().toLowerCase(), name: a.name }))
      .filter((a, i, all) => a.email && all.findIndex((b) => b.email === a.email) === i);
    const people: Interviewer[] = [];
    if (occasion === "interview") {
      for (const a of listed) {
        const c = byEmail.get(a.email);
        people.push({ email: a.email, name: c?.name ?? a.name, contactId: c?.id ?? null, thanked: false });
      }
      // The contact the entry names or links is one of them, listed or not:
      // "Interview with Dana Reed" sent from a recruiting coordinator's
      // calendar lists the coordinator, not Dana.
      const contactEmail = contact?.email?.trim().toLowerCase() || null;
      if (contact && !people.some((x) => x.contactId === contact.id || (!!contactEmail && x.email === contactEmail))) {
        people.unshift({
          email: contact.email?.trim().toLowerCase() || null,
          name: contact.name,
          contactId: contact.id,
          thanked: false,
        });
      }
    }

    const dueAt = thankYouDueAt(event, occasion, timeZone);
    // Written so a NaN anywhere fails it: a bad date is never owed.
    const late = now.getTime() - dueAt.getTime();
    const owedNow = !done.has(key) && late >= 0 && late <= THANK_YOU_LOOKBACK_DAYS * DAY;
    pending.push({ event, key, occasion, contact, people, dueAt, owedNow });
  }

  // Interview notes, matched to the people they went to where possible. A
  // note counts once per PERSON - two notes to Dana on a two-person panel are
  // not Pat thanked - and only for the latest interview that person was on
  // (with any others that day, a superday booked as separate rounds): a note
  // to Pat tonight is for today's round, not last week's.
  const interviews = pending.filter((p) => p.occasion === "interview");
  const notes = new Map<string, Set<string>>(interviews.map((p) => [p.key, new Set()]));
  const matchedByPerson = new Set<number>();
  const zoneForDays = parseTimeZone(timeZone);
  thanked.forEach((t, i) => {
    const email = sendEmail(t);
    const matches = (person: Interviewer) =>
      (!!person.contactId && person.contactId === t.contactId) || (!!person.email && !!email && person.email === email);
    const theirs = interviews.filter(
      (p) => t.at.getTime() >= begins(p.event).getTime() && p.people.some(matches),
    );
    if (theirs.length === 0) return;
    const latest = theirs.reduce((a, b) => (begins(b.event).getTime() > begins(a.event).getTime() ? b : a));
    const day = localDateString(begins(latest.event), zoneForDays);
    for (const p of theirs) {
      if (localDateString(begins(p.event), zoneForDays) !== day) continue;
      p.people.forEach((person, n) => {
        if (!matches(person)) return;
        person.thanked = true;
        notes.get(p.key)!.add(`person:${n}`);
      });
    }
    matchedByPerson.add(i);
  });
  // ...and the rest credited by time: every interview in the window - owed,
  // ticked, or not yet due - so a note written tonight is never credited to
  // last week's round.
  const window = interviews.map((p) => ({ key: p.key, startsAt: begins(p.event) }));
  // The same-day spread is for rounds with nobody listed - a superday typed
  // in as four entries. Rounds whose invitations say who was there get a
  // stray note only on the latest of them: one note to an address the
  // invitations did not show must not close four rounds.
  const listedKeys = new Set(interviews.filter((p) => p.people.length > 0).map((p) => p.key));
  thanked.forEach((t, i) => {
    if (!t.interview || matchedByPerson.has(i)) return;
    const credited = interviewsAnswered(window, [t], timeZone);
    const latest = window
      .filter((w) => w.startsAt.getTime() <= t.at.getTime())
      .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())[0];
    for (const key of credited) {
      if (listedKeys.has(key) && key !== latest?.key) continue;
      notes.get(key)!.add(`send:${i}`);
    }
  });

  // A chat with nobody we know - an Offerly entry that names no one, a Google
  // entry with no invitation - is answered by time, as interview notes are: a
  // chat thank-you that went to nobody the other entries are about (someone
  // saved from "Outside of your matched contacts", or a contact since deleted)
  // answers the latest such chat that had begun by then.
  const unknownChats = pending
    .filter((p) => p.occasion === "chat" && !p.contact)
    .map((p) => ({ key: p.key, startsAt: begins(p.event) }))
    .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime());
  const knownIds = new Set(pending.flatMap((p) => (p.contact ? [p.contact.id] : [])));
  const knownEmails = new Set(
    pending.flatMap((p) => [
      ...(p.contact?.email ? [p.contact.email.trim().toLowerCase()] : []),
      ...p.people.flatMap((x) => (x.email ? [x.email] : [])),
    ]),
  );
  const unknownChatsAnswered = new Set<string>();
  thanked.forEach((t, i) => {
    if (t.interview || matchedByPerson.has(i)) return;
    const email = sendEmail(t);
    if (knownIds.has(t.contactId) || (email && knownEmails.has(email))) return;
    const latest = unknownChats.find((c) => c.startsAt.getTime() <= t.at.getTime());
    if (latest) unknownChatsAnswered.add(latest.key);
  });

  const out: ThankYouPrompt[] = [];
  for (const p of pending) {
    if (!p.owedNow) continue;
    const box = p.occasion === "interview" ? interviewThankBox(p.event.title) : "thanks.chat";
    const firm = firmInTitle(p.event.title, firms);
    let next: ThankRecipient;
    let notesSent = 0;

    if (p.occasion === "chat") {
      if (p.contact) {
        // Answered by a thank-you to them - by record, or by address when the
        // student has two records for the same person.
        const email = p.contact.email?.trim().toLowerCase() || null;
        const to = p.contact.id;
        if (
          thanked.some(
            (t) =>
              t.at.getTime() >= p.event.startsAt.getTime() &&
              (t.contactId === to || (!!email && sendEmail(t) === email)),
          )
        ) {
          continue;
        }
      } else if (unknownChatsAnswered.has(p.key)) {
        continue;
      }
      // A chat with one other person on the invitation is with them.
      const only = p.contact ? null : p.event.attendees?.length === 1 ? p.event.attendees[0] : null;
      next = p.contact
        ? { contactId: p.contact.id, name: p.contact.name, email: p.contact.email ?? null, firm: null }
        : { contactId: null, name: only?.name ?? null, email: only?.email ?? null, firm };
    } else {
      notesSent = notes.get(p.key)!.size;
      const total = p.people.length;
      // Everyone on the list has had a note - by name, or by count when the
      // notes went to addresses the invitation did not show.
      if (total > 0 && (p.people.every((x) => x.thanked) || notesSent >= total)) continue;
      const who = p.people.find((x) => !x.thanked) ?? null;
      next = who
        ? { contactId: who.contactId, name: who.name, email: who.email, firm: who.contactId ? null : firm }
        : { contactId: null, name: null, email: null, firm };
    }

    out.push({
      key: p.key,
      occasion: p.occasion,
      title: p.event.title,
      startsAt: p.event.startsAt,
      dueAt: p.dueAt,
      contact: p.contact,
      href: thankYouHref(next.contactId ? { id: next.contactId, name: next.name ?? "" } : null, box, p.key),
      next,
      interviewers: p.people,
      notesSent,
    });
  }

  return out.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}
