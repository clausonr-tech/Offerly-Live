// The draft form's picker: what the student wants to do, then boxes for the
// situation. Pure data and functions - no UI, no database - so the form, the
// server action and the tests all use the same rules.
//
// Every box maps to one of the email types in draft-templates.ts, which keep
// their own formats and examples. When several boxes are checked, the strongest
// one leads (its type's examples and structure write the email) and the rest
// are "also true": their questions are asked and their facts and rules are
// worked in. A question two boxes share is asked once.

import { emailTypeById, type DraftField, type EmailType, type EmailTypeId } from "./draft-templates";

export type Box = {
  id: string;
  label: string;
  hint?: string;
  typeId: EmailTypeId;
  /** Select answers the box already implies. Those questions are hidden. "{recipient}" means the contact's name. */
  presets?: Record<string, string>;
  /** Boxes that can't be checked alongside this one. Applied in both directions. */
  excludes?: string[];
  /**
   * This box's wording for a question it shares with another box, where the
   * question's own wording would point at the wrong person or moment. Keyed by
   * the question's name.
   */
  questionText?: Record<string, Partial<Pick<DraftField, "label" | "hint" | "placeholder" | "prompt">>>;
};

export type BoxSection = { title: string; mode: "one" | "any"; boxes: Box[] };

export type Occasion = { id: string; label: string; description: string; sections: BoxSection[] };

/** A question on the form: a type's own field, or one of the shared brief questions. */
export type Question = DraftField & { section: string };

// ------------------------------------------------------------------ occasions

const INTERVIEW_THANKS = ["thanks.interview", "thanks.superday", "thanks.screen", "thanks.recorded"];

