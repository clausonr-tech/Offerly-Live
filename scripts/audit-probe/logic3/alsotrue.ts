// LOGIC-3 probe: the ALSO TRUE blocks in the real prompt for every multi-box
// combination. Reuses the committed sim harness so the inputs are the ones the
// product's own simulation uses.
import { buildDraftPrompt } from "@/lib/draft-prompt";
import { emailTypeById } from "@/lib/draft-templates";
import { sims } from "../../draft-occasions-sim";

const all = sims().filter((s) => s.profile === "full");
console.log(`multi-box combinations (full profile): ${all.length}`);

function alsoBlocks(userText: string): { label: string; lines: string[] }[] {
  const start = userText.indexOf("\nTHIS EMAIL\n");
  if (start < 0) return [];
  const rest = userText.slice(start + "\nTHIS EMAIL\n".length);
  const end = rest.search(/\n\n[A-Z][A-Z ’'()]{4,}\n/);
  const section = end < 0 ? rest : rest.slice(0, end);
  const out: { label: string; lines: string[] }[] = [];
  for (const line of section.split("\n")) {
    const h = line.match(/^ALSO TRUE - (.+?)\. Work these in/);
    if (h) out.push({ label: h[1], lines: [] });
    else if (out.length) out[out.length - 1].lines.push(line);
  }
  return out;
}

const silent: string[] = [];
const secondAsk: string[] = [];
const secondSubject: string[] = [];
const secondOpening: string[] = [];
let blockCount = 0, lineCount = 0;

const ASKY = /^(Ask (for|at most|two|three|whether|one)\b|No ask\b|Never ask for a referral\b|Keep it to one short paragraph plus the ask\b)/i;
const SUBJECTY = /subject line/i;
const OPENING = /\bOpen with\b|\bin the first line\b|\bLead with\b|\bin the first sentence\b|\bfirst two lines\b/i;

for (const s of all) {
  const { userText } = buildDraftPrompt(s.input);
  const blocks = alsoBlocks(userText);
  blockCount += blocks.length;
  const labels = new Set(blocks.map((b) => b.label));
  for (const t of s.input.alsoTypes ?? []) {
    const label = emailTypeById(t)!.label;
    if (!labels.has(label)) silent.push(`${s.id} [${s.ids.join(",")}] lead=${s.input.type} SILENT secondary=${t} ("${label}")`);
  }
  for (const b of blocks) {
    for (const line of b.lines) {
      if (!line.trim()) continue;
      lineCount++;
      if (ASKY.test(line)) secondAsk.push(`${s.id} lead=${s.input.type} also=${b.label} | ${line.trim()}`);
      if (SUBJECTY.test(line)) secondSubject.push(`${s.id} lead=${s.input.type} also=${b.label} | ${line.trim()}`);
      if (OPENING.test(line)) secondOpening.push(`${s.id} lead=${s.input.type} also=${b.label} | ${line.trim()}`);
    }
  }
}
console.log(`ALSO TRUE blocks built: ${blockCount}; lines inside them: ${lineCount}`);

const show = (title: string, rows: string[]) => {
  console.log(`\n=== ${title}: ${rows.length} occurrences ===`);
  const seen = new Map<string, number>();
  for (const r of rows) {
    const key = r.split("|")[1].trim();
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (seen.get(key) === 1) console.log("  first: " + r);
  }
  console.log(`  distinct lines: ${seen.size}`);
  for (const [k, n] of seen) console.log(`    x${n}  ${k.slice(0, 150)}`);
};
show("checked boxes contributing NO ALSO TRUE block", silent.map((s) => s + " | " + s));
show("ALSO TRUE lines that set an ask", secondAsk);
show("ALSO TRUE lines that set the subject line", secondSubject);
show("ALSO TRUE lines that set the opening", secondOpening);
