// LOGIC-2: the three mis-specified checks, FILLER on gold, formatPhone,
// resumeLooksLikeSomeoneElses, privateTopicsIn, and the per-check gold rates.
import { commaSplices, draftChecks, findingCategory, fluencyIssues, formatPhone, privateTopicsIn, resumeLooksLikeSomeoneElses } from "../../../src/lib/draft-lint";
import { gold, mainText } from "./corpus";

const mode = process.argv[2];
const show = (label: string, cases: string[], fn: (s: string) => unknown) => {
  console.log(`\n== ${label}`);
  for (const s of cases) console.log(`  ${JSON.stringify(fn(s))}\n     ${s}`);
};

if (mode === "misspec") {
  // (1) discovery-as-announcement, (2) student called an alum, (3) "both" doubled.
  show("discovery regex: /I (noticed|saw|…) (that )?we('re| are) both/", [
    "I was glad to see that you are also from Atlanta.",
    "I noticed that you also went to Duke.",
    "I saw that we share a hometown.",
    "I learned you were in the investment club too.",
    "I came across your profile and saw you are a Duke alum as well.",
    "I noticed that we're both from Atlanta.",
  ], (s) => fluencyIssues(s, null));
  show("student-called-an-alum regex", [
    "As a fellow Duke alum, I was glad to see your note.",
    "I am a fellow Duke student, and I gather you also studied there.",
    "We are both Duke people, so I thought I would reach out.",
    "As fellow alumni of the Calloway School, we have that in common.",
    "We're both alums of Duke.",
  ], (s) => fluencyIssues(s, null));
  show('"both" doubled with "too"/"as well"', [
    "We are both from Atlanta as well.",
    "I am from Atlanta too, and I gather you are as well.",
    "We both studied finance, and I also studied accounting as well.",
    "We are both from Atlanta, which I thought was a nice coincidence, and I grew up there as well.",
  ], (s) => fluencyIssues(s, null));
}

