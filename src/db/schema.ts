import {
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  boolean,
  integer,
  pgEnum,
  index,
  bigint,
  real,
  jsonb,
  uniqueIndex,
  doublePrecision,
  primaryKey,
  customType,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// ---------- enums ----------

export const relationshipStatusEnum = pgEnum("relationship_status", [
  "not_contacted",
  "reached_out",
  "in_conversation",
  "ongoing",
  "cold",
]);

export const applicationStatusEnum = pgEnum("application_status", [
  "not_started",
  "in_progress",
  "submitted",
  "interviewing",
  "offer",
  "rejected",
]);

export const eventTypeEnum = pgEnum("event_type", [
  "meeting",
  "coffee_chat",
  "deadline",
  "info_session",
  "personal",
  // Separate from "meeting" because it is the one kind of appointment the app
  // can help someone prepare for. Set by hand, or written by the interview
  // detector when a calendar entry names itself one - see lib/interview-prep.ts.
  "interview",
]);

export const googleSyncStatusEnum = pgEnum("google_sync_status", [
  "none",
  "pending",
  "synced",
  "dismissed",
]);

export const draftKindEnum = pgEnum("draft_kind", [
  "cold_outreach",
  "follow_up",
  "thank_you",
  // No fixed playbook: the student describes the situation and the model picks
  // the closest template, or writes one, rather than being forced into a kind
  // that does not fit.
  "custom",
]);

export const firmProgramCategoryEnum = pgEnum("firm_program_category", [
  "investment_banking",
  "private_equity",
  "venture_capital",
  "private_credit",
  "real_estate",
  "hedge_fund",
  "sales_trading",
  "asset_wealth_management",
  "commercial_banking",
  "insurance",
  "fintech",
  "market_infrastructure",
  "consulting",
  "other_finance",
]);

// Which kind of account a login is. Every existing row is a student, which is
// why "student" is the default - the column was added after the fact and a
// backfill that guessed anything else would silently grant posting rights.
export const accountTypeEnum = pgEnum("account_type", ["student", "club_lead", "firm"]);

// What the post's external link is FOR. A link to an external sign-up form and
// a link to a page with more detail want different words on the button, and
// "Details" on a registration deadline undersells it.
export const postLinkLabelEnum = pgEnum("post_link_label", [
  "details",
  "sign_up",
  "rsvp",
  "apply",
  "register",
]);

// What a community post is. Kept separate from eventTypeEnum on purpose: that
// one describes a *student's own* calendar entry, this one describes something
// an organisation is announcing to a room full of students.
export const postTypeEnum = pgEnum("post_type", [
  "event",
  "speaker_event",
  "coffee_chat",
  "deadline",
  "announcement",
]);

// Where a firm account sits inside its firm. The first account at a firm is
// approved by Offerly and becomes the owner; everyone after that is a member,
// approved - and removed - by the owner. Null for students and club leads.
export const firmRoleEnum = pgEnum("firm_role", ["owner", "member"]);

// "pro" is marketed as Pro ($30/mo); "pro_plus" as Pro+ ($50/mo, double the
// monthly feature quotas - see lib/plan-quotas). Free is the Internal Network
// (community) tier: networking, messages and profiles, nothing paid.
export const planEnum = pgEnum("plan", ["free", "pro", "pro_plus"]);

/** A student's answer to "may Offerly train its models on my writing?" - see users.trainingChoice. */
export const trainingChoiceEnum = pgEnum("training_choice", ["opted_in", "opted_out"]);

// Gates /admin/*. Everyone starts a student; flipped to admin by a one-off
// script, the same way `plan` is set manually today - there's no self-serve
// path to become an admin.
export const roleEnum = pgEnum("role", ["student", "admin"]);

// Which AI feature a usage row belongs to. Mirrors AiFeature in
// lib/model-registry — keep the two in sync when adding a feature.
export const aiFeatureEnum = pgEnum("ai_feature", [
  "firmMatch",
  "connectionAngle",
  "draft",
  "chat",
  "behavioralFeedback",
  "meetingTime",
  "speakerEvent",
  "technicalQuestion",
  "technicalGrading",
  "resumeReview",
  "resumeRewrite",
  // The crawler's posting extractor. It was added to AiFeature in
  // model-registry.ts and not here - the drift `drizzle-kit push` allows,
  // since there is no migration file to make the two move together. Harmless
  // only because runBackgroundAiFeature skips recordUsage today; the moment
  // background spend is metered it becomes a failing insert.
  "postingExtract",
  // Suggested answers for the drafter's hand-typed fields - lib/draft-suggestions.
  "draftSuggestions",
]);

export const applicationCategoryEnum = pgEnum("application_category", [
  "investment_banking",
  "private_equity",
  "real_estate",
  "hedge_fund",
  "asset_management",
  "corporate_finance",
  "consulting",
  "other",
]);

// ---------- schools ----------

// Allowlist of schools we recognise, keyed by the mail domain the school
// actually issues student addresses from. This table is what makes school
// affiliation trustworthy: a verified inbox at `emailDomain` is the *only*
// way `users.schoolId` gets set, so a student can't type a school they don't
// attend. A blocklist of personal providers (the previous approach) can't do
// that - anyone can buy a domain and it passes.
export const schools = pgTable("schools", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // Lowercase registrable domain, no leading dot or "@" (e.g. "upenn.edu").
  // Subdomains the school also issues from ("seas.upenn.edu") match this by
  // label-boundary suffix - see lib/school-verification.
  emailDomain: text("email_domain").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  // Every name this school goes by on LinkedIn, exactly as written there -
  // "University of Pennsylvania", "The Wharton School" - which is what a
  // people search filters on. The provider has no school id, only names, and
  // a word match on "University of Pennsylvania" also finds Indiana, West
  // Chester and Shippensburg University of Pennsylvania. See
  // lib/school-search-names. Null until first resolved.
  searchNames: text("search_names").array(),
  searchNamesCheckedAt: timestamp("search_names_checked_at", { withTimezone: true }),
  // The sharpest icon the school's own website publishes (its apple-touch-icon
  // or a sized <link rel=icon>), found by scripts/find-school-crests.ts. The
  // favicon service tops out at 16-64px for hundreds of schools, which is
  // what made crests blurry. /api/crest serves this when set, the favicon
  // service otherwise. Width 0 means vector (SVG). 0026, applied live first.
  crestUrl: text("crest_url"),
  crestWidth: integer("crest_width"),
  crestCheckedAt: timestamp("crest_checked_at", { withTimezone: true }),
});

export const schoolsRelations = relations(schools, ({ many }) => ({
  users: many(users),
}));

// ---------- users ----------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  school: text("school"),
  gradYear: integer("grad_year"),
  /**
   * The summer the student is actually trying to intern, e.g. 2028.
   *
   * Asked directly rather than inferred, because the inference is only usually
   * right. Investment banking recruits the junior-year summer, so a 2029 grad
   * wants Summer 2028 - but sophomore diversity programmes, five-year and
   * dual-degree students, MBA summer associates and anyone who took a gap year
   * all break `gradYear - 1`. Getting this wrong is not a cosmetic miss: it is
   * the difference between roles a student can apply to and roles whose cycle
   * closed a year ago.
   *
   * Null means unanswered, and internshipYearFor() falls back to the
   * inference rather than to showing everything.
   */
  targetInternshipYear: integer("target_internship_year"),
  targetGroup: text("target_group"), // e.g. "Investment Banking", "Private Equity"
  hometown: text("hometown"),
  /** A name from lib/countries, picked under hometown in onboarding. */
  homeCountry: text("home_country"),
  // Field of study. Matched against a contact's `degree` when ranking who is
  // likely to reply - a shared major is a specific, warm thing to open a cold
  // email with, and it was the one overlap the directory could describe on its
  // side but we had nothing to compare it to on the student's.
  major: text("major"),
  interests: text("interests"), // free text, e.g. "college football, poker, hiking"
  // Free text the student writes specifically to be shown on their PUBLIC
  // profile (/u/[id]) - unlike everything else on this row, which is private
  // matching input only. Distinct from `interests`/`hometown` above rather
  // than reusing them, because those two are shown to other students only
  // when the student flips the toggles below. (Both are sent to the contact
  // provider as search keywords regardless - see lib/contact-sourcing-agent.)
  aboutMe: text("about_me"),
  showHometownOnProfile: boolean("show_hometown_on_profile").notNull().default(false),
  showInterestsOnProfile: boolean("show_interests_on_profile").notNull().default(false),
  motivations: text("motivations"), // free text: why finance, what they're looking for
  proudExperience: text("proud_experience"), // free text: accomplishment/initiative signal
  workStyle: text("work_style"), // free text: fast-paced/deal-driven vs. analytical/research-heavy
  challengeLearned: text("challenge_learned"), // free text: setback/growth signal
  preferredCategories: text("preferred_categories").array(), // firm_program_category values
  /**
   * The paid news sources the student can read (ids from
   * src/lib/news/access.ts PAID_PUBLISHERS), often through their school
   * library. Null until they say; the News page then assumes none.
   */
  newsAccess: text("news_access").array(),
  nicheInterests: text("niche_interests").array(), // free-form granular sub-sector tags
  ibTierPreferences: text("ib_tier_preferences").array(), // Bulge Bracket / Elite Boutique / Middle-Market
  peTierPreferences: text("pe_tier_preferences").array(), // Mega-Fund / Middle-Market / Growth Equity / Venture Capital
  targetLocations: text("target_locations").array(), // cities/regions the student wants to work in
  // ---- deepened onboarding (see lib/onboarding-questions.ts) ----
  // Drives how much the app explains vs. gets out of the way, and is a strong
  // hint to the firm matcher about how much exploration to favour.
  recruitingStage: text("recruiting_stage"),
  priorExperience: text("prior_experience").array(),
  /**
   * Past and current internships, entered on the profile's About you. The
   * firm is the student's own words; firmId/website are set when they picked
   * it from our directory, which is what gives it a logo.
   */
  internships: jsonb("internships")
    // start/end are "YYYY-MM"; end null = ongoing ("May 2026 - Now").
    .$type<{ firm: string; firmId: string | null; website: string | null; role: string; start: string | null; end: string | null; current: boolean }[]>()
    .notNull()
    .default([]),
  clubsAndActivities: text("clubs_and_activities"),
  technicalReadiness: text("technical_readiness"),
  // Consecutive questions passed in practice, carried across sessions and
  // reset to 0 on a fail. Kept on the user rather than derived from attempts
  // because a streak spans sessions and would otherwise need a scan every read.
  practiceCurrentStreak: integer("practice_current_streak").default(0).notNull(),
  practiceBestStreak: integer("practice_best_streak").default(0).notNull(),
  // When the newest practice question this student had graded was served
  // (lib/practice-seal). Grading only moves forward past it, so one question
  // whose answer is known cannot be submitted over and over for a streak.
  practiceLastSealedAt: timestamp("practice_last_sealed_at"),
  sponsorshipNeeded: text("sponsorship_needed"),
  gpaBand: text("gpa_band"),
  /**
   * Which degree the student is enrolled in: "bachelors", "masters", "phd".
   *
   * Decides which postings they can actually apply to, and the three tracks
   * genuinely do not overlap. Lazard, BlackRock and Jefferies all require
   * Summer Analyst candidates to be undergraduates in their penultimate year,
   * so an MBA student is not eligible for one however much it looks like a
   * finance internship; the MBA equivalent is the Summer Associate programme,
   * which BlackRock opens to MBAs and advanced master's (MS Finance, MSFE)
   * and to nobody else. Quant firms - IMC, SIG, Citadel Securities - post
   * BS/MS and PhD versions of the same research internship as separate
   * requisitions.
   *
   * Null for every account created before this question existed. Null means
   * "do not filter", not "bachelors": guessing costs a student real openings,
   * and an unfiltered list is recoverable where a silently narrowed one is not.
   */
  degreeLevel: text("degree_level"),
  /**
   * The exact programme, in the student's own words: "BS Business
   * Administration", "MS Financial Engineering", "MBA".
   *
   * degreeLevel decides eligibility; this is for the student and for anything
   * that writes on their behalf. Free text on purpose - the space of real
   * degree names is not enumerable, and a dropdown that omits someone's
   * programme teaches them the product does not know their world.
   */
  degreeProgram: text("degree_program"),
  // Question keys the student explicitly marked "not sure yet". Recorded
  // rather than left null on purpose: null means "never asked", this means
  // "asked, and genuinely undecided" - which tells the matcher to prefer firms
  // with broad exposure and tells the UI to surface Discovery content instead
  // of assuming a preference the student doesn't have.
  onboardingUnsure: text("onboarding_unsure").array(),
  // Plain text extracted from the uploaded resume, so matching and outreach
  // can read it without re-parsing the file on every call.
  resumeText: text("resume_text"),
  resumeParsedAt: timestamp("resume_parsed_at"),
  linkedinUrl: text("linkedin_url"),
  /**
   * A photo the student uploaded, as its key in stored_files (kind "avatar").
   *
   * Null is the normal state and not a gap: the school crest is the default
   * picture, which is the whole reason the feed is scannable - a column of
   * crests tells you who is from where, and a column of grey initials tells
   * you nothing. A photo overrides it when there is one.
   */
  avatarStoragePath: text("avatar_storage_path"),

  resumeFilename: text("resume_filename"), // original filename, for display
  resumeStoragePath: text("resume_storage_path"), // key in stored_files (kind "resume")
  /**
   * Unguessable token for the public resume link that outreach emails carry.
   *
   * Separate from the storage path on purpose: the path is an internal key and
   * must never appear in a URL, and a token can be rotated to kill every link
   * already sent without touching the file. Anyone holding the link can fetch
   * the resume - that is the point of putting it in an email - so it is random,
   * never sequential, and null until the student first shares one.
   *
   * No unique constraint: adding one to a populated table made drizzle-kit
   * offer to TRUNCATE users, and a 128-bit random token does not need the
   * database to police collisions.
   */
  resumeShareToken: text("resume_share_token"),
  /**
   * How many firms matched this student's sectors the last time AI matching
   * ran, and when.
   *
   * Stored rather than derived from a firms.createdAt because the firms table
   * has no timestamp, and backfilling one would make all 22,000 existing rows
   * look new to every student at once. Comparing counts answers the only
   * question that matters - "has the directory grown since I last matched?" -
   * without touching the firms table.
   */
  topFirmsEligibleCount: integer("top_firms_eligible_count"),
  topFirmsMatchedAt: timestamp("top_firms_matched_at"),
  // How many firms the last match run was aiming for. Without it, "we already
  // tried for a hundred and the pool only had eighty" is indistinguishable from
  // "we filled this list to twenty-four back when twenty-four was the target" -
  // and the difference decides whether the next page load should spend an LLM
  // call topping the list up.
  topFirmsTarget: integer("top_firms_target"),
  // Set once the post-signup LinkedIn/resume prompt is shown (filled or
  // skipped); null means the signup flow should route the user through
  // /onboarding/links before the sector wizard.
  profileLinksPromptedAt: timestamp("profile_links_prompted_at"),
  // Set once the post-signup onboarding wizard is completed; null means the
  // (app) layout should redirect the user into /onboarding instead.
  onboardingCompletedAt: timestamp("onboarding_completed_at"),

  /**
   * Which version of the privacy policy and terms this account agreed to, and
   * when (see POLICY_VERSION in lib/policy.ts).
   *
   * Two columns rather than a single boolean because "did they agree?" is the
   * wrong question - the one that matters later is "what exactly did they
   * agree to, and on what date?". A boolean silently carries a 2026 consent
   * forward across a 2027 policy that says something different.
   *
   * Null on rows created before consent was gated. Those accounts are
   * re-prompted on their next page load rather than grandfathered: data
   * collected under a policy that did not mention model training cannot be
   * used for model training, and a nullable column is what makes that
   * distinction checkable instead of assumed.
   */
  consentedPolicyVersion: text("consented_policy_version"),
  consentedAt: timestamp("consented_at"),
  /**
   * The student's opt-in to having their profile shared with firms, so a
   * recruiter can find them on Student matching and reach out. Separate from
   * consentedPolicyVersion on purpose: agreeing to the terms is required to use
   * Offerly, sharing with firms is not, and the two must never be one tick.
   *
   * Null means not shared - the default for every account, including every one
   * created before this existed. The policy version is kept beside the time for
   * the same reason as above: a yes given under a policy that described sharing
   * one way is not a yes to a later policy that describes it differently, and
   * lib/firm-sharing only counts an opt-in given under the current version.
   * Turning it off clears both, and takes effect on the firm's next page load.
   */
  firmSharingOptedInAt: timestamp("firm_sharing_opted_in_at"),
  firmSharingPolicyVersion: text("firm_sharing_policy_version"),
  /**
   * Whether this student's writing may be used to train Offerly's models
   * (Training Use in the privacy policy). Separate from consentedPolicyVersion
   * for the same reason firm sharing is: agreeing to the terms is required,
   * training is a choice. The policy makes it opt-out, so the consent screen
   * and sign-up offer it ticked, and Settings can change it at any time.
   *
   * Null means the student has not been asked yet and is treated as NO:
   * lib/training-consent only lets capture and export touch rows whose choice
   * is opted_in, recorded under the current policy version. Every change is
   * also written to consent_events, which outlives the account.
   */
  trainingChoice: trainingChoiceEnum("training_choice"),
  trainingChoiceAt: timestamp("training_choice_at"),
  trainingChoicePolicyVersion: text("training_choice_policy_version"),
  phone: text("phone"), // for SMS features, E.164 format
  /**
   * The IANA zone the student picked on their profile ("America/Chicago"), or
   * null for Automatic - follow whatever their browser reports. On the account
   * rather than in a cookie so a pick made on a laptop holds on their phone.
   * Read through lib/time-zone-server, never directly.
   */
  timeZone: text("time_zone"),
  // School verification: proves the student controls an inbox at the school
  // they claim, so speaker-event/alumni-facing data stays trustworthy. Not a
  // real SSO/VPN integration — there's no single API across schools for that.
  schoolEmail: text("school_email"),
  /**
   * The address a code was just sent to, while it is still unconfirmed.
   *
   * Separate from `schoolEmail` so that asking for a code cannot cost a
   * student the verification they already have. Re-verifying used to be
   * refused outright ("contact support to change schools"), and the request
   * step wrote straight over schoolEmail/schoolId - fine while the flow was a
   * dead end, wrong the moment changing school became something a student can
   * do for themselves. Abandoning a change now leaves the old school intact.
   */
  pendingSchoolEmail: text("pending_school_email"),
  schoolEmailVerifiedAt: timestamp("school_email_verified_at"),
  schoolVerificationCodeHash: text("school_verification_code_hash"),
  schoolVerificationExpiresAt: timestamp("school_verification_expires_at"),
  // Wrong-code counter for the *current* outstanding code. A 6-digit code is
  // only 1M possibilities, which is brute-forceable inside the 15-minute
  // window without a cap, so the code is burned after MAX_CODE_ATTEMPTS.
  // Reset to 0 every time a new code is issued.
  schoolVerificationAttempts: integer("school_verification_attempts").default(0).notNull(),
  // The school that owns the verified email's domain. Written only by
  // confirmSchoolVerification, never by the profile form - so unlike the free
  // text `school` column above, this one can be trusted. When it's set, the
  // profile form shows `schools.name` and ignores any submitted school value.
  schoolId: uuid("school_id").references(() => schools.id),
  // The school the student PICKED at signup, off the same allowlist. Kept in a
  // separate column from `schoolId` on purpose: that one is the trust boundary
  // and is written only by confirmSchoolVerification, so letting a form set it
  // would quietly turn "verified affiliation" into "typed a school". This one
  // is self-reported and carries no weight - it exists so the feed can show a
  // crest and so matching has a hint before anyone verifies. Read it only
  // AFTER schoolId, never instead of it.
  claimedSchoolId: uuid("claimed_school_id").references(() => schools.id),
  // ---- account type: student / club lead / firm ----
  // Students read the community feed; clubs and firms also post to it.
  accountType: accountTypeEnum("account_type").default("student").notNull(),
  // An org account can only post once someone has vetted it. Deliberately a
  // separate flag from accountType rather than a fourth "pending" type: the
  // type says what an account IS, this says whether we trust it yet, and
  // collapsing the two would make an un-approved club indistinguishable from
  // a student in every query that switches on type. Meaningless for students.
  orgApproved: boolean("org_approved").default(false).notNull(),
  // The organisation a club_lead / firm account posts on behalf of. Exactly
  // one is set, matching accountType; both are null for a student. Nullable
  // even for orgs because the account exists before it is linked and approved.
  clubId: uuid("club_id").references(() => clubs.id, { onDelete: "set null" }),
  orgFirmId: uuid("org_firm_id").references(() => firms.id, { onDelete: "set null" }),
  // Owner or member of orgFirmId. Only meaningful for a firm account; see
  // firmRoleEnum. Null until the account is approved into a firm.
  firmRole: firmRoleEnum("firm_role"),
  // A demo account: the student demo and the firm demo. The one account kind
  // that may sign in to the firm portal with a password instead of a code to
  // a work inbox, and the only accounts that ever see demo firms' posts.
  isDemo: boolean("is_demo").default(false).notNull(),
  // A seeded example student (scripts/seed-sample-peers.ts): realistic
  // onboarding answers so Meet Peers and Connect have people in them before
  // real students do. No usable password and an .invalid email, so it can
  // never sign in or be mailed; shown with a "Sample" tag; removed with
  // --remove. 0026, applied to live first.
  isSample: boolean("is_sample").default(false).notNull(),
  // When this firm account last opened its notification center. Firm
  // notifications belong to the firm, not the person (firm_notifications), so
  // "unread" is simply "newer than this". Null for everyone else.
  firmNotificationsSeenAt: timestamp("firm_notifications_seen_at"),
  // Billing tier. Drives which sections open at all (lib/plan-access), the
  // monthly feature quotas (lib/plan-quotas), model selection
  // (lib/model-registry) and the daily AI quota. Kept current by the Stripe
  // webhook (app/api/stripe/webhook): subscription active -> its price's
  // plan, anything else -> free. Never trust this column from the client.
  plan: planEnum("plan").default("free").notNull(),
  // The Stripe Customer this account pays through. Created the first time the
  // student opens Checkout and reused forever after, so one student never
  // becomes two customers. The webhook maps subscription events back to the
  // account through this (plus the user id in the customer's metadata).
  stripeCustomerId: text("stripe_customer_id").unique(),
  // The live subscription, when there is one. Informational - the webhook
  // rewrites `plan` from the subscription's own state and never reads this
  // back - but it makes support ("which sub is this account on?") one lookup
  // instead of a Stripe dashboard search.
  stripeSubscriptionId: text("stripe_subscription_id"),
  role: roleEnum("role").default("student").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const usersRelations = relations(users, ({ one, many }) => ({
  verifiedSchool: one(schools, { fields: [users.schoolId], references: [schools.id] }),
  contacts: many(contacts),
  applications: many(applications),
  events: many(events),
  behavioralAnswers: many(behavioralAnswers),
  topFirms: many(userTopFirms),
  emailDrafts: many(emailDrafts),
  sessions: many(sessions),
}));

