// Lists firms + their programs and careers URLs, for the in-session crawl.
//   npx tsx --conditions=react-server scripts/list-firms.ts [offset] [limit]

import { openScriptDb } from "./_db";
async function main() {
  const offset = Number(process.argv[2] ?? 0);
  const limit = Number(process.argv[3] ?? 1000);
  const { db } = await openScriptDb();
  const firms = await db.query.firms.findMany({ with: { programs: true } });
  firms.sort((a, b) => a.name.localeCompare(b.name));
  const slice = firms.slice(offset, offset + limit);
  for (const [i, f] of slice.entries()) {
    console.log(`${offset + i}\t${f.name}\t${f.website}`);
    for (const p of f.programs) console.log(`\t${p.category}\t${p.roleLabel}\t${p.careersUrl}`);
  }
  console.log(`\n(${firms.length} firms total)`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
