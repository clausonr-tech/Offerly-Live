// Fills a LOCAL demo database with a synthetic student network, so the feed,
// Discussions, Peers and Connect can be exercised at the size they will
// eventually run at: ~500 students, a few hundred posts (many with photos),
// and discussion threads with replies across every topic.
//
// Everything here is invented. By default it only runs against a local PGlite
// directory whose name says "demo". With --live it writes to the database in
// DATABASE_URL instead - the shared one, pre-launch - following the same rules
// as the other sample seeds (seed-sample-peers and friends): every student and
// thread is is_sample, every address is on @network.offerly.test, and
// --remove takes all of it out again, photos included. Run --remove before
// launch; the feed is global, so real students would see these people.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/seed-demo-network.ts --live
//   npx tsx --env-file=.env.local --conditions=react-server scripts/seed-demo-network.ts --live --remove
//
// Note seed-sample-peers.ts treats EVERY is_sample user as its own: re-running
// it, or its --remove, deletes these 500 as well.
//
// The usual way in is one command, which builds the demo database if needed,
// seeds it (once - re-running adds nothing twice) and starts the app on it:
//
//   npm run demo:network        then open http://127.0.0.1:3004
//
// 127.0.0.1, not localhost: cookies are shared across ports, so on localhost
// a real login from the normal dev server (port 3001) shadows the demo one.
// The demo server is started with DATABASE_URL set to EMPTY rather than
// unset - unset, Next would fill it in from .env.local and connect to the
// real database.
//
// Stop any dev server using that directory first (PGlite is single-process).
//
// It also creates one account to look at it all from, "Test Student", and
// writes that account's password and a ready session token to
// local-data/pglite-demo-LOGIN.txt (gitignored), never to the console.
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { and, eq, inArray, isNotNull, like, or, sql } from "drizzle-orm";

const LIVE = process.argv.includes("--live");
const REMOVE = process.argv.includes("--remove");
if (LIVE) {
  if (!process.env.DATABASE_URL) {
    console.error("--live needs DATABASE_URL (run with --env-file=.env.local).");
    process.exit(1);
  }
  console.log(`LIVE database: ${new URL(process.env.DATABASE_URL).host}`);
} else {
  if (process.env.DATABASE_URL) {
    console.error("Refusing to run: DATABASE_URL is set. Pass --live to write to that database on purpose.");
    process.exit(1);
  }
  if (!/demo/.test(process.env.PGLITE_DATA_DIR ?? "")) {
    console.error("Refusing to run: set PGLITE_DATA_DIR to a demo directory, e.g. ./local-data/pglite-demo");
    process.exit(1);
  }
}
const EMAIL_DOMAIN = "@network.offerly.test";
const TEST_STUDENT = "test.student@offerly.test";

// The app's modules are imported inside main(), after the guards above, so
// nothing can open a database connection before they have run.
type SceneKind = import("./demo-network/photos").SceneKind;

// Deterministic, so a rebuilt demo DB looks the same every time.
let seed = 20260927;
const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const chance = (p: number) => r() < p;
const between = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
const shuffle = <T,>(xs: T[]): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000 - between(0, 86_399) * 1000);

// ---------------------------------------------------------------- people --

const FIRST = [
  "Aiden", "Maya", "Ethan", "Priya", "Lucas", "Sofia", "Noah", "Hannah", "Arjun", "Olivia", "Daniel", "Chloe",
  "Marcus", "Isabella", "Ryan", "Aaliyah", "Kevin", "Grace", "Jamal", "Emily", "Tyler", "Mei", "Brandon", "Zoe",
  "Andrew", "Nadia", "Jason", "Leah", "Omar", "Rachel", "Connor", "Ananya", "Diego", "Sarah", "Justin", "Fatima",
  "Matthew", "Ava", "Wei", "Julia", "Samuel", "Camila", "Nathan", "Kiara", "Rohan", "Emma", "Carlos", "Lily",
  "Jordan", "Aisha", "Patrick", "Yuna", "Christian", "Natalie", "Vikram", "Abigail", "Elijah", "Mariam", "Henry",
  "Riya", "Jack", "Elena", "David", "Imani", "Owen", "Ji-woo", "Caleb", "Victoria", "Adrian", "Tessa", "Kenji",
  "Madison", "Gabriel", "Amara", "Luke", "Sienna", "Mohammed", "Claire", "Sebastian", "Nia", "Benjamin", "Ingrid",
  "Alex", "Harper", "Dev", "Lauren", "Isaac", "Serena", "Thomas", "Jasmine", "Charlie", "Keira", "Ahmed", "Paige",
];
const LAST = [
  "Chen", "Patel", "Nguyen", "Kim", "Garcia", "Johnson", "Williams", "Shah", "Rodriguez", "Lee", "Brown", "Singh",
  "Martinez", "Davis", "Wang", "Miller", "Lopez", "Wilson", "Gupta", "Anderson", "Thomas", "Park", "Taylor", "Moore",
  "Jackson", "Martin", "Thompson", "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson", "Walker",
  "Young", "Allen", "King", "Wright", "Scott", "Torres", "Hill", "Flores", "Green", "Adams", "Nelson", "Baker",
  "Hall", "Rivera", "Campbell", "Mitchell", "Carter", "Roberts", "Zhang", "Liu", "Okafor", "Mensah", "Haddad",
  "Cohen", "Murphy", "O'Brien", "Sullivan", "Kapoor", "Iyer", "Tanaka", "Sato", "Novak", "Rossi", "Silva", "Costa",
  "Hughes", "Price", "Bennett", "Reyes", "Morales", "Ortiz", "Kumar", "Das", "Chowdhury", "Ali", "Hassan", "Yamamoto",
];