// ---------- auth sessions ----------

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // SHA-256 hash of the opaque token stored in the session cookie — the raw
  // token is never persisted, so a DB read alone can't be used to log in.
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

// ---------- contacts (personal CRM) ----------

export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  firm: text("firm"),
  role: text("role"),
  linkedinUrl: text("linkedin_url"),
  email: text("email"),
  /**
   * How much the address above is worth trusting.
   *
   * "confirmed"  - the provider returned it and the mail server accepted it
   * "unverified" - the provider returned it, nobody could confirm it
   * "inferred"   - WE built it from the firm's pattern; no one has checked it
   *
   * Never null when `email` is set. A student about to write to someone they
   * want to impress is entitled to know which of these they are holding.
   */
  /** What the student is shown: verified | catch_all | predicted | unavailable.
   *  Legacy rows still carry confirmed | unverified | inferred until backfill. */
  emailConfidence: text("email_confidence"),
  /**
   * The frontend gate. A non-null `email` is NOT sufficient to render.
   *
   * Defaults false so every row written before the relevance gate existed is
   * non-renderable until it has been re-judged - fail closed. This is what
   * kept vikram.jolly@greenhill.com on an Evercore page: the old renderer
   * asked only whether the column was set.
   */
  emailDomainRelevant: boolean("email_domain_relevant").notNull().default(false),
  /** Diagnostics only. Never rendered. The provider's own address, even when
   *  it was rejected, and their own word for its deliverability. */
  emailRawProvider: text("email_raw_provider"),
  emailStatusRaw: text("email_status_raw"),
  /** Why the provider's address was not used. See EmailRejectionReason. */
  emailRejectionReason: text("email_rejection_reason"),
  /** "crustdata" | "pattern_inference" | null. A pattern-derived address may
   *  never become pattern evidence, so its origin has to be recorded. */
  emailSource: text("email_source"),
  school: text("school"), // for future match/relevance scoring
  /**
   * The two facts that make one contact at a firm different from another.
   *
   * Without them every alum at the same firm scores identically - same school,
   * has email, on LinkedIn - and the match column cannot tell a student which
   * of five people to write to first. Both come back on every sourced profile
   * and cost nothing extra to keep.
   */
  gradYear: integer("grad_year"),
  /** Where they work now. Never read as a hometown. */
  currentCity: text("current_city"),
  background: text("background"), // free text: prior firm, group, etc.
  notes: text("notes"),
  relationshipStatus: relationshipStatusEnum("relationship_status")
    .default("not_contacted")
    .notNull(),
  lastContactDate: date("last_contact_date"),
  // enrichment placeholders for v2 (LinkedIn/web sourcing)
  sourceUrl: text("source_url"),
  enrichedAt: timestamp("enriched_at"),
  // Set when this contact was auto-added from the global recruiting directory
  // after a firm match. Makes the auto-add idempotent (re-matching the same
  // firm won't duplicate) and marks the row as reference data rather than
  // someone the student sourced themselves.
  firmRecruitingContactId: uuid("firm_recruiting_contact_id"),
  // last AI-generated "why connect" suggestion + the student's feedback on it
  connectionAngle: text("connection_angle"),
  connectionAngleFeedback: text("connection_angle_feedback"), // 'helpful' | 'not_helpful' | null
  /**
   * Contact generation's own record of how this row was chosen, so a run's
   * outcomes (drafts, sent, replies, removals) can be compared across
   * algorithm versions. Null on every row from before 2026-10-08 and on
   * contacts a student added themselves.
   *
   * Numbers, kinds and categories only - see SourcingRecord in
   * lib/contact-pool. Never a search term, club, interest or hometown.
   */
  sourcingRunId: uuid("sourcing_run_id").references(() => contactSourcingRuns.id, { onDelete: "set null" }),
  /** 1-based position in the run's final selection. */
  sourcingRank: integer("sourcing_rank"),
  sourcingScore: jsonb("sourcing_score"),
  sourcingRetrieval: jsonb("sourcing_retrieval"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [index("contacts_sourcing_run_idx").on(table.sourcingRunId)]);

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  user: one(users, { fields: [contacts.userId], references: [users.id] }),
  applicationLinks: many(applicationContacts),
  events: many(events),
  emailDrafts: many(emailDrafts),
  outreachSends: many(outreachSends),
}));

// ---------- applications ----------

export const applications = pgTable(
  "applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    firm: text("firm").notNull(),
    role: text("role").notNull(),
    status: applicationStatusEnum("status").default("not_started").notNull(),
    category: applicationCategoryEnum("category"),
    compensation: integer("compensation"), // student-entered estimated annual comp, USD
    applicationUrl: text("application_url"),
    notes: text("notes"),
    appliedDate: date("applied_date"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    /**
     * One application per (student, firm, role). Enforced here, not by the
     * code that inserts.
     *
     * `(firm, role)` is already treated as the identity of an application
     * everywhere that matters - getTrackedKeys builds a Set of `firm|role`,
     * untrackFirm deletes by firm name, and autoTrackInternships reads the
     * existing pairs before inserting. That read-then-insert was the only
     * thing holding the invariant up, and it loses to anything concurrent:
     * two Discovery renders, a match running while a page loads, a
     * double-click.
     *
     * Measured on Supabase, 22 September 2026: demo@offerly.test held 41 rows
     * covering 22 distinct pairs - nineteen duplicates, every one of them at
     * Evercore, each role listed twice in the tracking panel. It also made the
     * product contradict itself on screen, because the two surfaces count
     * differently: Discovery said "You're tracking 22 roles" from the Set,
     * /tracking said "41 roles across 3 firms" from the rows.
     *
     * Exactly the same lesson as internship_postings_firm_role_year_key
     * below, in the table next door, for exactly the same reason. A
     * convention held up by application code is not a constraint.
     *
     * Duplicates must be collapsed before this can be applied:
     * scripts/dedupe-tracked-applications.ts.
     */
    uniqueIndex("applications_user_firm_role_key").on(
      table.userId,
      table.firm,
      table.role,
    ),
  ],
);

export const applicationsRelations = relations(
  applications,
  ({ one, many }) => ({
    user: one(users, {
      fields: [applications.userId],
      references: [users.id],
    }),
    contactLinks: many(applicationContacts),
    events: many(events),
  }),
);

// join table: applications <-> contacts (many-to-many)
export const applicationContacts = pgTable("application_contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: uuid("application_id")
    .notNull()
    .references(() => applications.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id")
    .notNull()
    .references(() => contacts.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const applicationContactsRelations = relations(
  applicationContacts,
  ({ one }) => ({
    application: one(applications, {
      fields: [applicationContacts.applicationId],
      references: [applications.id],
    }),
    contact: one(contacts, {
      fields: [applicationContacts.contactId],
      references: [contacts.id],
    }),
  }),
);

// ---------- the one-time heads-up bars this student has already seen ----------

/**
 * One row per flash shown, so it is never shown twice.
 *
 * A flash is the bubble that drops across the top of the page for a few
 * seconds: the application-opening heads-up about a firm, the prep reminder
 * before an interview, and whatever comes next. It has no dismiss state because
 * it dismisses itself, which means "they have seen this" has to be written when
 * it is SHOWN rather than when it is closed.
 *
 * `flashKey` identifies the firing, not the job - "this firm, this opening" or
 * "this interview, at the three-day mark" - so a prompt with several thresholds
 * speaks once at each of them and never twice at the same one. The keys are
 * built in the modules that own each prompt; nothing here parses them.
 */
export const flashesShown = pgTable(
  "flashes_shown",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    flashKey: text("flash_key").notNull(),
    shownAt: timestamp("shown_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("flashes_shown_user_key_idx").on(t.userId, t.flashKey)],
);

export const flashesShownRelations = relations(flashesShown, ({ one }) => ({
  user: one(users, { fields: [flashesShown.userId], references: [users.id] }),
}));

// ---------- the notification list behind the bell ----------

/**
 * What a notification is about: writing to a firm before its application
 * opens, preparing for an interview, chasing a cold email that has gone a week
 * without a reply (the follow-up ladder - see lib/outreach-ladder.ts), or
 * thanking someone after a coffee chat or call (lib/thank-you.ts).
 */
export const notificationKindEnum = pgEnum("notification_kind", [
  "outreach",
  "interview_prep",
  "follow_up",
  "thank_you",
  // One of the student's matched firms posted an internship or an event on
  // the firm portal. See lib/firm-delivery.
  "firm_posting",
  "firm_event",
  // An open application the student has not applied to, as its deadline
  // nears. See lib/application-reminders.
  "application_deadline",
]);

/**
 * One row per thing the student still has to do, as the bell shows it.
 *
 * Deliberately NOT a log. A prompt that fires twice is one job, not two, so
 * `dedupeKey` is unique per student and a repeat firing bumps the row to the
 * top of the list instead of adding a second - and, if it had been closed,
 * reopens it, because a prompt only fires again when the work is live again.
 *
 * The display copy is denormalised onto the row rather than re-derived at read
 * time. A notification is a record of what the student was told, and it should
 * keep saying that even after the thing it was about has changed underneath.
 *
 * Two ways a row closes, and they are different facts:
 *   - `done_source = 'manual'`: the student ticked it off.
 *   - `done_source = 'auto'`:   the app watched them finish it (every contact
 *     at that firm written to).
 *   - `done_source = 'expired'`: nobody did it and the moment passed. Closed,
 *     never called done.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: notificationKindEnum("kind").notNull(),
    /** Identifies the JOB, not the firing. Unique per student. */
    dedupeKey: text("dedupe_key").notNull(),
    /** What the completion check watches - a normalised firm name for outreach. */
    subjectKey: text("subject_key"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    href: text("href").notNull(),
    /** When the thing it is about stops being worth doing, if it ever does. */
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    /** Last time this fired. The list is ordered by it, newest first. */
    bumpedAt: timestamp("bumped_at").defaultNow().notNull(),
    readAt: timestamp("read_at"),
    doneAt: timestamp("done_at"),
    /** "manual" | "auto" | "expired". Null while the row is open. */
    doneSource: text("done_source"),
  },
  (t) => [
    uniqueIndex("notifications_user_key_idx").on(t.userId, t.dedupeKey),
    index("notifications_user_bumped_idx").on(t.userId, t.bumpedAt),
  ],
);

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}));

// ---------- events (meetings + deadlines, unified for calendar/reminder views) ----------

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  type: eventTypeEnum("type").notNull(),
  /**
   * Who decided `type`: "student" (chosen or changed on the Schedule) or
   * "detected" (the interview detector re-filed it from its words). Null for
   * rows from before this was recorded. The detector never overrules
   * "student": re-filing a tagged interview as a meeting sticks.
   */
  typeSource: text("type_source"),
  /** When the detector re-filed it, and the words it matched ("superday"). */
  typeDetectedAt: timestamp("type_detected_at"),
  typeDetectedFrom: text("type_detected_from"),
  title: text("title").notNull(),
  notes: text("notes"),
  eventDate: timestamp("event_date").notNull(),
  // Optional — when set, the event spans eventDate..endDate (e.g. a 1-3pm
  // class) instead of using a type-based default duration on the calendar.
  endDate: timestamp("end_date"),
  completed: boolean("completed").default(false).notNull(),
  // optional links
  contactId: uuid("contact_id").references(() => contacts.id, {
    onDelete: "set null",
  }),
  applicationId: uuid("application_id").references(() => applications.id, {
    onDelete: "set null",
  }),
  // Google Calendar sync. Events are pushed automatically whenever a Google
  // connection exists; googleSyncStatus "pending" only survives for rows
  // created before that gate was removed.
  googleEventId: text("google_event_id"),
  // Which Google calendar the copy actually lives on. Normally the student's
  // dedicated "Offerly" calendar, but rows synced before that switch point at
  // "primary" - update and delete have to target the right one, so it is
  // recorded per event rather than assumed.
  googleCalendarId: text("google_calendar_id"),
  // Google Meet URL, for event types that are a conversation with someone
  // (meeting / coffee chat / info session). Null for deadlines and personal
  // entries, which get no conference link.
  googleMeetUrl: text("google_meet_url"),
  googleSyncStatus: googleSyncStatusEnum("google_sync_status").default("none").notNull(),
  // Set when the run-up reminder email actually went out. Doubles as the
  // idempotency guard for the reminder job - a cron that fires twice, or a
  // retry after a partial failure, must not email the student the same
  // deadline again.
  reminderEmailSentAt: timestamp("reminder_email_sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const eventsRelations = relations(events, ({ one }) => ({
  user: one(users, { fields: [events.userId], references: [users.id] }),
  contact: one(contacts, {
    fields: [events.contactId],
    references: [contacts.id],
  }),
  application: one(applications, {
    fields: [events.applicationId],
    references: [applications.id],
  }),
}));

// ---------- interview prep: behavioral question practice ----------

export const behavioralQuestions = pgTable("behavioral_questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  category: text("category").notNull(), // e.g. "Foundational", "Teamwork & Leadership"
  prompt: text("prompt").notNull(),
  guidance: text("guidance"), // short tip on what a strong answer covers
  orderIndex: integer("order_index").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const behavioralQuestionsRelations = relations(behavioralQuestions, ({ many }) => ({
  answers: many(behavioralAnswers),
}));

export const behavioralAnswers = pgTable("behavioral_answers", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  questionId: uuid("question_id")
    .notNull()
    .references(() => behavioralQuestions.id, { onDelete: "cascade" }),
  answerText: text("answer_text").notNull(),
  aiFeedback: text("ai_feedback"),
  feedbackGeneratedAt: timestamp("feedback_generated_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const behavioralAnswersRelations = relations(behavioralAnswers, ({ one }) => ({
  user: one(users, {
    fields: [behavioralAnswers.userId],
    references: [users.id],
  }),
  question: one(behavioralQuestions, {
    fields: [behavioralAnswers.questionId],
    references: [behavioralQuestions.id],
  }),
}));

// ---------- AI-generated email drafts ----------

