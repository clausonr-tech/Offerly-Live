// The email types a student can draft, and the format each one follows.
//
// Formats come from the Offerly Email Drafts playbooks (Volumes I-III). Each
// type pairs with its own examples in email-examples.ts, and a type only ever
// sees its own - that separation is the point of having types at all.
//
// Plain module, no "server-only": the form renders the names, timing, format
// steps and each type's own fields.

/** What the database stores. Kept to the original four so no migration is needed. */
export type DraftKind = "cold_outreach" | "follow_up" | "thank_you" | "custom";

export type EmailTypeId =
  | "cold_email"
  | "cold_after_meeting"
  | "cold_not_alum"
  | "cold_referral"
  | "recruiting_inbox"
  | "follow_up_1"
  | "follow_up_2"
  | "recruiting_inbox_follow_up"
  | "interview_check_in"
  | "call_scheduling"
  | "reschedule_call"
  | "recruiter_scheduling_reply"
  | "thank_you_chat"
  | "thank_you_offered_help"
  | "thank_you_event"
  | "keep_in_touch"
  | "close_loop_referrer"
  | "referral_ask"
  | "thank_you_interview"
  | "thank_you_superday"
  | "thank_you_phone_screen"
  | "recorded_round_note"
  | "after_rejection"
  | "offer_extension"
  | "accept_offer"
  | "decline_offer"
  | "conference_follow_up"
  | "recruiter_outreach"
  | "recruiter_follow_up"
  | "stalled_thread_nudge"
  | "not_now_reply"
  | "redirect_sequence"
  | "coffee_in_person_reply"
  | "thank_you_recruiter_session"
  | "second_conversation"
  | "congratulations"
  | "withdraw_process"
  | "thank_helper_offer"
  | "professor_recommendation"
  | "reference_request"
  | "custom";

/**
 * A form field a type asks for, rendered by the form and read by the server
 * without either needing a type-specific branch. `prompt` is how the answer is
 * labelled for the model; `label` is what the student sees.
 */
export type DraftField = {
  name: string;
  label: string;
  hint?: string;
  placeholder?: string;
  kind: "text" | "textarea" | "select";
  /** For selects. The first is the default. */
  options?: { value: string; label: string }[];
  required?: boolean;
  prompt: string;
  /** Only asked, and only sent, when another select on this type has one of these values. */
  showWhen?: { field: string; is: string[] };
};

export type EmailType = {
  id: EmailTypeId;
  label: string;
  /** Grouping in the type picker, in the order types are listed. */
  group:
    | "First contact"
    | "No reply yet"
    | "After they reply"
    | "After a conversation"
    | "Interviews"
    | "Offers & decisions"
    | "Recommendations & references"
    | "Other";
  /** Stored in email_drafts.kind; the type id itself goes in template_id. */
  dbKind: DraftKind;
  /** When to send it, shown under the picker. */
  timing: string;
  /** The playbook's format, in order. The order may flex; the steps may not. */
  format: string[];
  /** Body word ceiling, signature excluded. Roughly the longest example. */
  maxWords: number;
  /** A first-contact email to a person: resume, finance interest, what to learn, common ground. */
  isCold?: boolean;
  /** The email says the student's resume is attached, and the composer reminds them to attach it. */
  attachResume?: boolean;
  /**
   * The resume goes with it only when the email says it's attached - for types
   * whose examples attach it in some situations and not others.
   */
  attachResumeIfMentioned?: boolean;
  /** Goes to a team inbox rather than a person, so a typed-in recipient is a team name. */
  toTeam?: boolean;
  /** Replies in an earlier thread: "Re: <original subject>", built from the earlier email when there is one. */
  repliesInThread?: boolean;
  /** Type-specific fields beyond the shared ones. */
  fields?: DraftField[];
  /** Rules for the model that belong to this type alone. */
  promptNotes?: string[];
};

const TONE_NOTE = "Genuine and kind, never aggressive or demanding";

const TIME_ZONE_FIELD: DraftField = {
  name: "timeZone",
  label: "Your time zone",
  kind: "select",
  options: [
    { value: "Eastern", label: "Eastern" },
    { value: "Central", label: "Central" },
    { value: "Mountain", label: "Mountain" },
    { value: "Pacific", label: "Pacific" },
    { value: "London", label: "London" },
    { value: "Central Europe", label: "Central Europe" },
    { value: "India", label: "India" },
    { value: "Singapore / Hong Kong", label: "Singapore / Hong Kong" },
  ],
  prompt: "The student's time zone - write it out with every time",
};

// Used by both follow-ups: Volume III's versions after met-in-person, referral
// and non-alum emails differ only in this reminder line.
const OTHER_FIRST_EMAIL_NOTE =
  "If the original was a met-in-person, referral or not-an-alum email, remind them of that connection in one short " +
  "sentence of its own - the event, the referrer, or the reason the student wrote. That reminder is the whole job of " +
  "this email. Never fold it into the follow-up line (\"Following up on my note as a fellow Penn student hoping to " +
  "learn about your path, in case it got buried\" makes the reader untangle it): the follow-up is one sentence, the " +
  "reminder the next.";

const TRANSCRIPT_NOTE =
  "The app already reminds the student to attach their resume. If the email mentions a transcript or any other " +
  "document, write it as attached and add a note to `notesForStudent` to attach it to the email before sending - " +
  "never a placeholder in the body.";

const GIVEN_TIMES_NOTE =
  "Use only the days and times the student gave, tidied up (\"thurs am\" becomes \"Thursday: before noon\"). Never " +
  "add calendar dates, \"next week\" or a time zone that wasn't given.";

