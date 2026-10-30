# Video interview evaluation

An evaluation-first framework for the video interview coach. The goal is to
measure how good the transcripts and grades are **before** any model is
trained or fine-tuned. Nothing here trains a model, downloads a dataset, or
touches Offerly's database.

## What is measured, and why separately

| Stage | Input → output | Question it answers |
|---|---|---|
| `asr` | recording → transcript (Groq, via the production transcriber) | Are the words right? |
| `grader` | **verified reference transcript** → Claude grading | Is the grading right, given perfect words? |
| `end-to-end` | recording → transcript → grading | How much do transcription mistakes change the grade? |

Evaluating the grader on reference transcripts separates "the grader is
wrong" from "the transcript was wrong". End-to-end then reports the
difference (ASR minus reference) directly.

Every report keeps four accuracies apart, in this order:

1. **Transcript accuracy:** WER, numbers, currency, terms, fillers-as-heard.
2. **Delivery-signal accuracy:** pace, pauses, fillers, repeated phrases and
   disfluencies as Offerly *measures* them, against human annotation, and
   the pace/pauses and filler scores that result.
3. **Claude grading accuracy:** grading on the verified transcript.
4. **End-to-end grade accuracy:** grading on the ASR transcript, and the
   difference from section 3.

**It is the production code, not a copy.** The evaluator calls:

- the production transcriber class (`OpenAICompatibleTranscriber`, configured
  from the same `TRANSCRIPTION_*` variables)
- `computeDeliveryMetrics`
- `gradeSpokenAnswerDetailed`, which runs the same prompt builder
  (`buildGradingPrompt`), strict parser (`parseGradingOutput`), score
  combination (`combineGrading`) and weights as the app
- the same Claude request (`gradingRequest`) and model routing
  (`getModelConfig` plus the fallback chain)

Only the model **call** differs. The app sends it through `runAiFeature`, on
the student's quota. The evaluator makes the same request itself, on no one's
account or quota, walking the production fallback chain (`getModelConfig`,
`attemptConfig`, `nextFallbackModel`) with the SDK's retries switched off, so
that every request is counted. See *The request limit* below.

**Public ASR datasets are not evidence about grading.** LibriSpeech, Common
Voice and Earnings-21 measure transcription only. They are read speech or
earnings calls, not interview answers, and have no human grades. Whether
Claude grades interviews well can only be measured on Offerly's own
consented, blindly reviewed interview fixtures, in `grader` and `end-to-end`
modes.

## Files

| File | Role |
|---|---|
| `src/lib/video-interview/eval/manifest.ts` | Manifest schema and validation, held-out rules, `trainingEligible` |
| `src/lib/video-interview/eval/text-metrics.ts` | Normalisation, WER (S/I/D), numbers, currency, term recall |
| `src/lib/video-interview/eval/grader-metrics.ts` | MAE, Spearman, macro F1, P/R/F1, STAR, repeatability, human agreement |
| `src/lib/video-interview/eval/runner.ts` | The three stages, estimates, dry-run stubs |
| `src/lib/video-interview/eval/live.ts` | Quota-free Claude call, report versioning, Markdown |
| `src/lib/video-interview/eval/adapters.ts` | Common Voice, Common Voice Spontaneous Speech, LibriSpeech, Earnings-21 |
| `scripts/eval/video-interview-eval.ts` | The CLI (`npm run eval:video`) |
| `scripts/eval/import-dataset.ts` | Manifest import from local dataset files (`npm run eval:video-import`) |
| `scripts/eval/fixtures/synthetic-manifest.json` | Six tiny generated text fixtures (no audio, no real people) |

## The manifest

This is a JSON file: `{ "manifestVersion": 1, "name": "...", "items": [...] }`.
Every item has the following fields, and unknown fields are rejected:

