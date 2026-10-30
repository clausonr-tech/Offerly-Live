// Teaches the Help assistant every page of the app.
//
//   npm run help:learn              relearn only pages whose code changed
//   npm run help:learn -- --force   relearn everything
//   npm run help:learn -- /outreach /schedule   relearn just these
//
// For each page a student can open (lib/help-knowledge-sources), it hashes the
// page's source files. Where the hash differs from src/lib/help-knowledge.json,
// or the page is new, it sends the code to Claude Haiku 4.5 and asks for a
// short student-facing guide to the page: what it is for, every control on it,
// how to do each thing, the limits a student will hit, and related pages.
// Unchanged pages cost nothing. Pages that no longer exist are dropped.
//
// This spends API credits (a full relearn of every page is well under a
// dollar; a normal run after editing one page is a cent or two). It never
// touches the database. The output is committed with the code, and
// scripts/test/help-knowledge-coverage.test.ts fails until it is current.

import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  forbiddenInKnowledge,
  hashSources,
  HELP_KNOWLEDGE_FILES,
  listHelpKnowledgeTargets,
  type HelpAudience,
  type HelpKnowledgeEntry,
  type HelpKnowledgeFile,
  type HelpKnowledgeTarget,
} from "../src/lib/help-knowledge-sources";

const ROOT = process.cwd();
// Haiku 5.5: a tenth of 4.5's price ($0.10/$0.50 against $1/$5), newer, 1M
// context. This script runs on every commit that touches a page a student can
// open, so the saving is small and constant rather than large and one-off.
const MODEL = "claude-haiku-5-5";
const PRICE = { input: 0.1, output: 0.5 }; // Haiku 5.5, $ per million tokens (prompts under 100K)
const CONCURRENCY = 4;
const VERSION = 1;

const WRITER_RULES = `You write the knowledge base for the Help assistant inside Offerly, a finance-recruiting app for college students (investment banking, private equity, hedge funds, asset management, sales and trading, and other finance sectors). The assistant answers students' questions about the app from what you write, so write for a STUDENT who uses the app, never for a developer.

You are given the source code of ONE part of the app. Read it closely and write that part's entry in EXACTLY this shape:

TITLE: <the page's name as a student sees it>
For: <one line: what a student uses this page for>
Get there: <the sidebar label or button that leads here, and the web address>
Do here:
- "<exact on-screen label>": what it does, with brief steps when not obvious
- ... one bullet per feature or control a student can use
Limits:
- <limits and rules a student will hit: daily limits, character limits, required fields, Free vs Pro, locked or empty states>
Related: <other pages by name and address>

Rules:
- HARD LIMIT: 250 words (the overview may use 400). Count them. Cover every ACTION a student can take; cut everything else first.
- Use the exact labels on screen (button text, tab names, field names, filters) in double quotes, so a student can find them.
- Skip visual details: colours, layout, spacing, responsive behaviour, icons, animations, hover effects.
- Plain text only. No markdown headings, no bold, no tables, no code. Omit the Limits line if there are none.
- Describe only what the code shows. Never invent a feature, a number, a label, a page or an address. State a number or limit ONLY if it appears in the code you were given; otherwise leave it out. Name only pages and addresses that appear in the code.
- Never mention: code, files, components, functions, databases, servers, APIs, API keys, environment settings, secrets, tokens, internal names, which AI model or company powers anything, or anything only staff or administrators can see or do. Say "AI" if the page uses AI.
- If the page only redirects somewhere else, write two lines: TITLE, and "For: opens <page name> (<address>)".`;

// The firm portal's assistant has its own knowledge file, written for a
// recruiter at a firm rather than a student. Same shape and the same rules.
const FIRM_WRITER_RULES = WRITER_RULES.replace(
  "You write the knowledge base for the Help assistant inside Offerly, a finance-recruiting app for college students (investment banking, private equity, hedge funds, asset management, sales and trading, and other finance sectors). The assistant answers students' questions about the app from what you write, so write for a STUDENT who uses the app, never for a developer.",
  "You write the knowledge base for the Help assistant inside the Offerly FIRM PORTAL: the part of Offerly, a finance-recruiting app for college students, where recruiters at banks, funds and other finance firms post internships and campus events and see how students engage with them. The assistant answers a RECRUITER's questions about the firm portal from what you write, so write for a recruiter at a firm, never for a developer and never for a student.",
)
  .replaceAll("a student sees", "a recruiter sees")
  .replaceAll("a student uses", "a recruiter uses")
  .replaceAll("a student can take", "a recruiter can take")
  .replaceAll("a student can use", "a recruiter can use")
  .replaceAll("a student will hit", "a recruiter will hit")
  .replaceAll("student-facing", "recruiter-facing")
  .replaceAll("Write for a STUDENT", "Write for a RECRUITER");