// The schools students here actually attend, weighted toward the targets.
const SCHOOL_WEIGHTS: [string, number][] = [
  ["University of Pennsylvania", 9], ["New York University", 7], ["University of Michigan", 7],
  ["University of Southern California", 7], ["University of Notre Dame", 6], ["University of California, Los Angeles", 6],
  ["Indiana University Bloomington", 6], ["University of Texas at Austin", 6], ["Georgetown University", 6],
  ["Boston College", 5], ["Duke University", 5], ["University of Virginia", 5], ["Columbia University", 5],
  ["Cornell University", 5], ["Harvard University", 4], ["Princeton University", 4], ["Emory University", 4],
  ["Fordham University", 4], ["University of Chicago", 4], ["Northwestern University", 4], ["Vanderbilt University", 4],
  ["Stanford University", 3], ["Yale University", 3], ["Rice University", 3], ["Boston University", 4],
  ["University of California, Berkeley", 4], ["Washington University in St. Louis", 3], ["Brown University", 3],
  ["University of North Carolina at Chapel Hill", 3], ["Dartmouth College", 2],
];
const weightedSchool = (() => {
  const bag = SCHOOL_WEIGHTS.flatMap(([n, w]) => Array<string>(w).fill(n));
  return () => pick(bag);
})();

const MAJORS = ["Finance", "Economics", "Accounting", "Business Administration", "Mathematics", "Computer Science", "Applied Math", "Statistics", "Political Science", "Real Estate"];
const HOMETOWNS = [
  "Chicago, IL", "Dallas, TX", "Houston, TX", "Atlanta, GA", "Boston, MA", "Philadelphia, PA", "Short Hills, NJ",
  "Greenwich, CT", "Los Angeles, CA", "San Francisco, CA", "Seattle, WA", "Denver, CO", "Phoenix, AZ",
  "Miami, FL", "Charlotte, NC", "Nashville, TN", "Minneapolis, MN", "Columbus, OH", "Washington, DC", "Austin, TX",
  "San Diego, CA", "Scottsdale, AZ", "Westchester, NY", "Naperville, IL", "Bethesda, MD", "Toronto, ON", "London, UK",
  "Seoul, South Korea", "Mumbai, India", "Singapore",
];
const LOCATIONS = ["New York City", "San Francisco", "Chicago", "Los Angeles", "Boston", "Houston", "Charlotte", "Dallas"];
const CATEGORY_SETS = [
  ["investment_banking"], ["investment_banking", "private_equity"], ["private_equity"], ["investment_banking", "sales_trading"],
  ["hedge_fund", "asset_wealth_management"], ["venture_capital", "private_equity"], ["investment_banking", "real_estate"],
  ["private_credit", "private_equity"], ["sales_trading"], ["consulting", "investment_banking"],
];
const CLUBS = [
  "Investment Banking Club", "Finance Society", "Student Investment Fund", "Real Estate Club", "Women in Business",
  "Consulting Group", "Private Equity & VC Club", "Undergraduate Finance Association", "Quant Club",
];

const ABOUT = [
  "Sophomore recruiting for {cat}. Happy to swap notes on superdays and technicals.",
  "Junior at {school}. Spent last summer at {firm}; recruiting for full-time now.",
  "{major} major, {club} member. Always up for a coffee chat.",
  "Transferring into finance from engineering. Learning the technicals one DCF at a time.",
  "Recruiting for {cat} in {loc}. Ask me about the {club}.",
  "First-gen student figuring out banking recruiting. Let's connect.",
  "Former D1 athlete, now obsessed with LBO models.",
  "Interested in {cat}; previously interned at {firm}.",
];

// Firm names as the firms table has them (lib/firm-seeds); resolved to rows below.
const FIRM_NAMES = [
  "Goldman Sachs", "Morgan Stanley", "JPMorgan", "Evercore", "Lazard", "Centerview Partners", "PJT Partners",
  "Moelis & Company", "Perella Weinberg Partners", "Guggenheim Securities", "Houlihan Lokey", "Jefferies",
  "Citigroup", "Bank of America", "Barclays (US)", "Deutsche Bank (US)", "William Blair", "Piper Sandler",
  "Blackstone", "KKR", "Apollo Global Management", "Carlyle Group", "Bain Capital", "TPG", "Warburg Pincus",
  "Brookfield", "Citadel", "Point72", "Bridgewater Associates", "Harris Williams", "Baird", "RBC Capital Markets",
];
const TICKERS = ["GS", "MS", "JPM", "EVR", "LAZ", "BX", "KKR", "APO", "C", "BAC", "SPY", "QQQ", "NVDA", "AAPL", "TSLA"];
const ROLES = ["Summer Analyst", "Investment Banking Summer Analyst", "Private Equity Summer Analyst", "Sales & Trading Summer Analyst", "Summer Associate"];

