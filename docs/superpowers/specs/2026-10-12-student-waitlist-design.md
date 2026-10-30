# Pre-launch waitlist — design

**Date:** 2026-10-12
**Status:** BUILT (d1a81b3, 5a01163). Not migrated — `waitlist_signups` does not
exist in the live database, so the form renders and refuses to save until
`npm run db:migrate` is run with Kai's go-ahead.
**Path:** architectural (new public write path, new table, new pre-account consent record)

## Intent

Until launch, the public site offers exactly one action: join the waitlist.
Students join from the home page; firms join from `/for-firms`. Nothing public
links to sign up or log in. At launch, everyone on the list gets priority
access through an invite token that prefills the real signup.

Confirmed with Kai, 2026-10-12:

| Decision | Answer |
|---|---|
| The one action | "Join the waitlist" — no sign up, no log in, anywhere public |
| Top bar | The account buttons come out too, desktop and mobile menu |
| Form placement | **The form is the hero**, not a band further down |
| Audiences | **Both.** Students on `/`, firms on `/for-firms` |
| Student fields | Email, name, school, graduation year |
| Sending | **Capture only.** Nothing is emailed by this build |
| Incentive | Priority access at launch, via an invite token on the row |
| Existing accounts | Routes stay alive; only the links go |

### Links go, routes stay

`/login`, `/signup`, `/firms/login` and `/firms/signup` keep working by direct
URL. They are simply unlinked from every public page, so nobody browsing the
site finds a door, while you, the admin screens and the demo account get in by
typing the address. No env flag, no redirect, no bypass to maintain — and no
way to lock yourself out of your own admin console a week before launch.

The signed-in app is untouched. The home page's existing redirect for
logged-in users (`getOptionalUser()` → `/dashboard`) stays, so an authenticated
person never sees the waitlist hero at all.

### What this build deliberately does not do

The launch email. Capture-only was chosen, but priority access is delivered *by*
email, so the send has to exist eventually. This design stores everything that
send will need — address, marketing consent, the policy version shown, the
invite token — and stops. Choosing between an external ESP and in-app broadcast
is a separate decision at launch, and whichever wins needs a working
unsubscribe, a postal address and `List-Unsubscribe` headers before one campaign
goes out. None of that exists in this repo: `src/lib/email.ts` is
single-recipient transactional plain text, and "unsubscribe" appears nowhere in
the app.

Also out of scope, on YAGNI grounds: a standalone `/waitlist` route, referral
positions, and a public signup count.

## Success criteria

1. A student joins from the home page hero in one submit, with no account.
2. A firm joins from the `/for-firms` hero in one submit.
3. No public page links to sign up or log in — header, hero, footer, mobile menu.
4. The same address twice updates one row; it never creates a second.
5. An invite link prefills signup and the row records who it became.
6. `npm run test:all` passes, help knowledge is current, privacy policy published.

## Architecture

One table with two kinds, one server action, two hero forms, one admin screen,
and a prefill branch in the existing signup page. No new dependencies.

```
(marketing)/page.tsx       ─ CityHero ─▶ WaitlistHeroForm kind="student"
(marketing)/for-firms      ─ hero     ─▶ WaitlistHeroForm kind="firm"
                                              │
                                     waitlist-actions.ts joinWaitlist()
                                       ├── blockedInForm        (content rule)
                                       ├── waitlistSchema       (lib/validation)
                                       ├── honeypot + rateLimit (abuse)
                                       └── upsert waitlist_signups (lib/waitlist.ts)

MarketingHeader  ─ account links removed, desktop + mobile
MarketingFooter  ─ Account column keeps only "For firms"

/signup?invite=<token> ─▶ prefill name+email ─▶ on success set converted_user_id
(app)/admin/waitlist   ─▶ counts by kind, school, grad year + CSV export
```

### Why one table, not two

Student and firm rows share most of what matters — address, dedup key, consent,
policy version, invite token, conversion — and differ by two columns each. A
`kind` discriminator with four nullable columns and a CHECK constraint is one
table, one library, one action, one admin screen and one CSV. Two tables would
double all five to avoid four nullable columns.

### Why consent lives on the row, not in `consent_events`

`consent_events` is the ledger of what an **account holder** agreed to at a
`policyVersion`, and its `kind` is a Postgres enum. Recording waitlist consent
there means adding an enum value and writing null-`userId` rows for people with
no account and no settings screen to change their mind on. The consent belongs
to the waitlist row, which is also what gets deleted when someone asks to come
off the list.

### Why `POLICY_VERSION` is not bumped

`src/lib/policy.ts` says to bump only when the change affects what may be done
with **user** data, because a bump re-gates every existing account on next page
load. A waitlist adds a new pre-account collection and changes nothing about
existing users' data, so the privacy policy gains a Waitlist section and the
version stays `2026-09-28`. Flagged for Kai: a judgement call; bumping is the
conservative alternative at the cost of re-prompting every current user.

## Data

New migration, next in sequence: `drizzle/0051_waitlist_signups.sql`.

