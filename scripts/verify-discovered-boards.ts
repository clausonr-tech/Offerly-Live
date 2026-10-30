/**
 * Re-point sources at the boards discover-boards.ts found - but only the ones
 * that actually parse.
 *
 * NOTHING IS WRITTEN ON THE STRENGTH OF DISCOVERY ALONE. That rule is
 * apply-discovered-boards.ts's, and it is the whole reason this step exists
 * separately: a board that returns zero listings and a wrong URL look
 * identical in the database afterwards, so each candidate is FETCHED through
 * the connector that would poll it and written only if something real came
 * back.
 *
 * The 20 September run makes the case. Discovery found 21 boards for sources
 * that had never produced a listing - CIBC on Workday, BNP Paribas USA on
 * TalentLink, Solomon Partners and Ducera on Greenhouse - and among them:
 *
 *   Ballistic Ventures  -> jobs.lever.co/revealtech      a portfolio company
 *   Mercury Fund        -> jobs.ashbyhq.com/plasma       a portfolio company
 *   Learn Capital       -> jobs.ashbyhq.com/amplify      a portfolio company
 *   Mac Venture Capital -> getro.com/getro-jobs          the VENDOR's own site
 *
 * A venture firm's careers page links to its portfolio companies' boards, and
 * those links are indistinguishable from its own by shape alone. Pointing a
 * firm at somebody else's vacancies would be worse than the silence it
 * replaced, because the listings would look real.
 *
 * So: parse first, then a name check, then write. A candidate that parses but
 * whose token bears no relation to the firm's name is reported for a human
 * rather than applied.
 *
 * Dry-run by default; pass --apply to write.
 *
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/verify-discovered-boards.ts
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/verify-discovered-boards.ts --apply
 */
import { readFileSync } from "fs";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { openDb } from "../src/db/open";
import { assertExclusiveDbAccess } from "../src/lib/monitoring/exclusive-db";
import { getConnector, closeGenericConnectorBrowser } from "../src/lib/monitoring/connectors";
import { normalizeBoardUrl } from "../src/lib/monitoring/board-url";

const APPLY = process.argv.includes("--apply");
const IN = "scripts/data/discovered-boards.json";

type DiscoveredBoard = {
  firmId: string;
  sourceId: string;
  firmName: string;
  currentUrl: string;
  connectorId: string;
  boardUrl: string;
  viaVendorCdn: boolean;
};

/**
 * Does this board's token plausibly belong to this firm?
 *
 * Deliberately generous - it only has to catch the case where a board belongs
 * to somebody else entirely. "solomonpartnersstudentsgraduates" for Solomon
 * Partners passes on "solomon"; "revealtech" for Ballistic Ventures matches
 * nothing and is held back.
 *
 * Generous because the cost is asymmetric: a firm wrongly held back is a line
 * in a report somebody reads, and a firm wrongly applied is a student sent to
 * another company's jobs.
 */
export function tokenLooksLikeFirm(boardUrl: string, firmName: string): boolean {
  const token = boardUrl.toLowerCase().replace(/[^a-z0-9]/g, "");
  const words = firmName
    .toLowerCase()
    .replace(/\b(llc|lp|ltd|limited|inc|plc|co|company|group|partners|capital|management|advisors|ventures|holdings|the|and|of|us|usa)\b/g, " ")
    .split(/[^a-z0-9]+/)
    // Three, not four. A bank's board token is often an abbreviation - BNP
    // Paribas USA publishes on `bnppus.tal.net`, which contains "bnp" and
    // nothing else from the name. At four characters that real board was held
    // back as somebody else's.
    .filter((w) => w.length >= 3);
  // A firm whose name is entirely stopwords gives nothing to check against,
  // and refusing everything it finds would be the wrong direction.
  if (!words.length) return true;
  return words.some((w) => token.includes(w));
}

