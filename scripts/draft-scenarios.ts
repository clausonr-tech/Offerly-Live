// Builds the exact draft prompts for a spread of realistic scenarios, without
// calling the API, so draft quality can be reviewed type by type.
//
//   npx tsx scripts/draft-scenarios.ts [outFile]          write every scenario's prompt
//   npx tsx scripts/draft-scenarios.ts check <drafts>     check drafts written for them
//
// A drafts file is "=== <id>" blocks: a "Subject:" line, then the body.
//
// Each scenario mirrors what the draft form and server action would send:
// type fields become labelled answers, outside recipients are typed-in
// contacts, and profiles vary (freshman, non-finance, transfer, grad student,
// incomplete profile, Gmail signature, no resume).

import { readFileSync, writeFileSync } from "node:fs";
import { activeFields, emailTypeById, type EmailTypeId } from "../src/lib/draft-templates";
import { buildDraftPrompt, finishDraft, signatureLines, type DraftBrief, type DraftPromptInput } from "../src/lib/draft-prompt";
import { fluencyIssues } from "../src/lib/draft-lint";
import { EMAIL_EXAMPLES } from "../src/lib/email-examples";
import { edgeScenarios } from "./draft-scenarios-edge";

const NOW = new Date("2026-09-20T12:00:00");

export type Student = Pick<
  DraftPromptInput,
  | "studentName"
  | "studentSchool"
  | "studentSchoolEmail"
  | "studentPhone"
  | "studentLinkedinUrl"
  | "studentResumeSummary"
  | "studentGradYear"
  | "studentMajor"
  | "studentHometown"
  | "studentInterests"
  | "studentClubs"
  | "studentTargetGroup"
  | "studentMotivations"
  | "studentSponsorship"
> & { resumeOnFile: boolean };

const MAYA: Student = {
  studentName: "Maya Okafor",
  studentSchool: "Duke University",
  studentSchoolEmail: "maya.okafor@duke.edu",
  studentPhone: "(919) 555-0142",
  studentLinkedinUrl: "https://www.linkedin.com/in/mayaokafor",
  studentGradYear: 2029,
  studentMajor: "Economics",
  studentHometown: "Atlanta, GA",
  studentInterests: "distance running, jazz piano",
  studentClubs: "Duke Investment Club",
  studentTargetGroup: "Investment banking, consumer and retail",
  studentResumeSummary: [
    "EDUCATION",
    "- Duke University · BA Economics, minor in Statistics",
    "- GPA: 3.84",
    "WORK EXPERIENCE",
    "- Pinecrest Wealth Partners · Summer Intern · Atlanta, GA · Jun 2026 - Aug 2026",
    "    - Built a screening model for 40 dividend stocks used in client portfolio reviews",
    "    - Prepared quarterly performance summaries for 12 client households",
    "CLUBS & ACTIVITIES",
    "- Duke Investment Club · Consumer sector analyst · Sep 2025 - Present",
    "    - Pitched a long position on a regional grocery chain to a 30-person group",
    "SKILLS",
    "- Excel, PowerPoint, Python",
  ].join("\n"),
  resumeOnFile: true,
};

const LEO: Student = {
  studentName: "Leo Park",
  studentSchool: "University of Michigan",
  studentSchoolEmail: "leopark@umich.edu",
  studentGradYear: 2030,
  studentMajor: "Undecided, leaning economics",
  studentClubs: "Michigan Finance Club",
  studentResumeSummary: [
    "EDUCATION",
    "- University of Michigan · Intended Economics",
    "WORK EXPERIENCE",
    "- Bursley Dining Hall · Student Staff · Ann Arbor, MI · Sep 2026 - Present",
    "CLUBS & ACTIVITIES",
    "- Michigan Finance Club · New member education program · Sep 2026 - Present",
    "    - Completed the eight-week accounting and valuation course",
  ].join("\n"),
  resumeOnFile: true,
};

const SOFIA: Student = {
  studentName: "Sofia Reyes",
  studentSchool: "Georgia Tech",
  studentSchoolEmail: "sreyes31@gatech.edu",
  studentPhone: "(404) 555-0199",
  studentGradYear: 2028,
  studentMajor: "Industrial Engineering",
  studentTargetGroup: "Private equity, industrials",
  studentResumeSummary: [
    "EDUCATION",
    "- Georgia Institute of Technology · BS Industrial Engineering",
    "WORK EXPERIENCE",
    "- Harlow Components · Supply Chain Intern · Dalton, GA · May 2026 - Aug 2026",
    "    - Cut raw-material stockouts 18% by rebuilding the reorder-point model for 300 parts",
    "CLUBS & ACTIVITIES",
    "- Georgia Tech Society of Women Engineers · Treasurer",
  ].join("\n"),
  resumeOnFile: true,
};

const DANIEL: Student = {
  studentName: "Daniel Kim",
  studentSchool: "UCLA",
  studentSchoolEmail: "dkim27@ucla.edu",
  studentPhone: "(310) 555-0107",
  studentGradYear: 2027,
  studentMajor: "Business Economics",
  studentHometown: "Fresno, CA",
  studentResumeSummary: [
    "EDUCATION",
    "- UCLA · BA Business Economics",
    "- Fresno City College · Transferred 2025",
    "WORK EXPERIENCE",
    "- Valley First Credit Union · Teller · Fresno, CA · 2023 - 2025",
    "    - Handled deposits and loan payment questions for 60+ members a day",
  ].join("\n"),
  resumeOnFile: true,
};

// A second-year MBA: graduation year looks like an undergraduate senior's.
const AISHA: Student = {
  studentName: "Aisha Rahman",
  studentSchool: "Northwestern University",
  studentSchoolEmail: "aisha.rahman@kellogg.northwestern.edu",
  studentGradYear: 2027,
  studentMajor: "MBA, Finance",
  studentResumeSummary: [
    "EDUCATION",
    "- Kellogg School of Management, Northwestern · MBA, Finance · 2027",
    "WORK EXPERIENCE",
    "- Brightline Health · Senior Operations Analyst · Chicago, IL · 2021 - 2025",
  ].join("\n"),
  resumeOnFile: true,
};

// Signed up, skipped everything: no school, no year, no resume.
const BARE: Student = {
  studentName: "Jordan Blake",
  resumeOnFile: false,
};

export type Scenario = {
  id: string;
  what: string;
  student: Student;
  type: EmailTypeId;
  recipient: Pick<
    DraftPromptInput,
    "contactName" | "contactFirm" | "contactRole" | "contactFirmDivisions" | "contactGroup" | "contactSchool" | "contactBackground" | "contactNotes"
  >;
  fields?: Record<string, string>;
  brief?: DraftBrief;
  purpose?: string;
  extraContext?: string;
  gmailSignature?: boolean;
  sameSchool?: boolean;
  /** Expectations for the adversarial runs: regex sources, case-insensitive, multiline. */
  must?: string[];
  mustNot?: string[];
  subjectMustNot?: string[];
  /** The draft should tell the student something (what it softened or refused). */
  note?: boolean;
  maxBodyWords?: number;
};

const BANK = ["Investment Banking", "Sales & Trading", "Asset & Wealth Management"];