if (mode === "filler") {
  const FILLER = [
    ["wanted to reach out", /\bI (?:just )?wanted to (?:reach out|follow up|say|touch base)\b/i],
    ["hope this finds you well", /\bI hope this (?:email|message|note) finds you well\b/i],
    ["made all the difference etc", /\b(?:made all the difference|exactly what I needed|even more excited)\b/i],
  ] as const;
  const g = gold();
  for (const [name, re] of FILLER) {
    const hits = g.filter((x) => re.test(mainText(x.body)));
    console.log(`${name.padEnd(30)} ${hits.length}/${g.length} gold bodies (${(100 * hits.length / g.length).toFixed(1)}%)`);
  }
  // exact phrase counts
  const exact = (re: RegExp) => g.filter((x) => re.test(x.body)).length;
  console.log(`\n"I hope this email finds you well" exact: ${exact(/I hope this email finds you well/)}`);
  console.log(`near-miss variants the rule misses:`);
  for (const re of [/I hope (?:you are|you're) (?:doing )?well/i, /I hope (?:this|your) \w+ (?:is|finds)/i, /I hope all is well/i, /I hope you are doing well/i, /hope your \w+ is going well/i]) {
    console.log(`   ${String(re).padEnd(48)} ${exact(re)} gold bodies`);
  }
}

if (mode === "phone") {
  for (const raw of ["15550101234", "555.010.1234", "(555) 010-1234", "555-010-1234 x12", "+44 20 7946 0958",
    "0208315532", "1234567890", "555 010 1234 ", "+1 (555) 010-1234", "911", "55501012340",
    "000-000-0000", "1-800-FLOWERS", "555.010.1234 (mobile)", "+33 1 42 68 53 00", "11111111111"]) {
    console.log(`${JSON.stringify(raw).padEnd(28)} -> ${JSON.stringify(formatPhone(raw))}`);
  }
}

if (mode === "resume") {
  const cases: [string, string][] = [
    ["Aidan Matus-Enochs - Resume 1.docx", "Alex Rivera"],
    ["Resume.pdf", "Alex Rivera"],
    ["Alex Rivera Resume.pdf", "Alex Rivera"],
    ["KaiClausonResume.pdf", "Alex Rivera"],
    ["kai_clauson_resume.pdf", "Alex Rivera"],
    ["Clauson Resume.pdf", "Alex Rivera"],
    ["Aidan Resume.pdf", "Alex Rivera"],
    ["Resume - Goldman Sachs Analyst.pdf", "Alex Rivera"],
    ["Resume Summer Analyst Application.pdf", "Alex Rivera"],
    ["Morgan Stanley Resume.pdf", "Alex Rivera"],
    ["Aidan Matus-Enochs Resume.pdf", "Alex Rivera Aidan"],
    ["My Resume (Spring Recruiting).pdf", "Alex Rivera"],
    ["RESUME AIDAN MATUS.pdf", "Alex Rivera"],
    ["Resume Jan 2026.pdf", "Alex Rivera"],
    ["Priya Ravenel CV.docx", "Alex Rivera"],
  ];
  for (const [f, n] of cases) console.log(`${resumeLooksLikeSomeoneElses(f, n) ? "SOMEONE ELSE" : "mine        "}  ${f}   (student: ${n})`);
}

if (mode === "private") {
  const misses = [
    "She mentioned her husband's illness and how hard the treatment has been.",
    "He told me he is in recovery and no longer drinks.",
    "We talked about his custody battle and the settlement.",
    "She told me about her ADHD medication.",
    "He spoke about losing his daughter last year.",
    "She shared that she is on antidepressants.",
    "He mentioned his immigration status is still pending.",
    "We talked about her mental health and the hospital stay.",
    "He said he was let go in the last round of cuts.",
    "She mentioned her IVF treatments.",
    "He is going through a separation.",
    "She told me about her abortion.",
    "He said his son is in a treatment centre.",
    "She mentioned she had been sober for two years.",
    "He is on disability leave.",
    "She told me she voted for the measure and goes to synagogue on Fridays.",
    "He mentioned his HIV status.",
    "He was indicted last spring.",
    "She mentioned her tumour was benign.",
    "He said the firm is under SEC investigation and he was subpoenaed.",
  ];
  const fps = [
    "I was fascinated by your father's cancer research at the medical centre.",
    "I would love to hear about the Chapter 11 deal your team ran.",
    "Your work on the bankruptcy of Hertz was what got me interested in restructuring.",
    "I am taking a class on the economics of addiction this spring.",
    "I read your note on the lawsuit that reshaped the industry.",
    "The diagnostics company you took public is one I follow closely.",
    "I am interested in your pregnancy-tech portfolio company.",
    "I read the piece on how the firm was arrested mid-process - a figure of speech, I know.",
    "Your panel on anxiety in junior bankers was the most useful hour of my semester.",
    "The therapy-services roll-up your group did last year is what drew me in.",
    "I follow the oncology franchise and the chemotherapy pipeline closely.",
    "I would like to hear how the firm thinks about gambling and gaming credit.",
    "Our club pitched a rehab-clinic operator last spring.",
    "The DUI-detection hardware company in your portfolio caught my eye.",
    "I wrote my thesis on divorce rates and household formation.",
  ];
  console.log("== TOPICS THE WORD LIST MISSES (expect a hit, got none means a miss)");
  for (const s of misses) console.log(`  ${JSON.stringify(privateTopicsIn(s)).padEnd(24)} ${s}`);
  console.log("\n== BENIGN USES (expect no hit)");
  for (const s of fps) console.log(`  ${JSON.stringify(privateTopicsIn(s)).padEnd(28)} ${s}`);
}

if (mode === "goldrate") {
  // Per-category gold hit rate across all 234 bodies, the Tier-1 promotion test.
  const g = gold();
  const minimal = (name: string) => ({ contactName: name, contactFirm: null, gmailSignature: false, studentGradYear: null, brief: {}, purpose: null, extraContext: "" }) as never;
  const counts = new Map<string, number>();
  for (const x of g) {
    const name = x.body.match(/^(?:Hi|Hello|Dear)\s+([^,]+),/m)?.[1]?.trim() ?? "there";
    const r = draftChecks(minimal(name), x.body);
    for (const c of new Set(r.forReview.map(findingCategory))) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const ALL = ["long sentence", "clauses strung together", "also and too", "connector that isn't a cause", "split to then",
    "common ground tacked on", "student called an alum", "common ground as a discovery", "common ground doubled",
    "both doubled", "thank-you joined with and", "congratulations after the ask", "thank-you openers", "double space",
    "space before punctuation", "repeated word", "lowercase sentence start", "capital after a colon", "invented opinion",
    "how the student found them", "call asked of a recruiter", "background dropped out", "filler phrase", "comma splice",
    "dash as punctuation", "class year in the signature"];
  console.log(`gold bodies: ${g.length}`);
  for (const c of ALL) {
    const n = counts.get(c) ?? 0;
    console.log(`${c.padEnd(34)} ${String(n).padStart(4)}  ${(100 * n / g.length).toFixed(1)}%`);
  }
  for (const [k, v] of counts) if (!ALL.includes(k)) console.log(`UNLISTED ${k} ${v}`);
}

if (mode === "opinion") {
  // The invented-opinion gate: any of said|thought|told|mentioned|recommended in
  // what the student typed switches the check off for the whole email.
  const body = "Hi Rachel,\n\nEmily thought you would be the right person to talk to about the group.\n\nWould you have 15 minutes in the next two weeks?\n\nBest,\nKai";
  const base = { contactName: "Rachel", contactFirm: null, gmailSignature: false, studentGradYear: null, brief: {}, purpose: null } as const;
  for (const typed of ["", "Emily suggested I reach out to you.", "Emily referred me to you.", "Emily put me in touch.",
    "Emily pointed me your way.", "Emily said you would be a good person to talk to.", "Emily mentioned you."]) {
    console.log(`${JSON.stringify(typed).padEnd(52)} -> ${JSON.stringify(draftChecks({ ...base, extraContext: typed } as never, body).forReview)}`);
  }
}

if (mode === "filler192") {
  const per = gold().filter((x) => x.corpus === "per-type");
  const arms: [string, RegExp][] = [
    ["wanted to reach out/follow up/say", /\bI (?:just )?wanted to (?:reach out|follow up|say|touch base)\b/i],
    ["I hope this email finds you well", /\bI hope this (?:email|message|note) finds you well\b/i],
    ["made all the difference etc", /\b(?:made all the difference|exactly what I needed|even more excited)\b/i],
  ];
  for (const [n, re] of arms) console.log(`${n.padEnd(36)} ${per.filter((x) => re.test(mainText(x.body))).length}/192`);
}