```
waitlist_kind  enum ('student', 'firm')

waitlist_signups
  id                 uuid pk default random
  kind               waitlist_kind not null
  email              text not null          -- as typed; this is what gets mailed
  email_canonical    text not null unique   -- canonicalMailbox(email); the dedup key
  name               text not null
  school             text null              -- student only
  grad_year          integer null           -- student only
  firm_name          text null              -- firm only
  title              text null              -- firm only
  invite_token       text not null unique   -- 32 hex chars, crypto random
  email_consent      boolean not null
  policy_version     text not null
  source             text null              -- ?src= on the landing URL, [a-z0-9_-]{1,32}
  converted_user_id  uuid null references users(id) on delete set null
  created_at         timestamptz not null default now()
  updated_at         timestamptz not null default now()

  check (kind = 'student' and school is not null and grad_year is not null
         and firm_name is null and title is null)
     or (kind = 'firm'    and firm_name is not null and title is not null
         and school is null and grad_year is null)

  index on (created_at)
  index on (kind, created_at)
  index on (school, grad_year)
```

Two email columns on purpose. `canonicalMailbox` (lib/firm-account) collapses
`+tags` and, at dot-blind hosts, dots — exactly right for a unique key that
stops one person joining six times, and wrong for the address a launch email is
actually sent to. Store both; key on the canonical one, mail the typed one.

The unique key is global, not per-kind: one address is one row. Somebody who
joins as a student and later as a firm updates their row rather than holding two.

## Components

### `src/lib/waitlist.ts`

Owns the table. Server-only. Knows nothing about forms or React.

- `joinWaitlist(input: StudentJoin | FirmJoin): Promise<{ created: boolean }>` —
  upserts on `email_canonical`, generating `invite_token` only on insert so a
  resubmit keeps the token already in flight.
- `waitlistRowByToken(token): Promise<WaitlistRow | null>`
- `markWaitlistConverted(token, userId): Promise<void>`
- `waitlistSummary(): Promise<{ total, byKind, bySchool, byGradYear }>`
- `waitlistRows(kind, limit, offset)` for admin.

### `src/lib/validation.ts` — `waitlistSchema`

A discriminated union on `kind`, alongside `signupSchema` in the same style.

Shared: `name` 1..200, `email` email max 200, `emailConsent` `z.literal("on")`.
Student adds: `school` 1..200, `gradYear` coerced int, `currentYear`..`currentYear + 8`.
Firm adds: `firmName` 1..200, `title` 1..200.

`gradYear` is a range, not a free integer: the field is a `<select>`, so a value
outside it is not a typo, and `users.grad_year` arithmetic elsewhere assumes
sanity. `emailConsent` is checked server-side for the same reason `signupSchema`
checks `consent` there — the checkbox's `required` attribute says nothing about
what arrived in the POST.

### `src/app/(marketing)/waitlist-actions.ts` — `joinWaitlist`

`"use server"`. Order matters; each step refuses before the next runs.

1. **Content rule first.** `blockedInForm(formData, { name: "Name", school: "School", firmName: "Firm", title: "Title" }, ["email", "gradYear", "emailConsent", "kind", "hp"])`. Name, school, firm and title are words a person types. Email, the year `<select>`, the checkbox, the kind discriminator and the honeypot are not. This is what satisfies `content-limits-coverage-test.ts`; nothing is written before it passes.
2. **Honeypot.** An `hp` input, offscreen, `tabindex="-1"`, `autocomplete="off"`. Non-empty means a bot: return the ordinary success state and write nothing. There is no captcha anywhere in this repo, and this is a public unauthenticated insert into the production database — now the *only* thing the public site does, so it is the whole attack surface.
3. **Schema.** `waitlistSchema.safeParse`, field-keyed errors echoed back with the typed values, matching `signup/actions.ts` `ActionState`.
4. **Rate limit.** Two buckets via `lib/rate-limit`: `waitlist_ip` on `requestIp()`, 5/hour; `waitlist_email` on the canonical address, 3/day. A null IP refuses nothing on its own — the email bucket still applies — rather than treating every unknown caller as one subject.
5. **Upsert.** `onConflictDoUpdate` on `email_canonical`.
6. **Identical success whether it inserted or updated.** Distinguishing them turns the form into a free address-membership oracle.

No email send. No `sendEmail` import.

### `src/app/(marketing)/WaitlistHeroForm.tsx`

Client component, `useActionState`, `kind` prop. One component serves both heroes;
the fields it renders and the copy it carries switch on `kind`.

It sits over drone footage, so it carries its own plate — a dark translucent
panel with a blur, the same treatment `liquid-glass` gives the mobile menu —
because four inputs directly on moving video is unreadable and fails contrast
on the bright frames of the rotation. Fields stack on mobile, 2×2 on desktop,
one full-width **Join the waitlist** button beneath.

On success the form is replaced in place by a confirmation: they are on the
list, they will hear when Offerly opens. It says plainly that no email is coming
yet — silence after a submit reads as a broken form.