async function main() {
  await assertExclusiveDbAccess({ viaOpenDb: true });
  const opened = await openDb();
  const db = opened.db;
  console.log(`database: ${opened.backend}${APPLY ? "" : "  (dry run)"}`);

  let report: { discovered: DiscoveredBoard[] };
  try {
    report = JSON.parse(readFileSync(IN, "utf8"));
  } catch {
    console.log(`${IN} not found - run scripts/discover-boards.ts first.`);
    await opened.close();
    return;
  }

  const candidates = report.discovered ?? [];
  console.log(`${candidates.length} candidate board(s) to verify\n`);

  const applied: string[] = [];
  const emptied: string[] = [];
  const wrongFirm: string[] = [];
  const failed: string[] = [];

  try {
    for (const [i, c] of candidates.entries()) {
      const tag = `[${i + 1}/${candidates.length}]`;
      // normalizeBoardUrl also rejects the shapes that are not boards at all -
      // a CDN bundle, a script, a search-results widget. Discovery matched the
      // Phenom pattern against RBC's page and returned a .js file.
      const normalized = normalizeBoardUrl(c.boardUrl);
      if (!normalized.ok) {
        failed.push(`  ${c.firmName.padEnd(34)} ${normalized.reason}`);
        console.log(`${tag} ${c.firmName}: ${normalized.reason} - HELD`);
        continue;
      }
      const url = normalized.url;

      if (!tokenLooksLikeFirm(url, c.firmName)) {
        wrongFirm.push(`  ${c.firmName.padEnd(34)} ${url}`);
        console.log(`${tag} ${c.firmName}: token does not look like this firm - HELD`);
        continue;
      }

      const connector = getConnector(c.connectorId);
      let parsed = 0;
      try {
        const result = await connector.fetch({ careersUrl: url, sourceType: "ats", lastEtag: null });
        parsed = result.listings.length;
      } catch (err) {
        failed.push(`  ${c.firmName.padEnd(34)} ${(err as Error).message.slice(0, 60)}`);
        console.log(`${tag} ${c.firmName}: fetch failed`);
        continue;
      }

      /**
       * An empty board is stored. A board we could not READ is not.
       *
       * apply-discovered-boards.ts refuses to store anything returning zero
       * listings, on the grounds that "an empty board and a wrong URL look
       * identical in the database afterwards". That was true when it was
       * written and is not true here, for two reasons that did not exist then:
       * the token has already been checked against the firm's name, and the
       * fetch above distinguishes a clean empty answer from a failure.
       *
       * Checked directly on 20 September 2026 - Solomon Partners, Laurion
       * Capital, Setpoint and Energize all answer:
       *
       *   HTTP 200   {"jobs":[]}   30 bytes
       *
       * That is a firm with nothing posted today, not an address nobody
       * verified. And refusing it is the worse error: those sources currently
       * point at a homepage or a contact form, which can NEVER yield a
       * listing, while the firm's real board sits ready to be read the moment
       * they post. Storing an empty board costs one cheap poll a cycle;
       * refusing it costs every opening the firm ever publishes.
       *
       * A fetch that THREW is still refused, above - that is the case the
       * original rule was protecting against, and it still is.
       */
      const note = parsed === 0 ? " (empty today - real board, nothing posted)" : "";
      console.log(`${tag} ${c.firmName}: ${parsed} listing(s) via ${c.connectorId}${note} -> ${url}`);
      (parsed === 0 ? emptied : applied).push(
        `  ${c.firmName.padEnd(34)} ${String(parsed).padStart(4)}  ${c.connectorId.padEnd(12)} ${url}`,
      );

      if (APPLY) {
        await db
          .update(schema.firmMonitoringSources)
          .set({
            careersUrl: url,
            connectorId: c.connectorId,
            // Due immediately: the point of re-pointing is to read it.
            nextCheckAt: new Date(),
            failureCount: 0,
            sourceHealth: "healthy",
            lastContentHash: null,
            notes: `re-pointed ${new Date().toISOString().slice(0, 10)} from ${c.currentUrl}`,
            updatedAt: new Date(),
          })
          .where(eq(schema.firmMonitoringSources.id, c.sourceId));
      }
    }
  } finally {
    await closeGenericConnectorBrowser();
  }

  const section = (title: string, rows: string[]) => {
    if (!rows.length) return;
    console.log(`\n===== ${title} (${rows.length}) =====`);
    for (const r of rows) console.log(r);
  };

  section(APPLY ? "RE-POINTED" : "WOULD RE-POINT", applied);
  section(APPLY ? "RE-POINTED, EMPTY TODAY" : "WOULD RE-POINT, EMPTY TODAY", emptied);
  section("TOKEN DOES NOT MATCH THE FIRM - needs a human", wrongFirm);
  section("FETCH FAILED", failed);

  if (!APPLY) console.log("\nDry run - pass --apply to write.");
  await opened.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
