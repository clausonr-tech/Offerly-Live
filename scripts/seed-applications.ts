// One-off script: populate the Applications tracker with real, current
// application opportunities researched from each firm's own careers site.
// Run with: npx tsx scripts/seed-applications.ts
import type { Db } from "../src/db/types";
import { openScriptDb } from "./_db";
import { eq, and } from "drizzle-orm";
import * as schema from "../src/db/schema";

let db!: Db;

type Opportunity = {
  firm: string;
  role: string;
  category: (typeof schema.applicationCategoryEnum.enumValues)[number];
  applicationUrl: string;
  notes: string;
};

const OPPORTUNITIES: Opportunity[] = [
  // ---- Bulge brackets ----
  {
    firm: "Goldman Sachs",
    role: "2027 Summer Analyst Program (Investment Banking)",
    category: "investment_banking",
    applicationUrl: "https://www.goldmansachs.com/careers/students/programs-and-internships/americas/2027-summer-analyst-program",
    notes: "Opens Aug 15, 2026 (tomorrow) - page live now, rolling review after.",
  },
  {
    firm: "Morgan Stanley",
    role: "2027 Investment Banking Summer Analyst Program (United States)",
    category: "investment_banking",
    applicationUrl: "https://morganstanley.tal.net/vx/lang-en-GB/mobile-0/brand-2/candidate/so/pm/1/pl/1/opp/20793-2027-Investment-Banking-Summer-Analyst-Program-United-States/en-GB",
    notes: "Cycle closed (window was Jan 1–Feb 15, 2026) - watch for the 2028 posting.",
  },
  {
    firm: "JPMorgan Chase",
    role: "2027 Global Investment Banking Summer Analyst Program",
    category: "investment_banking",
    applicationUrl: "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210691542",
    notes: "Appears open now with rolling review - apply early.",
  },
  {
    firm: "Bank of America",
    role: "Global Investment Banking Summer Analyst Program – 2027 (Multiple Locations)",
    category: "investment_banking",
    applicationUrl: "https://careers.bankofamerica.com/en-us/students/job-detail/13953/global-investment-banking-summer-analyst-program-2027-multiple-locations",
    notes: "Open, but some regional deadlines (e.g. Canada) have already passed.",
  },
  {
    firm: "Citi",
    role: "Banking – Investment Banking, Summer Analyst, New York City – US, 2027",
    category: "investment_banking",
    applicationUrl: "https://jobs.citi.com/job/new-york/banking-investment-banking-summer-analyst-new-york-city-us-2027/287/89623967312",
    notes: "Live posting indexed on Citi's job board - verify current status on site.",
  },
  {
    firm: "Barclays",
    role: "Banking Analyst (Capital Markets) Summer Internship Program 2027, New York City",
    category: "investment_banking",
    applicationUrl: "https://search.jobs.barclays/job/new-york/banking-analyst-capital-markets-summer-internship-program-2027-new-york-city/13015/89084599488",
    notes: "Live NY listing; other offices (e.g. Toronto) already past deadline.",
  },
  {
    firm: "UBS",
    role: "2027 Summer Internship Program (Global Banking)",
    category: "investment_banking",
    applicationUrl: "https://www.ubs.com/global/en/careers/early-careers/summer-internship-program.html",
    notes: "NY-specific 2027 posting looked expired; evergreen program page still live.",
  },
  {
    firm: "Deutsche Bank",
    role: "Deutsche Bank Internship Program – Investment Bank Coverage, New York 2027",
    category: "investment_banking",
    applicationUrl: "https://careers.db.com/students-graduates/",
    notes: "Open now; specific track deadlines Aug 17–29, 2026 per university postings.",
  },

  // ---- Elite boutiques ----
  {
    firm: "Evercore",
    role: "Investment Banking Summer Analyst Program (Class of 2027)",
    category: "investment_banking",
    applicationUrl: "https://www.evercore.com/careers/students/",
    notes: "Generalist M&A/RX classes reportedly full - check portal for remaining spots.",
  },
  {
    firm: "Lazard",
    role: "2027 Financial Advisory Summer Analyst Program – NY M&A/Restructuring Generalist",
    category: "investment_banking",
    applicationUrl: "https://lazard-careers.tal.net/vx/lang-en-GB/mobile-0/appcentre-1/brand-4/candidate/so/pm/1/pl/2/opp/4124-2027-Financial-Advisory-Summer-Analyst-Program-New-York-M-A-and-Restructuring-Generalist/en-GB",
    notes: "Live posting on Lazard's official candidate portal, appears open.",
  },
  {
    firm: "Centerview Partners",
    role: "Summer Analyst Program (Class of 2027)",
    category: "investment_banking",
    applicationUrl: "https://www.centerviewpartners.com/careers.aspx",
    notes: "Formal Jan–Mar application window for 2027 already closed.",
  },
  {
    firm: "Moelis & Company",
    role: "2027 Summer Analyst, Investment Banking – New York City",
    category: "investment_banking",
    applicationUrl: "https://moelis-careers.tal.net/vx/lang-en-GB/mobile-0/appcentre-1/brand-4/xf-d43c9a446dde/candidate/so/pm/1/pl/2/opp/355-2027-Summer-Analyst-Investment-Banking-New-York-City/en-GB",
    notes: "Live posting on Moelis's official careers portal, appears open.",
  },
  {
    firm: "PJT Partners",
    role: "2027 Summer Analyst – Strategic Advisory (New York)",
    category: "investment_banking",
    applicationUrl: "https://pjtpartners.wd1.myworkdayjobs.com/en-US/Students/job/XMLNAME-2027-Summer-Analyst---Strategic-Advisory--New-York-_R0003174",
    notes: "Live Workday posting; rolling recruiting runs September–November 2026.",
  },
  {
    firm: "Houlihan Lokey",
    role: "2027 Investment Banking Summer Financial Analyst (Class of 2028) – New York Financial Services",
    category: "investment_banking",
    applicationUrl: "https://hl.wd1.myworkdayjobs.com/en-US/Campus/job/XMLNAME-2027-Investment-Banking-Summer-Financial-Analyst--Class-of-2028----New-York-Financial-Services_R2846",
    notes: "Live Workday posting, currently open for applications.",
  },

  // ---- Mid-market ----
  {
    firm: "William Blair",
    role: "2027 Investment Banking Summer Analyst",
    category: "investment_banking",
    applicationUrl: "https://www.williamblair.com/Careers/job-description?gh_jid=4977446007",
    notes: "Live posting on William Blair's own careers site, currently open.",
  },
  {
    firm: "Robert W. Baird",
    role: "Investment Banking Analyst, Charlotte NC (Summer 2027)",
    category: "investment_banking",
    applicationUrl: "https://www.bairdcareers.com/jobs/r20251399/internship-investment-banking-analyst-charlotte-nc-summer-2027/",
    notes: "Live posting found; main analyst cycle typically opens late December.",
  },
  {
    firm: "Piper Sandler",
    role: "2027 Investment Banking Summer Analyst Program",
    category: "investment_banking",
    applicationUrl: "https://www.pipersandler.com/careers/students/investment-banking-analyst-and-associate-program-us",
    notes: "Multiple 2027 roles posted on Workday; open, rolling by school.",
  },
  {
    firm: "Raymond James",
    role: "2027 Investment Banking Summer Analyst Program",
    category: "investment_banking",
    applicationUrl: "https://www.raymondjames.com/careers/students-and-recent-grads/equity-capital-markets/investment-banking",
    notes: "2027 roles opened Dec 2025; reviewed on a rolling basis, appears open.",
  },
  {
    firm: "Stifel",
    role: "2027 Investment Banking Summer Analyst Program",
    category: "investment_banking",
    applicationUrl: "https://join.stifel.com/students",
    notes: "Multiple 2027 IB summer analyst postings live across cities.",
  },
  {
    firm: "Harris Williams",
    role: "2027 M&A/PCA Summer Analyst Program",
    category: "investment_banking",
    applicationUrl: "https://www.harriswilliams.com/careers/analysts",
    notes: "2027 roles posted on Workday; resume, cover letter, assessment required.",
  },

  // ---- Private equity ----
  {
    firm: "Blackstone",
    role: "2027 Blackstone Private Equity, Summer Analyst",
    category: "private_equity",
    applicationUrl: "https://blackstone.wd1.myworkdayjobs.com/en-US/Blackstone_Campus_Careers/job/XMLNAME-2027-Blackstone-Private-Equity--Summer-Analyst_40779",
    notes: "Rare direct undergrad PE opening; 2027 cycle likely closed - watch for 2028.",
  },
  {
    firm: "KKR",
    role: "2027 Summer Analyst Program (Private Equity track)",
    category: "private_equity",
    applicationUrl: "https://www.kkr.com/careers/student-careers",
    notes: "Direct undergrad PE track exists; 2027 cycle already closed - watch for 2028.",
  },
  {
    firm: "Apollo Global Management",
    role: "Careers (Analyst Program / Summer Analyst, various groups)",
    category: "private_equity",
    applicationUrl: "https://www.apollo.com/careers",
    notes: "No distinct 2027 PE-specific posting found - check site directly.",
  },
  {
    firm: "The Carlyle Group",
    role: "Careers (Summer Analyst Program, incl. PE track)",
    category: "private_equity",
    applicationUrl: "https://www.carlyle.com/about-carlyle/careers",
    notes: "No PE-specific 2027 posting found; Carlyle hires summer analysts directly.",
  },
  {
    firm: "TPG",
    role: "TPG Private Equity Analyst Program",
    category: "private_equity",
    applicationUrl: "https://job-boards.greenhouse.io/tpgcareers",
    notes: "No 2027 undergrad PE analyst posting currently live on the board.",
  },
  {
    firm: "Warburg Pincus",
    role: "2027 US Analyst Program (full-time)",
    category: "private_equity",
    applicationUrl: "https://job-boards.greenhouse.io/warburgpincusllc/jobs/4922162008",
    notes: "Open now for Dec 2026–June 2027 grads, rolling review.",
  },

  // ---- Real estate ----
  {
    firm: "Brookfield Asset Management",
    role: "Brookfield Student Programs",
    category: "real_estate",
    applicationUrl: "https://www.brookfield.com/careers/student-programs",
    notes: "No named 2027 RE/PE undergrad summer-analyst posting; only MBA/CPA programs listed.",
  },
  {
    firm: "CBRE",
    role: "CBRE Sales & Brokerage Internship Program",
    category: "real_estate",
    applicationUrl: "https://www.cbre.com/careers/students-and-graduates/sales-and-brokerage-internship-program",
    notes: "Summer 2027 cycle not yet posted; typically opens fall 2026.",
  },
  {
    firm: "JLL",
    role: "JLL Early Careers (Internships & Graduate Programs)",
    category: "real_estate",
    applicationUrl: "https://www.jll.com/en-us/careers/early-careers",
    notes: "No specific 2027 posting live yet; portal shows general/older listings.",
  },

  // ---- Hedge funds ----
  {
    firm: "Citadel",
    role: "Equities – Citadel Associate Program, Full-Time 2027 (US)",
    category: "hedge_fund",
    applicationUrl: "https://www.citadel.com/careers/details/equities-citadel-associate-program-full-time-program-2027-us/",
    notes: "Open now for Dec 2026–July 2027 grads.",
  },
  {
    firm: "Point72 Asset Management",
    role: "Point72 Academy Investment Analyst Program, Upcoming Graduates (2027 – US)",
    category: "hedge_fund",
    applicationUrl: "https://job-boards.greenhouse.io/point72/jobs/8541241002",
    notes: "Open now, rolling review, no set application deadline.",
  },
  {
    firm: "Millennium Management",
    role: "Equities Analyst Program, New York",
    category: "hedge_fund",
    applicationUrl: "https://campusjobs.mlp.com/careers/job/755955763508-equities-analyst-program-new-york-new-york-new-york-united-states-of-america",
    notes: "Open now; bachelor's grads by June 2027, 3.6+ GPA.",
  },

  // ---- Additional programs at multi-division firms (Sales & Trading, Asset & Wealth Management) ----
  {
    firm: "Goldman Sachs",
    role: "2027 Summer Analyst Program – Global Markets (Sales & Trading)",
    category: "other",
    applicationUrl: "https://www.goldmansachs.com/careers/students/programs-and-internships/americas/2027-summer-analyst-program",
    notes: "Not yet open - Americas application opens Aug 15, 2026 (tomorrow).",
  },
  {
    firm: "Goldman Sachs",
    role: "2027 Summer Analyst Program – Asset & Wealth Management",
    category: "asset_management",
    applicationUrl: "https://www.goldmansachs.com/careers/students/programs-and-internships/americas/2027-summer-analyst-program",
    notes: "Not yet open - Americas application opens Aug 15, 2026 (tomorrow).",
  },
  {
    firm: "Morgan Stanley",
    role: "2027 Fixed Income (Sales & Trading) Summer Analyst Program",
    category: "other",
    applicationUrl: "https://www.morganstanley.com/people-opportunities/students-graduates",
    notes: "NY/SF/Houston postings closed ~March 2026 - watch for a new window.",
  },
  {
    firm: "Morgan Stanley",
    role: "2027 Wealth Management Summer Analyst Program (New York)",
    category: "asset_management",
    applicationUrl: "https://morganstanley.tal.net/vx/mobile-0/brand-0/candidate/so/pm/1/pl/1/opp/20928-2027-Wealth-Management-Summer-Analyst-Program-New-York/en-GB",
    notes: "Closed - deadline was March 13, 2026, posting marked no longer active.",
  },
  {
    firm: "JPMorgan Chase",
    role: "2027 Markets Summer Analyst Program",
    category: "other",
    applicationUrl: "https://www.jpmorganchase.com/careers/explore-opportunities/programs/markets-summer-analyst",
    notes: "Open, rolling review - listing runs through roughly Oct 1, 2026.",
  },
  {
    firm: "JPMorgan Chase",
    role: "2027 Asset Management Summer Analyst Program",
    category: "asset_management",
    applicationUrl: "https://www.jpmorganchase.com/careers/explore-opportunities/programs/asset-management-summer-analyst",
    notes: "Open - apply by Oct 1, 2026, across NY/Indianapolis/Columbus/LA/SF.",
  },
  {
    firm: "Bank of America",
    role: "Global Markets Sales & Trading Rotational Summer Analyst – 2027",
    category: "other",
    applicationUrl: "https://careers.bankofamerica.com/en-us/students/job-detail/14370/global-markets-sales-trading-rotational-summer-analyst-2027-singapore-singapore-singapore",
    notes: "Open (Singapore, apply by Sep 30, 2026) - NY posting already closed.",
  },
  {
    firm: "Bank of America",
    role: "Wealth Management Summer Analyst Program – Private Bank 2027",
    category: "asset_management",
    applicationUrl: "https://careers.bankofamerica.com/en-us/students/job-detail/13994/wealth-management-summer-analyst-program-private-bank-2027-multiple-locations",
    notes: "Open - multiple GWIM 2027 tracks posted, rolling deadlines.",
  },
  {
    firm: "Citi",
    role: "Markets – Sales and Trading, Summer Analyst, New York City – 2027",
    category: "other",
    applicationUrl: "https://jobs.citi.com/job/new-york/markets-sales-and-trading-summer-analyst-new-york-city-us-2027/287/89809477504",
    notes: "Apply button active, but posted/close dates look inconsistent - verify on site.",
  },
  {
    firm: "Citi",
    role: "Wealth Management Summer Analyst Program 2027",
    category: "asset_management",
    applicationUrl: "https://careers.citigroup.com/students-and-graduates/",
    notes: "No live 2027-specific posting found; only a 2026-cycle listing surfaced.",
  },
  {
    firm: "Barclays",
    role: "Sales, Trading and Structuring Summer Internship Programme – 2027",
    category: "other",
    applicationUrl: "https://search.jobs.barclays/job/singapore/sales-trading-and-structuring-summer-internship-programme-2027-singapore/13015/97173677984",
    notes: "Open (Singapore, confirmed live) - equivalent New York posting already closed.",
  },
  {
    firm: "UBS",
    role: "2027 Summer Internship – Global Markets, Sales & Trading (US)",
    category: "other",
    applicationUrl: "https://www.ubs.com/global/en/careers/early-careers/summer-internship-program.html",
    notes: "Prior 2027 US posting expired; likely closed for this cycle.",
  },
  {
    firm: "UBS",
    role: "Global Wealth Management – 2027 Summer Internship",
    category: "asset_management",
    applicationUrl: "https://jobs.ubs.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=25008&siteid=5131&PageType=JobDetails&jobid=339032",
    notes: "Appears open per search results; JS-rendered page couldn't be directly confirmed.",
  },
  {
    firm: "Deutsche Bank",
    role: "2027 Internship Program – Investment Bank: Fixed Income & Currencies (New York)",
    category: "other",
    applicationUrl: "https://careers.db.com/students-graduates/internship-programme/",
    notes: "Open - apply-by deadline Aug 31, 2026 per Handshake listing.",
  },
  {
    firm: "Citadel",
    role: "Citadel Securities - Quantitative Trader Intern (US)",
    category: "other",
    applicationUrl: "https://www.citadelsecurities.com/careers/details/quantitative-trader-intern-us/",
    notes: "Open on a rolling basis; live posting with active Start Application button.",
  },
  {
    firm: "Blackstone",
    role: "2027 Blackstone Real Estate Acquisitions Summer Analyst",
    category: "real_estate",
    applicationUrl: "https://blackstone.wd1.myworkdayjobs.com/en-US/Blackstone_Campus_Careers/job/New-York/XMLNAME-2027-Blackstone-Real-Estate-Acquisitions-Summer-Analyst_40467",
    notes: "Posting exists but 2027 cycle likely largely filled by August.",
  },
  {
    firm: "Brookfield Asset Management",
    role: "Private Equity Summer Analyst (undergraduate)",
    category: "private_equity",
    applicationUrl: "https://www.brookfield.com/careers/student-programs",
    notes: "Not yet posted - only an MBA-level PE internship found, no undergrad track live.",
  },
];

async function main() {
  ({ db } = await openScriptDb());
  const user = await db.query.users.findFirst();
  if (!user) {
    throw new Error("No user found — sign up through the app first, then re-run this script.");
  }

  let inserted = 0;
  let skipped = 0;
  for (const opp of OPPORTUNITIES) {
    const existing = await db.query.applications.findFirst({
      where: and(
        eq(schema.applications.userId, user.id),
        eq(schema.applications.firm, opp.firm),
        eq(schema.applications.role, opp.role),
      ),
    });
    if (existing) {
      skipped++;
      continue;
    }
    await db.insert(schema.applications).values({
      userId: user.id,
      firm: opp.firm,
      role: opp.role,
      status: "not_started",
      category: opp.category,
      applicationUrl: opp.applicationUrl,
      notes: opp.notes,
    });
    inserted++;
  }

  console.log(`Inserted ${inserted}, skipped ${skipped} (already existed).`);
  process.exit(0);
}

main();