export const EMAIL_TYPES: EmailType[] = [
  // ------------------------------------------------------ first contact ----
  {
    id: "cold_email",
    label: "Cold email: alum",
    group: "First contact",
    dbKind: "cold_outreach",
    isCold: true,
    attachResume: true,
    timing: "First contact with someone who went to your school.",
    format: [
      "Introduce yourself: name, year, school, major, recent work and clubs (pulled from your resume)",
      "Say what specifically draws you to finance and how it ties to their firm or work",
      "Say how you found them. Only name the school's alumni database when RECIPIENT confirms they went to your school - if it does not, leave out how you found them rather than claiming a shared school",
      "Say you'd love to learn about their time in college, their career, and their firm",
      "Ask for a 10-minute call",
      "Leave the timing to them, in wording built from this email - never a stock line about flexibility or working around a schedule (the courtesy-line rule under SOUND LIKE A PERSON, NOT A TEMPLATE applies)",
      "Mention your attached resume (you attach it when you send)",
      "Thank them for their time, then sign off",
      "The more concise the better. " + TONE_NOTE,
    ],
    // Volume III's non-finance major needs the room to explain the switch.
    maxWords: 200,
  },
  {
    id: "cold_after_meeting",
    label: "Cold email: met in person",
    group: "First contact",
    dbKind: "cold_outreach",
    isCold: true,
    attachResume: true,
    timing: "Send within 24-48 hours of the event, while they still remember the conversation.",
    format: [
      "Name the event in the subject line",
      "Open with the exact moment you met: the event, the day, and something specific you talked about",
      "Give a one-line reminder of who you are (name, school, year, major)",
      "Explain what stuck with you from the conversation and how it connects to your interests",
      "Explicitly ask for a 10-15 minute call to continue the conversation",
      "Leave the timing to them, in wording built from this email - never a stock line about flexibility or working around a schedule (the courtesy-line rule under SOUND LIKE A PERSON, NOT A TEMPLATE applies)",
      "Mention your attached resume (you attach it when you send)",
      "Thank them for their time, then sign off",
      "The specific detail in the opening is what makes them remember you, so don't be vague. " + TONE_NOTE,
    ],
    maxWords: 180,
    fields: [
      {
        name: "metAt",
        label: "Where and when you met this person",
        hint: "The event and the day.",
        placeholder: "e.g. the RITG markets panel on Tuesday night",
        kind: "text",
        required: true,
        prompt: "Where and when they met",
      },
      {
        name: "talkedAbout",
        label: "What you and this person talked about",
        hint: "The specific detail they'll remember.",
        placeholder: "e.g. his '73 Bronco restoration",
        kind: "textarea",
        required: true,
        prompt: "The specific thing they talked about - open the email with it",
      },
      {
        name: "stuckWithYou",
        label: "The point that stuck with you most",
        hint: "And how it connects to what you want to do.",
        placeholder: "e.g. his point about starting positions at half size",
        kind: "textarea",
        prompt: "What stuck with the student from the conversation, and how it connects to their interests",
      },
    ],
    promptNotes: [
      "Name the event in the subject line.",
      "Open with the exact moment they met - the event, the day and the specific thing they talked about. Never vague.",
      "Only after that, give a one-line reminder of who the student is. With no internship, the event itself is evidence of interest.",
      "If the day of the event isn't given, leave it out - no placeholder.",
    ],
  },
  {
    id: "cold_not_alum",
    label: "Cold email: not an alum",
    group: "First contact",
    dbKind: "cold_outreach",
    isCold: true,
    attachResume: true,
    timing: "Send any time. Use this when you have no school in common.",
    format: [
      "Introduce yourself: name, school, year, major, recent work and clubs",
      "Explain exactly how you found them, honestly and specifically",
      "Explain why you're reaching out to them in particular: the sector, the deal, or their career path",
      "Add a line or two of your background that makes the interest credible",
      "Explicitly ask for a 10-15 minute meeting",
      "Leave the timing to them, in wording built from this email - never a stock line about flexibility or working around a schedule (the courtesy-line rule under SOUND LIKE A PERSON, NOT A TEMPLATE applies)",
      "Mention your attached resume (you attach it when you send)",
      "Thank them for their time, then sign off",
      "Without a shared school, the \"why you specifically\" line does all the work, so make it real. Never invent a connection; being straightforward about LinkedIn is fine",
      "The more concise the better. " + TONE_NOTE,
    ],
    maxWords: 180,
    fields: [
      {
        name: "howFound",
        label: "How you found this person",
        hint: "Honest and specific - LinkedIn is fine.",
        placeholder: "e.g. LinkedIn, while researching healthcare coverage groups",
        kind: "text",
        required: true,
        prompt: "How the student found them - say it honestly and specifically",
      },
      {
        name: "whyThem",
        label: "Why this person specifically",
        hint: "A deal, their sector, their path, a shared hometown.",
        placeholder: "e.g. they led a carveout I read about in Middle Market Weekly",
        kind: "textarea",
        required: true,
        prompt: "Why the student is reaching out to this person in particular - this line does the work a shared school would",
      },
    ],
    promptNotes: [
      "The recipient did not go to the student's school. Never imply a shared school, and never invent any connection.",
      "Say plainly how the student found them; LinkedIn is completely fine.",
    ],
  },
  {
    id: "cold_referral",
    label: "Cold email: referral",
    group: "First contact",
    dbKind: "cold_outreach",
    isCold: true,
    attachResume: true,
    timing: "Send within 2-3 days of being given the name, while the referral is still fresh.",
    format: [
      "Put the referrer's name in the subject line",
      "Lead with the referral in the very first sentence: who suggested you reach out and how you know them",
      "Introduce yourself (name, school, year, major)",
      "Explain why that person pointed you toward them specifically",
      "Give a line or two of relevant background",
      "Explicitly ask for a 10-15 minute meeting",
      "Leave the timing to them, in wording built from this email - never a stock line about flexibility or working around a schedule (the courtesy-line rule under SOUND LIKE A PERSON, NOT A TEMPLATE applies)",
      "Mention your attached resume (you attach it when you send)",
      "Thank them for their time, then sign off",
      "Only use someone's name if they offered it. The referral does the first paragraph's work, so this can be shorter. " + TONE_NOTE,
    ],
    maxWords: 165,
    fields: [
      {
        name: "referrerName",
        label: "The referrer's name",
        hint: "Whoever suggested you reach out to this person.",
        placeholder: "e.g. Sarah Chen",
        kind: "text",
        required: true,
        prompt: "Referred by",
      },
      {
        name: "referrerContext",
        label: "How you know the referrer, and why they suggested this person",
        placeholder: "e.g. spoke with her last week about her first year; she said he's the person for the credit team",
        kind: "textarea",
        required: true,
        prompt: "How the student knows the referrer, and why the referrer pointed them to this person",
      },
    ],
    promptNotes: [
      "Put the referrer's name in the subject line.",
      "Lead with the referral in the very first sentence: who suggested reaching out and how the student knows them.",
      "The referral does the first paragraph's work, so this can be shorter than a normal cold email. For a student with little experience, let it carry what the resume can't yet.",
    ],
  },
  {
    id: "recruiting_inbox",
    label: "Email to a recruiting inbox",
    group: "First contact",
    dbKind: "custom",
    attachResume: true,
    toTeam: true,
    timing: "Send after applying, or after an event where the team asked you to send materials.",
    format: [
      "Subject line with your school, class year, and the exact program or role",
      "A neutral greeting to the team rather than to one person",
      "State your name, school, major and graduation year (the profile holds no month, so never ask for one or leave a placeholder for it) in the first two lines",
      "Name the exact program, role, or requisition number",
      "Give two or three lines of relevant experience",
      "Ask one specific, answerable question (timeline, eligibility, or confirmation)",
      "Mention your attached resume (you attach it when you send)",
      "Thank them for their time, then sign off",
      "Shorter and more formal than a cold email to a person; skip the small talk. Don't send more than one follow-up to an inbox. " + TONE_NOTE,
    ],
    maxWords: 150,
    fields: [
      {
        name: "program",
        label: "Program, role or requisition #",
        placeholder: "e.g. 2028 Summer Analyst, Investment Banking (Req #40712)",
        kind: "text",
        required: true,
        prompt: "The exact program, role or requisition number",
      },
      {
        name: "inboxContext",
        label: "Why you're writing",
        hint: "When you applied, or who asked you to send materials.",
        placeholder: "e.g. applied Sept 4 through the portal and never got a confirmation",
        kind: "textarea",
        required: true,
        prompt: "Why the student is writing to the inbox",
      },
      {
        name: "inboxQuestion",
        label: "Your one question",
        hint: "Timeline, eligibility or confirmation.",
        placeholder: "e.g. can you confirm my application was received?",
        kind: "text",
        required: true,
        prompt: "The one specific question to ask",
      },
    ],
    promptNotes: [
      "Usually a team inbox: greet the team, e.g. \"Hello {firm} Recruiting Team,\". If RECIPIENT names a person rather than a team, greet them by first name instead and keep the same short, formal shape.",
      "Subject line: the student's school and class year, and the exact program or role.",
      "Give name, school, major and graduation year in the first two lines. If the graduation month isn't given, give just the year.",
      "Shorter and more formal than a cold email: no small talk. Ask exactly one specific, answerable question.",
      "For a sponsorship question, state the visa status and what's needed in plain, correct terms, and ask about the specific program. For a transfer student, give years completed where eligibility depends on it. For a late senior, ask about off-cycle or full-time roles by name.",
      TRANSCRIPT_NOTE,
    ],
  },

  {
    id: "conference_follow_up",
    label: "Cold email: met at a conference",
    group: "First contact",
    dbKind: "cold_outreach",
    isCold: true,
    attachResume: true,
    timing: "Within 48 hours, while they can still place your face among several hundred people.",
    format: [
      "Name the conference and the city in the first line, since they may have attended four this year",
      "Describe the specific conversation, including where it happened, so they can place you",
      "Say what stuck with you and connect it to what you're working toward",
      "Ask for a 10-minute call",
      "Leave the timing to them and mention your attached resume (you attach it when you send), both in wording built from this email rather than a stock courtesy line, then thank them",
      "They met dozens of students, so the placing detail matters more than anywhere else. If they were a sponsor, say what you talked about at the table",
    ],
    maxWords: 170,
    fields: [
      {
        name: "conferenceName",
        label: "Conference and city",
        placeholder: "e.g. the Meridian Diversity in Finance Conference in Chicago",
        kind: "text",
        required: true,
        prompt: "The conference and city - name both in the first line",
      },
      {
        name: "whereTalked",
        label: "Where you talked, and about what",
        hint: "The breakout, the booth, the coffee line - whatever places you.",
        placeholder: "e.g. after the Thursday breakout on career switching",
        kind: "textarea",
        required: true,
        prompt: "Where the conversation happened and what it was about - the detail that lets them place the student",
      },
      {
        name: "stuckWithYou",
        label: "The point that stuck with you most",
        placeholder: "e.g. her point that being the only person with my background cuts both ways",
        kind: "textarea",
        prompt: "What stuck with the student and how it connects to what they're working toward",
      },
    ],
    promptNotes: [
      "Name the conference and the city in the first line.",
      "Describe exactly where they spoke and what about, so they can place the student among hundreds.",
      "Ask for 10 minutes.",
    ],
  },
  {
    id: "recruiter_outreach",
    label: "Email to a campus recruiter",
    group: "First contact",
    dbKind: "cold_outreach",
    attachResume: true,
    timing: "Within 48 hours of meeting them at a fair or event, while your name is still on their list.",
    format: [
      "Remind them where you met and what you talked about, if you did",
      "Introduce yourself: name, school, class year and graduation year (the profile holds no month, so never ask for one or leave a placeholder for it)",
      "Ask two or three questions only a recruiter can answer: programs, timeline, how to prepare",
      "Mention your attached resume (you attach it when you send) and thank them",
      "Never ask a recruiter about their own career path - that's a question for a banker",
    ],
    maxWords: 150,
    fields: [
      {
        name: "whereMet",
        label: "Where you met this recruiter, and what you talked about",
        hint: "Leave blank if you haven't met.",
        placeholder: "e.g. the Kirkwood career fair on Friday; I asked if it was too early to be in her line",
        kind: "textarea",
        prompt: "Where the student met the recruiter and what they talked about",
      },
      {
        name: "recruiterQuestions",
        label: "Your two or three questions for this recruiter",
        hint: "Things only a recruiter knows: programs, dates, process.",
        placeholder: "e.g. do you run sophomore insight programs, and when do they open?",
        kind: "textarea",
        required: true,
        prompt: "The questions to ask - two or three at most, numbered as \"First\" and \"Second\" in prose",
      },
    ],
    promptNotes: [
      "The recipient is a recruiter, a person rather than an inbox. Greet them by first name.",
      "Give name, school, class year and graduation year in the introduction. The profile holds only a year, never a month, so never ask for a graduation month and never leave a placeholder for one.",
      "Ask at most three questions, each answerable, in prose (\"First, ... Second, ...\"). Never ask about the recruiter's own career.",
      "For an MBA student, ask about the associate program.",
    ],
  },

  // ------------------------------------------------------ no reply yet ----
  {
    id: "follow_up_1",
    label: "Follow-up #1",
    group: "No reply yet",
    dbKind: "follow_up",
    repliesInThread: true,
    timing: "Send 3-5 business days after the first email, in the same thread.",
    format: [
      'Subject is "Re: [original subject line]"',
      "Open with one short sentence that follows up on the first email: the follow-up itself, not wanting to follow up. Say when the first email went out only if THIS EMAIL gives the date, and never how long ago it was",
      "For a met-in-person, referral or non-alum email, remind them of the connection in a short sentence of its own",
      "Quickly ask again whether they have 10 minutes to talk",
      "Leave the timing to them, in wording built from this email - never a stock line about flexibility or working around a schedule (the courtesy-line rule under SOUND LIKE A PERSON, NOT A TEMPLATE applies)",
      "Thank them for their time",
      "Don't restate your whole background; the original email is right below this one. " + TONE_NOTE,
    ],
    maxWords: 80,
    promptNotes: [OTHER_FIRST_EMAIL_NOTE, "Do not restate the student's background; the original email is directly below this one."],
  },
  {
    id: "follow_up_2",
    label: "Follow-up #2 (last one)",
    group: "No reply yet",
    dbKind: "follow_up",
    repliesInThread: true,
    timing: "Send 3-5 business days after follow-up #1. Do not send more after this one.",
    format: [
      'Subject is "Re: [original subject line]"',
      "Say you wanted to reach out one last time",
      "For a met-in-person, referral or non-alum email, repeat the connection in a short sentence of its own",
      "Say you're eager, but don't want to be disrespectful",
      "Ask for a 10-minute chat and say you'll stop reaching out for now",
      "Thank them for their time",
      "Mean it when you say you'll stop; three emails total is the ceiling. " + TONE_NOTE,
    ],
    maxWords: 100,
    promptNotes: [OTHER_FIRST_EMAIL_NOTE, "Leave the door open without asking them to walk through it."],
  },
  {
    id: "recruiting_inbox_follow_up",
    label: "Follow-up to a recruiting inbox",
    group: "No reply yet",
    dbKind: "follow_up",
    attachResume: true,
    toTeam: true,
    timing: "Send at least a week after your message to the inbox, and only once.",
    format: [
      "Reply on the same thread so the original message travels with it",
      "Restate who you are in one line: name, school, class year, and the program",
      "Re-ask the one question you asked the first time, in the same words if possible",
      "Note that your materials are attached again for convenience",
      "Thank them for their time, then sign off",
      "An inbox gets at most one follow-up. Keep it formal and neutral, and never ask a new question",
    ],
    maxWords: 110,
    fields: [
      {
        name: "threadSubject",
        label: "Subject of your original email",
        hint: "The follow-up replies as “Re: …”.",
        placeholder: "e.g. Calder ’29, 2028 Summer Analyst Application (Req #31894)",
        kind: "text",
        required: true,
        prompt: "Subject of the original email to the inbox (this replies in that thread)",
      },
      {
        name: "originalSent",
        label: "When you sent it",
        placeholder: "e.g. September 2",
        kind: "text",
        required: true,
        prompt: "When the original message was sent",
      },
      {
        name: "program",
        label: "Program, role or requisition #",
        placeholder: "e.g. 2028 Summer Analyst, Investment Banking (Req #31894)",
        kind: "text",
        required: true,
        prompt: "The program, role or requisition number",
      },
      {
        name: "inboxQuestion",
        label: "The question you asked",
        placeholder: "e.g. confirm my application was received",
        kind: "text",
        required: true,
        prompt: "The one question from the original email - re-ask it, in the same words if possible, and never add a new one",
      },
    ],
    promptNotes: [
      "Usually a team inbox: greet the team, e.g. \"Hello {firm} Recruiting Team,\". If RECIPIENT names a person, greet them by first name.",
      "Open by saying this follows up on the message from the date given, then restate who the student is in one line.",
      "Re-ask only the original question. Formal and neutral: nobody knows who is reading it.",
      TRANSCRIPT_NOTE,
    ],
  },
  {
    id: "interview_check_in",
    label: "Checking in after an interview",
    group: "No reply yet",
    dbKind: "follow_up",
    timing: "Send 7-10 business days after your thank-you note, or a few days after the date they gave you.",
    format: [
      "Keep the thread: reply to your thank-you note, or use \"Following Up on the [Role] Interview\"",
      "Reference the interview: the role and the date",
      "Reiterate your interest in one specific sentence",
      "Politely ask about the timeline or where the process stands",
      "Offer to send anything else they need",
      "Thank them for their time, then sign off",
      "Two check-ins maximum, at least a week apart. Don't manufacture urgency; a real deadline elsewhere may be mentioned once, politely. " + TONE_NOTE,
    ],
    maxWords: 120,
    fields: [
      {
        name: "interviewRole",
        label: "Role and team",
        placeholder: "e.g. Summer Analyst, Energy Group",
        kind: "text",
        required: true,
        prompt: "The role and team interviewed for",
      },
      {
        name: "interviewDate",
        label: "Interview date",
        placeholder: "e.g. September 24",
        kind: "text",
        required: true,
        prompt: "When the interview was",
      },
      {
        name: "interviewDetail",
        label: "Something specific from the interview",
        placeholder: "e.g. how the group underwrites long-term power contracts",
        kind: "textarea",
        prompt: "A specific thing from the interview to tie the student's interest to",
      },
      {
        name: "otherDeadline",
        label: "A real deadline elsewhere",
        hint: "Only if you have one. Mentioned once, politely.",
        placeholder: "e.g. an offer elsewhere due October 12",
        kind: "text",
        prompt: "A real deadline from another firm - mention once, politely, with no pressure",
      },
      {
        name: "threadSubject",
        label: "Subject of your thank-you note",
        hint: "The check-in replies in that thread.",
        placeholder: "e.g. Thank You",
        kind: "text",
        prompt: "Subject of the student's thank-you note (the check-in replies in that thread)",
      },
      {
        name: "lastCheckIn",
        label: "Is this your last check-in?",
        kind: "select",
        options: [
          { value: "no", label: "No" },
          { value: "yes", label: "Yes - my final check-in" },
        ],
        prompt: "Whether this is the student's final check-in",
      },
    ],
    promptNotes: [
      "Reference the role and the interview date, and reiterate interest in one specific sentence.",
      "Politely ask about the timeline or where the process stands, and offer to send anything else needed.",
      "Mention another firm's deadline only if the student gave one - once, politely. Never manufacture urgency.",
      "If this is the final check-in, say it's the last one and thank them regardless of the outcome.",
      "If no thank-you subject is given, use \"Following Up on the [role] Interview\" as the subject.",
    ],
  },

  {
    id: "recruiter_follow_up",
    label: "Follow-up to a recruiter",
    group: "No reply yet",
    dbKind: "follow_up",
    repliesInThread: true,
    timing: "5-7 business days after your first message to a recruiter, and only once.",
    format: [
      "Reply on the same thread",
      "Remind them where you met in one short phrase",
      "Re-ask the same questions, shortened",
      "Acknowledge that this is their busiest season",
      "Thank them and sign off",
      "Silence from a recruiter in recruiting season is almost never personal. One follow-up, then leave it",
    ],
    maxWords: 90,
    fields: [
      {
        name: "stillOpen",
        label: "The question you still need answered",
        placeholder: "e.g. when the 2027 summer analyst application opens",
        kind: "text",
        prompt: "The question the student still needs answered - restate it shorter than the original",
      },
    ],
    promptNotes: [
      "Shorten the ask rather than repeating it at full length, and make it easy: pointing to a page is plenty.",
      "Acknowledge that it's their busiest season. This is the only follow-up.",
    ],
  },
  {
    id: "stalled_thread_nudge",
    label: "Nudge when a thread goes quiet",
    group: "No reply yet",
    dbKind: "follow_up",
    timing: "4-7 days after their partial reply, or after the thread stalls.",
    format: [
      "Thank them for the part they did answer",
      "Restate the single open question in one sentence",
      "Make it answerable in a word or two, so replying costs them nothing",
      "Give them an easy out if the answer is no",
      "Thank them and sign off",
      "One question, not two. Never point out that they didn't answer, and never quote your own email back. One nudge only",
    ],
    maxWords: 95,
    fields: [
      {
        name: "threadSubject",
        label: "Subject of the thread",
        hint: "Your nudge replies in it.",
        placeholder: "e.g. Following Up from the Meridian Conference",
        kind: "text",
        required: true,
        prompt: "Subject of the thread (the nudge replies in it)",
      },
      {
        name: "answeredPart",
        label: "What they did say",
        placeholder: "e.g. a warm note back, but no time for the call",
        kind: "text",
        prompt: "What the recipient did reply with",
      },
      {
        name: "openQuestion",
        label: "The one thing still open",
        placeholder: "e.g. whether a 15-minute call works in the next few weeks",
        kind: "text",
        required: true,
        prompt: "The single open question - make it answerable in a word or two",
      },
    ],
    promptNotes: [
      "Thank them for what they did say, then restate only the one open question and make it answerable in a word.",
      "Never point out that they didn't answer. Offer an easy out and say you won't keep asking.",
    ],
  },

  // --------------------------------------------------- after they reply ----
  {
    id: "call_scheduling",
    label: "Reply when they agree to a call",
    group: "After they reply",
    dbKind: "custom",
    repliesInThread: true,
    timing: "Send within a few hours of their reply - the easiest email to get right and the worst one to delay.",
    format: [
      "Thank them for getting back to you",
      "Confirm that you'll work entirely around their schedule",
      "Offer three or four specific windows, with the time zone written out",
      "Confirm the format (Zoom, phone, or in person) and ask for the number or link",
      "Offer to send the calendar invite yourself",
      "Thank them again, then sign off",
      "Always include the time zone. If they propose a time, accept it and stop negotiating. A few lines - logistics, not a pitch. " + TONE_NOTE,
    ],
    // The list of time windows alone runs 30-40 words.
    maxWords: 140,
    fields: [
      {
        name: "canMakeIt",
        label: "Did they propose a time?",
        kind: "select",
        options: [
          { value: "none", label: "No - I'll offer times" },
          { value: "yes", label: "Yes, and I can make it" },
          { value: "no", label: "Yes, but I can't make it" },
        ],
        prompt: "Whether the recipient proposed a time",
      },
      {
        name: "proposedTime",
        showWhen: { field: "canMakeIt", is: ["yes", "no"] },
        label: "The time they proposed",
        hint: "Include their time zone if they gave one.",
        placeholder: "e.g. Thursday at 4:30 p.m. ET",
        kind: "text",
        prompt: "The time the recipient proposed",
      },
      {
        name: "availability",
        showWhen: { field: "canMakeIt", is: ["none", "no"] },
        label: "Your open windows",
        hint: "Three or four, with days and times.",
        placeholder: "e.g. Tue Oct 6, 9-12; Wed Oct 7 after 2; Fri Oct 9 before noon",
        kind: "textarea",
        prompt: "The student's open windows - list them one per line, exactly as given (no added dates)",
      },
      TIME_ZONE_FIELD,
      {
        name: "callFormat",
        label: "Format",
        kind: "select",
        options: [
          { value: "either", label: "Zoom or phone, their choice" },
          { value: "zoom", label: "Zoom" },
          { value: "phone", label: "Phone" },
          { value: "in_person", label: "In person" },
        ],
        prompt: "The call format",
      },
    ],
    promptNotes: [
      "This replies in the same thread: do not reintroduce the student.",
      "If they proposed a time the student can make, just confirm it and stop negotiating.",
      "Otherwise list the student's open windows, one per line, with the time zone written out. If no windows are given, write [your available times].",
      GIVEN_TIMES_NOTE,
      "Confirm the format and ask for their number or link, and offer to send the calendar invite.",
      "Keep it to a few lines: this is logistics, not a pitch.",
    ],
  },
  {
    id: "reschedule_call",
    label: "Rescheduling or canceling a call",
    group: "After they reply",
    dbKind: "custom",
    timing: "Send as early as you can, and at least 24 hours ahead whenever that's in your control.",
    format: [
      "Apologize briefly, once",
      "Give a one-line reason",
      "Offer two or three new windows with the time zone, or cancel cleanly with no rescheduling ask",
      "Thank them for their flexibility, then sign off",
      "Never reschedule the same person twice if you can avoid it. Don't over-explain. If you no longer need the call, say so honestly - never pretend to a scheduling conflict",
    ],
    maxWords: 130,
    fields: [
      {
        name: "rescheduleAction",
        label: "What do you need to do?",
        kind: "select",
        options: [
          { value: "reschedule", label: "Move the call" },
          { value: "cancel", label: "Cancel it entirely" },
          { value: "they_moved", label: "They moved it - I'm replying" },
          { value: "missed", label: "I missed the call" },
        ],
        prompt: "Whether the student is moving the call or canceling it",
      },
      {
        name: "callTime",
        label: "The call you set up",
        placeholder: "e.g. Thursday at 3:00 p.m.",
        kind: "text",
        required: true,
        prompt: "When the call was scheduled",
      },
      {
        name: "rescheduleReason",
        showWhen: { field: "rescheduleAction", is: ["reschedule", "cancel", "missed"] },
        label: "One-line reason",
        hint: "If you're moving or canceling it.",
        placeholder: "e.g. a required class session was added that afternoon",
        kind: "text",
        prompt: "The one-line reason",
      },
      {
        name: "newWindows",
        showWhen: { field: "rescheduleAction", is: ["reschedule", "they_moved", "missed"] },
        label: "New times you can do",
        hint: "Only if you're moving it.",
        placeholder: "e.g. Mon Oct 12 after 1; Tue Oct 13 before noon",
        kind: "textarea",
        prompt: "The student's new windows - list them one per line, exactly as given (no added dates)",
      },
      TIME_ZONE_FIELD,
      {
        name: "threadSubject",
        label: "Subject of the thread",
        hint: "Your email replies in it.",
        placeholder: "e.g. Call on Thursday",
        kind: "text",
        prompt: "Subject of the thread the call was set up in",
      },
    ],
    promptNotes: [
      "Apologize once, briefly. Give the one-line reason without over-explaining, and never a reason that makes the call sound low priority.",
      "If moving it, propose the new windows in this same email, one per line, with the time zone, so they only reply once. If no windows are given, write [your available times].",
      "If canceling, don't ask to reschedule. If the student no longer needs the call (e.g. accepted an offer), say so honestly and briefly, and leave the door open to talk later.",
      "If they moved the call on the student, thank them for letting you know with no trace of inconvenience, and confirm the new time or offer windows.",
      "If the student missed the call, apologize once and directly, with no elaborate excuse, and offer to work entirely around them. Send it the moment they realize.",
      GIVEN_TIMES_NOTE,
    ],
  },
  {
    id: "recruiter_scheduling_reply",
    label: "Replying to a recruiter scheduling an interview",
    group: "After they reply",
    dbKind: "custom",
    attachResumeIfMentioned: true,
    timing: "Send within a few hours - scheduling emails are the easiest thing in recruiting to be excellent at.",
    format: [
      "Thank them for the invitation",
      "Confirm the slot in the words it was offered in, or ask for a different one. Never add or convert a time zone: the slot is theirs, and the only zone given to you is the student's own",
      "Confirm the format and any materials they asked you to bring or send",
      "Ask any logistics questions, such as dress code or who you'll meet",
      "Thank them, then sign off",
      "More formal than replying to a professional who agreed to a chat. Repeat the date and time back in writing. Ask all your logistics questions at once",
    ],
    maxWords: 140,
    fields: [
      {
        name: "slotResponse",
        label: "Can you make the slot?",
        kind: "select",
        options: [
          { value: "confirm", label: "Yes - confirm it" },
          { value: "different", label: "No - I need a different slot" },
        ],
        prompt: "Whether the student is confirming the slot or asking for another",
      },
      {
        name: "offeredSlot",
        label: "The slot they offered",
        placeholder: "e.g. Tuesday, October 20 at 11:00 a.m.",
        kind: "text",
        required: true,
        prompt: "The slot the recruiter offered - repeat it back with the time zone",
      },
      {
        name: "interviewFormat",
        label: "Format",
        kind: "select",
        options: [
          { value: "virtual", label: "Video call" },
          { value: "phone", label: "Phone" },
          { value: "in_person", label: "In person / superday" },
        ],
        prompt: "The interview format",
      },
      TIME_ZONE_FIELD,
      {
        name: "conflictReason",
        showWhen: { field: "slotResponse", is: ["different"] },
        label: "Why you need another slot",
        hint: "Only if you do. One short clause.",
        placeholder: "e.g. a midterm I can't move",
        kind: "text",
        prompt: "Why the student needs a different slot - say it in one short clause",
      },
      {
        name: "availability",
        showWhen: { field: "slotResponse", is: ["different"] },
        label: "Your alternatives",
        hint: "Only if you need another slot.",
        placeholder: "e.g. Wed Oct 14 any time; Thu Oct 15 before noon",
        kind: "textarea",
        prompt: "The student's alternative windows - list them one per line, exactly as given (no added dates)",
      },
      {
        name: "materials",
        label: "Materials they asked for",
        placeholder: "e.g. unofficial transcript",
        kind: "text",
        prompt: "Materials the recruiter asked for",
      },
      {
        name: "logistics",
        label: "Logistics questions",
        hint: "Ask them all in this one email.",
        placeholder: "e.g. is travel booked for me? business formal or casual?",
        kind: "textarea",
        prompt: "The student's logistics questions - put them in one numbered list",
      },
      {
        name: "threadSubject",
        label: "Subject of their email",
        hint: "Your reply keeps the thread.",
        placeholder: "e.g. First Round Interview Scheduling",
        kind: "text",
        prompt: "Subject of the recruiter's email",
      },
    ],
    promptNotes: [
      "Formal: this is a process, not a favor. Repeat the date, time and time zone back in writing.",
      "If a different slot is needed, give the reason in one short clause and list real alternatives one per line with the time zone. If none are given, write [your available times].",
      "Put all logistics questions in one numbered list. For an in-person superday invitation from a team, greet the team.",
      GIVEN_TIMES_NOTE,
      TRANSCRIPT_NOTE,
    ],
  },

  {
    id: "not_now_reply",
    label: "When they say \"not now\"",
    group: "After they reply",
    dbKind: "custom",
    repliesInThread: true,
    timing: "Reply within a few hours; then follow up exactly when you said you would.",
    format: [
      "Thank them for replying at all",
      "Accept the timing without negotiating it",
      "Name when you'll follow up if THIS EMAIL gives a time, so the later email is expected rather than intrusive; with no time given, say you'll check back without naming a date",
      "Keep it to three or four sentences",
      "When you come back later, use their own words and reference any reason they gave",
    ],
    maxWords: 110,
    fields: [
      {
        name: "notNowStage",
        label: "Which email is this?",
        kind: "select",
        options: [
          { value: "reply", label: "Replying to their \"not now\"" },
          { value: "later", label: "Following up when they said to" },
        ],
        prompt: "Whether this replies to the not-now or is the later follow-up",
      },
      {
        name: "theirWords",
        label: "What they said",
        placeholder: "e.g. swamped until our deal closes, try me in a few weeks",
        kind: "text",
        required: true,
        prompt: "What the recipient said about timing, and any reason - use their own words when coming back",
      },
      {
        name: "followUpWhen",
        showWhen: { field: "notNowStage", is: ["reply"] },
        label: "When you'll follow up",
        placeholder: "e.g. early November",
        kind: "text",
        prompt: "When the student will follow up",
      },
    ],
    promptNotes: [
      "Replying to a not-now: thank them, accept the timing with no pushing, and name when the student will follow up. Three or four sentences.",
      "Following up later: say they mentioned the timing, use their words, reference any reason (like a deal closing), and ask again lightly with an easy out.",
    ],
  },
  {
    id: "redirect_sequence",
    label: "When they point you to someone else",
    group: "After they reply",
    dbKind: "custom",
    attachResumeIfMentioned: true,
    timing: "Reply the same day, and email the new person within two days.",
    format: [
      "Only the email THIS EMAIL names gets written. The three steps below are one per email; follow the one that matches and ignore the other two",
      "Thanking the first person: thank them for the redirect specifically, not generically, and ask whether they'd prefer to introduce you or whether you should write directly",
      "Emailing the new person: lead with the first person's name in the first sentence",
      "Closing the loop: tell the first person how the conversation went, now it has happened",
      "A redirect is a real favor; treating it as a rejection is the most common mistake",
    ],
    maxWords: 150,
    fields: [
      {
        name: "redirectStep",
        label: "Which email is this?",
        kind: "select",
        options: [
          { value: "thank", label: "Thanking the person who redirected me" },
          { value: "new_person", label: "Emailing the person they pointed me to" },
          { value: "close_loop", label: "Telling the first person how it went" },
        ],
        prompt: "Which email in the redirect sequence this is",
      },
      {
        name: "firstPerson",
        label: "Who sent you to this person",
        hint: "The person you emailed first, who pointed you here instead.",
        placeholder: "e.g. Marcus Delacroix",
        kind: "text",
        required: true,
        prompt: "The person who redirected the student",
      },
      {
        name: "newPerson",
        label: "Who they sent you to",
        placeholder: "e.g. Dorothy on the founder-owned team",
        kind: "text",
        required: true,
        prompt: "The person the student was pointed to",
      },
      {
        name: "redirectDetail",
        label: "Why they sent you to that person",
        placeholder: "e.g. she's better placed to talk about founder-owned businesses",
        kind: "textarea",
        prompt: "Why the student was redirected, or (for closing the loop) what came of the conversation",
      },
    ],
    promptNotes: [
      "Thanking the first person: thank them for the redirect specifically, and ask whether they'd rather introduce the student or have the student write directly.",
      "Emailing the new person: lead with the first person's name in the first sentence and why they pointed the student here, then the usual introduction, a 10-minute ask and the attached resume.",
      "Closing the loop: say the conversation happened and, when THIS EMAIL says what came of it, one specific thing that came of it. With nothing given, say plainly that the conversation was worth having and leave it there - never a bracketed marker where the specific thing would go, because the sentence reads perfectly without one. No new ask.",
    ],
  },
  {
    id: "coffee_in_person_reply",
    label: "Reply when they suggest coffee",
    group: "After they reply",
    dbKind: "custom",
    repliesInThread: true,
    timing: "Within a few hours - and pick a spot near their office, not yours.",
    format: [
      "Thank them and accept warmly",
      "If they named a place and time: confirm both exactly as THIS EMAIL gives them, and stop there",
      "If they did not: offer the days and times THIS EMAIL gives, suggest the spot it gives near their office, and offer to go wherever is easiest for them - never invent a cafe, a street or a day",
      "Say how long you expect to take, so they can plan",
      "Give your phone number in case of a change on the day",
      "Thank them and sign off",
    ],
    maxWords: 110,
    fields: [
      {
        name: "coffeeNamed",
        label: "Did they name a place and time?",
        kind: "select",
        options: [
          { value: "no", label: "No - I'll suggest" },
          { value: "yes", label: "Yes - I'm confirming" },
        ],
        prompt: "Whether the recipient named a place and time",
      },
      {
        name: "coffeePlaceTime",
        showWhen: { field: "coffeeNamed", is: ["yes"] },
        label: "The place and time they named",
        placeholder: "e.g. Thursday at 8:30 at the cafe in their lobby",
        kind: "text",
        prompt: "The place and time the recipient named - confirm it exactly",
      },
      {
        name: "coffeeDays",
        showWhen: { field: "coffeeNamed", is: ["no"] },
        label: "Days and times you're free",
        placeholder: "e.g. Tuesday to Thursday next week before 3",
        kind: "text",
        prompt: "The student's available days and times, exactly as given",
      },
      {
        name: "coffeeSpot",
        showWhen: { field: "coffeeNamed", is: ["no"] },
        label: "A spot near their office",
        placeholder: "e.g. Marlow Coffee on Chandler Street",
        kind: "text",
        prompt: "A place near the recipient's office the student suggests",
      },
    ],
    promptNotes: [
      "If they named a place and time, confirm it exactly and stop. Otherwise offer the student's days and suggest the spot given, offering to go wherever is easiest.",
      "Plan on about 30 minutes, and say so.",
      "Give the student's phone number from STUDENT (the signature lines or contact details) in the body for day-of changes. If there's no phone number, leave that sentence out - never a placeholder.",
      "Use only the days and places given. Never invent a cafe, street or date.",
    ],
  },

  // ------------------------------------------------ after a conversation ----
  {
    id: "thank_you_chat",
    label: "Thank-you after a coffee chat",
    group: "After a conversation",
    dbKind: "thank_you",
    timing: "Send 2-3 hours after the chat or call.",
    format: [
      "Thank them for meeting with you",
      "Mention something specific from the conversation that you appreciated",
      "Say your interest has grown, and ask about next steps only if THIS EMAIL names an ask",
      "If THIS EMAIL asks for one: ask whether you should talk to anyone else, or for a specific introduction. With no ask, end on the thanks and ask for nothing",
      "Thank them again, then sign off",
      "The specific detail is what separates this from every other thank-you note they get. " + TONE_NOTE,
    ],
    maxWords: 110,
    promptNotes: [
      "If the advice was discouraging or blunt, thank them for the honesty and say what the student takes from it. Never sound wounded.",
      "If the chat ran long or turned personal, acknowledge it lightly and without dwelling.",
    ],
  },
  {
    id: "thank_you_offered_help",
    label: "Thank-you when they offered to help",
    group: "After a conversation",
    dbKind: "thank_you",
    attachResumeIfMentioned: true,
    timing: "Send within 2-3 hours, while the offer is still fresh in their mind.",
    format: [
      "Thank them for the conversation and reference one specific thing from it",
      "If they offered something: thank them for that specific offer, in their own terms, and make it easy to act on - say the resume is attached, or include a short blurb they can forward",
      "If they offered nothing: say plainly you aren't asking for anything else, and don't attach or mention the resume",
      "Don't add a second ask on top of the one they volunteered",
      "Thank them again, then sign off",
      "Attach the resume only if they asked for it. If they offered an introduction, write the blurb for them. Never follow up on this in under a week",
    ],
    maxWords: 150,
    fields: [
      {
        name: "offerType",
        label: "What did they offer?",
        kind: "select",
        options: [
          { value: "resume", label: "To pass my resume along" },
          { value: "flag", label: "To flag me to their recruiting team" },
          { value: "intro", label: "To introduce me to someone" },
          { value: "none", label: "Nothing - the chat went as far as it will" },
        ],
        prompt: "What the recipient offered",
      },
      {
        name: "conversationDetail",
        label: "Something specific from the conversation",
        placeholder: "e.g. following the customer rather than the sector",
        kind: "textarea",
        required: true,
        prompt: "A specific thing from the conversation",
      },
      {
        name: "introTarget",
        showWhen: { field: "offerType", is: ["intro"] },
        label: "Who they offered to introduce you to",
        hint: "Only for an introduction.",
        placeholder: "e.g. Nathaniel on their team",
        kind: "text",
        prompt: "Who the recipient offered to introduce the student to",
      },
      {
        name: "applicationRef",
        showWhen: { field: "offerType", is: ["resume", "flag"] },
        label: "Your application or requisition #",
        hint: "If you've already applied.",
        placeholder: "e.g. applied Monday under req #22140",
        kind: "text",
        prompt: "The student's application or requisition number",
      },
    ],
    promptNotes: [
      "Thank them for exactly what they offered, in their terms. Never add a second ask.",
      "If they offered to pass along the resume or flag the student, say the resume is attached so it's easy to forward.",
      "If they offered an introduction, include a three-sentence blurb in quotation marks, in the third person using the student's name (never \"he\" or \"she\"), that they can paste as-is - built only from facts in STUDENT and the resume - and say the resume is attached.",
      "If they offered nothing, say plainly the student isn't asking for anything else, and don't attach or mention the resume.",
    ],
  },
  {
    id: "thank_you_event",
    label: "Thank-you after an info session or event",
    group: "After a conversation",
    dbKind: "thank_you",
    timing: "Send that same evening or the next morning, before they've left campus or moved on.",
    format: [
      "Thank them for hosting the session or for coming to campus",
      "Name the specific session so they can place it: the date, the club, and the location",
      "Reference a specific point from their remarks that stuck with you",
      "Say how it affected your interest in the firm or the role",
      "Ask one small follow-up question, ask for a short call, or none at all - whichever THIS EMAIL names",
      "Thank them again, then sign off",
      "Everyone heard the same session, so the specific detail is what makes you memorable. If you asked a question, remind them of it. One short paragraph, plus the ask when there is one. " + TONE_NOTE,
    ],
    maxWords: 130,
    fields: [
      {
        name: "eventName",
        label: "The talk or event",
        hint: "Club or firm, day and place, so they can place it.",
        placeholder: "e.g. the Halcombe info session at Calloway Hall, Wednesday evening",
        kind: "text",
        required: true,
        prompt: "The session - name it so they can place it",
      },
      {
        name: "remarkPoint",
        label: "A point from their remarks that stuck with you",
        placeholder: "e.g. analysts who succeed ask a question twice rather than guess once",
        kind: "textarea",
        required: true,
        prompt: "The specific point from their remarks that stuck with the student",
      },
      {
        name: "yourQuestion",
        label: "A question you asked during it",
        hint: "They'll remember the question before the name.",
        placeholder: "e.g. how small their deal teams are",
        kind: "text",
        prompt: "A question the student asked during the session - remind them of it",
      },
      {
        name: "eventAsk",
        label: "What to ask for",
        kind: "select",
        options: [
          { value: "call", label: "A short call" },
          { value: "who_else", label: "Who else I should talk to" },
          { value: "none", label: "Nothing, just thanks" },
        ],
        prompt: "What to ask for at the end",
      },
    ],
    promptNotes: [
      "Name the session so they can place it: the club or firm, the day, the place.",
      "Everyone in the room heard the same talk, so the specific point from their remarks is what makes the student memorable.",
      "Keep it to one short paragraph plus the ask.",
      "With nothing to ask, say plainly the student just wanted to say thank you, and end there.",
      "If the day or place isn't given, name the session without them - no placeholders.",
    ],
  },
  {
    id: "keep_in_touch",
    label: "Keeping in touch",
    group: "After a conversation",
    dbKind: "custom",
    timing: "Send 2-3 months after your conversation, or any time you have a real update worth sharing.",
    format: [
      "Reference your previous conversation and roughly when it happened",
      "Give a specific update on yourself since then (a role, a class, a club, a project)",
      "Tie the update back to a piece of advice they gave you",
      "Add a short note about them: congratulate them on news, or ask one light question",
      "Offer to catch up on a short call and NAME THE LENGTH - 10 or 15 minutes, which is what every example below does - with no pressure if they are busy. A call offer with no number in it reads as nothing to answer, and a number turns it into a question with a yes available",
      "Thank them for the time they gave you originally, then sign off",
      "Shorter than your original cold email. Don't ask for a referral; the goal is simply to stay on their radar. " + TONE_NOTE,
    ],
    maxWords: 150,
    fields: [
      {
        name: "lastSpoke",
        label: "When you last spoke, and about what",
        placeholder: "e.g. October, about his path onto the long/short team",
        kind: "text",
        required: true,
        prompt: "When they last spoke, and what about",
      },
      {
        name: "updateSince",
        label: "Your update since then",
        placeholder: "e.g. accepted a summer analyst role on a consumer coverage team",
        kind: "textarea",
        required: true,
        prompt: "The student's update since then",
      },
      {
        name: "adviceFollowed",
        label: "Advice of theirs you acted on",
        placeholder: "e.g. started keeping a weekly pitch journal",
        kind: "textarea",
        prompt: "Advice the recipient gave that the student acted on - tie the update back to it",
      },
      {
        name: "theirNews",
        label: "News of theirs to mention",
        hint: "Congratulate them, or ask one light question.",
        placeholder: "e.g. their firm opened a Denver office",
        kind: "text",
        prompt: "News about the recipient to congratulate them on, or ask one light question about",
      },
    ],
    promptNotes: [
      "Shorter than the original cold email.",
      "Never ask for a referral: the goal is simply to stay on their radar.",
    ],
  },
  {
    id: "close_loop_referrer",
    label: "Closing the loop with a referrer",
    group: "After a conversation",
    dbKind: "custom",
    timing: "Send within a day of the call happening, and again whenever there's an outcome.",
    format: [
      "Thank them again for the introduction",
      "Confirm that the call happened, and when",
      "Share one specific thing you learned, so they can see the introduction was used well",
      "Say what happens next for you",
      "Thank them, then sign off",
      "The only goal is making them feel their help mattered. Never ask for another introduction in the same email. Four or five sentences at most",
    ],
    maxWords: 110,
    fields: [
      {
        name: "introducedTo",
        label: "Who they introduced you to",
        placeholder: "e.g. Elias on the consumer team",
        kind: "text",
        required: true,
        prompt: "The person the referrer introduced the student to",
      },
      {
        name: "loopStage",
        label: "How did the introduction go?",
        kind: "select",
        options: [
          { value: "call", label: "We just had the call" },
          { value: "interview", label: "It turned into an interview" },
          { value: "offer", label: "I got the offer" },
          { value: "no", label: "It didn't work out" },
        ],
        prompt: "Where things stand",
      },
      {
        name: "learnedOrUpdate",
        label: "What came of the introduction",
        hint: "One thing you learned from the person they introduced you to, or how it turned out.",
        placeholder: "e.g. his point about passing on brands tied to one retailer",
        kind: "textarea",
        required: true,
        prompt: "One specific thing the student learned, or the details of the update",
      },
      {
        name: "nextForYou",
        label: "What happens next for you",
        placeholder: "e.g. applying to the summer program this week",
        kind: "text",
        prompt: "What happens next for the student",
      },
    ],
    promptNotes: [
      // Split from one note: the first half sets this email's purpose and gives
      // way to the lead's when this is a secondary box, while the prohibition
      // has to survive - nothing in any lead replaces it (LOGIC-3 F7).
      "The goal is to make the referrer feel their help mattered, and nothing else.",
      "Never ask for anything.",
      "Never ask for another introduction.",
      "Even when it didn't work out, thank them warmly and say what the conversation was still worth.",
      "Four or five sentences at most.",
    ],
  },
  {
    id: "referral_ask",
    label: "Asking a contact for a referral",
    group: "After a conversation",
    dbKind: "custom",
    attachResumeIfMentioned: true,
    timing: "Only after at least one good conversation, ideally two, and close enough to a deadline that the ask is concrete.",
    format: [
      "Reference your past conversations specifically",
      "Say you've applied, or are about to, naming the role and requisition number",
      "Ask directly but lightly whether they'd feel comfortable referring you or passing your resume along",
      "For a first ask, make it easy: say the resume is attached and include a two-line summary they can forward. On the one follow-up after they said yes, no summary and no mention of the resume",
      "Give them a clear, graceful way to say no",
      "Thank them, then sign off",
      "Never ask someone you've only cold emailed. It's too early if you haven't spoken, if the chat was under ten minutes, or if you can't name something specific they told you. If they say yes and it goes quiet, follow up once after a week, never twice",
    ],
    maxWords: 170,
    fields: [
      {
        name: "askStage",
        label: "Which email is this?",
        kind: "select",
        options: [
          { value: "first", label: "Asking for the first time" },
          { value: "followup", label: "The one follow-up after they said yes" },
          { value: "other_firm", label: "Asking them to connect me at a different firm" },
        ],
        prompt: "Whether this is the ask itself or the single follow-up after they agreed",
      },
      {
        name: "pastConversations",
        label: "Your past conversations with this person",
        hint: "When, and something specific they told you.",
        placeholder: "e.g. two chats this fall; she walked me through how her team thinks about founder-owned brands",
        kind: "textarea",
        required: true,
        prompt: "The student's past conversations with this person",
      },
      {
        name: "roleAndReq",
        label: "Role and requisition #",
        placeholder: "e.g. 2028 Summer Analyst Program, req #31894, applied yesterday",
        kind: "text",
        required: true,
        prompt: "The role, requisition number and when the student applied",
      },
      {
        name: "threadSubject",
        showWhen: { field: "askStage", is: ["followup"] },
        label: "Subject of your first ask",
        hint: "Only for the follow-up.",
        placeholder: "e.g. A Question About the Summer Program",
        kind: "text",
        prompt: "Subject of the original ask (the follow-up replies in that thread)",
      },
    ],
    promptNotes: [
      "This email type is the exception to the no-referral rule: asking for a referral or resume forward is the point.",
      "For the first ask: reference the past conversations specifically, name the role and requisition number, ask directly but lightly, say the resume is attached, include a two-line summary in quotation marks in the third person, using the student's name rather than a guessed pronoun, built only from facts in STUDENT and the resume, and give a graceful, costless way to say no.",
      "For the follow-up after they said yes: check in gently, once, with no urgency and an easy out. No new pitch, no summary, and don't mention the resume.",
      "For a connection at a different firm: say plainly that it's a different firm and their own name is involved, name the person or team they mentioned, include a forwardable blurb (the student's name, never a guessed pronoun) and the resume, and make a no cost nothing.",
    ],
  },

  {
    id: "thank_you_recruiter_session",
    label: "Thank-you to a recruiter who ran a session",
    group: "After a conversation",
    dbKind: "thank_you",
    timing: "The same evening or the next morning.",
    format: [
      "Thank them for running the session, not just for attending it",
      "Reference a specific thing they explained",
      "Ask at most one follow-up question, or none at all",
      "Thank them again and sign off",
      "Recruiters organize these and are thanked far less often than the speakers. Four or five sentences",
    ],
    maxWords: 110,
    fields: [
      {
        name: "sessionName",
        label: "The session",
        placeholder: "e.g. the Halyard Point information session at Kirkwood last night",
        kind: "text",
        required: true,
        prompt: "The session the recruiter ran",
      },
      {
        name: "recruiterExplained",
        label: "Something they explained about recruiting",
        placeholder: "e.g. how an application actually moves once it's submitted",
        kind: "textarea",
        required: true,
        prompt: "A specific thing the recruiter explained",
      },
      {
        name: "oneQuestion",
        label: "One question (optional)",
        placeholder: "e.g. is the career office resume drop the same pipeline as the portal?",
        kind: "text",
        prompt: "The one follow-up question to ask, if any",
      },
    ],
    promptNotes: [
      "Thank them for organizing or running it, which takes real work.",
      "At most one question. With no question, say plainly the student just wanted to say thank you.",
    ],
  },
  {
    id: "second_conversation",
    label: "Asking for a second conversation",
    group: "After a conversation",
    dbKind: "custom",
    timing: "At least six weeks after the first call, or right before an application deadline.",
    format: [
      "Reference the first conversation and roughly when it happened",
      "Say specifically what you did with their advice - that's what earns the second call",
      "Ask for 15 minutes. Say why now rather than later only when THIS EMAIL gives a reason - with none given, ask for the 15 minutes plainly rather than inventing an urgency the student did not describe, and never reach for a vague one (\"where my approach could be sharper\") to fill the gap",
      "Leave the timing to them, in wording built from this email rather than a stock courtesy line, and thank them",
      "Don't ask again if you did nothing with the first conversation",
    ],
    maxWords: 140,
    fields: [
      {
        name: "firstTalk",
        label: "When you first spoke, and their advice",
        placeholder: "e.g. early September; he said to start writing up two companies a month",
        kind: "textarea",
        required: true,
        prompt: "When they first spoke and the advice the recipient gave",
      },
      {
        name: "whatYouDid",
        label: "What you did with their advice",
        // The example is the instruction here. "I have four write-ups now" is a
        // COUNT, and a count is what the model gets back: a sparse student
        // answered "tracking 3 brands now" and the recipient's verdict was
        // "doesn't tell me which brands or give me anything to react to"
        // (scenario 822, audit-probe/sweep87-2026-10-12). So the example now
        // names the things and lands a conclusion, which is the shape the
        // format's step 2 asks for and the recipient can actually answer.
        //
        // REASONED, NOT MEASURED: the simulation's answers are fixed in
        // scripts/draft-occasions-sim.ts and are not drawn from placeholders,
        // so no rig here can see this change. It shows up only with real
        // students.
        placeholder: "e.g. four write-ups now - Costco, Dollar General, Target and TJX; the margin story surprised me most",
        kind: "textarea",
        required: true,
        prompt: "What the student actually did with the advice",
      },
      {
        name: "whyNow",
        label: "Why you're asking now",
        placeholder: "e.g. the application closes October 30",
        kind: "text",
        prompt: "Why the student is asking now",
      },
    ],
    promptNotes: [
      "Showing what the student did with the advice is the whole argument. Say it specifically.",
      "Keep the ask short: 15 minutes, and why now.",
    ],
  },
  {
    id: "congratulations",
    label: "Congratulating a contact (no ask)",
    group: "After a conversation",
    dbKind: "custom",
    timing: "Within a few days of the news, whenever you happen to see it.",
    format: [
      "Name the specific news and how you came across it",
      "Say one genuine sentence about why it makes sense or why you were glad to see it",
      "Add a brief line of your own news only if there is one",
      "Don't ask for anything",
      "Sign off",
      "The whole value is the absence of an ask. Three or four sentences",
    ],
    maxWords: 90,
    fields: [
      {
        name: "theirNews",
        label: "Their news",
        placeholder: "e.g. promoted to Vice President",
        kind: "text",
        required: true,
        prompt: "The recipient's news",
      },
      {
        name: "whereSaw",
        label: "Where you saw their news",
        placeholder: "e.g. LinkedIn this morning",
        kind: "text",
        required: true,
        prompt: "Where the student saw the news",
      },
      {
        name: "whyFits",
        label: "Why their news makes sense to you",
        hint: "Something you actually saw or heard from them.",
        placeholder: "e.g. watching him run a deal process while fielding intern questions",
        kind: "textarea",
        prompt: "A genuine reason it fits, from what the student actually saw or heard",
      },
      {
        name: "ownNews",
        label: "Your own news (optional, one line)",
        placeholder: "e.g. I start my internship in June",
        kind: "text",
        prompt: "The student's own news, in one sentence",
      },
    ],
    promptNotes: [
      // Split from one note: the prohibition survives as a secondary box, the
      // length gives way to the lead's format (LOGIC-3 F7).
      "No ask of any kind, including \"let me know if you have time\".",
      "Three or four sentences.",
      "Only reference past interactions the student described. With no reason given, keep the congratulations simple rather than inventing one.",
    ],
  },

  // ---------------------------------------------------------- interviews ----
  {
    id: "thank_you_interview",
    label: "Thank-you after an interview",
    group: "Interviews",
    dbKind: "thank_you",
    timing: "Send 2-3 hours after the interview.",
    format: [
      "Thank them for the interview opportunity",
      "Mention something specific from the interview - bonus if it connects to you",
      "Say your interest in the firm or team has only grown",
      "Offer anything else they need and ask about next steps",
      "Thank them again, then sign off",
      "Never send two interviewers the same note - use the superday type when you met several people. " + TONE_NOTE,
    ],
    maxWords: 130,
    fields: [
      {
        name: "clarification",
        label: "Something to clarify (optional)",
        hint: "One line if an answer went badly. Once.",
        placeholder: "e.g. I muddled the discount rate question",
        kind: "textarea",
        prompt: "An answer the student wants to clarify - one short clarification, then stop",
      },
    ],
    promptNotes: [
      "If there's a clarification, add it in one or two sentences, then say that's all and move on. Never relitigate or sound wounded.",
      "If sponsorship came up, confirm the status in one clear line, only if the student mentioned it.",
    ],
  },
  {
    id: "thank_you_superday",
    label: "Thank-you after a superday (one per interviewer)",
    group: "Interviews",
    dbKind: "thank_you",
    timing: "Send 2-3 hours after the day ends. Draft a separate note for each interviewer.",
    format: [
      "Thank them for their specific interview, not for the day in general",
      "Reference a detail that only came up in that conversation",
      "Say your interest has grown, and why, in a way that matches what you discussed",
      "Ask about next steps, or say you look forward to hearing about them",
      "Thank them again, then sign off",
      "Interviewers compare notes, and identical emails are obvious. Write down one detail after each round",
    ],
    maxWords: 110,
    fields: [
      {
        name: "whenInterviewed",
        label: "When you met this interviewer",
        placeholder: "e.g. this morning",
        kind: "text",
        prompt: "When the student met this interviewer",
      },
      {
        name: "onlyDetail",
        label: "A detail that only came up with them",
        placeholder: "e.g. working through a brand whose growth came from one retailer",
        kind: "textarea",
        required: true,
        prompt: "A detail that only came up in this interviewer's conversation",
      },
      {
        name: "secondInterviewer",
        label: "Anyone else in the room",
        placeholder: "e.g. Owen",
        kind: "text",
        prompt: "A second interviewer in the room - ask this interviewer to pass thanks to them by name",
      },
      {
        name: "meetingLength",
        label: "How long did you meet?",
        kind: "select",
        options: [
          { value: "interview", label: "A full interview" },
          { value: "brief", label: "Briefly (a lunch or short chat)" },
        ],
        prompt: "Whether it was a full interview or a brief meeting",
      },
      {
        name: "otherNotes",
        label: "What your other notes already said",
        hint: "So this one doesn't repeat them.",
        placeholder: "e.g. thanked Elias for the customer concentration case",
        kind: "textarea",
        prompt: "What the student's notes to other interviewers from the same day already covered - use a different detail and angle",
      },
    ],
    promptNotes: [
      "Thank them for their own interview, never for the day in general.",
      "Build the note around the detail that only came up with this interviewer, and say why interest grew in a way that matches it.",
      "If other notes are described, make this one clearly different in detail, angle and wording.",
      "If someone else was in the room, address this interviewer and ask them to pass thanks to the other by name.",
      "For a brief meeting like a lunch, write about three sentences, and don't manufacture a big moment or a paragraph about the firm.",
    ],
  },
  {
    id: "thank_you_phone_screen",
    label: "Thank-you after a recruiter phone screen",
    group: "Interviews",
    dbKind: "thank_you",
    timing: "Send within 2-3 hours; keep it shorter than an interview thank-you.",
    format: [
      "Thank them for the call and for walking you through the process",
      "Reference one thing they explained that was genuinely useful",
      "Restate your interest in one sentence",
      "Confirm the next step and the date, so you both have it in writing",
      "Thank them again, then sign off",
      "A recruiter screen is mostly logistics, so keep this brief. " + TONE_NOTE,
    ],
    maxWords: 115,
    fields: [
      {
        name: "usefulExplanation",
        label: "Something useful they explained",
        placeholder: "e.g. how the group assigns its summer class",
        kind: "textarea",
        required: true,
        prompt: "One thing the recruiter explained that was genuinely useful",
      },
      {
        name: "stillUnclear",
        label: "Anything still unclear",
        placeholder: "e.g. the time and whether it's Zoom",
        kind: "text",
        prompt: "A detail about the next step that's still unclear - ask for it in this email",
      },
      {
        name: "redirected",
        label: "Did they redirect you to another group?",
        kind: "select",
        options: [
          { value: "no", label: "No" },
          { value: "yes", label: "Yes" },
        ],
        prompt: "Whether the recruiter redirected the student to a different group",
      },
      {
        name: "nextStep",
        label: "The next step and date",
        hint: "Leave blank if nothing is scheduled yet.",
        placeholder: "e.g. first round Tuesday, October 20 at 11:00 a.m. ET",
        kind: "text",
        prompt: "The confirmed next step - repeat it back in writing with the date and time zone",
      },
    ],
    promptNotes: [
      "Brief: a screen is mostly logistics.",
      "If a next step is given, confirm it in writing with the date and time zone. If not, ask to be kept posted on scheduling.",
      "If a date is known but the time or format isn't, confirm the date and ask for the rest in this email rather than waiting.",
      "If they redirected the student to a different group, say plainly that the redirect was useful - recruiters rarely get thanked for that.",
    ],
  },
  {
    id: "recorded_round_note",
    label: "Note after a recorded or virtual round",
    group: "Interviews",
    dbKind: "thank_you",
    timing: "Send the same day, to the recruiter, since there's usually no interviewer to write to.",
    format: [
      "Confirm that you completed the round and when",
      "If THIS EMAIL describes the content, reference it lightly, since there was no conversation to draw on",
      "Restate your interest",
      "Ask what happens next and by when",
      "Thank them, then sign off",
      "No rapport to build, so four or five sentences. Don't critique the format",
    ],
    maxWords: 110,
    fields: [
      {
        name: "roundType",
        label: "What kind of round?",
        kind: "select",
        options: [
          { value: "recorded", label: "A recorded video interview" },
          { value: "live_unnamed", label: "A live virtual round (didn't catch the interviewer's name)" },
          { value: "timed_test", label: "A timed online test" },
        ],
        prompt: "The kind of round",
      },
      {
        name: "completedWhen",
        label: "When you completed it",
        placeholder: "e.g. this evening, ahead of Friday's deadline",
        kind: "text",
        required: true,
        prompt: "When the student completed the round",
      },
      {
        name: "roundContent",
        label: "What the questions focused on",
        placeholder: "e.g. how I work with other people",
        kind: "text",
        prompt: "What the questions focused on - reference it lightly",
      },
    ],
    promptNotes: [
      "Written to the recruiter. Four or five sentences, and never critique the format.",
      "Ask what the next step is and when candidates can expect to hear.",
      "For a live round where the interviewer's name wasn't caught, write to the recruiter, say so plainly, and ask them to pass thanks along. For a timed test, ask them to confirm the file came through.",
    ],
  },

  {
    id: "withdraw_process",
    label: "Declining an interview or withdrawing",
    group: "Interviews",
    dbKind: "custom",
    timing: "The moment you know - every day you wait is a day someone else doesn't get the slot.",
    format: [
      "Thank them for the invitation or the process so far",
      "Withdraw clearly in the first two lines",
      "Give a short, honest reason without over-explaining",
      "Apologize for the timing if it's late",
      "Ask to stay in touch where it's genuine",
      "Thank them and sign off",
      "If an exam genuinely can't move, ask whether another slot exists before withdrawing. Never withdraw by not showing up",
    ],
    maxWords: 130,
    fields: [
      {
        name: "withdrawSituation",
        label: "What's happening?",
        kind: "select",
        options: [
          { value: "accepted", label: "I accepted an offer elsewhere" },
          { value: "conflict", label: "A conflict I can't move" },
          { value: "other", label: "Another reason" },
        ],
        prompt: "Why the student is withdrawing",
      },
      {
        name: "processStage",
        label: "The role, and where you are in it",
        placeholder: "e.g. summer associate process, final round next week",
        kind: "text",
        required: true,
        prompt: "The role and the stage of the process",
      },
      {
        name: "withdrawDetail",
        label: "The details",
        placeholder: "e.g. my econ final is the same morning and the university won't move it",
        kind: "textarea",
        prompt: "The specific reason or conflict",
      },
    ],
    promptNotes: [
      "Accepted elsewhere: withdraw in the first two lines, say it now so someone else gets the slot, thank them for the process.",
      "A conflict that can't move: explain it plainly, ask whether a different slot or day exists, and say the student will withdraw rather than hold a place if not.",
      "Short, honest, no over-explaining.",
    ],
  },

  // ------------------------------------------------ offers & decisions ----
  {
    id: "after_rejection",
    label: "After a rejection",
    group: "Offers & decisions",
    dbKind: "custom",
    timing: "Send within a day of receiving the decision.",
    format: [
      "Thank them for their time and for letting you know",
      "Accept the decision gracefully; don't argue it or ask them to reconsider",
      "Name one specific thing you took away from the process",
      "Ask lightly for feedback, in a way that's easy for them to decline",
      "Ask whether you may stay in touch and reapply in a future cycle",
      "Thank them again, then sign off",
      "Four or five sentences. To an inbox, keep it formal; to people who spent a day with you, name them. This email is often why a firm interviews you again the next year. Disappointment is fine, resentment is not",
    ],
    maxWords: 125,
    fields: [
      {
        name: "roleName",
        label: "Role and firm",
        placeholder: "e.g. Summer Analyst at Castlebrook Capital",
        kind: "text",
        required: true,
        prompt: "The role and firm",
      },
      {
        name: "takeaway",
        label: "One thing you took away",
        placeholder: "e.g. the case round was the first time I defended an assumption under pressure",
        kind: "textarea",
        required: true,
        prompt: "One specific thing the student took away from the process",
      },
      {
        name: "stageReached",
        label: "How far did you get?",
        kind: "select",
        options: [
          { value: "application", label: "My application" },
          { value: "first_round", label: "A first-round interview" },
          { value: "superday", label: "A superday or final round" },
        ],
        prompt: "How far the student got in the process",
      },
      {
        name: "peopleMet",
        label: "People to thank",
        hint: "After a superday, name who you met.",
        placeholder: "e.g. Elias and Rosa",
        kind: "text",
        prompt: "People the student met in the process, to thank by name",
      },
    ],
    promptNotes: [
      "Name the role once, in the first two sentences, so the note reads as about this process.",
      "Accept the decision gracefully; never argue it or ask them to reconsider.",
      "Ask for feedback lightly, in a way that is easy to decline, and ask to stay in touch and reapply in a future cycle.",
      "To a recruiting team, keep it formal and short and greet the team.",
      "Only after a superday or final round, be warmer, acknowledge the time several people gave, and thank the people named. Never mention a superday otherwise.",
      "Turn a self-critical takeaway into what the student is working on (\"I ramble\" becomes \"I am working on keeping my answers concise\").",
    ],
  },
  {
    id: "offer_extension",
    label: "Asking for an offer deadline extension",
    group: "Offers & decisions",
    dbKind: "custom",
    timing: "Send as soon as you know you need it, and well before the deadline itself.",
    format: [
      "Thank them and restate your excitement about the offer",
      "If this email is the ask: ask clearly for the specific new date THIS EMAIL gives, not \"a little more time\", give the short honest reason it gives, name the other firm only if it names one, and say plainly this is not a negotiating tactic and you aren't shopping the offer",
      "If this email replies to a no: accept it with no second attempt, confirm the original deadline in writing, and keep it short",
      "Thank them, then sign off",
      "Ask once; if they say no, accept it and decide by the original date. Name a date you actually need. Never imply the offer is a backup",
    ],
    maxWords: 145,
    fields: [
      {
        name: "extensionStage",
        label: "Which email is this?",
        kind: "select",
        options: [
          { value: "asking", label: "Asking for more time" },
          { value: "said_no", label: "They said no - I'm replying" },
        ],
        prompt: "Whether the student is asking for more time or replying to a no",
      },
      {
        name: "extensionAskee",
        label: "Who made the offer?",
        kind: "select",
        options: [
          { value: "recruiter", label: "A recruiter or recruiting team" },
          { value: "team_member", label: "Someone on the team" },
        ],
        prompt: "Whether the student is writing to a recruiter or to the team member who made the offer",
      },
      {
        name: "roleName",
        label: "Role and team",
        placeholder: "e.g. 2028 Summer Analyst, Infrastructure group",
        kind: "text",
        required: true,
        prompt: "The role and team of the offer",
      },
      {
        name: "currentDeadline",
        label: "Current deadline",
        placeholder: "e.g. October 9",
        kind: "text",
        required: true,
        prompt: "The current decision deadline",
      },
      {
        name: "requestedDate",
        showWhen: { field: "extensionStage", is: ["asking"] },
        label: "The date you're asking for",
        hint: "A date you actually need.",
        placeholder: "e.g. October 16",
        kind: "text",
        prompt: "The specific new date requested",
      },
      {
        name: "extensionReason",
        showWhen: { field: "extensionStage", is: ["asking"] },
        label: "Short, honest reason",
        placeholder: "e.g. the final stage of one other process ends that week",
        kind: "text",
        prompt: "The short, honest reason",
      },
      {
        name: "otherFirm",
        showWhen: { field: "extensionStage", is: ["asking"] },
        label: "The other firm, if you want to name it",
        hint: "Optional - it can build trust.",
        placeholder: "e.g. a final round with Talbot Ridge on October 16",
        kind: "text",
        prompt: "The other process, named - only mention the firm because the student chose to",
      },
    ],
    promptNotes: [
      "Ask clearly for the specific new date. Give the short reason, and name the other firm only if the student did.",
      "Say plainly this is not a negotiating tactic, the student isn't using the offer elsewhere or asking to change its terms, and they'll decide by the original deadline if it can't move.",
      "Never imply the offer is a backup. To a recruiting team, be more formal and greet the team.",
      "Replying to a no: thank them, accept it with no second attempt, and confirm the original deadline in writing. Short.",
      "Asking the team member who made the offer: acknowledge it may not be their decision, and offer to ask recruiting directly.",
      "This only works before the student has accepted. If the student says they already accepted, don't write an extension request; say in notesForStudent that an accepted offer should be honored.",
    ],
  },
  {
    id: "accept_offer",
    label: "Accepting an offer",
    group: "Offers & decisions",
    dbKind: "custom",
    timing: "Send as soon as you've decided, and within the deadline they gave you.",
    format: [
      "Thank them and state your excitement clearly",
      "Accept in a single unmistakable sentence, naming the role, the team, and the start date",
      "Confirm what you've already done with the paperwork and what's still outstanding",
      "Thank anyone who helped you along the way, by name, if there is someone",
      "Ask what you can do to prepare before you start",
      "Thank them again, then sign off",
      "If nobody helped you in, skip thanking rather than inventing a name. For a return offer, thank the team you worked with. Only accept when you're certain. " + TONE_NOTE,
    ],
    maxWords: 160,
    fields: [
      {
        name: "roleName",
        label: "Role and team",
        placeholder: "e.g. Summer Analyst, Castlebrook Capital investment team",
        kind: "text",
        required: true,
        prompt: "The role and team being accepted",
      },
      {
        name: "startDate",
        label: "Start date",
        placeholder: "e.g. June 1, 2028",
        kind: "text",
        required: true,
        prompt: "The start date",
      },
      {
        name: "returnOffer",
        label: "Is this a return offer?",
        kind: "select",
        options: [
          { value: "no", label: "No" },
          { value: "yes", label: "Yes - from where I interned" },
        ],
        prompt: "Whether this is a return offer after interning there",
      },
      {
        name: "acceptedOnCall",
        label: "Did you already accept on a call?",
        kind: "select",
        options: [
          { value: "no", label: "No - this is my acceptance" },
          { value: "yes", label: "Yes - confirming in writing" },
        ],
        prompt: "Whether the student already accepted verbally and is confirming in writing",
      },
      {
        name: "paperwork",
        label: "Paperwork done, and what's outstanding",
        placeholder: "e.g. signed the offer letter in the portal; background check done",
        kind: "textarea",
        prompt: "What paperwork the student has done and what is outstanding",
      },
      {
        name: "thankPeople",
        label: "People to thank, and why",
        hint: "Leave blank if there's nobody - it's skipped, not invented.",
        placeholder: "e.g. Sarah Chen, who introduced me to the firm",
        kind: "textarea",
        prompt: "People to thank by name, and why",
      },
    ],
    promptNotes: [
      "Accept in one unmistakable sentence naming the role, the team and the start date.",
      "Only mention paperwork the student says is done. Thank only people the student named. If none are named, don't invent any, and skip thanking individuals.",
      "For a return offer, the student thanks the recipient for the summer itself. If no names are given, one sentence thanking the team they worked with is enough.",
      "If the offer came from a recruiting team, greet the team.",
      "Confirming a verbal acceptance: say they accepted on the call and are putting it in writing, and repeat the role, team and start date. Leave no room to back out.",
      "Thank them for a summer only if the resume shows the student worked at this firm. If it doesn't, write it as a new offer and say in notesForStudent that the return-offer answer looked wrong.",
    ],
  },
  {
    id: "decline_offer",
    label: "Declining an offer",
    group: "Offers & decisions",
    dbKind: "custom",
    timing: "Send as soon as you've decided, so the spot can go to someone else.",
    format: [
      "Thank them sincerely and specifically for the offer and the process",
      "Decline clearly and early in the email; don't bury it in the last line",
      "Give a short, honest reason without over-explaining",
      "Say something genuine about the people you met, if THIS EMAIL names any - never invent a name",
      "Ask to stay in touch",
      "Thank them again, then sign off",
      "Never criticize the firm, the process, or anyone you met. Declining a return offer is the most delicate version. A paragraph or two. " + TONE_NOTE,
    ],
    maxWords: 145,
    fields: [
      {
        name: "roleName",
        label: "Role and firm",
        placeholder: "e.g. 2028 Summer Analyst Program at Dunleavy Securities",
        kind: "text",
        required: true,
        prompt: "The role and firm being declined",
      },
      {
        name: "declineReason",
        label: "Short, honest reason",
        placeholder: "e.g. chose a role closer to the investing side",
        kind: "text",
        required: true,
        prompt: "The student's short, honest reason",
      },
      {
        name: "returnOffer",
        label: "Is this a return offer?",
        kind: "select",
        options: [
          { value: "no", label: "No" },
          { value: "yes", label: "Yes - from where I interned" },
        ],
        prompt: "Whether this is a return offer from where the student interned",
      },
      {
        name: "thankPeople",
        label: "People you met to mention",
        placeholder: "e.g. Priscilla Hayes and Jake Abbott",
        kind: "textarea",
        prompt: "People the student met, to say something genuine about",
      },
    ],
    promptNotes: [
      "Decline clearly and early - never in the last line.",
      "Give a short, honest reason without over-explaining; don't name the other firm unless the student did.",
      "Never criticize the firm, the process or anyone they met.",
      "For a return offer, thank them for the summer itself and make clear the decision is about the path, not the team.",
      "If the reason is location or visa sponsorship, say so plainly as a practical reason, never blame the firm or its policy, and leave the door open.",
    ],
  },

  {
    id: "thank_helper_offer",
    label: "Thanking someone who helped you get the offer",
    group: "Offers & decisions",
    dbKind: "custom",
    timing: "Within a day of signing, and before you tell most other people.",
    format: [
      "Tell them the outcome directly",
      "Name specifically what they did and how it changed things",
      "Don't ask for anything",
      "Offer to be useful to them, or to the next student in your position",
      "Thank them and sign off",
      "People who help students rarely find out whether it worked. Thank the recruiter too",
    ],
    maxWords: 110,
    fields: [
      {
        name: "helperRole",
        label: "Who are you thanking?",
        kind: "select",
        options: [
          { value: "contact", label: "A contact who helped me" },
          { value: "recruiter", label: "The recruiter who ran the process" },
        ],
        prompt: "Whether the recipient is a contact or the recruiter",
      },
      {
        name: "offerSigned",
        label: "The offer",
        placeholder: "e.g. signed the summer analyst offer this morning",
        kind: "text",
        required: true,
        prompt: "The offer the student signed",
      },
      {
        name: "whatTheyDid",
        label: "What they did, and how it helped",
        placeholder: "e.g. told me to start writing up companies, which is how I answered the second-round question",
        kind: "textarea",
        required: true,
        prompt: "What the recipient did and how it changed things",
      },
    ],
    promptNotes: [
      "Lead with the outcome. Name exactly what they did and how it mattered.",
      "No ask. Offer to help the next student they send your way. For a recruiter, thank them for running the process.",
    ],
  },

  // ---------------------------------------------- recommendations & references ----
  {
    id: "professor_recommendation",
    label: "Asking a professor for a recommendation",
    group: "Recommendations & references",
    dbKind: "custom",
    attachResumeIfMentioned: true,
    timing: "At least three weeks before the deadline, and four if you can.",
    format: [
      "Greet them as \"Professor [Last name],\" never by first name",
      "Say which class you took, in which term, and how you did or what you worked on",
      "Name the program, the deadline, and exactly how the letter is submitted - each one only if THIS EMAIL gives it",
      "Ask directly whether they'd be comfortable writing a strong letter",
      "Offer to send your resume, application draft and talking points",
      "Give them an easy way to decline",
      "Thank them and sign off",
      "If the timeline is tight, say so in the first two lines. Send one reminder three days before the deadline, never more",
    ],
    maxWords: 190,
    fields: [
      {
        name: "courseTerm",
        label: "The class, and when",
        placeholder: "e.g. Corporate Finance, last spring",
        kind: "text",
        required: true,
        prompt: "The class the student took and the term",
      },
      {
        name: "courseWork",
        label: "How you did, or what you worked on",
        placeholder: "e.g. A minus; presented on the working capital case",
        kind: "text",
        required: true,
        prompt: "How the student did or what they worked on with the professor",
      },
      {
        name: "recProgram",
        label: "The program",
        placeholder: "e.g. Halyard Point Sophomore Insight Program",
        kind: "text",
        required: true,
        prompt: "The program the letter is for",
      },
      {
        name: "recDeadline",
        label: "The deadline",
        placeholder: "e.g. November 14",
        kind: "text",
        required: true,
        prompt: "The deadline - if it's under three weeks away, say so in the first two lines",
      },
      {
        name: "recSubmission",
        label: "How the letter is submitted",
        placeholder: "e.g. an online portal emails them a link",
        kind: "text",
        prompt: "How the letter is submitted",
      },
    ],
    promptNotes: [
      "Use the greeting given under RECIPIENT - \"Dear Professor [Last name],\" for a professor - and keep the letter formal.",
      "Ask whether they'd be comfortable writing a strong letter, and make a no easy.",
      "Offer to send the resume, application draft and talking points; if the resume is on file, say it's attached.",
    ],
  },
  {
    id: "reference_request",
    label: "Asking a former manager for a reference",
    group: "Recommendations & references",
    dbKind: "custom",
    timing: "Before you list them anywhere, and at least a week before anyone would call.",
    format: [
      "Open warmly and remind them of your role and the dates",
      "Reference one specific project you worked on together",
      "Say exactly what you're asking for: a phone reference, a written letter, or a LinkedIn recommendation",
      "Offer a few bullet points they can draw on",
      "Give the timeline and an easy way to decline",
      "Thank them and sign off",
      "Never list someone before asking. A manager outside finance can speak to reliability and judgment",
    ],
    maxWords: 180,
    fields: [
      {
        name: "referenceKind",
        label: "What are you asking for?",
        kind: "select",
        options: [
          { value: "phone", label: "A phone reference" },
          { value: "letter", label: "A written letter" },
          { value: "linkedin", label: "A LinkedIn recommendation" },
        ],
        prompt: "What the student is asking for",
      },
      {
        name: "roleWithThem",
        label: "Your role with them, and when",
        placeholder: "e.g. summer intern on her team, last summer",
        kind: "text",
        required: true,
        prompt: "The student's role with the recipient and when",
      },
      {
        name: "sharedProject",
        label: "A specific project",
        placeholder: "e.g. the industrials screening project",
        kind: "text",
        required: true,
        prompt: "A specific project they worked on together",
      },
      {
        name: "referenceBullets",
        label: "Things they could mention (one per line)",
        placeholder: "e.g. built the screening model\nran weekly call notes for six weeks",
        kind: "textarea",
        prompt: "Things the recipient could mention - put them in a short numbered list, exactly as given",
      },
      {
        name: "referenceTimeline",
        label: "Timeline",
        placeholder: "e.g. calls would come in November",
        kind: "text",
        prompt: "When the reference would be needed",
      },
    ],
    promptNotes: [
      "Say exactly what's being asked for and when. Make declining easy, and say the student won't list them if they'd rather not.",
      "If things to mention are given, put them in a short numbered list. Never invent accomplishments for the list.",
    ],
  },

  // ------------------------------------------------------------- other ----
  {
    id: "custom",
    label: "Something else",
    group: "Other",
    dbKind: "custom",
    timing: "Describe the situation and it will use the closest format.",
    format: ["Short, specific, one clear ask", TONE_NOTE],
    maxWords: 150,
  },
];