export const OCCASIONS: Occasion[] = [
  {
    id: "first_contact",
    label: "Reach out for the first time",
    description: "A first email to someone who doesn't know you yet.",
    sections: [
      {
        title: "Who is it going to?",
        mode: "any",
        boxes: [
          {
            id: "first.alum",
            label: "An alum of my school",
            hint: "They went to your school",
            typeId: "cold_email",
            excludes: ["first.not_alum", "first.inbox"],
          },
          {
            id: "first.not_alum",
            label: "Not an alum",
            hint: "No shared school, e.g. you found them on LinkedIn",
            typeId: "cold_not_alum",
            excludes: ["first.inbox"],
          },
          {
            id: "first.recruiter",
            label: "A campus recruiter",
            hint: "Someone in recruiting or HR, not a banker",
            typeId: "recruiter_outreach",
            excludes: ["first.inbox"],
          },
          {
            id: "first.inbox",
            label: "A recruiting inbox",
            hint: "A team email address, not a person",
            typeId: "recruiting_inbox",
            excludes: ["first.referred", "first.met", "first.conference", "first.pointed"],
          },
        ],
      },
      {
        title: "How are you connected?",
        mode: "any",
        boxes: [
          // "Referred" and "pointed" were easy to mix up. The difference is
          // who started it: someone you know offered the name, or someone you
          // reached out to sent you on to this person instead.
          {
            id: "first.referred",
            label: "Someone I know suggested them",
            hint: "A friend, club member or professor told you to reach out and use their name",
            typeId: "cold_referral",
            // Two people who each connected the student is one too many for the form to ask about clearly.
            excludes: ["first.pointed"],
          },
          {
            id: "first.met",
            label: "We met in person",
            hint: "At a club event, panel, career fair or on campus",
            typeId: "cold_after_meeting",
            excludes: ["first.conference"],
          },
          {
            id: "first.conference",
            label: "We met at a conference",
            hint: "An industry or diversity conference, often in another city",
            typeId: "conference_follow_up",
          },
          {
            id: "first.pointed",
            label: "Someone I emailed sent me to them",
            hint: "You contacted someone else, and they said this person is a better fit",
            typeId: "redirect_sequence",
            presets: { redirectStep: "new_person", newPerson: "{recipient}" },
            questionText: {
              redirectDetail: {
                label: "Why they sent you to this person",
                prompt: "Why the person the student emailed first sent them to this recipient",
              },
            },
          },
        ],
      },
    ],
  },
  {
    id: "follow_up",
    label: "Follow up",
    description: "They haven't replied, or you're checking in.",
    sections: [
      {
        title: "What's the situation?",
        mode: "one",
        boxes: [
          {
            id: "follow.first",
            label: "No reply yet: first follow-up",
            hint: "A banker or alum hasn't answered your first email",
            typeId: "follow_up_1",
          },
          {
            id: "follow.final",
            label: "Still no reply: final follow-up",
            hint: "You've already followed up once. This is the last one",
            typeId: "follow_up_2",
          },
          {
            id: "follow.recruiter",
            label: "A recruiter hasn't replied",
            hint: "A person in recruiting, not a banker",
            typeId: "recruiter_follow_up",
          },
          {
            id: "follow.inbox",
            label: "A recruiting inbox hasn't replied",
            hint: "A team email address",
            typeId: "recruiting_inbox_follow_up",
          },
          {
            id: "follow.quiet",
            label: "They replied, then went quiet",
            hint: "The conversation started, then stopped",
            typeId: "stalled_thread_nudge",
          },
          {
            id: "follow.later",
            label: "Reaching back out when they asked",
            hint: "Earlier they said \"not now, try me later\", and it's later",
            typeId: "not_now_reply",
            presets: { notNowStage: "later" },
          },
          {
            id: "follow.interview",
            label: "No news after an interview",
            hint: "You sent a thank-you and haven't heard back",
            typeId: "interview_check_in",
          },
        ],
      },
    ],
  },
  {
    id: "reply",
    label: "Reply to them",
    description: "They wrote back and you're answering.",
    sections: [
      {
        title: "What did they say?",
        mode: "one",
        boxes: [
          { id: "reply.call", label: "They agreed to a call", hint: "Set up the time", typeId: "call_scheduling" },
          {
            id: "reply.coffee",
            label: "They suggested meeting in person",
            hint: "Coffee or a visit instead of a call",
            typeId: "coffee_in_person_reply",
          },
          {
            id: "reply.not_now",
            label: "They said \"not now\"",
            hint: "Answer it now. Reaching back out later is under Follow up",
            typeId: "not_now_reply",
            presets: { notNowStage: "reply" },
          },
          {
            id: "reply.pointed",
            label: "They sent me to someone else",
            hint: "Thank them and ask how they'd like to connect you",
            typeId: "redirect_sequence",
            presets: { redirectStep: "thank", firstPerson: "{recipient}" },
            questionText: {
              redirectDetail: { label: "Why they sent you to that person", prompt: "Why the recipient pointed the student to someone else" },
            },
          },
          {
            id: "reply.scheduling",
            label: "A recruiter wants to schedule an interview",
            hint: "Confirm a time slot",
            typeId: "recruiter_scheduling_reply",
          },
          {
            id: "reply.move",
            label: "Move or cancel a call",
            hint: "Or apologize for missing one",
            typeId: "reschedule_call",
          },
        ],
      },
    ],
  },
  {
    id: "thanks",
    label: "Say thank you",
    description: "After a conversation, an event or an interview.",
    sections: [
      {
        title: "What are you thanking them for?",
        mode: "any",
        boxes: [
          {
            id: "thanks.chat",
            label: "A coffee chat or call",
            hint: "A networking conversation, not an interview",
            typeId: "thank_you_chat",
            excludes: ["thanks.event", "thanks.session", ...INTERVIEW_THANKS],
          },
          {
            id: "thanks.helped",
            label: "They offered to help",
            hint: "To pass on your resume, flag you or introduce you. Check it with the chat, talk or session too",
            typeId: "thank_you_offered_help",
            excludes: INTERVIEW_THANKS,
          },
          {
            id: "thanks.event",
            label: "A talk a banker gave",
            hint: "A panel, club event or info session where they spoke",
            typeId: "thank_you_event",
            excludes: ["thanks.session", ...INTERVIEW_THANKS],
            // With "They offered to help", the one detail comes from the talk, not a conversation.
            questionText: {
              conversationDetail: {
                label: "A point from their talk that stuck with you",
                hint: "",
                placeholder: "e.g. analysts who succeed ask a question twice rather than guess once",
                prompt: "The specific point from the recipient's talk that stuck with the student",
              },
            },
          },
          {
            id: "thanks.session",
            label: "A session a recruiter ran",
            hint: "An info session or workshop led by recruiting",
            typeId: "thank_you_recruiter_session",
            excludes: INTERVIEW_THANKS,
            questionText: {
              conversationDetail: {
                label: "Something they explained about recruiting",
                hint: "",
                placeholder: "e.g. how an application actually moves once it's submitted",
                prompt: "A specific thing the recruiter explained at the session they ran",
              },
            },
          },
          {
            id: "thanks.interview",
            label: "A live interview",
            hint: "A first or second round with a banker, in person or on video",
            typeId: "thank_you_interview",
            excludes: ["thanks.superday", "thanks.screen", "thanks.recorded"],
          },
          {
            id: "thanks.superday",
            label: "A superday",
            hint: "The final round: several interviews in one day. One note per interviewer",
            typeId: "thank_you_superday",
            excludes: ["thanks.screen", "thanks.recorded"],
          },
          {
            id: "thanks.screen",
            label: "A recruiter phone screen",
            hint: "A short first call with recruiting",
            typeId: "thank_you_phone_screen",
            excludes: ["thanks.recorded"],
          },
          {
            id: "thanks.recorded",
            label: "A recorded video round",
            hint: "Like HireVue, with no live interviewer. Goes to the recruiter",
            typeId: "recorded_round_note",
          },
        ],
      },
    ],
  },
  {
    id: "stay",
    label: "Stay in touch",
    description: "Updates, congratulations and closing the loop.",
    sections: [
      {
        title: "What's the note about?",
        mode: "any",
        boxes: [
          {
            id: "stay.update",
            label: "Share an update",
            hint: "What you've done since you last talked",
            typeId: "keep_in_touch",
          },
          {
            id: "stay.congrats",
            label: "Congratulate them",
            hint: "A promotion, new job or deal, with no ask",
            typeId: "congratulations",
            excludes: ["stay.second"],
            // With "Share an update", the update's optional news question becomes this one.
            questionText: {
              theirNews: {
                label: "Their news",
                hint: "",
                placeholder: "e.g. promoted to Vice President",
                prompt: "The recipient's news, to congratulate them on",
              },
            },
          },
          {
            id: "stay.referrer",
            label: "Thank the person who introduced me",
            hint: "They connected you with someone, and you've now talked",
            typeId: "close_loop_referrer",
            excludes: ["stay.redirected"],
            questionText: {
              updateSince: {
                label: "Your own news since you last spoke",
                hint: "Separate from how the introduction went and from their advice.",
                prompt:
                  "The student's own news since they last spoke to the referrer - separate from how the introduction went and from the advice they acted on",
              },
            },
          },
          {
            id: "stay.redirected",
            label: "Thank the person who sent me elsewhere",
            hint: "You emailed them, they sent you to someone else, and you've now talked",
            typeId: "redirect_sequence",
            presets: { redirectStep: "close_loop", firstPerson: "{recipient}" },
            questionText: {
              redirectDetail: {
                label: "What you learned from the person they sent you to",
                hint: "You've now talked. One specific thing that came of it.",
                placeholder: "e.g. how her team decides what to stop researching",
                prompt: "What came of the student's conversation with the person they were sent to",
              },
            },
          },
          {
            id: "stay.second",
            label: "Ask for a second conversation",
            hint: "Show what you did with their advice",
            typeId: "second_conversation",
            questionText: {
              updateSince: {
                label: "Your own news since you last spoke",
                hint: "Separate from what you did with their advice.",
                prompt:
                  "The student's own news since they last spoke - separate from what they did with the recipient's advice",
              },
            },
          },
        ],
      },
    ],
  },
  {
    id: "ask",
    label: "Ask for help",
    description: "A referral, an introduction or a recommendation.",
    sections: [
      {
        title: "What are you asking for?",
        mode: "one",
        boxes: [
          {
            id: "ask.referral",
            label: "A referral at their firm",
            hint: "Ask a contact you've talked with to refer you for a role",
            typeId: "referral_ask",
            presets: { askStage: "first" },
          },
          {
            id: "ask.referral_check",
            label: "Check on a referral they agreed to",
            hint: "They said yes. This is the one follow-up",
            typeId: "referral_ask",
            presets: { askStage: "followup" },
          },
          {
            id: "ask.other_firm",
            label: "An introduction at another firm",
            hint: "Ask a contact to connect you with someone they know elsewhere",
            typeId: "referral_ask",
            presets: { askStage: "other_firm" },
          },
          {
            id: "ask.professor",
            label: "A recommendation letter",
            hint: "From a professor",
            typeId: "professor_recommendation",
          },
          {
            id: "ask.reference",
            label: "A job reference",
            hint: "From a former manager or supervisor",
            typeId: "reference_request",
          },
        ],
      },
    ],
  },
  {
    id: "offers",
    label: "Offers & decisions",
    description: "Accepting, declining, asking for time or withdrawing.",
    sections: [
      {
        title: "What's happening?",
        mode: "one",
        boxes: [
          { id: "offers.accept", label: "Accept an offer", hint: "Say yes to an offer you received", typeId: "accept_offer" },
          { id: "offers.decline", label: "Decline an offer", hint: "Turn down an offer you received", typeId: "decline_offer" },
          {
            id: "offers.extension",
            label: "Ask for more time to decide",
            hint: "On an offer with a deadline",
            typeId: "offer_extension",
          },
          {
            id: "offers.withdraw",
            label: "Withdraw before an offer",
            hint: "Cancel an interview or leave a process you're still in",
            typeId: "withdraw_process",
          },
          { id: "offers.rejection", label: "Reply to a rejection", hint: "Thank them and stay on their radar", typeId: "after_rejection" },
          {
            id: "offers.helper",
            label: "Thank someone who helped me get the offer",
            hint: "A contact who referred you or helped you prepare",
            typeId: "thank_helper_offer",
          },
        ],
      },
    ],
  },
  {
    id: "custom",
    label: "Something else",
    description: "Describe it in your own words.",
    sections: [
      {
        title: "What kind of email?",
        mode: "one",
        boxes: [{ id: "custom.describe", label: "I'll describe it", typeId: "custom" }],
      },
    ],
  },
];

