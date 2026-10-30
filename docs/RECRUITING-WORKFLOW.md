# Recruiting workflow: the nudge system

Three features that turn Offerly from a place a student *can* do recruiting work
into one that tells them what to do this week. They share one spine — a dated
thing coming up, a prompt at intervals before it, and a step the student ticks
off — so they are written down together and built one at a time.

Status: **#1, #2 and #3 built**, plus thank-you prompts after chats and interviews (`src/lib/thank-you.ts`).

---

## 1. Outreach prompts before an upcoming application — BUILT

**The idea.** A student matched with a firm and has an application coming up
there. At set intervals before it, prompt them to write to the contacts they
already have at *that firm*, and hand them straight to the email drafter.

**What already exists to build on**

| Piece | Where |
| --- | --- |
| Real, dated upcoming applications (opens / due) | `src/lib/upcoming-applications.ts`, rendered by `src/app/(app)/UpcomingApplications.tsx` |
| The student's contacts, with a `firm` string | `contacts` table, `src/db/schema.ts` |
| Firm-name normalisation for matching a contact to a firm | `normalizeFirmName` in `src/lib/network-coverage.ts` |
| The "five things to do today" list at the top of Opportunities | `src/lib/today-tasks.ts` + `src/app/(app)/dashboard/TodayList.tsx` |
| A drafter that opens pre-addressed to one contact | `/outreach?contact=<id>` (`src/app/(app)/outreach/page.tsx`) |

**What shipped**

- `src/lib/application-outreach.ts` — joins upcoming openings to contacts at the
  same firm (`normalizeFirmName` on both sides) and returns one nudge per firm,
  inside a 30-day window, counted in whole calendar days on the student's own
  clock. `todoNudges()` takes the nearer 14 days for the to-do list;
  `nextFlash()` picks the one bar to drop now. All pure, all tested.
- `src/app/(app)/OutreachFlash.tsx` + `OutreachFlashSlot.tsx`, mounted in
  `src/app/(app)/layout.tsx` inside `<Suspense>` so it never delays a page. A
  rounded grey bubble in the content column only - the rail keeps its own
  corner - 55px tall on a laptop, dropping in with a slight overshoot and
  leaving straight up, faster than it arrived. Transform and opacity only, so
  nothing under it reflows.
- The flash records itself as **shown** (`outreach_flashes_shown`, migration
  `drizzle/0007_add_outreach_flashes_shown.sql`) the moment it mounts - it has
  no dismiss state because it dismisses itself, and the one thing it must never
  do is repeat. Keyed by firm **and opening date**, so next year's cycle is a
  new thing to be told about.
- One flash at a time, most urgent first. When one leaves, the page refreshes
  and the next firm's bubble drops behind it, so two never stack.
- **Every flash also files a notification** under the bell in the top bar
  (`notifications` table, migration `drizzle/0008_add_notifications.sql`). The
  bubble is gone in five seconds whether or not it was read; the notification is
  the durable half of the same event.
  - **One job, one row.** A prompt that fires again bumps its row to the top
    rather than adding a second, and reopens it if it had been closed.
  - **The number is outstanding jobs, not unread messages.** Reading the panel
    clears the dot, never the count.
  - **Two ways to close.** The student ticks it off, or the app watches them
    finish it - every contact at that firm written to. A third case, a row whose
    application opened before anyone got to it, closes as expired: closed, never
    called done.
  - **Finished work is not listed anywhere.** A to-do list that keeps its own
    history stops being a to-do list.
  - **The full page** (`/notifications`, "What needs doing") is the same rows
    with room for how far through each job the student is - "1 of 2 emailed,
    finishing the rest closes this" - so a row says whether it will close itself
    or whether only they can answer for it. The bell links to it.
- A new `outreach` task kind in `src/lib/today-tasks.ts`: one of the five things
  on Opportunities, scored to climb as the opening nears (50 at three weeks out,
  92 on the day).
- Only openings with a published date (`provenance` `posting` or `signal`)
  prompt. An estimated window never produces a countdown - including our own
  `prediction` signals, which schedule the crawler but read as undated.
- Every dated opening is considered, not the Upcoming panel's rationed eight.
- `scripts/seed-outreach-demo.ts` writes the four things that have to line up
  (a tracked firm, a posting with a published opening date, contacts there, none
  of them written to) so the whole thing can be looked at locally.

**Decisions (agreed 2026-09-22)**

- Count down from the date the application **opens**, not the deadline. The
  emails have to land before the résumé goes in.
