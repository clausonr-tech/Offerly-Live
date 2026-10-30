// Red-green test for the FIX-PROMPT items: the nine defects the LOGIC-3 and
// OUTPUT-2 audits found in prompt construction (draft-prompt.ts) and the type
// definitions (draft-templates.ts). No API call, no database.
//
//   npx tsx scripts/audit-probe/fix-prompt-test.ts
//
// Every assertion names the audit item it holds. Each one fails on the code as
// the audit found it and passes on the fix.
import {
  SETS_THE_ASK,
  buildDraftPrompt,
  finishDraft,
  isGraduateStudent,
  type DraftPromptInput,
  type RawDraft,
} from "../../src/lib/draft-prompt";
import { EMAIL_TYPES, emailTypeById } from "../../src/lib/draft-templates";

const NOW = new Date("2026-10-11T12:00:00Z");
const base: DraftPromptInput = {
  studentName: "Maya Patel",
  studentSchool: "University of Pennsylvania",
  studentSchoolEmail: "mpatel@wharton.upenn.edu",
  studentPhone: "5550101234",
  studentLinkedinUrl: "https://www.linkedin.com/in/mayapatel",
  studentGradYear: 2028,
  studentMajor: "Finance",
  contactName: "Rachel Stein",
  contactFirm: "Evercore",
  contactRole: "Vice President",
  type: "cold_email",
  now: NOW,
};
const raw = (body: string, subject = "Quick question"): RawDraft => ({
  subject,
  body,
  connectionUsed: null,
  gaps: [],
});

let failed = 0;
let passed = 0;
let item = "";
const group = (name: string) => {
  item = name;
  console.log(`\n--- ${name}`);
};
function ok(cond: boolean, what: string, detail = "") {
  if (cond) {
    passed++;
    return;
  }
  failed++;
  console.log(`  FAIL [${item}] ${what}${detail ? `\n        ${detail}` : ""}`);
}

// --------------------------------------------------------------------- item 1
group("1. conference_follow_up falls through the cold switch (LOGIC-3 F1)");
{
  const brief = {
    financeInterest: "consumer and retail M&A",
    wantToLearn: "how she moved from Duke into consumer coverage",
    specificReason: "both from Atlanta",
    fieldAnswers: [],
  };
  for (const t of EMAIL_TYPES.filter((t) => t.isCold)) {
    const { userText } = buildDraftPrompt({ ...base, type: t.id, alumniSchool: "University of Pennsylvania", brief });
    ok(userText.includes("Why the student is reaching out:"), `${t.id}: the purpose line reaches the prompt`);
    ok(userText.includes("consumer and retail M&A"), `${t.id}: financeInterest reaches the prompt`);
    ok(userText.includes("into consumer coverage"), `${t.id}: wantToLearn reaches the prompt`);
    ok(userText.includes("both from Atlanta"), `${t.id}: specificReason reaches the prompt`);
  }
  // Its own promptNote sets its ask, so the brief must not add a second one.
  const { userText } = buildDraftPrompt({ ...base, type: "conference_follow_up", brief });
  ok(!userText.includes("Ask for a 10-15 minute call"), "conference_follow_up: no second, contradicting ask line");
  ok(userText.includes("Ask for 10 minutes."), "conference_follow_up: its own 10-minute ask is the only one");
}