// When several boxes are checked, the first of these leads: its examples and
// structure write the email. Ordered by how the playbook's emails lead - a
// referral opens the email, then a shared moment, then who the person is.
//
// Only the boxes that can be checked beside another one need a rank: a box in
// a `mode: "one"` section is never weighed against a sibling. Exported so the
// test can hold that line - an unranked box in a `mode: "any"` section would
// let the browser's post order decide which type writes the email.
export const STRENGTH = [
  "first.referred",
  "first.conference",
  "first.met",
  "first.pointed",
  "first.recruiter",
  "first.inbox",
  "first.alum",
  "first.not_alum",
  "thanks.helped",
  "thanks.superday",
  "thanks.interview",
  "thanks.screen",
  "thanks.recorded",
  "thanks.session",
  "thanks.event",
  "thanks.chat",
  "stay.second",
  "stay.referrer",
  "stay.redirected",
  "stay.update",
  "stay.congrats",
];

const BOXES = new Map(OCCASIONS.flatMap((o) => o.sections.flatMap((s) => s.boxes.map((b) => [b.id, b] as const))));

export function occasionById(id: string | null | undefined): Occasion | null {
  return OCCASIONS.find((o) => o.id === id) ?? null;
}

export function boxById(id: string): Box | null {
  return BOXES.get(id) ?? null;
}

