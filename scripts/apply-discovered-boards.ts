// Apply the boards found by discover-boards.ts --all (run 2026-09-18).
//
// Recorded here in full, including what was rejected and why, for the reason
// repoint-sources.ts states in its own header: a re-point performed by a
// throwaway script is a decision with no record, and when this database had to
// be restored from a snapshot those were the only changes that could not be
// replayed. Every board this system polls should be traceable to a line in a
// file.
//
// Nothing is written on the strength of discovery alone. Each URL is
// normalised (see lib/monitoring/board-url.ts), then FETCHED through the
// connector that would poll it, and only written if something actually parsed.
// A board that returns zero listings is reported, not stored - an empty board
// and a wrong URL look identical in the database afterwards, and the whole
// point of this pass is to stop storing addresses nobody verified.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/apply-discovered-boards.ts [--apply]
import { openDb } from "../src/db/open";
import { assertExclusiveDbAccess } from "../src/lib/monitoring/exclusive-db";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { getConnector, closeGenericConnectorBrowser } from "../src/lib/monitoring/connectors";
import { normalizeBoardUrl } from "../src/lib/monitoring/board-url";

const apply = process.argv.includes("--apply");

/** Raw discovery output, verbatim. Normalisation and verification happen below
 *  rather than here, so this stays a record of what was FOUND rather than of
 *  what we decided about it. */
