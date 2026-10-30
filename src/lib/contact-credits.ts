import "server-only";

import { and, eq, gte, ne, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { contactSourcingRuns, users } from "@/db/schema";
import type { Plan } from "@/lib/model-registry";
import { PENDING_STALE_MS } from "@/lib/sourcing-run-policy";

/**
 * Contacts returned per click. One click costs one credit and asks the provider
 * for this many people; a student who wants more at the same firm clicks again.
 */
export const CONTACTS_PER_RUN = 5;

/**
 * Clicks allowed per calendar month, by plan. Deliberately small: every click
 * is a paid call to Crustdata, so this is a real cost ceiling rather than the
 * fair-use ceiling DAILY_LIMITS is for.
 */
export const MONTHLY_CONTACT_CREDITS: Record<Plan, number> = {
  // Zero since billing launched: contact sourcing is a paid feature now, and
  // the page it lives on sits behind the plan gate (lib/plan-access). The
  // zero is defence in depth for anyone calling the action directly.
  free: 0,
  // The marketed quotas: 30 generations a month on Pro, double on Pro+.
  pro: 30,
  pro_plus: 60,
};

/**
 * Accounts that never consume credits.
 *
 * The shared demo login used to be here. Its password was pre-filled into the
 * public login page, so "unlimited" meant anyone on the internet could run
 * paid Crustdata searches without limit - it now pays the free allowance like
 * any other account.
 *
 * Matched on the email column, lowercased. Kept as data here rather than as a
 * flag on `users` so granting it is a code review rather than a DB update, and
 * so it cannot be set by anything the app itself writes.
 *
 * Matching on the address is safe because the address is proven: sign-up
 * emails a code to it before the account exists (lib/student-signup, and
 * lib/firm-auth for firms), and nothing in the app changes an account's
 * login email afterwards. Anything that ever lets a login email change must
 * verify the new address first, or these entries become claimable.
 */
// Empty in the open-source build. These were the two hosted accounts that
// bypassed metering; they were real personal addresses and had no business
// shipping in a public repository. Nothing self-hosted needs an exception
// anyway — the metered services run on your own key, so there is no shared
// budget for an account to be exempt from.
const UNLIMITED_EMAILS: ReadonlySet<string> = new Set<string>([]);

/**
 * Reserved test domains (RFC 2606 / 6761). An address there is a seeded or
 * shared account by construction, and those are exactly the ones whose
 * credentials travel - so none of them can be unlimited, whatever the list
 * above says.
 */
const TEST_DOMAIN = /\.(test|local|localhost|example|invalid)$/;

/**
 * Test accounts that ARE unlimited, named one by one - the exception to the
 * rule above, not a loosening of it.
 *
 * The shared demo student account, restored on 2026-09-25 at the owner's
 * request so demos never stop at the allowance. Safe to reconsider only
 * because its password no longer travels: the public login page stopped
 * pre-filling it (the reason it was metered), and the localhost autofill
 * reads it from .env.local on a dev server only. If that password is ever
 * shared further, or shown anywhere again, take this entry out - each run
 * still stops at the $2 provider limit, but the number of runs does not.
 */
const UNLIMITED_TEST_ACCOUNTS: ReadonlySet<string> = new Set(["demo@offerly.test"]);

/**
 * Whether an account bypasses the allowance. Exported and pure so the rule is
 * testable without a database - getting it wrong bills us for someone else's
 * searches.
 */
export function isUnlimitedAccount(email: string | null | undefined): boolean {
  const normalized = (email ?? "").trim().toLowerCase();
  if (UNLIMITED_TEST_ACCOUNTS.has(normalized)) return true;
  if (TEST_DOMAIN.test(normalized)) return false;
  return UNLIMITED_EMAILS.has(normalized);
}

/**
 * Accounts that see the agent's own workings - the raw outbound payload, and
 * anything else built to check the agent rather than to help a student.
 *
 * Kept separate from UNLIMITED_EMAILS: paying nothing and seeing the debugging
 * view are different grants, even while one account happens to hold both.
 *
 * Students still see what leaves the app about them - the plain-English
 * summary and the resume readback are rendered for everyone. This hides the
 * debugging view, not the disclosure.
 */
const INTERNAL_EMAILS: ReadonlySet<string> = new Set(["matuseno@usc.edu"]);

/**
 * Local development never meters contact searches, for any account - the demo
 * login included. The public-password risk that took the demo off the list is
 * about the deployed app, which is always a production build; `next dev` runs
 * only on a developer's own machine, bound to 127.0.0.1 (package.json) so
 * nobody else on the network can reach it and spend. Searches here are still
 * real, billed Crustdata calls against the live database.
 *
 * Strictly "development", as in dev-login-prefill: an unset or unexpected
 * NODE_ENV stays metered, and so does anything running on Vercel whatever
 * NODE_ENV claims.
 */
export function isUnmeteredEnvironment(env: { NODE_ENV?: string; VERCEL?: string } = process.env): boolean {
  return env.NODE_ENV === "development" && !env.VERCEL;
}

export function isInternalAccount(email: string | null | undefined): boolean {
  return INTERNAL_EMAILS.has((email ?? "").trim().toLowerCase());
}

/**
 * What a month of runs has cost, as a SQL expression.
 *
 * Exported so a test can inspect its bound parameters without a database.
 * The bug that made that worth doing: an earlier version interpolated a JS
 * `Date` here, which PGlite accepted and postgres-js refused - so the entire
 * offline suite passed and the live query threw.
 */
export const MONTHLY_CREDITS_USED = sql<number>`coalesce(sum(
  case
    when ${contactSourcingRuns.status} = 'pending'
     and ${contactSourcingRuns.createdAt} >
         (now() at time zone 'utc') - (interval '1 millisecond' * ${PENDING_STALE_MS})
    then 1
    else ${contactSourcingRuns.creditsSpent}
  end
), 0)::int`;

export type ContactCredits = {
  used: number;
  limit: number;
  remaining: number;
  unlimited: boolean;
  contactsPerRun: number;
};

export class NoContactCreditsError extends Error {
  constructor(public readonly limit: number) {
    super(
      limit === 0
        ? "Contact generation is part of Offerly Pro. Upgrade on the Billing page to use it."
        : `You have used all ${limit} contact generations for this month. ` +
            "They reset at the start of next month.",
    );
    this.name = "NoContactCreditsError";
  }
}

function startOfMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** Reads the allowance for the UI and for the gate below. Never throws. */
export async function getContactCredits(userId: string): Promise<ContactCredits> {
  const db = await getDb();

  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { plan: true, email: true },
  });

  const unlimited = isUnlimitedAccount(row?.email) || isUnmeteredEnvironment();
  const limit = MONTHLY_CONTACT_CREDITS[(row?.plan as Plan | undefined) ?? "free"];

  /**
   * What this month has cost, including what is currently being spent.
   *
   * Two rules in one sum:
   *
   *   FAILED RUNS ARE EXCLUDED. A provider error is not the student's spend.
   *
   *   AN IN-FLIGHT RUN COUNTS AS ONE, PROVISIONALLY. The pending row is
   *   written with zero credits - it is a lock, not a debit, and its real
   *   cost is known only when it settles. But if a pending run counted zero
   *   here, a student could open twenty tabs on twenty firms and start twenty
   *   paid workflows against a three-run allowance, because none of them
   *   would have settled yet. Counting it as one and letting it settle down
   *   to its true cost is the conservative direction: the worst case is a
   *   student briefly told they have fewer credits than they end up spending.
   *
   *   A pending row older than the staleness window counts zero, because
   *   nothing is running - see sourcing-run-policy.
   */
  /**
   * The cutoff is computed IN THE DATABASE, deliberately.
   *
   * Two reasons, both found the hard way. Interpolating a JS `Date` into a raw
   * `sql` template bypasses Drizzle's column-aware serializer, and postgres-js
   * then refuses it outright ("Received an instance of Date") - while PGlite
   * accepts it, so the whole offline suite passed and only the live driver
   * failed. And `created_at` is `timestamp without time zone` holding a UTC
   * wall clock, so a bare `now()` would compare it against the session zone.
   * `now() at time zone 'utc'` is the same clock the column was written with.
   * See db/utc-clock.ts.
   */
  const [count] = await db
    .select({ used: MONTHLY_CREDITS_USED })
    .from(contactSourcingRuns)
    .where(
      and(
        eq(contactSourcingRuns.userId, userId),
        gte(contactSourcingRuns.createdAt, startOfMonth()),
        ne(contactSourcingRuns.status, "failed"),
      ),
    );

  const used = count?.used ?? 0;

  return {
    used,
    limit,
    remaining: unlimited ? Number.POSITIVE_INFINITY : Math.max(0, limit - used),
    unlimited,
    contactsPerRun: CONTACTS_PER_RUN,
  };
}