/** Can these two boxes be checked together? Exclusions count in either direction. */
export function boxesConflict(a: string, b: string): boolean {
  return Boolean(BOXES.get(a)?.excludes?.includes(b) || BOXES.get(b)?.excludes?.includes(a));
}

/**
 * The student's click on a box, applied to what's already checked: a "one"
 * section swaps its choice, and anything that can't sit beside the new box is
 * unchecked rather than blocking the click.
 */
export function toggleBox(occasion: Occasion, checked: string[], boxId: string): string[] {
  if (checked.includes(boxId)) return checked.filter((id) => id !== boxId);
  const section = occasion.sections.find((s) => s.boxes.some((b) => b.id === boxId));
  if (!section) return checked;
  const sameSection = new Set(section.boxes.map((b) => b.id));
  return [...checked.filter((id) => !(section.mode === "one" && sameSection.has(id)) && !boxesConflict(id, boxId)), boxId];
}

export type Situation = {
  occasion: Occasion;
  /** The box whose email type writes the email. */
  lead: Box;
  /** The other checked boxes, strongest first. */
  also: Box[];
  /** Answers implied by the boxes, e.g. { redirectStep: "new_person" }. */
  presets: Record<string, string>;
  /** "Reach out for the first time · An alum of my school · We met at a conference" */
  summary: string;
};

/**
 * Checked boxes, validated and ordered. The server calls this too, so the
 * browser's choice is never trusted as-is - and an id this occasion doesn't
 * have is refused rather than dropped. The form can't send one (choosing a new
 * occasion clears the checked boxes), so the only sender is a stale or tampered
 * post, where building the email from fewer boxes than were ticked - without
 * saying so - is worse than refusing it.
 */
