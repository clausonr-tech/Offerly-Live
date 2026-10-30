# Offerly

A recruiting workspace for students breaking into finance. It keeps the whole
cycle in one place: finding firms worth targeting, finding the people inside
them, drafting the outreach, tracking applications and deadlines, preparing for
interviews, and following the news you will be asked about.

This is the open-source release of what was a hosted product. It runs on your
own machine, on your own API keys, with no accounts and no billing.

---

## ⚠️ There is no login

This build has **no authentication at all**. Identity is a single fixed local
row — whoever opens the app is the only user there is.

That is right for the way it is meant to be used: you clone it, you run it, it
is yours. It is **badly wrong if you put it on a public URL**, where every
visitor would share one account and one set of data with no sign-in between
them. Run it locally, or behind something that does the authenticating for you.

---

## Running it

You need **Node 20.9 or newer** (`node -v`). Nothing else — no database to
install, no services to sign up for.

```bash
git clone https://github.com/clausonr-tech/Offerly-Live.git
cd offerly
npm install
npm run dev
```

Then open <http://localhost:3001>.

The database is embedded ([PGlite](https://pglite.dev), a Postgres that runs
in-process) and lives in `./local-data`. Migrations apply automatically before
the dev server starts, so the first run sets itself up. You land on onboarding,
answer a few questions about what you are recruiting for, and the app is
populated from there.

**Everything in the app works at this point, with no API keys whatsoever.**
Keys only turn on the features that call outside services.

---

## Adding your own keys

Copy the template and fill in what you want:

```bash
cp .env.example .env.local
```

Every key is optional and every integration fails closed: with nothing set, the
feature says so instead of breaking. Nothing phones home, and no key is bundled
with this repo — the costs are yours directly, on your own accounts.

| Set this | And you get | Cost |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Email drafting, résumé review, connection suggestions, the interview coach | Per token, on your Anthropic account |
| *(nothing)* | The News desk and the job crawler, which use your signed-in `claude` CLI instead of the API | Your Claude subscription |
| `CRUSTDATA_API_KEY` + `CRUSTDATA_USD_PER_CREDIT` | Contact sourcing — finding real people at a firm. **Stays off until `CRUSTDATA_USD_PER_CREDIT` is set**, which is also the spend cap | Per credit, in dollars |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | Google Calendar on /schedule, reading your calendar and writing interviews back to a dedicated Offerly calendar | Free |
| `TRANSCRIPTION_*` + `VIDEO_STORAGE_*` | The video interview coach — speech-to-text and private storage for recordings | Per minute transcribed, plus storage |
| `RESEND_API_KEY` + `RESEND_FROM_EMAIL` | Real outbound email. Unset, mail prints to the terminal instead | Free tier covers it |
| `FRED_API_KEY` | The Markets view's official statistics — dollar index, oil, the Fed's rate | Free |
| `BRANDFETCH_CLIENT_ID` | Better firm logos, falling back to favicons without it | Free tier |
| `TWILIO_*` | SMS test sends | Per message |

`HELP_ASSISTANT_DAILY_BUDGET_USD` caps what the in-app help assistant may spend
per day. It defaults to 10; set it to 0 to switch the assistant off entirely.

`.env.local` is gitignored. Keep it that way.

---

## What is in here

- **Discovery** — a firm directory and internship postings, with recommendations
  based on what you told onboarding.
- **External Network** — the firms you are targeting, the people inside them,
  and the state of every conversation.
- **Outreach** — drafting cold emails and follow-ups, with a review pass that
  checks tone and catches the things that get students ignored.
- **Schedule** — interviews, coffee chats and deadlines, optionally synced with
  Google Calendar.
- **Interview Prep** — a question bank by sector, practice rounds that are
  graded, and a video coach.
- **News** — a finance news desk that summarises what matters for the firms you
  care about.
- **Internal Network** — a student feed, clubs and peer messaging. Largely inert
  in a single-user copy, since there is nobody else on it.

---

## Development

```bash
npm test          # the test suite
npm run typecheck # tsc --noEmit
npm run build     # production build
npm run setup     # apply migrations by hand
```

PGlite takes **one writer at a time**. Stop the dev server before running any
script that opens the database, or you will corrupt the data directory — there
is no repair tool. `src/lib/monitoring/exclusive-db.ts` guards the scripts that
know about it.

Pointing `DATABASE_URL` at a real Postgres switches the app off the embedded
database. Migrations are then yours to run (`npx drizzle-kit migrate`) — the
automatic step deliberately refuses to touch a database it did not create.

---

## Licence

MIT. See [LICENSE](LICENSE).
