// Draft simulations for the picker's multi-box situations: each valid
// combination of two or more boxes, answered the way a student would, built
// into the exact prompt the server action sends.
//
//   npx tsx scripts/draft-occasions-sim.ts [outFile]        write the prompts
//   npx tsx scripts/draft-occasions-sim.ts check <drafts>   check drafts written for them
//   npx tsx scripts/draft-occasions-sim.ts lint-examples    run the fluency checks on Volume V itself
//
// Two answer sets. "full" answers every question, for every combination (ids
// 601+). "sparse" answers only the required questions, typed in lowercase
// shorthand, with a Gmail signature, for a spread of combinations (ids 801+):
// thin input is where a stitched-together email shows most.
//
// Drafts file format matches draft-scenarios.ts: "=== <id>", "Subject:", an
// optional "Notes:" line, then the body. `sims` and `draftIssues` are exported
// for scripts/draft-live-eval.ts, which grades real drafts the same way.

import { readFileSync, writeFileSync } from "node:fs";
import {
  OCCASIONS,
  answerFor,
  boxesConflict,
  resolveSituation,
  situationQuestions,
  situationTypes,
  type Situation,
} from "../src/lib/draft-occasions";
import { buildDraftPrompt, combinedExamplesFor, finishDraft, signatureLines, type DraftPromptInput } from "../src/lib/draft-prompt";
import { fluencyIssues } from "../src/lib/draft-lint";
import volumeV from "../src/lib/email-examples-v5.json";

const NOW = new Date("2026-09-20T12:00:00");

const STUDENT: Pick<
  DraftPromptInput,
  "studentName" | "studentSchool" | "studentSchoolEmail" | "studentPhone" | "studentGradYear" | "studentMajor" | "studentClubs" | "studentResumeSummary"
> = {
  studentName: "Maya Okafor",
  studentSchool: "Duke University",
  studentSchoolEmail: "maya.okafor@duke.edu",
  studentPhone: "(919) 555-0142",
  studentGradYear: 2029,
  studentMajor: "Economics",
  studentClubs: "Duke Investment Club",
  studentResumeSummary: [
    "EDUCATION",
    "- Duke University · BA Economics",
    "WORK EXPERIENCE",
    "- Pinecrest Wealth Partners · Summer Intern · Atlanta, GA · Jun 2026 - Aug 2026",
    "    - Built a screening model for 40 dividend stocks used in client portfolio reviews",
    "CLUBS & ACTIVITIES",
    "- Duke Investment Club · Consumer sector analyst",
  ].join("\n"),
};

type Profile = "full" | "sparse";

// What a student types for each question, by name. The answers agree with each
// other (one deadline, one timeline): a draft is only as coherent as its input.
const ANSWERS: Record<string, string> = {
  financeInterest: "consumer and retail M&A",
  wantToLearn: "how she moved from Duke into consumer coverage",
  specificReason: "both from Atlanta",
  howFound: "LinkedIn, searching for consumer bankers",
  whyThem: "she covers the grocery and restaurant deals I follow",
  referrerName: "Emily Tran",
  firstPerson: "Marcus Delacroix",
  referrerContext: "president of the Duke Investment Club, interned on her team",
  metAt: "the SEO Career Summit in New York",
  talkedAbout: "the grocery chain turnaround she worked on",
  stuckWithYou: "that consumer deals come down to repeat customers",
  recruiterQuestions: "when the sophomore program opens and whether it feeds the summer analyst class",
  redirectDetail: "the consumer team runs the sophomore program and hires from it",
  newPerson: "Ben Ortega",
  program: "2028 Summer Analyst",
  inboxContext: "applied September 10",
  inboxQuestion: "can you confirm my application was received",
  meetingWhen: "this morning",
  conversationDetails: "how she picks which consumer brands have staying power",
  introName: "Ben on her team",
  introReason: "he covers restaurants",
  offerType: "resume",
  introTarget: "her colleague Ben",
  applicationRef: "req #55120",
  eventName: "the Morrow & Pike info session at Fuqua on Tuesday",
  remarkPoint: "the best analysts write down every question they get wrong",
  yourQuestion: "how the consumer team staffs analysts",
  eventAsk: "call",
  sessionName: "the Morrow & Pike info session at Fuqua",
  recruiterExplained: "how applications move from the portal to a first-round list",
  oneQuestion: "does the career-services resume drop go to the same pool",
  lastSpoke: "March, about consumer coverage",
  firstTalk: "March; she told me to start tracking a few consumer brands closely",
  updateSince: "I spent the summer at Pinecrest building a dividend screening model",
  adviceFollowed: "I started tracking three consumer brands like she suggested",
  theirNews: "promoted to Director",
  whereSaw: "LinkedIn this morning",
  whyFits: "how clearly she explained consumer deals on our calls",
  ownNews: "I start as an analyst lead in the investment club this month",
  introducedTo: "Ben Ortega",
  loopStage: "call",
  learnedOrUpdate: "Ben walked me through how the consumer team staffs sophomores on live deals",
  nextForYou: "applying before the October 15 deadline",
  whyNow: "the summer analyst application closes October 15",
  whenInterviewed: "this afternoon",
  onlyDetail: "why a grocery chain trades at a discount to peers",
  secondInterviewer: "Kevin",
  meetingLength: "interview",
  usefulExplanation: "how the consumer group splits from coverage",
  nextStep: "first round on October 2",
  roundType: "recorded",
  completedWhen: "tonight",
  roundContent: "why consumer and a time I changed my mind",
  interviewTeam: "Morrow & Pike, consumer and retail",
  personalConnection: "my summer at Pinecrest",
  clarification: "I mixed up EBITDA and operating income on one answer",
};