export const emailDrafts = pgTable("email_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").references(() => contacts.id, {
    onDelete: "set null",
  }),
  kind: draftKindEnum("kind").default("cold_outreach").notNull(),
  /** The student's own description of what this email is for. Required for
   *  "custom", useful context for every other kind. */
  purpose: text("purpose"),
  /** Which template the model built from, so the draft can say so and offer to
   *  rebuild with a different one. Null for drafts written before templates. */
  templateId: text("template_id"),
  /** What the draft still needs from the student: [{ id, question, placeholder }].
   *  Same idea as the resume rewrite - the model marks a gap rather than
   *  inventing a fact to fill it. */
  gaps: jsonb("gaps"),
  /** What the student entered in the form: [{ label, value }], in form order.
   *  Labelled rather than keyed by field name, so the history page can show it
   *  as-is even after the form's fields change. Null for drafts made before it. */
  inputs: jsonb("inputs"),
  subject: text("subject").notNull(),
  body: text("body").notNull(),

  /**
   * The answers the drafter suggested for this email's hand-typed fields, and
   * what the student did with each: [{ field, suggested, source, basis,
   * submitted, outcome: "used" | "edited" | "ignored" }]. Which connections a
   * student trusts enough to send, beside the drafted-vs-sent pair below, is
   * how the suggestions learn what works. Null for drafts made without any.
   */
  suggestions: jsonb("suggestions"),

  /**
   * What the MODEL wrote, frozen at generation and never updated afterwards.
   *
   * `subject`/`body` above are the working copy - updateDraft overwrites them
   * every time the student edits, which until now destroyed the only record of
   * what was actually generated. Keeping the original beside it is what makes
   * the edit delta computable: model output vs. what a human decided to send
   * instead is the single highest-value training signal this product can
   * collect, and it costs two columns and no user effort to keep.
   *
   * Null for drafts created before this existed - which is the correct reading
   * of "we don't know what the model originally wrote", and distinguishable
   * from "the student changed nothing" (where these equal subject/body).
   */
  modelSubject: text("model_subject"),
  modelBody: text("model_body"),

  /**
   * Set when the draft is pushed into the student's Gmail drafts folder.
   *
   * The closest thing to a "sent" signal this product can honestly observe:
   * Offerly never sends the email itself (see saveDraftToGmail), so the last
   * verifiable step is the student moving it into their own mailbox. Treated
   * as intent to send, not proof of sending.
   */
  pushedToGmailAt: timestamp("pushed_to_gmail_at"),

  /**
   * When the student sent this email, as far as Offerly can tell: set when
   * they copy it out of the composer (which is how an email leaves Offerly)
   * or tick "I sent this", cleared when they untick it. Still the student's
   * word, not proof - Offerly never sees their outbox.
   */
  sentAt: timestamp("sent_at"),

  /**
   * Self-reported by the student. Deliberately nullable with three states:
   * true (they said it got a reply), false (they said it didn't), and null
   * (never asked, or never answered) - because "no reply yet" and "we never
   * found out" are different facts and collapsing them into a boolean would
   * silently label every unanswered draft a failure.
   */
  gotReply: boolean("got_reply"),
  repliedAt: timestamp("replied_at"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const emailDraftsRelations = relations(emailDrafts, ({ one }) => ({
  user: one(users, { fields: [emailDrafts.userId], references: [users.id] }),
  contact: one(contacts, {
    fields: [emailDrafts.contactId],
    references: [contacts.id],
  }),
}));

// ---------- the cold-email ladder: which emails went to whom, and when ----------

/**
 * One row per cold email a student sent to one contact - the first email and
 * up to two follow-ups, never more (see lib/outreach-ladder.ts).
 *
 * A row is written when the student copies a draft out of the composer, which
 * is how an email leaves Offerly now, or when they tick "Mark sent" for one
 * they wrote somewhere else. Either way it is the student's own account of
 * what happened: Offerly sends nothing and cannot see their outbox.
 *
 * Whether the person REPLIED is not here. It lives on the contact, as
 * relationshipStatus "in_conversation", because that is what the rest of the
 * app already reads as "they wrote back" - a reply is a fact about the
 * relationship, not about any one email.
 */
export const outreachSends = pgTable(
  "outreach_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** 1 for the first cold email, 2 and 3 for the follow-ups. */
    step: integer("step").notNull(),
    sentAt: timestamp("sent_at").defaultNow().notNull(),
    /** The Offerly draft that was copied. Null for one marked sent by hand. */
    draftId: uuid("draft_id").references(() => emailDrafts.id, { onDelete: "set null" }),
    /** "copy" | "manual". */
    source: text("source").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    // One email per rung. A second copy of the same draft, or a double-click
    // on "Mark sent", lands on the same row instead of climbing the ladder.
    uniqueIndex("outreach_sends_contact_step_idx").on(t.contactId, t.step),
    index("outreach_sends_user_idx").on(t.userId),
  ],
);

export const outreachSendsRelations = relations(outreachSends, ({ one }) => ({
  user: one(users, { fields: [outreachSends.userId], references: [users.id] }),
  contact: one(contacts, { fields: [outreachSends.contactId], references: [contacts.id] }),
  draft: one(emailDrafts, { fields: [outreachSends.draftId], references: [emailDrafts.id] }),
}));

// ---------- the "Today" to-do list: what was shown, and what was ticked ----------

/**
 * Tasks a student ticked off by hand on the to-do list, so they stay gone.
 *
 * Most tasks leave the list on their own when the work is done - a round
 * played, an email sent. This is for the rest: a firm they have decided not
 * to find anyone at, a meeting they already know went fine. The task ids are
 * built by lib/today-tasks.ts and carry whatever makes one occurrence of a
 * task different from the next (a date, a rung), so ticking this week's
 * catch-up does not silence next month's.
 */
export const todoDismissals = pgTable(
  "todo_dismissals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    taskId: text("task_id").notNull(),
    dismissedAt: timestamp("dismissed_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("todo_dismissals_user_task_idx").on(t.userId, t.taskId)],
);

/**
 * The five tasks a student was shown today, as they read at the time.
 *
 * Kept so a finished task can stay on the list crossed out instead of
 * vanishing - the app only knows a task is done by it no longer being owed,
 * and by then its words are gone. One row per batch of five: batch 1 is the
 * day's first five, and "Load the next 5" writes batch 2, and so on. `day` is
 * the student's own calendar day, so a new day starts a new list.
 */
export const todoBatches = pgTable(
  "todo_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    batch: integer("batch").notNull(),
    /** [{ id, kind, title, detail, href, score, doneKey? }], in list order. */
    items: jsonb("items").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("todo_batches_user_day_batch_idx").on(t.userId, t.day, t.batch)],
);

/**
 * Every task a student has finished, kept for good with what it said.
 *
 * The to-do list shows a finished task crossed out for a day; after that it
 * lives only here, and "See all completed" reads it back a day at a time. A
 * row is written when the student ticks a task, or when the app sees one of
 * the tasks it showed them get done - a round played, an email sent. `source`
 * says which. One row per task: a task finished is finished once.
 */
export const completedTasks = pgTable(
  "completed_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    taskId: text("task_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    href: text("href").notNull(),
    /** "manual" (ticked) or "auto" (the app saw it done). */
    source: text("source").notNull(),
    completedAt: timestamp("completed_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("completed_tasks_user_task_idx").on(t.userId, t.taskId),
    index("completed_tasks_user_time_idx").on(t.userId, t.completedAt),
  ],
);

// ---------- encrypted archive of emails pushed to Gmail ----------

/**
 * Every email a student pushes to Gmail, kept as training data for a future
 * read-only learner: what the model wrote, and what the student actually sent.
 *
 * Both versions are AES-256-GCM ciphertext (lib/email-archive.ts), sealed with
 * a key that lives only in the server environment, so a copy of the database
 * alone reveals nothing. The recipient's address is deliberately not stored.
 * Nothing in the app reads these rows back.
 */
export const emailArchive = pgTable(
  "email_archive",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    draftId: uuid("draft_id").references(() => emailDrafts.id, { onDelete: "set null" }),
    /** An EmailTypeId, e.g. "cold_email". */
    emailType: text("email_type").notNull(),
    /** The model's original draft. Null for drafts written before the archive existed. */
    generatedCiphertext: text("generated_ciphertext"),
    /** The version last pushed to Gmail. Null until the student pushes it. */
    finalCiphertext: text("final_ciphertext"),
    resumeAttached: boolean("resume_attached").default(false).notNull(),
    pushCount: integer("push_count").default(0).notNull(),
    /** Which archive key sealed this row, so the key can be rotated. */
    keyVersion: integer("key_version").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    pushedAt: timestamp("pushed_at"),
  },
  (t) => [index("email_archive_draft_idx").on(t.draftId)],
);

// ---------- people students typed in by hand (internal only) ----------

/**
 * Everyone a student drafted an email to from outside their matched contacts,
 * collected to grow Offerly's own contact database.
 *
 * Internal: no student-facing page reads it, and it never feeds matching or
 * the shared directory - that data is unverified and typed by one student. One
 * row per email address; a person entered again is not added twice.
 */
export const submittedPeople = pgTable(
  "submitted_people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Lowercased and trimmed, so the unique index catches case variants. */
    email: text("email").notNull(),
    name: text("name").notNull(),
    firm: text("firm").notNull(),
    role: text("role"),
    group: text("group"),
    school: text("school"),
    linkedinUrl: text("linkedin_url"),
    background: text("background"),
    /** The first student to enter them. Kept if later students enter the same person. */
    submittedBy: uuid("submitted_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("submitted_people_email_idx").on(t.email)],
);

// ---------- firms directory (reference content, not user-owned) ----------

export const firms = pgTable("firms", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  headquarters: text("headquarters").notNull(),
  keyOffices: text("key_offices").notNull(), // e.g. "New York · London · Hong Kong"
  website: text("website").notNull(), // root domain, used for logo lookup + link
  description: text("description").notNull(),
  // The firm's own words, quoted rather than paraphrased - which is why it is
  // a separate column from `description` above and not a replacement for it.
  // `description` is ours: facts we assembled, safe to feed a model and to
  // present as the site's summary. This is theirs, so it is only ever rendered
  // as an attributed quote next to its source, never as our copy, and never
  // sent to the firm matcher. Null for most firms; only the researched set has
  // one. A row must carry both this and its source URL or neither - an
  // unattributed quote is exactly what this codebase avoids.
  selfDescription: text("self_description"),
  selfDescriptionSourceUrl: text("self_description_source_url"),
  // Regulatory assets under management, in whole US dollars, as the firm last
  // reported it on Form ADV (Item 5.F(2)(c); for exempt reporting advisers,
  // the summed gross asset value of their private funds). Null for firms that
  // manage no assets - which is not a small residual category: pure advisory
  // shops like Centerview file no ADV at all, so a ranking that treats null as
  // zero would bury exactly the investment banks students most want to see.
  // Use it to rank WITHIN asset-management-like categories, never across all.
  // bigint because the largest managers clear $11T, well past int4.
  aum: bigint("aum", { mode: "number" }),
  // Two denormalised columns purely so the directory can be filtered in SQL
  // rather than by loading every firm and filtering in JS - at 22k rows the
  // latter is what made the category pages slow.
  //
  // hqState is the two-letter state parsed out of `headquarters` at seed time.
  // Null for the many rows whose HQ is just "United States", and for non-US
  // offices, so a state filter narrows rather than silently dropping them.
  hqState: text("hq_state"),
  // Mirrors FirmSeed.hasVerifiedStudentProgram. It lives in the static content
  // layer too, but a filter cannot reach that from inside a query.
  hasVerifiedProgram: boolean("has_verified_program").default(false).notNull(),

  // ---- resolved company identity -----------------------------------------
  //
  // Everything below is what a company-data provider CONFIRMED about this
  // firm, kept strictly apart from `website` above. That column is the firm's
  // own SEC Form ADV Item 1.I filing - self-reported, never checked, and the
  // audit found 13 rows carrying a LinkedIn country subdomain and 12 pointing
  // at a careers site. It stays exactly as filed, because it is source data
  // and a useful resolution hint; it is simply not evidence. This is.
  //
  // crustdataCompanyId is deliberately NOT unique: these rows are SEC legal
  // entities while the provider models the recruiting brand, so several rows
  // legitimately share one company - onex.com covers four, key.com three
  // including Cain Brothers. Deduplication belongs in the recommendation
  // layer, not in a constraint that would refuse a valid subsidiary mapping.
  crustdataCompanyId: bigint("crustdata_company_id", { mode: "number" }),
  /**
   * Mail domains that count as this firm's own, beyond verifiedDomain.
   *
   * Explicit only. A parent, an acquirer, a subsidiary or a similarly-named
   * firm never qualifies by being one - key.com is shared by KeyCorp, KeyBank
   * AND Cain Brothers. It exists because real firms do run more than one:
   * eight Barclays contacts sit on @barclays.com while the SEC filing says
   * home.barclays. See lib/contact-email-gate.
   */
  approvedEmailDomains: text("approved_email_domains").array().notNull().default([]),
  linkedinUrl: text("linkedin_url"),
  verifiedDomain: text("verified_domain"),
  aliases: text("aliases").array().notNull().default([]),
  /** 0-100, from the resolver's own scoring. See lib/company-identity.ts. */
  identityConfidence: real("identity_confidence"),
  /** "unresolved" | "verified". Ambiguous stays unresolved - never a guess. */
  identityStatus: text("identity_status").notNull().default("unresolved"),
  /** Last ATTEMPT, success or not, so a failure can be cached for a retry
   *  window rather than re-hammering the provider on every sweep. */
  identityCheckedAt: timestamp("identity_checked_at", { withTimezone: true }),
  /** Last SUCCESS. Only moves when identityStatus becomes "verified". */
  verifiedAt: timestamp("verified_at", { withTimezone: true }),

  /**
   * A made-up firm for demonstrating the firm portal. Kept out of the
   * directory search, and everything it posts is flagged is_demo so it only
   * ever reaches demo accounts. See scripts/seed-firm-demo.ts.
   */
  isDemo: boolean("is_demo").default(false).notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const firmsRelations = relations(firms, ({ many }) => ({
  programs: many(firmPrograms),
}));

export const firmPrograms = pgTable(
  "firm_programs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id, { onDelete: "cascade" }),
    category: firmProgramCategoryEnum("category").notNull(),
    roleLabel: text("role_label").notNull(), // e.g. "Investment Banking Summer Analyst"
    timingGuidance: text("timing_guidance").notNull(), // general, non-firm-year-specific
    careersUrl: text("careers_url").notNull(),
    recruitingChannelLabel: text("recruiting_channel_label").notNull(),
    recruitingChannelUrl: text("recruiting_channel_url").notNull(),
  },
  // Discovery filters by category and joins back to firms on firm_id. Without
  // these both are sequential scans, which the directory import makes costly:
  // the table goes from ~4k program rows to ~16k.
  (table) => [
    index("firm_programs_category_idx").on(table.category),
    index("firm_programs_firm_idx").on(table.firmId),
  ],
);

// ---------- a student's curated "top firms" shortlist ----------
// Populated two ways: AI research from the student's onboarding profile
// (source "ai_matched", with a one-line reason), or manually added by the
// student themselves (source "manual", no reason).

export const userTopFirms = pgTable(
  "user_top_firms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("manual"), // "ai_matched" | "manual"
    reason: text("reason"), // one-line rationale, set for ai_matched picks only
    /** 0-100, how well this firm fits the student's profile. */
    matchScore: integer("match_score"),
    /** Which of the student's stated preferences this firm actually hit, for
     *  the card to show. Denormalised on purpose - the reason a firm was
     *  recommended must not change retroactively when a profile is edited. */
    matchedPreferences: text("matched_preferences").array().notNull().default([]),
    /** Where the student dragged this firm in their list, 0 first. Null until
     *  they reorder; unmoved firms keep the default order (orderTopFirms). */
    position: integer("position"),
    // identityStatus is deliberately NOT mirrored here. It belongs to the firm,
    // and a copy on this row is a copy that can disagree with it.
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // A firm can only be on one student's list once. The read-then-insert in
    // matchTopFirmsForUser cannot enforce this on its own: two matcher runs
    // that overlap - two tabs, a double-click, a page reloaded while the first
    // is still thinking - both read the same "already have" set before either
    // writes, and both insert the firms the other is about to. The result is
    // duplicate rows, and downstream that means React keys colliding wherever
    // a firm id is used as one.
    uniqueIndex("user_top_firms_user_firm_idx").on(table.userId, table.firmId),
  ],
);

/**
 * What a firm is looking for on Student matching: one row per firm, saved from
 * the requirements form and shared by everyone on the firm's team.
 *
 * Fixed choices only (class years, school ids, sectors, degree levels) plus
 * majors and locations picked from the values students actually have - no
 * free text, so nothing here carries the language check. Empty arrays mean
 * "any". GPA and visa sponsorship are deliberately absent: onboarding tells
 * students their GPA is never shown to anyone, and a filter on it would show
 * it to a firm one student at a time.
 */
export const firmMatchCriteria = pgTable(
  "firm_match_criteria",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id, { onDelete: "cascade" }),
    gradYears: integer("grad_years").array().notNull().default([]),
    schoolIds: uuid("school_ids").array().notNull().default([]),
    majors: text("majors").array().notNull().default([]),
    categories: text("categories").array().notNull().default([]),
    locations: text("locations").array().notNull().default([]),
    degreeLevels: text("degree_levels").array().notNull().default([]),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("firm_match_criteria_firm_idx").on(table.firmId)],
);

export const userTopFirmsRelations = relations(userTopFirms, ({ one }) => ({
  user: one(users, { fields: [userTopFirms.userId], references: [users.id] }),
  firm: one(firms, { fields: [userTopFirms.firmId], references: [firms.id] }),
}));

export const firmProgramsRelations = relations(firmPrograms, ({ one }) => ({
  firm: one(firms, { fields: [firmPrograms.firmId], references: [firms.id] }),
}));

// ---------- integrations (scaffolded — inactive until credentials are configured) ----------

export const emailConnections = pgTable("email_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("google"),
  email: text("email"),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  expiresAt: timestamp("expires_at"),
  // Id of the dedicated "Offerly" calendar created on this account, cached so
  // every write doesn't have to re-resolve it. Verified (and recreated) on use,
  // because the student can delete the calendar on Google's side at any time.
  offerlyCalendarId: text("offerly_calendar_id"),
  connectedAt: timestamp("connected_at").defaultNow().notNull(),
});

export const emailConnectionsRelations = relations(emailConnections, ({ one }) => ({
  user: one(users, { fields: [emailConnections.userId], references: [users.id] }),
}));

// ---------- technical quiz ----------

// One row per graded attempt. Stores the question as asked (it may be an
// AI-generated variation rather than a verbatim bank entry) alongside the
// student's answer and the grader's verdict, so progress is reviewable and
// the same question isn't served twice in a row.
export const technicalQuizAttempts = pgTable(
  "technical_quiz_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: firmProgramCategoryEnum("category").notNull(),
    topic: text("topic").notNull(),
    difficulty: text("difficulty").notNull(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    feedback: text("feedback"),
    // Legacy 0-5 score from before grading was split by strictness. No longer
    // written; kept so existing attempt history isn't destroyed. Safe to drop
    // once nothing depends on the old rows.
    score: integer("score"),
    // One 0-10 score per grading strictness - the same answer graded three
    // ways (see lib/technical-quiz). All null while grading hasn't completed.
    scoreLenient: integer("score_lenient"),
    scoreMedium: integer("score_medium"),
    scoreHarsh: integer("score_harsh"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("technical_quiz_user_created_idx").on(table.userId, table.createdAt)],
);

export const technicalQuizAttemptsRelations = relations(technicalQuizAttempts, ({ one }) => ({
  user: one(users, { fields: [technicalQuizAttempts.userId], references: [users.id] }),
}));

// One row per completed practice round. Rounds are a fixed length, which is
// what makes `score` comparable between them - a personal best is read as the
// max over this table rather than being denormalised onto the user.
export const practiceSessions = pgTable(
  "practice_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // "technical" | "behavioral" | "mixed"
    mode: text("mode").notNull(),
    // "foundational" | "intermediate" | "advanced" | "mixed"
    difficulty: text("difficulty").notNull(),
    // "written" | "multiple_choice" | "mixed" - defaulted for rows written
    // before this column existed. Lets the platformer game leaderboard (a
    // technical + multiple_choice round played through the game screen) be
    // told apart from an ordinary written technical round.
    format: text("format").notNull().default("written"),
    // firm_program_category values the round drew from. Empty for a
    // behavioral-only round, which is not sector-specific.
    categories: text("categories").array().notNull(),
    score: integer("score").notNull(),
    maxScore: integer("max_score").notNull(),
    questionsAnswered: integer("questions_answered").notNull(),
    bestStreak: integer("best_streak").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("practice_sessions_user_score_idx").on(table.userId, table.score)],
);

