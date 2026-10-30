// Parses the pypdf text dump of Volume V (combination emails) into sections
// (format and notes per combination) and examples keyed by the picker's box ids.
import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
const lines = readFileSync(input, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l !== "" && l !== "=====PAGE=====" && !/^Fictional examples, page \d+$/.test(l));

// [title, box ids for each example in order]
const A = "first.alum", REF = "first.referred", MET = "first.met", REC = "first.recruiter", CONF = "first.conference", PT = "first.pointed";
const SECTIONS = [
  ["1.  Referral + Alum", [[REF, A], [REF, A], [REF, A]]],
  ["2.  Met in Person + Alum", [[MET, A], [MET, A], [MET, A]]],
  ["3.  Campus Recruiter + Alum", [[REC, A], [REC, A], [REC, A]]],
  ["4.  Coffee Chat Thank You + They Offered to Help", [["thanks.helped", "thanks.chat"], ["thanks.helped", "thanks.chat"], ["thanks.helped", "thanks.chat"]]],
  ["5.  Keep in Touch + Congratulations", [["stay.update", "stay.congrats"], ["stay.update", "stay.congrats"], ["stay.update", "stay.congrats"]]],
  ["6.  Thanking the Person Who Introduced You + an Update", [["stay.referrer", "stay.update"], ["stay.referrer", "stay.update"], ["stay.referrer", "stay.update"]]],
  ["7.  Referral + Met in Person", [[REF, MET], [REF, MET]]],
  ["8.  Referral + Campus Recruiter", [[REF, REC], [REF, REC]]],
  ["9.  Met at a Conference + Campus Recruiter", [[CONF, REC], [CONF, REC]]],
  ["10.  They Offered to Help + a Talk a Banker Gave", [["thanks.helped", "thanks.event"], ["thanks.helped", "thanks.event"]]],
  ["11.  They Offered to Help + a Session a Recruiter Ran", [["thanks.helped", "thanks.session"], ["thanks.helped", "thanks.session"]]],
  ["12.  Thanking the Person Who Introduced You + Congratulations", [["stay.referrer", "stay.congrats"], ["stay.referrer", "stay.congrats"]]],
  ["13.  Second Conversation + an Update", [["stay.second", "stay.update"], ["stay.second", "stay.update"]]],
  ["14.  Someone I Emailed Sent Me to Them + Alum", [[PT, A], [PT, A]]],
  ["15.  Referral + Someone I Emailed Sent Me to Them", [[REF, PT], [REF, PT]]],
  ["16.  Three or More Boxes at Once", [[REF, MET, A, REC], [REF, PT, MET, A]]],
  ["17.  Thanking the Person Who Sent You Elsewhere + an Update or", [["stay.redirected", "stay.update"], ["stay.redirected", "stay.congrats"]]],
  ["18.  Second Conversation + Thanking the Person Who Introduced You", [["stay.second", "stay.referrer"], ["stay.second", "stay.redirected"]]],
];

let cursor = lines.findIndex((l) => l.startsWith("Each example below carries"));
const starts = SECTIONS.map(([title]) => {
  const i = lines.findIndex((l, idx) => idx > cursor && l === title);
  if (i < 0) throw new Error(`not found: ${title}`);
  return (cursor = i);
});

const EXAMPLE_WORDS = ["One", "Two", "Three"];
// Paragraph ends checked by hand against the PDF, where the width rule guesses wrong.
const FORCE_BREAK = ["for a dental services platform.", "in a way that finally made it click."];
const bodyLens = [];
const sections = [];
const examples = [];
const review = [];