// --------------------------------------------------------------------- item 2
group("2. finishDraft ships two sign-offs / deletes the body (LOGIC-3 F6, OUTPUT-2 #4)");
{
  const CLOSINGS = [
    "Best, Maya Okafor", "Best, Maya A. Okafor", "Sincerely", "Sincerely,", "Thanks!", "Thank you so much,",
    "Thanks so much,", "Looking forward to hearing from you,", "Gratefully,", "Warm wishes,", "All my best,",
    "Best,Maya", "Best , Maya", "With gratitude,", "Appreciatively,", "Respectfully yours,", "Yours sincerely,",
    "Warmly,", "Cheers,", "Kind regards,", "Take care,", "Many thanks,", "Thanks again,",
  ];
  for (const c of CLOSINGS) {
    const out = finishDraft(base, raw(`Hi Rachel,\n\nThanks for your time.\n\n${c}\nMaya Patel`));
    const names = out.body.split("Maya Patel").length - 1;
    ok(names === 1, `"${c}": the name is printed once`, JSON.stringify(out.body));
    ok(out.body.endsWith("https://www.linkedin.com/in/mayapatel"), `"${c}": one rebuilt signature at the end`);
  }
  // A six-line signature plus a P.S. pushed the closing outside the 8-line window.
  const long = finishDraft(
    base,
    raw(
      "Hi Rachel,\n\nThanks for your time.\n\nBest,\nMaya Okafor\nDuke University '29\nmaya.okafor@duke.edu\n" +
        "(919) 555-0142\nlinkedin.com/in/mayaokafor\n\nP.S. I have attached my resume.\nP.P.S. I am free any afternoon.",
    ),
  );
  ok(!long.body.includes("Maya Okafor"), "a six-line signature + P.S. does not survive the rebuild", JSON.stringify(long.body));
  ok(long.body.split(/^Best,$/gm).length - 1 === 1, "exactly one \"Best,\" line");
  // The em-dash rewrite used to manufacture a CLOSING match mid-body and cut the rest.
  const mid = finishDraft(
    base,
    raw("Hi Rachel,\n\nThanks again — Maya mentioned you lead the group.\n\nTwo questions, if you have a moment:\nHow did you choose the team?\nWhat should I read first?"),
  );
  ok(mid.body.includes("What should I read first?"), "a mid-body dash does not delete the rest of the email", JSON.stringify(mid.body));
  ok(mid.body.includes("Thanks again, Maya mentioned"), "the mid-body dash is still rewritten");
  // A one-word body paragraph is not a sign-off: reading "Thanks." as one cut
  // the whole body of a two-line email.
  for (const body of [
    "Hi Rachel,\n\nThanks.\n\nBest,\nMaya\nSee you October 5",
    "Hi Rachel,\n\nThanks.\n\nBest,\nMaya Patel\nPenn, October 5 cohort",
  ]) {
    const out = finishDraft(base, raw(body));
    ok(out.body.startsWith("Hi Rachel,\n\nThanks."), '"Thanks." stays in the body', JSON.stringify(out.body));
  }
  // A real sentence that merely starts with a closing word is not a sign-off.
  const sentence = finishDraft(base, raw("Hi Rachel,\n\nThanks for your time and advice.\n\nI applied last week."));
  ok(sentence.body.includes("I applied last week."), "\"Thanks for your time and advice.\" is not read as a closing");
}

// --------------------------------------------------------------------- item 3
group("3. the subject fallback (OUTPUT-2 #5)");
{
  ok(
    finishDraft(base, raw("Hi Rachel,\n\nThanks.", "—")).subject === "University of Pennsylvania Student Reaching Out",
    "a subject of one em dash falls back",
    finishDraft(base, raw("Hi Rachel,\n\nThanks.", "—")).subject,
  );
  const range = finishDraft(base, raw("Hi Rachel,\n\nThanks.", "Summer 2023—2025 recruiting")).subject;
  ok(range === "Summer 2023-2025 recruiting", "a digit range in the subject is a range, not a list", range);
  const lead = finishDraft(base, raw("Hi Rachel,\n\nThanks.", "— Penn student reaching out")).subject;
  ok(lead === "Penn student reaching out", "a leading dash is not a leading comma", lead);
  ok(finishDraft(base, raw("Hi Rachel,\n\nThanks.", "Penn student — quick question")).subject === "Penn student, quick question", "an ordinary em dash still becomes a comma");
  ok(finishDraft(base, raw("Hi Rachel,\n\nThanks.", "Re: Quick question")).subject === "Quick question", "a non-reply drops the model's Re:");
}

// --------------------------------------------------------------------- item 4
group("4. graduate detection (OUTPUT-2 #1, #2)");
{
  const grad = (major: string) => isGraduateStudent({ ...base, studentMajor: major });
  ok(!grad("BS/MS Finance"), '"BS/MS Finance" is not a graduate student');
  ok(!grad("Economics (MBA pipeline)"), '"Economics (MBA pipeline)" is not a graduate student');
  ok(!grad("Pre-MBA"), '"Pre-MBA" is not a graduate student');
  ok(!grad("pre-MBA analyst"), '"pre-MBA analyst" is not a graduate student');
  ok(!grad("BS/MS"), '"BS/MS" is not a graduate student');
  ok(!grad("Finance"), '"Finance" is not a graduate student');
  ok(!grad("Rutgers Business School"), '"Rutgers Business School" is not a graduate student');
  for (const m of ["MBA, Finance", "MS Finance", "M.S. in Finance", "Master of Science in Finance", "Masters in Finance", "MSF", "MFin", "LLM", "JD", "mba"]) {
    ok(grad(m), `"${m}" is a graduate student`);
  }
  ok(
    isGraduateStudent({ ...base, studentMajor: "Finance", studentResumeSummary: "EDUCATION\n- Vanderbilt University · MS in Finance, May 2027" }),
    "a resume education line still counts",
  );
  const { userText } = buildDraftPrompt({ ...base, studentMajor: "MBA", studentGradYear: 2024 });
  ok(userText.includes("Not a current student"), "a graduate student with a past grad year is not a current student", userText.split("\n").slice(0, 8).join(" | "));
  ok(!userText.includes("Graduate student (graduates 2024)"), "and is not described as graduating in the past");
}

