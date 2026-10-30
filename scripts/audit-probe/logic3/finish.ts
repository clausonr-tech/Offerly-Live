// LOGIC-3 probe: finishDraft's step ordering. No API, no DB.
import { finishDraft, type DraftPromptInput } from "@/lib/draft-prompt";

const INPUT: DraftPromptInput = {
  type: "cold_email",
  contactName: "Rachel Stein",
  contactFirm: "Morrow & Pike",
  studentName: "Maya Okafor",
  studentSchool: "Duke University",
  studentSchoolEmail: "maya.okafor@duke.edu",
  studentPhone: "9195550142",
  studentGradYear: 2029,
  studentMajor: "Economics",
  now: new Date("2026-09-20T12:00:00"),
} as DraftPromptInput;

const run = (label: string, subject: string, body: string, input: DraftPromptInput = INPUT) => {
  const out = finishDraft(input, { subject, body, connectionUsed: null, gaps: [] });
  console.log(`\n### ${label}`);
  console.log(`subject: ${JSON.stringify(out.subject)}`);
  console.log("body:\n" + out.body.split("\n").map((l) => "   | " + l).join("\n"));
  if (out.notesForStudent.length) console.log("notes: " + JSON.stringify(out.notesForStudent));
};

// A. em dash -> comma manufactures a comma splice
run("A em-dash splice", "Duke student", "I interned at Pinecrest this summer — it taught me how screening models get used.\n\nBest,\nMaya Okafor");

// B. en dash survives the prose rewrite although the digit rule knows about it
run("B en dash in prose + digit range", "Duke – reaching out", "I worked there 2023–2025 and loved it – the team was great.\n\nBest,\nMaya");

// C. subject that is only an em dash
run("C subject is only an em dash", "—", "Hello.\n\nBest,\nMaya");

// D. em dash at the start of the subject
run("D em dash leads the subject", "— Duke student reaching out", "Hello.\n\nBest,\nMaya");

// E. unusual closing not in CLOSING -> two sign-offs
run("E unrecognised closing", "Hi", "Thank you for the time.\n\nWith appreciation,\nMaya Okafor\nDuke University");

// F. three-word name after the closing -> regex misses -> two sign-offs
run("F closing with a middle initial", "Hi", "Thank you.\n\nBest,\nMaya A. Okafor");

// G. closing pushed out of the last-8-lines window by a P.S.
run(
  "G closing outside the 8-line window",
  "Hi",
  [
    "Thank you for the time.",
    "",
    "Best,",
    "Maya Okafor",
    "Duke University '29",
    "maya.okafor@duke.edu",
    "(919) 555-0142",
    "linkedin.com/in/mayaokafor",
    "",
    "P.S. I have attached my resume.",
    "P.P.S. I am free any afternoon.",
  ].join("\n"),
);

// H. the em-dash rewrite CREATES a closing match mid-body
run("H em dash turns a mid-body line into a closing", "Hi", "Rachel,\n\nThanks again — Maya here, following up.\n\nI had two questions about the programme.\n\nBest,\nMaya Okafor");

// I. body that is nothing but a closing
run("I body is only a closing", "Hi", "Best,\nMaya");

// J. the //n unescape
run("J escaped newline", "Hi", "I work on M&A.//nI had two questions.\n\nBest,\nMaya");

// K. a numeric date the model invented is never flagged; a month-name one is
run("K invented dates", "Hi", "Would Thursday 10/16 work, or October 17?\n\nBest,\nMaya");
