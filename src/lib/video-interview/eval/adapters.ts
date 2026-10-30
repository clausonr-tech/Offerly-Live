import type { ManifestItem } from "./manifest";

/**
 * Import adapters: turn a public dataset's own metadata files - ALREADY on
 * disk, downloaded by a person who accepted the dataset's terms - into
 * manifest items. Nothing here downloads anything, and nothing is written
 * anywhere; the import script writes the manifest.
 *
 * All three are speech datasets, not interview answers, so they produce
 * ASR-only items (tasks ["asr"]); grading needs Offerly's own reviewed
 * fixtures.
 *
 * Partitions stay separate: official test/dev partitions are always
 * permittedUse "evaluation", Earnings-21 is always "evaluation" (held out as
 * the finance benchmark), and a training partition is "evaluation" too unless
 * the caller explicitly allows training. Columns about the speaker (Common
 * Voice's age and gender) are never read; an accent is copied only as the
 * dataset reported it, and only when the caller asks for it.
 */

const DATASET_LICENSES = {
  commonVoice: {
    dataset: "common-voice",
    license: "CC0-1.0",
    consentBasis: "Mozilla Common Voice: contributors recorded and released clips under CC0. Used under its terms; no attempt is made to identify speakers.",
    attribution: "Mozilla Common Voice (commonvoice.mozilla.org). Attribution is not required by CC0 but is given.",
  },
  commonVoiceSpontaneous: {
    dataset: "common-voice-spontaneous",
    license: "CC0-1.0",
    consentBasis: "Mozilla Common Voice Spontaneous Speech: contributor answers to prompts released under CC0 (verify against the release notes). No attempt is made to identify speakers.",
    attribution: "Mozilla Common Voice Spontaneous Speech (commonvoice.mozilla.org).",
  },
  libriSpeech: {
    dataset: "librispeech",
    license: "CC-BY-4.0",
    consentBasis: "LibriSpeech (OpenSLR SLR12): public-domain LibriVox audiobooks, corpus released under CC BY 4.0.",
    attribution: "V. Panayotov, G. Chen, D. Povey, S. Khudanpur. LibriSpeech: an ASR corpus based on public domain audio books. ICASSP 2015. https://www.openslr.org/12",
  },
  earnings21: {
    dataset: "earnings21",
    // Deliberately no default licence: the repository's LICENSE file covers
    // the transcripts and alignment text, not necessarily the call audio.
    // The importer requires the audio's licence, for the release in hand.
    license: "",
    consentBasis: "",
    attribution: "M. Del Rio et al. Earnings-21: A Practical Benchmark for ASR in the Wild. Interspeech 2021. https://github.com/revdotcom/speech-datasets",
  },
} as const;

type License = { dataset: string; license: string; consentBasis: string; attribution: string };

const idPart = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

function lengthBucket(text: string): "short" | "medium" | "long" {
  const words = text.trim().split(/\s+/).length;
  return words < 20 ? "short" : words < 80 ? "medium" : "long";
}

function asrItem(input: {
  lic: License;
  id: string;
  split: string | null;
  originalId: string;
  mediaPath: string;
  reference: string;
  durationSec: number | null;
  audio: ManifestItem["slices"]["audio"];
  accent: string | null;
  permittedUse: ManifestItem["permittedUse"];
  annotations?: ManifestItem["annotations"];
  version?: string | null;
  licenseSource?: string | null;
}): ManifestItem {
  return {
    id: input.id,
    source: {
      dataset: input.lic.dataset,
      split: input.split,
      originalId: input.originalId,
      attribution: input.lic.attribution,
      version: input.version ?? null,
      licenseSource: input.licenseSource ?? null,
    },
    license: input.lic.license,
    consentBasis: input.lic.consentBasis,
    permittedUse: input.permittedUse,
    tasks: ["asr"],
    mediaPath: input.mediaPath,
    durationSec: input.durationSec,
    referenceTranscript: input.reference,
    // None of these datasets' transcripts reliably keep fillers.
    verbatimFillers: false,
    question: null,
    expected: null,
    reviews: null,
    adjudicated: null,
    slices: {
      audio: input.audio,
      accent: input.accent,
      accentSource: input.accent ? "dataset" : "none",
      speakingSpeed: "unknown",
      answerLength: lengthBucket(input.reference),
    },
    annotations: input.annotations ?? null,
  };
}

