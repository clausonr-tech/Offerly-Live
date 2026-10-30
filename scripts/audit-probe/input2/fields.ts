// INPUT-2 probe 1: does every DraftPromptInput field the action sets reach the
// built prompt text? Pure: buildDraftPrompt only, no DB, no API.
import { buildDraftPrompt, type DraftPromptInput } from "../../../src/lib/draft-prompt";
import { buildReviewPrompt } from "../../../src/lib/draft-review";

const NOW = new Date("2026-10-11T12:00:00Z");

// One sentinel per field the committed runGenerateDraft sets.
export const sentinels: Record<string, string> = {
  studentName: "ZQNAME",
  studentSchool: "Duke University",
  studentSchoolEmail: "zqemail@duke.edu",
  studentPhone: "2125550143",
  studentLinkedinUrl: "https://linkedin.com/in/zqlinked",
  studentResumeSummary: "EDUCATION\n- Duke University · BA\nWORK EXPERIENCE\n- ZQRESUMEORG",
  studentGradYear: "2028",
  studentMajor: "ZQMAJOR",
  studentHometown: "ZQTOWN",
  studentInterests: "ZQINTEREST",
  studentClubs: "ZQCLUB",
  studentExperience: "ZQEXPERIENCE",
  studentTargetGroup: "ZQTARGET",
  studentMotivations: "ZQMOTIVE",
  studentSponsorship: "needs visa sponsorship for full-time work",
  contactName: "Zara Quimby",
  contactFirm: "ZQFIRM",
  contactRole: "ZQROLE",
  contactSchool: "Duke University",
  contactBackground: "ZQBACKGROUND",
  contactNotes: "ZQNOTES",
  contactFirmDivisions: "ZQDIVISION",
  contactGroup: "ZQGROUP",
  contactConnectionAngle: "ZQANGLE",
  detectedOverlaps: "ZQOVERLAP",
  alumniSchool: "Duke University",
  situationSummary: "ZQSITUATION",
  purpose: "ZQPURPOSE",
  extraContext: "ZQEXTRA",
  "brief.financeInterest": "ZQFININTEREST",
  "brief.wantToLearn": "ZQWANTLEARN",
  "brief.specificReason": "ZQSPECIFIC",
  "brief.threadSubject": "ZQTHREADSUBJ",
  "brief.originalSubject": "ZQORIGSUBJ",
  "brief.originalDate": "ZQORIGDATE",
  "brief.originalAsk": "ZQORIGASK",
  "brief.followUp1Date": "ZQFU1DATE",
  "brief.meetingWhen": "ZQMEETWHEN",
  "brief.conversationDetails": "ZQCONVO",
  "brief.introName": "ZQINTRONAME",
  "brief.introReason": "ZQINTROREASON",
  "brief.interviewTeam": "ZQTEAM",
  "brief.personalConnection": "ZQPERSONAL",
  "brief.fieldAnswers": "ZQFIELDANSWER",
  "brief.originalBody": "ZQORIGBODY",
  "brief.originalTypeLabel": "ZQORIGLABEL",
  "brief.followUp1Body": "ZQFU1BODY",
  gmailSignature: "(flag)",
  "brief.nextStepAsk": "(enum)",
  boxIds: "(routing)",
  alsoTypes: "(routing)",
  hasResumePdf: "(flag)",
  resumeOnFile: "(flag)",
  type: "(routing)",
  now: "(date)",
};

