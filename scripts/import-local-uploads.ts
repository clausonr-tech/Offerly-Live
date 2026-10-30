/**
 * One-off: copies files uploaded before stored_files existed from this
 * machine's local-data/uploads into the database, so the accounts that point
 * at them keep their resume, photo or post image everywhere (lib/file-store).
 *
 * Each developer who uploaded files locally runs it once on their own machine
 * - the files only ever existed there. Keys are kept exactly, since that is
 * what users.resume_storage_path and the other columns already hold.
 *
 * Safe to re-run: a key already in stored_files is left alone, never
 * overwritten. Without --apply it only reports what it would copy.
 *
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/import-local-uploads.ts [dir] [--apply]
 *
 * [dir] defaults to ./local-data/uploads.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { storedFiles } from "../src/db/schema";
import { MAX_FILE_BYTES, putStoredFile, type FileKind } from "../src/lib/file-store";
import { resumeContentType } from "../src/lib/resume-storage";
import { contentTypeFor } from "../src/lib/post-image-storage";

const FOLDERS: { folder: string; kind: FileKind; key: RegExp; type: (key: string) => string | null }[] = [
  { folder: "resumes", kind: "resume", key: /^[0-9a-f-]{36}\.[a-z]+$/i, type: resumeContentType },
  { folder: "avatars", kind: "avatar", key: /^[0-9a-f-]{36}\.jpg$/i, type: () => "image/jpeg" },
  { folder: "post-images", kind: "post-image", key: /^[0-9a-f-]{36}\.(jpg|png)$/i, type: contentTypeFor },
];

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const root = path.resolve(args.find((a) => !a.startsWith("--")) ?? "local-data/uploads");
  const db = await getDb();

  let copied = 0;
  let present = 0;
  let skipped = 0;
  for (const { folder, kind, key: pattern, type } of FOLDERS) {
    const dir = path.join(root, folder);
    if (!existsSync(dir)) continue;
    for (const key of readdirSync(dir)) {
      const file = path.join(dir, key);
      if (!statSync(file).isFile()) continue;
      const contentType = type(key);
      if (!pattern.test(key) || !contentType) {
        console.log(`skip   ${kind} ${key} - not a key the app generates`);
        skipped++;
        continue;
      }
      const bytes = readFileSync(file);
      if (bytes.length > MAX_FILE_BYTES) {
        console.log(`skip   ${kind} ${key} - ${bytes.length} bytes, over the 4MB cap`);
        skipped++;
        continue;
      }
      const [existing] = await db
        .select({ key: storedFiles.key })
        .from(storedFiles)
        .where(and(eq(storedFiles.kind, kind), eq(storedFiles.key, key)))
        .limit(1);
      if (existing) {
        console.log(`exists ${kind} ${key}`);
        present++;
        continue;
      }
      if (apply) await putStoredFile(kind, key, contentType, bytes);
      console.log(`${apply ? "copied" : "would copy"} ${kind} ${key} (${bytes.length} bytes)`);
      copied++;
    }
  }

  console.log(
    `\n${apply ? "Copied" : "Would copy"} ${copied}, already stored ${present}, skipped ${skipped}` +
      (apply ? "." : ". Nothing written - rerun with --apply."),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
