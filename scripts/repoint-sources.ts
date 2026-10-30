// Re-point monitoring sources at the real job boards found by
// discover-boards.ts.
//
// Every proposal is fetched through the connector that would poll it BEFORE
// anything is written. A URL that parses to zero listings is not written - the
// whole point of this pass is to stop storing addresses nobody verified, and
// swapping one unverified URL for another would just move the problem.
//
// An empty board is not the same as a broken one, so a proposal that fetches
// cleanly and legitimately has no open roles yet is still accepted; the
// difference is that we now know which it is.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/repoint-sources.ts [--apply]
import { openScriptDb } from "./_db";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { getConnector, closeGenericConnectorBrowser } from "../src/lib/monitoring/connectors";

const apply = process.argv.includes("--apply");

/**
 * `--only "Kroll"` - restrict the pass to firms whose name contains this.
 *
 * Applying writes `careersUrl` and resets the stored hash, etag and failure
 * count, so a full `--apply` re-asserts this file over every firm in it. That
 * is right after a database restore and wrong when one connector has just
 * been added: four unrelated sources would have their content hash cleared
 * and re-diff a board nobody changed, and any careersUrl tuned by hand since
 * would be silently overwritten by the proposal.
 */
const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1]?.toLowerCase() : null;

/**
 * firm name -> the board discover-boards.ts found, normalised.
 *
 * Normalisation matters for Greenhouse: the link on a careers page is often an
 * `/embed/job_board?for=<token>` widget URL or a single `/jobs/<id>` posting,
 * and the connector reads the token from the first path segment - so "embed"
 * would be stored as the board name. Both are rewritten to the board root.
 */