const catLabel: Record<string, string> = {
  investment_banking: "investment banking", private_equity: "private equity", sales_trading: "sales & trading",
  hedge_fund: "hedge funds", asset_wealth_management: "asset management", venture_capital: "venture capital",
  real_estate: "real estate", private_credit: "private credit", consulting: "consulting",
};

// ----------------------------------------------------------------- posts --

type PostTpl = { title?: string; body: string; scene?: SceneKind };
const POSTS: PostTpl[] = [
  { title: "Signed!", body: "Beyond grateful to share I'll be joining {firm} as a {role} next summer. Huge thanks to everyone who ran mock interviews with me.", scene: "offer" },
  { title: "It's official", body: "Accepted my offer from {firm}. Two years of cold emails, coffee chats and 400 flashcards. DM me if you're recruiting, happy to help.", scene: "offer" },
  { body: "Superday at {firm} tomorrow. Any last advice? Already went through the technicals guide twice.", scene: "badge" },
  { body: "Networking night with {firm} tonight. Met three alumni from {school} and one of them offered to pass my resume along." , scene: "badge" },
  { title: "Office visit", body: "Got to see the {firm} floor in {loc} today. The views are unreal.", scene: "skyline" },
  { body: "Late night in the library building my first LBO from scratch. The debt schedule finally balances.", scene: "spreadsheet" },
  { title: "Model check", body: "Built a 3-statement model for my stock pitch this week. Would love feedback from anyone who's done one for a club competition.", scene: "spreadsheet" },
  { body: "Flashcard grind before recruiting season. If you want my deck (120 cards, IB technicals) just ask.", scene: "flashcards" },
  { title: "Technicals are clicking", body: "Walked through a DCF out loud to my roommate 10 times. Finally feels natural.", scene: "flashcards" },
  { body: "Coffee chat with a {firm} associate today. Best advice: know exactly why this group, not just why banking.", scene: "coffee" },
  { title: "Coffee chat tip", body: "Always end with 'is there anyone else you think I should talk to?' It turned one chat into four this month.", scene: "coffee" },
  { body: "Our student fund's pitch on {ticker} went up 8% since we presented. Very small sample size, very big ego boost.", scene: "chart" },
  { title: "Markets update", body: "Anyone else watching {ticker} this week? Using it as a case study for our investment club meeting.", scene: "chart" },
  { body: "Golden hour on campus. Recruiting season is stressful but this view helps.", scene: "campus" },
  { title: "Back on campus", body: "Moved back in at {school}. Setting up the Investment Banking Club's first info session of the year.", scene: "campus" },
  { body: "{loc} skyline from the rooftop after our trek. Visited four firms in two days.", scene: "skyline" },
  { title: "Finance trek recap", body: "Our club visited {firm}, plus two boutiques. Biggest takeaway: every analyst said culture matters more than the logo." , scene: "skyline" },
  { body: "Just submitted my {firm} application. Fingers crossed." },
  { body: "Does anyone know if {firm}'s summer analyst application has a HireVue this year?" },
  { body: "Reminder: follow up after coffee chats within 24 hours. Short thank-you, one specific thing you learned." },
  { title: "Rejection, but okay", body: "Didn't make it past the first round at {firm}. Asked for feedback and actually got some. On to the next one." },
  { body: "Hit a 30-day practice streak today. The mental math drills are paying off." },
  { title: "Resources thread", body: "Putting together a list of the best free resources for IB technicals. Drop your favorites below and I'll compile them." },
  { body: "Anyone from {school} going to the {firm} diversity event next week? Would love to go together." },
  { body: "Mock interview swap anyone? I'll do behavioral, you do technicals, then switch." },
  { title: "Why {cat}?", body: "Took me a year to write a real answer to 'why {cat}'. Mine now starts with the summer I spent helping my family's business raise a loan." },
  { body: "Networking email response rate this month: 11 of 40. Personalizing the first line made the biggest difference." },
  { body: "Group project turned into a real valuation of a local company. Learned more there than in any class." },
];

// ---------------------------------------------------------- discussions --