export function resolveSituation(occasionId: string, boxIds: string[]): Situation | { error: string } {
  const occasion = occasionById(occasionId);
  if (!occasion) return { error: "Choose what you want to do." };
  const inOccasion = new Set(occasion.sections.flatMap((s) => s.boxes.map((b) => b.id)));
  const ids = [...new Set(boxIds)];
  if (ids.some((id) => !inOccasion.has(id))) {
    return { error: `Those boxes don't go with "${occasion.label}". Check the boxes again.` };
  }
  if (ids.length === 0) return { error: "Check at least one box that describes the situation." };
  for (const section of occasion.sections) {
    if (section.mode === "one" && section.boxes.filter((b) => ids.includes(b.id)).length > 1) {
      return { error: `Pick just one under "${section.title}".` };
    }
  }
  for (const a of ids) {
    for (const b of ids) {
      if (a < b && boxesConflict(a, b)) {
        return { error: `"${BOXES.get(a)!.label}" and "${BOXES.get(b)!.label}" can't both be checked.` };
      }
    }
  }
  const rank = (id: string) => (STRENGTH.includes(id) ? STRENGTH.indexOf(id) : STRENGTH.length);
  const ordered = ids.map((id) => BOXES.get(id)!).sort((a, b) => rank(a.id) - rank(b.id));
  const presets = Object.assign({}, ...ordered.map((b) => b.presets ?? {}).reverse()) as Record<string, string>;
  return {
    occasion,
    lead: ordered[0],
    also: ordered.slice(1),
    presets,
    summary: [occasion.label, ...ordered.map((b) => b.label)].join(" · "),
  };
}

/** The email types a situation draws on, lead first, without repeats. */
export function situationTypes(situation: Situation): EmailType[] {
  const ids = [...new Set([situation.lead, ...situation.also].map((b) => b.typeId))];
  return ids.map((id) => emailTypeById(id)!);
}

// ------------------------------------------------------------------ questions

// The questions that used to be hard-coded form sections, as fields, so every
// question on the form is merged and de-duplicated the same way.
const COLD_BRIEF: Question[] = [
  {
    name: "financeInterest",
    label: "What part of finance draws you?",
    hint: "Be specific - it should tie to their firm or work.",
    placeholder: "e.g. long/short investing, energy banking",
    kind: "text",
    prompt: "",
    section: "Tailoring it to them",
  },
  {
    name: "wantToLearn",
    label: "What do you want to learn from this person?",
    hint: "Their school, firm, group or career path.",
    placeholder: "e.g. their time at Penn and at Goldman",
    kind: "text",
    prompt: "",
    section: "Tailoring it to them",
  },
  {
    name: "specificReason",
    label: "What you and this person have in common",
    hint: "Filled in from what we know - check it and add more.",
    placeholder: "e.g. same hometown; both rowed in college",
    kind: "textarea",
    prompt: "",
    section: "Tailoring it to them",
  },
];

const THREAD_BRIEF: Question[] = [
  {
    name: "originalSubject",
    label: "Subject line of your email",
    hint: "This replies as “Re: …”.",
    placeholder: "e.g. Advice on My Career",
    kind: "text",
    required: true,
    prompt: "",
    section: "The earlier email",
  },
  { name: "originalDate", label: "When did you send it?", hint: "Roughly is fine.", placeholder: "e.g. four days ago", kind: "text", prompt: "", section: "The earlier email" },
  {
    name: "originalAsk",
    label: "What did you ask for?",
    hint: "What you wanted to learn or talk about.",
    placeholder: "e.g. a call about their time at JP Morgan",
    kind: "text",
    prompt: "",
    section: "The earlier email",
  },
];

const FOLLOW_UP_1_DATE: Question = {
  name: "followUp1Date",
  label: "When did you send follow-up #1?",
  hint: "Roughly is fine.",
  placeholder: "e.g. three days ago",
  kind: "text",
  prompt: "",
  section: "The earlier email",
};

const CHAT_BRIEF: Question[] = [
  { name: "meetingWhen", label: "When did you meet?", placeholder: "e.g. this morning", kind: "text", prompt: "", section: "About the conversation" },
  {
    name: "nextStepAsk",
    label: "What do you want to ask next?",
    kind: "select",
    options: [
      { value: "who_else", label: "Who else I should talk to" },
      { value: "intro", label: "An intro to someone specific" },
      { value: "none", label: "No ask, just thanks" },
    ],
    prompt: "",
    section: "About the conversation",
  },
  {
    name: "introName",
    label: "Who?",
    placeholder: "e.g. Josh on their team",
    kind: "text",
    prompt: "",
    showWhen: { field: "nextStepAsk", is: ["intro"] },
    section: "About the conversation",
  },
  {
    name: "introReason",
    label: "Why them?",
    placeholder: "e.g. we're from the same hometown",
    kind: "text",
    prompt: "",
    showWhen: { field: "nextStepAsk", is: ["intro"] },
    section: "About the conversation",
  },
  {
    name: "conversationDetails",
    label: "What did you learn or enjoy?",
    hint: "One or two real details from this exact conversation.",
    placeholder: "e.g. the tip about applying to sales and trading instead of PE",
    kind: "textarea",
    // The one specific detail the thank-you is built on. Required here to match
    // the rest of its alias group (conversationDetail / remarkPoint /
    // recruiterExplained are all required), so whether the student must give
    // it depends on the email rather than on how many boxes they ticked.
    required: true,
    prompt: "",
    section: "About the conversation",
  },
];