const PROPOSALS: { firm: string; url: string }[] = [
  // Recorded here late, and that omission cost a day's data once already:
  // these boards were re-pointed by a throwaway script that kept no record of
  // its decisions, so when the database had to be restored from a snapshot
  // they were the one part of the work that could not be replayed. Every
  // re-point belongs in this file, whatever script performed it.
  { firm: "Evercore", url: "https://evercore.tal.net/candidate/jobboard/vacancy/2/adv/" },
  { firm: "Jefferies", url: "https://jefferies.tal.net/candidate/jobboard/vacancy/2/adv/" },
  { firm: "Moelis & Company", url: "https://moelis-careers.tal.net/candidate/jobboard/vacancy/2/adv/" },
  { firm: "Perella Weinberg Partners", url: "https://pwpcareers.tal.net/candidate/jobboard/vacancy/2/adv/" },
  { firm: "PJT Partners", url: "https://pjtpartners.wd1.myworkdayjobs.com/Students" },
  { firm: "Mizuho Americas", url: "https://mizuho.wd1.myworkdayjobs.com/mizuhoamericas" },
  { firm: "Piper Sandler", url: "https://pipersandler.wd501.myworkdayjobs.com/Piper_Sandler_Careers" },
  { firm: "Baker Tilly Capital", url: "https://bakertilly.wd5.myworkdayjobs.com/BTCareers" },
  { firm: "TD Securities", url: "https://td.wd3.myworkdayjobs.com/en-US/TD_Bank_Careers" },
  { firm: "Harris Williams", url: "https://pnc.wd5.myworkdayjobs.com/HarrisWilliams" },
  { firm: "Stout", url: "https://stout.wd5.myworkdayjobs.com/Stout-Student-Careers" },
  { firm: "Leerink Partners", url: "https://leerink.wd5.myworkdayjobs.com/en-US/leerinkpartners" },
  { firm: "Berkeley Research Group", url: "https://thinkbrg.wd5.myworkdayjobs.com/BRG_External_Career_Site" },
  { firm: "MUFG Securities Americas", url: "https://mufgub.wd3.myworkdayjobs.com/MUFG-Careers" },

  /**
   * Baird, 19 Sep. Not a new board - a re-read of an old refusal.
   *
   * The generic connector got a 403 here and it was recorded as "a real
   * investment bank actively refusing the crawler". It is not:
   * `bairdcareers.com/robots.txt` says `User-agent: * / Allow: /`, disallows
   * only `/cdn-cgi/`, and advertises `sitemap.xml`. The 403 is Cloudflare bot
   * management on the rendered board. The sitemap - 119 job URLs, rebuilt
   * hourly, each carrying its requisition id - is the path the site actually
   * offers, and bairdConnector reads it. Same resolution as Kroll.
   */
  { firm: "Robert W. Baird", url: "https://www.bairdcareers.com/jobs/" },

  { firm: "Nomura (US)", url: "https://nomuracampus.tal.net/vx/lang-en-GB/mobile-0/appcentre-ext/brand-4/xf-3348347fc789/candidate/jobboard/vacancy/1/adv/" },
  { firm: "BNP Paribas USA", url: "https://bnppus.tal.net/vx/lang-en-GB/mobile-0/appcentre-ext/brand-4/xf-5db317b8ad85/candidate/jobboard/vacancy/1/adv/" },
  { firm: "Ducera Partners", url: "https://boards.greenhouse.io/ducerapartnerscampus" },
  { firm: "Financial Technology Partners", url: "https://job-boards.greenhouse.io/financialtechnologypartners" },
  { firm: "Solomon Partners (fka Peter J. Solomon Company)", url: "https://job-boards.greenhouse.io/solomonpartnersstudentsgraduates" },
  { firm: "Houlihan Lokey", url: "https://hl.wd1.myworkdayjobs.com/Campus" },
  { firm: "Ankura", url: "https://ankura.wd5.myworkdayjobs.com/Ankura" },
  // Not found by link-scanning any Morgan Stanley page - their careers site
  // never links the campus board directly. Found by probing the TalentLink
  // host pattern the four working tal.net firms already use.
  { firm: "Morgan Stanley", url: "https://morganstanley.tal.net/candidate/jobboard/vacancy/1/adv/" },
  { firm: "BMO Capital Markets (US)", url: "https://bmo.wd3.myworkdayjobs.com/External" },

  // Second pass, after building the Oracle HCM, Lever and iCIMS connectors.
  { firm: "JPMorgan", url: "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/requisitions" },
  { firm: "Lazard", url: "https://icbpjb.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/LazardStudentCareers/jobs" },
  { firm: "BDO Capital Advisors", url: "https://ebqb.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/jobs" },
  // Cantor Fitzgerald and BGC share one Oracle tenant. Both were previously
  // in the 403-blocking group: the block is on their marketing site, not on
  // the ATS, so the connector reaches what the crawler could not.
  { firm: "Cantor Fitzgerald", url: "https://hdow.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1003" },
  { firm: "BGC Group", url: "https://hdow.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1003" },
  { firm: "D.A. Davidson & Co", url: "https://jobs.lever.co/dadavidson" },
  { firm: "Seaport Global", url: "https://jobs.lever.co/seaportglobal" },
  { firm: "Stifel", url: "https://careers-stifel.icims.com/jobs/search?mode=job" },
  // Miller Buckfire is Stifel's restructuring arm and recruits on Stifel's
  // board - the same board URL under a second firm row, which is what the
  // parentFirmId column exists for.
  { firm: "Miller Buckfire", url: "https://careers-stifel.icims.com/jobs/search?mode=job" },
  // Both previously 403-blocked on their own careers pages.
  { firm: "Raymond James", url: "https://raymondjames.wd1.myworkdayjobs.com/RaymondJamesCareers" },

  // Third pass: the two firms that needed a connector written for them alone.
  { firm: "Goldman Sachs", url: "https://higher.gs.com/roles" },
  { firm: "Citigroup", url: "https://citi.eightfold.ai/careers?domain=citi.com" },
  // Previously rejected as bot-blocked. The block is on the board PAGE only;
  // the Atom feed at the conventional path is served without a challenge, and
  // the TalentLink connector now probes for it when the page yields nothing.
  { firm: "BofA Securities", url: "https://bankcampuscareers.tal.net/candidate/jobboard/vacancy/1/feed" },

  // Fourth pass. These three were in the "no board exists" group, wrongly:
  // the first discovery pass matched a fixed list of ATS hostnames, followed
  // one hop, and never read a sitemap. A deeper pass found all three on
  // platforms we already parse.
  { firm: "Guggenheim Securities", url: "https://guggenheim.wd1.myworkdayjobs.com/Guggenheim_Careers_Campus" },
  { firm: "William Blair", url: "https://boards.greenhouse.io/williamblair" },
  { firm: "Brown Gibbons Lang & Company", url: "https://boards.greenhouse.io/browngibbonslangcompany" },

  // Fifth pass. Kroll was in the "nothing found" group and should not have
  // been: it publishes all 381 open requisitions in its careers SITEMAP, 28
  // of them internships, and the sitemap index points at careers.kroll.com -
  // a different HOSTNAME, which is exactly the case the old sitemap ranking
  // missed by reading path segments only. Verified through the connector
  // before this line was written: 381 listings parsed, enrichment returns
  // stated title, division, city, country, posted date and a requisition
  // type of "Internship". See connectors/kroll.ts for why it is firm-specific
  // rather than a general sitemap connector.
  { firm: "Kroll", url: "https://careers.kroll.com/en" },

  // Société Générale, which needed no connector at all - see REJECTED below
  // for why the Taleo one this file's next-steps list called for was never
  // built. The old URL was a programme MARKETING page, and it showed: its two
  // "listings" were the page's own heading ("Summer Analyst Program", 154
  // characters) and a strip of navigation text ("CareersSummer Analyst
  // ProgramGet to know usDiscover Open Positions"). Zero real postings.
  //
  // The internships index on their own careers site carries 17, each a real
  // vacancy URL with its location in the link text, on one page with no
  // pagination. Verified through the generic connector, which renders the
  // page - the listings are client-side and a plain GET returns none of them.
  {
    firm: "Société Générale (US)",
    url: "https://careers.societegenerale.com/en/internships-trainee-programs",
  },
];