const THREADS: Record<string, { title: string; body: string }[]> = {
  Interviews: [
    { title: "How long should my 'walk me through your resume' be?", body: "I'm at about 2.5 minutes and it feels long. What have people found works in first rounds?" },
    { title: "Superday format at elite boutiques?", body: "Got a superday next week. Is it usually 4 back-to-back 30 minute interviews, or does it vary a lot by firm?" },
    { title: "Behavioral questions that caught you off guard", body: "Mine was 'tell me about a time you disagreed with a manager'. What are yours?" },
    { title: "HireVue tips", body: "First HireVue ever this weekend. Any tips on pacing and where to look?" },
    { title: "Is it okay to bring notes to a virtual interview?", body: "Not reading off them, just a few bullet points of stories. Thoughts?" },
    { title: "What do you ask at the end of an interview?", body: "I always blank when they ask if I have questions. Looking for good ones that aren't generic." },
    { title: "Group interviews at S&T", body: "Heard some desks do group interviews. What's that actually like?" },
    { title: "How technical are PE first rounds for undergrads?", body: "Should I expect a paper LBO in the first round or is that later?" },
    { title: "Fit vs. technical weighting", body: "Which matters more at bulge brackets for sophomores?" },
    { title: "Recovering after a bad answer", body: "Totally botched a question mid-interview. Can you come back from that?" },
    { title: "Case study interview for growth equity", body: "Anyone done a take-home case? How much time did you spend?" },
  ],
  Technicals: [
    { title: "Walk me through a DCF: how detailed?", body: "Do they want terminal value methods explained, or just the high-level steps?" },
    { title: "Depreciation flowing through the 3 statements", body: "Can someone sanity check my answer for a $10 increase in depreciation with a 25% tax rate?" },
    { title: "EV vs equity value, the bridge", body: "Why do we add non-controlling interest? I keep memorizing it without understanding it." },
    { title: "Best way to learn LBO paper models", body: "Looking for practice problems that are actually timed like an interview." },
    { title: "Accretion/dilution shortcut", body: "Is comparing cost of acquisition vs. earnings yield reliable enough to answer quickly?" },
    { title: "How would you value a company with negative earnings?", body: "Got asked this and said revenue multiples. Was that enough?" },
    { title: "WACC: when does adding debt stop helping?", body: "I get the tax shield part, but how do you explain the tipping point concisely?" },
    { title: "Bank valuation questions", body: "FIG interviews ask about P/TBV. Any good primers?" },
    { title: "Unlevered vs levered FCF", body: "Which do you use for a DCF and why? Want to make sure I explain it right." },
    { title: "Goodwill and purchase accounting", body: "Struggling with the purchase price allocation questions. Any intuitive way to think about it?" },
    { title: "Brain teasers still a thing?", body: "Got a brain teaser in a S&T interview. How common are those now?" },
  ],
  "Recruiting timeline": [
    { title: "When do junior summer apps open this cycle?", body: "Feels earlier every year. Anyone tracking the bulge bracket dates?" },
    { title: "Is it too late to start networking as a junior?", body: "Just switched into finance. Where should I focus my time first?" },
    { title: "Sophomore programs worth applying to", body: "Which sophomore diversity or insight programs actually convert to offers?" },
    { title: "PE on-cycle for undergrads?", body: "Are there any undergrad programs that recruit on the on-cycle timeline?" },
    { title: "Spring week vs summer internship", body: "Is a spring insight week worth giving up spring break for?" },
    { title: "Off-cycle recruiting at boutiques", body: "Anyone recruited off-cycle at a middle market bank? How did you find the openings?" },
    { title: "How many applications did you send?", body: "Trying to calibrate. I'm at 35 and have 4 first rounds." },
    { title: "Recruiting while studying abroad", body: "Will I miss everything if I'm abroad in the fall of junior year?" },
    { title: "Timeline for hedge fund internships", body: "Seems much less structured than banking. When do they usually hire?" },
    { title: "Accepting early vs waiting", body: "Got an exploding offer from a middle market bank. Should I wait for BB superdays?" },
  ],
  Networking: [
    { title: "Cold email templates that actually work", body: "Share your best subject lines. Mine is '{school} student - quick question about {firm}'." },
    { title: "How often to follow up?", body: "Sent an email 8 days ago, no reply. Is a second follow-up pushy?" },
    { title: "LinkedIn vs email for outreach", body: "Which gets better response rates for analysts?" },
    { title: "What to talk about in a 15-minute coffee chat", body: "I always run out of questions after 10 minutes." },
    { title: "Networking with non-alumni", body: "No alumni at my target firm. How do you get a first conversation going?" },
    { title: "Keeping track of contacts", body: "Spreadsheet, CRM, notes app? What's your system?" },
    { title: "Thank you notes: email or LinkedIn?", body: "After a coffee chat, which is more appropriate?" },
    { title: "Is it weird to network with someone younger than you?", body: "A first-year analyst from my school is a year older than me. Still worth reaching out?" },
    { title: "Networking at info sessions", body: "How do you stand out when there are 200 students in the room?" },
    { title: "Referral etiquette", body: "Someone offered to refer me. What do I send them to make it easy?" },
  ],
  Offers: [
    { title: "Negotiating a summer analyst offer?", body: "Is that ever done, or is comp fixed across the class?" },
    { title: "BB vs EB offer: which would you take?", body: "Deciding between a bulge bracket in NYC and an elite boutique in SF." },
    { title: "Reneging: ever okay?", body: "Asking hypothetically. What are the real consequences?" },
    { title: "Group placement after accepting", body: "Do you get a say in which group you're staffed in?" },
    { title: "Exploding offers", body: "Got 7 days to decide. Can I ask for an extension politely?" },
    { title: "Return offer rates", body: "Anyone have data on return offer rates by firm?" },
    { title: "Offer came through!", body: "Wanted to say thanks to this community. The mock interview swaps here made the difference." },
    { title: "Signing bonus timing", body: "When do signing bonuses usually get paid out for full-time?" },
    { title: "Location choice after the offer", body: "They asked if I'd consider Houston instead of NYC. Thoughts on energy banking?" },
  ],
  "Internship life": [
    { title: "What to wear the first week", body: "Business casual or suits? The email was vague." },
    { title: "Hours as a summer analyst", body: "Realistic weekly hours at a BB? Asking so I can plan housing near the office." },
    { title: "Housing in NYC for the summer", body: "Best neighborhoods for interns? Budget around $2,500/month." },
    { title: "How to get a return offer", body: "Beyond working hard, what actually matters?" },
    { title: "First deal as an intern", body: "Got staffed on a live sell-side. Any tips for not messing up the CIM?" },
    { title: "Excel shortcuts to learn before day one", body: "Which ones do you actually use every day?" },
    { title: "Intern events worth going to", body: "Are the evening socials mandatory in practice?" },
    { title: "Balancing two staffings", body: "Two associates both need things tonight. How do you handle that?" },
    { title: "Summer in Chicago", body: "Anyone else interning in Chicago? Would love to meet up." },
  ],
  "Exit opps": [
    { title: "Banking to PE: how soon do recruiters reach out?", body: "Heard on-cycle starts before you've even begun full-time. True?" },
    { title: "Is corporate development a good exit?", body: "Seems like better hours. What's the trade-off?" },
    { title: "Hedge fund exits from S&T", body: "More common than from IB? Curious about the path." },
    { title: "Going to business school later", body: "Does the bank brand still matter for MBA admissions?" },
    { title: "Growth equity vs buyout", body: "What's the difference in day-to-day work for a first-year associate?" },
    { title: "Startups after banking", body: "Anyone joined a startup as a finance hire? How did the skills translate?" },
    { title: "Exit opps from middle market banks", body: "Are they as limited as people say?" },
    { title: "Venture capital without an operating background", body: "Realistic for a banker?" },
  ],
  General: [
    { title: "Best finance podcasts?", body: "Looking for something to listen to on the way to class." },
    { title: "How are you managing stress this cycle?", body: "Recruiting plus midterms is a lot. What's helping?" },
    { title: "GPA cutoffs, real or myth?", body: "Is a 3.5 really a hard screen at most banks?" },
    { title: "Books that helped you understand markets", body: "Trying to read more beyond the technical guides." },
    { title: "Study group for technicals", body: "Starting a weekly virtual study group. Anyone want to join?" },
    { title: "Non-target success stories", body: "Would love to hear from anyone who broke in from a non-target." },
    { title: "Club leadership: worth the time?", body: "Does running a club actually come up in interviews?" },
    { title: "Favorite resume formatting tips", body: "One page, sure, but what else do recruiters notice?" },
    { title: "Anyone else doing a stock pitch competition?", body: "Looking for teammates for the spring competition." },
  ],
};
const REPLIES: Record<string, string[]> = {
  Interviews: [
    "Keep it under two minutes. Hit school, why finance, experiences, why this firm.", "I always prepare 3 stories that can flex to most behavioral questions.",
    "Superdays at boutiques were more technical for me than at BBs.", "Look at the camera, not the screen. Feels weird but it works.",
    "Ask them about a deal they enjoyed working on. People love talking about that.", "Honestly, fit mattered more for me as a sophomore.",
    "You can recover. Acknowledge it, correct yourself, move on calmly.", "Paper LBO came in the second round for me.",
    "Practice with a timer. Rambling is the most common mistake.", "Thank-you emails the same day, short and specific.",
  ],
  Technicals: [
    "High-level first, then offer to go deeper. Let them steer.", "Net income down 7.5, cash up 2.5 after the tax shield. Balance sheet balances.",
    "NCI gets added because EV counts 100% of the subsidiary's value.", "The BIWS and WSO guides have good timed paper LBOs.",
    "The shortcut is fine as long as you mention it's a simplification.", "Revenue multiples plus a DCF with a long projection period.",
    "Explain it as the rising cost of equity and distress risk eventually offsetting the shield.", "Unlevered for enterprise value, levered for equity value.",
    "Think of goodwill as the premium over fair value of net assets.", "Brain teasers still show up on some trading desks.",
  ],
  "Recruiting timeline": [
    "Most BB apps opened in the spring of sophomore year this cycle.", "Not too late, but prioritize networking at 10-15 firms.",
    "The insight programs at the bulge brackets converted a lot of my friends.", "A few funds do recruit undergrads, but it's rare.",
    "Spring weeks were worth it for me, especially for S&T.", "I found off-cycle roles through alumni, not job boards.",
    "35 is reasonable. Quality of networking matters more.", "Recruiting abroad is doable, just block out interview time zones.",
    "Hedge funds hire whenever they have a need. Keep your network warm.", "Ask for an extension. Most firms will give a few days.",
  ],
  Networking: [
    "Short subject lines with the school name worked best for me.", "Follow up once after a week. After that let it go.",
    "Email gets better response rates for analysts in my experience.", "Ask about their path, what surprised them, and advice for someone in your shoes.",
    "Find people who share anything with you: hometown, club, sport.", "I use a spreadsheet with last contact date and next step.",
    "Email for thank-yous, LinkedIn to stay in touch after.", "Definitely reach out. Younger analysts remember recruiting best.",
    "Ask one thoughtful question and follow up by email the next day.", "Send a short blurb and your resume so they can forward it directly.",
  ],
  Offers: [
    "Summer comp is usually fixed. Full-time is where there's some room.", "Depends on the group. I'd pick the group over the logo.",
    "Reneging burns bridges, especially in a small industry.", "Some banks let you rank groups, others staff you generally.",
    "Asking politely for a few more days is normal.", "Return rates are high at most banks if you're solid.",
    "Congrats!! Well deserved.", "Houston energy is a great place to build technical skills.",
  ],
  "Internship life": [
    "Suit the first day, then match what the analysts wear.", "70-90 hours depending on the group and deal flow.",
    "Murray Hill and FiDi were popular with my intern class.", "Be the person they trust to get the details right.",
    "Check every number in the CIM against the model twice.", "Ctrl+arrows, Alt shortcuts for formatting, F4 for anchoring.",
    "Go to the socials. That's where you meet people outside your team.", "Tell both associates about the conflict early and let them prioritize.",
  ],
  "Exit opps": [
    "On-cycle can start within months of starting full-time.", "Corp dev has better hours but slower comp growth.",
    "S&T to hedge funds is a common path on the markets side.", "The brand helps, but your story matters more for business school.",
    "Growth equity is more about sourcing and market work.", "The modeling skills translate well, the pace is different.",
    "Middle market exits are good if the deal experience is strong.", "Possible, especially with sector expertise.",
  ],
  General: [
    "Odd Lots and Capital Allocators are great.", "Blocking off one night a week with no recruiting at all helps.",
    "3.5 is a soft screen at most places, networking can get you past it.", "Liar's Poker and Barbarians at the Gate.",
    "I'm in for the study group!", "Broke in from a non-target. It took a lot of networking but it's doable.",
    "Leadership comes up a lot in behavioral questions.", "Consistent formatting and quantified bullets.", "Count me in for the pitch team.",
  ],
};