// --------------------------------------------------------------------- item 5
group("5. finishDraft damages placeholders (OUTPUT-2 #9)");
{
  const b1 = finishDraft(base, raw("Hi Rachel,\n\nCould we talk [date — time]?")).body;
  ok(b1.includes("[date — time]"), "an em dash inside a placeholder is left alone", JSON.stringify(b1));
  const b2 = finishDraft(base, raw("Hi Rachel,\n\nI worked there [2023—2025].")).body;
  ok(b2.includes("[2023—2025]"), "a digit range inside a placeholder is left alone", JSON.stringify(b2));
  const b3 = finishDraft(base, raw("Hi Rachel,\n\nI am interested in [their//nGroup].")).body;
  ok(b3.includes("[their//nGroup]"), "a //n inside a placeholder does not split the bracket", JSON.stringify(b3));
  ok(/\[[^\]\n]{2,}\]/.test(b3), "the Composer send gate still sees the gap");
  const s1 = finishDraft(base, raw("Hi Rachel,\n\nThanks.", "[date — time] confirmation")).subject;
  ok(s1 === "[date — time] confirmation", "a placeholder in the subject is left alone", s1);
  const b4 = finishDraft(base, raw("Hi Rachel,\n\nM&A.//nI had [two] questions — all short.")).body;
  ok(b4.includes("\n\nI had [two] questions, all short."), "text outside the brackets is still rewritten", JSON.stringify(b4));
}

// --------------------------------------------------------------------- item 6
group("6. date flagging gaps (OUTPUT-2 #7)");
{
  const notes = (body: string, p: Partial<DraftPromptInput> = {}) =>
    finishDraft({ ...base, ...p }, raw(`Hi Rachel,\n\n${body}`)).notesForStudent.join(" | ");
  ok(/11\/20/.test(notes("Could we speak 11/20?")), "an invented numeric date is flagged", notes("Could we speak 11/20?"));
  ok(/2026-11-20/.test(notes("Could we speak 2026-11-20?")), "an invented ISO date is flagged", notes("Could we speak 2026-11-20?"));
  ok(notes("Could we speak 11/20?", { purpose: "free on 11/20" }) === "", "a numeric date the student typed is not flagged");
  ok(notes("Could we speak on October 5?", { purpose: "call on 10/5" }) === "", "10/5 still whitelists October 5");
  const half = notes("Could we speak January 2?", { purpose: "we spoke for 1/2 hour" });
  ok(/January 2/.test(half), '"1/2 hour" does not whitelist January 2', half);
  const half2 = notes("Could we speak February 1?", { purpose: "we spoke for 1/2 hour" });
  ok(/February 1/.test(half2), '"1/2 hour" does not whitelist February 1', half2);
  ok(/10\/16/.test(notes("Would Thursday 10/16 work?")), "a date with a word after it is still a date, not a fraction", notes("Would Thursday 10/16 work?"));
  ok(notes("Times are at https://cal.com/maya/10/5 if that helps") === "", "a numeric date inside a URL is not a date");
  ok(notes("Could we speak 10/5/2026?", { purpose: "call on 10/5" }) === "", "a date with a year is the same date");
  ok(notes("Could we speak next Tuesday?") === "", "a natural-language date is deliberately left alone");
  ok(/October 5/.test(notes("Could we speak October 5?")), "the month-name rule still fires");
}