export const practiceSessionsRelations = relations(practiceSessions, ({ one }) => ({
  user: one(users, { fields: [practiceSessions.userId], references: [users.id] }),
}));

// ---------- firm recruiting directory (global, not user-scoped) ----------

// One row per firm/division recruiting office. Global reference data shared by
// every user - copied into a student's own `contacts` when they match with the
// firm. `email` is null for firms that don't publish a recruiting address
// (most large banks recruit via portal only); `sourceUrl` carries the portal
// in that case, so the student still has a real way in.
export const firmRecruitingContacts = pgTable(
  "firm_recruiting_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role").notNull(),
    email: text("email"),
    sourceUrl: text("source_url"),
    background: text("background").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("firm_recruiting_contacts_firm_idx").on(table.firmId)],
);

export const firmRecruitingContactsRelations = relations(firmRecruitingContacts, ({ one }) => ({
  firm: one(firms, { fields: [firmRecruitingContacts.firmId], references: [firms.id] }),
}));

// ---------- people directory ----------

// The imported people database: employees at firms, with enough personal
// background to find genuine common ground with a student.
//
// Separate from `contacts` on purpose. `contacts` is one student's private CRM
// - rows they created, notes only they see. This is reference data shared by
// every student and never edited by them, the same split the firm directory
// already uses. Nothing here is written from the app.
//
// Every column except name and firm is nullable: the source is a spreadsheet,
// and a row with only a name and a LinkedIn URL is still worth showing.
export const directoryPeople = pgTable(
  "directory_people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Resolved firm when the name matched the directory; null when it didn't. */
    firmId: uuid("firm_id").references(() => firms.id, { onDelete: "set null" }),
    /** The employer as written in the source, kept even when firmId resolves. */
    firmName: text("firm_name").notNull(),
    name: text("name").notNull(),
    title: text("title"),
    school: text("school"),
    degree: text("degree"),
    /** Free text as it appears - "2018-2022", "Class of 2022". */
    schoolYears: text("school_years"),
    /** Parsed from schoolYears where possible, for range filtering. */
    gradYear: integer("grad_year"),
    /** Prior roles, as written in the source. */
    jobHistory: text("job_history"),
    linkedinUrl: text("linkedin_url"),
    email: text("email"),
    /** Lets a re-import replace one file's rows without touching another's. */
    importBatch: text("import_batch"),
    /**
     * Set when a re-import no longer contains this person - they left the firm,
     * or the row was dropped from the source.
     *
     * Soft, not a delete: a student may have notes on a conversation with them
     * or a draft already written, and hard-deleting the row would take that
     * history with it. Delisted people stop appearing in search and in outreach
     * suggestions, and nothing the student wrote disappears.
     */
    delistedAt: timestamp("delisted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("directory_people_firm_idx").on(table.firmId),
    index("directory_people_school_idx").on(table.school),
  ],
);

export const directoryPeopleRelations = relations(directoryPeople, ({ one }) => ({
  firm: one(firms, { fields: [directoryPeople.firmId], references: [firms.id] }),
}));

// ---------- AI usage accounting ----------

// One row per model call. Drives the per-user daily quota and gives you the
// per-feature cost visibility needed to tune model choice. Written after the
// call completes, so a failed call is not charged against the user's quota.
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    feature: aiFeatureEnum("feature").notNull(),
    // Model that actually served the call — may differ from the registry's
    // first choice if the fallback ladder kicked in.
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    // True when the request was served by a fallback model after the primary
    // was rate-limited or overloaded. Watch this rate — sustained non-zero
    // means the primary model's capacity needs attention.
    usedFallback: boolean("used_fallback").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // The quota check counts a user's rows since midnight on every AI call, so
    // this index is load-bearing rather than a nice-to-have.
    index("ai_usage_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export const aiUsageRelations = relations(aiUsage, ({ one }) => ({
  user: one(users, { fields: [aiUsage.userId], references: [users.id] }),
}));

// ---------- internship postings (reference content, not user-owned) ----------
// The published, student-facing table Discovery reads from. Populated by an
// admin approving a row in `detectedListings` (see the internship monitoring
// section below) - never written to directly by a connector or a classifier.

export const postingDeadlineStatusEnum = pgEnum("posting_deadline_status", [
  "tbd", // firm hasn't published a deadline yet — the daily refresh re-checks these
  "confirmed", // an explicit date was found on the firm's own page
  "rolling", // firm reviews applications as they arrive, no fixed close date
  "closed", // cycle has closed
]);

export const internshipPostings = pgTable(
  "internship_postings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id, { onDelete: "cascade" }),
    // Every industry the posting belongs to, not just its primary one. A
    // single-column category forced a choice that the market doesn't make:
    // a "Real Estate Investment Banking" analyst seat is genuinely both, and
    // filing it under one hid it from students browsing the other. Stored as
    // an array so a posting appears under each industry it actually fits.
    // Always non-empty — savePosting falls back to the firm's own sector.
    categories: firmProgramCategoryEnum("categories").array().notNull(),

    roleTitle: text("role_title").notNull(),
    location: text("location"),

    // The summer the internship actually runs (e.g. 2028), which is what
    // students filter on — not the year the posting went up.
    programYear: integer("program_year").notNull(),
    // Graduation years eligible for this posting. A rising sophomore
    // graduating 2029 recruits for their junior summer (2028), so a 2028
    // program typically carries [2029]. Stored as an array because some
    // programs genuinely accept two class years.
    eligibleGradYears: integer("eligible_grad_years").array().notNull(),

    deadlineStatus: postingDeadlineStatusEnum("deadline_status")
      .notNull()
      .default("tbd"),
    // Free text exactly as the firm words it ("Applications open August 2027").
    // Kept alongside deadlineDate because most 2028 cycles have no date yet.
    deadlineText: text("deadline_text"),
    deadlineDate: timestamp("deadline_date"),

    // When the application DROPS, as distinct from deadlineDate above, which is
    // when it closes. Both matter and they are not interchangeable: for most of
    // the year the useful answer to "what do I do about this role" is a future
    // open date, not a close date that doesn't exist yet. Without this the only
    // honest label for an unopened posting was "Deadline TBD", which reads as
    // missing data rather than as "nothing to do yet, here's when there will
    // be".
    //
    // Same text/date pairing as the deadline fields, for the same reason: firms
    // announce "opens August 2027" far more often than a precise day, so
    // opensText carries the firm's own wording and opensAt is set only when a
    // real date is known. Render opensText first when both exist.
    opensText: text("opens_text"),
    opensAt: timestamp("opens_at"),

    // Our own paraphrase of the posting, not reproduced text — keeps the
    // substantive details (length, eligibility, locations, groups, process)
    // without republishing the firm's copy. Always shown with sourceUrl so the
    // student can open the real posting.
    descriptionFull: text("description_full").notNull(),
    /**
     * The employer's own requirements section, verbatim, when the posting had
     * one. Stored separately from descriptionFull because it is what a student
     * actually needs - GPA, class year, degree, visa status - and it otherwise
     * sits under several hundred words of firm boilerplate. Null means the
     * posting did not state its requirements, which is different from having
     * none, so the UI must not render an empty section as "no requirements".
     */
    requirementsFull: text("requirements_full"),
    // The firm's own page this was read from. Load-bearing: it is displayed
    // with every description as attribution, not just kept for debugging.
    sourceUrl: text("source_url").notNull(),
    applicationUrl: text("application_url"),

    // Recruiting contact, only when the firm publishes one on the posting
    // itself as the point of contact for applicants. Deliberately not
    // assembled from elsewhere: a contact printed on the posting is published
    // business contact info, a name found by searching for staff is not.
    recruiterName: text("recruiter_name"),
    recruiterTitle: text("recruiter_title"),
    recruiterEmail: text("recruiter_email"),
    recruiterPhone: text("recruiter_phone"),

    // Set false when a later crawl finds the posting gone, rather than
    // deleting — so a transient fetch failure can't silently drop content.
    isActive: boolean("is_active").notNull().default(true),

    // ---- who wrote this row ----
    /**
     * "crawler" for everything the monitoring pipeline publishes, "firm" for a
     * posting a firm wrote itself on the firm portal. A firm's own posting is
     * the firm's to change: savePosting leaves it alone even when the crawler
     * finds the same (firm, role, year), and nothing marks it inactive but the
     * firm closing it.
     */
    origin: text("origin").notNull().default("crawler"),
    postedByUserId: uuid("posted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /**
     * The extra "label: value" details a firm added beyond the standard
     * fields, kept structured so the portal can edit them. They are also
     * written into descriptionFull, which is what students read.
     */
    extraFields: jsonb("extra_fields").$type<{ label: string; value: string }[]>().notNull().default([]),
    /** Posted by a demo firm: shown to demo accounts only. */
    isDemo: boolean("is_demo").notNull().default(false),
    /**
     * Removed by Offerly (lib/firm-admin takeDownPost). Unlike a firm closing
     * its own posting, the firm cannot reopen it; only Offerly can restore it.
     */
    takenDownAt: timestamp("taken_down_at"),
    takenDownReason: text("taken_down_reason"),

    lastCheckedAt: timestamp("last_checked_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // The student-facing query filters on program year, and the daily refresh
    // selects on deadlineStatus — both are hot paths.
    index("internship_postings_year_idx").on(table.programYear),
    // GIN, not btree: categories is an array and the student-facing filter is
    // an overlap test (`categories && ARRAY[...]`), which a btree can't serve.
    index("internship_postings_categories_idx").using("gin", table.categories),
    index("internship_postings_deadline_status_idx").on(table.deadlineStatus),
    index("internship_postings_firm_idx").on(table.firmId),
    /**
     * savePosting's upsert key, enforced by the database rather than trusted.
     *
     * It reads for an existing (firm, role, year) and inserts when it finds
     * none, and for a long time nothing stopped two of those racing or a
     * second writer skipping the read entirely. Checked on Supabase,
     * 20 September 2026: seventeen extra copies had accumulated across
     * seventeen groups - five of one Piper Sandler posting alone - and a
     * student saw the same internship listed several times.
     *
     * A convention held up by application code is not a constraint. This is.
     */
    uniqueIndex("internship_postings_firm_role_year_key").on(
      table.firmId,
      table.roleTitle,
      table.programYear,
    ),
  ],
);

export const internshipPostingsRelations = relations(
  internshipPostings,
  ({ one }) => ({
    firm: one(firms, {
      fields: [internshipPostings.firmId],
      references: [firms.id],
    }),
  }),
);

// Retired alongside the AI crawler (src/lib/internship-crawler.ts, removed).
// Kept as a historical record of what that crawler cost; nothing writes to
// it any more. The monitoring system below has its own per-SOURCE audit
// trail (monitoringCheckRuns) instead of one row per AI-crawl batch.
//
// Audit trail for crawl runs. The crawler is a background job with no user, so
// it can't log to aiUsage (which is per-user and quota-bearing) — this is where
// its cost and outcome are visible instead.
export const internshipCrawlRuns = pgTable("internship_crawl_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  mode: text("mode").notNull(), // "deep" | "refresh"
  firmsScanned: integer("firms_scanned").notNull().default(0),
  postingsFound: integer("postings_found").notNull().default(0),
  postingsUpdated: integer("postings_updated").notNull().default(0),
  deadlinesResolved: integer("deadlines_resolved").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  webSearches: integer("web_searches").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  notes: text("notes"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  finishedAt: timestamp("finished_at"),
});

// ---------- internship monitoring (tiered detection, deterministic) ----------
//
// Replaces the AI crawler above for finding NEW postings. `internshipPostings`
// stays the approved, student-facing table Discovery reads from - everything
// here is upstream of that: which sources to check, how often, what a check
// found, and whether a human needs to look at it before it's published.

export const monitoringSourceTypeEnum = pgEnum("monitoring_source_type", [
  "generic_html",
  "jobposting_jsonld",
  "greenhouse",
]);

export const monitoringSourceHealthEnum = pgEnum("monitoring_source_health", [
  "healthy",
  "degraded",
  "broken",
]);

export const monitoringCheckOutcomeEnum = pgEnum("monitoring_check_outcome", [
  "no_change",
  "changed",
  "error",
  "rate_limited",
]);

export const detectedListingStatusEnum = pgEnum("detected_listing_status", [
  "open",
  "closed",
  "reopened",
  "uncertain",
]);

export const listingReviewStatusEnum = pgEnum("listing_review_status", [
  "auto_approved",
  "pending_review",
  "approved",
  "rejected",
  "merged",
]);

export const userAlertKindEnum = pgEnum("user_alert_kind", [
  "watched_firm_opening",
  "sector_digest",
]);

// Configuration, not hardcoded rules - an admin edits these rows to
// reprioritize a sector or retune a tier's cadence, no code change needed.

export const monitoringTiers = pgTable("monitoring_tiers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(), // "critical" | "high" | "standard" | "discovery" | "inactive"
  // Null means never auto-checked (the "inactive" tier: no usable career page
  // or program, so polling it would just waste a request every run).
  checkIntervalMinutes: integer("check_interval_minutes"),
  description: text("description").notNull(),
  sortOrder: integer("sort_order").notNull(),
});

export const sectorPriorities = pgTable("sector_priorities", {
  id: uuid("id").primaryKey().defaultRandom(),
  category: firmProgramCategoryEnum("category").notNull().unique(),
  priorityRank: integer("priority_rank").notNull(), // 1 = highest (investment banking)
  description: text("description"),
});

// One row per distinct thing to poll - not one per firm, so firms that share
// a career portal or roll up to a parent company don't get checked twice.
export const firmMonitoringSources = pgTable(
  "firm_monitoring_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id, { onDelete: "cascade" }),
    // Set when this source's postings really belong to a parent (e.g. a
    // sub-brand on the parent's career portal) - so demand/priority can roll
    // up without polling the same URL under two different firm rows.
    parentFirmId: uuid("parent_firm_id").references(() => firms.id),
    careersUrl: text("careers_url").notNull(),
    sourceType: monitoringSourceTypeEnum("source_type").notNull(),
    connectorId: text("connector_id").notNull(), // key into the connector registry
    sectorCategory: firmProgramCategoryEnum("sector_category").notNull(),
    hasConfirmedInternshipHistory: boolean("has_confirmed_internship_history")
      .notNull()
      .default(false),
    // Free text for now ("August", "rolling", "January-March") - not enough
    // firms have confirmed history yet to justify a structured calendar.
    historicalOpeningWindow: text("historical_opening_window"),
    isRolling: boolean("is_rolling").notNull().default(false),
    tierId: uuid("tier_id")
      .notNull()
      .references(() => monitoringTiers.id),
    priorityScore: doublePrecision("priority_score").notNull().default(0),
    lastAttemptedAt: timestamp("last_attempted_at"),
    lastSuccessAt: timestamp("last_success_at"),
    nextCheckAt: timestamp("next_check_at").defaultNow().notNull(),
    failureCount: integer("failure_count").notNull().default(0),
    /**
     * Reads in a row that were not an answer about this firm.
     *
     * SEPARATE FROM failureCount ON PURPOSE, AND THIS IS THE POINT.
     *
     * `failureCount` means "this source told us something is wrong with it":
     * it degrades the source at 2, marks it broken at 5, and backs the next
     * check off exponentially. On 20 September 2026 that was correctly taken
     * OFF the inconclusive statuses - 0, 403, 408, 429, 5xx - because all
     * thirteen Workable sources answered 429 from one shared host and five
     * hourly runs would have written off nine hedge funds, three VC firms and
     * a real estate manager that were all perfectly healthy. See
     * lib/monitoring/http-outcome.ts.
     *
     * What that fix left behind is a source with NO counter at all.
     * `inconclusiveRetryMs(failureCount + 1)` was the retry interval, and on
     * a source whose every read is inconclusive `failureCount` never leaves
     * zero - so the attempt number was permanently 1, the growth to 4x inside
     * that function was unreachable, and the retry stayed at 15 minutes
     * forever.
     *
     * Measured on 11 October 2026, over 28,597 check runs: 351 sources had
     * never once produced a successful read across three or more attempts and
     * had consumed 12,902 runs between them - 45% of the entire crawl - and
     * 319 of those 351 still read `failure_count = 0`, i.e. healthy. Per
     * sector it was investment banking at 16% inconclusive against 49-95%
     * everywhere else, because the schedule was tuned on the sector that has
     * connectors.
     *
     * So this counts the thing `failureCount` is not allowed to count. It
     * grows the retry interval and eventually slows the source to the
     * discovery tier, and it never touches `sourceHealth` - a vendor
     * throttling us is still not a verdict on the firm.
     */
    consecutiveInconclusive: integer("consecutive_inconclusive").notNull().default(0),
    sourceHealth: monitoringSourceHealthEnum("source_health")
      .notNull()
      .default("healthy"),
    lastEtag: text("last_etag"),
    lastContentHash: text("last_content_hash"),
    /**
     * What this page last said, for sources with no parseable board.
     *
     * The announcement watcher diffs against this: an opening is a sentence
     * that APPEARED since the previous check, and matching phrases against the
     * whole page instead would re-report the same evergreen line every cycle.
     * Null until the first check, which is also why the first check can never
     * raise an announcement - see lib/monitoring/announcements.ts.
     */
    lastPageText: text("last_page_text"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("firm_monitoring_sources_next_check_idx").on(table.nextCheckAt),
    index("firm_monitoring_sources_firm_idx").on(table.firmId),
  ],
);

export const firmMonitoringSourcesRelations = relations(
  firmMonitoringSources,
  ({ one, many }) => ({
    firm: one(firms, { fields: [firmMonitoringSources.firmId], references: [firms.id] }),
    parentFirm: one(firms, {
      fields: [firmMonitoringSources.parentFirmId],
      references: [firms.id],
    }),
    tier: one(monitoringTiers, {
      fields: [firmMonitoringSources.tierId],
      references: [monitoringTiers.id],
    }),
    checkRuns: many(monitoringCheckRuns),
    detectedListings: many(detectedListings),
  }),
);

// One row per actual fetch attempt - what "source health" and "last
// successful check" are computed from.
export const monitoringCheckRuns = pgTable(
  "monitoring_check_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => firmMonitoringSources.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
    outcome: monitoringCheckOutcomeEnum("outcome"),
    httpStatus: integer("http_status"),
    responseBytes: integer("response_bytes"),
    /**
     * Milliseconds per stage. Null means the connector reported none, which is
     * a fact - never defaulted to zero, which would read as "instant" in the
     * percentile maths these exist to feed (see ConnectorFetchResult.timings).
     */
    staticMs: integer("static_ms"),
    renderMs: integer("render_ms"),
    enrichMs: integer("enrich_ms"),
    listingsSeen: integer("listings_seen").notNull().default(0),
    listingsNew: integer("listings_new").notNull().default(0),
    listingsClosed: integer("listings_closed").notNull().default(0),
    errorMessage: text("error_message"),
  },
  (table) => [index("monitoring_check_runs_source_idx").on(table.sourceId)],
);

