import "server-only";

/**
 * One number per family of advisory lock, so that two families can never
 * collide.
 *
 * WHY THIS FILE EXISTS. Seven places take a Postgres advisory lock to make a
 * reservation exact - the shared rate limiter, the daily AI quota, the monthly
 * allowances, a practice round, the Help assistant's two, the video session and
 * the speech-to-text budget. Every one of them derived its key the same way:
 * `pg_advisory_xact_lock(hashtext('<name>:<id>'))`.
 *
 * `hashtext` returns an int4. All seven families were therefore sharing one
 * 32-bit space, and `hashtext` is Postgres's ordinary `hash_any` - stable,
 * documented, and reproducible offline by anyone. One of those keys takes an
 * attacker-chosen string from an endpoint that takes no session: the firm
 * code-send bucket is keyed on the email address typed into the sign-up form.
 * So a caller could search offline for a string whose hash equals
 * `hashtext('ai-quota:<some victim's uuid>')`, and then make that victim's
 * reservations queue behind a lock the attacker holds - and five of these
 * families WAIT for their lock, each waiter holding one of the eight web
 * connections while it does. That is the connection-pool lever the rate
 * limiter was just converted away from, reachable in the other five places
 * through the key space rather than through the limiter.
 *
 * The two-argument form of the lock functions takes (int4, int4) and keys on
 * the pair, so giving each family its own first argument makes the spaces
 * disjoint and removes the whole class: a collision now has to be found inside
 * one family, where every key is already a server-resolved id of that family's
 * own subject.
 *
 * Numbers are permanent. Never reuse one, and never renumber: two deploys of
 * different versions run against the same database during a rollout, and a
 * family that changed its number would not see the locks held by the other.
 */
export const LOCK_FAMILY = {
  /** lib/rate-limit - the shared per-(bucket, subject) limiter. Tried. */
  rateLimit: 1,
  /** lib/ai-runner - the daily AI call quota. */
  aiQuota: 2,
  /** lib/plan-quotas - the monthly per-feature allowances. */
  monthlyQuota: 3,
  /** lib/practice-session - one student's practice round. */
  practiceRound: 4,
  /** lib/help-gate - one student's own minute and day. */
  helpGateUser: 5,
  /** lib/help-gate - the shared daily spend ceiling. Tried, never waited for. */
  helpGateGlobal: 6,
  /** lib/video-interview/consent - one student's video session. */
  videoSession: 7,
  /** lib/video-interview/stt-budget - one student's day of audio. */
  sttBudget: 8,
} as const;

export type LockFamily = (typeof LOCK_FAMILY)[keyof typeof LOCK_FAMILY];