| Field | Notes |
|---|---|
| `id` | Stable, lowercase: `ls.test-clean.1089-134686-0000` |
| `source` | `{ dataset, split, originalId, attribution, version, licenseSource }` |
| `license`, `consentBasis` | **Required.** Why we may use it |
| `permittedUse` | **Required.** `evaluation`, `training` or `both` |
| `tasks` | `["asr"]`, `["grader"]` or both |
| `mediaPath` | Relative to the manifest; must stay inside its directory. Required for a live ASR run |
| `verbatimFillers` | **Required.** `true` only if the reference was transcribed verbatim, fillers included |
| `durationSec` | Required to grade (pace is scored) |
| `referenceTranscript` | Verified by a person |
| `question` | `{ prompt, kind, sector, specialty, topic, difficulty, expectedPoints }` |
| `expected` | `{ coveredPoints (1-based into expectedPoints), factualErrors, star }` |
| `reviews` | **At least two** blind reviews by different reviewers: `{ reviewer: "R1", blind: true, scores, classification }` |
| `adjudicated` | `{ scores, classification, method }` |
| `slices` | `{ audio, accent, accentSource, speakingSpeed, answerLength }` |
| `delivery` | Optional human-verified delivery ground truth (see *Delivery-signal accuracy*) |
| `annotations` | `{ financeTerms, namedEntities, numbers }`, optional |

`scores` holds all eight rubric dimensions (`grammarClarity`, `pacePauses`,
`fillers`, `structure`, `relevance`, `completeness`, `logic`, `concision`)
plus `overall`, each from 0 to 100. The classification bands are strong ≥ 75
and average ≥ 50 (`CLASSIFICATION_BANDS`).

`question`, `expected`, `reviews` and `adjudicated` may be `null` on ASR-only
items. Grader items must have them.

### Rules the validator enforces

- **Licence, consent basis and permitted use are required.** An entry
  without them is rejected, and so is an empty licence.
- **No protected characteristics.** The schema has no field for gender, age,
  ethnicity, race, religion, disability and the like. Any such key, anywhere
  in an item, is rejected.
  - An accent may be recorded only as the **dataset** supplied it
    (`accentSource: "dataset"`). Never infer anything about a person from a
    recording.
- **Held-out data is evaluation-only.** Earnings-21 always is, and so is any
  item from a `test`, `dev` or `validation` partition (`test-clean`,
  `dev-other`, …). Marking one for training is an error.
- **Grader fixtures need at least two blind reviews** (`blind: true`) from
  different reviewers. Each reviewer reviews an item once, and reviewers are
  identified by pseudonymous codes (`R1`), never names.
- **Earnings-21 items must record the release** (`source.version`) **and
  where the audio licence was confirmed** (`source.licenseSource`).

## Adding licensed local fixtures

1. Only use media you're allowed to use for evaluation: your own recordings
   with written consent, or a dataset under its licence. Record the reason
   in `consentBasis`.
2. Put the media **outside git**, e.g. `local-data/eval/<set>/`, which is
   gitignored. Never commit audio or video.
3. Write the manifest next to the media (relative `mediaPath`s), or import
   one (see *Datasets* below).
4. Check it with a dry run. Validation errors are listed all at once.

Offerly's own interview fixtures would need, per recording: written consent
covering evaluation (and training only if separately agreed), a
person-verified transcript, and two blind reviews. **Never copy a student's
interview from the app into a fixture.** App recordings are covered by the
student's training consent, not by an evaluation-fixture consent.

## Human review, blind

1. Two or more reviewers score each answer independently. Each sees the
   question, the expected points, the reference transcript and, ideally,
   the recording. They never see another reviewer's scores, or any model
   output.
2. They score all eight dimensions and the overall on 0–100, and assign
   strong / average / poor. They also mark which expected points were
   conveyed, any factual errors, and the STAR elements present (behavioral
   answers).
3. Reviewers work from a shared written rubric (the dimension definitions in
   `src/lib/video-interview/grading.ts`, `SHARED_RULES`). Calibrate on a few
   practice items that aren't in the evaluation set first.

## Adjudication

- Where reviewers agree within 10 points overall and on the class, the
  adjudicated score is their mean.
- Otherwise a third reviewer, or a discussion between the two, sets the
  adjudicated scores and class. The `method` field says which.
- `expected` (covered points, factual errors, STAR) is adjudicated the same
  way.
- The pre-adjudication `reviews` stay in the manifest: they're what measures
  human-to-human agreement.

