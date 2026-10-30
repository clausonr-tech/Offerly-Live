# Video interview coach — setup

Interview Prep → **Video interview** runs a five-question, one-way video
interview with a robot interviewer. After each answer it produces a
transcript, measured delivery (pace, pauses, filler words, repetition,
estimated disfluencies) and graded content, then a final report.

## What it needs

| Piece | Required? | Configured by |
| --- | --- | --- |
| Database tables | Yes | Migrations `0029_video_interviews` through `0032_per_interview_training_consent` |
| Question bank rows | Yes | `npm run db:seed-interview-questions` |
| Speech-to-text | For transcripts and scores | `TRANSCRIPTION_*` env vars |
| AI grading | For content feedback | `ANTHROPIC_API_KEY` (already used by the app) |
| Private object storage | Only to keep training recordings | `VIDEO_STORAGE_*` env vars |

The page checks the database before anything else, and names what's wrong:

- **Migration missing:** development names whichever of `0029`, `0030` and
  `0031` is missing. Production
  shows a calm "temporarily unavailable" card with no database details.
- **Question bank empty:** development tells you to run the seed command.
- **Database unreachable:** reported as a connection problem, never as a
  missing migration.
- **No speech-to-text:** the coach runs, and says it can't transcribe or score.
  Students can still practise and watch their answers back on their device.
- **No object storage:** the coach runs, and says no training recording is
  kept, including to students who have training switched on.

## Before touching a database — confirm which one it is

`.env.local` currently points at a **remote Supabase pooler**. Both
`npm run db:migrate` and the seed script write to whatever `DATABASE_URL`
names. Before either:

1. **Read the host without the password.**

   ```bash
   node --env-file=.env.local -e 'const u=new URL(process.env.DATABASE_URL); console.log(u.username, "@", u.host)'
   ```

   On the Supabase pooler the username is `postgres.<project-ref>`, which is
   what identifies the project.

2. **Match that project ref** against the Supabase dashboard. Which project is it: development,
   staging or production? Shared with a cofounder?
3. **If it's production or shared:** schedule the change, tell the other
   people using that database, and take a backup or confirm point-in-time
   recovery first.
4. **To try things locally instead,** point at a local PGlite and leave
   `.env.local` alone:

   ```bash
   env DATABASE_URL= PGLITE_DATA_DIR=./local-data/pglite-demo npm run db:migrate
   ```

5. **Check the `[drizzle]` line** that `db:migrate` prints. It names the
   target. Stop if it isn't the one you meant.
6. **Order matters.** Apply `0029` through `0032` before deploying the code
   that reads them. All four only add tables and columns, and are
   re-runnable. Missing migrations are an expected state: the page shows its
   setup card and logs a warning, not an error.

## 1. Migrate

```bash
npm run db:migrate
```

## 2. Seed the question bank

The runtime source of truth is the `interview_questions` table. The authored
JSON in `src/lib/question-bank/data` is only the **seed input**; nothing in
the coach reads it at runtime. Its `expected_points` column (the answer key)
is read only by grading, on the server.

```bash
# Local PGlite (no DATABASE_URL):
env DATABASE_URL= PGLITE_DATA_DIR=./local-data/pglite-demo npm run db:seed-interview-questions

# A remote database: refuses unless you repeat its host exactly.
npm run db:seed-interview-questions -- --database-host=<host from step 1 above>
```

- **Idempotent:** it upserts about 8,200 rows keyed by each question's
  authored stable id (`investment_banking.restructuring.t004`). Re-running
  updates wording, metadata and criteria in place, adds new questions, and
  never deletes or duplicates a row.
- **Retiring a question:** set `active = false`. Re-seeding never
  re-activates it.
- **The behavioral core** (`is_behavioral_core`, ordered by
  `rotation_priority`, 0 = the anchor) is defined in
  `src/lib/video-interview/seed.ts`.