/**
 * Proposals deliberately NOT applied, and why. Kept in the file rather than in
 * a commit message because each one is a decision a human should be able to
 * revisit, and two of them are bad *seed* data that no connector can fix.
 */
const REJECTED: { firm: string; url: string; reason: string }[] = [
  {
    firm: "Waller Helms Advisors",
    url: "https://hl.wd1.myworkdayjobs.com/Campus",
    reason: "that is Houlihan Lokey's board - Waller Helms' seeded careers URL is hl.com, the wrong firm",
  },
  {
    firm: "DBO Partners",
    url: "https://pipersandler.wd501.myworkdayjobs.com/Piper_Sandler_Careers",
    reason: "that is Piper Sandler's board - DBO's seeded careers URL is pipersandler.com, the wrong firm",
  },
  {
    firm: "CIBC Capital Markets",
    url: "https://cibc.wd3.myworkdayjobs.com/search?q=banking+centre",
    reason: "a search URL with no site id, and 'banking centre' means retail branches, not the capital markets programme",
  },
  {
    firm: "Goldman Sachs (avature URL)",
    url: "https://recruiting360.avature.net/candidates",
    reason:
      "a candidate login portal, not a board - the same trap as the Workday /login URLs. Superseded: Goldman now has its own connector reading higher.gs.com",
  },
  {
    firm: "RBC Capital Markets (US)",
    url: "https://jobs.rbc.com/",
    reason: "parses to 2 rows and both are navigation links, not roles - no better than the page it would replace",
  },
  // Three firms whose careers page links their PARENT's board. Unlike the
  // Waller Helms and DBO cases these are not bad seed data - the acquisition
  // is real and the parent really does recruit for them. They are still held
  // back, because pointing two firm rows at one board files the parent's
  // entire requisition list under the subsidiary's name too, and a student
  // would see Mizuho's openings labelled Greenhill. The schema already has the
  // right tool for this (firmMonitoringSources.parentFirmId); wiring it up is
  // its own change, and picking the parent for someone is not a guess a script
  // should make silently.
  {
    firm: "Cowen (now TD Cowen)",
    url: "https://td.wd3.myworkdayjobs.com/en-US/TD_Bank_Careers",
    reason:
      "TD's board, already monitored under TD Securities - same duplicate-under-two-names problem as Greenhill below, and it needs parentFirmId rather than a second pointer at one board",
  },
  {
    firm: "Intrepid Investment Bankers",
    url: "https://mufgub.wd3.myworkdayjobs.com/en-US/MUFG-Careers?q=intrepid",
    reason:
      "MUFG's board narrowed by a ?q= filter the Workday connector ignores (it reads tenant and site from the path only), so this would store MUFG's entire requisition list under Intrepid",
  },
  {
    firm: "Greenhill & Co",
    url: "https://mizuho.wd1.myworkdayjobs.com/mizuhoamericas",
    reason: "Mizuho's board, already monitored under Mizuho Americas - would duplicate every listing under a second firm name",
  },
  {
    firm: "Cain Brothers",
    url: "https://keybank.wd5.myworkdayjobs.com/External_Career_Site",
    reason: "KeyBank's full external board - needs parentFirmId plus a filter, not a straight re-point",
  },
  {
    firm: "Capstone Partners",
    url: "https://huntington.wd12.myworkdayjobs.com/HNBcareers",
    reason: "Huntington's board; the discovered URL was a single job posting, and the board root covers the whole bank",
  },
  {
    firm: "Stephens Inc",
    url: "https://recruiting2.ultipro.com/STE1004/JobBoard/fbeef081-b55b-0ae3-a2ac-7b4fb3db6826",
    reason:
      "robots.txt on recruiting2.ultipro.com disallows */JobBoardView, which is the only way to enumerate the board. " +
      "It allows */JobBoard/ (the board page and OpportunityDetail) but the board page is a React shell: measured on " +
      "18 Sep its HTML contains no job titles and none of the opportunity ids, and there is no sitemap on the host. " +
      "So the 24 postings - 2 of them real internships - are reachable ONLY through the disallowed endpoint, whether " +
      "requested directly or by pointing a headless browser at the page that requests it. Not built, deliberately. " +
      "If ids ever arrive from a permitted source, OpportunityDetail IS allowed and embeds the whole requisition as " +
      "JSON, so the connector would be short.",
  },
  /**
   * The three real estate firms board discovery found on UltiPro, 19 Sep.
   *
   * Re-checked rather than assumed, because the note handing this over said
   * to: `recruiting.ultipro.com/robots.txt` and
   * `recruiting2.ultipro.com/robots.txt` both still serve the same rules as
   * on 18 Sep, and neither host publishes a sitemap. So the Stephens decision
   * above applies unchanged to all three, and they stay on the generic
   * connector - which reaches the allowed React shell, finds no titles in it,
   * and reports honestly that the board yields nothing.
   */
  {
    firm: "Mesirow Re-ia, INC.",
    url: "https://recruiting2.ultipro.com/MES1003MFAC/JobBoard/69451223-cdce-4faf-9407-23a2cd5ac83b/",
    reason: "UltiPro - same robots.txt rules as Stephens above, re-verified unchanged 19 Sep",
  },
  {
    firm: "Rose Smart Growth Investment Advisors, LLC",
    url: "https://recruiting.ultipro.com/JON1002JROSE/JobBoard/831f2c6f-2842-6082-be63-f7945fe68801/",
    reason: "UltiPro, the other host - identical robots.txt, re-verified unchanged 19 Sep",
  },
  {
    firm: "Peachtree Group",
    url: "https://recruiting.ultipro.com/PEA1007PEHO/JobBoard/3fa301cc-3f29-4a93-be0d-269c11b36327/",
    reason: "UltiPro - same rules again, re-verified unchanged 19 Sep",
  },
  /**
   * Realterm is NOT rejected - it is registered on the shared Dayforce host
   * instead. Recorded here because the URL discovery found is the one that
   * must not be used, and without the note the next person re-adds it.
   */
  {
    firm: "Realterm (us231 host)",
    url: "https://us231.dayforcehcm.com/CandidatePortal/EN-US/Realterm/Site/Candidateportal",
    reason:
      "us231.dayforcehcm.com redirects its robots.txt to www.dayforcehcm.com, which is 'User-Agent: * / Disallow: /'. " +
      "The same tenant answers on jobs.dayforcehcm.com, whose robots.txt carries no directives at all, with the same " +
      "four postings - measured 19 Sep. Registered there; see the staged source for Realterm.",
  },
];

