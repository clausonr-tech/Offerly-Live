// Scores a model's output against the held-out test set.
//
//   npx tsx --conditions=react-server scripts/eval-training.ts \
//     --test training-data/email_draft.sft.test.jsonl \
//     --predictions my-finetune.jsonl \
//     --blind-out review.md
//
// Flags:
//   --test <file>         held-out JSONL from export-training.ts (required)
//   --predictions <file>  one prediction per line, same order as --test
//   --blind-out <file>    write a shuffled A/B review sheet for human judging
//
// Deliberately provider-agnostic: it reads predictions from a file rather than
// calling any model itself, so the same harness scores a fine-tune, a hosted
// API, or a prompt change without knowing or caring which produced them.
// Generate predictions however you like; this only judges them.
import { readFileSync, writeFileSync } from "node:fs";

type SftLine = { messages: { role: string; content: string }[] };

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function readJsonl<T>(file: string): T[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

/**
 * Token-level F1 against the reference.
 *
 * A deliberately WEAK metric, and worth being honest about why it is here at
 * all: there is no automated score that tells you whether a cold email is
 * good. What this catches is the failure modes that are actually common and
 * cheap to detect - output that collapsed to a stub, drifted to a completely
 * different subject, or lost the placeholder convention. Treat a drop as a
 * signal to go and look, and never treat a rise as proof of improvement.
 * The blind sheet below is the real evaluation.
 */
function tokenF1(prediction: string, reference: string): number {
  const tok = (s: string) => s.toLowerCase().match(/[a-z0-9[\]_]+/g) ?? [];
  const p = tok(prediction);
  const r = tok(reference);
  if (p.length === 0 || r.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const t of r) counts.set(t, (counts.get(t) ?? 0) + 1);

  let overlap = 0;
  for (const t of p) {
    const left = counts.get(t) ?? 0;
    if (left > 0) {
      overlap += 1;
      counts.set(t, left - 1);
    }
  }
  if (overlap === 0) return 0;
  const precision = overlap / p.length;
  const recall = overlap / r.length;
  return (2 * precision * recall) / (precision + recall);
}

/** Placeholders must survive. A model that starts inventing real-looking names
 *  where [CONTACT] belonged is failing in a way token overlap barely notices. */
function placeholdersKept(prediction: string, reference: string): boolean {
  const find = (s: string) => new Set(s.match(/\[[A-Z_]+\]/g) ?? []);
  const expected = find(reference);
  if (expected.size === 0) return true;
  const got = find(prediction);
  return [...expected].every((p) => got.has(p));
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function main() {
  const testFile = flag("test");
  const predFile = flag("predictions");
  const blindOut = flag("blind-out");

  if (!testFile) {
    console.error("--test is required (a *.test.jsonl from export-training.ts).");
    process.exit(1);
  }

  const test = readJsonl<SftLine>(testFile);
  const references = test.map(
    (l) => l.messages.find((m) => m.role === "assistant")?.content ?? "",
  );
  const prompts = test.map((l) => l.messages.find((m) => m.role === "user")?.content ?? "");

  if (!predFile) {
    console.log(`\n${test.length} held-out example(s) in ${testFile}.`);
    console.log("No --predictions given, so nothing was scored.\n");
    console.log("Generate one prediction per line, in the same order, then re-run.\n");
    return;
  }

  const predictions = readJsonl<string | { output?: string; content?: string }>(predFile).map(
    (p) => (typeof p === "string" ? p : (p.output ?? p.content ?? "")),
  );

  if (predictions.length !== test.length) {
    console.error(
      `Prediction count (${predictions.length}) does not match the test set (${test.length}).\n` +
        "They are matched by position, so a mismatch means every score after the gap is wrong.",
    );
    process.exit(1);
  }

  const f1s = predictions.map((p, i) => tokenF1(p, references[i]));
  const kept = predictions.map((p, i) => placeholdersKept(p, references[i]));
  const empties = predictions.filter((p) => p.trim().length < 20).length;

  console.log(`\nScored ${test.length} example(s) from ${predFile}\n`);
  console.log(`  mean token-F1 vs reference : ${mean(f1s).toFixed(3)}`);
  console.log(
    `  placeholders preserved     : ${kept.filter(Boolean).length}/${kept.length}`,
  );
  console.log(`  suspiciously short outputs : ${empties}`);
  console.log(
    "\n  Token-F1 is a tripwire, not a verdict - it catches collapsed or drifted\n" +
      "  output, and says nothing about whether an email is any good.\n",
  );

  if (blindOut) {
    // Side A/B assignment is per-example and deterministic-by-coin-flip at
    // write time. Shuffled so the judge cannot learn "A is always the model",
    // with the key written at the bottom rather than inline.
    const key: string[] = [];
    const parts: string[] = [
      "# Blind review\n",
      "For each item, pick the better output. The key is at the bottom - ",
      "score everything before you read it.\n",
    ];

    test.forEach((_, i) => {
      const predFirst = Math.random() < 0.5;
      const a = predFirst ? predictions[i] : references[i];
      const b = predFirst ? references[i] : predictions[i];
      key.push(`${i + 1}. A = ${predFirst ? "model" : "human"}, B = ${predFirst ? "human" : "model"}`);
      parts.push(
        `\n---\n\n## ${i + 1}\n\n**Context**\n\n\`\`\`\n${prompts[i]}\n\`\`\`\n\n` +
          `**A**\n\n\`\`\`\n${a}\n\`\`\`\n\n**B**\n\n\`\`\`\n${b}\n\`\`\`\n\n` +
          `Better: [ ] A  [ ] B  [ ] tie\n`,
      );
    });

    parts.push(`\n---\n\n## Key\n\n${key.join("\n")}\n`);
    writeFileSync(blindOut, parts.join(""));
    console.log(`  Blind review sheet written to ${blindOut}\n`);
  }
}

main();