const SCENARIOS: Scenario[] = [
  // ---------------------------------------------------------- cold emails
  {
    id: "01", what: "standard alum cold email", student: MAYA, type: "cold_email", sameSchool: true,
    recipient: { contactName: "Rachel Stein", contactFirm: "Morrow & Pike", contactRole: "Vice President", contactFirmDivisions: BANK, contactSchool: "Duke University" },
    brief: { financeInterest: "consumer and retail M&A", wantToLearn: "her path from Duke into consumer coverage" },
  },
  {
    id: "02", what: "freshman, lowercase unsure input, Gmail signature on", student: LEO, type: "cold_email", sameSchool: true, gmailSignature: true,
    recipient: { contactName: "Tom Alvarez", contactFirm: "Castellan Partners", contactRole: "Analyst", contactSchool: "University of Michigan" },
    brief: { financeInterest: "idk maybe banking? i like the numbers side" },
  },
  {
    id: "03", what: "engineer picks the alum type for someone who isn't an alum", student: SOFIA, type: "cold_email", sameSchool: false,
    recipient: { contactName: "Greg Hollis", contactFirm: "Ironbridge Capital", contactRole: "Associate", contactSchool: "Vanderbilt University" },
    brief: { financeInterest: "industrial private equity", wantToLearn: "how he picks which manufacturers to buy" },
  },
  {
    id: "04", what: "student types an explicit job ask", student: MAYA, type: "cold_email", sameSchool: true,
    recipient: { contactName: "Kevin Marsh", contactFirm: "Halsey Ridge Securities", contactRole: "Director", contactFirmDivisions: BANK, contactSchool: "Duke University" },
    purpose: "tell him i want an internship at his firm this summer and ask if he can get me an interview",
  },
  {
    id: "05", what: "met in person, talked about cars (the original complaint)", student: MAYA, type: "cold_after_meeting",
    recipient: { contactName: "Brian Castellano", contactFirm: "Ashford Lane Capital", contactRole: "Principal" },
    fields: { metAt: "the Duke Investment Club speaker night on Thursday", talkedAbout: "we talked about cars, he restores old Porsches", stuckWithYou: "that consumer deals come down to whether customers actually come back" },
    extraContext: "he said to email him",
  },
  {
    id: "06", what: "met at a career fair, thin detail, freshman", student: LEO, type: "cold_after_meeting",
    recipient: { contactName: "Priya Nair", contactFirm: "Wexford Bank", contactRole: "Campus Recruiter" },
    fields: { metAt: "career fair", talkedAbout: "her dog" },
  },
  {
    id: "07", what: "not an alum, engineer, specific why-them", student: SOFIA, type: "cold_not_alum",
    recipient: { contactName: "Marcus Lee", contactFirm: "Ironbridge Capital", contactRole: "Vice President", contactBackground: "Former plant manager at a steel company before business school" },
    fields: { howFound: "LinkedIn, searching for PE investors with operations backgrounds", whyThem: "he ran a steel plant before moving into PE" },
  },
  {
    id: "08", what: "outside contact with only name and firm, transfer student", student: DANIEL, type: "cold_not_alum",
    recipient: { contactName: "Linda Osei", contactFirm: "Sequoia Trust Bank" },
    fields: { howFound: "a podcast", whyThem: "her episode on how community banks compete with big banks" },
  },
  {
    id: "09", what: "freshman referral from the club president", student: LEO, type: "cold_referral",
    recipient: { contactName: "Nathan Cole", contactFirm: "Castellan Partners", contactRole: "Associate" },
    fields: { referrerName: "Emily Tran", referrerContext: "she's president of Michigan Finance Club and interned on his team" },
  },
  {
    id: "10", what: "informal family referral", student: MAYA, type: "cold_referral",
    recipient: { contactName: "Steve Duarte", contactFirm: "Beacon Hill Advisors", contactRole: "Managing Director" },
    fields: { referrerName: "my uncle Rob", referrerContext: "they golf together every weekend, rob said steve is super nice" },
  },
  {
    id: "11", what: "recruiting inbox, confirm application", student: MAYA, type: "recruiting_inbox",
    recipient: { contactName: "Morrow & Pike Campus Recruiting Team", contactFirm: "Morrow & Pike" },
    fields: { program: "2028 Summer Analyst, Investment Banking (Req #55120)", inboxContext: "applied september 10, no confirmation email", inboxQuestion: "can you confirm my application went through" },
  },
  {
    id: "12", what: "recruiting inbox, transfer eligibility question", student: DANIEL, type: "recruiting_inbox",
    recipient: { contactName: "Wexford Bank Early Careers", contactFirm: "Wexford Bank" },
    fields: { program: "2027 Full-Time Analyst Program", inboxContext: "I transferred from community college in 2025", inboxQuestion: "whether transfer students with 2 years at UCLA are eligible" },
  },
  // ------------------------------------------------------------ follow-ups
  {
    id: "13", what: "follow-up #1 built from an Offerly cold email", student: MAYA, type: "follow_up_1",
    recipient: { contactName: "Rachel Stein", contactFirm: "Morrow & Pike", contactRole: "Vice President" },
    brief: {
      originalSubject: "Duke Student Interested in Consumer Coverage",
      originalDate: "4 days ago",
      originalTypeLabel: "Cold email: alum",
      originalBody: "Hi Rachel,\n\nI hope this email finds you well! My name is Maya Okafor, and I am a sophomore at Duke studying economics...\n\nWould you have 10 minutes for a call?\n\nBest,\nMaya Okafor",
    },
  },
  {
    id: "14", what: "follow-up #1, manual, vague date and ask", student: SOFIA, type: "follow_up_1",
    recipient: { contactName: "Greg Hollis", contactFirm: "Ironbridge Capital" },
    brief: { originalSubject: "Advice", originalDate: "like a week ago?", originalAsk: "coffee chat" },
  },
  {
    id: "15", what: "follow-up #2 after a referral email", student: LEO, type: "follow_up_2",
    recipient: { contactName: "Nathan Cole", contactFirm: "Castellan Partners" },
    brief: { originalSubject: "Referred by Emily Tran", originalDate: "about 1 week ago", originalTypeLabel: "Cold email: referral", followUp1Date: "3 days ago" },
  },
  {
    id: "16", what: "follow-up #2, manual, Gmail signature", student: DANIEL, type: "follow_up_2", gmailSignature: true,
    recipient: { contactName: "Linda Osei", contactFirm: "Sequoia Trust Bank" },
    brief: { originalSubject: "Question About Your Community Banking Episode", originalAsk: "a 10 minute call about community banking" },
  },
  {
    id: "17", what: "recruiting inbox follow-up", student: MAYA, type: "recruiting_inbox_follow_up",
    recipient: { contactName: "Morrow & Pike Campus Recruiting Team", contactFirm: "Morrow & Pike" },
    fields: { threadSubject: "Duke ’29, 2028 Summer Analyst Application (Req #55120)", originalSent: "September 11", program: "2028 Summer Analyst, Investment Banking (Req #55120)", inboxQuestion: "confirm my application was received" },
  },
  {
    id: "18", what: "interview check-in, first, with thread", student: SOFIA, type: "interview_check_in",
    recipient: { contactName: "Janet Wu", contactFirm: "Ironbridge Capital", contactRole: "Vice President" },
    fields: { interviewRole: "Summer Associate, Industrials", interviewDate: "September 8", interviewDetail: "how they fix working capital at the plants they buy", threadSubject: "Thank You", lastCheckIn: "no" },
  },
  {
    id: "19", what: "final interview check-in with a competing deadline", student: MAYA, type: "interview_check_in",
    recipient: { contactName: "Paul Grant", contactFirm: "Halsey Ridge Securities" },
    fields: { interviewRole: "Summer Analyst, Consumer & Retail", interviewDate: "September 3", otherDeadline: "offer from another bank due September 30", lastCheckIn: "yes" },
  },
  // --------------------------------------------------------- after they reply
  {
    id: "20", what: "they proposed a time the student can make", student: LEO, type: "call_scheduling",
    recipient: { contactName: "Tom Alvarez", contactFirm: "Castellan Partners" },
    brief: { originalSubject: "Michigan Freshman Seeking Advice" },
    fields: { canMakeIt: "yes", proposedTime: "Friday 11am", timeZone: "Eastern", callFormat: "phone" },
  },
  {
    id: "21", what: "offering windows, messy shorthand", student: SOFIA, type: "call_scheduling",
    recipient: { contactName: "Marcus Lee", contactFirm: "Ironbridge Capital" },
    brief: { originalSubject: "Engineer Interested in Operations-Focused PE" },
    fields: { canMakeIt: "none", availability: "mon after 2, tues whenever, thurs am", timeZone: "Eastern", callFormat: "either" },
  },
  {
    id: "22", what: "reschedule for an exam", student: MAYA, type: "reschedule_call",
    recipient: { contactName: "Rachel Stein", contactFirm: "Morrow & Pike" },
    fields: { rescheduleAction: "reschedule", callTime: "Wednesday at 4pm", rescheduleReason: "my econometrics midterm got moved to that slot", newWindows: "Thursday after 1, Friday morning, Monday any time", timeZone: "Eastern", threadSubject: "Call on Wednesday" },
  },
  {
    id: "23", what: "cancel after accepting an offer", student: DANIEL, type: "reschedule_call",
    recipient: { contactName: "Linda Osei", contactFirm: "Sequoia Trust Bank" },
    fields: { rescheduleAction: "cancel", callTime: "next Tuesday", rescheduleReason: "i accepted a full time offer at another bank yesterday", timeZone: "Pacific" },
  },
  {
    id: "24", what: "confirm a virtual first round, transcript requested", student: MAYA, type: "recruiter_scheduling_reply",
    recipient: { contactName: "Olivia Brandt", contactFirm: "Morrow & Pike", contactRole: "Campus Recruiter" },
    fields: { slotResponse: "confirm", offeredSlot: "Tuesday, October 6 at 10:00 a.m.", interviewFormat: "virtual", timeZone: "Eastern", materials: "unofficial transcript", threadSubject: "First Round Interview: Morrow & Pike" },
  },
  {
    id: "25", what: "different superday slot plus logistics", student: SOFIA, type: "recruiter_scheduling_reply",
    recipient: { contactName: "Ironbridge Capital Recruiting", contactFirm: "Ironbridge Capital" },
    fields: { slotResponse: "different", offeredSlot: "Friday October 9, 8am", interviewFormat: "in_person", timeZone: "Eastern", conflictReason: "a required design lab", availability: "Thursday October 8 any time, Monday October 12 any time", logistics: "is travel covered? dress code?" },
  },
  // ------------------------------------------------------ after a conversation
  {
    id: "26", what: "coffee chat thank-you, incomplete profile", student: BARE, type: "thank_you_chat",
    recipient: { contactName: "Dana Whitfield", contactFirm: "Crestline Advisors", contactRole: "Associate" },
    brief: { meetingWhen: "this afternoon", conversationDetails: "she said to learn accounting before worrying about modeling", nextStepAsk: "who_else" },
  },
  {
    id: "27", what: "coffee chat thank-you asking for an intro", student: SOFIA, type: "thank_you_chat",
    recipient: { contactName: "Marcus Lee", contactFirm: "Ironbridge Capital" },
    brief: { meetingWhen: "this morning", conversationDetails: "how he learned to read a P&L after years on the plant floor", nextStepAsk: "intro", introName: "Claire on his deal team", introReason: "she also studied industrial engineering" },
  },
  {
    id: "28", what: "they offered to pass the resume along", student: MAYA, type: "thank_you_offered_help",
    recipient: { contactName: "Rachel Stein", contactFirm: "Morrow & Pike" },
    fields: { offerType: "resume", conversationDetail: "the way she decides which consumer brands have staying power", applicationRef: "applied last week, req #55120" },
  },
  {
    id: "29", what: "they offered an intro, no resume on file", student: { ...LEO, resumeOnFile: false, studentResumeSummary: null }, type: "thank_you_offered_help",
    recipient: { contactName: "Tom Alvarez", contactFirm: "Castellan Partners" },
    fields: { offerType: "intro", conversationDetail: "his advice to join a student-run fund early", introTarget: "his old roommate who works in restructuring" },
  },
  {
    id: "30", what: "event thank-you, asked a question", student: MAYA, type: "thank_you_event",
    recipient: { contactName: "Helen Park", contactFirm: "Halsey Ridge Securities", contactRole: "Managing Director" },
    fields: { eventName: "the Halsey Ridge info session at the Fuqua auditorium on Tuesday", remarkPoint: "the best analysts write down every question they get wrong", yourQuestion: "how the consumer team splits work between associates and analysts", eventAsk: "call" },
  },
  {
    id: "31", what: "event thank-you, outside contact, no ask", student: DANIEL, type: "thank_you_event",
    recipient: { contactName: "Victor Ames", contactFirm: "Golden State Credit" },
    fields: { eventName: "the transfer student finance panel", remarkPoint: "his story about starting at a community college too", eventAsk: "none" },
  },
  {
    id: "32", what: "keeping in touch with news and advice followed", student: MAYA, type: "keep_in_touch",
    recipient: { contactName: "Brian Castellano", contactFirm: "Ashford Lane Capital" },
    fields: { lastSpoke: "back in March about consumer PE", updateSince: "I spent the summer at Pinecrest Wealth Partners building a dividend screening model", adviceFollowed: "I started reading one 10-K a week like he suggested", theirNews: "Ashford Lane just closed its third fund" },
  },
  {
    id: "33", what: "close the loop: got the offer", student: SOFIA, type: "close_loop_referrer",
    recipient: { contactName: "Janet Wu", contactFirm: "Ironbridge Capital" },
    fields: { introducedTo: "Marcus Lee", loopStage: "offer", learnedOrUpdate: "I accepted the summer associate offer on the industrials team", nextForYou: "starting in June" },
  },
  {
    id: "34", what: "close the loop: didn't work out", student: LEO, type: "close_loop_referrer",
    recipient: { contactName: "Emily Tran", contactFirm: "Michigan Finance Club" },
    fields: { introducedTo: "Nathan Cole", loopStage: "no", learnedOrUpdate: "didn't get the sophomore program but nathan told me to focus on one sector" },
  },
  {
    id: "35", what: "referral ask after two chats", student: MAYA, type: "referral_ask",
    recipient: { contactName: "Rachel Stein", contactFirm: "Morrow & Pike" },
    fields: { askStage: "first", pastConversations: "two calls this month, she walked me through how her team screens consumer brands", roleAndReq: "2028 Summer Analyst, req #55120, applied Sept 10" },
  },
  {
    id: "36", what: "the one follow-up after they said yes", student: SOFIA, type: "referral_ask",
    recipient: { contactName: "Marcus Lee", contactFirm: "Ironbridge Capital" },
    fields: { askStage: "followup", pastConversations: "he said he'd pass my resume to recruiting two weeks ago", roleAndReq: "Summer Associate, Industrials", threadSubject: "Question About the Summer Program" },
  },
  // -------------------------------------------------------------- interviews
  {
    id: "37", what: "interview thank-you with a personal connection", student: DANIEL, type: "thank_you_interview",
    recipient: { contactName: "Carla Mendez", contactFirm: "Golden State Credit", contactRole: "Director" },
    brief: { meetingWhen: "this morning", interviewTeam: "Golden State Credit, leveraged finance", conversationDetails: "she started as a bank teller too", personalConnection: "I was a teller at a credit union for two years" },
  },
  {
    id: "38", what: "superday note that must differ from the others", student: MAYA, type: "thank_you_superday",
    recipient: { contactName: "Paul Grant", contactFirm: "Halsey Ridge Securities" },
    fields: { whenInterviewed: "this afternoon", onlyDetail: "walking through why a grocery chain trades at a discount to peers", otherNotes: "thanked Helen for the question about analyst staffing and Kevin for the DCF walkthrough" },
  },
  {
    id: "39", what: "phone screen with nothing scheduled yet", student: LEO, type: "thank_you_phone_screen",
    recipient: { contactName: "Priya Nair", contactFirm: "Wexford Bank" },
    fields: { usefulExplanation: "freshman programs are mostly about exposure, not technicals" },
  },
  {
    id: "40", what: "recorded round note", student: DANIEL, type: "recorded_round_note",
    recipient: { contactName: "Samira Holt", contactFirm: "Wexford Bank", contactRole: "Recruiter" },
    fields: { completedWhen: "tonight, a day before the deadline", roundContent: "why credit and a time I handled a difficult customer" },
  },
  // ------------------------------------------------------ offers & decisions
  {
    id: "41", what: "rejection after a superday, thanking people", student: MAYA, type: "after_rejection",
    recipient: { contactName: "Helen Park", contactFirm: "Halsey Ridge Securities" },
    fields: { roleName: "Summer Analyst, Consumer & Retail", takeaway: "the case round showed me I need to practice talking through numbers out loud", peopleMet: "Paul and Kevin", stageReached: "superday" },
  },
  {
    id: "42", what: "rejection to a recruiting team", student: DANIEL, type: "after_rejection",
    recipient: { contactName: "Wexford Bank Early Careers", contactFirm: "Wexford Bank" },
    fields: { roleName: "2027 Full-Time Analyst Program", takeaway: "the video round made me realize i ramble", stageReached: "first_round" },
  },
  {
    id: "43", what: "extension, naming the other firm", student: SOFIA, type: "offer_extension",
    recipient: { contactName: "Janet Wu", contactFirm: "Ironbridge Capital" },
    fields: { roleName: "Summer Associate, Industrials", currentDeadline: "October 2", requestedDate: "October 9", extensionReason: "I have a final round that week", otherFirm: "Redwood Forge Partners on October 7" },
  },
  {
    id: "44", what: "accept a return offer, nobody named", student: MAYA, type: "accept_offer",
    recipient: { contactName: "Laura Chen", contactFirm: "Pinecrest Wealth Partners" },
    fields: { roleName: "Full-Time Analyst, Pinecrest Wealth Partners", startDate: "July 2029", returnOffer: "yes", paperwork: "signed the letter in the portal today" },
  },
  {
    id: "45", what: "decline a return offer", student: SOFIA, type: "decline_offer",
    recipient: { contactName: "Rob Feld", contactFirm: "Harlow Components" },
    fields: { roleName: "Full-Time Supply Chain Analyst at Harlow Components", declineReason: "I want to start my career in private equity", returnOffer: "yes", thankPeople: "Denise and the Dalton plant team" },
  },
  // ------------------------------------------------------------------ custom
  {
    id: "46", what: "custom: asking a professor for a recommendation letter", student: LEO, type: "custom",
    recipient: { contactName: "Professor Alan Greer", contactFirm: "University of Michigan" },
    purpose: "ask my econ 101 professor if he'd write me a recommendation for the sophomore leadership program, i got an A and went to office hours a lot",
  },
  {
    id: "47", what: "custom: congratulate a contact on a promotion, no ask", student: MAYA, type: "custom",
    recipient: { contactName: "Rachel Stein", contactFirm: "Morrow & Pike" },
    purpose: "congratulate rachel on making director, we talked twice last year. no ask",
  },
  {
    id: "48", what: "custom: LinkedIn recommendation from an internship manager", student: SOFIA, type: "custom",
    recipient: { contactName: "Rob Feld", contactFirm: "Harlow Components", contactRole: "Supply Chain Manager" },
    purpose: "ask my old manager rob for a linkedin recommendation about the reorder point project",
  },
  {
    id: "49", what: "custom: rambling, rude-ish instruction and typos", student: DANIEL, type: "custom",
    recipient: { contactName: "Victor Ames", contactFirm: "Golden State Credit" },
    purpose: "WANT TO TALK TO HIM ABOUT CREDIT JOBS. tell him his firm is kinda overrated compared to goldman but i still wanna chat lol. also i met him at the transfer panel",
  },
  {
    id: "50", what: "custom: MBA student, outside contact from a conference", student: AISHA, type: "custom",
    recipient: { contactName: "Denise Howard", contactFirm: "Ridgeline Partners", contactRole: "Recruiting Manager" },
    purpose: "met her at the Forte Foundation conference in Chicago last weekend, want to ask about the post-MBA associate program and recruiting timeline",
  },
];

// ------------------------------------------------ Volume IV students and runs 51-300

// International sophomore-year junior on an F-1 visa.
const TENDAI: Student = {
  studentName: "Tendai Moyo",
  studentSchool: "New York University",
  studentSchoolEmail: "tm3921@nyu.edu",
  studentPhone: "(646) 555-0183",
  studentLinkedinUrl: "https://www.linkedin.com/in/tendaimoyo",
  studentGradYear: 2028,
  studentMajor: "Finance and Mathematics",
  studentHometown: "Harare, Zimbabwe",
  studentClubs: "NYU Stern Investment Banking Club",
  studentSponsorship: "needs visa sponsorship for full-time work",
  studentResumeSummary: [
    "EDUCATION",
    "- New York University, Stern School of Business · BS Finance and Mathematics · F-1 visa",
    "WORK EXPERIENCE",
    "- Mukuru Payments · Finance Intern · Harare, Zimbabwe · Jun 2026 - Aug 2026",
    "    - Reconciled cross-border remittance flows across four corridors",
    "CLUBS & ACTIVITIES",
    "- NYU Stern Investment Banking Club · Technical training lead",
  ].join("\n"),
  resumeOnFile: true,
};

// A senior who spent three years on a history degree and is recruiting late.
const HANNAH: Student = {
  studentName: "Hannah Brooks",
  studentSchool: "Boston College",
  studentSchoolEmail: "brookshd@bc.edu",
  studentGradYear: 2027,
  studentMajor: "History",
  studentHometown: "Providence, RI",
  studentResumeSummary: [
    "EDUCATION",
    "- Boston College · BA History, minor in Economics",
    "WORK EXPERIENCE",
    "- Ironbound Learning · Summer Teaching Fellow · Newark, NJ · Jun 2026 - Aug 2026",
    "    - Ran budgeting for a $40,000 summer program serving 90 students",
    "- Boston College Archives · Research Assistant · 2024 - Present",
  ].join("\n"),
  resumeOnFile: true,
};

// A one-year Master's in Finance after three years in audit.
const MARCO: Student = {
  studentName: "Marco Bellini",
  studentSchool: "Vanderbilt University",
  studentSchoolEmail: "marco.bellini@vanderbilt.edu",
  studentPhone: "(615) 555-0126",
  studentGradYear: 2027,
  studentMajor: "Master of Science in Finance",
  studentResumeSummary: [
    "EDUCATION",
    "- Vanderbilt University, Owen Graduate School of Management · MS Finance · 2027",
    "WORK EXPERIENCE",
    "- Tate & Carrow LLP · Audit Senior · Nashville, TN · 2023 - 2026",
    "    - Led fieldwork on audits of three manufacturing clients with $200M+ revenue",
  ].join("\n"),
  resumeOnFile: true,
};

// A junior whose Gmail adds her signature, no LinkedIn.
const JADE: Student = {
  studentName: "Jade Nguyen",
  studentSchool: "Rutgers University",
  studentSchoolEmail: "jade.nguyen@rutgers.edu",
  studentPhone: "(732) 555-0164",
  studentGradYear: 2028,
  studentMajor: "Accounting",
  studentClubs: "Rutgers Women in Business",
  studentResumeSummary: [
    "EDUCATION",
    "- Rutgers Business School · BS Accounting · GPA 3.71",
    "WORK EXPERIENCE",
    "- Lindqvist Tax Group · Seasonal Tax Associate · Edison, NJ · Jan 2026 - Apr 2026",
    "CLUBS & ACTIVITIES",
    "- Rutgers Women in Business · VP of Corporate Relations",
  ].join("\n"),
  resumeOnFile: true,
};

// A sophomore who transferred from a community college.
const RUBEN: Student = {
  studentName: "Ruben Ortiz",
  studentSchool: "UC Berkeley",
  studentSchoolEmail: "rortiz@berkeley.edu",
  studentPhone: "(510) 555-0171",
  studentGradYear: 2029,
  studentMajor: "Economics",
  studentHometown: "Bakersfield, CA",
  studentResumeSummary: [
    "EDUCATION",
    "- University of California, Berkeley · BA Economics",
    "- Bakersfield College · Transferred 2026",
    "WORK EXPERIENCE",
    "- Ortiz Family Auto Repair · Bookkeeper · Bakersfield, CA · 2022 - 2026",
    "    - Moved the shop's books from paper to QuickBooks and cut month-end close to two days",
  ].join("\n"),
  resumeOnFile: true,
};

export type Opts = Pick<
  Scenario,
  "fields" | "brief" | "purpose" | "extraContext" | "gmailSignature" | "sameSchool" | "must" | "mustNot" | "subjectMustNot" | "note" | "maxBodyWords"
>;
const R = (contactName: string, contactFirm?: string, contactRole?: string, more: Partial<Scenario["recipient"]> = {}): Scenario["recipient"] => ({
  contactName,
  contactFirm,
  contactRole,
  ...more,
});
const sc = (id: number, type: EmailTypeId, student: Student, recipient: Scenario["recipient"], what: string, o: Opts = {}): Scenario => ({
  id: String(id),
  type,
  student,
  recipient,
  what,
  ...o,
});
const NO_RESUME = (s: Student): Student => ({ ...s, resumeOnFile: false, studentResumeSummary: null });

let n = 50;
const next = () => ++n;