- **After editing the authored bank**
  (`npx tsx scripts/import-question-bank.ts`), re-run the seed.

## 3. Speech-to-text (server-only)

```bash
TRANSCRIPTION_API_KEY=              # required to turn transcription on
TRANSCRIPTION_BASE_URL=https://api.openai.com/v1   # default
TRANSCRIPTION_MODEL=whisper-1       # default
TRANSCRIPTION_RESPONSE_FORMAT=verbose_json          # default for whisper models
TRANSCRIPTION_TIMEOUT_MS=45000      # 5000–120000
TRANSCRIPTION_LANGUAGE=en
```

- **`whisper-1`** and Groq's whisper models
  (`TRANSCRIPTION_BASE_URL=https://api.groq.com/openai/v1`) return the word
  timings that pause detection needs.
- **`gpt-4o-*-transcribe`** returns text only, so pauses show as "n/a".
- Remote endpoints must use `https://`. `http://` is accepted only for
  localhost.
- Only each answer's **audio** (about 1 MB for three minutes) is sent. It is
  not kept afterwards.

## 4. Private object storage for training recordings (optional)

Used **only** for interviews the student chose to contribute. With it unset, nothing is
kept and the page says so.

```bash
VIDEO_STORAGE_ENDPOINT=             # see the per-provider values below
VIDEO_STORAGE_REGION=
VIDEO_STORAGE_BUCKET=
VIDEO_STORAGE_ACCESS_KEY_ID=
VIDEO_STORAGE_SECRET_ACCESS_KEY=
VIDEO_STORAGE_FORCE_PATH_STYLE=true # default; false = virtual-hosted S3
```

**Manual bucket setup is required.** Nothing creates the bucket for you.

**Supabase Storage**

1. Storage → New bucket, e.g. `interview-recordings`. Leave **Public bucket
   off**.
2. Storage → Settings → S3 Connection: enable it, note the endpoint
   (`https://<ref>.supabase.co/storage/v1/s3`) and region, and create an
   **S3 access key**. These are storage-only keys. Do **not** use the
   service-role key.
3. Browser uploads go straight to the storage endpoint. Confirm your project
   allows a cross-origin `PUT` with a `Content-Type` header from the app's
   origin, and test one upload end to end before relying on it.

**Cloudflare R2**

1. Create a bucket, and leave public access off.
2. Create an API token with Object Read & Write scoped to that bucket.
3. Endpoint `https://<account-id>.r2.cloudflarestorage.com`, region `auto`.
4. Add a CORS rule: `AllowedOrigins: [your app origin]`,
   `AllowedMethods: [PUT]`, `AllowedHeaders: [content-type]`.

**AWS S3**

1. Create a bucket with Block Public Access on.
2. Create an IAM user limited to `s3:PutObject`, `s3:GetObject` and
   `s3:DeleteObject` on `arn:aws:s3:::<bucket>/training-video/*`.
3. Add the same CORS rule as R2.

**How an upload works:** `src/lib/video-interview/training-video.ts`

