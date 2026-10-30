import "server-only";
import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { applications } from "@/db/schema";
import { trackedFirmNames } from "@/lib/tracked-firms";
import { firmResolver } from "@/lib/firm-name";
import { sameRole } from "@/lib/role-name";

/**
 * The student's existing tracker entry for this application, however either
 * was written: the same firm under any name it goes by ("J.P. Morgan",
 * "JPMorgan Chase", an alias in the firms table) and the same role in any
 * order or abbreviation, with a year or city left off one side ("IB Summer
 * Analyst", "2027 Summer Analyst, IB - New York"). One application is one row
 * - this is what every path that adds one asks first.
 */
export async function findSameApplication(
  userId: string,
  firm: string,
  role: string,
): Promise<{ id: string; status: string } | null> {
  const db = await getDb();
  const rows = await db.query.applications.findMany({
    where: eq(applications.userId, userId),
    columns: { id: true, firm: true, role: true, status: true },
  });
  // Firms through the student's own list and every alias each goes by (a
  // tracker row at "PJ Solomon" is at that firm), roles by sameRole.
  const resolve = firmResolver(await trackedFirmNames(userId));
  const f = resolve(firm);
  if (!f || !role.trim()) return null;
  return rows.find((a) => resolve(a.firm) === f && sameRole(a.role, role)) ?? null;
}