SCENARIOS.push(
  // ------------------------------------------------ conference follow-up
  sc(next(), "conference_follow_up", TENDAI, R("Adaeze Obi", "Northgate Securities", "Vice President"), "international student, clean input", {
    fields: { conferenceName: "the SEO Career Summit in New York", whereTalked: "at the Northgate table after the Friday lunch, about moving from Lagos to New York for banking", stuckWithYou: "she said the outsider view is an edge in cross-border deals" },
  }),
  sc(next(), "conference_follow_up", MAYA, R("Chris Talbot", "Calloway Brothers", "Associate"), "lowercase shorthand", {
    fields: { conferenceName: "wharton restructuring conf, philly", whereTalked: "coffee line before the distressed debt panel, talked about the retail bankruptcies" },
  }),
  sc(next(), "conference_follow_up", AISHA, R("Gwen Alder", "Stonebrook Capital", "Principal"), "MBA, healthcare switch", {
    fields: { conferenceName: "the Forte MBA Women's Leadership Conference in Chicago", whereTalked: "after her breakout on healthcare services buyouts", stuckWithYou: "that operators who have run clinics spot bad roll-ups fast" },
  }),
  sc(next(), "conference_follow_up", HANNAH, R("Derek Plum", "Everly Park Partners", "Managing Director"), "late senior, verbose rambling input", {
    fields: { conferenceName: "the Boston Finance Forum at the Hynes Convention Center", whereTalked: "ok so it was at the very end, everyone was leaving and he was packing up the booth and I asked him whether it was realistic to start in banking as a history major senior and he laughed and said he was a classics major", stuckWithYou: "he said the best analysts he hired could write, and that most people can learn Excel in a summer" },
  }),
  sc(next(), "conference_follow_up", JADE, R("Nora Fitch", "Harbor Row Capital", "Analyst"), "Gmail signature, terse", {
    gmailSignature: true, fields: { conferenceName: "Women in Finance Symposium, Newark", whereTalked: "sponsor booth, restructuring" },
  }),
  sc(next(), "conference_follow_up", RUBEN, R("Sam Whitaker", "Keswick & Lowe", "Director"), "transfer student, personal connection", {
    fields: { conferenceName: "the Latino Business Student Association conference in Los Angeles", whereTalked: "on the panel Q&A line, about his dad's body shop and how small business owners think about selling", stuckWithYou: "that most owners sell once, so the advisor matters more than the price" },
  }),
  sc(next(), "conference_follow_up", MARCO, R("Elena Voss", "Tillman Gray", "Vice President"), "Master's student with audit background", {
    fields: { conferenceName: "the CFA Society Nashville annual forum", whereTalked: "at the reception, about how auditors make good diligence people", stuckWithYou: "her line that auditors already know where the bodies are buried in a quality of earnings" },
  }),
  sc(next(), "conference_follow_up", NO_RESUME(SOFIA), R("Owen Price", "Ironbridge Capital", "Associate"), "no resume on file", {
    fields: { conferenceName: "the Georgia Tech Energy Finance Conference in Atlanta", whereTalked: "during the plant tour bus ride, about battery supply chains" },
  }),
  sc(next(), "conference_follow_up", DANIEL, R("Ivy Chen", "Golden State Credit", "Recruiter"), "recruiter met at a conference", {
    fields: { conferenceName: "the Transfer Students in Business Conference in San Diego", whereTalked: "at the Golden State Credit booth, about whether they hire seniors off-cycle" },
  }),

  // ------------------------------------------------ recruiter outreach
  sc(next(), "recruiter_outreach", MAYA, R("Lauren Haskell", "Morrow & Pike", "Campus Recruiter"), "met at a fair, two questions", {
    fields: { whereMet: "the Duke fall career fair on Wednesday, talked about the sophomore diversity program", recruiterQuestions: "when does the sophomore program application open, and does it lead into the summer analyst process" },
  }),
  sc(next(), "recruiter_outreach", TENDAI, R("Jon Mercer", "Northgate Securities", "University Recruiting Lead"), "sponsorship question to a recruiter", {
    fields: { whereMet: "the NYU Stern bank night", recruiterQuestions: "does Northgate sponsor visas for full-time analysts, and is the summer program open to international students" },
  }),
  sc(next(), "recruiter_outreach", LEO, R("Priya Nair", "Wexford Bank", "Campus Recruiter"), "freshman, never met, lowercase", {
    fields: { recruiterQuestions: "is there anything for freshmen? like a spring week thing? how should i prepare" },
  }),
  sc(next(), "recruiter_outreach", HANNAH, R("Molly Grant", "Pemberton Trust", "Recruiter"), "late senior asking about full-time", {
    fields: { whereMet: "the BC info session last Tuesday", recruiterQuestions: "are there still full-time analyst spots for 2027, and do you hire off-cycle in the spring" },
  }),
  sc(next(), "recruiter_outreach", AISHA, R("Carl Benning", "Larchmont Securities", "MBA Recruiting Manager"), "MBA associate program", {
    fields: { whereMet: "Kellogg's finance club trek to New York", recruiterQuestions: "timeline for the summer associate program and whether healthcare is staffed separately" },
  }),
  sc(next(), "recruiter_outreach", JADE, R("Tara Wells", "Blue Ash Advisors", "Talent Acquisition Partner"), "Gmail signature, three questions", {
    gmailSignature: true, fields: { whereMet: "Rutgers accounting career night", recruiterQuestions: "1) do you take accounting majors into transaction advisory 2) is there a junior summer program 3) what does the interview look like" },
  }),
  sc(next(), "recruiter_outreach", RUBEN, R("Kim Duarte", "Summit Hollow Capital", "Campus Recruiter"), "student wants to ask about the recruiter's own career (should not)", {
    fields: { whereMet: "Berkeley career fair, told her I transferred in", recruiterQuestions: "how she got into recruiting and what her day looks like, and whether transfer students can apply to the sophomore program" },
  }),
  sc(next(), "recruiter_outreach", DANIEL, R("Grace Lin", "Crestline Advisors", "Recruiting Coordinator"), "senior, never met, over-eager input", {
    fields: { recruiterQuestions: "PLEASE tell me if there are any openings, I will do anything, also when do full time roles post" },
  }),
  sc(next(), "recruiter_outreach", MARCO, R("Hugh Barlow", "Stonebrook Capital", "Recruiter"), "Master's student, analyst vs associate", {
    fields: { whereMet: "Owen's finance recruiting reception", recruiterQuestions: "whether MSF graduates come in as analysts or associates, and when the 2027 class recruits" },
  }),

  // ------------------------------------------------ recruiter follow-up
  sc(next(), "recruiter_follow_up", MAYA, R("Lauren Haskell", "Morrow & Pike", "Campus Recruiter"), "one question still open", {
    brief: { originalSubject: "Duke Sophomore Following Up From the Career Fair", originalDate: "a week ago" }, fields: { stillOpen: "when the sophomore program application opens" },
  }),
  sc(next(), "recruiter_follow_up", TENDAI, R("Jon Mercer", "Northgate Securities", "University Recruiting Lead"), "sponsorship question still open", {
    brief: { originalSubject: "Question About Visa Sponsorship for Analysts", originalDate: "September 10" }, fields: { stillOpen: "whether analysts are sponsored" },
  }),
  sc(next(), "recruiter_follow_up", LEO, R("Priya Nair", "Wexford Bank", "Campus Recruiter"), "no stillOpen given, Gmail signature", {
    gmailSignature: true, brief: { originalSubject: "Michigan Freshman Question", originalDate: "6 days ago" },
  }),
  sc(next(), "recruiter_follow_up", HANNAH, R("Molly Grant", "Pemberton Trust", "Recruiter"), "annoyed input", {
    brief: { originalSubject: "Boston College Senior Asking About Full-Time Roles", originalDate: "two weeks ago" }, fields: { stillOpen: "she never answered me about full time spots, kind of annoying" },
  }),
  sc(next(), "recruiter_follow_up", AISHA, R("Carl Benning", "Larchmont Securities", "MBA Recruiting Manager"), "manual thread, vague date", {
    brief: { originalSubject: "Kellogg MBA Following Up From the New York Trek", originalDate: "last Monday" }, fields: { stillOpen: "the summer associate timeline" },
  }),
  sc(next(), "recruiter_follow_up", RUBEN, R("Kim Duarte", "Summit Hollow Capital", "Campus Recruiter"), "eligibility for transfer", {
    brief: { originalSubject: "Berkeley Transfer Student Question", originalDate: "September 12" }, fields: { stillOpen: "if transfer students can do the sophomore program" },
  }),
  sc(next(), "recruiter_follow_up", JADE, R("Tara Wells", "Blue Ash Advisors", "Talent Acquisition Partner"), "three questions shortened to one", {
    brief: { originalSubject: "Rutgers Junior Following Up From Accounting Career Night", originalDate: "8 days ago" }, fields: { stillOpen: "accounting majors into transaction advisory, junior program, interview format" },
  }),
  sc(next(), "recruiter_follow_up", DANIEL, R("Grace Lin", "Crestline Advisors", "Recruiting Coordinator"), "second follow-up attempt (should warn)", {
    brief: { originalSubject: "UCLA Senior Asking About Full-Time Openings", originalDate: "3 weeks ago", followUp1Date: "last week" }, fields: { stillOpen: "full time openings" },
  }),
  sc(next(), "recruiter_follow_up", MARCO, R("Hugh Barlow", "Stonebrook Capital", "Recruiter"), "short clean", {
    brief: { originalSubject: "Vanderbilt MSF Candidate Question", originalDate: "September 11" }, fields: { stillOpen: "analyst or associate entry for MSF grads" },
  }),

  // ------------------------------------------------ stalled thread nudge
  sc(next(), "stalled_thread_nudge", MAYA, R("Chris Talbot", "Calloway Brothers", "Associate"), "warm reply but no time", {
    fields: { threadSubject: "Following Up From the Wharton Restructuring Conference", answeredPart: "a nice note saying he remembered the retail chat", openQuestion: "whether a 15 minute call works in the next couple weeks" },
  }),
  sc(next(), "stalled_thread_nudge", TENDAI, R("Adaeze Obi", "Northgate Securities", "Vice President"), "answered one of two questions", {
    fields: { threadSubject: "SEO Career Summit Follow Up", answeredPart: "she answered about the cross-border team", openQuestion: "who on the team I should talk to about the analyst program" },
  }),
  sc(next(), "stalled_thread_nudge", HANNAH, R("Derek Plum", "Everly Park Partners", "Managing Director"), "lowercase, no answered part", {
    fields: { threadSubject: "Boston Finance Forum", openQuestion: "can we still do a call or nah" },
  }),
  sc(next(), "stalled_thread_nudge", RUBEN, R("Sam Whitaker", "Keswick & Lowe", "Director"), "Gmail signature", {
    gmailSignature: true, fields: { threadSubject: "Question After the LBSA Panel", answeredPart: "said he'd be happy to help", openQuestion: "a day that works for a call" },
  }),
  sc(next(), "stalled_thread_nudge", AISHA, R("Gwen Alder", "Stonebrook Capital", "Principal"), "student wants to point out the non-answer (should not)", {
    fields: { threadSubject: "Forte Conference Follow Up", answeredPart: "replied about the fund but ignored my question", openQuestion: "remind her she didn't answer whether they hire post-MBA associates into healthcare" },
  }),
  sc(next(), "stalled_thread_nudge", JADE, R("Nora Fitch", "Harbor Row Capital", "Analyst"), "terse", {
    fields: { threadSubject: "Women in Finance Symposium", openQuestion: "call next week?" },
  }),
  sc(next(), "stalled_thread_nudge", MARCO, R("Elena Voss", "Tillman Gray", "Vice President"), "answered part: sent a link", {
    fields: { threadSubject: "CFA Society Forum Follow Up", answeredPart: "she sent the careers page link", openQuestion: "whether she'd be open to a quick call about diligence roles" },
  }),
  sc(next(), "stalled_thread_nudge", DANIEL, R("Victor Ames", "Golden State Credit"), "outside contact with no role", {
    fields: { threadSubject: "Transfer Panel Thank You", answeredPart: "thanked me for the note", openQuestion: "if the credit team takes off-cycle interns" },
  }),
  sc(next(), "stalled_thread_nudge", LEO, R("Tom Alvarez", "Castellan Partners", "Analyst"), "freshman, verbose", {
    fields: { threadSubject: "Michigan Freshman Seeking Advice", answeredPart: "he said sure lets talk sometime but then nothing happened and its been like 10 days and I don't want to be annoying but I really want to talk", openQuestion: "a time for the call" },
  }),

  // ------------------------------------------------ not now reply
  sc(next(), "not_now_reply", MAYA, R("Rachel Stein", "Morrow & Pike", "Vice President"), "replying, deal closing", {
    brief: { originalSubject: "Duke Student Interested in Consumer Coverage" }, fields: { notNowStage: "reply", theirWords: "slammed until our deal closes, try me in a few weeks", followUpWhen: "mid-October" },
  }),
  sc(next(), "not_now_reply", MAYA, R("Rachel Stein", "Morrow & Pike", "Vice President"), "the later follow-up", {
    brief: { originalSubject: "Duke Student Interested in Consumer Coverage" }, fields: { notNowStage: "later", theirWords: "slammed until our deal closes, try me in a few weeks" },
  }),
  sc(next(), "not_now_reply", TENDAI, R("Adaeze Obi", "Northgate Securities", "Vice President"), "reply, no follow-up date given", {
    brief: { originalSubject: "SEO Career Summit Follow Up" }, fields: { notNowStage: "reply", theirWords: "traveling for the next month, reach back out after Thanksgiving" },
  }),
  sc(next(), "not_now_reply", HANNAH, R("Derek Plum", "Everly Park Partners", "Managing Director"), "disappointed input", {
    brief: { originalSubject: "Boston Finance Forum" }, fields: { notNowStage: "reply", theirWords: "not a good time, maybe in the new year", followUpWhen: "ugh january i guess, by then recruiting is basically over for me" },
  }),
  sc(next(), "not_now_reply", RUBEN, R("Sam Whitaker", "Keswick & Lowe", "Director"), "later, busy season over", {
    brief: { originalSubject: "Question After the LBSA Panel" }, fields: { notNowStage: "later", theirWords: "busy season, ping me in November", followUpWhen: "November" },
  }),
  sc(next(), "not_now_reply", AISHA, R("Gwen Alder", "Stonebrook Capital", "Principal"), "reply, fundraise", {
    gmailSignature: true, brief: { originalSubject: "Forte Conference Follow Up" }, fields: { notNowStage: "reply", theirWords: "we're in the middle of a fundraise; give me until mid-November", followUpWhen: "the week of November 16" },
  }),
  sc(next(), "not_now_reply", JADE, R("Nora Fitch", "Harbor Row Capital", "Analyst"), "student wants to push back (should not)", {
    brief: { originalSubject: "Women in Finance Symposium" }, fields: { notNowStage: "reply", theirWords: "can't this month", followUpWhen: "ask if she can do just 5 minutes this week instead" },
  }),
  sc(next(), "not_now_reply", DANIEL, R("Linda Osei", "Sequoia Trust Bank"), "later, terse reason", {
    brief: { originalSubject: "Question About Your Community Banking Episode" }, fields: { notNowStage: "later", theirWords: "reach out after quarter-end" },
  }),
  sc(next(), "not_now_reply", MARCO, R("Elena Voss", "Tillman Gray", "Vice President"), "reply, terse", {
    brief: { originalSubject: "CFA Society Forum Follow Up" }, fields: { notNowStage: "reply", theirWords: "few weeks", followUpWhen: "early Oct" },
  }),

  // ------------------------------------------------ redirect sequence
  sc(next(), "redirect_sequence", SOFIA, R("Marcus Lee", "Ironbridge Capital", "Vice President"), "thank the redirect", {
    fields: { redirectStep: "thank", firstPerson: "Marcus Lee", newPerson: "Claire Dunn on the industrials deal team", redirectDetail: "she runs the intern program now" },
  }),
  sc(next(), "redirect_sequence", SOFIA, R("Claire Dunn", "Ironbridge Capital", "Associate"), "email the new person", {
    fields: { redirectStep: "new_person", firstPerson: "Marcus Lee", newPerson: "Claire Dunn", redirectDetail: "Marcus said she runs the intern program and also studied industrial engineering" },
  }),
  sc(next(), "redirect_sequence", SOFIA, R("Marcus Lee", "Ironbridge Capital", "Vice President"), "close the loop", {
    fields: { redirectStep: "close_loop", firstPerson: "Marcus Lee", newPerson: "Claire", redirectDetail: "talked tuesday, she told me to apply to the operations track and gave me a case to practice" },
  }),
  sc(next(), "redirect_sequence", TENDAI, R("Hassan Karimi", "Northgate Securities", "Associate"), "new person, international", {
    fields: { redirectStep: "new_person", firstPerson: "Adaeze Obi", newPerson: "Hassan Karimi", redirectDetail: "she said he went through the sponsorship process himself two years ago" },
  }),
  sc(next(), "redirect_sequence", LEO, R("Tom Alvarez", "Castellan Partners", "Analyst"), "thank, lowercase", {
    fields: { redirectStep: "thank", firstPerson: "tom", newPerson: "his friend jess in s&t", redirectDetail: "he said he doesnt know much about trading" },
  }),
  sc(next(), "redirect_sequence", HANNAH, R("Philip Sato", "Everly Park Partners", "Vice President"), "new person, humanities-to-finance link", {
    fields: { redirectStep: "new_person", firstPerson: "Derek Plum", newPerson: "Philip Sato", redirectDetail: "Derek said Philip also switched from a humanities background" },
  }),
  sc(next(), "redirect_sequence", MAYA, R("Rachel Stein", "Morrow & Pike", "Vice President"), "close loop, Gmail signature", {
    gmailSignature: true, fields: { redirectStep: "close_loop", firstPerson: "Rachel Stein", newPerson: "Ben Ortega", redirectDetail: "Ben walked me through the consumer group's recent deals and said to apply by October 5" },
  }),
  sc(next(), "redirect_sequence", AISHA, R("Gwen Alder", "Stonebrook Capital", "Principal"), "student treats it like a rejection", {
    fields: { redirectStep: "thank", firstPerson: "Gwen", newPerson: "Tomas on the healthcare team", redirectDetail: "i think she just didn't want to talk to me honestly" },
  }),
  sc(next(), "redirect_sequence", RUBEN, R("Diana Reyes", "Keswick & Lowe", "Analyst"), "new person, verbose", {
    fields: { redirectStep: "new_person", firstPerson: "Sam Whitaker", newPerson: "Diana Reyes", redirectDetail: "Sam said Diana transferred from a community college too and is the best person to ask about how she got the internship as a sophomore, and that she's on the business services team which is what I care about because of the shop" },
  }),

  // ------------------------------------------------ coffee in person
  sc(next(), "coffee_in_person_reply", MAYA, R("Brian Castellano", "Ashford Lane Capital", "Principal"), "suggest days and a spot", {
    brief: { originalSubject: "Following Up From Speaker Night" }, fields: { coffeeNamed: "no", coffeeDays: "Tuesday or Thursday next week, anytime after 11", coffeeSpot: "Joe Van Gogh on Broad Street" },
  }),
  sc(next(), "coffee_in_person_reply", AISHA, R("Carl Benning", "Larchmont Securities", "MBA Recruiting Manager"), "confirm named place and time", {
    brief: { originalSubject: "Kellogg MBA Question About the Associate Program" }, fields: { coffeeNamed: "yes", coffeePlaceTime: "Friday at 8:30 at Intelligentsia on Monroe" },
  }),
  sc(next(), "coffee_in_person_reply", HANNAH, R("Derek Plum", "Everly Park Partners", "Managing Director"), "no spot given, no phone on profile", {
    brief: { originalSubject: "Boston Finance Forum" }, fields: { coffeeNamed: "no", coffeeDays: "any weekday morning before 10" },
  }),
  sc(next(), "coffee_in_person_reply", TENDAI, R("Hassan Karimi", "Northgate Securities", "Associate"), "lowercase", {
    brief: { originalSubject: "Introduced by Adaeze Obi" }, fields: { coffeeNamed: "no", coffeeDays: "mon wed fri after 3", coffeeSpot: "somewhere near his office in midtown" },
  }),
  sc(next(), "coffee_in_person_reply", JADE, R("Nora Fitch", "Harbor Row Capital", "Analyst"), "Gmail signature, confirm", {
    gmailSignature: true, brief: { originalSubject: "Women in Finance Symposium" }, fields: { coffeeNamed: "yes", coffeePlaceTime: "Wednesday 7:45am at the Starbucks in her lobby" },
  }),
  sc(next(), "coffee_in_person_reply", RUBEN, R("Sam Whitaker", "Keswick & Lowe", "Director"), "student wants to invite him to his school instead", {
    brief: { originalSubject: "Question After the LBSA Panel" }, fields: { coffeeNamed: "no", coffeeDays: "Thursday or Friday", coffeeSpot: "Caffe Strada on Berkeley campus since that's easier for me" },
  }),
  sc(next(), "coffee_in_person_reply", DANIEL, R("Carla Mendez", "Golden State Credit", "Director"), "confirm with a slight time question", {
    brief: { originalSubject: "Thank You for the Interview" }, fields: { coffeeNamed: "yes", coffeePlaceTime: "Saturday 10am at Blue Bottle in Santa Monica" }, extraContext: "I might be 10 minutes late because of the bus",
  }),
  sc(next(), "coffee_in_person_reply", MARCO, R("Elena Voss", "Tillman Gray", "Vice President"), "clean", {
    brief: { originalSubject: "CFA Society Forum Follow Up" }, fields: { coffeeNamed: "no", coffeeDays: "Tuesday October 6 or Wednesday October 7, before noon", coffeeSpot: "Frothy Monkey on 12th Avenue" },
  }),
  sc(next(), "coffee_in_person_reply", LEO, R("Nathan Cole", "Castellan Partners", "Associate"), "freshman, no days given", {
    brief: { originalSubject: "Referred by Emily Tran" }, fields: { coffeeNamed: "no" },
  }),

  // ------------------------------------------------ recruiter session thank-you
  sc(next(), "thank_you_recruiter_session", MAYA, R("Lauren Haskell", "Morrow & Pike", "Campus Recruiter"), "one question", {
    fields: { sessionName: "the Morrow & Pike info session at Fuqua last night", recruiterExplained: "how an application moves from the portal to a first-round list", oneQuestion: "does the resume drop through Duke career services go to the same pool" },
  }),
  sc(next(), "thank_you_recruiter_session", TENDAI, R("Jon Mercer", "Northgate Securities", "University Recruiting Lead"), "no question", {
    fields: { sessionName: "Northgate's Stern information session on Tuesday", recruiterExplained: "that sponsorship is decided at the offer stage, not the application stage" },
  }),
  sc(next(), "thank_you_recruiter_session", LEO, R("Priya Nair", "Wexford Bank", "Campus Recruiter"), "freshman, lowercase", {
    fields: { sessionName: "wexford info session", recruiterExplained: "that freshman programs care more about curiosity than technicals" },
  }),
  sc(next(), "thank_you_recruiter_session", HANNAH, R("Molly Grant", "Pemberton Trust", "Recruiter"), "late senior, two questions (should keep one)", {
    fields: { sessionName: "the Pemberton Trust session at BC on Monday", recruiterExplained: "the off-cycle analyst hiring in January", oneQuestion: "when do off-cycle roles post and do they interview on campus" },
  }),
  sc(next(), "thank_you_recruiter_session", JADE, R("Tara Wells", "Blue Ash Advisors", "Talent Acquisition Partner"), "Gmail signature", {
    gmailSignature: true, fields: { sessionName: "Blue Ash's transaction advisory night at Rutgers", recruiterExplained: "how accounting majors rotate through diligence in year one" },
  }),
  sc(next(), "thank_you_recruiter_session", RUBEN, R("Kim Duarte", "Summit Hollow Capital", "Campus Recruiter"), "verbose", {
    fields: { sessionName: "Summit Hollow info session at Haas", recruiterExplained: "she spent a lot of time on the transfer question which I asked, and said they look at the full transcript including the community college one, and that it doesn't count against you, which honestly was a relief" },
  }),
  sc(next(), "thank_you_recruiter_session", AISHA, R("Carl Benning", "Larchmont Securities", "MBA Recruiting Manager"), "MBA", {
    fields: { sessionName: "the Larchmont associate recruiting presentation at Kellogg", recruiterExplained: "how associates are placed into groups after the summer", oneQuestion: "can associates rank healthcare first" },
  }),
  sc(next(), "thank_you_recruiter_session", DANIEL, R("Grace Lin", "Crestline Advisors", "Recruiting Coordinator"), "no role clarity", {
    fields: { sessionName: "the Crestline virtual session", recruiterExplained: "the full-time timeline for 2027" },
  }),
  sc(next(), "thank_you_recruiter_session", MARCO, R("Hugh Barlow", "Stonebrook Capital", "Recruiter"), "terse", {
    fields: { sessionName: "Stonebrook at Owen", recruiterExplained: "MSF to analyst" },
  }),

  // ------------------------------------------------ second conversation
  sc(next(), "second_conversation", MAYA, R("Rachel Stein", "Morrow & Pike", "Vice President"), "clean, deadline", {
    fields: { firstTalk: "early August; she said to pick three consumer brands and track them", whatYouDid: "I've tracked Crumbl, Olipop and Vuori since then and wrote a one-pager on each", whyNow: "the summer analyst application closes October 15" },
  }),
  sc(next(), "second_conversation", LEO, R("Tom Alvarez", "Castellan Partners", "Analyst"), "freshman, did the thing", {
    fields: { firstTalk: "in july he said to learn the three statements", whatYouDid: "finished the finance club accounting course and built a model for Chipotle" },
  }),
  sc(next(), "second_conversation", TENDAI, R("Adaeze Obi", "Northgate Securities", "Vice President"), "international, why now", {
    fields: { firstTalk: "late July; she said to read about cross-border M&A in Africa", whatYouDid: "I wrote up three recent deals including the Airtel Africa tower sale", whyNow: "Northgate's application opens next week" },
  }),
  sc(next(), "second_conversation", HANNAH, R("Derek Plum", "Everly Park Partners", "Managing Director"), "did nothing much (should note)", {
    fields: { firstTalk: "two weeks ago, he said to take an accounting course", whatYouDid: "haven't started yet but I signed up for one" },
  }),
  sc(next(), "second_conversation", SOFIA, R("Marcus Lee", "Ironbridge Capital", "Vice President"), "Gmail signature, verbose", {
    gmailSignature: true, fields: { firstTalk: "in June we talked about operating partners and he said I should learn how to read a 10-K and focus on one sub-sector so I could speak to it in interviews", whatYouDid: "I picked packaging, read 10-Ks for Sonoco, Sealed Air and Berry Global, and started a spreadsheet of margins and capex across them", whyNow: "Ironbridge's summer associate interviews start in November" },
  }),
  sc(next(), "second_conversation", AISHA, R("Gwen Alder", "Stonebrook Capital", "Principal"), "MBA", {
    fields: { firstTalk: "late June, she said to talk to two operators about roll-ups", whatYouDid: "I spoke with a dental group COO and a former clinic director, and both confirmed her point about integration", whyNow: "before summer associate recruiting starts in October" },
  }),
  sc(next(), "second_conversation", RUBEN, R("Sam Whitaker", "Keswick & Lowe", "Director"), "lowercase, no why now", {
    fields: { firstTalk: "august, he said learn how small businesses get valued", whatYouDid: "i valued my dads shop using comps from bizbuysell" },
  }),
  sc(next(), "second_conversation", DANIEL, R("Carla Mendez", "Golden State Credit", "Director"), "too soon (a week)", {
    fields: { firstTalk: "last week, she said read Moody's primers", whatYouDid: "read two primers" },
  }),
  sc(next(), "second_conversation", MARCO, R("Elena Voss", "Tillman Gray", "Vice President"), "Master's, terse", {
    fields: { firstTalk: "July, QoE", whatYouDid: "did CFI QoE course", whyNow: "apps due Oct 30" },
  }),

  // ------------------------------------------------ congratulations
  sc(next(), "congratulations", MAYA, R("Rachel Stein", "Morrow & Pike", "Director"), "promotion, own news", {
    fields: { theirNews: "promoted to Director", whereSaw: "LinkedIn this morning", whyFits: "how clearly she explained consumer deals on both our calls", ownNews: "I start as a club analyst lead this month" },
  }),
  sc(next(), "congratulations", SOFIA, R("Marcus Lee", "Ironbridge Capital", "Vice President"), "deal closed", {
    fields: { theirNews: "Ironbridge closed the Harlan Metals acquisition", whereSaw: "the press release on Business Wire" },
  }),
  sc(next(), "congratulations", TENDAI, R("Adaeze Obi", "Northgate Securities", "Vice President"), "panel speaker, lowercase", {
    fields: { theirNews: "she was named to the crain's 40 under 40", whereSaw: "saw it on linkedin", whyFits: "she was super generous at the seo summit" },
  }),
  sc(next(), "congratulations", HANNAH, R("Derek Plum", "Everly Park Partners", "Managing Director"), "student wants to sneak in an ask (should not)", {
    fields: { theirNews: "Everly Park raised its fourth fund", whereSaw: "the WSJ", ownNews: "and also ask if they're hiring analysts now that they have new money" },
  }),
  sc(next(), "congratulations", AISHA, R("Gwen Alder", "Stonebrook Capital", "Partner"), "Gmail signature, promotion to partner", {
    gmailSignature: true, fields: { theirNews: "made partner", whereSaw: "the firm's announcement email" },
  }),
  sc(next(), "congratulations", RUBEN, R("Sam Whitaker", "Keswick & Lowe", "Director"), "new job at a new firm", {
    fields: { theirNews: "moved to Keswick & Lowe to lead the business services group", whereSaw: "LinkedIn", whyFits: "he talked about wanting to work with family-owned businesses at the LBSA panel" },
  }),
  sc(next(), "congratulations", JADE, R("Nora Fitch", "Harbor Row Capital", "Analyst"), "personal news (marathon)", {
    fields: { theirNews: "ran the Boston Marathon", whereSaw: "her Strava post she mentioned on our call", ownNews: "I ran my first half this spring" },
  }),
  sc(next(), "congratulations", DANIEL, R("Victor Ames", "Golden State Credit"), "outside contact, over-the-top input", {
    fields: { theirNews: "promoted to managing director!!!", whereSaw: "linkedin", whyFits: "he is literally the GOAT and deserves it so much" },
  }),
  sc(next(), "congratulations", LEO, R("Emily Tran", "Michigan Finance Club", "President"), "peer, got an internship", {
    fields: { theirNews: "got the Castellan summer analyst offer", whereSaw: "the club GroupMe" },
  }),

  // ------------------------------------------------ withdraw
  sc(next(), "withdraw_process", MAYA, R("Olivia Brandt", "Morrow & Pike", "Campus Recruiter"), "accepted elsewhere", {
    fields: { withdrawSituation: "accepted", processStage: "2028 Summer Analyst, superday scheduled October 14", withdrawDetail: "accepted an offer at Halsey Ridge yesterday" },
  }),
  sc(next(), "withdraw_process", TENDAI, R("Northgate Securities Campus Recruiting", "Northgate Securities"), "exam conflict to a team", {
    fields: { withdrawSituation: "conflict", processStage: "Summer Analyst, first round", withdrawDetail: "the only first round date is the same morning as my real analysis midterm, which can't be moved" },
  }),
  sc(next(), "withdraw_process", HANNAH, R("Molly Grant", "Pemberton Trust", "Recruiter"), "other reason: decided against banking", {
    fields: { withdrawSituation: "other", processStage: "full-time analyst, final round next week", withdrawDetail: "after the first round I realized I want to do nonprofit finance instead" },
  }),
  sc(next(), "withdraw_process", SOFIA, R("Janet Wu", "Ironbridge Capital", "Vice President"), "lowercase accepted", {
    fields: { withdrawSituation: "accepted", processStage: "summer associate, second round", withdrawDetail: "took redwood forge offer" },
  }),
  sc(next(), "withdraw_process", AISHA, R("Carl Benning", "Larchmont Securities", "MBA Recruiting Manager"), "Gmail signature, late withdrawal day before", {
    gmailSignature: true, fields: { withdrawSituation: "accepted", processStage: "Summer Associate, superday tomorrow", withdrawDetail: "I signed with Stonebrook this afternoon and should have told you sooner" },
  }),
  sc(next(), "withdraw_process", RUBEN, R("Kim Duarte", "Summit Hollow Capital", "Campus Recruiter"), "family emergency", {
    fields: { withdrawSituation: "other", processStage: "sophomore program, final interview Friday", withdrawDetail: "my dad is having surgery and I need to go home to run the shop for a few weeks" },
  }),
  sc(next(), "withdraw_process", JADE, R("Tara Wells", "Blue Ash Advisors", "Talent Acquisition Partner"), "conflict, verbose", {
    fields: { withdrawSituation: "conflict", processStage: "junior summer transaction advisory, in-person superday October 2", withdrawDetail: "I am the VP of corporate relations for Women in Business and our biggest event of the year is that day and I'm running it, I already asked if I could move the event and I can't, and I don't want to just not show up" },
  }),
  sc(next(), "withdraw_process", DANIEL, R("Grace Lin", "Crestline Advisors", "Recruiting Coordinator"), "student wants to ghost (should still write)", {
    fields: { withdrawSituation: "accepted", processStage: "full time analyst, first round", withdrawDetail: "honestly was just going to not show up lol but accepted golden state" },
  }),
  sc(next(), "withdraw_process", MARCO, R("Hugh Barlow", "Stonebrook Capital", "Recruiter"), "terse", {
    fields: { withdrawSituation: "accepted", processStage: "analyst, round 2" },
  }),

  // ------------------------------------------------ thank helper
  sc(next(), "thank_helper_offer", MAYA, R("Rachel Stein", "Morrow & Pike", "Vice President"), "contact whose advice mattered", {
    fields: { helperRole: "contact", offerSigned: "signed the Morrow & Pike summer analyst offer this morning", whatTheyDid: "she told me to track three brands, and my Olipop write-up was what the superday interviewer asked about" },
  }),
  sc(next(), "thank_helper_offer", MAYA, R("Olivia Brandt", "Morrow & Pike", "Campus Recruiter"), "recruiter", {
    fields: { helperRole: "recruiter", offerSigned: "signed the summer analyst offer", whatTheyDid: "moved my superday when my midterm conflicted" },
  }),
  sc(next(), "thank_helper_offer", TENDAI, R("Adaeze Obi", "Northgate Securities", "Vice President"), "international, sponsorship", {
    fields: { helperRole: "contact", offerSigned: "accepted the Northgate summer analyst offer, with sponsorship confirmed for full-time", whatTheyDid: "connected me with Hassan, who explained how to raise sponsorship in the final round" },
  }),
  sc(next(), "thank_helper_offer", HANNAH, R("Derek Plum", "Everly Park Partners", "Managing Director"), "late senior, emotional input", {
    fields: { helperRole: "contact", offerSigned: "got a full time offer at Pemberton Trust!!", whatTheyDid: "he told me writing is an edge and I literally cried when they said my case writeup was the best they'd seen" },
  }),
  sc(next(), "thank_helper_offer", RUBEN, R("Sam Whitaker", "Keswick & Lowe", "Director"), "Gmail signature, lowercase", {
    gmailSignature: true, fields: { helperRole: "contact", offerSigned: "signed summit hollow sophomore program", whatTheyDid: "his tip about how owners think about selling was my answer to the why-M&A question" },
  }),
  sc(next(), "thank_helper_offer", SOFIA, R("Marcus Lee", "Ironbridge Capital", "Vice President"), "offer at a different firm", {
    fields: { helperRole: "contact", offerSigned: "accepted Redwood Forge's summer associate offer", whatTheyDid: "taught me to read a 10-K like an operator, which carried my case study" },
  }),
  sc(next(), "thank_helper_offer", AISHA, R("Carl Benning", "Larchmont Securities", "MBA Recruiting Manager"), "recruiter, verbose", {
    fields: { helperRole: "recruiter", offerSigned: "signed my Larchmont summer associate offer in healthcare", whatTheyDid: "he answered every one of my questions within a day, got me a second coffee chat with the healthcare team, and he made the whole process feel much more human than the other firms" },
  }),
  sc(next(), "thank_helper_offer", DANIEL, R("Carla Mendez", "Golden State Credit", "Director"), "student wants to ask for a signing bonus (should not)", {
    fields: { helperRole: "contact", offerSigned: "signed full time at golden state", whatTheyDid: "she vouched for me after the superday" }, extraContext: "also ask if she can help me get a bigger signing bonus",
  }),
  sc(next(), "thank_helper_offer", JADE, R("Nora Fitch", "Harbor Row Capital", "Analyst"), "terse", {
    fields: { helperRole: "contact", offerSigned: "Blue Ash offer", whatTheyDid: "mock interview" },
  }),

  // ------------------------------------------------ professor recommendation
  sc(next(), "professor_recommendation", MAYA, R("Professor Eleanor Hart", "Duke University"), "clean, portal", {
    fields: { courseTerm: "Intermediate Microeconomics, last spring", courseWork: "A, and my final paper on grocery pricing", recProgram: "Morrow & Pike Sophomore Leadership Program", recDeadline: "October 30", recSubmission: "portal emails her a link" },
  }),
  sc(next(), "professor_recommendation", LEO, R("Professor Alan Greer", "University of Michigan"), "freshman, tight deadline", {
    fields: { courseTerm: "econ 101 this fall", courseWork: "went to office hours a lot, 96 on the midterm", recProgram: "Wexford Freshman Discovery Program", recDeadline: "September 28" },
  }),
  sc(next(), "professor_recommendation", TENDAI, R("Dr. Mira Kovac", "New York University"), "Dr. title, not professor", {
    fields: { courseTerm: "Probability Theory, spring 2026", courseWork: "A, and I was her grader this fall", recProgram: "SEO Career Scholarship", recDeadline: "November 20", recSubmission: "a letter uploaded by the recommender" },
  }),
  sc(next(), "professor_recommendation", HANNAH, R("Professor James Whitcombe", "Boston College"), "history professor, finance program", {
    fields: { courseTerm: "my senior thesis seminar, this year and last", courseWork: "he's advising my thesis on the 1873 banking panic", recProgram: "Pemberton Trust full-time analyst program", recDeadline: "October 21", recSubmission: "email to the recruiter directly" },
  }),
  sc(next(), "professor_recommendation", RUBEN, R("Professor Linda Okoro", "UC Berkeley"), "no resume on file", {
    fields: { courseTerm: "Econ 100A, summer session", courseWork: "A minus", recProgram: "Summit Hollow Sophomore Program", recDeadline: "November 14" },
  }),
  sc(next(), "professor_recommendation", JADE, R("Professor Ken Adler", "Rutgers University"), "Gmail signature, lowercase", {
    gmailSignature: true, fields: { courseTerm: "intermediate accounting 1, spring", courseWork: "top grade in the class, he asked me to TA", recProgram: "blue ash junior summer program", recDeadline: "nov 1", recSubmission: "online form" },
  }),
  sc(next(), "professor_recommendation", DANIEL, R("Professor Rosa Diaz", "UCLA"), "student wants professor to write it for him (should not)", {
    fields: { courseTerm: "Econ 102, winter", courseWork: "B plus", recProgram: "Golden State Credit Analyst Program", recDeadline: "October 10" }, extraContext: "tell her i can write the letter myself and she can just sign it",
  }),
  sc(next(), "professor_recommendation", MARCO, R("Professor Hal Sutter", "Vanderbilt University"), "graduate student", {
    fields: { courseTerm: "Valuation, fall module 1", courseWork: "presented the best LBO case in the section", recProgram: "Tillman Gray Associate Program", recDeadline: "November 6", recSubmission: "portal link" },
  }),
  sc(next(), "professor_recommendation", SOFIA, R("Professor Ada Lin", "Georgia Tech"), "verbose", {
    fields: { courseTerm: "Supply Chain Engineering, fall 2025", courseWork: "I got an A and also did a research project with her on reorder-point models which is the same thing I used at my internship at Harlow, and she wrote me a short note at the end saying my project was one of the best she'd seen", recProgram: "Ironbridge Operations Fellowship", recDeadline: "December 1" },
  }),

  // ------------------------------------------------ reference request
  sc(next(), "reference_request", MAYA, R("Laura Chen", "Pinecrest Wealth Partners", "Senior Wealth Advisor"), "phone reference with bullets", {
    fields: { referenceKind: "phone", roleWithThem: "summer intern on her team, June to August 2026", sharedProject: "the dividend stock screening model", referenceBullets: "built the 40-stock screening model\nprepared quarterly summaries for 12 households", referenceTimeline: "calls in October" },
  }),
  sc(next(), "reference_request", SOFIA, R("Rob Feld", "Harlow Components", "Supply Chain Manager"), "LinkedIn recommendation", {
    fields: { referenceKind: "linkedin", roleWithThem: "supply chain intern, summer 2026", sharedProject: "the reorder-point model rebuild" },
  }),
  sc(next(), "reference_request", HANNAH, R("Carmen Ruiz", "Ironbound Learning", "Program Director"), "non-finance manager, letter", {
    fields: { referenceKind: "letter", roleWithThem: "summer teaching fellow", sharedProject: "the $40,000 program budget", referenceTimeline: "by October 15" },
  }),
  sc(next(), "reference_request", DANIEL, R("Mark Ellison", "Valley First Credit Union", "Branch Manager"), "old manager, years ago, lowercase", {
    fields: { referenceKind: "phone", roleWithThem: "teller 2023-2025", sharedProject: "the loan payment help desk thing we set up", referenceBullets: "trained new tellers\nhandled 60 members a day" },
  }),
  sc(next(), "reference_request", RUBEN, R("Maria Ortiz", "Ortiz Family Auto Repair", "Owner"), "family business, the owner is his mom (should note)", {
    fields: { referenceKind: "letter", roleWithThem: "bookkeeper 2022 to 2026", sharedProject: "moving the books to QuickBooks" },
  }),
  sc(next(), "reference_request", TENDAI, R("Farai Chikwanha", "Mukuru Payments", "Finance Manager"), "international manager, Gmail signature", {
    gmailSignature: true, fields: { referenceKind: "phone", roleWithThem: "finance intern, summer 2026", sharedProject: "remittance reconciliation across four corridors", referenceTimeline: "calls could come from New York in November, so time zones matter" },
  }),
  sc(next(), "reference_request", MARCO, R("Diane Carrow", "Tate & Carrow LLP", "Partner"), "former employer, student wants invented praise (should not)", {
    fields: { referenceKind: "letter", roleWithThem: "audit senior 2023-2026", sharedProject: "the Harrow Tools audit", referenceBullets: "say I was the best senior in the office\nsay I led a team of 10" },
  }),
  sc(next(), "reference_request", JADE, R("Priya Lindqvist", "Lindqvist Tax Group", "Owner"), "short season job", {
    fields: { referenceKind: "linkedin", roleWithThem: "seasonal tax associate last spring", sharedProject: "the small business returns backlog" },
  }),
  sc(next(), "reference_request", AISHA, R("Tom Keller", "Brightline Health", "Director of Operations"), "MBA, verbose", {
    fields: { referenceKind: "phone", roleWithThem: "senior operations analyst reporting to him for four years", sharedProject: "the clinic scheduling overhaul that cut wait times", referenceBullets: "led the scheduling overhaul across 14 clinics\ncut average wait time from 19 to 11 days\npresented monthly to the COO", referenceTimeline: "Larchmont will call in the next two weeks" },
  }),

  // ------------------------------------------------ existing types: cold email
  sc(next(), "cold_email", TENDAI, R("Kwame Mensah", "Northgate Securities", "Associate", { contactSchool: "New York University" }), "international alum", {
    sameSchool: true, brief: { financeInterest: "cross-border M&A", wantToLearn: "how he handled sponsorship as an international analyst" },
  }),
  sc(next(), "cold_email", HANNAH, R("Julia Park", "Pemberton Trust", "Vice President", { contactSchool: "Boston College" }), "late senior history major alum", {
    sameSchool: true, brief: { financeInterest: "wealth management or maybe banking", wantToLearn: "whether it's too late to recruit as a senior" },
  }),
  sc(next(), "cold_email", MARCO, R("Andrew Liu", "Tillman Gray", "Associate", { contactSchool: "Vanderbilt University" }), "Master's alum", {
    sameSchool: true, brief: { financeInterest: "financial due diligence into PE", wantToLearn: "how he moved from Big 4 to the deal side" },
  }),
  sc(next(), "cold_email", RUBEN, R("Isabel Cruz", "Keswick & Lowe", "Analyst", { contactSchool: "UC Berkeley", contactBackground: "Transferred from Pasadena City College" }), "transfer to transfer alum", {
    sameSchool: true, brief: { financeInterest: "middle market M&A", wantToLearn: "how she recruited after transferring", specificReason: "we both transferred from community colleges" },
  }),
  sc(next(), "cold_email", JADE, R("Megan Doyle", "Blue Ash Advisors", "Senior Associate", { contactSchool: "Rutgers University" }), "Gmail signature, terse", {
    sameSchool: true, gmailSignature: true, brief: { financeInterest: "TAS" },
  }),
  sc(next(), "cold_email", NO_RESUME(MAYA), R("Will Foster", "Calloway Brothers", "Analyst", { contactSchool: "Duke University" }), "no resume on file", {
    sameSchool: true, brief: { financeInterest: "restructuring", wantToLearn: "what first-years actually do" },
  }),
  sc(next(), "cold_email", DANIEL, R("Ray Chen", "Stonebrook Capital", "Managing Director", { contactSchool: "UCLA" }), "MD recipient, student flatters too much", {
    sameSchool: true, brief: { financeInterest: "credit", wantToLearn: "tell him he's a legend and I've followed his whole career and would love any time at all" },
  }),
  sc(next(), "cold_email", AISHA, R("Nadia Shah", "Larchmont Securities", "Vice President", { contactSchool: "Northwestern University" }), "MBA alum, prior career", {
    sameSchool: true, brief: { financeInterest: "healthcare investment banking", wantToLearn: "how former operators fit on a coverage team" },
  }),

  // cold after meeting
  sc(next(), "cold_after_meeting", TENDAI, R("Ian Brody", "Harbor Row Capital", "Vice President"), "met on a flight", {
    fields: { metAt: "on the flight from Johannesburg to New York last week", talkedAbout: "infrastructure funds in southern Africa", stuckWithYou: "that power projects fail on currency, not engineering" },
  }),
  sc(next(), "cold_after_meeting", HANNAH, R("Greta Lund", "Everly Park Partners", "Associate"), "met at a wedding, lowercase", {
    fields: { metAt: "my cousin's wedding saturday", talkedAbout: "she laughed at my history major thing and said she did art history" },
  }),
  sc(next(), "cold_after_meeting", JADE, R("Dev Patel", "Northgate Securities", "Analyst"), "Gmail signature, met at club event", {
    gmailSignature: true, fields: { metAt: "the Women in Business mock interview night", talkedAbout: "how he prepped accounting questions", stuckWithYou: "walk the statements out loud every morning" },
  }),
  sc(next(), "cold_after_meeting", MARCO, R("Oliver Grant", "Tillman Gray", "Principal"), "met at a golf outing, verbose", {
    fields: { metAt: "the Owen alumni golf scramble at Hermitage last Friday, we were in the same foursome", talkedAbout: "we talked about his time at a Big 4 firm and the audit to diligence to PE path, and also about how bad both of us are at golf, he lost like six balls on the back nine", stuckWithYou: "he said the diligence people who do best are the ones who question management's numbers without sounding accusatory" },
  }),
  sc(next(), "cold_after_meeting", RUBEN, R("Lucia Moreno", "Summit Hollow Capital", "Vice President"), "he said to email", {
    fields: { metAt: "the Haas speaker series Tuesday", talkedAbout: "family businesses and succession" }, extraContext: "she told me to email her about the sophomore program",
  }),

  // cold not alum
  sc(next(), "cold_not_alum", HANNAH, R("Rob Tierney", "Calloway Brothers", "Director", { contactBackground: "History PhD dropout turned restructuring banker" }), "found via a newsletter", {
    fields: { howFound: "his interview in the Restructuring Weekly newsletter", whyThem: "he left a history PhD for restructuring" },
  }),
  sc(next(), "cold_not_alum", TENDAI, R("Ama Boateng", "Stonebrook Capital", "Associate"), "found via LinkedIn group", {
    fields: { howFound: "the African Finance Professionals LinkedIn group", whyThem: "she moved from Accra to New York for PE and posts about sponsorship" },
  }),
  sc(next(), "cold_not_alum", JADE, R("Kate Morgan", "Harbor Row Capital", "Vice President"), "Gmail signature, lowercase", {
    gmailSignature: true, fields: { howFound: "podcast", whyThem: "cpa to banking" },
  }),
  sc(next(), "cold_not_alum", MARCO, R("Sean Wu", "Everly Park Partners", "Vice President"), "found via a book", {
    fields: { howFound: "the acknowledgments of a quality of earnings textbook he co-wrote", whyThem: "he wrote the chapter on working capital adjustments I used in audit" },
  }),
  sc(next(), "cold_not_alum", NO_RESUME(RUBEN), R("Anne Beck", "Keswick & Lowe"), "outside contact, no resume", {
    fields: { howFound: "her LinkedIn post about family business sales", whyThem: "my family runs an auto shop" },
  }),

  // cold referral
  sc(next(), "cold_referral", TENDAI, R("Hassan Karimi", "Northgate Securities", "Associate"), "professor referral", {
    fields: { referrerName: "Dr. Mira Kovac", referrerContext: "my probability professor, she taught Hassan's section in 2022" },
  }),
  sc(next(), "cold_referral", HANNAH, R("Philip Sato", "Everly Park Partners", "Vice President"), "roommate's dad, informal", {
    fields: { referrerName: "my roommate Emma's dad", referrerContext: "they worked together at a bank 10 years ago" },
  }),
  sc(next(), "cold_referral", JADE, R("Leah Kim", "Blue Ash Advisors", "Manager"), "Gmail signature, club alum", {
    gmailSignature: true, fields: { referrerName: "Megan Doyle", referrerContext: "former Women in Business president, now at Blue Ash" },
  }),
  sc(next(), "cold_referral", AISHA, R("Tomas Varga", "Stonebrook Capital", "Vice President"), "MBA, classmate referral", {
    fields: { referrerName: "my classmate Priya Menon", referrerContext: "she interned with him last summer and said he's the person to ask about healthcare services" },
  }),
  sc(next(), "cold_referral", DANIEL, R("Joe Park", "Crestline Advisors", "Associate"), "referral by someone who barely knows him", {
    fields: { referrerName: "a guy at my gym, Luis", referrerContext: "idk how well they know each other honestly" },
  }),

  // recruiting inbox
  sc(next(), "recruiting_inbox", TENDAI, R("Northgate Securities Campus Recruiting", "Northgate Securities"), "sponsorship eligibility", {
    fields: { program: "2027 Summer Analyst Program", inboxContext: "I'm on an F-1 visa and will need H-1B sponsorship full time", inboxQuestion: "whether international students are eligible and sponsored" },
  }),
  sc(next(), "recruiting_inbox", HANNAH, R("Pemberton Trust Early Careers", "Pemberton Trust"), "late senior asking about off-cycle", {
    fields: { program: "2027 Full-Time Analyst", inboxContext: "i'm a senior who just decided on finance, applications look closed", inboxQuestion: "are there off cycle or spring roles" },
  }),
  sc(next(), "recruiting_inbox", RUBEN, R("Summit Hollow Recruiting", "Summit Hollow Capital"), "transfer, class year question", {
    fields: { program: "Sophomore Insight Program", inboxContext: "I transferred this fall with junior standing by credits but it's my first year at Berkeley", inboxQuestion: "do I apply as a sophomore or a junior" },
  }),
  sc(next(), "recruiting_inbox", JADE, R("Blue Ash Talent Team", "Blue Ash Advisors"), "Gmail signature, application portal error", {
    gmailSignature: true, fields: { program: "Junior Summer Transaction Advisory (JR-2231)", inboxContext: "portal crashed when I hit submit on September 14", inboxQuestion: "did it go through" },
  }),
  sc(next(), "recruiting_inbox", MARCO, R("Tillman Gray Recruiting", "Tillman Gray"), "Master's: which program", {
    fields: { program: "2027 Analyst and Associate programs", inboxContext: "I'm finishing an MSF after three years in audit", inboxQuestion: "which program I should apply to" },
  }),
  sc(next(), "recruiting_inbox", DANIEL, R("Golden State Credit Careers", "Golden State Credit"), "rude input", {
    fields: { program: "Full Time Analyst", inboxContext: "applied 3 weeks ago heard NOTHING", inboxQuestion: "whats going on with my app" },
  }),

  // follow ups
  sc(next(), "follow_up_1", TENDAI, R("Kwame Mensah", "Northgate Securities", "Associate"), "from Offerly cold email", {
    brief: { originalSubject: "NYU Student Interested in Cross-Border M&A", originalDate: "5 days ago", originalTypeLabel: "Cold email: alum", originalBody: "Hi Kwame,\n\nMy name is Tendai Moyo, and I am a junior at NYU studying finance and mathematics. I found your contact through the NYU alumni database...\n\nWould you have 10 minutes for a call?\n\nBest,\nTendai Moyo" },
  }),
  sc(next(), "follow_up_1", HANNAH, R("Julia Park", "Pemberton Trust", "Vice President"), "manual, anxious input", {
    brief: { originalSubject: "Boston College Senior Seeking Advice", originalDate: "9/12", originalAsk: "a call, and I'm worried I sounded desperate" },
  }),
  sc(next(), "follow_up_1", JADE, R("Megan Doyle", "Blue Ash Advisors", "Senior Associate"), "Gmail signature, no date", {
    gmailSignature: true, brief: { originalSubject: "Rutgers Junior Interested in Transaction Advisory" },
  }),
  sc(next(), "follow_up_1", MARCO, R("Andrew Liu", "Tillman Gray", "Associate"), "manual clean", {
    brief: { originalSubject: "Vanderbilt MSF Student With an Audit Background", originalDate: "September 14", originalAsk: "10 minute call" },
  }),
  sc(next(), "follow_up_2", TENDAI, R("Kwame Mensah", "Northgate Securities", "Associate"), "Offerly chain", {
    brief: { originalSubject: "NYU Student Interested in Cross-Border M&A", originalDate: "2 weeks ago", originalTypeLabel: "Cold email: alum", followUp1Date: "last week" },
  }),
  sc(next(), "follow_up_2", HANNAH, R("Julia Park", "Pemberton Trust", "Vice President"), "senior, time pressure", {
    brief: { originalSubject: "Boston College Senior Seeking Advice", originalDate: "September 1", followUp1Date: "September 9", originalAsk: "call" }, extraContext: "the Pemberton application closes October 1",
  }),
  sc(next(), "follow_up_2", RUBEN, R("Isabel Cruz", "Keswick & Lowe", "Analyst"), "lowercase", {
    brief: { originalSubject: "Berkeley Transfer Student Question", originalDate: "like 2 weeks", followUp1Date: "a week ago" },
  }),
  sc(next(), "follow_up_2", AISHA, R("Nadia Shah", "Larchmont Securities", "Vice President"), "Gmail signature", {
    gmailSignature: true, brief: { originalSubject: "Kellogg MBA Interested in Healthcare Coverage", originalDate: "September 2", followUp1Date: "September 10" },
  }),
  sc(next(), "recruiting_inbox_follow_up", TENDAI, R("Northgate Securities Campus Recruiting", "Northgate Securities"), "sponsorship follow-up", {
    fields: { threadSubject: "International Student Eligibility, 2027 Summer Analyst", originalSent: "September 8", program: "2027 Summer Analyst Program", inboxQuestion: "whether international students are sponsored" },
  }),
  sc(next(), "recruiting_inbox_follow_up", HANNAH, R("Pemberton Trust Early Careers", "Pemberton Trust"), "off-cycle follow-up", {
    fields: { threadSubject: "Boston College Senior, Off-Cycle Roles", originalSent: "Sept 5", program: "2027 Full-Time Analyst", inboxQuestion: "off-cycle roles" },
  }),
  sc(next(), "recruiting_inbox_follow_up", RUBEN, R("Summit Hollow Recruiting", "Summit Hollow Capital"), "class year follow-up, Gmail sig", {
    gmailSignature: true, fields: { threadSubject: "Transfer Student Class Year Question", originalSent: "September 9", program: "Sophomore Insight Program", inboxQuestion: "apply as sophomore or junior" },
  }),
  sc(next(), "recruiting_inbox_follow_up", DANIEL, R("Golden State Credit Careers", "Golden State Credit"), "angry input", {
    fields: { threadSubject: "Application Status", originalSent: "aug 30", program: "Full Time Analyst", inboxQuestion: "STILL nothing, need an answer" },
  }),
  sc(next(), "interview_check_in", TENDAI, R("Ivy Chen", "Northgate Securities", "Recruiter"), "first check-in", {
    fields: { interviewRole: "Summer Analyst, Cross-Border M&A", interviewDate: "September 4", interviewDetail: "the case on a Kenyan telecom carve-out", lastCheckIn: "no" },
  }),
  sc(next(), "interview_check_in", HANNAH, R("Molly Grant", "Pemberton Trust", "Recruiter"), "competing deadline, anxious", {
    fields: { interviewRole: "Full-Time Analyst", interviewDate: "Sept 10", otherDeadline: "nonprofit fellowship needs an answer by Sept 25", lastCheckIn: "no" },
  }),
  sc(next(), "interview_check_in", MARCO, R("Andrew Liu", "Tillman Gray", "Associate"), "final check-in, Gmail sig", {
    gmailSignature: true, fields: { interviewRole: "Associate, Transaction Services", interviewDate: "August 28", interviewDetail: "working capital pegs", threadSubject: "Thank You", lastCheckIn: "yes" },
  }),
  sc(next(), "interview_check_in", JADE, R("Tara Wells", "Blue Ash Advisors", "Talent Acquisition Partner"), "terse", {
    fields: { interviewRole: "junior summer TAS", interviewDate: "9/8" },
  }),

  // after they reply
  sc(next(), "call_scheduling", TENDAI, R("Kwame Mensah", "Northgate Securities", "Associate"), "can make proposed time, Zoom", {
    brief: { originalSubject: "NYU Student Interested in Cross-Border M&A" }, fields: { canMakeIt: "yes", proposedTime: "Tuesday at 6:30 pm", timeZone: "Eastern", callFormat: "zoom" },
  }),
  sc(next(), "call_scheduling", HANNAH, R("Julia Park", "Pemberton Trust", "Vice President"), "can't make proposed time", {
    brief: { originalSubject: "Boston College Senior Seeking Advice" }, fields: { canMakeIt: "no", proposedTime: "Wednesday 2pm", availability: "Wednesday after 4, Thursday before noon, Friday any time", timeZone: "Eastern", callFormat: "phone" },
  }),
  sc(next(), "call_scheduling", RUBEN, R("Isabel Cruz", "Keswick & Lowe", "Analyst"), "Pacific, she's in New York", {
    brief: { originalSubject: "Berkeley Transfer Student Question" }, fields: { canMakeIt: "none", availability: "weekdays 7-9am my time, or after 5pm", timeZone: "Pacific", callFormat: "either" },
  }),
  sc(next(), "call_scheduling", JADE, R("Megan Doyle", "Blue Ash Advisors", "Senior Associate"), "Gmail signature, in person", {
    gmailSignature: true, brief: { originalSubject: "Rutgers Junior Interested in Transaction Advisory" }, fields: { canMakeIt: "yes", proposedTime: "Friday noon at their Newark office", callFormat: "in_person" },
  }),
  sc(next(), "call_scheduling", AISHA, R("Nadia Shah", "Larchmont Securities", "Vice President"), "verbose availability", {
    brief: { originalSubject: "Kellogg MBA Interested in Healthcare Coverage" }, fields: { canMakeIt: "none", availability: "Monday I have class until 3 then free, Tuesday is all booked with recruiting stuff, Wednesday morning is open before 11, Thursday I'm flying to New York so maybe the airport around 1, Friday is fine all day", timeZone: "Central", callFormat: "phone" },
  }),
  sc(next(), "reschedule_call", TENDAI, R("Kwame Mensah", "Northgate Securities", "Associate"), "they moved it", {
    fields: { rescheduleAction: "they_moved", callTime: "Tuesday at 6:30 pm", newWindows: "Wednesday or Thursday after 5", timeZone: "Eastern", threadSubject: "Call on Tuesday" },
  }),
  sc(next(), "reschedule_call", HANNAH, R("Julia Park", "Pemberton Trust", "Vice President"), "missed the call", {
    fields: { rescheduleAction: "missed", callTime: "this morning at 11", rescheduleReason: "i overslept honestly", timeZone: "Eastern" },
  }),
  sc(next(), "reschedule_call", RUBEN, R("Isabel Cruz", "Keswick & Lowe", "Analyst"), "missed, verbose excuse", {
    fields: { rescheduleAction: "missed", callTime: "yesterday 5pm", rescheduleReason: "my phone died on BART and then the train got stuck in the tunnel for 40 minutes and I had no signal and by the time I got out it was 5:50 and I felt terrible", newWindows: "any time this week", timeZone: "Pacific" },
  }),
  sc(next(), "reschedule_call", JADE, R("Megan Doyle", "Blue Ash Advisors", "Senior Associate"), "Gmail signature, reschedule for exam", {
    gmailSignature: true, fields: { rescheduleAction: "reschedule", callTime: "Thursday at noon", rescheduleReason: "tax exam moved", newWindows: "Friday morning or Monday afternoon", timeZone: "Eastern" },
  }),
  sc(next(), "reschedule_call", AISHA, R("Nadia Shah", "Larchmont Securities", "Vice President"), "they moved it, no windows", {
    fields: { rescheduleAction: "they_moved", callTime: "Friday 9am Central", timeZone: "Central" },
  }),
  sc(next(), "recruiter_scheduling_reply", TENDAI, R("Ivy Chen", "Northgate Securities", "Recruiter"), "confirm superday, travel from NYU", {
    fields: { slotResponse: "confirm", offeredSlot: "Friday, October 16 at 9:00 a.m.", interviewFormat: "in_person", timeZone: "Eastern", logistics: "which entrance and do I need ID" },
  }),
  sc(next(), "recruiter_scheduling_reply", HANNAH, R("Molly Grant", "Pemberton Trust", "Recruiter"), "different slot, lowercase", {
    fields: { slotResponse: "different", offeredSlot: "tues 10/6 10am", interviewFormat: "virtual", timeZone: "Eastern", conflictReason: "thesis defense practice", availability: "wed 10/7 any time, thurs 10/8 morning" },
  }),
  sc(next(), "recruiter_scheduling_reply", MARCO, R("Tillman Gray Recruiting", "Tillman Gray"), "confirm phone round to team, resume requested", {
    fields: { slotResponse: "confirm", offeredSlot: "Monday, September 28 at 3:30 p.m.", interviewFormat: "phone", timeZone: "Central", materials: "updated resume" },
  }),
  sc(next(), "recruiter_scheduling_reply", RUBEN, R("Kim Duarte", "Summit Hollow Capital", "Campus Recruiter"), "Gmail signature, confirm", {
    gmailSignature: true, fields: { slotResponse: "confirm", offeredSlot: "Wednesday October 7, 1pm", interviewFormat: "virtual", timeZone: "Pacific" },
  }),

  // after a conversation
  sc(next(), "thank_you_chat", TENDAI, R("Kwame Mensah", "Northgate Securities", "Associate"), "sponsorship talk", {
    brief: { meetingWhen: "last night", conversationDetails: "he explained raising sponsorship after the offer, not before", nextStepAsk: "who_else" },
  }),
  sc(next(), "thank_you_chat", HANNAH, R("Julia Park", "Pemberton Trust", "Vice President"), "harsh advice", {
    brief: { meetingWhen: "this afternoon", conversationDetails: "she said honestly banking is probably out of reach this year and I should look at wealth management or a year in consulting first", nextStepAsk: "none" },
  }),
  sc(next(), "thank_you_chat", RUBEN, R("Isabel Cruz", "Keswick & Lowe", "Analyst"), "ran long and personal", {
    brief: { meetingWhen: "today", conversationDetails: "was supposed to be 15 min, went an hour, we talked about both our dads' businesses and she teared up talking about hers closing", nextStepAsk: "intro", introName: "her staffer Kevin", introReason: "he covers auto aftermarket deals" },
  }),
  sc(next(), "thank_you_chat", JADE, R("Megan Doyle", "Blue Ash Advisors", "Senior Associate"), "Gmail signature, terse", {
    gmailSignature: true, brief: { meetingWhen: "friday", conversationDetails: "TAS vs audit", nextStepAsk: "none" },
  }),
  sc(next(), "thank_you_chat", MARCO, R("Andrew Liu", "Tillman Gray", "Associate"), "verbose details", {
    brief: { meetingWhen: "this morning", conversationDetails: "we covered how he moved from Big 4 to Tillman, why quality of earnings is more judgment than math, the working capital peg fights on his last deal, how he studied for the transaction services case, and that he still keeps his audit workpapers habits", nextStepAsk: "who_else" },
  }),
  sc(next(), "thank_you_chat", AISHA, R("Nadia Shah", "Larchmont Securities", "Vice President"), "student input includes gossip (should keep private)", {
    brief: { meetingWhen: "yesterday", conversationDetails: "healthcare team staffing, and she privately told me the team lead is leaving in December", nextStepAsk: "none" },
  }),
  sc(next(), "thank_you_offered_help", TENDAI, R("Kwame Mensah", "Northgate Securities", "Associate"), "offered to flag application", {
    fields: { offerType: "flag", conversationDetail: "raising sponsorship at the offer stage", applicationRef: "applied September 15, req NG-4410" },
  }),
  sc(next(), "thank_you_offered_help", HANNAH, R("Julia Park", "Pemberton Trust", "Vice President"), "offered intro to wealth team", {
    fields: { offerType: "intro", conversationDetail: "that wealth management rewards people who can explain things simply", introTarget: "Marcus on the private wealth team" },
  }),
  sc(next(), "thank_you_offered_help", JADE, R("Megan Doyle", "Blue Ash Advisors", "Senior Associate"), "Gmail signature, resume pass along", {
    gmailSignature: true, fields: { offerType: "resume", conversationDetail: "tax skills matter in diligence more than people think" },
  }),
  sc(next(), "thank_you_offered_help", NO_RESUME(RUBEN), R("Isabel Cruz", "Keswick & Lowe", "Analyst"), "resume offer, no resume on file", {
    fields: { offerType: "resume", conversationDetail: "how she prepped for sophomore interviews", applicationRef: "haven't applied yet" },
  }),
  sc(next(), "thank_you_event", TENDAI, R("Adaeze Obi", "Northgate Securities", "Vice President"), "panel, who else", {
    fields: { eventName: "the NYU Stern Africa Business Forum panel on Saturday", remarkPoint: "deals in frontier markets are won on relationships built years earlier", eventAsk: "who_else" },
  }),
  sc(next(), "thank_you_event", HANNAH, R("Rob Tierney", "Calloway Brothers", "Director"), "lowercase", {
    fields: { eventName: "bc history dept careers night", remarkPoint: "restructuring is just history with spreadsheets", yourQuestion: "i asked if seniors can still get in", eventAsk: "call" },
  }),
  sc(next(), "thank_you_event", JADE, R("Leah Kim", "Blue Ash Advisors", "Manager"), "Gmail signature", {
    gmailSignature: true, fields: { eventName: "the Blue Ash lunch-and-learn at Rutgers", remarkPoint: "every diligence finding should end with a dollar number", eventAsk: "none" },
  }),
  sc(next(), "thank_you_event", MARCO, R("Sean Wu", "Everly Park Partners", "Vice President"), "verbose", {
    fields: { eventName: "Owen's private equity speaker series last Thursday night in the Management Hall auditorium", remarkPoint: "he talked for a while about how operating partners and deal teams fight over the 100-day plan, and how the best deal teams give the operating partners a seat in diligence rather than after close, which was the opposite of what I'd assumed from the audit side", yourQuestion: "I asked how he evaluates management teams in founder-owned businesses", eventAsk: "call" },
  }),
  sc(next(), "keep_in_touch", TENDAI, R("Kwame Mensah", "Northgate Securities", "Associate"), "update with advice followed", {
    fields: { lastSpoke: "in September before my first round", updateSince: "I got the Northgate summer offer", adviceFollowed: "I raised sponsorship at the offer stage like he said" },
  }),
  sc(next(), "keep_in_touch", HANNAH, R("Rob Tierney", "Calloway Brothers", "Director"), "no big news", {
    fields: { lastSpoke: "october", updateSince: "nothing major, still finishing thesis and applying" },
  }),
  sc(next(), "keep_in_touch", JADE, R("Megan Doyle", "Blue Ash Advisors", "Senior Associate"), "Gmail signature, holiday note", {
    gmailSignature: true, fields: { lastSpoke: "our coffee in the spring", updateSince: "I'm spending the winter doing tax season again at Lindqvist", theirNews: "she got promoted to manager" },
  }),
  sc(next(), "keep_in_touch", MARCO, R("Andrew Liu", "Tillman Gray", "Associate"), "verbose", {
    fields: { lastSpoke: "back in July, when he spent 30 minutes walking me through the audit-to-diligence path", updateSince: "I passed CFA Level I in August, started the MSF program, and I'm the VP of the Owen finance club's diligence practice group which I started because of our conversation", adviceFollowed: "I built a practice quality of earnings workbook on a public company like he suggested" },
  }),
  sc(next(), "close_loop_referrer", TENDAI, R("Dr. Mira Kovac", "New York University"), "call happened, professor", {
    fields: { introducedTo: "Hassan Karimi", loopStage: "call", learnedOrUpdate: "he told me how to handle the sponsorship question in interviews", nextForYou: "applying to Northgate next week" },
  }),
  sc(next(), "close_loop_referrer", HANNAH, R("Emma's dad, Paul Wright", "Wright Capital"), "outside contact, interview", {
    fields: { introducedTo: "Philip Sato", loopStage: "interview", learnedOrUpdate: "got a first round at Everly Park on October 5" },
  }),
  sc(next(), "close_loop_referrer", JADE, R("Megan Doyle", "Blue Ash Advisors", "Senior Associate"), "Gmail signature, no offer", {
    gmailSignature: true, fields: { introducedTo: "Leah Kim", loopStage: "no", learnedOrUpdate: "didn't make the superday but Leah said reapply for full time" },
  }),
  sc(next(), "close_loop_referrer", AISHA, R("Priya Menon", "Kellogg School of Management", "MBA Classmate"), "classmate, offer", {
    fields: { introducedTo: "Tomas Varga", loopStage: "offer", learnedOrUpdate: "signed Stonebrook's summer associate offer in healthcare services" },
  }),
  sc(next(), "referral_ask", TENDAI, R("Kwame Mensah", "Northgate Securities", "Associate"), "first ask", {
    fields: { askStage: "first", pastConversations: "two calls, one in August and one in September about sponsorship", roleAndReq: "2027 Summer Analyst, NG-4410, applied September 15" },
  }),
  sc(next(), "referral_ask", SOFIA, R("Marcus Lee", "Ironbridge Capital", "Vice President"), "different firm", {
    fields: { askStage: "other_firm", pastConversations: "three conversations since June; he mentioned his former colleague Dana Reyes runs recruiting at Redwood Forge", roleAndReq: "Redwood Forge Summer Associate, Industrials" },
  }),
  sc(next(), "referral_ask", HANNAH, R("Julia Park", "Pemberton Trust", "Vice President"), "only one short call (should note)", {
    fields: { askStage: "first", pastConversations: "one 10 minute call last week", roleAndReq: "Full-Time Analyst, closes Oct 1" },
  }),
  sc(next(), "referral_ask", RUBEN, R("Isabel Cruz", "Keswick & Lowe", "Analyst"), "Gmail signature, follow-up", {
    gmailSignature: true, fields: { askStage: "followup", pastConversations: "she said she'd send my resume to the sophomore program lead 10 days ago", roleAndReq: "Sophomore Summer Analyst", threadSubject: "Sophomore Program Application" },
  }),

  // interviews
  sc(next(), "thank_you_interview", TENDAI, R("Ivy Chen", "Northgate Securities", "Recruiter"), "sponsorship came up", {
    brief: { meetingWhen: "this morning", interviewTeam: "Northgate cross-border M&A", conversationDetails: "the telecom carve-out case, and she asked about my visa status" },
  }),
  sc(next(), "thank_you_interview", HANNAH, R("Philip Sato", "Everly Park Partners", "Vice President"), "bad answer clarification", {
    brief: { meetingWhen: "today", interviewTeam: "Everly Park analyst program", conversationDetails: "we talked about his switch from English lit" }, fields: { clarification: "I blanked on how depreciation flows through the cash flow statement; it gets added back because it's non-cash" },
  }),
  sc(next(), "thank_you_interview", RUBEN, R("Lucia Moreno", "Summit Hollow Capital", "Vice President"), "transfer, personal connection", {
    brief: { meetingWhen: "this afternoon", interviewTeam: "Summit Hollow sophomore program", conversationDetails: "her family's restaurant sale", personalConnection: "my family's auto shop" },
  }),
  sc(next(), "thank_you_interview", JADE, R("Leah Kim", "Blue Ash Advisors", "Manager"), "Gmail signature, over-long clarification (should trim)", {
    gmailSignature: true, brief: { meetingWhen: "yesterday", interviewTeam: "Blue Ash TAS", conversationDetails: "net working capital" }, fields: { clarification: "when she asked about deferred revenue I said it was an asset, which is wrong, it's a liability, and I also mixed up how it affects working capital, and then I also didn't explain accrued expenses well and I think I rambled about my tax job for too long" },
  }),
  sc(next(), "thank_you_interview", MARCO, R("Oliver Grant", "Tillman Gray", "Principal"), "terse", {
    brief: { meetingWhen: "today", interviewTeam: "TG associate", conversationDetails: "golf, QoE" },
  }),
  sc(next(), "thank_you_superday", TENDAI, R("Hassan Karimi", "Northgate Securities", "Associate"), "second interviewer in the room", {
    fields: { whenInterviewed: "today", onlyDetail: "his question about hedging rand exposure", secondInterviewer: "Maria", meetingLength: "interview" },
  }),
  sc(next(), "thank_you_superday", HANNAH, R("Philip Sato", "Everly Park Partners", "Vice President"), "brief lunch", {
    fields: { whenInterviewed: "today at lunch", onlyDetail: "the sandwiches from the place on Newbury, and his daughter starting at BC", meetingLength: "brief" },
  }),
  sc(next(), "thank_you_superday", RUBEN, R("Diana Reyes", "Keswick & Lowe", "Analyst"), "Gmail signature, lowercase", {
    gmailSignature: true, fields: { whenInterviewed: "this morning", onlyDetail: "she asked how i'd value a car wash", otherNotes: "wrote to sam about the family business stuff" },
  }),
  sc(next(), "thank_you_superday", AISHA, R("Tomas Varga", "Stonebrook Capital", "Vice President"), "MBA, harsh interview", {
    fields: { whenInterviewed: "yesterday", onlyDetail: "he pushed hard on my LBO math and I got the exit multiple wrong", meetingLength: "interview" },
  }),
  sc(next(), "thank_you_phone_screen", TENDAI, R("Ivy Chen", "Northgate Securities", "Recruiter"), "date known, time unclear", {
    fields: { usefulExplanation: "how the cross-border group splits from coverage", stillUnclear: "the time and whether it's Zoom", nextStep: "first round on October 2" },
  }),
  sc(next(), "thank_you_phone_screen", HANNAH, R("Molly Grant", "Pemberton Trust", "Recruiter"), "redirected to another group", {
    fields: { usefulExplanation: "that wealth management is a better fit for a late switcher", redirected: "yes" },
  }),
  sc(next(), "thank_you_phone_screen", JADE, R("Tara Wells", "Blue Ash Advisors", "Talent Acquisition Partner"), "Gmail signature", {
    gmailSignature: true, fields: { usefulExplanation: "the two-week diligence rotation", nextStep: "superday October 2 in Newark" },
  }),
  sc(next(), "thank_you_phone_screen", MARCO, R("Hugh Barlow", "Stonebrook Capital", "Recruiter"), "lowercase", {
    fields: { usefulExplanation: "msf grads come in as analysts but get promoted faster", nextStep: "he'll email about round 1" },
  }),
  sc(next(), "recorded_round_note", TENDAI, R("Ivy Chen", "Northgate Securities", "Recruiter"), "live round, didn't catch the name", {
    fields: { roundType: "live_unnamed", completedWhen: "this afternoon", roundContent: "a markets question on the rand" },
  }),
  sc(next(), "recorded_round_note", HANNAH, R("Pemberton Trust Early Careers", "Pemberton Trust"), "timed test to a team", {
    fields: { roundType: "timed_test", completedWhen: "tonight", roundContent: "a 90-minute modeling test, uploaded the Excel file" },
  }),
  sc(next(), "recorded_round_note", RUBEN, R("Kim Duarte", "Summit Hollow Capital", "Campus Recruiter"), "recorded, Gmail sig, lowercase", {
    gmailSignature: true, fields: { roundType: "recorded", completedWhen: "last night", roundContent: "why summit hollow, tell me about a mistake" },
  }),
  sc(next(), "recorded_round_note", JADE, R("Tara Wells", "Blue Ash Advisors", "Talent Acquisition Partner"), "recorded, tech issue", {
    fields: { roundType: "recorded", completedWhen: "this morning" }, extraContext: "my video froze during question 3 but it let me keep going",
  }),

  // offers & decisions
  sc(next(), "after_rejection", TENDAI, R("Ivy Chen", "Northgate Securities", "Recruiter"), "sponsorship was the reason", {
    fields: { roleName: "2027 Summer Analyst", takeaway: "they said sponsorship was the limiting factor this year", stageReached: "first_round" },
  }),
  sc(next(), "after_rejection", HANNAH, R("Philip Sato", "Everly Park Partners", "Vice President"), "bitter input", {
    fields: { roleName: "Analyst", takeaway: "honestly feel like they never gave a history major a real shot", stageReached: "superday", peopleMet: "Philip and Greta" },
  }),
  sc(next(), "after_rejection", JADE, R("Blue Ash Talent Team", "Blue Ash Advisors"), "Gmail signature, application stage", {
    gmailSignature: true, fields: { roleName: "Junior Summer TAS", takeaway: "want to know what to improve for full time", stageReached: "application" },
  }),
  sc(next(), "after_rejection", MARCO, R("Oliver Grant", "Tillman Gray", "Principal"), "final round, gracious", {
    fields: { roleName: "Associate, Transaction Services", takeaway: "the case showed me I need to be quicker structuring a QoE bridge", stageReached: "superday", peopleMet: "Oliver and Andrew" },
  }),
  sc(next(), "offer_extension", TENDAI, R("Ivy Chen", "Northgate Securities", "Recruiter"), "asking, sponsorship confirmation pending", {
    fields: { extensionStage: "asking", extensionAskee: "recruiter", roleName: "2027 Summer Analyst", currentDeadline: "October 1", requestedDate: "October 8", extensionReason: "waiting for my school's international office to confirm CPT paperwork" },
  }),
  sc(next(), "offer_extension", HANNAH, R("Molly Grant", "Pemberton Trust", "Recruiter"), "they said no", {
    fields: { extensionStage: "said_no", extensionAskee: "recruiter", roleName: "Full-Time Analyst", currentDeadline: "September 30" },
  }),
  sc(next(), "offer_extension", SOFIA, R("Marcus Lee", "Ironbridge Capital", "Vice President"), "asking the team member", {
    fields: { extensionStage: "asking", extensionAskee: "team_member", roleName: "Summer Associate, Industrials", currentDeadline: "October 2", requestedDate: "October 9", extensionReason: "final round elsewhere October 7" },
  }),
  sc(next(), "offer_extension", RUBEN, R("Kim Duarte", "Summit Hollow Capital", "Campus Recruiter"), "already accepted (should not write request)", {
    fields: { extensionStage: "asking", extensionAskee: "recruiter", roleName: "Sophomore Program", currentDeadline: "already signed last week", requestedDate: "October 15", extensionReason: "got a better offer from Keswick" },
  }),
  sc(next(), "offer_extension", JADE, R("Tara Wells", "Blue Ash Advisors", "Talent Acquisition Partner"), "Gmail signature, lowercase", {
    gmailSignature: true, fields: { extensionStage: "asking", extensionAskee: "recruiter", roleName: "junior summer TAS", currentDeadline: "9/28", requestedDate: "10/5", extensionReason: "waiting on one more process" },
  }),
  sc(next(), "accept_offer", TENDAI, R("Ivy Chen", "Northgate Securities", "Recruiter"), "confirming verbal acceptance", {
    fields: { roleName: "2027 Summer Analyst, Cross-Border M&A", startDate: "June 7, 2027", acceptedOnCall: "yes", thankPeople: "Hassan and Maria" },
  }),
  sc(next(), "accept_offer", HANNAH, R("Molly Grant", "Pemberton Trust", "Recruiter"), "late senior, emotional", {
    fields: { roleName: "Full-Time Analyst, Private Wealth", startDate: "July 2027", thankPeople: "Julia Park" }, extraContext: "I'm so so happy, I thought this wasn't going to happen for me",
  }),
  sc(next(), "accept_offer", MARCO, R("Tillman Gray Recruiting", "Tillman Gray"), "to a team, paperwork", {
    fields: { roleName: "Associate, Transaction Services", startDate: "August 2, 2027", paperwork: "background check form submitted today" },
  }),
  sc(next(), "accept_offer", JADE, R("Tara Wells", "Blue Ash Advisors", "Talent Acquisition Partner"), "Gmail signature, terse", {
    gmailSignature: true, fields: { roleName: "junior summer TAS", startDate: "june" },
  }),
  sc(next(), "decline_offer", TENDAI, R("Kim Duarte", "Summit Hollow Capital", "Campus Recruiter"), "decline over sponsorship", {
    fields: { roleName: "2027 Summer Analyst", declineReason: "Summit Hollow can't sponsor full-time and I need a path to sponsorship" },
  }),
  sc(next(), "decline_offer", HANNAH, R("Carmen Ruiz", "Ironbound Learning", "Program Director"), "declining non-finance return offer", {
    fields: { roleName: "Program Manager, Ironbound Learning", declineReason: "I accepted a finance role", returnOffer: "yes", thankPeople: "the summer fellows team" },
  }),
  sc(next(), "decline_offer", RUBEN, R("Lucia Moreno", "Summit Hollow Capital", "Vice President"), "student wants to say the firm is worse (should not)", {
    fields: { roleName: "Sophomore Summer Analyst", declineReason: "keswick pays more and is a better brand honestly" },
  }),
  sc(next(), "decline_offer", MARCO, R("Hugh Barlow", "Stonebrook Capital", "Recruiter"), "location reason, Gmail sig", {
    gmailSignature: true, fields: { roleName: "Analyst, Nashville office", declineReason: "I'm relocating to Chicago for family" },
  }),
  sc(next(), "custom", TENDAI, R("International Student Office", "New York University"), "custom to a school office about CPT", {
    purpose: "ask the international office how fast they can issue CPT authorization for a summer internship offer, deadline in 2 weeks",
  }),
  sc(next(), "custom", HANNAH, R("Julia Park", "Pemberton Trust", "Vice President"), "custom: ask to shadow for a day", {
    purpose: "ask julia if I could shadow her for a day over winter break to see what wealth advisors actually do",
  }),
  sc(next(), "custom", RUBEN, R("Emily Tran", "Michigan Finance Club", "President"), "custom: peer asking for resume feedback", {
    purpose: "ask emily (we met at a conference) if she'd look at my resume since she got castellan",
  }),
  sc(next(), "custom", JADE, R("Megan Doyle", "Blue Ash Advisors", "Senior Associate"), "custom: invite a speaker to a club", {
    gmailSignature: true, purpose: "invite megan to speak at Rutgers Women in Business on October 22 at 7pm about transaction advisory careers, 30 minutes plus Q&A, virtual is fine",
  }),
  sc(next(), "custom", MARCO, R("Andrew Liu", "Tillman Gray", "Associate"), "custom: ask for mock interview, job-adjacent", {
    purpose: "ask andrew if he'd do a 20 min mock case with me before my tillman gray interview, and if he can tell me what questions they ask",
  }),
);