1. After an answer is processed, the browser asks to keep its video. The
   server checks:
   - this interview was contributed (the session's own opt-in), under the
     current `VIDEO_POLICY_VERSION`
   - the question belongs to the signed-in student
   - the answer has been processed
   - the type is `video/webm` or `video/mp4`
   - the duration matches the processed answer
   - the size is within `maxVideoBytesFor()`: about 24 MB is typical for
     three minutes at 1 Mbps video plus 64 kbps audio; the hard cap is 40 MB
   - no upload already exists for that answer
2. It writes a **pending** row with a random key and returns one presigned
   `PUT`. The URL is valid for 5 minutes and signed for exactly that key,
   content type and byte length. No credential leaves the server.
3. The browser uploads straight to the bucket; the Vercel request limit
   doesn't apply.
4. On confirm, the server checks consent again, then HEADs the object (exact
   size, type) and reads its first bytes (a real WebM/MP4 file), and only
   then marks the row **stored**. Any failure removes the object and the row.
   If the database write fails, the object is deleted.
5. A pending upload that is never confirmed expires after 15 minutes and is
   swept (object and row) the next time the student opens the page.

**Deletion:**

- **"Delete all training recordings"** deletes every kept recording and
  withdraws those interviews' contribution.
- **Deleting an interview, or "delete all"**, removes the objects first. If
  the store is unreachable, nothing else is deleted and the student is asked
  to retry. Rows are marked `deleting` so they no longer count as kept, and
  the sweep retries them.
- **Account deletion** runs this before anything irreversible. It deletes
  every object it can. Any the store refuses are written to
  `object_deletion_queue`, which deliberately has no link to the user and
  holds only the provider, the random key, an attempt count, an error
  category and timestamps. Only then is the user deleted. If even the queue
  write fails, the account is not deleted and the student is asked to try
  again, because the user's rows are the last record of those objects. A
  database without the video tables never blocks account deletion.
- **Draining the queue:** `npm run storage:process-deletions` retries queued
  deletions. It is idempotent, removes a row only once its object is gone
  (an object that's already missing counts as gone), and exits non-zero while
  anything remains, so it suits a cron. The video page also drains a few rows
  on each load when storage is configured.

**CSP:** the Content-Security-Policy is report-only today. When it's
enforced, add the storage origin to `connect-src`.

## Privacy model

> **Legal review required.** The consent and retention wording (in
> `src/lib/video-interview/types.ts`: `ANALYSIS_CONSENT_POINTS`,
> `TRAINING_DIALOG_POINTS`) is a product draft, written to match what the code
> does. It hasn't been reviewed by counsel. In particular, check retention
> periods, the training use, and any jurisdiction-specific rules on voice and
> face recordings before launch.

- **Analysis consent (required):** given once and logged as an append-only
  event with the policy version and a timestamp. Each answer's audio is
  transcribed and graded, and the audio is not kept. The transcript and
  feedback are kept for the report.
- **Training consent (optional), asked per interview.** "Start interview"
  opens a dialog *before* the session exists and before the camera is
  requested. It offers two equally weighted answers, neither preselected:
  - "Yes, contribute this interview"
  - "No, continue without sharing"
- **How the decision is recorded:** the answer is stored on that session
  (`training_opt_in`, `training_policy_version`, `training_decided_at`) by
  the server, in the same transaction that creates the session. Each Start
  sends a one-time token, so a double-click can't create two sessions or two
  decisions.
- **What a "yes" covers:** that interview only, never earlier or later ones.
  Upload grants check the *session's* opt-in and its policy version, never an
  account setting or anything the browser sends.
- **What a "no" means:** no video from that interview ever leaves the
  browser. It doesn't touch earlier interviews or their recordings.
- **Sessions from before 0032** default to opted out.
- **"Delete all training recordings"** deletes every contributed recording
  and withdraws those interviews' contribution (`training_withdrawn_at`), so
  an interview still in progress stops uploading. The interviews and feedback
  stay. Deleting an interview, or deleting everything, removes its recordings
  too.
- **Without storage configured,** the dialog says no training recording can
  be kept, and nothing is attempted.
- **Camera video** otherwise lives in the tab's memory for playback and
  download only.
- **Minimal metadata:** a kept recording's row holds its key, type, size,
  duration, owner, consent version and upload state.
- **Answer keys stay on the server.** `expected_points` is read only at
  grading time.

Bump `VIDEO_POLICY_VERSION` (now `2026-09-30`) whenever what is kept, or how
consent is asked, changes materially. Consents from older versions stop
counting.

## Limits

In `src/lib/video-interview/limits.ts`:

- 12 interviews per student per rolling day
- 15 answer submissions per 10 minutes
- 5 tries per answer
- 4 MB per audio upload
- one training upload per answer

Grading also takes one slot of the shared daily AI quota per answer.