export const monitoringCheckRunsRelations = relations(monitoringCheckRuns, ({ one }) => ({
  source: one(firmMonitoringSources, {
    fields: [monitoringCheckRuns.sourceId],
    references: [firmMonitoringSources.id],
  }),
}));

/**
 * What a human decided, next to what the classifier decided.
 *
 * The highest-signal data this system can produce is the set of listings where
 * a reviewer overruled the machine - those are, by definition, the cases the
 * rules get wrong. Until now every one of those judgements was discarded:
 * `reviewedBy` was written to `detected_listings` and read only DEFENSIVELY,
 * to stop a machine re-deciding something a person had settled. Nothing ever
 * learned from it.
 *
 * Worse, the evidence disappears. Re-running the classifier overwrites
 * `classification`, so by the time anyone asks "why did it get this wrong",
 * the verdict being questioned is gone. A row here is a snapshot taken at the
 * moment of disagreement.
 *
 * DELIBERATELY NOT A TRAINING SIGNAL. Nothing reads this table to change
 * behaviour automatically. A classifier that retrains on its own reviewer's
 * clicks drifts quickly and silently, and this pipeline's whole design is that
 * rules are explicit and explainable. This is a record for a person to read
 * and a phrase list for a person to tune.
 */
export const classifierFeedback = pgTable(
  "classifier_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => detectedListings.id, { onDelete: "cascade" }),
    /** The listing's title AT THE TIME, copied rather than joined - a source
     *  can re-fetch and change it, and then the record no longer describes the
     *  thing that was judged. */
    title: text("title").notNull(),
    /** What the classifier said: relevant, or not. */
    machineRelevant: boolean("machine_relevant").notNull(),
    machineConfidence: doublePrecision("machine_confidence"),
    /** The classifier's own stated reason and evidence, frozen here. */
    machineReason: text("machine_reason"),
    machineEvidence: jsonb("machine_evidence"),
    /** What the reviewer did: approved, rejected or merged. */
    humanVerdict: listingReviewStatusEnum("human_verdict").notNull(),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    /**
     * True when the two disagree - stored rather than derived, so the
     * interesting rows can be found with a WHERE clause instead of a join and
     * a comparison nobody will remember to write.
     */
    disagreed: boolean("disagreed").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("classifier_feedback_disagreed_idx").on(table.disagreed),
    index("classifier_feedback_listing_idx").on(table.listingId),
  ],
);

// The normalized, PRE-approval record - distinct from `internshipPostings`,
// which stays the published, student-facing table. A listing lives here from
// the moment a connector sees it until an admin (or an auto-approve rule)
// decides it's real and relevant; only then does it get published there.
export const detectedListings = pgTable(
  "detected_listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => firmMonitoringSources.id, { onDelete: "cascade" }),
    // Not every source hands back a stable id - a generic HTML page usually
    // doesn't, which is why this is nullable and contentHash is the
    // fallback identity signal for those sources.
    externalJobId: text("external_job_id"),
    contentHash: text("content_hash").notNull(),
    title: text("title").notNull(),
    division: text("division"),
    location: text("location"),
    /**
     * How many times a detail fetch has been SPENT on this listing.
     *
     * Enrichment used to be bounded by the calendar - seven days from
     * `firstDetectedAt` - and that measured the wrong thing. A busy board's
     * per-check detail cap means a listing can go a fortnight without ever
     * being TRIED, and the clock gave up on it as though it had failed. 233
     * listings across 91 sources were in the opposite state before the window
     * existed, re-fetched on every check indefinitely (HSBC's for 38 days).
     *
     * Counting attempts bounds the waste without punishing a listing that
     * never got a turn. See shouldRetryEnrichment in listing-lifecycle.ts.
     */
    enrichmentAttempts: integer("enrichment_attempts").notNull().default(0),
    descriptionRaw: text("description_raw").notNull(),
    employmentType: text("employment_type"),
    applicationUrl: text("application_url"),
    listingUrl: text("listing_url").notNull(),
    // Only set when the source itself states one - never inferred, so this
    // can never be confused with firstDetectedAt (see that column's comment).
    publishedAt: timestamp("published_at"),
    /**
     * The closing date the SOURCE stated, when it stated one. Never inferred.
     *
     * Added after losing a database and discovering this was the one crawled
     * fact that could not be rebuilt. Connectors parse it (TalentLink feeds
     * publish it outright), monitor-run passed it straight into
     * opening_signals, and nothing kept a copy - so the deadline existed only
     * in memory during the insert that first saw the listing. After a restore,
     * every "Open now" row silently became "date not announced", because that
     * bucket needs a closing date and the only record of it was gone.
     */
    deadlineAt: timestamp("deadline_at"),
    // Distinct from `publishedAt` on purpose: this is when OUR system first
    // saw the listing, not when the employer says they posted it. Conflating
    // the two is exactly the "never imply the system knows an exact opening
    // time unless the source provides it" mistake the product spec calls out.
    firstDetectedAt: timestamp("first_detected_at").defaultNow().notNull(),
    lastConfirmedAt: timestamp("last_confirmed_at").defaultNow().notNull(),
    status: detectedListingStatusEnum("status").notNull().default("open"),
    // Deterministic classifier output: { relevant, sector, subsector,
    // recruitingCycle, confidence, matchedEvidence[], reasonForUncertainty,
    // needsHumanReview }. jsonb rather than columns because the rule set is
    // still being tuned - promoting a field to its own column is easy once
    // it's stable; doing that now would mean a migration per rule tweak.
    classification: jsonb("classification"),
    reviewStatus: listingReviewStatusEnum("review_status")
      .notNull()
      .default("pending_review"),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at"),
    promotedPostingId: uuid("promoted_posting_id").references(() => internshipPostings.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("detected_listings_source_idx").on(table.sourceId),
    index("detected_listings_review_status_idx").on(table.reviewStatus),
  ],
);

export const detectedListingsRelations = relations(detectedListings, ({ one }) => ({
  source: one(firmMonitoringSources, {
    fields: [detectedListings.sourceId],
    references: [firmMonitoringSources.id],
  }),
  reviewer: one(users, { fields: [detectedListings.reviewedBy], references: [users.id] }),
  promotedPosting: one(internshipPostings, {
    fields: [detectedListings.promotedPostingId],
    references: [internshipPostings.id],
  }),
}));

// Personal, per-user notifications - the global activity feed (activityEvents,
// below) is deliberately visible to everyone; this is the opposite: only the
// recipient ever sees their own row. Unique on (userId, postingId, kind) so
// re-running a check on an already-notified posting can never double-alert
// the same student for the same reason.
export const userAlerts = pgTable(
  "user_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: userAlertKindEnum("kind").notNull(),
    postingId: uuid("posting_id")
      .notNull()
      .references(() => internshipPostings.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("user_alerts_user_posting_kind_idx").on(
      table.userId,
      table.postingId,
      table.kind,
    ),
    index("user_alerts_user_idx").on(table.userId),
  ],
);

export const userAlertsRelations = relations(userAlerts, ({ one }) => ({
  user: one(users, { fields: [userAlerts.userId], references: [users.id] }),
  posting: one(internshipPostings, {
    fields: [userAlerts.postingId],
    references: [internshipPostings.id],
  }),
}));

// ---------- activity feed ----------

// "post" is the only kind a person writes. The other three are milestones the
// system records on their behalf, which is why they carry structured columns
// (firm, role, streak) and no prose - a post is the reverse, so it carries
// `body` and nothing else.
export const activityKindEnum = pgEnum("activity_kind", ["joined", "streak", "offer", "post"]);

// One row per shareable milestone, and the whole of what the home feed reads.
//
// The feed is GLOBAL by product decision: every signed-in student sees every
// row. That is the reason this table denormalises its display copy instead of
// joining out to the source record at read time - the feed must never be able
// to reach anything the student did not choose to put in it. `firm` and `role`
// are copied from what they typed into their own application; `streak` is a
// number they scored. Nothing here comes from contacts, email connections or
// the recruiting directory, and there is deliberately no column that could
// carry one.
//
// `dedupeKey` is what stops the feed being spammable. An application toggled
// offer -> rejected -> offer, or a signup action retried, would otherwise
// write a row every time; the unique index means the second write is a no-op.
// It is the user id for a join, the application id for an offer, and the
// streak bucket for a streak.
export const activityEvents = pgTable(
  "activity_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: activityKindEnum("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    firm: text("firm"),
    role: text("role"),
    streak: integer("streak"),
    /**
     * What the student wrote, for kind "post". Null for every generated kind.
     *
     * Kept on this table rather than in a posts-of-its-own table because the
     * feed reads one ordered list and a second source would mean merging two
     * queries and paginating across both - see `posts`, which is a genuinely
     * different thing (organisation programming, with dates and a location)
     * and stays separate for that reason.
     */
    body: text("body"),
    /**
     * A post's headline. Null for every generated kind, and optional even on a
     * post - plenty of updates are one sentence, and a title on top of that is
     * just the sentence twice.
     */
    title: text("title"),
    /**
     * Storage key for an attached image - not a URL, and not the bytes. The
     * file lives in stored_files (kind "post-image") and is served
     * through /api/post-image/[id], the same arrangement avatars use. See
     * lib/post-image-storage.ts for why the key is always a generated uuid.
     */
    imagePath: text("image_path"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("activity_events_created_idx").on(table.createdAt),
    uniqueIndex("activity_events_dedupe_idx").on(table.userId, table.kind, table.dedupeKey),
  ],
);

export const activityEventsRelations = relations(activityEvents, ({ one }) => ({
  user: one(users, { fields: [activityEvents.userId], references: [users.id] }),
}));

// Emoji reactions on a feed row. One row per student, row and emoji, so a
// student can leave several different emojis on one post but not the same one
// twice. 0027, applied live first.
export const activityReactions = pgTable(
  "activity_reactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => activityEvents.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("activity_reactions_unique_idx").on(table.eventId, table.userId, table.emoji),
    index("activity_reactions_user_idx").on(table.userId),
  ],
);

// Comments on a feed row, oldest first under the post.
export const activityComments = pgTable(
  "activity_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => activityEvents.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("activity_comments_event_idx").on(table.eventId, table.createdAt)],
);

// Which feed rows a student has already had on screen. The feed lists rows
// with no entry here first ("new"), then the rest (lib/activity getFeedPage).
export const activitySeen = pgTable(
  "activity_seen",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => activityEvents.id, { onDelete: "cascade" }),
    seenAt: timestamp("seen_at").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.eventId] })],
);


// ---------- direct messages ----------

// A flat message log rather than a conversations table with a join. Threads are
// derived by pairing sender and recipient, which for one-to-one messaging is
// the same information with one fewer table to keep consistent - there is no
// group chat here and adding one later means adding the conversation table
// then, not carrying an empty abstraction until it arrives.
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    /** Last time the sender changed the text. Only possible for a short while
     *  after sending (lib/message-limits MESSAGE_EDIT_WINDOW_MS); the other
     *  person sees that it was edited. */
    editedAt: timestamp("edited_at"),
  },
  (table) => [
    // Both directions of a thread are read together, so each participant needs
    // its own index - a single composite on (sender, recipient) only serves
    // half the query.
    index("messages_sender_idx").on(table.senderId, table.createdAt),
    index("messages_recipient_idx").on(table.recipientId, table.createdAt),
  ],
);

export const messagesRelations = relations(messages, ({ one }) => ({
  sender: one(users, { fields: [messages.senderId], references: [users.id], relationName: "sentMessages" }),
  recipient: one(users, { fields: [messages.recipientId], references: [users.id], relationName: "receivedMessages" }),
}));


// ---------- clubs + community feed ----------

// Student organisations that post to the feed. A real table rather than a
// free-text org name on each post, so "filter by club" stays reliable when
// the same club is written three different ways, and so a club survives its
// leadership turning over every year.
export const clubs = pgTable("clubs", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  // The school the club belongs to. Nullable for the occasional inter-school
  // or national organisation.
  schoolId: uuid("school_id").references(() => schools.id, { onDelete: "set null" }),
  description: text("description"),
  websiteUrl: text("website_url"),
  // A seeded example club (scripts/seed-sample-clubs.ts), shown with a
  // "Sample" tag. 0026, applied to live first.
  isSample: boolean("is_sample").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Who is in a club. Joining is the student's own click (or a seeded sample);
// `title` is an officer role ("President"), null for a member.
export const clubMembers = pgTable(
  "club_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: uuid("club_id")
      .notNull()
      .references(() => clubs.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("club_members_club_user_idx").on(table.clubId, table.userId),
    index("club_members_user_idx").on(table.userId),
  ],
);

export const clubsRelations = relations(clubs, ({ one, many }) => ({
  school: one(schools, { fields: [clubs.schoolId], references: [schools.id] }),
  posts: many(posts),
}));

// One entry in the community feed. Authored by a club or firm account and
// read by everyone.
//
// Note this is NOT the `events` table: that one is a student's own calendar
// and its userId is NOT NULL, so an organisation's announcement has no owner
// to hang off. Students can't be auto-subscribed to these either - a post
// reaching a student's calendar is their choice, not the poster's.
export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Who actually pressed post. Kept alongside clubId/firmId so an audit
    // still names a person after a club's leadership changes.
    authorUserId: uuid("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Exactly one of these is set - whichever org the author posts for.
    clubId: uuid("club_id").references(() => clubs.id, { onDelete: "cascade" }),
    firmId: uuid("firm_id").references(() => firms.id, { onDelete: "cascade" }),
    type: postTypeEnum("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    // Industry filter. Reuses the same category vocabulary the firm directory
    // and student preferences already speak, so "show me private equity" means
    // one thing across the whole app. Null for posts that aren't sector-specific.
    category: firmProgramCategoryEnum("category"),
    // Audience. Null means open to every school; set means the post is only
    // relevant to that school's students (it is a filter default, not a
    // permission - the feed is readable by any logged-in student).
    schoolId: uuid("school_id").references(() => schools.id, { onDelete: "set null" }),
    location: text("location"),
    // Optional external link - a sign-up form, registration page, or wherever
    // the poster wants people to go. Null when the post is self-contained.
    linkUrl: text("link_url"),
    // Only meaningful alongside linkUrl. Defaults to "details" so an older row
    // (or a poster who does not pick one) still renders a sensible button.
    linkLabel: postLinkLabelEnum("link_label").default("details").notNull(),
    // When the thing being announced happens. Null for a plain announcement,
    // which is why the feed orders by publishedAt and only uses these to
    // split upcoming from past.
    startsAt: timestamp("starts_at"),
    endsAt: timestamp("ends_at"),
    publishedAt: timestamp("published_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // The feed's default read is "newest first", unfiltered.
    index("posts_published_idx").on(table.publishedAt),
    index("posts_club_idx").on(table.clubId, table.publishedAt),
    index("posts_firm_idx").on(table.firmId, table.publishedAt),
  ],
);

export const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, { fields: [posts.authorUserId], references: [users.id] }),
  club: one(clubs, { fields: [posts.clubId], references: [clubs.id] }),
  firm: one(firms, { fields: [posts.firmId], references: [firms.id] }),
  school: one(schools, { fields: [posts.schoolId], references: [schools.id] }),
}));


// ---------- follows ----------

// A one-way follow. Mirrors the posts table's shape: a follower plus exactly
// one target, which is a person, a club or a firm.
//
// Two different jobs on purpose. Following a PERSON is social - it is what
// the Connect directory reads to show "following" state. Following an ORG is
// functional - only clubs and firms can post, so the feed's "Following" sort
// would have nothing to work with if this table held people alone.
export const follows = pgTable(
  "follows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    followerId: uuid("follower_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    followingUserId: uuid("following_user_id").references(() => users.id, { onDelete: "cascade" }),
    clubId: uuid("club_id").references(() => clubs.id, { onDelete: "cascade" }),
    firmId: uuid("firm_id").references(() => firms.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // "Who does this person follow" is read on every directory render and on
    // every Following-sorted feed page.
    index("follows_follower_idx").on(table.followerId),
    // Follower counts, and the reverse lookup on a profile.
    index("follows_user_idx").on(table.followingUserId),
    // A double-tap on Follow must not create two rows. Partial uniques per
    // target kind rather than one composite across all three, because
    // NULLs don't compare equal in a composite unique - (me, NULL, NULL, X)
    // twice would pass a plain unique index.
    uniqueIndex("follows_user_unique")
      .on(table.followerId, table.followingUserId)
      .where(sql`following_user_id is not null`),
    uniqueIndex("follows_club_unique")
      .on(table.followerId, table.clubId)
      .where(sql`club_id is not null`),
    uniqueIndex("follows_firm_unique")
      .on(table.followerId, table.firmId)
      .where(sql`firm_id is not null`),
  ],
);

/**
 * Peers - this app's version of friends, and deliberately NOT another follow.
 *
 * A follow is one-way and about reading someone's activity. A peer is mutual
 * and about knowing them: same year, same recruiting season, someone to
 * compare notes with. The two are kept apart because collapsing them would
 * make "peers" mean "people I follow", which is not a relationship anyone
 * would call friendship.
 *
 * ONE ROW PER DIRECTION, and a pair is peers only when both rows exist. That
 * is what lets "Add +" be a single click with no request inbox to build or
 * maintain: adding someone you have not heard from records your half and reads
 * as "Requested", adding someone who already added you completes the pair and
 * both sides become peers immediately. Removing deletes only your own row, so
 * leaving is unilateral the way it should be.
 */
export const peerLinks = pgTable(
  "peer_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    peerId: uuid("peer_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // "Who have I added" - read on every directory render.
    index("peer_links_user_idx").on(table.userId),
    // The reverse: "who added me", which is the half that decides mutuality,
    // and what peer counts are computed from.
    index("peer_links_peer_idx").on(table.peerId),
    // A double-tap on Add must not record two halves. uniqueIndex rather than
    // unique(), matching how every other composite constraint in this file is
    // written - both columns are NOT NULL here, so the NULL-comparison trap
    // documented on `follows` does not apply.
    uniqueIndex("peer_links_pair_unique").on(table.userId, table.peerId),
  ],
);

export const peerLinksRelations = relations(peerLinks, ({ one }) => ({
  user: one(users, { fields: [peerLinks.userId], references: [users.id], relationName: "peersAdded" }),
  peer: one(users, { fields: [peerLinks.peerId], references: [users.id], relationName: "peersAddedBy" }),
}));

export const followsRelations = relations(follows, ({ one }) => ({
  follower: one(users, { fields: [follows.followerId], references: [users.id], relationName: "following" }),
  followingUser: one(users, { fields: [follows.followingUserId], references: [users.id], relationName: "followers" }),
  club: one(clubs, { fields: [follows.clubId], references: [clubs.id] }),
  firm: one(firms, { fields: [follows.firmId], references: [firms.id] }),
}));