SCENARIOS.push(...edgeScenarios({ sc, R, next, S: { MAYA, LEO, SOFIA, DANIEL, AISHA, TENDAI, HANNAH, MARCO, JADE, RUBEN } }));

function fieldAnswers(type: EmailTypeId, values: Record<string, string> = {}) {
  const t = emailTypeById(type)!;
  const out: { prompt: string; value: string }[] = [];
  for (const f of activeFields(t, (name) => values[name]?.trim() || undefined)) {
    const raw = (values[f.name] ?? "").trim();
    if (!raw) {
      if (f.required) throw new Error(`scenario for ${type} is missing required field ${f.name}`);
      continue;
    }
    out.push({ prompt: f.prompt, value: f.options?.find((o) => o.value === raw)?.label ?? raw });
  }
  return out;
}

export function scenarioInputs() {
  return SCENARIOS.map((s) => {
    const input: DraftPromptInput = {
      ...s.student,
      ...s.recipient,
      type: s.type,
      now: NOW,
      purpose: s.purpose ?? null,
      extraContext: s.extraContext,
      gmailSignature: s.gmailSignature,
      detectedOverlaps: s.sameSchool ? ["Same school"] : [],
      alumniSchool: s.sameSchool ? (s.student.studentSchool ?? null) : null,
      resumeOnFile: s.student.resumeOnFile,
      brief: {
        ...s.brief,
        threadSubject: s.fields?.threadSubject ?? s.brief?.threadSubject,
        fieldAnswers: fieldAnswers(s.type, s.fields),
      },
    };
    return { scenario: s, input };
  });
}