Design risk, stated rather than hidden: four fields plus a consent checkbox is
a heavy hero, and the hero is now the only conversion point on the site. If it
reads as cluttered against the footage, the fallback is email-first (one field
and the button, the rest revealed after submit) — a change to this component
alone, not to the action or the table.

### Page edits

| File | Change |
|---|---|
| `(marketing)/page.tsx` | `CityHero` children become `<WaitlistHeroForm kind="student" />`. The "Sign up, it's free" and "See how it works" buttons go. The approach band's "See what's inside" → `/signup` becomes a scroll back to the hero. The "Recruiting for a firm?" link stays — it points at `/for-firms`, a marketing page, not a door. |
| `(marketing)/for-firms/page.tsx` | Hero CTAs (`/firms/signup`, `/firms/login`, `/firms/demo`) and the closing CTA pair both become `<WaitlistHeroForm kind="firm" />` in the hero, nothing at the close. |
| `(marketing)/MarketingHeader.tsx` | The `forFirms` account block comes out, desktop and mobile. `TABS` stay. The `forFirms` variable and the `my-2 border-t` divider in the mobile menu go with it. |
| `(marketing)/MarketingFooter.tsx` | Account column loses Log in and Sign up, keeps For firms. |

`/firms/demo` comes out with the rest: it is a door into the portal, and leaving
one door open defeats the point of closing the others. Flag if you want it kept
as a sales asset.

### `src/app/(app)/admin/waitlist/page.tsx`

`requireAdminPage()`, same as the three existing admin screens. Totals by kind,
tables by school and grad year, recent rows, and a CSV download — the handoff
format for whichever ESP wins at launch. Admin routes are excluded from the Help
assistant's page list by its own test, so this costs nothing there.

### Signup prefill — `src/app/signup/page.tsx`, `actions.ts`

`/signup?invite=<token>`: look the row up server-side, pass `name` and `email`
as defaults into `SignupForm`, carry the token as a hidden field. On a completed
signup, `markWaitlistConverted(token, userId)` and seed `users.school` /
`users.grad_year` from the row if still null.

The token prefills and attributes. It does **not** skip email verification,
confer a plan, or stand in for consent — a guessed or shared token must buy
nothing but a filled-in form. An unknown token is ignored silently.

## Error handling

| Case | Behaviour |
|---|---|
| Blocked language in any typed field | The check's own message, against that field. Nothing written. |
| Invalid field | Field-keyed errors, typed values echoed back (React resets an uncontrolled form on settle). |
| Honeypot filled | Ordinary success. Nothing written. |
| Rate limited | "Try again shortly" via `retryAfterText`. Nothing written. |
| Address already on the list | Ordinary success; the row is updated. |
| Student payload carrying firm fields, or the reverse | Rejected by the schema union before the CHECK constraint sees it. |
| Database unreachable | Generic failure, no stack to the browser; the action logs. |
| Unknown or missing invite token | Ignored; signup behaves normally. |

## Testing

New `scripts/test/waitlist-db.test.ts`, following the existing db tests:

1. A valid student submit inserts one row with a token and the current `POLICY_VERSION`.
2. A valid firm submit inserts a firm row; school and grad year stay null.
3. The same address with `+tag` and different capitalisation updates that row — one row, token unchanged.
4. Blocked language in name, school, firm name and title is each refused, writing nothing.
5. `gradYear` outside the window is refused.
6. A student payload missing `school` is refused.
7. A filled honeypot returns success and writes nothing.
8. The sixth submit from one IP inside an hour is refused.
9. `markWaitlistConverted` sets `converted_user_id`; an unknown token is a no-op.
10. `waitlistSummary` groups by kind, school and grad year.

Plus a render assertion that no public marketing page links to `/login`,
`/signup`, `/firms/login` or `/firms/signup` — the one requirement here that a
future edit could silently undo, and the whole point of the change.

Then the gates: `npm run test:all`, and `npm run help:learn` with `.env.local`
symlinked, committing the regenerated `help-knowledge.json`.

## Launch and legal checklist

1. `npm run db:generate` then `db:migrate`. **This runs against the production Supabase project — local dev shares it.** Not run without Kai saying go.
2. `legal/drafts/privacy-policy.md`: a Waitlist section — what is collected, that it is used to tell them when Offerly opens, that they can ask to be removed, and how. Then `npm run legal:publish`, committing draft and published output together.
3. `npm run help:learn`, commit `src/lib/help-knowledge.json`. Both `/` and `/for-firms` change, so both relearn.
4. `npm run test:all`.

## Open questions for review

1. **Pricing page.** `/pricing` still sells plans and its tiers link onward. With no way to sign up, it advertises something nobody can buy. Leave it, soften it to "at launch", or drop the tab until launch?
2. **`/firms/demo`.** Removed above with the other firm doors. Keep it if it is a sales asset you use in conversations.
3. **Firm fields.** Specced as name, work email, firm, title. Say if you want "roles you recruit for" or headcount instead of title.