// The same student in a hurry: only what's required, typed the way students type.
const SPARSE: Record<string, string> = {
  referrerName: "emily tran",
  referrerContext: "she interned on the consumer team last summer and said to reach out",
  metAt: "seo career summit nyc",
  talkedAbout: "grocery chain turnaround she worked on",
  conferenceName: "seo career summit, new york",
  whereTalked: "firm table at lunch, talked about the grocery turnaround",
  recruiterQuestions: "when does soph program open + does it feed the summer analyst class",
  firstPerson: "marcus delacroix",
  newPerson: "ben ortega",
  howFound: "linkedin",
  whereMet: "found her on linkedin",
  whyThem: "covers grocery and restaurant deals i follow",
  conversationDetails: "how she picks consumer brands w staying power",
  eventName: "morrow & pike info session at fuqua",
  sessionName: "morrow & pike session at fuqua",
  lastSpoke: "march, consumer coverage",
  updateSince: "summer at pinecrest building a dividend screen",
  theirNews: "promoted to director",
  whereSaw: "linkedin",
  introducedTo: "ben ortega",
  learnedOrUpdate: "ben explained how the consumer team staffs deals",
  firstTalk: "march, she said track a few brands",
  whatYouDid: "tracking 3 brands now",
};

// Answers that depend on the box asking: beside a talk, the one detail is from the talk.
const ANSWERS_BY_BOX: Record<Profile, Record<string, Record<string, string>>> = {
  full: {
    "thanks.event": { conversationDetail: ANSWERS.remarkPoint },
    "thanks.session": { conversationDetail: ANSWERS.recruiterExplained },
    "stay.redirected": { redirectDetail: "Ben explained how the consumer team decides which deals sophomores staff" },
  },
  sparse: {
    "thanks.event": { conversationDetail: "best analysts write down every q they get wrong" },
    "thanks.session": { conversationDetail: "how apps go from the portal to a first round list" },
  },
};

// The first-email combinations the sparse answers are also run for, from two
// boxes up to four. Every thank-you and stay-in-touch mix gets them too.
const SPARSE_MIXES = new Set(
  [
    ["first.alum", "first.recruiter"],
    ["first.not_alum", "first.recruiter"],
    ["first.alum", "first.referred"],
    ["first.recruiter", "first.referred"],
    ["first.alum", "first.met"],
    ["first.met", "first.referred"],
    ["first.alum", "first.met", "first.recruiter", "first.referred"],
    ["first.conference", "first.recruiter"],
    ["first.alum", "first.pointed"],
    ["first.met", "first.pointed"],
    ["first.alum", "first.met", "first.pointed", "first.recruiter"],
  ].map((m) => m.sort().join("+")),
);

export type Sim = { id: string; profile: Profile; situation: Situation; ids: string[]; input: DraftPromptInput; answered: Record<string, string> };