export function emailTypeById(id: string | null | undefined): EmailType | null {
  if (!id) return null;
  return EMAIL_TYPES.find((t) => t.id === id) ?? null;
}

/**
 * Does the email say a resume is attached? A sentence has to name the resume
 * (or CV, or résumé) and say attached or attaching - not "I haven't attached
 * it", "happy to attach it" or "I'd love to resume our conversation".
 */
export function mentionsAttachedResume(body: string): boolean {
  return body.split(/(?<=[.!?\n])\s*/).some((sentence) => {
    const resume = /(^|[^\p{L}])(r[eé]sum[eé]|cv)(?![\p{L}])(?!\s+(our|the|this|that|an?|where)\b)/iu.test(sentence);
    const attached = /\battach(ed|ing)\b/i.test(sentence);
    const negated = /\b(not|never|without|no)\b|n['’]t\b/i.test(sentence);
    return resume && attached && !negated;
  });
}

/**
 * Whether this draft is sent with the resume attached. Drafts from before types
 * existed have no type and fall back to their kind.
 */
export function draftAttachesResume(
  type: EmailType | null,
  kind: string,
  body: string,
): boolean {
  if (!type) return kind === "cold_outreach";
  // Any email that says the resume is attached gets it - a custom email or a
  // keep-in-touch update can say so as well as the types built around it.
  return Boolean(type.attachResume || mentionsAttachedResume(body));
}

const KIND_LABELS: Record<string, string> = {
  cold_outreach: "Cold email",
  custom: "Custom",
  follow_up: "Follow-up",
  thank_you: "Thank-you",
};

/** Drafts written before types existed carry an old template id; fall back to the kind. */
export function draftLabel(kind: string, templateId: string | null | undefined): string {
  return emailTypeById(templateId)?.label ?? KIND_LABELS[kind] ?? "Draft";
}

/**
 * The fields that apply given the student's other answers. A select's first
 * option counts as chosen until the student picks another, as in the form.
 */
export function activeFields(type: EmailType, valueOf: (name: string) => string | undefined): DraftField[] {
  const fields = type.fields ?? [];
  return fields.filter((f) => {
    if (!f.showWhen) return true;
    const controller = fields.find((c) => c.name === f.showWhen!.field);
    const current = valueOf(f.showWhen.field) || controller?.options?.[0]?.value || "";
    return f.showWhen.is.includes(current);
  });
}