// A failed replace would quietly teach the firm assistant the student's rules.
if (!FIRM_WRITER_RULES.includes("FIRM PORTAL")) throw new Error("FIRM_WRITER_RULES did not take - WRITER_RULES' opening changed.");

function sourceText(target: HelpKnowledgeTarget): string {
  return target.sources.map((rel) => `===== ${rel} =====\n${readFileSync(path.join(ROOT, rel), "utf8")}`).join("\n\n");
}

function taskFor(target: HelpKnowledgeTarget, audience: HelpAudience): string {
  if (audience === "firm" && target.kind === "overview") {
    return (
      "Write the OVERVIEW entry for the firm portal: what it is for and who it is for, how a firm account is verified and approved, " +
      "the sections of the sidebar and what each is for (with its address), and how what a firm posts reaches students. Use the guide and navigation list below."
    );
  }
  if (audience === "firm" && target.kind === "shell") {
    return (
      "Write the entry for the PORTAL FRAME that surrounds every page of the firm portal: the sidebar and its sections, the top bar, the help button, " +
      "the account menu (and what is in it), the theme toggle, and what an account that is not approved yet sees. TITLE it \"Around the portal\"."
    );
  }
  if (target.kind === "overview") {
    return (
      "Write the OVERVIEW entry: what Offerly is and who it is for, the point of the product, the sections of the sidebar and what each is for (with its address), " +
      "and the recruiting path a student follows through the app, step by step with where each step happens. Use the readme, the recruiting workflow notes, " +
      "the help guide and the navigation list below. Skip anything about how the app is built or run."
    );
  }
  if (target.kind === "shell") {
    return (
      "Write the entry for the APP FRAME that surrounds every signed-in page: the sidebar and its sections, the top bar, the notification bell, the help menu " +
      "(and its \"?\" shortcut), the account menu, the theme toggle, the footer, and any prompts or bubbles that pop up. TITLE it \"Around the app\"."
    );
  }
  return `Write the entry for the page at ${target.key}.`;
}

function parseEntry(raw: string): { title: string; text: string } {
  const lines = raw.replace(/\r\n?/g, "\n").trim().split("\n");
  const titleLine = lines.findIndex((l) => /^\s*TITLE:/i.test(l));
  const title = titleLine >= 0 ? lines[titleLine].replace(/^\s*TITLE:\s*/i, "").trim() : "";
  const body = (titleLine >= 0 ? lines.slice(titleLine + 1) : lines)
    .join("\n")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[*•]\s+/gm, "- ")
    .replace(/^\s*\(?word count:.*$/gim, "") // the model sometimes reports its own count
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text: body };
}

let spentIn = 0;
let spentOut = 0;