function recipientFor(situation: Situation): Pick<DraftPromptInput, "contactName" | "contactFirm" | "contactRole" | "contactSchool"> {
  const ids = [situation.lead, ...situation.also].map((b) => b.id);
  if (ids.includes("first.recruiter") || ids.includes("thanks.session") || ids.includes("thanks.screen") || ids.includes("thanks.recorded")) {
    return { contactName: "Olivia Brandt", contactFirm: "Morrow & Pike", contactRole: "Campus Recruiter", contactSchool: ids.includes("first.alum") ? "Duke University" : null };
  }
  return { contactName: "Rachel Stein", contactFirm: "Morrow & Pike", contactRole: "Vice President", contactSchool: ids.includes("first.alum") ? "Duke University" : null };
}

export const missing = new Set<string>();

function build(id: string, profile: Profile, situation: Situation, ids: string[]): Sim {
  const recipient = recipientFor(situation);
  const types = situationTypes(situation);
  const boxIds = [situation.lead, ...situation.also].map((b) => b.id);
  const answers = profile === "full" ? ANSWERS : SPARSE;
  const selects: Record<string, string> = {};
  const typed = (name: string) => boxIds.map((b) => ANSWERS_BY_BOX[profile][b]?.[name]).find(Boolean) ?? answers[name];
  const field = (name: string) => situation.presets[name] ?? selects[name] ?? typed(name);
  const answered: Record<string, string> = {};
  const fieldAnswers: { prompt: string; value: string }[] = [];
  for (const q of situationQuestions(situation, field)) {
    if (profile === "sparse" && !q.required && q.kind !== "select") continue;
    let raw = answerFor(q.name, field);
    if (raw === undefined && q.options?.length) raw = selects[q.name] = q.options[0].value;
    if (raw === undefined) {
      if (profile === "full") missing.add(q.name);
      continue;
    }
    answered[q.name] = raw;
    if (!q.prompt) continue;
    fieldAnswers.push({ prompt: q.prompt, value: q.options?.find((o) => o.value === raw)?.label ?? raw });
  }
  for (const t of types) {
    for (const f of t.fields ?? []) {
      const preset = situation.presets[f.name];
      if (!preset) continue;
      fieldAnswers.push({ prompt: f.prompt, value: preset === "{recipient}" ? recipient.contactName : (f.options?.find((o) => o.value === preset)?.label ?? preset) });
    }
  }
  const alum = ids.includes("first.alum");
  const input: DraftPromptInput = {
    ...STUDENT,
    ...recipient,
    type: types[0].id,
    alsoTypes: types.slice(1).map((t) => t.id),
    situationSummary: situation.summary,
    boxIds,
    now: NOW,
    resumeOnFile: true,
    gmailSignature: profile === "sparse",
    detectedOverlaps: alum ? ["Same school"] : [],
    alumniSchool: alum ? "Duke University" : null,
    brief: {
      financeInterest: answered.financeInterest,
      wantToLearn: answered.wantToLearn,
      specificReason: answered.specificReason,
      meetingWhen: answered.meetingWhen,
      conversationDetails: answered.conversationDetails,
      interviewTeam: answered.interviewTeam,
      personalConnection: answered.personalConnection,
      fieldAnswers,
    },
  };
  return { id, profile, situation, ids, input, answered };
}

export function sims(): Sim[] {
  const out: Sim[] = [];
  let full = 600;
  let sparse = 800;
  for (const occasion of OCCASIONS) {
    const all = occasion.sections.flatMap((s) => s.boxes.map((b) => b.id));
    for (let mask = 1; mask < 1 << all.length; mask++) {
      const ids = all.filter((_, i) => mask & (1 << i));
      if (ids.length < 2) continue;
      if (ids.some((a) => ids.some((b) => a !== b && boxesConflict(a, b)))) continue;
      const situation = resolveSituation(occasion.id, ids);
      if ("error" in situation) continue;
      out.push(build(String(++full), "full", situation, ids));
      if (occasion.id !== "first_contact" || SPARSE_MIXES.has([...ids].sort().join("+"))) out.push(build(String(++sparse), "sparse", situation, ids));
    }
  }
  return out;
}

