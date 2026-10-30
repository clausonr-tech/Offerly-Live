# Firm catalog sync

The firm directory has two homes:

- **The catalog**, in code: `src/lib/firm-content.ts` (curated seeds), `src/lib/firm-seeds-bulk.json`
  (~22.5k imported firms), `src/lib/firm-merges.json`, plus the location, tier and AUM overlays in
  `src/lib/firm-profiles.ts` and `src/lib/firm-aum-corrections.ts`. `firm-content.ts` is server-only.
- **The `firms` and `firm_programs` tables**, which are what the app reads at runtime for search,
  firm detail pages and pagination.

`npm run db:sync-firms` copies the catalog into the tables. It is the **only** thing that does that.

## What changed

Until this change, `ensureFirmsSeeded()` ran at server boot (`src/instrumentation.ts`, whenever
`DATABASE_URL` was set) and at the top of every firm read in `src/lib/firms.ts`. Each new process
loaded every firm with its programs and diffed them against the catalog, which took about 9–13 s
against the remote database. That had two effects:

- **Deployments relied on it.** Every deploy or cold start pushed catalog edits into the production
  database automatically. That no longer happens.
- **It deleted orphaned firms automatically.** A firm that dropped out of the catalog was removed
  unless it had postings or shortlist entries. That delete cascaded to follows, recruiting contacts,
  monitoring sources, crawl history, events and more. Removing orphans is now opt-in, and it is
  blocked by any dependent row.

Nothing runs the sync automatically: not a request, server start, `postinstall` or `next build`.
The one exception is `npm run demo`, an explicit local demo setup, which runs it once against its
local PGlite database before seeding.

## One-time: deploying this change

The production database was already synced by every boot of the previous code. So if this deploy
doesn't change any catalog file, nothing needs to be written. Confirm that:

```bash
DATABASE_URL='<production url>' npm run db:sync-firms -- --dry-run
```

Expect `0 inserted, 0 updated, 0 with programs rewritten`. Any orphans listed are rows the old boot
sync chose to keep. This branch's catalog files may differ from what is deployed, so check the dry
run rather than assuming zero. If it reports changes, apply them:

```bash
DATABASE_URL='<production url>' npm run db:sync-firms -- --yes
```

A `DATABASE_URL` in the environment takes precedence over `.env.local`. Without one set, the command
reads `.env.local`, and if that has none either, it uses local PGlite. The first line of output
names the database it will touch. Against any remote database (a `DATABASE_URL` from either source),
a writing run refuses to start without `--yes`.

A dry run does the whole sync inside one database transaction and then rolls it back. Its report
is exactly what a real run would do, and nothing is committed. Rows it would change stay locked
until the rollback, which is a moment when the database is already in sync.

## Every time the catalog changes

After a deploy that changes any of the catalog files above, run the sync against **each** database
that should carry the change (production, staging, your local one):

```bash
npm run db:sync-firms -- --dry-run
npm run db:sync-firms -- --yes
```

Run it after the deploy is live. Until then the live site keeps serving the previous firm data,
exactly as the tables hold it. Firm reads are cached for up to 5 minutes (`sharedCache`, tag
`shared-firms`), and a CLI cannot revalidate that cache. Expect changes to appear within 5 minutes,
not immediately.

- **Idempotent.** A second run writes nothing.
- **All or nothing.** The whole run is one transaction. If it fails partway through, nothing is
  committed, and nothing is left half-synced or half-merged.
- **Non-destructive by default.** Firms are inserted or updated in place, so their ids and
  everything attached to them survive. Program rows for a changed firm are rewritten, because
  nothing references `firm_programs`.
- **Merges.** For a firm absorbed through `firm-merges.json`, rows in the 20 columns that reference
  it are handled per table. The policy table is `FIRM_DEPENDANTS` in `src/lib/firm-sync.ts`.
  - Moved to the parent: monitoring sources (as their firm or as their parent firm), recruiting
    contacts, contact-sourcing runs, engagement, posts, discussions, directory people and org
    accounts.
  - Moved unless the parent already has the same record: postings (same role and year), opening
    signals, student opening reports, recruiting events (same URL), notifications, match criteria
    and email patterns. A clashing row stays on the absorbed firm and blocks its deletion.
  - Moved after deleting the absorbed firm's copy of a row the parent already has: shortlist
    entries, follows and news tags. The parent's row is kept.
  - Never moved: the admin audit trail, which records what happened to that firm. It blocks
    deletion.
- **Orphans** (in the database but not in the catalog) are always kept unless you pass
  `--prune-orphans`. Even then, a firm is deleted only when no row in any of those 20 columns still
  points at it. That covers monitoring sources and their crawl history, events, contact-sourcing
  runs, signals, reports, notifications, news tags, audit rows and everything else. Only the firm
  row and its regenerable program rows are deleted. Anything else keeps the firm and is listed as
  blocking.

  ```bash
  npm run db:sync-firms -- --dry-run --prune-orphans
  npm run db:sync-firms -- --prune-orphans --yes
  ```

  For each orphan, the report lists the rows that move, the duplicate rows that are deleted, the
  rows that block deletion, and the outcome. After a merge, the absorbed row stays in search
  results until a pruning run removes it. Its firm page already redirects to the parent.
- **Schema changes.** `scripts/test/firm-sync-db.test.ts` reads every foreign key to `firms` from
  the migrated schema. It fails if one is missing from `FIRM_DEPENDANTS`, so a new table that
  references firms needs a merge policy before it ships.

## Local development

A fresh local PGlite database starts with no firms. Run `DATABASE_URL= npm run db:sync-firms`
once. The empty `DATABASE_URL=` makes sure a production URL in `.env.local` isn't picked up. Stop any dev
server using the same PGlite directory first, because two processes writing one PGlite directory
corrupts it. `npm run demo` and `npm run demo:network` already sync their own databases.

## Keeping the catalog out of the browser

Client components import labels, types and timeline content from `src/lib/firm-metadata.ts`, never
from `firm-content.ts`. `scripts/test/firm-catalog-client-boundary.test.ts` fails if any
`"use client"` module can reach `firm-seeds-bulk.json` again. Before this change, that file put a
5.1 MB chunk on five routes.