// ---------- resume review ----------

// One AI review of one uploaded resume.
//
// Kept as its own table rather than columns on `users` because a student
// re-uploads as they iterate, and the point of the feature is watching the
// score move. The uploaded file itself stays where saveResumeFile put it; only
// the verdict lives here.
export const resumeReviews = pgTable(
  "resume_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    storagePath: text("storage_path").notNull(),
    /** 0-100, computed in code from the per-dimension marks below - never asked
     *  of the model. Same split as lib/grading.ts: the model judges, the rubric
     *  scores, so the weighting can be retuned without re-tuning a prompt. */
    score: integer("score").notNull(),
    /** Per-dimension marks and notes: [{ id, score, max, notes }]. */
    dimensions: jsonb("dimensions").notNull(),
    summary: text("summary").notNull(),
    strengths: text("strengths").array().notNull(),
    /** Ordered fixes: [{ priority, title, detail }]. */
    improvements: jsonb("improvements").notNull(),
    /** Copyable before/after suggestions: [{ kind, before, after, note }].
     *  Nullable rather than defaulted so reviews written before the rewrite
     *  critics existed read back as "none offered" instead of an empty list
     *  that looks like the model declined to suggest anything. */
    rewrites: jsonb("rewrites"),
    /** The target posting the ATS critic compared against, when the student
     *  pasted one. Kept so a re-read of an old review explains why its keyword
     *  findings say what they say. */
    jobDescription: text("job_description"),
    /** The full rewritten resume, once the student asks for one, as
     *  { name, contact, sections[] }. Null until then. Student edits are saved
     *  back over it, so this is the working draft rather than a frozen record
     *  of what the model first produced. */
    revised: jsonb("revised"),
    revisedUpdatedAt: timestamp("revised_updated_at"),
    /** What the model first produced, frozen at generation - the frozen record
     *  `revised` above explicitly is not. Same reasoning as modelSubject /
     *  modelBody on emailDrafts: the student's edits over the top are the most
     *  useful thing here, and they are only legible against the original.
     *  Null for revisions generated before this column existed. */
    revisedOriginal: jsonb("revised_original"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("resume_reviews_user_idx").on(table.userId, table.createdAt)],
);

export const resumeReviewsRelations = relations(resumeReviews, ({ one }) => ({
  user: one(users, { fields: [resumeReviews.userId], references: [users.id] }),
}));

// ---------- consent ledger ----------

export const consentEventKindEnum = pgEnum("consent_event_kind", [
  /** Agreed to the Terms and Privacy Policy at `policyVersion`. */
  "policy_accepted",
  /** Said yes to Training Use. */
  "training_opted_in",
  /** Said no to Training Use (including turning it off later). */
  "training_opted_out",
  /** Turned Profile Sharing with firms on. */
  "firm_sharing_on",
  /** Turned Profile Sharing with firms off. */
  "firm_sharing_off",
]);

/**
 * Every consent decision a student makes, one row per decision, never updated.
 *
 * The columns on `users` say what is true NOW; this says what was agreed,
 * when, under which policy version and on which screen - the question a
 * regulator, a lawyer or a training-data audit actually asks. It is kept after
 * the account is deleted (the privacy policy keeps consent records for the life
 * of the account plus 6 years): `userId` is set null on delete and `emailHash`
 * (sha256 of the lowercased email) is what still matches a former student's
 * later claim, without keeping their address.
 */
export const consentEvents = pgTable(
  "consent_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    emailHash: text("email_hash").notNull(),
    kind: consentEventKindEnum("kind").notNull(),
    policyVersion: text("policy_version").notNull(),
    /** Where the decision was made: "signup", "consent_screen", "onboarding", "settings". */
    source: text("source").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("consent_events_user_idx").on(table.userId, table.createdAt),
    index("consent_events_kind_idx").on(table.kind, table.createdAt),
  ],
);

// ---------- training corpus ----------

export const trainingTaskEnum = pgEnum("training_task", [
  "email_draft",
  "resume_tailor",
]);

/**
 * What happened to a generated output after the model produced it. This is the
 * label, and it is ordered by how much it tells you: an untouched draft the
 * student pushed to Gmail is a strong positive, a heavily rewritten one is a
 * correction, and a discarded one is a negative.
 */
export const trainingOutcomeEnum = pgEnum("training_outcome", [
  /** Saved with no edits to the model's text. */
  "accepted",
  /** Saved after the student changed it - `humanOutput` is the correction. */
  "edited",
  /** Reached the student's mailbox (drafts) or was exported. */
  "delivered",
  /** Deleted without being used. */
  "discarded",
]);

/**
 * The de-identified training corpus, deliberately a separate table from the
 * product rows it is derived from.
 *
 * The privacy policy promises two specific things that this table's shape is
 * what actually delivers: identifiers are removed BEFORE content is used for
 * training (so redaction happens on the way in here, not in a later export
 * pass), and training data is "stored separately from your account" (so this
 * is its own table rather than more columns on emailDrafts).
 *
 * `userId` cascades on delete on purpose. Deleting an account is promised to
 * remove that student's content from the training datasets, and a foreign key
 * enforces that mechanically - a promise kept by a database constraint rather
 * than by remembering to run a cleanup script.
 */
export const trainingExamples = pgTable(
  "training_examples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    task: trainingTaskEnum("task").notNull(),
    outcome: trainingOutcomeEnum("outcome").notNull(),

    /**
     * The consent version in force when this example was captured.
     *
     * The single most important column here for anything downstream. It is
     * what lets a future export answer "was this collected under a policy that
     * actually permitted training?" by filtering rather than by trusting that
     * every row predates or postdates some remembered cutoff. Rows captured
     * under a policy that is later found wanting can be excluded precisely
     * instead of throwing away the whole corpus.
     */
    policyVersion: text("policy_version").notNull(),

    /** The de-identified inputs the generation was conditioned on. */
    promptContext: jsonb("prompt_context").notNull(),
    /** The de-identified text the model produced. */
    modelOutput: jsonb("model_output").notNull(),
    /** The de-identified text the human decided on instead. Null when they
     *  changed nothing, which is itself the signal - see outcome "accepted". */
    humanOutput: jsonb("human_output"),

    /** Whether the outreach this example came from got a reply, once the
     *  student says. Null means unknown, never "no" - see emailDrafts.gotReply. */
    gotReply: boolean("got_reply"),

    /** The row this was derived from, for debugging a bad example back to its
     *  source. Not a foreign key: the source is allowed to be deleted while
     *  the de-identified example survives, which is the entire point of them
     *  being separate tables. */
    sourceId: uuid("source_id"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("training_examples_task_idx").on(table.task, table.createdAt),
    // One example per source row: capture runs on every edit and every push,
    // and without this each of those would append a near-duplicate rather than
    // updating the example in place.
    uniqueIndex("training_examples_source_idx").on(table.task, table.sourceId),
  ],
);

// ---------- opening signals ----------

/**
 * Where a claim about an application window came from, ordered by how much it
 * should be believed. The resolver reads this order directly (see
 * lib/opening-signals.ts), so the sequence here IS the precedence rule.
 */
export const openingSignalSourceEnum = pgEnum("opening_signal_source", [
  /** The firm said so: its own careers page, email, or announcement. */
  "firm_announcement",
  /** We observed a live posting ourselves - the crawler found it open. */
  "seen_live",
  /** A student told us. Fast and often first, but unverified. */
  "student_report",
  /** Derived from previous cycles or published guidance. Never a fact. */
  "prediction",
]);

/**
 * One claim about when a firm's programme opens or closes, from one source.
 *
 * Every date-discovering thing in the product writes HERE rather than straight
 * onto a posting: the crawler, the recruiting inbox, student reports, the
 * Wayback backfill, the predictor. Rows are claims, not truth - several will
 * disagree about the same programme, and resolveOpeningSignal picks between
 * them by source precedence. Keeping the disagreement rather than overwriting
 * is the point: a student report that a firm opened is still worth showing
 * while it waits for the crawler to confirm it, and when the firm itself
 * announces something different we want to be able to see that we were wrong
 * and why.
 *
 * Keyed on (firm, programme, cycle) - the same triple the summary specifies -
 * because "when does Evercore IB open" is only answerable once you say which
 * year's programme you mean.
 */
