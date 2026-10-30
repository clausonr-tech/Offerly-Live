// Brings the `firms` / `firm_programs` tables in line with the firm catalog
// (src/lib/firm-content.ts + firm-seeds-bulk.json + firm-merges.json).
//
//   npm run db:sync-firms -- --dry-run         # do it all in a transaction, report, roll back
//   npm run db:sync-firms                      # insert/update; report orphans
//   npm run db:sync-firms -- --prune-orphans   # also delete unreferenced orphans
//
// Against a remote database (DATABASE_URL set, including from .env.local) a
// writing run also needs --yes, so a .env.local that points at production is
// never written to by accident; a dry run never does.
//
// Run it after changing any of those files, against each database that should
// carry the change. Nothing runs it automatically - not a request, not server
// boot, not install, not build. Safe to repeat: an up-to-date database is left
// untouched. Never deletes a firm unless --prune-orphans is given.
//
// Targets DATABASE_URL from the environment or .env.local; with none set, the
// local PGlite database. Stop any dev server on that PGlite directory first -
// two processes writing one PGlite directory corrupts it.
import { syncFirmCatalog } from "../src/lib/firm-sync";

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((a) => !["--dry-run", "--prune-orphans", "--yes"].includes(a));
if (unknown.length) {
  console.error(`Unknown option(s): ${unknown.join(" ")}. Use --dry-run, --prune-orphans and/or --yes.`);
  process.exit(2);
}
const dryRun = args.has("--dry-run");
const pruneOrphans = args.has("--prune-orphans");

function target(): string {
  const url = process.env.DATABASE_URL;
  if (!url) return `local PGlite (${process.env.PGLITE_DATA_DIR || "./local-data/pglite"})`;
  try {
    return `Postgres at ${new URL(url).hostname}`;
  } catch {
    return "Postgres (unparseable DATABASE_URL)";
  }
}

if (process.env.DATABASE_URL && !dryRun && !args.has("--yes")) {
  console.error(
    `[firms] refusing to write to ${target()} without --yes. Review a dry run first:\n` +
      `  npm run db:sync-firms -- --dry-run${pruneOrphans ? " --prune-orphans" : ""}\n` +
      `then repeat with --yes. For the local PGlite database, run with DATABASE_URL= (empty).`,
  );
  process.exit(2);
}

const t0 = Date.now();
console.log(`[firms] ${dryRun ? "dry run against" : "syncing"} ${target()}`);
syncFirmCatalog({ dryRun, pruneOrphans })
  .then((r) => {
    const verb = dryRun ? "would be" : "were";
    console.log(
      `[firms] ${r.seeds} catalog firms: ${r.inserted} inserted, ${r.updated} updated, ` +
        `${r.programsReplaced} with programs rewritten, ${r.unchanged} unchanged (${verb}).`,
    );
    const fmt = (c: Record<string, number>) =>
      Object.entries(c)
        .map(([dep, n]) => `${dep}=${n}`)
        .join(", ");
    for (const o of r.orphanDetails) {
      const parts = [
        o.mergedInto ? `merged into ${o.mergedInto}` : "not in the catalog",
        Object.keys(o.moved).length ? `moves ${fmt(o.moved)}` : "",
        Object.keys(o.droppedDuplicates).length ? `deletes duplicates ${fmt(o.droppedDuplicates)}` : "",
        Object.keys(o.blocking).length ? `still referenced by ${fmt(o.blocking)}` : "nothing references it",
        o.outcome === "removed"
          ? `firm row + ${o.programsDeleted} programme row(s) ${verb} deleted`
          : o.outcome === "blocked"
            ? "kept: deletion blocked"
            : "kept (no --prune-orphans)",
      ].filter(Boolean);
      console.log(`[firms] orphan ${o.slug}: ${parts.join("; ")}`);
    }
    if (r.removed.length) console.log(`[firms] ${r.removed.length} orphan(s) ${verb} removed: ${r.removed.join(", ")}`);
    if (r.kept.length) console.log(`[firms] ${r.kept.length} orphan(s) kept because rows still reference them.`);
    if (dryRun) console.log("[firms] dry run: every change above ran inside a transaction that was rolled back.");
    console.log(`[firms] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
