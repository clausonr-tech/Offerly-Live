// Refuses to run the demo against a real database, or to serve it to the LAN.
//
// `npm run demo` migrates and then seeds an account with invented firms,
// postings, contacts and a calendar entry. drizzle.config.ts points at
// DATABASE_URL whenever one is set, so running this with a production
// connection string in the environment would migrate and seed PRODUCTION. The
// demo is for the embedded local database and nothing else.
//
// WHY CHECKING THE SHELL IS NOT ENOUGH
// -----------------------------------
// This file used to check `process.env.DATABASE_URL` and stop there, and that
// covered only the first half of the chain. drizzle-kit and the two tsx seed
// scripts do not load .env.local (drizzle.config.ts says so), which is the
// premise the old check rested on - but the LAST step is `next dev`, and Next
// DOES load .env.local. So on any working copy whose .env.local defines
// DATABASE_URL, the guard passed, the seeds went to local PGlite, and then the
// server that actually took traffic was pointed at the live database. Without
// `-H 127.0.0.1` it also bound every interface, and under `next dev` the
// contact-credit and monthly-quota metering is off by design - a design whose
// own comment (contact-credits.ts) says it is safe BECAUSE the server is bound
// to loopback (security review, 10 October 2026).
//
// So the guard now checks the environment the SERVER step will resolve, by
// checking the command that starts it: the demo scripts must blank
// DATABASE_URL and bind loopback, exactly as `demo:network` already did. A
// control that lives in one npm script is a control one careless edit
// removes, so it is asserted here rather than assumed.
//
// .env.local IS NEVER READ FOR ITS VALUES. Whether it assigns DATABASE_URL is
// a key-name question and that is all this asks of it; the answer only
// decides whether to print a line saying the demo is overriding it.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

function refuse(lines) {
  console.error(["", ...lines.map((l) => `  ${l}`), ""].join("\n"));
  process.exit(1);
}

if (process.env.DATABASE_URL) {
  refuse([
    "npm run demo refuses to run with DATABASE_URL set.",
    "",
    "It seeds invented firms, postings and contacts, and DATABASE_URL is",
    "what points drizzle at a real database. Unset it for this shell:",
    "",
    "  env -u DATABASE_URL npm run demo",
    "",
    "Or use `npm run dev` against your own data instead.",
  ]);
}

/**
 * The npm script that invoked this, and what it does with the two controls.
 *
 * `npm_lifecycle_event` is set by npm to the script's name. Falling back to
 * "demo" means an unrecognised caller is held to the stricter rule rather than
 * waved through.
 */
const scriptName = process.env.npm_lifecycle_event ?? "demo";
let command = null;
try {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  command = pkg.scripts?.[scriptName] ?? null;
} catch {
  command = null;
}

if (command) {
  // Only the server step matters: the seeds run on PGlite either way.
  const serverStep = command.includes("next dev");
  // `DATABASE_URL=` (empty) in front of the command overrides whatever
  // .env.local holds, because process env beats .env.local in Next.
  const blanksDb = /(^|\s|&&\s*)DATABASE_URL=(\s|$)/.test(command);
  const loopback = /-H\s+127\.0\.0\.1\b/.test(command);
  if (serverStep && (!blanksDb || !loopback)) {
    refuse([
      `The "${scriptName}" script is missing a control the demo relies on.`,
      "",
      ...(blanksDb ? [] : [
        "  - It does not blank DATABASE_URL before `next dev`. Next loads",
        "    .env.local, so the dev server would serve the LIVE database",
        "    however clean this shell is.",
      ]),
      ...(loopback ? [] : [
        "  - It does not pass -H 127.0.0.1, so `next dev` binds every",
        "    interface. Dev mode runs with contact-credit and monthly-quota",
        "    metering off, and that is only safe on loopback.",
      ]),
      "",
      "Fix the script in package.json - see `demo:network` for the shape:",
      "",
      "  DATABASE_URL= next dev -H 127.0.0.1 --port 3001",
    ]);
  }
}

// Informational, and a key-name check only - no value is read or printed.
if (existsSync(path.join(root, ".env.local"))) {
  let assignsDb = false;
  try {
    assignsDb = readFileSync(path.join(root, ".env.local"), "utf8")
      .split("\n")
      .some((line) => /^\s*(export\s+)?DATABASE_URL\s*=/.test(line));
  } catch {
    assignsDb = false;
  }
  if (assignsDb) {
    console.log(
      "  .env.local assigns DATABASE_URL; the demo blanks it, so the dev server uses local PGlite.",
    );
  }
}