/** Evaluation-only unless it is a training partition AND training was allowed. */
function usePolicy(split: string | null, isTrainingSplit: boolean, allowTraining: boolean): ManifestItem["permittedUse"] {
  return isTrainingSplit && allowTraining && split !== null ? "both" : "evaluation";
}

function parseTsv(text: string): Record<string, string>[] {
  const [head, ...rows] = text.replace(/\r/g, "").split("\n").filter((l) => l.length);
  const cols = head.split("\t");
  return rows.map((r) => {
    const v = r.split("\t");
    return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? ""]));
  });
}

/**
 * Mozilla Common Voice: one of test.tsv / dev.tsv / train.tsv (use those, not
 * validated.tsv, which overlaps the test partition). `split` is which file.
 * Reads only path, sentence and - with includeDatasetAccent - accents.
 */
export function fromCommonVoice(tsv: string, opts: { split: "test" | "dev" | "train"; clipsDir: string; includeDatasetAccent?: boolean; allowTraining?: boolean; limit?: number }): ManifestItem[] {
  const lic = DATASET_LICENSES.commonVoice;
  return parseTsv(tsv)
    .filter((r) => r.path && r.sentence)
    .slice(0, opts.limit ?? Infinity)
    .map((r) =>
      asrItem({
        lic,
        id: `cv.${opts.split}.${idPart(r.path.replace(/\.[a-z0-9]+$/i, ""))}`,
        split: opts.split,
        originalId: r.path,
        mediaPath: `${opts.clipsDir.replace(/\/+$/, "")}/${r.path}`,
        reference: r.sentence,
        durationSec: null,
        audio: "unknown",
        accent: opts.includeDatasetAccent && r.accents ? r.accents : null,
        permittedUse: usePolicy(opts.split, opts.split === "train", Boolean(opts.allowTraining)),
      }),
    );
}

/**
 * Common Voice Spontaneous Speech. Its column names have changed between
 * releases, so they are parameters - check them against the release's README
 * before importing. Speaker columns are never read.
 */
export function fromCommonVoiceSpontaneous(
  tsv: string,
  opts: {
    audioDir: string;
    columns?: { id?: string; audio?: string; transcript?: string; split?: string; durationMs?: string; accent?: string };
    includeDatasetAccent?: boolean;
    allowTraining?: boolean;
    limit?: number;
  },
): ManifestItem[] {
  const c = { id: "audio_id", audio: "audio_file", transcript: "transcription", split: "split", durationMs: "duration_ms", accent: "accent", ...opts.columns };
  const lic = DATASET_LICENSES.commonVoiceSpontaneous;
  return parseTsv(tsv)
    .filter((r) => r[c.audio] && r[c.transcript]?.trim())
    .slice(0, opts.limit ?? Infinity)
    .map((r) => {
      const split = r[c.split] || null;
      const ms = Number(r[c.durationMs]);
      return asrItem({
        lic,
        id: `cvss.${idPart(split ?? "nosplit")}.${idPart(r[c.id] || r[c.audio])}`,
        split,
        originalId: r[c.id] || r[c.audio],
        mediaPath: `${opts.audioDir.replace(/\/+$/, "")}/${r[c.audio]}`,
        reference: r[c.transcript].trim(),
        durationSec: Number.isFinite(ms) && ms > 0 ? ms / 1000 : null,
        audio: "unknown",
        accent: opts.includeDatasetAccent && r[c.accent] ? r[c.accent] : null,
        permittedUse: usePolicy(split, split === "train", Boolean(opts.allowTraining)),
      });
    });
}

/**
 * LibriSpeech: one chapter's `<speaker>-<chapter>.trans.txt`, with the
 * official partition it came from ("test-clean", "dev-other",
 * "train-clean-100"). `chapterDir` is that chapter's folder, relative to the
 * manifest.
 */
export function fromLibriSpeech(transTxt: string, opts: { partition: string; chapterDir: string; allowTraining?: boolean; limit?: number }): ManifestItem[] {
  const lic = DATASET_LICENSES.libriSpeech;
  const audio: ManifestItem["slices"]["audio"] = /clean/.test(opts.partition) ? "clean" : /other/.test(opts.partition) ? "challenging" : "unknown";
  return transTxt
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, opts.limit ?? Infinity)
    .map((line) => {
      const space = line.indexOf(" ");
      const uttId = line.slice(0, space);
      return asrItem({
        lic,
        id: `ls.${idPart(opts.partition)}.${idPart(uttId)}`,
        split: opts.partition,
        originalId: uttId,
        mediaPath: `${opts.chapterDir.replace(/\/+$/, "")}/${uttId}.flac`,
        reference: line.slice(space + 1).toLowerCase(),
        durationSec: null,
        audio,
        accent: null,
        permittedUse: usePolicy(opts.partition, opts.partition.startsWith("train"), Boolean(opts.allowTraining)),
      });
    });
}