const DISCOVERED: { firm: string; ats: string; url: string }[] = [
  { firm: "Mizuho Americas", ats: "workday", url: "https://mizuho.wd1.myworkdayjobs.com/mizuhoamericas" },
  { firm: "Jefferies", ats: "talentlink", url: "https://jefferies.tal.net/vx/lang-en-GB/mobile-0/appcentre-ext/brand-4/xf-016c915b0a67/candidate/jobboard/vacancy/1/adv/" },
  { firm: "Nomura (US)", ats: "talentlink", url: "https://nomuracampus.tal.net/vx/lang-en-GB/mobile-0/appcentre-ext/brand-4/xf-3348347fc789/candidate/jobboard/vacancy/1/adv/" },
  { firm: "Moelis & Company", ats: "workday", url: "https://moelis.wd1.myworkdayjobs.com/Experienced-Hires" },
  { firm: "PJT Partners", ats: "workday", url: "https://pjtpartners.wd1.myworkdayjobs.com/Students" },
  { firm: "Houlihan Lokey", ats: "workday", url: "https://hl.wd1.myworkdayjobs.com/Campus" },
  { firm: "Piper Sandler", ats: "workday", url: "https://pipersandler.wd501.myworkdayjobs.com/Piper_Sandler_Careers" },
  { firm: "Raymond James", ats: "workday", url: "https://raymondjames.wd1.myworkdayjobs.com/RaymondJamesCareers" },
  // Parent-company boards. Harris Williams is PNC-owned, Cain Brothers is
  // KeyBanc's, Intrepid is MUFG's, Greenhill was absorbed by Mizuho, DBO by
  // Piper Sandler, Waller Helms by Houlihan Lokey, Miller Buckfire by Stifel.
  // The board is genuinely the right one; it just belongs to the parent, which
  // is the case firm_monitoring_sources.parentFirmId exists for.
  { firm: "Harris Williams", ats: "workday", url: "https://pnc.wd5.myworkdayjobs.com/HarrisWilliams" },
  { firm: "Greenhill & Co", ats: "workday", url: "https://mizuho.wd1.myworkdayjobs.com/mizuhoamericas" },
  { firm: "Ducera Partners", ats: "greenhouse", url: "https://boards.greenhouse.io/ducerapartnerscampus" },
  { firm: "Solomon Partners (fka Peter J. Solomon Company)", ats: "greenhouse", url: "https://job-boards.greenhouse.io/embed/job_board?for=solomonpartnersstudentsgraduates" },
  { firm: "Cowen (now TD Cowen)", ats: "workday", url: "https://td.wd3.myworkdayjobs.com/en-US/TD_Bank_Careers" },
  { firm: "Ankura", ats: "workday", url: "https://ankura.wd5.myworkdayjobs.com/Ankura?q=University" },
  { firm: "Baker Tilly Capital", ats: "workday", url: "https://bakertilly.wd5.myworkdayjobs.com/BTCareers" },
  { firm: "Bank of America", ats: "talentlink", url: "https://bankcampuscareers.tal.net/vx/lang-en-GB/mobile-0/brand-4/xf-6f0048376f93/candidate/jobboard/vacancy/2/adv/" },
  { firm: "Berkeley Research Group", ats: "workday", url: "https://thinkbrg.wd5.myworkdayjobs.com/BRG_External_Career_Site" },
  { firm: "BNP Paribas USA", ats: "talentlink", url: "https://bnppus.tal.net/vx/lang-en-GB/mobile-0/appcentre-ext/brand-4/xf-5db317b8ad85/candidate/jobboard/vacancy/1/adv/" },
  { firm: "BofA Securities", ats: "talentlink", url: "https://bankcampuscareers.tal.net/vx/lang-en-GB/mobile-0/brand-4/xf-6f0048376f93/candidate/jobboard/vacancy/2/adv/" },
  { firm: "Cain Brothers", ats: "workday", url: "https://keybank.wd5.myworkdayjobs.com/External_Career_Site" },
  { firm: "Capstone Partners", ats: "workday", url: "https://huntington.wd12.myworkdayjobs.com/HNBcareers/job/Birmingham-MI/Vice-President---Capstone-Partners--Financial-Advisory-Services_R0070587-1" },
  { firm: "CIBC Capital Markets", ats: "workday", url: "https://cibc.wd3.myworkdayjobs.com/search?q=banking+centre" },
  { firm: "DBO Partners", ats: "workday", url: "https://pipersandler.wd501.myworkdayjobs.com/Piper_Sandler_Careers" },
  { firm: "Financial Technology Partners", ats: "greenhouse", url: "https://job-boards.greenhouse.io/financialtechnologypartners/jobs/8697055002" },
  { firm: "Intrepid Investment Bankers", ats: "workday", url: "https://mufgub.wd3.myworkdayjobs.com/en-US/MUFG-Careers?q=intrepid" },
  { firm: "Leerink Partners", ats: "workday", url: "https://leerink.wd5.myworkdayjobs.com/en-US/leerinkpartners" },
  { firm: "MUFG Securities Americas", ats: "workday", url: "https://mufgub.wd3.myworkdayjobs.com/MUFG-Careers" },
  { firm: "Stout", ats: "workday", url: "https://stout.wd5.myworkdayjobs.com/Stout-Student-Careers" },
  { firm: "TD Securities", ats: "workday", url: "https://td.wd3.myworkdayjobs.com/en-US/TD_Bank_Careers" },
  { firm: "Waller Helms Advisors", ats: "workday", url: "https://hl.wd1.myworkdayjobs.com/Campus" },

  // Found with an ATS whose connector already exists - discover-boards.ts was
  // labelling these "no connector" from a stale table, fixed in the same pass.
  { firm: "JPMorgan", ats: "oracle-hcm", url: "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/requisitions&#34;" },
  { firm: "Lazard", ats: "oracle-hcm", url: "https://icbpjb.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/LazardStudentCareers/jobs" },
  { firm: "BDO Capital Advisors", ats: "oracle-hcm", url: "https://ebqb.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/jobs" },
  { firm: "BGC Group", ats: "oracle-hcm", url: "https://hdow.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1003" },
  { firm: "Cantor Fitzgerald", ats: "oracle-hcm", url: "https://hdow.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1003" },
  { firm: "Citigroup", ats: "eightfold", url: "https://citi.eightfold.ai/careers/join?jtn_form_id=jtn-early-career" },
  { firm: "Stifel", ats: "icims", url: "https://careers-stifel.icims.com/jobs/search?mode=job&iis=Company+Website" },
  { firm: "Miller Buckfire", ats: "icims", url: "https://careers-stifel.icims.com/jobs/search?mode=job&#038;iis=Company+Website" },
  { firm: "Union Square Advisors", ats: "lever", url: "https://jobs.lever.co/usadvisors" },
  { firm: "D.A. Davidson & Co", ats: "lever", url: "https://jobs.lever.co/dadavidson" },
  { firm: "Seaport Global", ats: "lever", url: "https://jobs.lever.co/seaportglobal/" },

  // Expected to be refused by the normaliser, kept so the refusal is on the
  // record rather than an unexplained absence.
  { firm: "Goldman Sachs", ats: "avature", url: "https://recruiting360.avature.net/candidates" },
  { firm: "Barclays (US)", ats: "avature", url: "https://barclays.avature.net/GraduatesAndInterns" },
  { firm: "William Blair", ats: "avature", url: "https://williamblair.avature.net/careers" },
  { firm: "Macquarie Group", ats: "avature", url: "https://mgl.avature.net/earlycareersEMEAAMERS" },
  { firm: "RBC Capital Markets (US)", ats: "phenom", url: "https://pp-cdn.phenompeople.com/CareerConnectResources/pp/agWidgets/ph-search-results-v2-default-30.js" },
  { firm: "Truist Securities (truistsecurities.com)", ats: "phenom", url: "https://cdn.phenompeople.com/CareerConnectResources" },
  { firm: "Société Générale (US)", ats: "taleo", url: "https://socgen.taleo.net/careersection/sgcareers/profile.ftl?lang=en&src=CWS-1" },
];