**Why human agreement matters:** the grader can't be expected to agree with
the adjudicated score better than two humans agree with each other. Every
report prints the human-to-human MAE, Spearman, class agreement and Cohen's
kappa next to the grader's numbers. These are computed over **every pair** of
reviews of each item: three reviewers give three pairs, not only the first
two. Read a grader MAE of 8 against a reviewer MAE of 6, not against 0.

## Running

### A no-cost dry run (no network, no keys)

```bash
npm run eval:video -- --mode end-to-end
```

Without `--live`, the providers are local stubs: the "transcriber" echoes the
reference, and the "grader" returns each item's own expected judgement.
Every real step in between runs, including validation, delivery metrics, the
parser, score combination, the metrics and the report. That proves the
manifest and the pipeline work. The metrics themselves are meaningless, and
the report is marked **DRY RUN**.

### Estimate before spending

```bash
npm run eval:video -- --mode end-to-end --manifest local-data/eval/set/manifest.json --runs 3 --estimate
```

The estimate counts logical **cases**. A case is one transcription or one
grading:

| Mode | Transcription cases | Grading cases |
|---|---|---|
| `asr` | items × runs | 0 |
| `grader` | 0 | items × runs |
| `end-to-end` | items × runs | **2** × items × runs (reference and ASR transcript) |

Each case costs **at least one** provider request, and more when a request
is retried or falls back to another model. So the estimate's
`minimumRequests` is a floor, not a forecast. The estimate also prints audio
minutes: transcription is priced per minute and grading per request, so
check your provider's current prices.

### The request limit (`--max-calls`)

`--max-calls` is a hard limit on **actual provider requests**, enforced as
the run goes:

- Every transcription fetch, and every Claude attempt, retry and fallback,
  claims one request from the budget **before** it starts.
- A request that would exceed the limit is never sent. The run stops, and the
  case that was refused is discarded rather than scored as a failure.
- The report is then marked **STOPPED EARLY**, and its metrics cover only the
  completed cases.
- The evaluator's Claude calls run with SDK retries off (`maxRetries: 0`),
  so no request happens out of sight.
- A capacity error (rate limit, 5xx, connection) gets one explicit, counted
  retry on the same model, then falls back to the next production model,
  also counted.
- `--live` refuses to start unless `--max-calls` is at least
  `minimumRequests`.

Every live report records the requests: attempted, succeeded, failed,
retried, fallback and refused by the limit, in total and per provider. It
records these next to the planned and completed cases, so logical cases and
real HTTP requests are never confused.

### A small live baseline

```bash
npm run eval:video -- --mode grader --manifest <file> --live --max-items 10 --max-calls 15
```

- `--live` is required before anything leaves the machine.
- `--max-calls` caps real requests. Leave headroom above the minimum for
  retries and fallbacks.
- `--max-items` limits the run to the first *n* items.
- The keys come from the server environment (`TRANSCRIPTION_API_KEY`,
  `ANTHROPIC_API_KEY`) and are never printed. The report records the host
  and model only.
- `--plan pro` evaluates the paid tier's routing.
- A sensible first baseline: grader on 20–30 reviewed items with `--runs 3`
  (to measure repeatability), then ASR on a small held-out slice, then
  end-to-end on the items that have both.

### Output and privacy

- Reports go to `local-data/eval-reports/` (gitignored) as JSON and Markdown.
  `--out` can't point into `src/`, `public/`, `scripts/` or `drizzle/`.
- The console and reports contain **fixture ids and aggregate or per-item
  numbers only**: no transcripts, audio, names or keys.
- `--debug` adds per-case transcripts and feedback to the console and JSON,
  for inspecting cases locally. Never share a debug report.
- Nothing is written to Offerly's database.

## Metrics

**ASR:**

- normalised WER, as a corpus value (total errors / total reference words)
  and a mean per item, with substitution, insertion and deletion counts.
  Hesitations are removed first, as is conventional.
- **number precision, recall and F1**, comparing reference and hypothesis
  numbers as multisets. A missed number lowers recall. A wrong or invented
  number lowers precision, so a transcript that sprays extra digits is
  penalised, where recall alone would have rewarded it.
- **currency precision, recall and F1**, which works the same way, except
  the amount *and* the unit must match ("5 million dollars" is not matched
  by "5 million").
