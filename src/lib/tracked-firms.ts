import "server-only";
import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { firms, userTopFirms } from "@/db/schema";

/**
 * The firms on this student's list, with every alias each goes by - the one
 * list every firm-name match resolves against (the prompts, the bell, the
 * tracker), so none of them can count a different set of people or rows.
 *
 * Its own module so anything can ask without importing the prompt machinery.
 */
export async function trackedFirmNames(userId: string): Promise<{ name: string; aliases: string[] }[]> {
  const db = await getDb();
  const rows = await db
    .select({ name: firms.name, aliases: firms.aliases })
    .from(userTopFirms)
    .innerJoin(firms, eq(firms.id, userTopFirms.firmId))
    .where(eq(userTopFirms.userId, userId));
  return rows.map((r) => ({ name: r.name, aliases: r.aliases ?? [] }));
}