// ----------------------------------------------------------------- seed --

function fill(tpl: string, v: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");
}

async function main() {
  const { getDb } = await import("../src/db/client");
  const schema = await import("../src/db/schema");
  const { syncFirmCatalog } = await import("../src/lib/firm-sync");
  const { hashPassword } = await import("../src/lib/auth");
  const { putStoredFile, deleteStoredFiles } = await import("../src/lib/file-store");
  const { POLICY_VERSION } = await import("../src/lib/policy");
  const { renderScene } = await import("./demo-network/photos");
  const { users, activityEvents, discussions, discussionReplies, userTopFirms, peerLinks, follows, firms, schools, sessions } =
    schema;
  const db = await getDb();

  if (REMOVE) {
    const mine = await db.select({ id: users.id }).from(users).where(or(like(users.email, `%${EMAIL_DOMAIN}`), eq(users.email, TEST_STUDENT)));
    const ids = mine.map((u) => u.id);
    let threads = 0;
    let photos = 0;
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      // Stored photos have no foreign key to their post, so they go first,
      // while the posts that name them still exist.
      const withPhotos = await db
        .select({ key: activityEvents.imagePath })
        .from(activityEvents)
        .where(and(inArray(activityEvents.userId, chunk), isNotNull(activityEvents.imagePath)));
      await deleteStoredFiles("post-image", withPhotos.map((p) => p.key!));
      photos += withPhotos.length;
      // Threads and replies only set their author to null when a user goes,
      // so they are deleted explicitly. Replies to these threads by anyone
      // cascade with the thread.
      await db.delete(discussionReplies).where(and(inArray(discussionReplies.authorId, chunk), eq(discussionReplies.isSample, true)));
      threads += (await db.delete(discussions).where(and(inArray(discussions.authorId, chunk), eq(discussions.isSample, true))).returning()).length;
      // Posts, joins, top firms, peers, follows and sessions cascade.
      await db.delete(users).where(inArray(users.id, chunk));
    }
    console.log(`Removed ${ids.length} students, ${threads} threads and ${photos} photos.`);
    process.exit(0);
  }

  const existing = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(like(users.email, `%${EMAIL_DOMAIN}`));
  if (existing[0].n > 0) {
    console.log(`Already seeded (${existing[0].n} network students). Nothing to do.`);
    process.exit(0);
  }

  console.log("[1/7] firms");
  // The live database already has its firms (`npm run db:sync-firms`).
  if (!LIVE) await syncFirmCatalog();
  const firmRows = await db.select({ id: firms.id, name: firms.name }).from(firms).where(inArray(firms.name, FIRM_NAMES));
  const firmByName = new Map(firmRows.map((f) => [f.name, f]));
  const firmPool = FIRM_NAMES.filter((n) => firmByName.has(n));
  console.log(`      ${firmPool.length} of ${FIRM_NAMES.length} named firms present`);

  const schoolRows = await db.select({ id: schools.id, name: schools.name }).from(schools).where(inArray(schools.name, SCHOOL_WEIGHTS.map(([n]) => n)));
  const schoolByName = new Map(schoolRows.map((s) => [s.name, s]));

  console.log("[2/7] 500 students");
  // One unusable password for every synthetic student: nobody logs in as them.
  const lockedHash = await hashPassword(randomBytes(24).toString("hex"));
  const people: { id: string; name: string; school: string; gradYear: number; createdAt: Date; cats: string[] }[] = [];
  // Sample threads show this in place of an author (lib/discussions authorLabel).
  const label = (p: { name: string; school: string; gradYear: number }) => `${p.name} · ${p.school} '${String(p.gradYear).slice(-2)}`;
  const usedNames = new Set<string>();
  const rows: (typeof users.$inferInsert)[] = [];
  while (rows.length < 500) {
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    if (usedNames.has(name)) continue;
    usedNames.add(name);
    const schoolName = weightedSchool();
    const school = schoolByName.get(schoolName);
    const cats = pick(CATEGORY_SETS);
    const gradYear = pick([2026, 2027, 2027, 2028, 2028, 2029]);
    const created = daysAgo(between(1, 150));
    const firm = pick(firmPool);
    const vars = { cat: catLabel[cats[0]] ?? "finance", school: schoolName, firm, major: pick(MAJORS), club: pick(CLUBS), loc: pick(LOCATIONS) };
    const hadInternship = gradYear <= 2027 && chance(0.55);
    rows.push({
      email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}.${rows.length}${EMAIL_DOMAIN}`,
      // Shown with a "Sample" tag, and what --remove and seed-sample-peers find.
      isSample: true,
      passwordHash: lockedHash,
      name,
      school: schoolName,
      claimedSchoolId: school?.id ?? null,
      gradYear,
      targetInternshipYear: gradYear - 1,
      major: vars.major,
      hometown: pick(HOMETOWNS),
      showHometownOnProfile: chance(0.6),
      aboutMe: fill(pick(ABOUT), vars),
      preferredCategories: cats,
      targetLocations: shuffle(LOCATIONS).slice(0, between(1, 3)),
      clubsAndActivities: shuffle(CLUBS).slice(0, between(1, 3)).join(", "),
      internships: hadInternship
        ? [{ firm: pick(firmPool), firmId: null, website: null, role: pick(["Summer Analyst", "Finance Intern", "Investment Intern"]), start: "2025-06", end: "2025-08", current: false }]
        : [],
      practiceCurrentStreak: between(0, 40),
      practiceBestStreak: between(5, 60),
      onboardingCompletedAt: created,
      profileLinksPromptedAt: created,
      consentedPolicyVersion: POLICY_VERSION,
      consentedAt: created,
      createdAt: created,
    } as typeof users.$inferInsert);
  }
  for (let i = 0; i < rows.length; i += 100) {
    const inserted = await db.insert(users).values(rows.slice(i, i + 100)).returning();
    for (const u of inserted) people.push({ id: u.id, name: u.name!, school: u.school!, gradYear: u.gradYear!, createdAt: u.createdAt, cats: u.preferredCategories ?? [] });
  }

  console.log("[3/7] top firms, peers, follows");
  const topRows: (typeof userTopFirms.$inferInsert)[] = [];
  for (const p of people) {
    for (const f of shuffle(firmPool).slice(0, between(3, 8))) {
      topRows.push({ userId: p.id, firmId: firmByName.get(f)!.id, source: "manual" });
    }
  }
  for (let i = 0; i < topRows.length; i += 500) await db.insert(userTopFirms).values(topRows.slice(i, i + 500));

  const pairs = new Set<string>();
  const peerRows: (typeof peerLinks.$inferInsert)[] = [];
  for (const p of people) {
    for (const q of shuffle(people).slice(0, between(2, 10))) {
      if (q.id === p.id || pairs.has(`${p.id}:${q.id}`)) continue;
      pairs.add(`${p.id}:${q.id}`);
      peerRows.push({ userId: p.id, peerId: q.id });
      // Most adds are returned, which is what makes two students "peers".
      if (chance(0.7) && !pairs.has(`${q.id}:${p.id}`)) {
        pairs.add(`${q.id}:${p.id}`);
        peerRows.push({ userId: q.id, peerId: p.id });
      }
    }
  }
  for (let i = 0; i < peerRows.length; i += 500) await db.insert(peerLinks).values(peerRows.slice(i, i + 500));

  console.log("[4/7] joins, offers and streaks");
  const events: (typeof activityEvents.$inferInsert)[] = [];
  for (const p of people) {
    events.push({ userId: p.id, kind: "joined", dedupeKey: p.id, createdAt: p.createdAt });
    if (chance(0.12)) {
      events.push({ userId: p.id, kind: "offer", dedupeKey: randomUUID(), firm: pick(firmPool), role: pick(ROLES), createdAt: daysAgo(between(0, 60)) });
    }
    if (chance(0.2)) {
      const m = pick([5, 10, 15, 20, 25, 30]);
      events.push({ userId: p.id, kind: "streak", dedupeKey: String(m), streak: m, createdAt: daysAgo(between(0, 45)) });
    }
  }
  for (let i = 0; i < events.length; i += 500) await db.insert(activityEvents).values(events.slice(i, i + 500));

  console.log("[5/7] posts with photos (rendering images...)");
  let photos = 0;
  const posts: (typeof activityEvents.$inferInsert)[] = [];
  for (let i = 0; i < 260; i++) {
    const p = pick(people);
    const tpl = pick(POSTS);
    const vars = { firm: pick(firmPool), role: pick(ROLES), school: p.school, loc: pick(LOCATIONS), ticker: pick(TICKERS), cat: catLabel[p.cats[0]] ?? "finance" };
    let imagePath: string | null = null;
    if (tpl.scene) {
      const bytes = await renderScene(tpl.scene, r, { firm: vars.firm, name: p.name, ticker: vars.ticker });
      imagePath = `${randomUUID()}.jpg`;
      await putStoredFile("post-image", imagePath, "image/jpeg", bytes);
      photos++;
    }
    posts.push({
      userId: p.id,
      kind: "post",
      dedupeKey: randomUUID(),
      title: tpl.title ? fill(tpl.title, vars) : null,
      body: fill(tpl.body, vars),
      imagePath,
      createdAt: daysAgo(between(0, 45)),
    });
  }
  for (let i = 0; i < posts.length; i += 100) await db.insert(activityEvents).values(posts.slice(i, i + 100));
  console.log(`      ${posts.length} posts, ${photos} with photos`);

  console.log("[6/7] discussions and replies");
  let threadCount = 0;
  let replyCount = 0;
  for (const [topic, threads] of Object.entries(THREADS)) {
    for (const t of threads) {
      const author = pick(people);
      const firm = chance(0.3) ? pick(firmPool) : null;
      const created = daysAgo(between(2, 50));
      const replies = between(0, 12);
      const replyRows: (typeof discussionReplies.$inferInsert)[] = [];
      let last = created;
      for (let k = 0; k < replies; k++) {
        last = new Date(Math.min(NOW - 60_000, last.getTime() + between(20, 60 * 30) * 60_000));
        const by = pick(people);
        replyRows.push({ discussionId: "", authorId: by.id, anonymous: chance(0.15), body: pick(REPLIES[topic]), isSample: true, sampleAuthor: label(by), createdAt: last });
      }
      const vars = { school: author.school, firm: firm ?? pick(firmPool) };
      const [d] = await db
        .insert(discussions)
        .values({
          authorId: author.id,
          anonymous: chance(0.2),
          title: fill(t.title, vars),
          body: fill(t.body, vars),
          topic,
          isSample: true,
          sampleAuthor: label(author),
          firmId: firm ? firmByName.get(firm)!.id : null,
          firmName: firm,
          replyCount: replies,
          lastActivityAt: last,
          createdAt: created,
        })
        .returning();
      if (replyRows.length) await db.insert(discussionReplies).values(replyRows.map((x) => ({ ...x, discussionId: d.id })));
      threadCount++;
      replyCount += replies;
    }
  }
  console.log(`      ${threadCount} threads, ${replyCount} replies`);

  if (LIVE) {
    console.log("[7/7] skipped on --live: sign in with your own account");
    process.exit(0);
  }
  console.log("[7/7] the Test Student account");
  const password = randomBytes(12).toString("base64url");
  const usc = schoolByName.get("University of Southern California");
  const [me] = await db
    .insert(users)
    .values({
      email: TEST_STUDENT,
      passwordHash: await hashPassword(password),
      name: "Test Student",
      school: "University of Southern California",
      claimedSchoolId: usc?.id ?? null,
      gradYear: 2028,
      targetInternshipYear: 2027,
      major: "Finance",
      preferredCategories: ["investment_banking", "private_equity"],
      targetLocations: ["New York City", "Los Angeles"],
      aboutMe: "Test account for the demo network.",
      onboardingCompletedAt: new Date(),
      profileLinksPromptedAt: new Date(),
      consentedPolicyVersion: POLICY_VERSION,
      consentedAt: new Date(),
    } as typeof users.$inferInsert)
    .returning();
  for (const f of firmPool.slice(0, 6)) await db.insert(userTopFirms).values({ userId: me.id, firmId: firmByName.get(f)!.id, source: "manual" });
  for (const q of shuffle(people).slice(0, 14)) {
    await db.insert(peerLinks).values({ userId: me.id, peerId: q.id });
    await db.insert(peerLinks).values({ userId: q.id, peerId: me.id });
  }
  for (const q of shuffle(people).slice(0, 8)) await db.insert(peerLinks).values({ userId: q.id, peerId: me.id }).onConflictDoNothing();
  for (const q of shuffle(people).slice(0, 20)) await db.insert(follows).values({ followerId: me.id, followingUserId: q.id });
  await db.insert(activityEvents).values({ userId: me.id, kind: "joined", dedupeKey: me.id });

  const token = randomBytes(32).toString("hex");
  await db.insert(sessions).values({
    userId: me.id,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(NOW + 30 * 86_400_000),
  });
  writeFileSync(
    "./local-data/pglite-demo-LOGIN.txt",
    [
      "Demo network login (local demo DB only - never the real database).",
      "Email:    test.student@offerly.test",
      `Password: ${password}`,
      `Session cookie (session_token), valid 30 days: ${token}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  console.log("      login written to local-data/pglite-demo-LOGIN.txt");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