- **filler precision, recall and F1** (um, umm, uh, uhh, er, erm, ah, hmm,
  mm, mhm, grouped by variant). This is reported **only for fixtures with
  `verbatimFillers: true`**. Public dataset references omit fillers, so
  their imports are `false`, and no filler or stutter score is ever inferred
  for them.
- finance-term recall and named-entity recall, where annotated
- word-timestamp coverage and the share of items with timings
- empty and failed rates, and the WER spread across runs

None of these is labelled "accuracy" unless it really is one.

All of these are also grouped by dataset and by each slice. Accent groups
appear only where the dataset supplied an accent.

**How text is normalised:**

- lower case; `&` becomes "and", `%` becomes "percent", `$5` becomes
  "5 dollars"
- spelled-out numbers become digits ("twenty five million" becomes 25000000,
  "two point five" becomes 2.5); digit-plus-scale amounts fold the same way
- `Q3` and "q three" become the same token, as do `FY26` and "f y twenty six"
- punctuation is dropped
- hesitations (um, uh, er, ah, hmm) are dropped, as the datasets' reference
  transcripts omit them; filler counting is a separate delivery metric

**Delivery signals** (section 2) are covered in their own section below.

**Grader:**

- overall MAE and per-dimension MAE against the adjudicated scores
- Spearman rank correlation
- strong/average/poor macro F1 and accuracy
- expected-point precision, recall and F1 (micro-averaged sets)
- factual-error detection precision and recall. This is item-level, because
  a reviewer's wording and the model's differ: did the grader flag an answer
  that has errors?
- STAR precision, recall and F1 per element
- parse-failure, refusal, model-error and too-short rates. Items that
  weren't graded are excluded from MAE, and counted here instead.
- repeatability: per-item score standard deviation (mean and max) and the
  classification-flip rate across `--runs`
- human-to-human agreement

**End-to-end:**

- both sets of grader metrics
- the differences between them: MAE, Spearman, macro F1, expected-point F1
- each item's mean absolute score shift, and the share of items whose class
  changed

## Delivery-signal accuracy

**One definition, shared.** Production scores delivery with the exported
detectors in `src/lib/video-interview/delivery-metrics.ts`:

- `detectFillers`, `detectPauses`, `detectRepeatedPhrases` and
  `detectDisfluencies`
- `speakingSeconds` and `wordsPerMinute`
- `analyzeDelivery`, which returns the metrics *and* the individual events

`computeDeliveryMetrics` is `analyzeDelivery(...).metrics`. The evaluator
calls the same functions and scores with the same `deliveryScores`, so what
is evaluated is exactly what students are scored on.

**Filler definitions:**

- hesitations: um, uh, er, ah, hmm, mm, and their spellings
- "like", except as a verb ("I like", "would like", "looks like") or a
  comparison ("like a", "like how")
- "you know what I mean", "you know", "I mean", "kind of", "sort of".
  These are matched longest first, with no overlap.
- "basically", "literally" and "actually" when they open a clause: the first
  word, or straight after a hesitation

The ASR filler metric (section 1) uses the same spelling map
(`HESITATION_FAMILY`).

> The refactor fixed one production bug: "you know what I mean" used to also
> count the "I mean" inside it, so one filler scored as two. Everything else
> is unchanged; this was checked by running the old and new code side by
> side over a set of transcripts.