const INTERVIEW_BRIEF: Question[] = [
  { name: "meetingWhen", label: "When was it?", placeholder: "e.g. earlier today", kind: "text", prompt: "", section: "About the interview" },
  { name: "interviewTeam", label: "Firm and team", placeholder: "e.g. KKR, distressed investing team", kind: "text", prompt: "", section: "About the interview" },
  {
    name: "conversationDetails",
    label: "Something specific they said",
    placeholder: "e.g. how they create a discount through corporate carve-outs",
    kind: "textarea",
    // As in CHAT_BRIEF: the detail the thank-you exists to carry.
    required: true,
    prompt: "",
    section: "About the interview",
  },
  {
    name: "personalConnection",
    label: "How does it connect to you?",
    placeholder: "e.g. I also grew up with no one in finance",
    kind: "textarea",
    prompt: "",
    section: "About the interview",
  },
];

/**
 * Questions that ask the same thing under different names on different types,
 * as groups: every name in a group is the same question. When more than one
 * would show, only the first one met is asked, and the server gives its answer
 * to every name. Groups, not pairs, so "where did you meet?" is asked once
 * whether it comes from the in-person, conference or recruiter box.
 */
const QUESTION_ALIASES: string[][] = [
  ["metAt", "conferenceName", "whereMet"],
  ["talkedAbout", "whereTalked"],
  // A thank-you's one specific detail: from the chat, the talk or the session, whichever was checked.
  ["conversationDetails", "conversationDetail", "remarkPoint", "recruiterExplained"],
  ["lastSpoke", "firstTalk"],
  ["adviceFollowed", "whatYouDid"],
  ["updateSince", "ownNews"],
];

/**
 * Two questions that ask nearly the same thing when both of their boxes are
 * checked: only `keep` is asked, worded for both, and its answer covers `drop`.
 * Scoped to the boxes rather than global like QUESTION_ALIASES, because
 * "what happens next for you" is its own question beside an update and only a
 * repeat beside "why you're asking now".
 */
export const QUESTION_MERGES: {
  boxes: string[];
  keep: string;
  drop: string;
  text: Partial<Pick<DraftField, "label" | "hint" | "placeholder" | "prompt">>;
}[] = [
  {
    boxes: ["stay.second", "stay.referrer"],
    keep: "whyNow",
    drop: "nextForYou",
    text: {
      label: "What's next for you, and why you're asking now",
      hint: "",
      placeholder: "e.g. applying before the October 15 deadline",
      prompt: "What happens next for the student, and why they are asking for a second conversation now",
    },
  },
  {
    boxes: ["stay.referrer", "stay.congrats"],
    keep: "nextForYou",
    drop: "ownNews",
    text: {
      label: "Your own news, or what happens next for you",
      hint: "",
      placeholder: "e.g. applying to the summer program this week",
      prompt: "The student's own news or what happens next for them, in one sentence",
    },
  },
  {
    boxes: ["first.recruiter", "first.not_alum"],
    keep: "whereMet",
    drop: "howFound",
    text: {
      label: "Where you met this recruiter, or how you found them",
      hint: "",
      placeholder: "e.g. the Kirkwood career fair on Friday, or the firm's campus recruiting page",
      prompt: "Where the student met the recruiter and what they talked about, or how the student found them - say it honestly",
    },
  },
];

/** The other names a question goes by. */
export function aliasesOf(name: string): string[] {
  return QUESTION_ALIASES.filter((g) => g.includes(name)).flatMap((g) => g.filter((n) => n !== name));
}

function briefQuestions(type: EmailType): Question[] {
  const out: Question[] = [];
  if (type.isCold) out.push(...COLD_BRIEF);
  if (type.repliesInThread) out.push(...THREAD_BRIEF, ...(type.id === "follow_up_2" ? [FOLLOW_UP_1_DATE] : []));
  if (type.id === "thank_you_chat") out.push(...CHAT_BRIEF);
  if (type.id === "thank_you_interview") out.push(...INTERVIEW_BRIEF);
  return out;
}