export const openingSignals = pgTable(
  "opening_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id, { onDelete: "cascade" }),
    /** Which programme at that firm. Null means "the firm generally", which is
     *  what a mailing-list email or a Reddit post usually gives you. */
    programCategory: firmProgramCategoryEnum("program_category"),
    /** The programme year this claim is about, e.g. 2028 for Summer 2028. */
    cycleYear: integer("cycle_year").notNull(),

    source: openingSignalSourceEnum("source").notNull(),

    /**
     * The window the application opens in, as a RANGE rather than a date.
     *
     * "Vague stays vague": a source saying "March" is stored as 1-31 March,
     * not 1 March. Collapsing a month to its first day invents a precision
     * the source never had, and a student planning around it is being misled
     * by our rounding rather than by the firm. An exact announced date is
     * simply a window where both ends are the same day.
     */
    opensStart: timestamp("opens_start"),
    opensEnd: timestamp("opens_end"),
    /** Same treatment for the closing date. */
    closesStart: timestamp("closes_start"),
    closesEnd: timestamp("closes_end"),

    /**
     * The sentence this claim was read out of, verbatim.
     *
     * Required, and the reason is the summary's own rule: every field returns
     * the sentence it came from, which is what makes a human review fast and
     * makes a hallucinated date visible instead of plausible. A row that
     * cannot say where its dates came from should not be in this table.
     */
    evidence: text("evidence").notNull(),
    sourceUrl: text("source_url"),

    /** Set when source = "student_report", so a wrong report is traceable and
     *  a reliable reporter is recognisable. */
    reportedByUserId: uuid("reported_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    /** When the claim was true of the world, which is not when we stored it -
     *  a Wayback backfill writes rows about last year today. */
    observedAt: timestamp("observed_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("opening_signals_key_idx").on(table.firmId, table.cycleYear, table.programCategory),
    // One live claim per source per programme. Note this does NOT fully
    // enforce that: Postgres treats NULLs as distinct in a unique index, and
    // programCategory is null whenever a source does not say which desk -
    // which is most of them. One crawl of Jefferies wrote eight rows that were
    // meant to be one. `nullsNotDistinct` would fix it at the database level
    // but is not available in this drizzle version, so recordOpeningSignal
    // does the deduplication explicitly instead. This index still constrains
    // the non-null case and, more importantly, is the lookup path that
    // deduplication uses.
    uniqueIndex("opening_signals_source_idx").on(
      table.firmId,
      table.cycleYear,
      table.programCategory,
      table.source,
    ),
  ],
);

export const openingSignalsRelations = relations(openingSignals, ({ one }) => ({
  firm: one(firms, { fields: [openingSignals.firmId], references: [firms.id] }),
  reportedBy: one(users, {
    fields: [openingSignals.reportedByUserId],
    references: [users.id],
  }),
}));

/**
 * A student saying "I saw this firm's programme open."
 *
 * Kept as its own table rather than written straight into `opening_signals`,
 * and the reason is that table's own deduplication rule: it holds ONE live
 * claim per (firm, cycle, programme, source), so every student reporting
 * Goldman's 2028 banking programme lands on the same row. Written directly,
 * the twentieth reporter would overwrite the first's words while the row
 * stayed credited to whoever happened to report first - and the fact that
 * twenty people independently saw the same thing, which is the most useful
 * part of a crowd report, would never be recorded anywhere.
 *
 * So: raw reports live here, one per student, and `opening_signals` carries
 * the single aggregated claim derived from them. That keeps the signals table's
 * "one claim per source" shape intact while making corroboration countable.
 */
export const studentOpeningReports = pgTable(
  "student_opening_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id, { onDelete: "cascade" }),
    reportedByUserId: uuid("reported_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Null means "the firm generally" - same convention as opening_signals. */
    programCategory: firmProgramCategoryEnum("program_category"),
    cycleYear: integer("cycle_year").notNull(),
    /**
     * What the student actually saw, in their own words.
     *
     * Free text, so it goes through the blocked-language check on the way in
     * like every other typed field. Optional: a report with no note is still a
     * useful sighting, and demanding a sentence would cost more reports than
     * the sentences are worth.
     */
    note: text("note"),
    /** Where they saw it. Optional, and worth a lot when present - it is the
     *  one part of a student report an admin can verify in a click. */
    sourceUrl: text("source_url"),
    /**
     * When the student says they saw it live.
     *
     * Defaults to now. Like `seen_live`, this is a LATE bound on the opening:
     * it says the programme had opened by this moment and nothing about when
     * it opened. The action never writes an opensStart from it.
     */
    observedAt: timestamp("observed_at").defaultNow().notNull(),
    /** Set by an admin who checked the claim and found it wrong. Dismissed
     *  reports stop counting toward the aggregated signal but are kept, so a
     *  repeatedly-wrong reporter is visible rather than merely absent. */
    dismissedAt: timestamp("dismissed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("student_opening_reports_firm_idx").on(table.firmId, table.cycleYear),
    // One report per student per programme per cycle. A student who reports the
    // same thing twice is correcting themselves, not corroborating themselves -
    // the action upserts onto this so the second report replaces the first
    // rather than inflating the count.
    uniqueIndex("student_opening_reports_unique_idx").on(
      table.firmId,
      table.reportedByUserId,
      table.programCategory,
      table.cycleYear,
    ),
  ],
);

export const studentOpeningReportsRelations = relations(studentOpeningReports, ({ one }) => ({
  firm: one(firms, { fields: [studentOpeningReports.firmId], references: [firms.id] }),
  reportedBy: one(users, {
    fields: [studentOpeningReports.reportedByUserId],
    references: [users.id],
  }),
}));

/**
 * Recruiting events a firm published - info sessions, coffee chats, campus
 * receptions, insight days.
 *
 * Its own table rather than rows in `events`, and the distinction is the same
 * one `detected_listings` draws against `internship_postings`. `events` is a
 * STUDENT'S calendar: userId is required, rows sync to their Google Calendar
 * and trigger reminder emails. A firm's info session belongs to no student
 * until one chooses it, so writing crawler output straight in would mean
 * either inventing a userId or creating a row per user and pushing uninvited
 * entries onto every connected calendar.
 *
 * So the crawler files them here, students add the ones they want to their own
 * `events`, and the existing calendar sync carries on unchanged.
 *
 * These arrive as a by-product of the classifier REJECTING them. Evercore's
 * board publishes "2028 Summer Analyst Intro to Evercore - Duke" beside its
 * real vacancies; it reads exactly like an internship and is not one. Rejecting
 * it was correct and throwing it away was not - a coffee chat with Evercore is
 * worth a great deal to a student, just not as a job posting.
 */
export const firmRecruitingEvents = pgTable(
  "firm_recruiting_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id, { onDelete: "cascade" }),
    /** The monitoring source it was seen on, so a stale event is traceable. */
    sourceId: uuid("source_id").references(() => firmMonitoringSources.id, {
      onDelete: "set null",
    }),
    /** The source's own id where it has one, else a hash of the URL - same
     *  identity rule detected_listings uses. */
    externalId: text("external_id"),
    title: text("title").notNull(),
    /** info_session | coffee_chat | networking | insight_day | other - read
     *  from the title, and left as "other" rather than guessed. */
    eventKind: text("event_kind").notNull().default("other"),
    /** What a firm typed when it picked "Other event" - shown as the event's
     *  type in place of the generic label. Null for every other kind. */
    kindLabel: text("kind_label"),
    /**
     * When it happens, when the source stated it outright.
     *
     * Null when the page gave no parseable date. Never inferred: an event with
     * an invented time is worse than one a student has to click through to,
     * because they will plan around it.
     */
    eventDate: timestamp("event_date"),
    /** Registration close, where stated. TalentLink publishes this. */
    registrationDeadline: timestamp("registration_deadline"),
    /** The school named in the title, for campus-specific events - "Duke",
     *  "University of Southern California". Null for open events. */
    school: text("school"),
    location: text("location"),
    eventUrl: text("event_url").notNull(),
    descriptionRaw: text("description_raw"),
    /** The sentence the date was read out of, so a wrong one is checkable. */
    evidence: text("evidence"),

    // ---- events a firm posted itself, on the firm portal ----
    /** "crawler" | "firm". The crawler never touches a "firm" row. */
    origin: text("origin").notNull().default("crawler"),
    postedByUserId: uuid("posted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /**
     * The schools the event is for. Empty means open to students anywhere.
     * `school` above keeps the names for display; these decide who is told.
     */
    schoolIds: uuid("school_ids").array().notNull().default(sql`'{}'::uuid[]`),
    endsAt: timestamp("ends_at"),
    /** "in_person" | "virtual" | "hybrid", for firm-posted events. */
    format: text("format"),
    /**
     * Where a firm wants students to sign up, if anywhere. Firm-posted events
     * keep an internal marker in eventUrl (it is the identity column, and two
     * events can share one registration page), so the link lives here.
     */
    rsvpUrl: text("rsvp_url"),
    /** Closed by the firm: kept for its analytics, shown to no student. */
    isActive: boolean("is_active").notNull().default(true),
    /** Posted by a demo firm: shown to demo accounts only. */
    isDemo: boolean("is_demo").notNull().default(false),
    /** Removed by Offerly - see internshipPostings.takenDownAt. */
    takenDownAt: timestamp("taken_down_at"),
    takenDownReason: text("taken_down_reason"),

    firstSeenAt: timestamp("first_seen_at").defaultNow().notNull(),
    lastConfirmedAt: timestamp("last_confirmed_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("firm_recruiting_events_firm_idx").on(table.firmId, table.eventDate),
    uniqueIndex("firm_recruiting_events_identity_idx").on(table.firmId, table.eventUrl),
  ],
);

export const firmRecruitingEventsRelations = relations(firmRecruitingEvents, ({ one }) => ({
  firm: one(firms, { fields: [firmRecruitingEvents.firmId], references: [firms.id] }),
  source: one(firmMonitoringSources, {
    fields: [firmRecruitingEvents.sourceId],
    references: [firmMonitoringSources.id],
  }),
}));

// ---------- work-email patterns, learned per firm ----------

/**
 * How one firm builds its people's email addresses.
 *
 * A FIRM-level fact, deliberately not scoped to a user: the first student to
 * search a firm pays one credit to learn its shape, and every student after
 * gets it for nothing. That amortisation is the entire reason this table
 * exists - buying an address per contact costs ~$0.30, deriving one costs $0.
 *
 * Holds no personal data. A shape and a domain, never the addresses it was
 * learned from.
 */
export const firmEmailPatterns = pgTable("firm_email_patterns", {
  id: uuid("id").primaryKey().defaultRandom(),
  firmId: uuid("firm_id")
    .notNull()
    .unique()
    .references(() => firms.id, { onDelete: "cascade" }),
  /** One of PATTERN_SHAPES in lib/email-patterns.ts, e.g. "first.last". */
  shape: text("shape").notNull(),
  /** The domain people are actually at - gs.com, not always the firm's website. */
  domain: text("domain").notNull(),
  /** How many observations agreed with `shape`/`domain` above. */
  samples: integer("samples").notNull().default(1),
  /**
   * Every shape/domain actually seen here, keyed "shape|domain" -> count.
   *
   * The winner above is derived from this rather than fixed at first sight, so
   * a firm whose first observed address was unrepresentative can be outvoted
   * by later evidence. Once the winner holds PATTERN_CONFIRMED_SAMPLES with a
   * clear majority, the firm is never enriched again.
   */
  tally: jsonb("tally").notNull().default({}),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ---------- AI contact sourcing (Crustdata) ----------
// One row per click of "Generate contacts" on a firm. Credits are counted from
// these rows rather than from a counter column on `users`, for the same reason
// aiUsage does it: the spend stays auditable (who, which firm, how many came
// back, did it fail) and there is no counter to drift out of step with reality.
//
// A run is inserted as `pending` and only settles to `succeeded`/`failed` once
// the provider answers. Failed runs are not counted against the allowance -
// nobody should pay a credit for our API erroring.

export const contactSourcingStatusEnum = pgEnum("contact_sourcing_status", [
  "pending",
  "succeeded",
  "failed",
]);

export const contactSourcingRuns = pgTable(
  "contact_sourcing_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id, { onDelete: "cascade" }),
    /** One click = one credit = CONTACTS_PER_RUN contacts requested. */
    creditsSpent: integer("credits_spent").notNull().default(1),
    contactsRequested: integer("contacts_requested").notNull().default(5),
    contactsCreated: integer("contacts_created").notNull().default(0),
    status: contactSourcingStatusEnum("status").notNull().default("pending"),
    provider: text("provider").notNull().default("crustdata"),
    /** Human-readable note of what was asked for, so a run can be explained
        later without re-deriving the student's profile as it was that day. */
    querySummary: text("query_summary"),
    error: text("error"),
    /**
     * The intent this run serves: `user:firm:mode[:sequence]`.
     *
     * UNIQUE (partial, where not null). This column is the double-click
     * protection - a second concurrent press collides here and reads back the
     * run the first press created, instead of starting a rival provider
     * workflow and a rival charge. A disabled button in the browser does not
     * survive a reload mid-flight or a second tab; this does.
     *
     * Null on every row written before the idempotency migration. Those rows
     * predate the concept and there is no honest key to backfill them with.
     */
    idempotencyKey: text("idempotency_key"),
    /** generate | refresh | fill. A `fill` shares its predecessor's key. */
    mode: text("mode").notNull().default("generate"),
    /** Which refresh this is, so successive refreshes get distinct keys. */
    refreshSequence: integer("refresh_sequence").notNull().default(0),
    /** CONTACT_ALGORITHM_VERSION (lib/contact-pool). Null before 2026-10-08. */
    algorithmVersion: text("algorithm_version"),
    /** RunMetrics (lib/contact-pool): counts, categories, credits. Redacted by construction. */
    metrics: jsonb("metrics"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    // The allowance check counts a user's rows for the current month on every
    // click, so this index is load-bearing rather than a nice-to-have.
    index("contact_sourcing_user_created_idx").on(table.userId, table.createdAt),
    index("contact_sourcing_user_firm_idx").on(table.userId, table.firmId),
    index("contact_sourcing_user_firm_status_idx").on(table.userId, table.firmId, table.status),
    /**
     * The double-click lock. Rows written before drizzle/0008 carry a null
     * key and coexist freely under it: Postgres indexes nulls as DISTINCT.
     *
     * NOT declared here, because drizzle-kit cannot express a NOT VALID
     * constraint and would emit a validated one that fails on historical
     * rows: drizzle/0008 also adds CHECK contact_sourcing_charge_needs_contacts
     * (credits_spent = 0 OR contacts_created > 0) and CHECK
     * contact_sourcing_credits_nonnegative. Both are real and enforced.
     */
    uniqueIndex("contact_sourcing_idempotency_uq").on(table.idempotencyKey),
  ],
);

/**
 * What happened to a generated contact that the student then deleted.
 *
 * A deletion removes the contact row - and with it the link from its drafts
 * (email_drafts.contact_id is set null) - so this snapshot, taken just before
 * the delete, is the only way a removed contact's run can still be credited
 * with the draft, sent and reply outcomes it had. Ids, a rank and booleans:
 * no name, firm, address or draft text. Live contacts need no row here; their
 * outcomes join through contacts.sourcing_run_id.
 */
export const contactSourcingOutcomes = pgTable(
  "contact_sourcing_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => contactSourcingRuns.id, { onDelete: "cascade" }),
    sourcingRank: integer("sourcing_rank"),
    /** "removed" today. */
    event: text("event").notNull(),
    hadDraft: boolean("had_draft").notNull().default(false),
    markedSent: boolean("marked_sent").notNull().default(false),
    /** true / false as the student reported it on any draft; null if never answered. */
    gotReply: boolean("got_reply"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("contact_sourcing_outcomes_run_idx").on(table.runId)],
);

export const contactSourcingRunsRelations = relations(contactSourcingRuns, ({ one }) => ({
  user: one(users, { fields: [contactSourcingRuns.userId], references: [users.id] }),
  firm: one(firms, { fields: [contactSourcingRuns.firmId], references: [firms.id] }),
}));

// ---------- the firm portal ----------

/**
 * One-time codes for firm sign-up (proving the work inbox) and password reset.
 * Keyed by email rather than user because a sign-up code exists before the
 * account. `purpose` is "signup" | "reset" ("login" rows are from before
 * firms had passwords).
 *
 * `pending` carries what the sign-up form collected (name, the firm it
 * resolved to, the password's HASH) across to the verify step, so nothing is
 * created until the code proves the inbox. Rows are pruned after a day.
 */
export const firmLoginCodes = pgTable(
  "firm_login_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    /** "signup" | "login" */
    purpose: text("purpose").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    /** Set once the code has been used, so it can never be used twice. */
    consumedAt: timestamp("consumed_at"),
    pending: jsonb("pending").$type<{
      name?: string;
      firmId?: string | null;
      firmHint?: string;
      passwordHash?: string;
      nonceHash?: string;
      /** Student sign-up (lib/student-signup): the signature address, and the policy version agreed to. */
      schoolEmail?: string;
      consentVersion?: string;
      /** Student sign-up: the separate, optional Training Use box. Missing means no. */
      trainingOptIn?: boolean;
    }>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("firm_login_codes_email_idx").on(table.email, table.createdAt)],
);

/**
 * What students did with a firm's posts: one row per click.
 *
 * The raw material for the firm's Analytics tab, which only ever reads it in
 * aggregate. `firmId` is stored on every row, even though a posting or an
 * event implies it, so the analytics read is one indexed scan.
 */
export const firmEngagement = pgTable(
  "firm_engagement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "apply_click" | "event_click" */
    kind: text("kind").notNull(),
    postingId: uuid("posting_id").references(() => internshipPostings.id, { onDelete: "set null" }),
    eventId: uuid("event_id").references(() => firmRecruitingEvents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("firm_engagement_firm_idx").on(table.firmId, table.kind, table.createdAt)],
);

// ---------- suggested answers for the drafter ----------

/**
 * Suggested answers for one student writing to one person, cached: the facts
 * the rules found in common and what the model wrote from them. One row per
 * student and recipient ("contact-<id>" or "directory-<id>"), replaced when
 * either side's facts change (inputHash) - so opening the drafter again costs
 * nothing, and a new school on the profile is seen at once.
 */
export const draftSuggestions = pgTable(
  "draft_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    recipientKey: text("recipient_key").notNull(),
    /** What the suggestions were built from; a different hash is stale. */
    inputHash: text("input_hash").notNull(),
    /** The connections the rules found: [{ kind, label, studentFact, theirFact }]. */
    connections: jsonb("connections").notNull(),
    /** Per field: [{ text, source, basis }]. */
    fields: jsonb("fields").notNull(),
    /** Null when only the rules ran. */
    model: text("model"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("draft_suggestions_user_recipient_idx").on(t.userId, t.recipientKey)],
);

/**
 * The firm portal's notification center: numbers worth a firm's attention,
 * written when something crosses a line - an internship's 25th apply click, a
 * surge week, an event tomorrow that 30 students saved. See lib/firm-insights.
 *
 * One row per FIRM, not per person: every teammate sees the same news, and a
 * milestone is a fact about the firm's posts. `dedupeKey` is unique per firm,
 * which is what makes writing them on every portal load safe - a milestone
 * crossed once is announced once. `audience: "owner"` rows (a teammate waiting
 * for approval) are shown to the owner only.
 */
export const firmNotifications = pgTable(
  "firm_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id, { onDelete: "cascade" }),
    dedupeKey: text("dedupe_key").notNull(),
    /** "milestone" | "reach" | "surge" | "weekly" | "deadline" | "event_soon" | "team" */
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    href: text("href").notNull(),
    /** "all" | "owner" */
    audience: text("audience").notNull().default("all"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("firm_notifications_firm_key_idx").on(table.firmId, table.dedupeKey),
    index("firm_notifications_firm_created_idx").on(table.firmId, table.createdAt),
  ],
);

/**
 * Every change Offerly's admins make to firm accounts and firm posts: who did
 * it, to what, and when. Written by lib/firm-admin.ts itself, so any admin UI
 * that calls it is audited without doing anything. Read by listAdminAudit.
 */
export const firmAdminAudit = pgTable(
  "firm_admin_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** "approve_account" | "revoke_account" | "set_owner" | "take_down_post" | "restore_post" */
    action: text("action").notNull(),
    targetUserId: uuid("target_user_id").references(() => users.id, { onDelete: "set null" }),
    targetFirmId: uuid("target_firm_id").references(() => firms.id, { onDelete: "set null" }),
    /** A posting or event id, for post actions. */
    targetPostId: uuid("target_post_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("firm_admin_audit_created_idx").on(table.createdAt)],
);

/**
 * Every sign-in attempt, for slowing down password guessing (lib/login-throttle).
 * One row per attempt - the email as typed (lower-cased) and the caller's IP -
 * so both "one account, many guesses" and "one machine, many accounts" show.
 * Old rows are pruned as new ones are written.
 */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    ip: text("ip"),
    success: boolean("success").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("login_attempts_email_idx").on(table.email, table.createdAt),
    index("login_attempts_ip_idx").on(table.ip, table.createdAt),
  ],
);

/**
 * Speech-to-text spend, in audio seconds the provider actually billed
 * (migration 0043).
 *
 * The coach's limits cap how many answers may be uploaded and
 * upload-validation caps the bytes, but neither bounds the audio MINUTES:
 * durationMs is the browser's claim, and a low-bitrate file of a few hundred
 * kilobytes can be an hour long. These rows hold the duration the provider
 * reports back, so a rolling budget can bound the spend whatever the client
 * claimed. Cascades with the user.
 */
export const sttUsage = pgTable(
  "stt_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    seconds: integer("seconds").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("stt_usage_user_created_idx").on(table.userId, table.createdAt)],
);

/**
 * An append-only record that a metered feature was used once (migration 0042).
 *
 * The monthly allowances (lib/plan-quotas) counted rows in the feature's own
 * table, every one of which the student can delete - which handed the
 * allowance back. This ledger holds the USE, not the content: who, which
 * feature, when. Deleting a draft still deletes the draft and no longer
 * refunds the month. A row is also written as a reservation before a paid call
 * starts, under a per-student lock, so requests fired together queue instead of
 * all passing the same count (what lib/ai-runner does for the daily ceiling),
 * and is removed again if the call never produced anything.
 */
export const featureUsage = pgTable(
  "feature_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    feature: text("feature").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("feature_usage_user_feature_idx").on(table.userId, table.feature, table.createdAt)],
);

/**
 * A generic per-subject rate-limit ledger (migration 0041). One row per
 * metered attempt, keyed by (bucket, subject). The limiter in lib/rate-limit.ts
 * records a row FIRST and then counts the rows written before it in the window,
 * the same record-then-count shape as login_attempts, so a parallel burst is
 * counted rather than every request seeing an empty window and passing. Used by
 * spend levers and write-amplification guards; `subject` is the server-resolved
 * user id (optionally suffixed with a destination) so it cannot be spoofed.
 */
export const rateEvents = pgTable(
  "rate_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bucket: text("bucket").notNull(),
    subject: text("subject").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("rate_events_bucket_subject_idx").on(table.bucket, table.subject, table.createdAt),
  ],
);

/**
 * A student's email choices. A row exists only once they change something;
 * no row means every default, which is "on". Kept off the users table so the
 * app runs unchanged before this table exists.
 */
export const studentEmailPrefs = pgTable("student_email_prefs", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** An email when a firm the student is matched with posts an internship or event. */
  firmPosts: boolean("firm_posts").notNull().default(true),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ---- Discussions ---------------------------------------------------------
//
// Student threads under Networking ("Goldman superday - what to expect?").
// A post can be anonymous: `authorId` is still recorded, so the author can
// delete it and a report can be traced, but it is never sent to a browser -
// lib/discussions turns a row into its display label on the server.
//
// `isSample` marks the seeded example threads (scripts/seed-sample-
// discussions.ts). They carry no author, show a "Sample" label, and one
// DELETE ... WHERE is_sample removes them all. `sampleAuthor` is the label
// they show in place of a person, e.g. "Class of 2027".
//
// 0026_profile_social_crests.sql, applied to the live database first.
export const discussions = pgTable(
  "discussions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    anonymous: boolean("anonymous").default(false).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    // One of DISCUSSION_TOPICS (lib/discussions). Text, not an enum, so the
    // list can change without a migration.
    topic: text("topic").notNull(),
    firmId: uuid("firm_id").references(() => firms.id, { onDelete: "set null" }),
    // As typed. firmId is set only when it matched a firm in the directory.
    firmName: text("firm_name"),
    isSample: boolean("is_sample").default(false).notNull(),
    sampleAuthor: text("sample_author"),
    // Kept on the row so the list is one query, not a count per thread.
    replyCount: integer("reply_count").default(0).notNull(),
    lastActivityAt: timestamp("last_activity_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("discussions_last_activity_idx").on(table.lastActivityAt)],
);

export const discussionReplies = pgTable(
  "discussion_replies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discussionId: uuid("discussion_id")
      .notNull()
      .references(() => discussions.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    anonymous: boolean("anonymous").default(false).notNull(),
    body: text("body").notNull(),
    isSample: boolean("is_sample").default(false).notNull(),
    sampleAuthor: text("sample_author"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("discussion_replies_discussion_idx").on(table.discussionId, table.createdAt)],
);

// ---------- uploaded files ----------

/** Raw bytes. postgres-js hands back a Buffer, PGlite a Uint8Array. */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Every uploaded file: resumes, profile photos and post images.
 *
 * In the database rather than on disk because the app has no disk that lasts:
 * on Vercel each request can land on a fresh server, and in local development
 * a file written to one person's machine is invisible to everyone else sharing
 * the same database. Keyed by the random name lib/file-store's callers
 * generate, which is what users.resume_storage_path, users.avatar_storage_path,
 * resume_reviews.storage_path and the feed's image_path already hold.
 *
 * Capped at 4MB per file by the callers - under Vercel's 4.5MB limit on a
 * request or response body, which every upload and download passes through.
 */
export const storedFiles = pgTable(
  "stored_files",
  {
    /** "resume", "avatar" or "post-image": the same key never means two files. */
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    contentType: text("content_type").notNull(),
    bytes: bytea("bytes").notNull(),
    byteSize: integer("byte_size").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.kind, table.key] })],
);

// ---------- news pipeline ----------
//
// The News tab used to fetch seven RSS feeds on every page view and sort them
// into sectors with headline regexes. That left eight of the fourteen sector
// tabs empty. These tables are what replaces it: a scheduled job collects from
// a reviewed list of sources, a model labels each story, stories about the same
// event are grouped, and the page reads the ranked result.
//
// Nothing here stores article text. A story is its headline, link, date, image
// and the publisher's own feed summary (cut to 400 characters) - the same
// things the publisher puts in its RSS feed for exactly this use.
//
// Tier, status, story type and sector are plain text rather than Postgres
// enums. They are validated in src/lib/news/types.ts, and a new story type
// should not need a migration against the live database.

/**
 * Where news comes from. The reviewed registry: a source only feeds the
 * pipeline once `status` is "approved", and trade press only ever reaches the
 * tabs listed in `sectors` - Artemis fills Insurance and never Main.
 */
export const newsSources = pgTable("news_sources", {
  /** A stable slug ("artemis", "google-majors-pe"), so a re-seed updates rather than duplicates. */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  domain: text("domain").notNull(),
  /** "primary" (a filing or regulator), "major" (a national newsroom), "trade" or "blocked". */
  tier: text("tier").notNull(),
  /** The sectors this source is trusted for. Empty for a major, which is trusted for any. */
  sectors: text("sectors").array().notNull(),
  /** "rss", "google_site", "edgar" or "regulator". */
  kind: text("kind").notNull(),
  url: text("url").notNull(),
  region: text("region").notNull().default("global"),
  paywall: boolean("paywall").notNull().default(false),
  /** "proposed" (by the scout), "approved", "rejected" or "retired". Only a person approves. */
  status: text("status").notNull().default("proposed"),
  /** The scout's measurements when it proposed the source: volume, relevance, filler rates. */
  metrics: jsonb("metrics"),
  notes: text("notes"),
  lastFetchedAt: timestamp("last_fetched_at"),
  /** The newest story it has ever given us. Silence past 48 hours raises an alert. */
  lastItemAt: timestamp("last_item_at"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  approvedAt: timestamp("approved_at"),
});

/** One story from one source, after the code filters and before any model sees it. */
export const newsItems = pgTable(
  "news_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: text("source_id")
      .notNull()
      .references(() => newsSources.id),
    /** sha256 of the canonical URL (tracking parameters stripped). The dedup key. */
    urlHash: text("url_hash").notNull(),
    url: text("url").notNull(),
    title: text("title").notNull(),
    /** The publisher's own feed summary, HTML stripped, at most 400 characters. */
    description: text("description"),
    publisher: text("publisher").notNull(),
    publisherDomain: text("publisher_domain"),
    imageUrl: text("image_url"),
    publishedAt: timestamp("published_at").notNull(),
    fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
    /** Normalised headline, so a Reuters story syndicated by Yahoo merges instead of repeating. */
    titleKey: text("title_key").notNull(),
    /** Other publishers carrying the same headline. Counts as corroboration in ranking. */
    alsoPublishedBy: text("also_published_by").array().notNull().default(sql`'{}'::text[]`),
    /** "rss", "google", "edgar" or "regulator". */
    origin: text("origin").notNull(),
    /** For EDGAR items, the form ("S-1", "SC 13D"); the story type follows from it. */
    filingForm: text("filing_form"),
    /** "new" (awaiting a label), "labeled", "failed" (retry later) or "skipped" (never sent to a model). */
    status: text("status").notNull().default("new"),
    classifyAttempts: integer("classify_attempts").notNull().default(0),
    clusterId: uuid("cluster_id"),
    /**
     * Taken down: never grouped, ranked or shown again. Set by an admin
     * (`npm run news:sources -- hide`) or automatically once enough students
     * report the story. Hiding covers every outlet's copy of the event.
     */
    hiddenAt: timestamp("hidden_at"),
    /** "admin: <why>" or "reports". */
    hiddenReason: text("hidden_reason"),
    /**
     * The photo the feed carried, before any check. `imageUrl` above is only
     * ever a photo that passed (src/lib/news/photos.ts), so an unchecked or
     * rejected image can never reach a card.
     */
    imageCandidate: text("image_candidate"),
    /** The publisher's own address for a story that arrived as a Google News link. */
    resolvedUrl: text("resolved_url"),
    /** Where the shown photo came from: feed, sitemap, share (og:image), jsonld or article. */
    imageSource: text("image_source"),
    /**
     * sha256 of the exact bytes the photo check passed. Students' browsers load
     * the photo through /api/news-image, which serves it only if the
     * publisher's server still returns those bytes - so what a student sees is
     * what was checked, not whatever the host decides to send a browser.
     */
    imageHash: text("image_hash"),
    /** When the photo step looked at this story, found a photo or not - so it looks once. */
    imageCheckedAt: timestamp("image_checked_at"),
  },
  (table) => [
    uniqueIndex("news_items_url_hash_key").on(table.urlHash),
    index("news_items_status_idx").on(table.status),
    index("news_items_published_idx").on(table.publishedAt),
    index("news_items_title_key_idx").on(table.titleKey),
  ],
);

/**
 * The daily briefing: short, sourced bullets written each morning from the
 * stories collected. One row per edition per scope - "general" (economy,
 * policy, markets overall, recruiting) and one per sector (its deals and
 * market moves). A student's briefing is the general row plus their sectors',
 * so no model runs per student.
 */
export const newsBriefings = pgTable(
  "news_briefings",
  {
    editionDate: text("edition_date").notNull(),
    scope: text("scope").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.editionDate, table.scope] })],
);

