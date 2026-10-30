// Does DATABASE_URL point at a database that answers?
//
// Prints the host and port so a wrong endpoint is obvious, and never the
// user or the password.
import { createPostgresClient } from "../src/db/connection";

async function main() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.log("DATABASE_URL is not set.");
    process.exit(1);
  }
  if (/<ref>|<password>|<host>|\[YOUR-PASSWORD\]|YOUR-PASSWORD/.test(raw)) {
    console.log("DATABASE_URL still contains the PLACEHOLDER text - it has not been replaced yet.");
    console.log("Look for <ref>, <host> or [YOUR-PASSWORD] in the line and swap in the real values.");
    process.exit(1);
  }

  let where = "unparseable";
  try {
    const u = new URL(raw);
    where = `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    console.log("DATABASE_URL is not a valid URI. Check for stray quotes, spaces or line breaks.");
    process.exit(1);
  }
  console.log("target:", where);

  /**
   * Shape checks, not value dumps.
   *
   * Supabase's shared pooler authenticates as `postgres.<project-ref>`. A bare
   * `postgres` means the username lost its ref - either it was edited, or an
   * unencoded character earlier in the string made the parser read it wrong.
   */
  try {
    const u = new URL(raw);
    const user = decodeURIComponent(u.username);
    console.log("username:", user.includes(".") ? `postgres.<ref present, ${user.split(".")[1]?.length} chars>` : `"${user}"  <- NO PROJECT REF`);

    const pw = u.password;
    const risky = [..."@:/?#[]% "].filter((ch) => pw.includes(ch));
    console.log("password:", `${pw.length} chars`,
      risky.length ? `- contains ${risky.map((c) => (c === " " ? "<space>" : c)).join(" ")} which MUST be percent-encoded` : "- no characters needing encoding");
    if (/\[|\]/.test(pw)) console.log("  -> looks like the [ ] brackets were left in around the password.");
  } catch {}

  const sql = createPostgresClient(raw, { pooling: "as-configured", max: 1, connectTimeout: 15, onnotice: () => {} }).sql;
  try {
    const r = await sql`select version() as v, current_database() as db, current_setting('TimeZone') as tz`;
    console.log("CONNECTED");
    console.log("  server  :", String(r[0].v).split(" ").slice(0, 2).join(" "));
    console.log("  database:", r[0].db);
    console.log("  timezone:", r[0].tz);
    const t = await sql`select count(*)::int as n from information_schema.tables where table_schema='public'`;
    console.log("  tables in public schema:", t[0].n);
  } catch (e: any) {
    console.log("FAILED:", e.message);
    if (/ENOTFOUND|EAI_AGAIN/.test(e.message)) console.log("  -> the host does not resolve; check you copied the whole string.");
    if (/ENETUNREACH|EHOSTUNREACH/.test(e.message)) console.log("  -> unreachable: this is the IPv6 problem. Use the Session pooler URI, not Direct connection.");
    if (/password|authentication/i.test(e.message)) console.log("  -> the password is wrong, or has characters needing percent-encoding.");
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
main();
