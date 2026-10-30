import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { contacts, userTopFirms } from "@/db/schema";
import { normalizeFirmName } from "@/lib/firm-name";

// "Do I actually know anyone where it matters?"
//
// A contact list grows where outreach is easy, not where it counts - the
// student who already has eleven people at one bank keeps talking to that bank.
// This crosses their saved top firms against their own contacts so the
// dashboard can say "Centerview is on your list and you know nobody there",
// which is the sentence that actually changes behaviour.

// contacts.firm is free text - typed by hand, CSV-imported, or copied off a
// profile - while userTopFirms joins on firms.id. The two only ever meet
// through the firm *name*, so both sides get normalised through the same
// function below. Auto-added directory contacts already store the exact firm
// name and match cleanly; hand-entered ones are the messy case this is for.

// The name normaliser lives in lib/firm-name.ts, with no imports, so rules
// that run without a database (the thank-you prompt) match firms the same way.
export { normalizeFirmName };

export type FirmCoverage = {
  firmId: string;
  firmName: string;
  firmSlug: string;
  firmWebsite: string;
  // People the student sourced themselves.
  personalCount: number;
  // ...of which they have actually spoken to (anything past not_contacted).
  engagedCount: number;
  // Recruiting-directory rows auto-added when they matched the firm. Counted
  // separately and never folded into the numbers above: a published campus
  // recruiting inbox is not a relationship, and letting it read as coverage
  // would paper over exactly the gap this function exists to surface.
  directoryCount: number;
};

// Worst-covered first: no contacts at all, then contacts but no conversations,
// then by how thin the coverage is. Ties break on firm name so the order is
// stable between loads rather than shuffling on every render.
function coverageRank(c: FirmCoverage): number {
  if (c.personalCount === 0) return 0;
  if (c.engagedCount === 0) return 1;
  return 2;
}

export async function getNetworkCoverage(userId: string): Promise<FirmCoverage[]> {
  const db = await getDb();

  const [topFirmRows, contactRows] = await Promise.all([
    db.query.userTopFirms.findMany({
      where: eq(userTopFirms.userId, userId),
      with: { firm: true },
    }),
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      columns: { firm: true, relationshipStatus: true, firmRecruitingContactId: true },
    }),
  ]);

  if (topFirmRows.length === 0) return [];

  // Bucket the student's contacts by normalised firm once, rather than
  // re-scanning the whole contact list for every top firm.
  type Bucket = { personal: number; engaged: number; directory: number };
  const byFirm = new Map<string, Bucket>();

  for (const c of contactRows) {
    if (!c.firm) continue;
    const key = normalizeFirmName(c.firm);
    if (!key) continue;

    const bucket = byFirm.get(key) ?? { personal: 0, engaged: 0, directory: 0 };
    if (c.firmRecruitingContactId) {
      bucket.directory++;
    } else {
      bucket.personal++;
      if (c.relationshipStatus !== "not_contacted") bucket.engaged++;
    }
    byFirm.set(key, bucket);
  }

  return topFirmRows
    .map(({ firm }) => {
      const bucket = byFirm.get(normalizeFirmName(firm.name));
      return {
        firmId: firm.id,
        firmName: firm.name,
        firmSlug: firm.slug,
        firmWebsite: firm.website,
        personalCount: bucket?.personal ?? 0,
        engagedCount: bucket?.engaged ?? 0,
        directoryCount: bucket?.directory ?? 0,
      };
    })
    .sort(
      (a, b) =>
        coverageRank(a) - coverageRank(b) ||
        a.engagedCount - b.engagedCount ||
        a.personalCount - b.personalCount ||
        a.firmName.localeCompare(b.firmName),
    );
}
