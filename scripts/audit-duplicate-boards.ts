// Which monitored sources are the same board under two firm names?
//
// The known cost: 313 duplicate listing rows across four pairs - Stifel and
// Miller Buckfire (149), Cantor Fitzgerald and BGC (84), Cowen and TD (40),
// Mizuho and Greenhill (40). Every duplicate is a fetch that buys nothing and
// a second copy of each listing that then has to be classified and reviewed.
//
// `parentFirmId` exists in the schema for exactly this and is null on all 106
// sources. This names the pairs; --apply links the second source to the first
// and stops it being polled.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/audit-duplicate-boards.ts [--apply]
//
// Stop the dev server first - PGlite is single-writer.
import { openScriptDb } from "./_db";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { dedupKey, boardIdentity } from "../src/lib/monitoring/board-identity";

const APPLY = process.argv.includes("--apply");
/** Link pairs whose owner could not be determined from the board itself. */
const FORCE = process.argv.includes("--force");

async function main() {
  const { db, close: closeDb } = await openScriptDb();

  try {
    const sources = await db.query.firmMonitoringSources.findMany({
      with: { firm: true, detectedListings: { columns: { id: true } } },
    });

    const groups = new Map<string, typeof sources>();
    for (const source of sources) {
      const key = dedupKey(source.careersUrl, source.connectorId);
      groups.set(key, [...(groups.get(key) ?? []), source]);
    }

    const duplicated = [...groups.entries()].filter(([, group]) => group.length > 1);

    console.log(`${sources.length} sources -> ${groups.size} distinct boards.`);
    if (!duplicated.length) {
      console.log("No board is monitored twice.");
      return;
    }

    let wouldLink = 0;
    let listingsBehindDuplicates = 0;

    for (const [key, group] of duplicated) {
      /**
       * Which firm keeps the board, and which becomes its child.
       *
       * Listings-then-age was the first rule and it produced two links that
       * read backwards: TD Securities parented to Cowen on `td.wd3...`, and
       * MUFG Securities parented to Intrepid on `mufgub.wd3...`. Both pairs
       * have identical listing counts, so the tie fell to creation order,
       * which carries no meaning at all.
       *
       * The board itself says who owns it. `mufgub.wd3.myworkdayjobs.com` and
       * `careers-stifel.icims.com` name their tenant, so a firm whose name
       * appears in the board key is the owner and the other is the sub-brand
       * riding on it. That ordering is what parentFirmId is supposed to mean.
       */
      /**
       * The tenant label, which is the part of the key the ATS vendor let the
       * employer choose: "td" from `td.wd3.myworkdayjobs.com`, "mufgub" from
       * `mufgub.wd3...`, "careers-stifel" from `careers-stifel.icims.com`.
       */
      const tenant = (key.split(":")[1] ?? "").split(".")[0];

      const ownsBoard = (firmName: string) => {
        const words = firmName
          .toLowerCase()
          .replace(/[^a-z0-9 ]/g, "")
          .split(/\s+/)
          .filter(Boolean);

        // An EXACT match against the tenant counts at any length. This is the
        // TD case: "TD Securities" and "Cowen" share `td.wd3...`, and a
        // minimum word length of four - needed to stop "group" and "bank"
        // matching everything - threw away the two characters that settle it.
        // Exactness is what makes a short word safe: "td" equals the tenant,
        // where a substring test would match "td" inside a dozen names.
        if (words.some((w) => w === tenant)) return true;

        // Otherwise fall back to a substring match on words long enough to
        // identify somebody, ignoring the ones every firm here shares.
        return words
          .filter((w) => w.length >= 4 && !["group", "bank", "securities", "americas", "capital", "partners"].includes(w))
          .some((w) => key.includes(w));
      };

      /**
       * Whose name STARTS with the tenant.
       *
       * Needed because a rename annotation can smuggle the other firm's brand
       * into a name: "Cowen (now TD Cowen)" contains "TD", so both it and "TD
       * Securities" match the tenant `td` and the tie fell back to creation
       * order again. The tenant is the leading brand of whoever bought the
       * board, so the firm whose name opens with it is the owner.
       */
      const leadsWithTenant = (firmName: string) =>
        firmName.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/)[0] === tenant;

      const ordered = [...group].sort(
        (a, b) =>
          Number(leadsWithTenant(b.firm.name)) - Number(leadsWithTenant(a.firm.name)) ||
          Number(ownsBoard(b.firm.name)) - Number(ownsBoard(a.firm.name)) ||
          b.detectedListings.length - a.detectedListings.length ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      );
      const [keep, ...rest] = ordered;

      /**
       * Nobody's name appears in the board key, so which firm owns it is a
       * guess.
       *
       * TD Securities and Cowen share `td.wd3.myworkdayjobs.com` and the
       * tenant is "td" - two characters, which is below the length any name
       * match can use without matching half the directory. The board is
       * plainly TD's to a human and unprovable to this script, so it says so
       * and leaves the pair alone rather than writing a parent link that
       * points the wrong way.
       */
      const ambiguous = !ownsBoard(keep.firm.name);

      console.log(`\n${key}${ambiguous ? "   [owner ambiguous - needs --force]" : ""}`);
      console.log(`  keep  ${keep.firm.name} (${keep.detectedListings.length} listings)`);
      for (const dup of rest) {
        console.log(
          `  link  ${dup.firm.name} (${dup.detectedListings.length} listings) -> parent ${keep.firm.name}`,
        );
        listingsBehindDuplicates += dup.detectedListings.length;
        if (!ambiguous || FORCE) wouldLink += 1;

        if (APPLY && (!ambiguous || FORCE)) {
          const tiers = await db.select().from(schema.monitoringTiers);
          const inactive = tiers.find((t) => t.name === "inactive");
          if (!inactive) throw new Error("no inactive tier - run seed-monitoring-config.ts");

          // NOT deleted. The firm is still a real firm and its postings may
          // genuinely belong to it; what changes is that this row stops being
          // a second fetch of the same bytes. parentFirmId is what lets
          // demand and priority still roll up.
          await db
            .update(schema.firmMonitoringSources)
            .set({
              parentFirmId: keep.firmId,
              tierId: inactive.id,
              notes:
                `duplicate of ${keep.firm.name}'s board (${key}) - linked, not polled. ` +
                (dup.notes ?? ""),
              updatedAt: new Date(),
            })
            .where(eq(schema.firmMonitoringSources.id, dup.id));
        }
      }
    }

    console.log(
      `\n${duplicated.length} board(s) monitored more than once; ` +
        `${wouldLink} source(s) ${APPLY ? "linked and parked" : "would be linked and parked"}.`,
    );
    console.log(`${listingsBehindDuplicates} listing rows sit behind the duplicate sources.`);
    if (!APPLY) console.log("\nDry run - pass --apply to write.");
  } finally {
    await closeDb();
  }
}

main();
