// Exports the de-identified training corpus to JSONL, ready for a fine-tune.
//
//   npx tsx --conditions=react-server scripts/export-training.ts --stats
//   npx tsx --conditions=react-server scripts/export-training.ts --task email_draft
//   npx tsx --conditions=react-server scripts/export-training.ts --task email_draft --format dpo
//
// Flags:
//   --stats              print corpus counts and readiness, write nothing
//   --task <name>        email_draft | resume_tailor   (default: both)
//   --format <fmt>       sft | dpo                     (default: sft)
//   --policy <version>   only rows captured under this policy version
//   --test-fraction <n>  held-out share, 0-1           (default: 0.2)
//   --out <dir>          output directory              (default: ./training-data)
//
// Writes <task>.<format>.train.jsonl and <task>.<format>.test.jsonl.
import { openScriptDb } from "./_db";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  isHeldOut,
  summarise,
  toDpo,
  toSft,
  VIABLE_PER_TASK,
  type ExampleRow,
  type TaskName,
} from "../src/lib/training-export";
import { allowsTraining } from "../src/lib/training-rule";

/**
 * Refuses to run while the dev server is up.
 *
 * PGlite is a single-process database. Two processes on the same data
 * directory has corrupted this project's local database twice, badly enough
 * both times that recovery needed pg_resetwal from a separately installed
 * Postgres build. Every other script in this directory asks for the dev server
 * to be stopped in a comment at the top, which works right up until the once
 * it doesn't - so this one checks instead of asking.
 */
function assertNoDevServer(): void {
  let running = "";
  try {
    running = execSync('pgrep -f "next dev|next-server" || true', {
      encoding: "utf8",
    }).trim();
  } catch {
    // pgrep unavailable - fall through rather than blocking the export on a
    // missing tool, since the guard is a safety net and not the only one.
    return;
  }
  if (running) {
    console.error(
      "Refusing to run: the dev server appears to be running (pids " +
        running.replace(/\s+/g, ", ") +
        ").\nPGlite allows one process at a time. Stop the dev server, then re-run.",
    );
    process.exit(1);
  }
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function pct(n: number, total: number): string {
  return total === 0 ? "0%" : `${Math.round((n / total) * 100)}%`;
}

async function main() {
  assertNoDevServer();

  const task = flag("task") as TaskName | undefined;
  const format = (flag("format") ?? "sft") as "sft" | "dpo";
  const policy = flag("policy");
  const testFraction = Number(flag("test-fraction") ?? 0.2);
  const outDir = flag("out") ?? "./training-data";

  if (format !== "sft" && format !== "dpo") {
    console.error(`Unknown --format "${format}". Use sft or dpo.`);
    process.exit(1);
  }

  const { db, close: closeDb } = await openScriptDb();
  const all = (await db.query.trainingExamples.findMany()) as unknown as ExampleRow[];

  // Only students who are opted in to Training Use RIGHT NOW. A student who
  // said no after an example was captured has had it deleted already
  // (lib/training-consent), but the export checks again rather than trust that.
  const people = await db.query.users.findMany({
    columns: { id: true, consentedPolicyVersion: true, trainingChoice: true, trainingChoicePolicyVersion: true },
  });
  const trainable = new Set(people.filter((u) => allowsTraining(u)).map((u) => u.id));
  const consented = all.filter((r) => !!r.userId && trainable.has(r.userId));
  if (consented.length < all.length) {
    console.log(`Skipped ${all.length - consented.length} example(s) from students not opted in to Training Use.`);
  }

  // Discarded examples are captured so the corpus knows they happened, but
  // they are not training targets - nobody wants a model fine-tuned toward
  // the drafts students threw away.
  let rows = consented.filter((r) => r.outcome !== "discarded");
  if (task) rows = rows.filter((r) => r.task === task);
  if (policy) rows = rows.filter((r) => r.policyVersion === policy);

  const stats = summarise(rows);

  console.log(`\nCorpus: ${stats.total} usable example(s)` + (task ? ` for ${task}` : ""));
  console.log(`  by task:     ${JSON.stringify(stats.byTask)}`);
  console.log(`  by outcome:  ${JSON.stringify(stats.byOutcome)}`);
  console.log(`  by policy:   ${JSON.stringify(stats.byPolicyVersion)}`);
  console.log(
    `  preference-pair eligible: ${stats.dpoEligible} (${pct(stats.dpoEligible, stats.total)})`,
  );
  console.log(`  with a reply label:       ${stats.withReplyLabel}`);

  for (const [name, count] of Object.entries(stats.byTask)) {
    const short = VIABLE_PER_TASK - count;
    console.log(
      short > 0
        ? `  readiness (${name}): ${count}/${VIABLE_PER_TASK} - ${short} more before a fine-tune is worth attempting`
        : `  readiness (${name}): ${count}/${VIABLE_PER_TASK} - enough to try`,
    );
  }

  if (has("stats")) {
    console.log("\n--stats given, nothing written.\n");
    await closeDb();
    return;
  }

  const tasks: TaskName[] = task ? [task] : ["email_draft", "resume_tailor"];
  mkdirSync(outDir, { recursive: true });

  for (const t of tasks) {
    const forTask = rows.filter((r) => r.task === t);
    if (forTask.length === 0) {
      console.log(`\n${t}: no examples, skipped.`);
      continue;
    }

    const train: string[] = [];
    const test: string[] = [];
    let skipped = 0;

    for (const row of forTask) {
      const line = format === "sft" ? toSft(row) : toDpo(row);
      if (!line) {
        // Only reachable for dpo: an accepted example has no rejected side.
        skipped += 1;
        continue;
      }
      (isHeldOut(row.id, testFraction) ? test : train).push(JSON.stringify(line));
    }

    const base = path.join(outDir, `${t}.${format}`);
    writeFileSync(`${base}.train.jsonl`, train.join("\n") + (train.length ? "\n" : ""));
    writeFileSync(`${base}.test.jsonl`, test.join("\n") + (test.length ? "\n" : ""));

    console.log(
      `\n${t}: wrote ${train.length} train / ${test.length} test to ${base}.*.jsonl` +
        (skipped ? `\n  (${skipped} skipped - no preference pair available)` : ""),
    );
  }

  console.log(
    "\nThe test split is derived from each example's id, so it is stable across runs -\n" +
      "the same examples stay held out as the corpus grows.\n",
  );

  await closeDb();
}

// Closing the PGlite handle is not optional here, and the failure mode is
// confusing rather than obvious: an open handle keeps the event loop alive
// forever, and because stdout is a pipe (not a TTY) whenever this is piped
// anywhere, Node buffers it fully instead of line by line - so the script
// appears to hang having printed nothing at all, rather than finishing and
// sitting idle with its output visible.
main();