/**
 * Every question the situation needs, in form order: the lead box's first,
 * then each other box's, each asked once. A question implied by a box (a
 * preset) isn't asked; one that only applies to another answer ("new windows"
 * after "they moved it") shows only when that answer is given.
 */
/** Questions that choose what the email asks for. Only the lead box's are asked. */
export const ASK_QUESTIONS = new Set(["eventAsk", "nextStepAsk", "introName", "introReason", "oneQuestion"]);
/** "How did you find them?" questions, which a connection box already answers. */
export const FOUND_QUESTIONS = new Set(["howFound", "whyThem"]);
const CONNECTION_TYPES = new Set<string>(["cold_referral", "cold_after_meeting", "conference_follow_up", "redirect_sequence"]);

export function situationQuestions(situation: Situation, valueOf: (name: string) => string | undefined): Question[] {
  const presetNames = new Set(Object.keys(situation.presets));
  const answer = (name: string) => situation.presets[name] ?? valueOf(name);
  const seen = new Set<string>();
  const out: Question[] = [];
  const types = situationTypes(situation);
  const connected = types.some((t) => CONNECTION_TYPES.has(t.id));
  // A campus recruiter is asked about programs, never about their own path.
  const toRecruiter = types.some((t) => t.id === "recruiter_outreach");
  for (const type of types) {
    const own: Question[] = (type.fields ?? []).map((f) => ({ ...f, section: "About this email" }));
    for (const q of [...briefQuestions(type), ...own]) {
      if (presetNames.has(q.name)) continue;
      // The lead box decides the ask; a secondary box's "what to ask for" would be a second one.
      if (type !== types[0] && ASK_QUESTIONS.has(q.name)) continue;
      // A referral, a meeting or a redirect already says how the student came to them.
      if (connected && FOUND_QUESTIONS.has(q.name)) continue;
      // "Why them specifically" asks for a deal or a sector, which a recruiter doesn't have.
      if (toRecruiter && (q.name === "wantToLearn" || q.name === "whyThem")) continue;
      if (q.showWhen) {
        const controller = [...briefQuestions(type), ...own].find((c) => c.name === q.showWhen!.field);
        const current = answer(q.showWhen.field) || controller?.options?.[0]?.value || "";
        if (!q.showWhen.is.includes(current)) continue;
      }
      if (seen.has(q.name) || aliasesOf(q.name).some((a) => seen.has(a))) {
        // Asked already: a required copy makes the shown one required too.
        if (q.required) {
          const shown = out.find((s) => s.name === q.name || aliasesOf(q.name).includes(s.name));
          if (shown) shown.required = true;
        }
        continue;
      }
      seen.add(q.name);
      out.push({ ...q });
    }
  }
  // Near-repeats asked once when both boxes are checked. A required copy keeps
  // the merged one required.
  //
  // The question to drop is matched through its alias group as well as by its
  // own name: a third box can have absorbed it already (congratulations'
  // "ownNews" into keep_in_touch's "updateSince"), and the question that
  // absorbed it is then the near-repeat to remove. And a merge whose drop was
  // never asked at all still rewords its keep - the merged wording is what
  // makes the question honest beside both boxes ("Where you met this
  // recruiter, or how you found them" for someone who was referred and never
  // met them), and that wording is the whole reason the entry exists.
  const checkedIds = new Set([situation.lead, ...situation.also].map((b) => b.id));
  for (const m of QUESTION_MERGES) {
    if (!m.boxes.every((id) => checkedIds.has(id))) continue;
    const keepAt = out.findIndex((q) => q.name === m.keep);
    if (keepAt < 0) continue;
    const dropNames = [m.drop, ...aliasesOf(m.drop)];
    const dropAt = out.findIndex((q, i) => i !== keepAt && dropNames.includes(q.name));
    if (dropAt >= 0) out[keepAt].required = out[keepAt].required || out[dropAt].required;
    Object.assign(out[keepAt], m.text);
    if (dropAt >= 0) out.splice(dropAt, 1);
  }
  // Each checked box's wording for a question it shares, so the label names the right person and moment.
  for (const box of [situation.lead, ...situation.also]) {
    for (const q of out) Object.assign(q, box.questionText?.[q.name] ?? {});
  }
  return out;
}