async function learn(
  client: Anthropic,
  target: HelpKnowledgeTarget,
  hash: string,
  audience: HelpAudience,
): Promise<HelpKnowledgeEntry> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `${taskFor(target, audience)}\n\nSOURCE:\n\n${sourceText(target)}` },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: target.kind === "overview" ? 1200 : 900,
      system: audience === "firm" ? FIRM_WRITER_RULES : WRITER_RULES,
      messages,
    });
    spentIn += response.usage.input_tokens;
    spentOut += response.usage.output_tokens;
    const raw = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const { title, text } = parseEntry(raw);
    const bad = forbiddenInKnowledge(`${title}\n${text}`);
    const words = text.split(/\s+/).length;
    const cap = target.kind === "overview" ? 450 : 300;
    const tooLong = words > cap || response.stop_reason === "max_tokens";
    if (!bad.length && text && !tooLong) return { hash, sources: target.sources, title: title || target.key, text };

    if (attempt === 0) {
      const fixes = [
        bad.length && `remove every mention of: ${bad.join(", ")}`,
        tooLong && `cut it to under ${cap - 50} words (it is ${words}) by dropping visual details and merging bullets, keeping every action a student can take`,
        !text && "write the entry - it came back empty",
      ].filter(Boolean);
      // The rewrite sees only the draft, not the source again: it is an edit,
      // and resending a whole page's code to shorten 400 words would double
      // the cost of every long page.
      messages.splice(0, messages.length, {
        role: "user",
        content: `Here is a draft entry:\n\n${raw}\n\nRewrite the whole entry: ${fixes.join("; ")}. Same shape, ${audience === "firm" ? "recruiter" : "student"}-facing only. Do not add anything that is not in the draft.`,
      });
      continue;
    }
    // Second miss: drop the offending lines rather than ship them.
    const clean = text
      .split("\n")
      .filter((l) => !forbiddenInKnowledge(l).length)
      .join("\n")
      .trim();
    const cleanTitle = forbiddenInKnowledge(title).length ? target.key : title || target.key;
    return { hash, sources: target.sources, title: cleanTitle, text: clean };
  }
  throw new Error("unreachable");
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set. Run with --env-file=.env.local (npm run help:learn does).");
  const args = process.argv.slice(2);
  // Both assistants by default; `--audience firm` or `--audience student` for one.
  const which = args.includes("--audience") ? (args[args.indexOf("--audience") + 1] as HelpAudience) : null;
  const audiences: HelpAudience[] = which ? [which] : ["student", "firm"];
  for (const audience of audiences) await learnAudience(audience, args);
}

async function learnAudience(audience: HelpAudience, args: string[]) {
  const OUT = path.join(ROOT, HELP_KNOWLEDGE_FILES[audience]);
  const force = args.includes("--force");
  const only = args.filter((a) => a.startsWith("/") || a === "overview" || a === "shell");
  console.log(`\n[${audience}]`);

  const existing: HelpKnowledgeFile = existsSync(OUT)
    ? JSON.parse(readFileSync(OUT, "utf8"))
    : { version: VERSION, generatedAt: "", entries: {} };

  const targets = listHelpKnowledgeTargets(ROOT, audience);
  const entries: Record<string, HelpKnowledgeEntry> = {};
  const todo: { target: HelpKnowledgeTarget; hash: string }[] = [];

  for (const target of targets) {
    const hash = hashSources(ROOT, target.sources);
    const prev = existing.entries[target.key];
    const wanted = only.length ? only.includes(target.key) : true;
    const current = prev && prev.hash === hash && prev.sources.join("|") === target.sources.join("|");
    if (prev) entries[target.key] = prev;
    if (wanted && (force || !current)) todo.push({ target, hash });
  }
  const dropped = Object.keys(existing.entries).filter((k) => !targets.some((t) => t.key === k));

  console.log(`${targets.length} pages known; ${todo.length} to learn${dropped.length ? `; dropping ${dropped.join(", ")}` : ""}.`);

  const client = new Anthropic();
  const save = () => {
    const ordered: Record<string, HelpKnowledgeEntry> = {};
    for (const t of targets) if (entries[t.key]) ordered[t.key] = entries[t.key];
    const file: HelpKnowledgeFile = { version: VERSION, generatedAt: new Date().toISOString(), entries: ordered };
    writeFileSync(OUT, JSON.stringify(file, null, 2) + "\n");
  };

  let next = 0;
  const failures: string[] = [];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < todo.length) {
        const { target, hash } = todo[next++];
        try {
          entries[target.key] = await learn(client, target, hash, audience);
          console.log(`  learned ${target.key} (${entries[target.key].text.split(/\s+/).length} words)`);
          save();
        } catch (err) {
          failures.push(target.key);
          console.error(`  FAILED ${target.key}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }),
  );
  save();

  const cost = (spentIn * PRICE.input + spentOut * PRICE.output) / 1_000_000;
  const words = Object.values(entries).reduce((n, e) => n + e.text.split(/\s+/).length, 0);
  console.log(`Done. ${Object.keys(entries).length} entries, ~${words} words. Spent ${spentIn} in / ${spentOut} out tokens = $${cost.toFixed(4)}.`);
  if (failures.length) {
    console.error(`${failures.length} failed: ${failures.join(", ")}. Run again to retry them.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