- **Two surfaces, two jobs.** A **flash** - a grey notification bubble that
  drops into the content column beside the rail, holds ~4.5 seconds and shoots
  back up the way it came - from **a month out**, and again every **two
  calendar days** from when it last fired while the work is outstanding. Then a
  **standing row in the Opportunities "Today" list** from **two weeks out**
  until the application opens: it does not
  interrupt, so it can sit there as long as the work is outstanding.
- **One row per firm, never one per person**: *"Email Goldman Sachs — 5 contacts
  left to email · opens in 13 days"*. Five rows each naming one person would
  fill the whole five-item list with one firm.
- A firm where the student has **no contacts produces no prompt at all**.
  Sourcing contacts is a different problem and a different nudge.
- **One prompt per firm**, naming how many contacts there are still to write to,
  not one prompt per person.

---

## 2. Self-reported sending, and the three-email ladder

**The idea.** Offerly stops handing emails to Gmail. The student sends the email
themselves, ticks a box saying they did, and Offerly runs the follow-up clock:
one week later a banner asks for follow-up #2, a week after that #3. Three
emails to one person, then stop. It also stops the moment the student says that
person replied.

**Decisions (agreed 2026-09-22)**

- **Copy to clipboard is the send path.** No Gmail hand-off, no `mailto:`.
- **Copying counts as sending.** Hitting copy registers the email as sent and
  starts the follow-up clock; ticking it by hand does the same, for an email
  written outside Offerly.
- **It extends "Reached out", it does not replace it.** The existing column in
  the networking table gains two facts: whether that person replied, and which
  cold email the student is on (1st / 2nd / 3rd / done).
- **Keep capturing the sent version.** Pushing to Gmail used to be the only
  thing that wrote `emailArchive.finalCiphertext` - what the model drafted
  against what the student actually sent. The copy button takes that over, so
  the training signal survives the Gmail path being removed.

**2a. Remove the Gmail send path**

- The `Send on Gmail` button and the disclaimer hand-off in
  `src/app/(app)/drafts/Composer.tsx`, and `sendDraftToGmail` in
  `src/app/(app)/drafts/actions.ts`.
- Consequence to handle deliberately: pushing to Gmail is currently the only
  thing that writes `emailDrafts.pushedToGmailAt` and the sent version into
  `emailArchive.finalCiphertext` (the training signal — what the model wrote vs.
  what the student actually sent). "I sent this" has to take over that job, or
  that data stops being collected.
- The Google *calendar* connection stays — #3 depends on it.

**2b. "I sent it"**

- After each draft, an explicit choice: *sent* / *not yet*. Never inferred.
- Sets the send date, which is what the follow-up clock counts from.

**2c. The ladder**

- Email 1 sent → 7 days later, a banner across the top of the app: *follow up
  with <name>*.
- Draft + tick email 2 → 7 days later, the same for email 3.
- After email 3, that person is done. No more banners, ever.
- The student ticking *they replied* ends it immediately at any step.

**2d. Networking tab**

Next to each contact line in the networking tab (`ContactGrid.tsx` /
`ContactsPanel.tsx`):

- which email they are on — none / 1st / 2nd / 3rd / done;
- a reply toggle — replied / no reply yet. `emailDrafts.gotReply` already models
  the three states (yes / no / never answered) and the same honesty applies
  here: "we never found out" is not "no".

**Shape of the work**

- Per-contact sequence state. Either derived from `emailDrafts` rows (add a
  self-reported `sentAt`, count sent drafts per contact) or a dedicated
  `outreach_steps` table. Decision pending — see questions.
- A banner host in `src/app/(app)/layout.tsx`, since there is no app-wide banner
  today (only `GoogleConnectBanner` on Schedule).
- The existing `relationshipStatus` (`not_contacted` → `reached_out` → …) and
  `getDueFollowUps` in `src/lib/follow-ups.ts` already nudge on a cadence of
  7/21/45/90 days. The ladder replaces or subsumes that for cold outreach rather
  than running a second, competing reminder next to it.

---

## 3. Interview prep prompts — BUILT

**The idea.** A student connects Google Calendar and an interview appears.
A week before, start prompting interview prep: a banner, and an entry at the top
of the Opportunities "Today" list.

**What already exists to build on**

- Google Calendar read + the sync-into-Offerly flow: `src/lib/google-calendar.ts`,
  `src/app/(app)/schedule/page.tsx`, `googleSyncStatusEnum`.
- Prep material to point at: `/learn`, `src/lib/behavioral-questions.ts`,
  `technicalQuizAttempts`, `practiceSessions`.

**Decisions (agreed 2026-09-22)**

- **The heuristic decides, and auto-tags.** No confirmation step: a calendar
  entry that names itself an interview is filed as one.