export function fullInput(type: DraftPromptInput["type"], over: Partial<DraftPromptInput> = {}): DraftPromptInput {
  return {
    studentName: sentinels.studentName,
    studentSchool: sentinels.studentSchool,
    studentSchoolEmail: sentinels.studentSchoolEmail,
    studentPhone: sentinels.studentPhone,
    studentLinkedinUrl: sentinels.studentLinkedinUrl,
    studentResumeSummary: sentinels.studentResumeSummary,
    gmailSignature: false,
    studentGradYear: 2028,
    studentMajor: sentinels.studentMajor,
    studentHometown: sentinels.studentHometown,
    studentInterests: sentinels.studentInterests,
    studentClubs: sentinels.studentClubs,
    studentExperience: sentinels.studentExperience,
    studentTargetGroup: sentinels.studentTargetGroup,
    studentMotivations: sentinels.studentMotivations,
    studentSponsorship: sentinels.studentSponsorship,
    contactName: sentinels.contactName,
    contactFirm: sentinels.contactFirm,
    contactRole: sentinels.contactRole,
    contactSchool: sentinels.contactSchool,
    contactBackground: sentinels.contactBackground,
    contactNotes: sentinels.contactNotes,
    contactFirmDivisions: [sentinels.contactFirmDivisions],
    contactGroup: sentinels.contactGroup,
    contactConnectionAngle: sentinels.contactConnectionAngle,
    detectedOverlaps: [sentinels.detectedOverlaps],
    alumniSchool: sentinels.alumniSchool,
    situationSummary: sentinels.situationSummary,
    boxIds: ["reach_out_first_time"],
    purpose: sentinels.purpose,
    extraContext: sentinels.extraContext,
    hasResumePdf: false,
    resumeOnFile: true,
    type,
    alsoTypes: [],
    now: NOW,
    brief: {
      financeInterest: sentinels["brief.financeInterest"],
      wantToLearn: sentinels["brief.wantToLearn"],
      specificReason: sentinels["brief.specificReason"],
      threadSubject: sentinels["brief.threadSubject"],
      originalSubject: sentinels["brief.originalSubject"],
      originalDate: sentinels["brief.originalDate"],
      originalAsk: sentinels["brief.originalAsk"],
      originalBody: sentinels["brief.originalBody"],
      originalTypeLabel: sentinels["brief.originalTypeLabel"],
      followUp1Date: sentinels["brief.followUp1Date"],
      followUp1Body: sentinels["brief.followUp1Body"],
      meetingWhen: sentinels["brief.meetingWhen"],
      conversationDetails: sentinels["brief.conversationDetails"],
      nextStepAsk: "intro",
      introName: sentinels["brief.introName"],
      introReason: sentinels["brief.introReason"],
      interviewTeam: sentinels["brief.interviewTeam"],
      personalConnection: sentinels["brief.personalConnection"],
      fieldAnswers: [{ prompt: "A field prompt", value: sentinels["brief.fieldAnswers"] }],
    },
  };
}

if (process.argv[1]?.endsWith('fields.ts')) {
const TYPES = ["cold_email", "follow_up_1", "follow_up_2", "thank_you_chat", "thank_you_interview", "call_scheduling", "custom"] as const;

const probe = [...Object.entries(sentinels)].filter(([, v]) => v.startsWith("ZQ") || v.startsWith("http") || v.includes("@") || v.startsWith("needs visa") || v === "2125550143");

console.log("field\t" + TYPES.join("\t"));
for (const [field, value] of probe) {
  const row: string[] = [];
  for (const t of TYPES) {
    const input = fullInput(t as DraftPromptInput["type"]);
    const { system, userText } = buildDraftPrompt(input);
    const inUser = userText.includes(value);
    const inSystem = system.includes(value);
    row.push(inUser ? "USER" : inSystem ? "sys" : "MISSING");
  }
  console.log(`${field}\t${row.join("\t")}`);
}

console.log("\n--- REVIEW PROMPT (cold_email) ---");
const { userText: rv } = buildReviewPrompt(fullInput("cold_email"), { subject: "s", body: "b" }, []);
for (const [field, value] of probe) {
  if (!value.startsWith("ZQ") && !value.includes("@") && value !== "2125550143" && !value.startsWith("http") && !value.startsWith("needs")) continue;
  console.log(`${field}\t${rv.includes(value) ? "in review" : "NOT in review"}`);
}

}
