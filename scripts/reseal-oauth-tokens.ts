// Re-seal stored Google OAuth tokens to the current best key.
//
// Walks email_connections and, for any token not already sealed with the
// target key, opens it and re-seals it. Migrates:
//   - plain tokens written before sealing      -> sealed
//   - t1 tokens (EMAIL_ARCHIVE_KEY-derived)     -> t2 (OAUTH_TOKEN_KEY), when that key is set
//
// Idempotent: a token already at the target version is left untouched. It never
// deletes a row and touches only the two token columns.
//
// Run it AFTER setting the keys, against the target database. To migrate t1 -> t2
// both keys must be present (EMAIL_ARCHIVE_KEY opens the old seal, OAUTH_TOKEN_KEY
// writes the new one):
//
//   OAUTH_TOKEN_KEY=... EMAIL_ARCHIVE_KEY=... DATABASE_URL=... DATABASE_CA_CERT=... \
//     npx tsx --conditions=react-server scripts/reseal-oauth-tokens.ts [--apply]
//
// Without --apply it reports what it would change and writes nothing. If run
// against the local PGlite database, stop the dev server first (single writer).
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { emailConnections } from "@/db/schema";
import { isSealed, openToken, sealToken } from "@/lib/token-crypto";

async function main() {
  const apply = process.argv.includes("--apply");

  // The version new writes use right now: "t2." when OAUTH_TOKEN_KEY is set,
  // else "t1.". If neither key is set there is nothing to seal with.
  const probe = sealToken("probe");
  if (!isSealed(probe)) {
    console.error("No OAUTH_TOKEN_KEY or EMAIL_ARCHIVE_KEY is set; there is no key to seal with. Aborting.");
    process.exit(1);
  }
  const target = probe.slice(0, 3);
  console.log(`Target seal version: ${target.replace(".", "")}${apply ? "" : "   (dry run - pass --apply to write)"}`);

  const db = await getDb();
  const rows = await db.query.emailConnections.findMany({
    columns: { id: true, accessToken: true, refreshToken: true },
  });

  let migrated = 0;
  let current = 0;
  let failed = 0;
  for (const r of rows) {
    const aNeeds = r.accessToken != null && !r.accessToken.startsWith(target);
    const rNeeds = r.refreshToken != null && !r.refreshToken.startsWith(target);
    if (!aNeeds && !rNeeds) {
      current++;
      continue;
    }
    try {
      const nextAccess = aNeeds ? sealToken(openToken(r.accessToken!)) : r.accessToken;
      const nextRefresh = rNeeds ? sealToken(openToken(r.refreshToken!)) : r.refreshToken;
      if (apply) {
        await db
          .update(emailConnections)
          .set({ accessToken: nextAccess, refreshToken: nextRefresh })
          .where(eq(emailConnections.id, r.id));
      }
      migrated++;
    } catch (e) {
      failed++;
      console.error(`  connection ${r.id}: could not re-seal (${(e as Error).message}). Is the key that originally sealed it set?`);
    }
  }

  console.log(`${apply ? "Re-sealed" : "Would re-seal"} ${migrated}, left ${current} already current, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