- **The prompt opens the technical quiz for that firm's sector** - the work
  students under-prepare - not a menu.
- **7, 3 and 1 days before.** Three prompts, because an interview does not move.

**What shipped**

- `src/lib/interview-prep.ts` — `looksLikeInterview` reads the calendar entry's
  own words, and is deliberately narrow: "chat", "call" and "meeting" are absent
  because they are most of everyone's calendar, and a second list rules out
  *preparation* ("mock interview", "interview prep") so the app never prompts
  somebody to prepare for their preparation. A title the student filed as an
  interview themselves always wins.
- The firm is read out of the title against **their own tracked firms**, run by
  every word in it rather than the whole string - "BAML superday - NYC" only
  resolves because the abbreviation is looked up on its own - and the longest
  match wins. That firm's sector picks the question bank; their own sector is
  the fallback, so a prompt always lands on a bank rather than a menu.
- `interview` is now an event type (`drizzle/0009_*.sql`), rendered by the
  Schedule and the calendar, and written back onto anything the detector
  recognised. It never overwrites a type the student chose.
- `/learn?category=<bank>` opens the quiz on a specific bank.
- Same two surfaces as #1: the flash bubble (7/3/1 days), and a row in the
  Opportunities to-do list scored just under a deadline due today.
- The flash plumbing is now shared (`src/lib/prompt-flash.ts`, `flashes_shown`):
  one bubble at a time, the most urgent across every kind of prompt, the rest
  queued behind it. An interview in three days outranks an application opening
  in twenty.
- Under the bell the job is **one row per interview**, bumped to the top at each
  of the three marks rather than filed three times. It closes itself once the
  student plays a round in that bank, and expires after the interview.

**Verified (2026-09-22)** — 332 tests across `scripts/test/outreach-selection.test.ts`,
`outreach-timing.test.ts` and `outreach-firm-matching.test.ts`, plus a look at the
real banner in both themes at 1440 / 1024 / 390. Six things it found and fixed:

1. **The deep link went nowhere for half the contacts.** `/outreach` built its
   recipient list from Discovery's matches only, so `?contact=<id>` silently
   selected nobody for a contact the student added themselves. "Draft to Dana
   Reed" opened an empty form. The page now adds the person who was asked for.
2. **The "+N more" link could 404.** It pointed at `/contacts/company/<key>`,
   which lists only contacts with an email address and 404s for a firm where
   none of them has one - a common early state, and exactly the state this
   banner fires in. Both links now go to `/networking/contacts?q=<firm>`, which
   is that table filtered to the firm (a new `?q=` param on that page).
3. **`"Morgan Stanley & Co. LLC"` matched nothing.** Stripping "Co." off an
   "X & Co." name left a dangling "and" in `normalizeFirmName`, so the contact
   normalised to `morgan stanley and`. Four firms had a one-off alias patching
   this; every other firm written that way silently failed. Fixed for all of
   them, and the four aliases are gone. This fixes network coverage too.
4. **Duplicate and unreachable contacts wasted the row.** The same person
   imported twice appeared twice, and the three name slots were filled in
   database order. Duplicates now collapse (keeping the copy with an address)
   and people who can actually be written to come first.
5. **The banner ran on every page load** before checking whether the student had
   anyone left to write to. The cheap contacts query now gates the expensive
   upcoming-applications one.
6. **Layout**: the supporting line truncated mid-word, the same sentence of
   sales copy repeated on all three rows, "Not now" abutted the last name pill,
   and at 390px the firm name lost half its characters. Rows now stack below
   `sm`, the muted controls sit behind a rule, and nothing truncates at any
   width measured.

---

## Rules every one of these inherits

- **Content checks.** Any new server action that takes typed words calls
  `blockedLanguageError` / `blockedInForm` (`src/lib/content-limits.ts`); the
  ones that take only an id and a tick get an `EXEMPT` line with that reason in
  `scripts/content-limits-coverage-test.ts`.
- **Never invent a date.** `upcoming-applications.ts` refuses to count down from
  an estimate, and prompts built on it must not either.
- **Nothing auto-sends, nothing auto-ticks.** Every state here is the student's
  own report about their own behaviour.
- **A prompt that cannot be ended is spam.** Every banner has a stop condition
  written down before it ships.

---

## Open questions

**#1** — answered, see the decisions under that section.

**#2**
8. Is the 7-day gap fixed, or editable per contact?
9. Does the banner show one person at a time, or all who are due?
10. Where does an existing `relationshipStatus` of `reached_out` leave a contact
    with no logged emails — step 0, or step 1?

**#3** — answered, see the decisions under that section.