**Ground truth comes only from human annotation of the recording** (the
item's `delivery` block). It is never inferred from any model's transcript,
and each metric is computed only for items that carry the annotation it
needs:

| `delivery` field | What it's for |
|---|---|
| `verifiedBy` | `human`, or `synthetic` for the committed test fixtures only |
| `method` | How it was annotated (tool, number of annotators) |
| `speakingSec` or `wordsPerMinute` | WPM error, first word's onset to last word's offset |
| `pauses: [{startSec, endSec}]` | *Every* silent gap ≥ 1.5 s (the production threshold) |
| `fillers: [label, …]` | Every filler heard, one per occurrence, in production's labels (`FILLER_LABELS`) |
| `repeatedPhrases: [{phrase, count}]` | Phrases said three or more times |
| `disfluencies: [{type, text}]` | `repetition` ("I I") or `cutoff` ("th- the", "co company") |

**The validator rejects annotation mistakes:**

- a pause whose `startSec` isn't before its `endSec`, or that's shorter than
  1.5 s
- a pause outside the recording (before 0 or after `durationSec`)
- pauses out of time order, or overlapping (back-to-back is fine)
- a `speakingSec` longer than `durationSec`
- a `wordsPerMinute` that contradicts `speakingSec` and the verified
  transcript's word count by more than 15% (or 10 wpm, whichever is larger)
- the same phrase listed twice in `repeatedPhrases`. List it once, with its
  count.

Repeated events are **not** rejected: the same filler, or the same
disfluency ("I I" twice), can really occur many times, so one entry per
occurrence is correct.

**How each metric is matched:**

- **WPM:** mean absolute error, plus mean signed error (bias), against the
  annotation.
- **Pauses:** precision, recall and F1, plus the same for long pauses
  (≥ 3 s). A detected pause matches an annotated one when they overlap and
  both boundaries are within 0.5 s. The mean boundary error is reported too.
- **Missing timestamps:** an ASR transcript without word timestamps can't
  locate pauses, so its annotated pauses count as missed. The report counts
  such items separately (`itemsWithoutTimestamps`).
- **Fillers:** a multiset of labels, so a missed filler lowers recall and an
  invented one lowers precision, overall and per label.
- **Repeated phrases:** precision/recall/F1. A detected phrase matches when
  either phrase contains the other.
- **Disfluencies:** precision/recall/F1 overall and by type. An ASR that
  "tidies" a cut-off into a repeated word shows up as a missed cut-off *and*
  a spurious repetition. These counts are estimates, as in the product.
- **Score error:** the pace/pauses and filler scores that production's
  `deliveryScores` gives the measured signals, minus the scores the same
  function gives the annotated signals (MAE and bias). This is how much
  transcription and timestamp errors move the student's delivery scores.

**Two transcripts, reported side by side:**

- **On the verified transcript:** the detectors' own errors. The verified
  text has no word timings, so WPM, pauses and the pace/pauses score aren't
  measured here.
- **On the ASR transcript:** detector errors plus transcription and
  timestamp errors. Failed transcriptions are excluded and counted.

**With `--runs` greater than 1:**

- The ASR-transcript delivery metrics are computed **for every run**
  separately (`delivery.asrRuns`), alongside an aggregate pooled over all
  runs (`delivery.onAsrTranscript`).
- Each run's row gives WPM error, pause and long-pause F1, filler F1,
  repeated-phrase F1, repeated-word (repetition) F1, cut-off F1, overall
  disfluency F1, and the pace and filler score errors.
- `delivery.acrossRuns` gives each of those metrics' min, max, range and
  standard deviation across runs. A large spread means the transcriber is
  unstable.
- A failed transcription is excluded from, and listed under, the run it
  failed in.
- The verified-transcript column is computed **once**. It doesn't depend on
  the ASR run, so repeating it would only duplicate numbers.

Delivery evaluation makes no provider calls; it analyses text and timings
the run already has.

## Comparing models, prompts and versions

Every report records:

- transcription provider, host, model and response format
- Claude model per question kind, the plan, and the models that actually
  answered
- `GRADING_RUBRIC_VERSION`, and `gradingPromptHash()`, a hash over both
  system prompts, the user template, the output schema, the weights and the
  bands
- the code commit (and whether there were uncommitted changes)
- the manifest name and its SHA-256
- the timestamp and number of runs

Compare two reports only when the manifest hash matches and exactly one of
provider, model, prompt hash or rubric version differs. Change one thing at
a time.

**Bump `GRADING_RUBRIC_VERSION`** whenever you change the prompts, weights or
bands; the prompt hash changes on its own. A difference smaller than the
repeatability spread (score SD, flip rate) isn't a real difference: run
`--runs 3` or more.

## Why evaluation sets must never be used for training

A model trained on its test set memorises the answers, so its score stops
measuring anything, and every later comparison is contaminated with no way
to tell. So:

- Every fixture carries `permittedUse`.
- `trainingEligible()` is false unless an item explicitly permits training
  **and** isn't held out.
- Earnings-21 and every official test/dev partition are held out, whatever
  their entry says.
- Nothing in Offerly trains on fixtures today. Any future training export
  must filter through `trainingEligible()`, and must also keep out the
  source recordings behind evaluation items (same speaker and same prompt
  counts as leakage).

## Datasets

**Nothing downloads automatically.** Get each dataset from its official page,
accept its terms, keep it under `local-data/eval/`, and verify the licence
and the column names on the version you downloaded.

| Dataset | Licence (verify) | Attribution | How it's used |
|---|---|---|---|
| Mozilla Common Voice | CC0-1.0 | "Mozilla Common Voice", commonvoice.mozilla.org (not required, but given) | Read speech, accent slices only as the dataset reports them |
| Common Voice Spontaneous Speech | CC0-1.0 | Mozilla Common Voice Spontaneous Speech | Spontaneous answers to prompts, closest to interview speech |
| LibriSpeech (OpenSLR 12) | CC BY 4.0 | Panayotov, Chen, Povey, Khudanpur. *LibriSpeech: an ASR corpus based on public domain audio books.* ICASSP 2015 | Clean and "other" read speech baseline |
| Earnings-21 (Rev) | Transcripts and alignments: per the repository LICENSE (CC BY-SA 4.0 at the time of writing). **Audio: confirm separately, per release** | Del Rio et al. *Earnings-21: A Practical Benchmark for ASR in the Wild.* Interspeech 2021 | **Held-out finance evaluation only** |

**Earnings-21 audio licensing:** the repository's LICENSE file covers the
transcripts and associated alignment text. It does not by itself establish
the terms for the earnings-call **audio**. The importer therefore refuses to
import Earnings-21 media until you supply three things for the release you
downloaded:

- `--release`: a tag, commit or date
- `--audio-license`: the licence or permission that covers the audio
- `--audio-license-source`: where that was confirmed (a URL, a file, or a
  written permission)

The manifest records all three (`license`, `source.version`,
`source.licenseSource`), plus the transcript licence in `consentBasis`, and
the validator rejects Earnings-21 entries without them. Earnings-21 stays
evaluation-only whatever the licence says.

CC BY and CC BY-SA require attribution wherever results or derived material
are shared. Keep the citations above with any published numbers.
CC BY-SA's share-alike clause applies to adapted versions of the dataset
itself.

**Import commands:**

```bash
# Common Voice: use test.tsv / dev.tsv / train.tsv, never validated.tsv (it overlaps test).
npm run eval:video-import -- --dataset common-voice --input local-data/eval/cv/en/test.tsv \
  --split test --clips-dir clips --out local-data/eval/cv/en/manifest.json [--include-dataset-accent] [--limit 200]

# Common Voice Spontaneous Speech: check the column names in the release README first.
npm run eval:video-import -- --dataset common-voice-spontaneous --input local-data/eval/cvss/ss-corpus-en.tsv \
  --audio-dir audios --out local-data/eval/cvss/manifest.json

# LibriSpeech: one chapter's .trans.txt at a time, with its official partition.
npm run eval:video-import -- --dataset librispeech --input local-data/eval/LibriSpeech/test-clean/1089/134686/1089-134686.trans.txt \
  --partition test-clean --chapter-dir test-clean/1089/134686 --out local-data/eval/LibriSpeech/manifest.json

# Earnings-21: one call's .nlp reference and its (segmented) audio - refused without the audio licence confirmation.
npm run eval:video-import -- --dataset earnings21 --input local-data/eval/earnings21/transcripts/nlp_references/4320211.nlp \
  --file-id 4320211 --media media/4320211.mp3 --out local-data/eval/earnings21/manifest.json \
  --release <tag-or-commit> --audio-license "<licence covering the audio>" --audio-license-source "<url or file>" \
  [--transcript-license "CC BY-SA 4.0 (repository LICENSE)"]
```

**Partitions stay separate:** test and dev are always evaluation-only. A
training partition is too, unless `--allow-training` is passed, and even then
only that partition's items are eligible. The Common Voice adapter never
reads the `age`, `gender` or `client_id` columns.

**Limits:** OpenAI's and Groq's transcription endpoints accept up to 25 MB
per file, and the evaluator refuses larger media without sending anything.
Full Earnings-21 calls usually exceed that, so split each call into segments
under the limit, each with its own reference span, before running them live.