// ------------------------------------------------------------------ checks

const STOP = new Set(
  "about after also been before being could from have into just like more most much only over some that than their them then there these they this those very what when where which while with would your yours will been does".split(" "),
);

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9#]+/g) ?? []).filter((w) => (w.length >= 4 || /\d/.test(w)) && !STOP.has(w));
}

function bodyBeforeSignOff(body: string): string {
  const lines = body.split("\n");
  const signOff = lines.map((l) => l.trim().toLowerCase()).lastIndexOf("best,");
  return (signOff === -1 ? lines : lines.slice(0, signOff)).join("\n");
}

function shingles(text: string, n: number): string[] {
  const words = text.toLowerCase().replace(/[’']/g, "'").match(/[a-z0-9'#]+/g) ?? [];
  const out: string[] = [];
  for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(" "));
  return out;
}

const TITLE = /^(Professor|Prof\.|Dr\.|Dean)\s+/i;
const TEAMISH = /\b(team|recruiting|careers|talent|campus|inbox|hr)\b/i;

type Finding = { id: string; type: string; issue: string };

let stockCache: Set<string> | null = null;
/** 9-word runs used in examples of three or more different types: the playbook's house phrasing. */
function stockShingles(): Set<string> {
  if (stockCache) return stockCache;
  const typesPerShingle = new Map<string, Set<string>>();
  for (const [typeId, examples] of Object.entries(EMAIL_EXAMPLES)) {
    for (const e of examples) {
      for (const sh of shingles(bodyBeforeSignOff(e.body), 9)) {
        typesPerShingle.set(sh, (typesPerShingle.get(sh) ?? new Set()).add(typeId));
      }
    }
  }
  stockCache = new Set([...typesPerShingle].filter(([, types]) => types.size >= 3).map(([sh]) => sh));
  return stockCache;
}

function parseDrafts(file: string) {
  const text = readFileSync(file, "utf8");
  const parts = text.split(/^=== (\d+)\s*$/m).slice(1);
  const drafts = new Map<string, { subject: string; body: string; notes: string[] }>();
  for (let i = 0; i < parts.length; i += 2) {
    const [subjectLine, ...rest] = parts[i + 1].replace(/^\n/, "").split("\n");
    const notesLine = rest[0]?.startsWith("Notes:") ? rest.shift()! : "";
    const notes = notesLine ? notesLine.replace(/^Notes:\s*/, "").split(" | ").filter(Boolean) : [];
    drafts.set(parts[i], { subject: subjectLine.replace(/^Subject:\s*/, ""), body: rest.join("\n").trim(), notes });
  }
  return drafts;
}

// The fluency checks' findings, kept apart from check()'s so the automated
// findings count stays comparable with runs from before these checks existed.
const fluency: string[] = [];

function check(file: string) {
  const drafts = parseDrafts(file);
  const findings: Finding[] = [];
  for (const { scenario: s, input } of scenarioInputs()) {
    const raw = drafts.get(s.id);
    const type = emailTypeById(s.type)!;
    const add = (issue: string) => findings.push({ id: s.id, type: type.label, issue });
    if (!raw) {
      add("no draft");
      continue;
    }
    const final = finishDraft(input, { ...raw, connectionUsed: null, gaps: [], notesForStudent: raw.notes });
    const main = bodyBeforeSignOff(final.body);
    for (const issue of fluencyIssues(main.split("\n").slice(1).join("\n").trim(), null)) fluency.push(`${s.id} ${type.label}: ${issue}`);
    const words = main.split(/\s+/).filter(Boolean).length - 2; // greeting
    if (words > type.maxWords) add(`over ceiling: ${words} > ${type.maxWords}`);
    if (/—/.test(final.body)) add("em dash");
    for (const b of final.body.match(/\[[^\]\n]{2,}\]/g) ?? []) add(`placeholder left: ${b}`);

    // Signature, as the model wrote it (before any fix-up).
    const rawLines = raw.body.split("\n");
    const signOff = rawLines.map((l) => l.trim().toLowerCase()).lastIndexOf("best,");
    const after = signOff === -1 ? null : rawLines.slice(signOff + 1).filter((l) => l.trim());
    const expected = input.gmailSignature ? [] : signatureLines(input);
    if (!after) add("no \"Best,\" sign-off");
    else if (after.join("|") !== expected.join("|")) add(`signature differs: [${after.join(" / ")}]`);

    // Subject threading.
    const thread = type.repliesInThread ? input.brief?.originalSubject : input.brief?.threadSubject;
    if (!thread && /^re:/i.test(raw.subject)) add(`invented "Re:" subject: ${raw.subject}`);

    // Greeting.
    const greeting = main.split("\n")[0];
    if (!/^((Hi|Hello|Dear) [^,]+|Hello),$/.test(greeting)) add(`odd greeting: ${greeting}`);
    if (TITLE.test(input.contactName) && !greeting.includes(input.contactName.split(/\s+/)[0])) {
      add(`title dropped in greeting: ${greeting} (to ${input.contactName})`);
    }
    if (TEAMISH.test(input.contactName) && /^Hi /.test(greeting)) add(`team greeted like a person: ${greeting}`);

    // Every typed detail should land.
    const NOT_IN_BODY = new Set(["threadSubject", "otherNotes", "originalSent"]);
    const details = [
      ...Object.entries(s.fields ?? {})
        .filter(([name]) => !NOT_IN_BODY.has(name) && type.fields?.find((f) => f.name === name)?.kind !== "select")
        .filter(([name]) => activeFields(type, (n) => s.fields?.[n]).some((f) => f.name === name))
        .map(([, v]) => v),
      input.brief?.financeInterest,
      input.brief?.wantToLearn,
      input.brief?.meetingWhen,
      input.brief?.conversationDetails,
      input.brief?.introName,
      input.brief?.introReason,
      input.brief?.personalConnection,
      input.purpose,
      input.extraContext,
    ].filter((d): d is string => Boolean(d));
    const bodyWords = new Set(contentWords(main).map((w) => w.slice(0, 5)));
    for (const d of details) {
      const ws = contentWords(d);
      if (!ws.length) continue;
      const hit = ws.filter((w) => bodyWords.has(w.slice(0, 5))).length / ws.length;
      if (hit < 0.4) add(`detail may be missing (${Math.round(hit * 100)}%): "${d}"`);
    }

    // Distinctive phrasing lifted from this type's examples.
    const exampleShingles = new Map<string, number>();
    const stock = stockShingles();
    for (const e of EMAIL_EXAMPLES[s.type as Exclude<EmailTypeId, "custom">] ?? []) {
      for (const sh of new Set(shingles(bodyBeforeSignOff(e.body), 9))) exampleShingles.set(sh, (exampleShingles.get(sh) ?? 0) + 1);
    }
    const lifted = [...new Set(shingles(main, 9))].filter((sh) => exampleShingles.get(sh) === 1 && !stock.has(sh));
    if (lifted.length >= 3) add(`copies an example (${lifted.length} distinctive 9-word runs), e.g. "${lifted[0]}"`);

    // Dates the student never gave.
    for (const n of final.notesForStudent.filter((n) => n.startsWith("Double-check"))) add(`flagged for the student: ${n}`);
    if (/\b(internship|interview|job|overrated|goldman)\b/i.test(input.purpose ?? "") && !(raw.notes ?? []).length) {
      add("rule-breaking request handled without a note to the student");
    }

    // The student's register leaking in, or instructions that break the rules.
    if (/\b(idk|lol|gonna|wanna|kinda)\b|(^|[\s.,])i\s/.test(main)) add("casual register copied from input");
    if (/\b(get me an interview|overrated|hire me|give me a job)\b/i.test(main)) add("rule-breaking ask made it in");
    if (/\bMBA\b/.test(input.studentMajor ?? "") && /\b(a|an) (freshman|sophomore|junior|senior) (at|in|studying)\b/i.test(main)) add("graduate student given an undergraduate year");
    if ((main.match(/!/g) ?? []).length > 3) add("more than three exclamation points");

    // Does it read like a person wrote it?
    for (const [re, label] of STIFF) if (re.test(main)) add(`stiff: ${label}`);
    const sentences = main
      .split("\n")
      .slice(1)
      .join(" ")
      .split(/(?<=[.!?])\s+/)
      .map((x) => x.trim())
      .filter((x) => x.split(/\s+/).length > 2);
    let run = 0;
    let longestRun = 0;
    for (const x of sentences) {
      run = /^I\b/.test(x) ? run + 1 : 0;
      longestRun = Math.max(longestRun, run);
    }
    if (longestRun >= 3) add(`${longestRun} sentences in a row start with "I"`);
    const lengths = sentences.map((x) => x.split(/\s+/).length);
    if (lengths.length >= 5) {
      const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
      const sd = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length);
      if (sd < 3.5) add(`monotone rhythm: ${lengths.length} sentences all ~${Math.round(mean)} words`);
    }
    const thanks = (main.match(/\bthank/gi) ?? []).length;
    if (thanks >= 3) add(`thanks them ${thanks} times`);
    for (const w of ["genuinely", "really", "truly", "specifically", "incredibly"]) {
      if ((main.match(new RegExp(`\\b${w}\\b`, "gi")) ?? []).length >= 2) add(`"${w}" used twice`);
    }
    openers.push({ id: s.id, opener: sentences[0] ?? "" });

    // The adversarial runs' own expectations.
    // "cs:" marks a pattern that must match case-sensitively.
    const rx = (p: string) => (p.startsWith("cs:") ? new RegExp(p.slice(3), "m") : new RegExp(p, "im"));
    for (const p of s.must ?? []) if (!rx(p).test(final.body)) add(`EXPECTED /${p}/ in the body`);
    for (const p of s.mustNot ?? []) {
      const m = final.body.match(rx(p));
      if (m) add(`MUST NOT contain /${p}/: "${m[0]}"`);
    }
    for (const p of s.subjectMustNot ?? []) {
      const m = final.subject.match(rx(p));
      if (m) add(`subject MUST NOT contain /${p}/: "${m[0]}"`);
    }
    if (s.note && final.notesForStudent.length === 0) add("EXPECTED a note to the student");
    if (s.maxBodyWords && words > s.maxBodyWords) add(`over the requested length: ${words} > ${s.maxBodyWords}`);
  }

  // Across the batch: the same opening sentence shape over and over reads as a template.
  const openerCounts = new Map<string, string[]>();
  for (const { id, opener } of openers) {
    const key = opener.toLowerCase().split(/\s+/).slice(0, 5).join(" ");
    openerCounts.set(key, [...(openerCounts.get(key) ?? []), id]);
  }
  for (const [key, ids] of openerCounts) {
    if (ids.length >= Math.max(4, Math.round(openers.length * 0.08))) {
      findings.push({ id: "batch", type: "all", issue: `${ids.length} drafts open with "${key}..." (${ids.slice(0, 8).join(", ")})` });
    }
  }
  return findings;
}