// Pass 1: find the example body lines, to learn the PDF's line width.
const raw = [];
SECTIONS.forEach(([title, boxes], si) => {
  const end = si + 1 < starts.length ? starts[si + 1] : lines.length;
  const sec = lines.slice(starts[si], end);
  let k = 1;
  if (si === 16) k = 2; // the title wraps onto a second line
  const timing = sec[k];
  const fmtAt = sec.indexOf("Format:");
  const exAt = sec.indexOf("Examples:");
  const format = [];
  const notes = [];
  let inNotes = false;
  for (const l of sec.slice(fmtAt + 1, exAt)) {
    let m;
    if (!inNotes && (m = l.match(/^\d+\.\s+(.*)$/))) {
      if (m[1] === "Notes:") inNotes = true;
      else format.push(m[1]);
    } else if (inNotes && (m = l.match(/^[a-c]\.\s+(.*)$/))) notes.push(m[1]);
    else if (inNotes) notes[notes.length - 1] += " " + l;
    else format[format.length - 1] += " " + l;
  }
  const fullTitle = si === 16 ? `${title} ${sec[1]}` : title;
  sections.push({ section: si + 1, title: fullTitle.replace(/^\d+\.\s+/, ""), timing, format, notes });

  let n = 0;
  for (let i = exAt + 1; i < sec.length; i++) {
    if (!EXAMPLE_WORDS.includes(sec[i])) continue;
    let j = i + 1;
    if (!sec[j].startsWith("Boxes: ")) throw new Error(`s${si + 1} ${sec[i]}: no Boxes line`);
    let note = sec[j].slice("Boxes: ".length);
    while (!sec[j + 1].startsWith("Subject: ") && !sec[j + 1].startsWith("What the student typed:")) note += " " + sec[++j];
    j++;
    let typed;
    if (sec[j].startsWith("What the student typed:")) {
      typed = sec[j];
      while (!typed.endsWith("”")) typed += " " + sec[++j];
      typed = typed.replace(/^What the student typed:\s*/, "");
      j++;
    }
    const subject = sec[j].slice("Subject: ".length);
    const greeting = sec[j + 1];
    const bestIdx = sec.findIndex((l, x) => x > j + 1 && l === "Best,");
    const wordsIdx = sec.findIndex((l, x) => x > bestIdx && /^\[\d+ words\]$/.test(l));
    const signature = sec.slice(bestIdx, wordsIdx);
    const bodyLines = sec.slice(j + 2, bestIdx);
    bodyLines.forEach((l) => bodyLens.push(l.length));
    raw.push({ section: si + 1, which: sec[i], boxes: boxes[n], note, typed, subject, greeting, bodyLines, signature, words: Number(sec[wordsIdx].match(/\d+/)[0]) });
    n++;
    i = wordsIdx;
  }
  if (n !== boxes.length) throw new Error(`s${si + 1}: ${n} examples, ${boxes.length} mapped`);
});

const W = Math.max(...bodyLens);
for (const ex of raw) {
  const paras = [];
  let para = [];
  ex.bodyLines.forEach((l, k) => {
    para.push(l);
    const next = ex.bodyLines[k + 1];
    if (!next) return;
    const terminal = /[.!?:”")]$/.test(l);
    const nextWord = next.split(" ")[0];
    const fits = l.length + 1 + nextWord.length <= W;
    if (terminal && l.length >= W - 20) review.push(`[s${ex.section} ${ex.which}] ${fits ? "BREAK" : "join "} len=${l.length} next=${nextWord.length} | …${l.slice(-40)} || ${next.slice(0, 30)}`);
    if (terminal && (fits || FORCE_BREAK.some((f) => l.endsWith(f)))) {
      paras.push(para.join(" "));
      para = [];
    }
  });
  if (para.length) paras.push(para.join(" "));
  const body = [ex.greeting, ...paras].join("\n\n") + "\n\n" + ex.signature.join("\n");
  const count = paras.join(" ").split(/\s+/).filter(Boolean).length;
  const note = [ex.note, ex.typed && `what the student typed: ${ex.typed}`].filter(Boolean).join("; ");
  examples.push({ section: ex.section, boxes: [...ex.boxes].sort(), note, subject: ex.subject, body });
  console.log(`s${String(ex.section).padEnd(2)} ${ex.which.padEnd(5)} ${ex.boxes.join("+").padEnd(62)} paras=${paras.length} words=${count}/${ex.words}${Math.abs(count - ex.words) > 3 ? "  <-- CHECK" : ""}`);
}
writeFileSync(output, JSON.stringify({ sections, examples }, null, 2) + "\n");
console.log(`W=${W} sections=${sections.length} examples=${examples.length}\nREVIEW:\n${review.join("\n")}`);
