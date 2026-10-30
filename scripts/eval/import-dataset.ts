/**
 * Builds an evaluation manifest from a public dataset's metadata file that is
 * ALREADY on this machine. It never downloads anything: get the dataset from
 * its official source yourself, accept its terms, then point this at the file.
 *
 *   npm run eval:video-import -- --dataset librispeech --input <dir>/test-clean/1089/134686/1089-134686.trans.txt \
 *       --partition test-clean --chapter-dir test-clean/1089/134686 --out local-data/eval/librispeech/manifest.json
 *
 * See docs/VIDEO_INTERVIEW_EVALUATION.md for every dataset's arguments.
 * Output defaults to local-data/eval/ (gitignored). Media paths in the
 * manifest are relative to the manifest file, so put it at the dataset root.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { fromCommonVoice, fromCommonVoiceSpontaneous, fromEarnings21, fromLibriSpeech } from "../../src/lib/video-interview/eval/adapters";
import { validateManifest, type ManifestItem } from "../../src/lib/video-interview/eval/manifest";

const args: Record<string, string | true> = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, "");
  const v = argv[i + 1];
  if (v !== undefined && !v.startsWith("--")) {
    args[k] = v;
    i++;
  }
  else args[k] = true;
}
const need = (k: string) => {
  if (typeof args[k] !== "string") {
    console.error(`missing --${k}`);
    process.exit(2);
  }
  return args[k] as string;
};

const dataset = need("dataset");
const input = readFileSync(need("input"), "utf8");
const limit = typeof args.limit === "string" ? Number(args.limit) : undefined;
const allowTraining = args["allow-training"] === true;
const includeDatasetAccent = args["include-dataset-accent"] === true;

let items: ManifestItem[];
switch (dataset) {
  case "common-voice":
    items = fromCommonVoice(input, { split: need("split") as "test" | "dev" | "train", clipsDir: need("clips-dir"), includeDatasetAccent, allowTraining, limit });
    break;
  case "common-voice-spontaneous":
    items = fromCommonVoiceSpontaneous(input, { audioDir: need("audio-dir"), includeDatasetAccent, allowTraining, limit });
    break;
  case "librispeech":
    items = fromLibriSpeech(input, { partition: need("partition"), chapterDir: need("chapter-dir"), allowTraining, limit });
    break;
  case "earnings21":
    // The repository LICENSE covers transcripts and alignments. The AUDIO's
    // licence for this release must be confirmed and supplied explicitly.
    try {
      items = [
        fromEarnings21(input, {
          fileId: need("file-id"),
          mediaPath: need("media"),
          audio:
            typeof args.release === "string" && typeof args["audio-license"] === "string" && typeof args["audio-license-source"] === "string"
              ? {
                  release: args.release,
                  audioLicense: args["audio-license"],
                  audioLicenseSource: args["audio-license-source"],
                  transcriptLicense: typeof args["transcript-license"] === "string" ? args["transcript-license"] : undefined,
                }
              : null,
        }),
      ];
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      console.error("Pass --release <tag|commit> --audio-license <licence> --audio-license-source <url|file> (and optionally --transcript-license).");
      process.exit(1);
    }
    break;
  default:
    console.error("--dataset must be common-voice, common-voice-spontaneous, librispeech or earnings21");
    process.exit(2);
}

// A release recorded for any dataset, when given.
if (typeof args.release === "string") for (const i of items) i.source.version ??= args.release;

const manifest = { manifestVersion: 1, name: `${dataset}-${new Date().toISOString().slice(0, 10)}`, description: `Imported from local ${dataset} metadata`, items };
const check = validateManifest(manifest);
if (!check.ok) {
  console.error(`The imported manifest did not validate:\n  - ${check.errors.slice(0, 20).join("\n  - ")}`);
  process.exit(1);
}
const out = path.resolve(String(args.out ?? `local-data/eval/${dataset}-manifest.json`));
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(manifest, null, 2));
const training = items.filter((i) => i.permittedUse !== "evaluation").length;
console.log(`[import] ${items.length} item(s) -> ${path.relative(process.cwd(), out)} (${training} marked for possible training; the rest evaluation-only)`);