// --------------------------------------------------------------------- item 7
group("7. SETS_THE_ASK leaks and over-drops (LOGIC-3 F7)");
{
  for (const l of [
    "Ask for 10 minutes.",
    "Ask for a 10-15 minute call, as the examples do.",
    "Name the event in the subject line.",
    "Open with the exact moment they met - the event, the day and the specific thing they talked about. Never vague.",
    "Name the conference and the city in the first line.",
    "Three or four sentences.",
    "Four or five sentences at most.",
  ]) ok(SETS_THE_ASK.test(l), `dropped from a secondary box: "${l}"`);
  for (const l of [
    "Never ask for a referral: the goal is simply to stay on their radar.",
    "Never ask for anything, including another introduction.",
    'No ask of any kind, including "let me know if you have time".',
    "Ask at most three questions, each answerable, in prose (\"First, ... Second, ...\"). Never ask about the recruiter's own career.",
    "Describe exactly where they spoke and what about, so they can place the student among hundreds.",
    "Only after that, give a one-line reminder of who the student is. With no internship, the event itself is evidence of interest.",
    "Give name, school, class year and graduation year in the introduction. The profile holds only a year, never a month, so never ask for a graduation month and never leave a placeholder for one.",
  ]) ok(!SETS_THE_ASK.test(l), `kept for a secondary box: "${l}"`);
  // The prohibitions have to exist as notes of their own to survive.
  const notesOf = (id: string) => emailTypeById(id as never)?.promptNotes ?? [];
  ok(notesOf("congratulations").includes('No ask of any kind, including "let me know if you have time".'), "congratulations: the prohibition is its own note");
  ok(notesOf("close_loop_referrer").includes("Never ask for anything, including another introduction."), "close_loop_referrer: the prohibition is its own note");
  // End to end, in real prompts.
  const conf = buildDraftPrompt({ ...base, type: "cold_referral", alsoTypes: ["conference_follow_up"], brief: { fieldAnswers: [] } }).userText;
  const alsoTrue = conf.split("ALSO TRUE - ").slice(1).join("\n");
  ok(!alsoTrue.includes("Ask for 10 minutes."), "no second ask survives into a real prompt");
  ok(!alsoTrue.includes("in the first line"), "no second opening survives into a real prompt");
  const meeting = buildDraftPrompt({ ...base, type: "cold_referral", alsoTypes: ["cold_after_meeting"], brief: { fieldAnswers: [] } }).userText;
  ok(!meeting.split("ALSO TRUE - ").slice(1).join("\n").includes("in the subject line"), "no second subject-line rule survives");
  const congrats = buildDraftPrompt({ ...base, type: "keep_in_touch", alsoTypes: ["congratulations"], brief: { fieldAnswers: [] } }).userText;
  ok(congrats.includes("No ask of any kind"), "a prohibition from a secondary box survives");
  const loop = buildDraftPrompt({ ...base, type: "keep_in_touch", alsoTypes: ["close_loop_referrer"], brief: { fieldAnswers: [] } }).userText;
  ok(loop.includes("Never ask for anything, including another introduction."), "the referrer prohibition survives");
}

// --------------------------------------------------------------------- item 8
group("8. greeting edge cases (LOGIC-3 F14, OUTPUT-2 #6)");
{
  const greet = (contactName: string) => {
    const line = buildDraftPrompt({ ...base, contactName }).userText.split("\n").find((l) => l.startsWith("Greeting:"));
    return line ?? "(none)";
  };
  ok(!greet("team lead Rachel Stein").includes('"Hi Team,"'), 'a job title is not a first name: "team lead Rachel Stein"', greet("team lead Rachel Stein"));
  ok(greet("team lead Rachel Stein").includes('"Hi Rachel,"'), '"team lead Rachel Stein" is greeted "Hi Rachel,"', greet("team lead Rachel Stein"));
  ok(greet("VP Rachel Stein").includes('"Hi Rachel,"'), '"VP Rachel Stein" is greeted "Hi Rachel,"', greet("VP Rachel Stein"));
  ok(!greet("rachel@firm.com").includes("@"), "a bare email address is never the greeting", greet("rachel@firm.com"));
  ok(!greet("j.smith42@firm.com").includes("@"), "an opaque address is never the greeting", greet("j.smith42@firm.com"));
  // The cases the audit found correct stay correct.
  ok(greet("Rachel Stein") === "(none)", "an ordinary name still needs no instruction");
  ok(greet("Dr. Amy Adams").includes('"Dear Dr. Adams,"'), "a doctor with a full name is unchanged");
  ok(greet("Dean Martin") === "(none)", "Dean as a first name is unchanged");
  ok(greet("Dean Amy Adams").includes('"Dear Dean Adams,"'), "Dean as a title is unchanged");
  ok(greet("Campus Recruiting").includes('"Hello Campus Recruiting,"'), "a team inbox is unchanged");
  ok(greet("To Whom It May Concern").includes('"Hello,"'), "no name given is unchanged");
  ok(greet("RACHEL STEIN").includes('"Hi Rachel,"'), "shouting is unchanged");
  ok(greet("Rachel Stein <rachel@firm.com>").includes('"Hi Rachel,"'), "name + address is unchanged");
  ok(!greet("Dr. Amy").includes("never their first name alone"), '"Dr. Amy" no longer claims a surname', greet("Dr. Amy"));
}

// --------------------------------------------------------------------- item 9
group("9. the word ceiling only ever loosens (LOGIC-3 F12)");
{
  const lead = emailTypeById("recruiter_outreach")!;
  const { system } = buildDraftPrompt({ ...base, type: "recruiter_outreach", alsoTypes: ["cold_email"], boxIds: ["first.recruiter", "first.alum"] });
  ok(system.includes("HARD CEILING: 200 words"), "the mix ceiling is still the hard stop");
  ok(system.includes(`${lead.maxWords} words`), "the lead's own ceiling is named as the target", system.split("\n").filter((l) => /ceiling|words/i.test(l)).join(" | "));
}

console.log(`\n${passed}/${passed + failed} passed, ${failed} failing`);
process.exit(failed === 0 ? 0 : 1);