/**
 * The second gate, once a run's pending row exists: whether that run is
 * within this month's allowance, counting every run up to and including it
 * in the order they were written. assertContactCredit alone was a check
 * before the write, so twenty runs started at once all passed it on the same
 * three remaining credits; here each counts the others' pending rows, and
 * only the first ones in line are within it.
 */
export async function runIsWithinAllowance(userId: string, runId: string): Promise<boolean> {
  const credits = await getContactCredits(userId);
  if (credits.unlimited) return true;
  const db = await getDb();
  const [count] = await db
    .select({ used: MONTHLY_CREDITS_USED })
    .from(contactSourcingRuns)
    .where(
      and(
        eq(contactSourcingRuns.userId, userId),
        gte(contactSourcingRuns.createdAt, startOfMonth()),
        ne(contactSourcingRuns.status, "failed"),
        sql`(${contactSourcingRuns.createdAt}, ${contactSourcingRuns.id}) <= (select created_at, id from contact_sourcing_runs where id = ${runId})`,
      ),
    );
  return (count?.used ?? 0) <= credits.limit;
}

/** Gate for the server action. Throws NoContactCreditsError when exhausted. */
export async function assertContactCredit(userId: string): Promise<ContactCredits> {
  const credits = await getContactCredits(userId);
  if (!credits.unlimited && credits.remaining <= 0) {
    throw new NoContactCreditsError(credits.limit);
  }
  return credits;
}
