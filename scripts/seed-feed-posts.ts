// Fills the community feed with enough posts to exercise pagination and the
// sort options. Local dev only.
//   npx tsx --conditions=react-server scripts/seed-feed-posts.ts
import { openScriptDb } from "./_db";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";

const TYPES = ["event", "speaker_event", "coffee_chat", "deadline", "announcement"] as const;
const CATEGORIES = [
  "investment_banking", "private_equity", "hedge_fund", "sales_trading",
  "venture_capital", "asset_wealth_management", null,
] as const;

const TITLES = [
  "Spring analyst info session", "Coffee chat sign-ups open", "Resume workshop",
  "Trading floor tour", "Alumni panel: breaking into PE", "Technical interview bootcamp",
  "Networking night", "Application deadline reminder", "Meet the analysts",
  "Diversity recruiting reception", "Stock pitch competition", "Case study workshop",
  "Superday prep session", "Summer internship Q&A", "Mock interview marathon",
  "Sector deep dive: TMT", "Fireside chat with the CIO", "Campus office hours",
  "Women in finance breakfast", "Deal walkthrough session", "Portfolio construction talk",
  "First-year kickoff", "Behavioral prep clinic", "Alumni mixer",
];

async function main() {
  const { db } = await openScriptDb();

  const clubUser = await db.query.users.findFirst({ where: eq(schema.users.email, "club@offerly.test") });
  const firmUser = await db.query.users.findFirst({ where: eq(schema.users.email, "firm@offerly.test") });
  if (!clubUser || !firmUser) throw new Error("run seed-feed-orgs.ts first");

  const now = Date.now();
  const rows = TITLES.map((title, i) => {
    const fromClub = i % 2 === 0;
    const author = fromClub ? clubUser : firmUser;
    const type = TYPES[i % TYPES.length];
    // Spread across past and future so the date filters and "soonest" sort
    // have something to separate.
    const dayOffset = (i % 2 === 0 ? 1 : -1) * (i + 1) * 2;
    const startsAt = type === "announcement" ? null : new Date(now + dayOffset * 86400000);
    return {
      authorUserId: author.id,
      clubId: fromClub ? author.clubId : null,
      firmId: fromClub ? null : author.orgFirmId,
      type,
      title,
      body: `${title}. Seeded post #${i + 1} for testing the feed, its filters and infinite scroll.`,
      category: CATEGORIES[i % CATEGORIES.length],
      location: i % 3 === 0 ? "Huntsman Hall G06" : null,
      startsAt,
      // Staggered so "newest" has a stable, meaningful order.
      publishedAt: new Date(now - i * 3600000),
    };
  });

  await db.insert(schema.posts).values(rows);
  console.log(`inserted ${rows.length} posts`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