const openers: { id: string; opener: string }[] = [];

// Phrases that mark an email as machine-written or stiff. The playbook's own
// house phrasing ("I hope this email finds you well") is deliberately absent.
const STIFF: [RegExp, string][] = [
  [/\bI am writing to\b/i, "\"I am writing to\""],
  [/\bI wanted to reach out\b/i, "\"I wanted to reach out\""],
  [/\b(delve|leverage|synerg\w+|esteemed|invaluable|insightful|resonated? with me|passionate about)\b/i, "AI-flavoured vocabulary"],
  [/\b(Furthermore|Moreover|Additionally|In conclusion|Ultimately),/, "essay connector"],
  [/\bat your earliest convenience\b|\bdo not hesitate\b|\bplease feel free\b/i, "form-letter phrase"],
  [/\bI am confident (that )?I\b|\bI believe I would be\b|\bgreat fit\b/i, "self-selling line"],
  [/\bvaluable (insights?|perspective|advice)\b/i, "\"valuable insight\""],
  [/\b(deeply|greatly) appreciate\b/i, "over-formal gratitude"],
  [/\bnot only\b[^.]*\bbut also\b/i, "\"not only... but also\""],
  [/\bIt was a pleasure\b/i, "\"It was a pleasure\""],
];

const [mode, arg] = process.argv.slice(2);
if (mode === "check") {
  const findings = check(arg);
  const byId = new Map<string, Finding[]>();
  for (const f of findings) byId.set(f.id, [...(byId.get(f.id) ?? []), f]);
  for (const [id, fs] of byId) {
    console.log(`${id} ${fs[0].type}`);
    for (const f of fs) console.log(`   - ${f.issue}`);
  }
  console.log(`\n${findings.length} automated findings across ${byId.size} of ${SCENARIOS.length} drafts`);
  if (process.argv.includes("--fluency")) for (const f of fluency) console.log(`   ~ ${f}`);
  console.log(`${fluency.length} fluency findings (run with --fluency to list them)`);
} else {
  const chunks: string[] = [];
  for (const { scenario: s, input } of scenarioInputs()) {
    const type = emailTypeById(s.type)!;
    const { system, userText } = buildDraftPrompt(input);
    const purposeBlock = system.split("WHAT THE STUDENT SAYS ABOUT THIS EMAIL (every detail must be worked in):")[1];
    chunks.push(
      [
        `################ ${s.id} | ${type.label} | ${s.what} | ceiling ${type.maxWords}`,
        purposeBlock ? `WHAT THE STUDENT SAYS ABOUT THIS EMAIL:${purposeBlock.split("\n\nNever state")[0]}` : "",
        userText,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }
  const outFile = mode ?? "draft-scenarios.txt";
  writeFileSync(outFile, chunks.join("\n\n") + "\n");
  console.log(`${SCENARIOS.length} scenarios written to ${outFile}`);
}