// Shorthand in the sparse answers, so a draft that spells it out isn't flagged as missing it.
const SHORTHAND: Record<string, string> = { soph: "sophomore", q: "question", apps: "applications", w: "with", nyc: "new york", "3": "three" };
const expand = (t: string) => t.replace(/\b(soph|q|apps|w|nyc|3)\b/gi, (m) => SHORTHAND[m.toLowerCase()]);

const STOP = new Set("about after also been before from have into just like more most much only over some that than their them then there these they this those very what when where which while with would your".split(" "));
const words = (t: string) => (t.toLowerCase().match(/[a-z0-9#]+/g) ?? []).filter((w) => (w.length >= 4 || /\d/.test(w)) && !STOP.has(w));

/** Everything wrong with one draft for one simulation, as the check command reports it. */
export function draftIssues(s: Sim, raw: { subject: string; body: string; notes: string[] }): string[] {
  const issues: string[] = [];
  const final = finishDraft(s.input, { ...raw, connectionUsed: null, gaps: [], notesForStudent: raw.notes });
  const lines = final.body.split("\n");
  const main = lines.slice(0, lines.map((l) => l.trim()).lastIndexOf("Best,")).join("\n");
  const count = main.split(/\s+/).filter(Boolean).length - 2;
  const types = situationTypes(s.situation);
  const ceiling = Math.max(...types.map((t) => t.maxWords));
  if (count > ceiling) issues.push(`over ceiling: ${count} > ${ceiling}`);
  if (/—/.test(final.body)) issues.push("em dash");
  for (const b of final.body.match(/\[[^\]\n]{2,}\]/g) ?? []) issues.push(`placeholder: ${b}`);
  const after = raw.body.split("\n").slice(raw.body.split("\n").map((l) => l.trim()).lastIndexOf("Best,") + 1).filter((l) => l.trim());
  const expected = s.input.gmailSignature ? [] : signatureLines(s.input);
  if (after.join("|") !== expected.join("|")) issues.push(`signature differs: ${after.join(" / ") || "(none)"}`);
  for (const n of final.notesForStudent.filter((x) => x.startsWith("Double-check"))) issues.push(n);

  // Every checked box's facts made it in: most words of each typed answer appear.
  const bodyWords = new Set(words(main).map((w) => w.slice(0, 5)));
  for (const [name, value] of Object.entries(s.answered)) {
    if (["loopStage", "offerType", "eventAsk", "meetingLength", "roundType", "nextStepAsk"].includes(name)) continue;
    const ws = words(expand(value));
    if (!ws.length) continue;
    const hit = ws.filter((w) => bodyWords.has(w.slice(0, 5))).length / ws.length;
    if (hit < 0.4) issues.push(`answer may be missing (${Math.round(hit * 100)}%): ${name} = "${value}"`);
  }

  // One email, not one per box: a single ask, one resume mention, no paragraph per box.
  const asks = main.match(/\b(would you have|would you be (open|willing)|could we|do you have time)\b/gi) ?? [];
  if (asks.length > 1) issues.push(`${asks.length} asks - reads as stitched together`);
  const resumeMentions = main.match(/\bresume\b[^.]*\battach|\battach\w*[^.]*\bresume\b/gi) ?? [];
  if (resumeMentions.length > 1) issues.push(`resume mentioned ${resumeMentions.length} times`);
  const paragraphs = main.split(/\n\s*\n/).filter((p) => p.trim()).length - 1;
  if (paragraphs > 5) issues.push(`${paragraphs} paragraphs - a paragraph per box?`);
  const sentences = main.split(/(?<=[.!?])\s+/).map((x) => x.trim().toLowerCase()).filter((x) => x.length > 20);
  const repeated = sentences.filter((x, i) => sentences.indexOf(x) !== i);
  if (repeated.length) issues.push(`repeated sentence: "${repeated[0]}"`);

  // The lead box writes the opening, as the playbook's examples do.
  const opening = main.split("\n").slice(1).join(" ").split(/(?<=[.!?])\s/).slice(0, 2).join(" ");
  const leadId = s.situation.lead.id;
  if (leadId === "first.referred" && !/Emily Tran/.test(opening)) issues.push("referral lead, but the referrer isn't in the opening");
  if (leadId === "first.conference" && !/SEO Career Summit/.test(opening)) issues.push("conference lead, but the conference isn't in the opening");
  if (leadId === "first.met" && !/SEO Career Summit|grocery/.test(opening)) issues.push("met-in-person lead, but the meeting isn't in the opening");
  if (s.ids.includes("first.alum") && !/\balum|also (studied|went to)|Duke (too|as well)/i.test(main)) issues.push("alum box checked, but the shared school isn't mentioned");
  if (s.ids.includes("first.recruiter") && !/sophomore program/i.test(main)) issues.push("recruiter box checked, but the recruiter questions are missing");

  issues.push(...fluencyIssues(main.split("\n").slice(1).join("\n").trim(), { ids: s.ids, answered: s.answered }));
  return issues;
}

// Only when run directly: the live evaluation imports this file for sims() and draftIssues().
const isMain = /draft-occasions-sim\.ts$/.test(process.argv[1] ?? "");
const [mode, arg] = isMain ? process.argv.slice(2) : ["library"];

if (mode === "check") {
  const text = readFileSync(arg, "utf8");
  const parts = text.split(/^=== (\d+)\s*$/m).slice(1);
  const drafts = new Map<string, { subject: string; body: string; notes: string[] }>();
  for (let i = 0; i < parts.length; i += 2) {
    const [subjectLine, ...rest] = parts[i + 1].replace(/^\n/, "").split("\n");
    const notesLine = rest[0]?.startsWith("Notes:") ? rest.shift()! : "";
    drafts.set(parts[i], {
      subject: subjectLine.replace(/^Subject:\s*/, ""),
      body: rest.join("\n").trim(),
      notes: notesLine ? notesLine.replace(/^Notes:\s*/, "").split(" | ") : [],
    });
  }
  let findings = 0;
  let checked = 0;
  for (const s of sims()) {
    const raw = drafts.get(s.id);
    const issues = raw ? draftIssues(s, raw) : ["no draft"];
    if (raw) checked++;
    if (issues.length) {
      findings += issues.length;
      console.log(`${s.id} [${s.profile}] ${s.situation.summary}`);
      for (const i of issues) console.log(`   - ${i}`);
    }
  }
  console.log(`\n${checked} drafts checked, ${findings} findings`);
} else if (mode === "lint-examples") {
  const V = volumeV as { examples: { section: number; boxes: string[]; body: string }[] };
  let findings = 0;
  for (const e of V.examples) {
    const main = e.body.slice(0, e.body.lastIndexOf("\n\nBest,")).split("\n").slice(1).join("\n").trim();
    const issues = fluencyIssues(main, null);
    findings += issues.length;
    if (issues.length) console.log(`section ${e.section} ${e.boxes.join("+")}\n${issues.map((i) => `   - ${i}`).join("\n")}`);
  }
  console.log(`\n${V.examples.length} Volume V examples linted, ${findings} findings`);
  // The playbook's own combined emails are what the fluency checks are
  // calibrated against, so this count drifting means either a check got looser
  // or the examples changed under it. Asserted rather than printed: it was
  // being quoted as a gate while the script exited 0 whatever it found.
  const EXPECTED_FINDINGS = 3;
  if (findings !== EXPECTED_FINDINGS) {
    console.log(`EXPECTED ${EXPECTED_FINDINGS} findings, got ${findings} - a check or the examples moved.`);
    process.exitCode = 1;
  }
} else if (isMain) {
  const chunks = sims().map((s) => {
    const { userText } = buildDraftPrompt(s.input);
    const types = situationTypes(s.situation);
    const combined = combinedExamplesFor(s.input.boxIds!);
    return [
      `################ ${s.id} | ${s.profile} | ${s.situation.summary} | lead: ${types[0].label} | ceiling ${Math.max(...types.map((t) => t.maxWords))} | combination examples: ${combined.examples.length ? (combined.exact ? "exact" : "partial") : "none"}`,
      userText.replace(/^STUDENT\n[\s\S]*?\n\nRECIPIENT/m, `STUDENT (Maya Okafor${s.input.gmailSignature ? ", Gmail adds the signature" : ", see signature below"})\n\nRECIPIENT`),
    ].join("\n\n");
  });
  if (missing.size) console.log(`no answer written for: ${[...missing].join(", ")}`);
  const outFile = mode ?? "occasion-sims.txt";
  writeFileSync(outFile, chunks.join("\n\n") + "\n");
  console.log(`${chunks.length} multi-box situations written to ${outFile}`);
}