/**
 * A story's summary for the panel a card opens: two or three key points and
 * the takeaway, written once by the pipeline (src/lib/news/summary.ts) from
 * the article's text, or from the headline and feed summaries when the page is
 * paywalled. "thin" means there was too little to summarise - the panel then
 * shows only the link to the article.
 */
export const newsSummaries = pgTable("news_summaries", {
  itemId: uuid("item_id")
    .primaryKey()
    .references(() => newsItems.id, { onDelete: "cascade" }),
  /** "ok", "thin" (too little to go on) or "failed" (retried next run). */
  status: text("status").notNull(),
  /** { points, takeaway, basis } when ok. */
  payload: jsonb("payload"),
  model: text("model"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * A student flagging a story. Fixed reasons only - no free text, so nothing a
 * student writes is stored or shown. One report per student per story; enough
 * of them hide the story until an admin looks (src/lib/news/takedown.ts).
 */
export const newsReports = pgTable(
  "news_reports",
  {
    itemId: uuid("item_id")
      .notNull()
      .references(() => newsItems.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.itemId, table.userId] })],
);

/**
 * What the classifier said about a story. One row per story; `classifierVersion`
 * is a hash of the prompt and model, so a label can always be traced to the
 * exact prompt that produced it and a prompt change can relabel selectively.
 */
export const newsLabels = pgTable("news_labels", {
  itemId: uuid("item_id")
    .primaryKey()
    .references(() => newsItems.id, { onDelete: "cascade" }),
  classifierVersion: text("classifier_version").notNull(),
  model: text("model").notNull(),
  relevant: boolean("relevant").notNull(),
  /** Why a story was judged not relevant, or "insufficient_info" when the model declined to guess. */
  abstain: text("abstain"),
  primarySector: text("primary_sector"),
  /** Every sector the story belongs to, primary first. At most three. */
  sectors: text("sectors").array().notNull(),
  /**
   * Specialties within those sectors, from the onboarding list ("Healthcare
   * Coverage", "Direct Lending") - what matches a story to the specialties a
   * student picked. Empty for labels written before 30 September 2026.
   */
  specialties: text("specialties").array().notNull().default(sql`'{}'::text[]`),
  storyType: text("story_type"),
  /** 1-4: how much a professional in the sector would expect a candidate to know it. */
  worthiness: integer("worthiness"),
  /** [{ name, role }], each name checked to appear in the headline or summary. */
  entities: jsonb("entities").notNull(),
  amountUsd: doublePrecision("amount_usd"),
  region: text("region"),
  labeledAt: timestamp("labeled_at").defaultNow().notNull(),
});

/** Firms a story is about, linked by exact alias only - an ambiguous name stays unlinked. */
export const newsItemFirms = pgTable(
  "news_item_firms",
  {
    itemId: uuid("item_id")
      .notNull()
      .references(() => newsItems.id, { onDelete: "cascade" }),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.firmId] }),
    index("news_item_firms_firm_idx").on(table.firmId),
  ],
);

/**
 * Stories about the same event, from however many outlets covered it. The page
 * shows one card per cluster, and the number of publishers is the strongest
 * accuracy signal the ranking has.
 */
export const newsClusters = pgTable(
  "news_clusters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadItemId: uuid("lead_item_id").notNull(),
    storyType: text("story_type"),
    primarySector: text("primary_sector"),
    sectors: text("sectors").array().notNull(),
    /** Every specialty any member was tagged with, for the student digest to match on. */
    specialties: text("specialties").array().notNull().default(sql`'{}'::text[]`),
    publisherCount: integer("publisher_count").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at").notNull(),
    lastSeenAt: timestamp("last_seen_at").notNull(),
    /** { [sector]: score, main: score } from the ranking formula, refreshed every run. */
    scores: jsonb("scores").notNull(),
    rankedAt: timestamp("ranked_at").defaultNow().notNull(),
  },
  (table) => [index("news_clusters_last_seen_idx").on(table.lastSeenAt)],
);

/** The sector desk's top three per sector, with the question it suggests a student ask. */
export const newsSectorPicks = pgTable(
  "news_sector_picks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sector: text("sector").notNull(),
    runId: text("run_id").notNull(),
    clusterId: uuid("cluster_id").notNull(),
    rank: integer("rank").notNull(),
    /** Null when the question failed a check - the pick still shows, without its line. */
    question: text("question"),
    /** The desk's reason, for review only. Never shown to a student. */
    reason: text("reason"),
    pickedAt: timestamp("picked_at").defaultNow().notNull(),
  },
  (table) => [index("news_sector_picks_sector_idx").on(table.sector, table.pickedAt)],
);

/**
 * Model spend by background jobs, which have no user to charge. ai_usage cannot
 * hold these: its user_id is NOT NULL and its quota counts per student.
 */
export const aiJobUsage = pgTable(
  "ai_job_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    feature: text("feature").notNull(),
    model: text("model").notNull(),
    /** "claude-cli" (the local subscription) or "api". */
    engine: text("engine").notNull(),
    items: integer("items").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    /** What the call would have cost on the API. On the subscription it is notional, and still worth watching. */
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    ok: boolean("ok").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("ai_job_usage_feature_created_idx").on(table.feature, table.createdAt)],
);

/**
 * One student's news digest for one day - the morning edition. Built the first
 * time the student opens News that day (in their time zone) and kept, so the
 * page reads the same all day like a newspaper; breaking stories still reach
 * the sector tabs. The payload is the assembled sections, stored rather than
 * recomputed because the ranking under it moves every 30 minutes.
 */
export const newsDigests = pgTable(
  "news_digests",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The student's local date, YYYY-MM-DD. */
    editionDate: text("edition_date").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.editionDate] })],
);

// ---------- video interview coach (Interview Prep > Video interview) ----------
//
// Four tables, all new, none altering an existing one - so the app runs
// unchanged on a database that has not had migration 0029 yet; only the video
// coach itself needs it. Every row carries user_id and cascades from users, so
// deleting an account removes the lot (the retained audio's bytes are removed
// by the account-deletion action, which reads their keys first).

/**
 * One five-question interview. The answers live on video_interview_questions,
 * one row per question, which is what lets a reload resume mid-interview.
 */
export const videoInterviewSessions = pgTable(
  "video_interview_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "behavioral" | "technical" | "both" */
    mode: text("mode").notNull(),
    /** What the difficulty resolved to: a level, or "auto". */
    difficulty: text("difficulty").notNull(),
    thinkSeconds: integer("think_seconds").notNull(),
    answerSeconds: integer("answer_seconds").notNull(),
    /** "in_progress" | "complete" | "abandoned" */
    status: text("status").notNull().default("in_progress"),
    /** Plain-language note of what the technicals were tailored to. */
    tailoredTo: text("tailored_to").notNull().default(""),
    /** The VIDEO_POLICY_VERSION the student agreed to for analysis. */
    analysisPolicyVersion: text("analysis_policy_version").notNull(),
    /** The final report (lib/video-interview/types InterviewReport). */
    report: jsonb("report"),
    /**
     * Per-interview training consent (migration 0032): the student's answer
     * to "contribute this interview?", asked every time an interview starts,
     * recorded here before any recording can begin. The ONLY thing that
     * authorises a training-video upload for this session. False by default -
     * every session from before 0032 is opted out.
     */
    trainingOptIn: boolean("training_opt_in").notNull().default(false),
    /** VIDEO_POLICY_VERSION the decision (yes or no) was made under. */
    trainingPolicyVersion: text("training_policy_version"),
    trainingDecidedAt: timestamp("training_decided_at"),
    /** Set when the student later deleted their training recordings. */
    trainingWithdrawnAt: timestamp("training_withdrawn_at"),
    /** One per "Start interview" dialog, so a double-click is one session. */
    startToken: text("start_token"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (t) => [
    index("video_interview_sessions_user_idx").on(t.userId, t.createdAt),
    uniqueIndex("video_interview_sessions_start_token_idx").on(t.userId, t.startToken),
  ],
);

/**
 * A question as asked in a session, and the student's answer to it.
 *
 * Holds the bank id, never the expected points: grading looks those up from
 * the server-side bank by id, so there is no copy of an answer key anywhere a
 * query for the browser could reach.
 */
export const videoInterviewQuestions = pgTable(
  "video_interview_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => videoInterviewSessions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    /** "behavioral" | "technical" */
    kind: text("kind").notNull(),
    bankId: text("bank_id").notNull(),
    category: text("category"),
    topic: text("topic").notNull(),
    difficulty: text("difficulty").notNull(),
    prompt: text("prompt").notNull(),
    /** "pending" | "processing" | "complete" | "failed" | "skipped" */
    status: text("status").notNull().default("pending"),
    /** When the browser was shown this question (its think time began).
     *  An answer cannot be longer than the time since. */
    askedAt: timestamp("asked_at"),
    /** Submissions tried, so a stuck answer can be told from a new one. */
    attempts: integer("attempts").notNull().default(0),
    processingStartedAt: timestamp("processing_started_at"),
    durationMs: integer("duration_ms"),
    audioContentType: text("audio_content_type"),
    audioBytes: integer("audio_bytes"),
    transcript: text("transcript"),
    /** "ok" | "unconfigured" | "failed" */
    transcriptionStatus: text("transcription_status"),
    /** "full" | "delivery_only" | "failed" */
    gradingStatus: text("grading_status"),
    feedback: jsonb("feedback"),
    overallScore: integer("overall_score"),
    /** A plain-language reason, shown to the student. Never a stack trace. */
    lastError: text("last_error"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("video_interview_questions_session_position_idx").on(t.sessionId, t.position),
    index("video_interview_questions_user_idx").on(t.userId, t.createdAt),
  ],
);

/**
 * An answer's camera recording (video with its audio), kept ONLY because the
 * student opted in to training and private object storage is configured. No
 * row means nothing was kept. The bytes live in the bucket, never here.
 *
 * Lifecycle (migration 0030): "pending" while the browser uploads through a
 * short-lived signed URL, "stored" once the server has checked the object,
 * "deleting" while its object is being removed. A pending row past
 * expires_at is swept, object and all.
 *
 * Deliberately thin: no device, no location, no voice or face derived
 * attributes - just what is needed to find, attribute and delete the object,
 * and the consent it was kept under.
 */
export const videoInterviewRecordings = pgTable(
  "video_interview_recordings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionId: uuid("question_id")
      .notNull()
      .references(() => videoInterviewQuestions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Which lib/video-interview/recording-storage driver holds the bytes. */
    storageDriver: text("storage_driver").notNull(),
    /** A random key, never derived from the user, session or question. */
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    durationMs: integer("duration_ms").notNull(),
    /** The VIDEO_POLICY_VERSION of the training opt-in this was kept under. */
    trainingPolicyVersion: text("training_policy_version").notNull(),
    /** "pending" | "stored" | "deleting" */
    status: text("status").notNull().default("stored"),
    /** When an unconfirmed upload is given up on. Null once stored. */
    expiresAt: timestamp("expires_at"),
    confirmedAt: timestamp("confirmed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("video_interview_recordings_question_idx").on(t.questionId),
    index("video_interview_recordings_user_idx").on(t.userId),
  ],
);

/**
 * Every consent decision about the video coach, appended, never edited: the
 * current state is the newest row of each kind. A log rather than two columns
 * so "what did they agree to, and when did they take it back?" has an answer.
 */
export const videoInterviewConsentEvents = pgTable(
  "video_interview_consent_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * "analysis_granted" | "training_standing_yes" | "training_standing_no"
     * (the standing training answer - see video-interview/consent), or the
     * history-only "training_granted" | "training_revoked". Checked in SQL.
     */
    kind: text("kind").notNull(),
    policyVersion: text("policy_version").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("video_interview_consent_user_idx").on(t.userId, t.createdAt)],
);

/**
 * The interview question bank - the video coach's runtime source of truth
 * (migration 0030). Seeded from the authored bank in src/lib/question-bank/data
 * by scripts/seed-interview-questions.ts, keyed by the authored stable id, so
 * re-seeding updates rows in place and never duplicates or deletes one.
 *
 * `expected_points` is the answer key. It is read in exactly one place -
 * lib/video-interview/question-bank-db expectedPointsFor(), at grading time -
 * and every other query selects named columns without it.
 */
export const interviewQuestions = pgTable(
  "interview_questions",
  {
    /** The authored stable id, e.g. "investment_banking.restructuring.t004". */
    id: text("id").primaryKey(),
    /** "behavioral" | "technical" */
    kind: text("kind").notNull(),
    prompt: text("prompt").notNull(),
    topic: text("topic").notNull(),
    /** firm_program_category value; null for a universal behavioral question. */
    category: text("category"),
    /** A QUIZ_SPECIALTIES value within the category, or null for the whole sector. */
    specialty: text("specialty"),
    /** "foundational" | "intermediate" | "advanced" */
    difficulty: text("difficulty").notNull(),
    /** Server-only grading criteria: what a strong answer conveys. */
    expectedPoints: jsonb("expected_points").$type<string[]>().notNull(),
    /** In the stable behavioral core every interview draws from. */
    isBehavioralCore: boolean("is_behavioral_core").notNull().default(false),
    /** Core: rotation order (0 = the anchor). Technical: a small weight boost. */
    rotationPriority: integer("rotation_priority").notNull().default(0),
    /** Inactive questions are never served. Re-seeding does not re-activate. */
    active: boolean("active").notNull().default(true),
    source: text("source").notNull().default("authored"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("interview_questions_serving_idx").on(t.kind, t.category, t.active),
    index("interview_questions_core_idx").on(t.isBehavioralCore, t.rotationPriority),
  ],
);

/**
 * Objects in private storage that still have to be deleted, when the store
 * could not be reached at the moment their owner went away (migration 0031).
 *
 * Deliberately NOT linked to users: account deletion cascades every row that
 * references the student, and this queue exists precisely to outlive that
 * cascade - it is the only record left of where the bytes are. For the same
 * reason it holds nothing personal: the provider, the random object key, and
 * the bookkeeping needed to retry. A row is removed only once the object is
 * confirmed gone (lib/video-interview/deletion-queue).
 */
export const objectDeletionQueue = pgTable(
  "object_deletion_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Which storage provider holds the object ("s3"). */
    provider: text("provider").notNull(),
    /** The random object key - never derived from the user. */
    objectKey: text("object_key").notNull(),
    attempts: integer("attempts").notNull().default(0),
    /** "storage_unconfigured" | "storage_error" - a category, never a message. */
    lastErrorCategory: text("last_error_category"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastAttemptAt: timestamp("last_attempt_at"),
  },
  (t) => [uniqueIndex("object_deletion_queue_key_idx").on(t.provider, t.objectKey)],
);

// ---------- pre-launch waitlist ----------

export const waitlistKindEnum = pgEnum("waitlist_kind", ["student", "firm"]);

/**
 * People who asked to be told when Offerly opens, before they could make an
 * account. Until launch this is the only thing the public site does.
 *
 * One table for both audiences rather than two. They share everything that
 * carries risk - the dedup key, the consent record, the invite token, the
 * conversion link - and differ only in two columns each, so a `kind` column
 * and a CHECK is one library, one action, one admin screen and one export
 * where two tables would be two of each.
 *
 * TWO EMAIL COLUMNS, on purpose. `emailCanonical` is canonicalMailbox() of
 * what was typed: it folds +tags away and, at dot-blind hosts, dots, which is
 * exactly what a unique key needs so one person cannot take six places in the
 * queue. It is NOT a deliverable address - 'a.b+x@gmail.com' canonicalises to
 * 'ab@gmail.com', which may belong to someone else entirely. The launch email
 * goes to `email`, as typed. Keying on one and mailing the other is the whole
 * reason both exist.
 *
 * Consent lives here rather than in consent_events because that ledger is the
 * record of what an ACCOUNT HOLDER agreed to at a policy version, keyed to a
 * user row and changeable from Settings. Someone on this list has neither.
 * When they ask to come off, deleting this row takes the consent with it.
 *
 * 0051_waitlist_signups.sql.
 */
export const waitlistSignups = pgTable(
  "waitlist_signups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: waitlistKindEnum("kind").notNull(),
    /** As typed. This is the address a launch email is actually sent to. */
    email: text("email").notNull(),
    /** canonicalMailbox(email) - the dedup key, never a send target. */
    emailCanonical: text("email_canonical").notNull().unique(),
    name: text("name").notNull(),
    /** Students only; as typed, so an unseeded school still gets in. */
    school: text("school"),
    gradYear: integer("grad_year"),
    /** Firms only. */
    firmName: text("firm_name"),
    title: text("title"),
    /** 32 hex chars. Prefills signup at launch; confers nothing else. */
    inviteToken: text("invite_token").notNull().unique(),
    emailConsent: boolean("email_consent").notNull(),
    /** The policy version on screen when they agreed. */
    policyVersion: text("policy_version").notNull(),
    /** ?src= on the landing URL, [a-z0-9_-]{1,32}, or null. */
    source: text("source"),
    /** Set once this person signs up through their invite link. */
    convertedUserId: uuid("converted_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("waitlist_signups_created_idx").on(t.createdAt),
    index("waitlist_signups_kind_idx").on(t.kind, t.createdAt),
    index("waitlist_signups_school_idx").on(t.school, t.gradYear),
  ],
);