/** The connector that should read a given host, or null when we have none. */
function connectorForHost(host: string): string | null {
  if (host === "higher.gs.com") return "goldman";
  if (host.endsWith("myworkdayjobs.com")) return "workday";
  if (host.endsWith("tal.net")) return "talentlink";
  if (host.endsWith("greenhouse.io")) return "greenhouse";
  if (host.endsWith("lever.co")) return "lever";
  if (host.includes("icims.com")) return "icims";
  if (host.includes("oraclecloud.com")) return "oracle-hcm";
  if (host.endsWith("eightfold.ai")) return "eightfold";
  return null;
}

type Outcome = { firm: string; status: string; detail: string };

async function main() {
  await assertExclusiveDbAccess({ viaOpenDb: true });
  // Follows DATABASE_URL, like the scripts ported before it. Opening PGlite
  // here wrote board discoveries into a local file nothing reads - and this
  // is the only route by which a source pointed at a homepage or a contact
  // form ever gets re-pointed at a real board.
  const opened = await openDb();
  const db = opened.db;
  console.log(`database: ${opened.backend}`);

  const applied: Outcome[] = [];
  const empty: Outcome[] = [];
  const refused: Outcome[] = [];
  const noSource: Outcome[] = [];

  try {
    const firms = await db.select().from(schema.firms);
    const sources = await db.select().from(schema.firmMonitoringSources);
    const firmIdByName = new Map(firms.map((f) => [f.name, f.id]));

    for (const d of DISCOVERED) {
      const norm = normalizeBoardUrl(d.url);
      if (!norm.ok) {
        refused.push({ firm: d.firm, status: d.ats, detail: norm.reason });
        continue;
      }

      const firmId = firmIdByName.get(d.firm);
      const source = sources.find((s) => s.firmId === firmId);
      if (!source) {
        noSource.push({ firm: d.firm, status: d.ats, detail: "no monitoring source row" });
        continue;
      }

      const host = new URL(norm.url).hostname;
      const preferred = connectorForHost(host);

      // Try the host's own connector, then generic. Same reasoning as
      // repoint-sources.ts: not every board on a given ATS host exposes the
      // same machinery, and choosing by hostname alone silently returns zero
      // for the ones that don't.
      let best = { connector: preferred ?? "generic", count: -1 };
      for (const candidate of [preferred, "generic"].filter(Boolean) as string[]) {
        try {
          const r = await getConnector(candidate).fetch({
            careersUrl: norm.url,
            sourceType: source.sourceType,
            lastEtag: null,
          });
          if (r.listings.length > best.count) best = { connector: candidate, count: r.listings.length };
          if (best.count > 0) break;
        } catch {
          /* try the next candidate */
        }
      }

      if (best.count <= 0) {
        empty.push({
          firm: d.firm,
          status: best.connector,
          detail: `${best.count < 0 ? "every connector threw" : "parsed 0 listings"} - ${norm.url}`,
        });
        continue;
      }

      applied.push({
        firm: d.firm,
        status: best.connector,
        detail: `${best.count} listings - ${norm.url}${norm.note ? ` (${norm.note})` : ""}`,
      });

      if (apply) {
        await db
          .update(schema.firmMonitoringSources)
          .set({
            careersUrl: norm.url,
            connectorId: best.connector,
            sourceType: best.connector === "greenhouse" ? "greenhouse" : "generic_html",
            // The stored hash and etag describe the page this replaces.
            lastContentHash: null,
            lastEtag: null,
            failureCount: 0,
            sourceHealth: "healthy",
            nextCheckAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.firmMonitoringSources.id, source.id));
      }
    }

    const show = (label: string, rows: Outcome[]) => {
      console.log(`\n===== ${label} (${rows.length}) =====`);
      for (const r of rows) console.log(`  ${r.firm.padEnd(38)} ${r.status.padEnd(11)} ${r.detail}`);
    };
    show(apply ? "WRITTEN" : "WOULD WRITE", applied);
    show("PARSED NOTHING - not written", empty);
    show("REFUSED BY THE NORMALISER", refused);
    if (noSource.length) show("NO SOURCE ROW", noSource);

    console.log(
      `\n${applied.length} board(s) ${apply ? "applied" : "would be applied"}; ` +
        `${empty.length} verified-empty; ${refused.length} refused.`,
    );
    if (!apply) console.log("Dry run - pass --apply to write.");
  } finally {
    await closeGenericConnectorBrowser();
    await opened.close();
  }
}

main();
