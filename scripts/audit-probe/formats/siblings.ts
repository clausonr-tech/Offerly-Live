// Sibling disagreement: the same situation, handled differently by two types.
// The graduation-month bug was exactly this - recruiting_inbox had the escape
// clause, recruiter_outreach did not, and the two just disagreed.
import { EMAIL_TYPES, type EmailType } from "../../../src/lib/draft-templates";
const T = (id: string) => EMAIL_TYPES.find((t) => t.id === id)!;
const txt = (t: EmailType) => [...t.format, ...(t.promptNotes ?? [])];
const find = (t: EmailType, re: RegExp) => txt(t).filter((s) => re.test(s));

const SITUATIONS: { name: string; re: RegExp; family: string[] }[] = [
  { name: "subject of an in-thread reply", re: /\bRe:|same thread|keep the thread|replies in (that|it|the)|thread's subject|threadSubject/i,
    family: EMAIL_TYPES.filter((t) => t.repliesInThread || (t.fields ?? []).some((f) => f.name === "threadSubject")).map((t) => t.id) },
  { name: "how long a call to ask for", re: /\b\d+(-\d+)? ?minutes?\b|\b10 to 15\b/i, family: EMAIL_TYPES.filter((t) => txt(t).some((s) => /\d+(-\d+)? ?minutes?/i.test(s))).map((t) => t.id) },
  { name: "the time zone", re: /time zone/i, family: EMAIL_TYPES.filter((t) => (t.fields ?? []).some((f) => f.name === "timeZone")).map((t) => t.id) },
  { name: "flexibility about timing", re: /flexib|work around their schedule/i, family: EMAIL_TYPES.filter((t) => txt(t).some((s) => /flexib|work around their schedule/i.test(s))).map((t) => t.id) },
  { name: "graduation year / date / class year", re: /graduation (date|year|month)|class year/i, family: EMAIL_TYPES.filter((t) => txt(t).some((s) => /graduation (date|year|month)|class year/i.test(s))).map((t) => t.id) },
  { name: "greeting a team vs a person", re: /greet (the )?(team|them)|team inbox|to the team|Hello /i, family: EMAIL_TYPES.filter((t) => txt(t).some((s) => /greet (the )?(team|them)|team inbox|to the team/i.test(s))).map((t) => t.id) },
  { name: "the student's phone number", re: /phone number|your number|their number or link/i, family: EMAIL_TYPES.filter((t) => txt(t).some((s) => /phone number|your number|their number or link/i.test(s))).map((t) => t.id) },
  { name: "a document other than the resume", re: /transcript|materials|document/i, family: EMAIL_TYPES.filter((t) => txt(t).some((s) => /transcript|materials they|document/i.test(s))).map((t) => t.id) },
];
for (const sit of SITUATIONS) {
  console.log(`\n### ${sit.name}  (${sit.family.length} types)`);
  for (const id of sit.family) {
    const t = T(id);
    const hits = find(t, sit.re);
    console.log(`  ${id}${t.repliesInThread ? " [repliesInThread]" : ""}${(t.fields ?? []).some((f) => f.name === "threadSubject") ? " [has threadSubject field]" : ""}`);
    for (const h of hits) console.log(`      - ${h.slice(0, 160)}`);
    if (hits.length === 0) console.log(`      - (SILENT)`);
  }
}