/** The answer to a question, or to the same question asked under another name. */
export function answerFor(name: string, valueOf: (name: string) => string | undefined): string | undefined {
  return valueOf(name) || aliasesOf(name).map(valueOf).find(Boolean);
}

/**
 * The answer for one of the shared brief slots (`conversationDetails` and the
 * like), which have no prompt of their own and are read into DraftBrief by
 * name.
 *
 * Like `answerFor`, except it ignores the alias names that are themselves
 * prompted questions on this situation: their answer already reaches the model
 * through `fieldAnswers`, under their own prompt, so copying it into the brief
 * slot as well sends one typed answer twice under two framings (INPUT-1 #4).
 * Pass the questions the form actually asked - `situationQuestions`' result.
 */
export function briefAnswerFor(
  name: string,
  questions: Question[],
  valueOf: (name: string) => string | undefined,
): string | undefined {
  const prompted = new Set(questions.filter((q) => q.prompt).map((q) => q.name));
  return valueOf(name) || aliasesOf(name).filter((a) => !prompted.has(a)).map(valueOf).find(Boolean);
}

// ------------------------------------------------------------------ suggestions

export type RecipientHints = {
  sameSchool: boolean;
  /** Their school is on file and it is not the student's - so "Not an alum"
   *  is a fact, not a guess. False when their school is unknown. */
  knownNotAlum?: boolean;
  role?: string | null;
  name?: string | null;
  hasPriorColdEmail: boolean;
  hasFollowUp1: boolean;
};

/**
 * What the app already knows about this recipient, as box and occasion ids.
 * autoFill turns it into the form's starting answers.
 */
export function suggestions(hints: RecipientHints | null): Set<string> {
  const out = new Set<string>();
  if (!hints) return out;
  const recruiter = /\b(recruit\w*|talent|campus|early careers?|human resources|hr)\b/i;
  const team = /\b(team|recruiting|careers|inbox|office|committee)\b/i;
  if (hints.name && team.test(hints.name)) {
    out.add("first.inbox");
    out.add("follow.inbox");
  } else {
    const isRecruiter = Boolean(hints.role && recruiter.test(hints.role));
    if (hints.sameSchool) out.add("first.alum");
    else if (hints.knownNotAlum && !isRecruiter) out.add("first.not_alum");
    if (isRecruiter) {
      out.add("first.recruiter");
      out.add("follow.recruiter");
    }
  }
  if (hints.hasPriorColdEmail) {
    out.add("follow_up");
    out.add(hints.hasFollowUp1 ? "follow.final" : "follow.first");
  } else {
    out.add("first_contact");
  }
  return out;
}

/**
 * The sections asked only about someone the student found themselves.
 *
 * "How are you connected?" is about how the student came to this person - a
 * referral, a meeting, a conference. For one of their Offerly contacts the app
 * already knows the answer (they found them here, or saved them), so the
 * section is not shown and none of its boxes can be checked.
 */
function isOutsideOnlySection(section: BoxSection): boolean {
  return section.boxes.some((b) => b.id === "first.referred");
}

/** The sections to show, given who the email is going to. */
export function visibleSections(occasion: Occasion, outside: boolean): BoxSection[] {
  return outside ? occasion.sections : occasion.sections.filter((s) => !isOutsideOnlySection(s));
}

/**
 * The form's starting answers for this recipient: what they want to do, and
 * the boxes the facts already settle. Checked for the student, not merely
 * tagged - they can uncheck any of it. Conflicts are resolved the same way a
 * click would (toggleBox), so the result is always a valid set.
 *
 * `occasionId` keeps the student's own choice of occasion when they made one;
 * otherwise the suggested one is used.
 */
export function autoFill(
  hints: RecipientHints | null,
  opts: { outside: boolean; occasionId?: string },
): { occasionId: string; boxes: string[] } {
  const hinted = suggestions(hints);
  const occasion =
    occasionById(opts.occasionId) ?? OCCASIONS.find((o) => hinted.has(o.id)) ?? null;
  if (!occasion) return { occasionId: "", boxes: [] };
  const all = occasion.sections.flatMap((s) => s.boxes);
  // "Something else" and the like: one box, nothing to choose.
  if (all.length === 1) return { occasionId: occasion.id, boxes: [all[0].id] };
  let boxes: string[] = [];
  for (const section of visibleSections(occasion, opts.outside)) {
    for (const box of section.boxes) {
      if (hinted.has(box.id)) boxes = toggleBox(occasion, boxes, box.id);
    }
  }
  return { occasionId: occasion.id, boxes };
}