/**
 * Earnings-21: one call's `.nlp` reference (pipe-separated: token | speaker |
 * ts | endTs | punctuation | case | tags | wer_tags). Entity tags become the
 * named-entity annotations; CARDINAL / MONEY / PERCENT tagged tokens become
 * number annotations. ALWAYS evaluation-only - it is the held-out finance
 * benchmark. Whole calls run for tens of minutes; estimate before a live run.
 */
export type Earnings21AudioLicense = {
  /** The dataset release the files came from - a tag, commit or date. */
  release: string;
  /** The licence that covers the AUDIO for that release, as confirmed. */
  audioLicense: string;
  /** Where that was confirmed: a URL, a file path, or a written permission. */
  audioLicenseSource: string;
  /** The transcripts' licence, per the repository LICENSE, for the record. */
  transcriptLicense?: string;
};

export class LicenseConfirmationRequired extends Error {
  constructor(what: string) {
    super(`Earnings-21 import refused: ${what}. Confirm the audio licence for the specific release (the repository LICENSE covers transcripts and alignments) and pass it explicitly.`);
    this.name = "LicenseConfirmationRequired";
  }
}

export function fromEarnings21(nlp: string, opts: { fileId: string; mediaPath: string; audio: Earnings21AudioLicense | null | undefined }): ManifestItem {
  const a = opts.audio;
  if (!a) throw new LicenseConfirmationRequired("no audio licence confirmation was supplied");
  for (const [k, v] of Object.entries({ release: a.release, audioLicense: a.audioLicense, audioLicenseSource: a.audioLicenseSource })) {
    if (typeof v !== "string" || !v.trim()) throw new LicenseConfirmationRequired(`${k} is missing`);
  }
  const lic: License = {
    ...DATASET_LICENSES.earnings21,
    license: a.audioLicense.trim(),
    consentBasis:
      `Audio: ${a.audioLicense.trim()}, confirmed at ${a.audioLicenseSource.trim()} for release ${a.release.trim()}. ` +
      `Transcripts: ${a.transcriptLicense?.trim() || "per the repository LICENSE (not verified here)"}. Held out: evaluation only.`,
  };
  const lines = nlp.replace(/\r/g, "").split("\n").filter(Boolean);
  const header = lines[0].split("|").map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const [ti, pi, tgi] = [col("token"), col("punctuation"), col("tags")];
  const words: string[] = [];
  const entities = new Map<string, { label: string; tokens: string[] }>();
  for (const line of lines.slice(1)) {
    const f = line.split("|");
    const token = f[ti]?.trim();
    if (!token) continue;
    words.push(token + (f[pi]?.trim() ?? ""));
    for (const m of (f[tgi] ?? "").matchAll(/(\d+):([A-Z_]+)/g)) {
      const key = `${m[1]}:${m[2]}`;
      const e = entities.get(key) ?? { label: m[2], tokens: [] };
      e.tokens.push(token);
      entities.set(key, e);
    }
  }
  const all = [...entities.values()];
  const numeric = new Set(["CARDINAL", "MONEY", "PERCENT", "ORDINAL", "QUANTITY", "DATE", "YEAR"]);
  return asrItem({
    lic,
    id: `e21.${idPart(opts.fileId)}`,
    split: "test",
    originalId: opts.fileId,
    mediaPath: opts.mediaPath,
    reference: words.join(" "),
    durationSec: null,
    audio: "unknown",
    accent: null,
    permittedUse: "evaluation",
    version: a.release.trim(),
    licenseSource: a.audioLicenseSource.trim(),
    annotations: {
      namedEntities: all.filter((e) => !numeric.has(e.label)).map((e) => e.tokens.join(" ")),
      numbers: all.filter((e) => numeric.has(e.label)).map((e) => e.tokens.join(" ")),
      financeTerms: [],
    },
  });
}