async function main() {
  const { db, close: closeDb } = await openScriptDb();

  try {
    const firms = await db.select().from(schema.firms);
    const sources = await db.select().from(schema.firmMonitoringSources);
    const byName = new Map(firms.map((f) => [f.name, f.id]));

    let written = 0;
    for (const p of PROPOSALS) {
      if (only && !p.firm.toLowerCase().includes(only)) continue;
      const firmId = byName.get(p.firm);
      const source = sources.find((s) => s.firmId === firmId);
      if (!source) {
        console.log(`SKIP  ${p.firm}: no monitoring source row`);
        continue;
      }

      const host = new URL(p.url).hostname;
      const preferred = host === "careers.kroll.com"
        ? "kroll"
        : host === "higher.gs.com"
        ? "goldman"
        : host.endsWith("eightfold.ai")
        ? "eightfold"
        : host.endsWith("myworkdayjobs.com")
        ? "workday"
        : host.endsWith("tal.net")
          ? "talentlink"
          : host.endsWith("oraclecloud.com")
            ? "oracle-hcm"
            : host.endsWith("lever.co")
              ? "lever"
              : host.endsWith("icims.com")
                ? "icims"
                : "greenhouse";

      /**
       * Already pointed here by an earlier run.
       *
       * Skipped without re-fetching, so this file can stay a cumulative record
       * of every decision without a re-run costing a request per firm - but
       * ONLY when the stored connector is the one we would choose today.
       *
       * The exception matters. Kroll's careers URL was correct from the first
       * seed and yielded nothing for months, because the connector reading it
       * was the generic one; what was missing was never the address. With an
       * unconditional skip, writing a connector for a URL already on file
       * could never take effect, and the fix would look applied while
       * changing nothing. Re-verifying only when the two disagree costs a
       * request for the handful of sources that actually need one.
       */
      if (source.careersUrl === p.url && source.connectorId === preferred) {
        console.log(`SAME  ${p.firm.padEnd(34)} already pointed here, on ${preferred}`);
        continue;
      }
      if (source.careersUrl === p.url) {
        console.log(
          `MOVE  ${p.firm.padEnd(34)} same URL, connector ${source.connectorId} -> ${preferred}`,
        );
      }

      /**
       * Try the host's own connector, and fall back to generic when it finds
       * nothing.
       *
       * Not every board on a given ATS host exposes the same machinery:
       * Evercore and Jefferies publish a TalentLink Atom feed, while Nomura
       * and BNP Paribas run TalentLink boards with no feed at all but with
       * every listing present in the served HTML. Choosing the connector by
       * hostname alone silently returns zero for the second kind, which looks
       * exactly like an empty board. Choosing it by what actually parses tells
       * the two apart.
       */
      let connectorId = preferred;
      let count = -1;
      for (const candidate of [preferred, "generic"]) {
        try {
          const result = await getConnector(candidate).fetch({
            careersUrl: p.url,
            sourceType: source.sourceType,
            lastEtag: null,
          });
          if (result.listings.length > count) {
            count = result.listings.length;
            connectorId = candidate;
          }
          if (count > 0) break;
        } catch (err) {
          if (candidate === "generic" && count < 0) {
            console.log(`FAIL  ${p.firm}: ${(err as Error).message}`);
          }
        }
      }

      // A negative count means every connector threw; zero is a real, empty board.
      if (count < 0) continue;

      console.log(
        `${apply ? "WRITE" : "OK   "} ${p.firm.padEnd(34)} ${connectorId.padEnd(11)} ${count} listings`,
      );

      if (apply) {
        await db
          .update(schema.firmMonitoringSources)
          .set({
            careersUrl: p.url,
            connectorId,
            // The stored hash and etag describe the OLD page. Leaving them set
            // would make the next check compare this board against the careers
            // page it replaced and quite possibly report "not modified".
            lastContentHash: null,
            lastEtag: null,
            failureCount: 0,
            sourceHealth: "healthy",
            nextCheckAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.firmMonitoringSources.id, source.id));
        written++;
      }
    }

    console.log(`\n${apply ? `${written} sources re-pointed` : "dry run - pass --apply to write"}`);
    console.log(`\n${REJECTED.length} proposals rejected on purpose:`);
    for (const r of REJECTED) console.log(`  ${r.firm}\n     ${r.url}\n     ${r.reason}`);
  } finally {
    await closeGenericConnectorBrowser();
    await closeDb();
  }
}

main();
