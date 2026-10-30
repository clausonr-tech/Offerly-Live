import { z } from "zod";
import { isValidGpa } from "./gpa";
import { externalHref } from "./safe-url";
import type { FirmProgramCategory } from "./firm-metadata";

/**
 * The two URL rules every link field in this file uses.
 *
 * `z.string().max(500)` is not a URL check: it accepted `javascript:alert(1)`,
 * which then reached a student's screen as an href. Written here once rather
 * than inline per field, because the LinkedIn rule already existed on
 * profileLinksSchema and nowhere else - and the fields that lacked it
 * (contactSchema, the CSV import, applicationSchema) are the ones a third
 * party or a pasted file fills in (security review, 10 October 2026).
 *
 * Both are written to PASS the empty string, so a field that is `.optional()`
 * or `.or(z.literal(""))` still means "not set" rather than failing the form.
 */
export const isLinkedinUrl = (v: string): boolean => {
  if (v === "") return true;
  // new URL() strips \n, \r and \t before parsing, and every caller of this
  // predicate stores the RAW input - so a newline-bearing value passes the check
  // and is kept verbatim, which is how a forged line reaches a prompt or an
  // email body. linkedinLink() below returns url.href for the paths that store
  // it; this is the same guard for the paths that only validate.
  if (/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && /(^|\.)linkedin\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
};
export const LINKEDIN_URL_MESSAGE = "That should be a linkedin.com link, starting with https://";

/**
 * Any employer's apply link - so a linkedin.com rule would be wrong here.
 *
 * Delegates to lib/safe-url rather than restating the policy: the render
 * boundary already decides what a student may be sent to, and a value this
 * accepts but `externalHref` later drops is a link the student watches do
 * nothing. One policy, asked at both ends.
 */
export const isPublicWebUrl = (v: string): boolean => v === "" || externalHref(v) !== undefined;
export const WEB_URL_MESSAGE = "That should be a web link, starting with https://";

export const contactSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  firm: z.string().max(200).optional().or(z.literal("")),
  role: z.string().max(200).optional().or(z.literal("")),
  // A contact's LinkedIn becomes an href on the contacts grid and the company
  // page, and this schema is one of the two ways a row gets one.
  linkedinUrl: z
    .string()
    .max(500)
    .refine(isLinkedinUrl, LINKEDIN_URL_MESSAGE)
    .optional()
    .or(z.literal("")),
  email: z.string().max(200).optional().or(z.literal("")),
  school: z.string().max(200).optional().or(z.literal("")),
  background: z.string().max(2000).optional().or(z.literal("")),
  notes: z.string().max(4000).optional().or(z.literal("")),
  relationshipStatus: z.enum([
    "not_contacted",
    "reached_out",
    "in_conversation",
    "ongoing",
    "cold",
  ]),
  lastContactDate: z.string().optional().or(z.literal("")),
});

const applicationCategorySchema = z.enum([
  "investment_banking",
  "private_equity",
  "real_estate",
  "hedge_fund",
  "asset_management",
  "corporate_finance",
  "consulting",
  "other",
]);

export const applicationSchema = z.object({
  firm: z.string().min(1, "Firm is required").max(200),
  role: z.string().min(1, "Role is required").max(200),
  status: z.enum([
    "not_started",
    "in_progress",
    "submitted",
    "interviewing",
    "offer",
    "rejected",
  ]),
  category: applicationCategorySchema.optional().or(z.literal("")),
  compensation: z.string().optional().or(z.literal("")),
  // Rendered as the "open the application" button on the detail page, so it
  // has to be somewhere a student can actually be sent.
  applicationUrl: z
    .string()
    .max(500)
    .refine(isPublicWebUrl, WEB_URL_MESSAGE)
    .optional()
    .or(z.literal("")),
  notes: z.string().max(4000).optional().or(z.literal("")),
  appliedDate: z.string().optional().or(z.literal("")),
});

// Must list every firm_program_category. Onboarding builds its sector
// checkboxes from CATEGORY_LABELS, which is keyed by FirmProgramCategory, so
// any value missing here is still offered to the student and then rejected on
// submit - which is exactly what happened to "consulting": it was in the enum
// and on the form, but not in this list, so picking it failed validation with
// no way for the student to tell which choice was at fault.
//
// The assertion below is what stops that recurring. It is a compile-time
// check, not a runtime one: adding a category to the enum without adding it
// here now fails the typecheck instead of reaching a student.
export const FIRM_PROGRAM_CATEGORIES = [
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
] as const;

// A type-only import, so it is erased at build time and pulls none of
// firm-content's ~4,700 lines (or its bulk seed JSON) into any bundle.
type Covers<Listed extends FirmProgramCategory> = [FirmProgramCategory] extends [Listed]
  ? true
  : ["MISSING FROM FIRM_PROGRAM_CATEGORIES:", Exclude<FirmProgramCategory, Listed>];
const _allCategoriesListed: Covers<(typeof FIRM_PROGRAM_CATEGORIES)[number]> = true;
void _allCategoriesListed;

// Account tab, "About you". Everything recruiting-related is edited on the
// Interests tab by the recruiting-answers editor instead.
export const accountSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  school: z.string().max(200).optional().or(z.literal("")),
  // Grad year, hometown and target group are edited on the Interests tab; these
  // are the public-profile settings, which live with the rest of "About you".
  aboutMe: z.string().max(600).optional().or(z.literal("")),
  showHometownOnProfile: z.boolean().optional().default(false),
  showInterestsOnProfile: z.boolean().optional().default(false),
  major: z.string().max(200).optional().or(z.literal("")),
});

// Interests tab: the two profile answers outside the onboarding question bank.
export const moreAnswersSchema = z.object({
  targetGroup: z.string().max(200).optional().or(z.literal("")),
  challengeLearned: z.string().max(1500).optional().or(z.literal("")),
});

export const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password").max(200),
    newPassword: z.string().min(8, "New password must be at least 8 characters").max(200),
    confirmPassword: z.string().max(200),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "The new passwords don't match",
    path: ["confirmPassword"],
  });

export const signupSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  email: z.string().email("Enter a valid email").max(200),
  // Goes under the sign-off of every email drafted in Offerly. Separate from the
  // login email, which may be personal.
  schoolEmail: z.string().email("Enter a valid school email").max(200),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  // Checked on the server rather than trusted from the checkbox's own
  // `required` attribute - that attribute is a browser convenience and says
  // nothing about what actually arrived in the POST. The entire value of a
  // consent record is that it is defensible, so agreement is confirmed here
  // before the account row is written, not assumed from the markup.
  consent: z.literal("on", {
    message: "Please agree to the terms and privacy policy to continue.",
  }),
});

export const loginSchema = z.object({
  email: z.string().email("Enter a valid email").max(200),
  password: z.string().min(1, "Password is required").max(200),
});

export const schoolVerificationRequestSchema = z.object({
  schoolEmail: z.string().email("Enter a valid email address").max(200),
});

// The code is always 6 digits (see generateVerificationCode). Rejecting
// anything else here means malformed input never reaches the attempt counter,
// so typos can't burn a student's retry budget.
export const schoolVerificationConfirmSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit code from your email"),
});

// Free-text answers are capped generously rather than tightly - these feed a
// model prompt, and truncating a student's "why finance" answer costs more
// than the bytes save.
const shortText = z.string().max(400).optional().default("");
const longText = z.string().max(1500).optional().default("");
const oneOf = z.string().max(120).optional().default("");

export const onboardingSchema = z.object({
  preferredCategories: z.array(z.enum(FIRM_PROGRAM_CATEGORIES)).min(1, "Pick at least one sector"),
  nicheInterests: z.array(z.string().max(100)).max(60).optional().default([]),
  ibTierPreferences: z.array(z.string().max(50)).max(10).optional().default([]),
  peTierPreferences: z.array(z.string().max(50)).max(10).optional().default([]),
  targetLocations: z.array(z.string().max(100)).max(20).optional().default([]),

  // deepened onboarding
  degreeLevel: z.enum(["Bachelor's", "Master's or MBA", "PhD", ""]).optional().default(""),
  recruitingStage: oneOf,
  gradYear: oneOf,
  targetInternshipYear: oneOf,
  priorExperience: z.array(z.string().max(80)).max(20).optional().default([]),
  clubsAndActivities: shortText,
  technicalReadiness: oneOf,
  motivations: longText,
  workStyle: oneOf,
  proudExperience: longText,
  interests: shortText,
  major: z.string().max(120).optional().default(""),
  hometown: z.string().max(120).optional().default(""),
  homeCountry: z.string().max(80).optional().default(""),
  sponsorshipNeeded: oneOf,
  gpaBand: z
    .string()
    .trim()
    .max(5)
    .optional()
    .default("")
    .refine((v) => v === "" || isValidGpa(v), "Enter your GPA as a number, like 3.72"),
  onboardingUnsure: z.array(z.string().max(60)).max(40).optional().default([]),
});

/** The cap on a stored LinkedIn link: longer than any real profile address. */
export const LINKEDIN_URL_MAX = 500;

/**
 * A LinkedIn link as it will be STORED, or the reason it was refused.
 *
 * The raw input is never what gets stored. WHATWG `new URL()` strips ASCII tab,
 * CR and LF *before* parsing, so "https://www.linkedin.com/in/x\n\nSTUDENT\n..."
 * parses as a clean linkedin.com address while the newlines survive in the
 * string - and that string goes into the draft prompt's STUDENT block and into
 * the signature of the email the student sends. So anything carrying whitespace
 * or a control character is refused, and what comes back is `url.href`: the
 * parser's own normalised form, which is all the blocked-language exemption for
 * this field ever claimed it was.
 */
export function linkedinLink(raw: string): { href: string | null } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { href: null };
  if (trimmed.length > LINKEDIN_URL_MAX) return { error: "That link is too long. Paste just the profile address." };
  if (/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(trimmed)) return { error: "Paste the link on one line." };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: "Paste the full link, starting with https://" };
  }
  // It lands in emails sent to bankers, so only a real LinkedIn address.
  // z.string().url() alone accepts javascript: and data: URLs, and this link is
  // shown to recruiters and other students as something to click.
  if (url.protocol !== "https:" || !/(^|\.)linkedin\.com$/i.test(url.hostname)) {
    return { error: "That should be a linkedin.com link, starting with https://" };
  }
  return { href: url.href };
}

export const profileLinksSchema = z.object({
  // https linkedin.com only, and stored as url.href - the same rule and the
  // same helper as updateLinkedin in profile/actions.
  linkedinUrl: z
    .string()
    .max(LINKEDIN_URL_MAX)
    .optional()
    .default("")
    .superRefine((v, ctx) => {
      const link = linkedinLink(v);
      if ("error" in link) ctx.addIssue({ code: "custom", message: link.error });
    })
    .transform((v) => {
      const link = linkedinLink(v);
      return "error" in link ? "" : (link.href ?? "");
    }),
});

export const eventSchema = z.object({
  type: z.enum(["meeting", "coffee_chat", "deadline", "info_session", "personal", "interview"]),
  title: z.string().min(1, "Title is required").max(300),
  notes: z.string().max(2000).optional().or(z.literal("")),
  eventDate: z.string().min(1, "Date is required"),
  endDate: z.string().optional().or(z.literal("")),
  contactId: z.string().optional().or(z.literal("")),
  applicationId: z.string().optional().or(z.literal("")),
});

// ---------- community feed posts ----------

export const postSchema = z.object({
  type: z.enum(["event", "speaker_event", "coffee_chat", "deadline", "announcement"]),
  title: z.string().min(1, "Title is required").max(200),
  body: z.string().min(1, "Add a description so students know what this is").max(4000),
  // "" is what an unselected <select> submits; both it and a real category
  // are valid, so the action maps "" to null rather than rejecting.
  category: z.string().max(60).optional().or(z.literal("")),
  location: z.string().max(200).optional().or(z.literal("")),
  // Only length-checked here; the action runs it through normaliseHttpUrl,
  // which is what actually rejects javascript:/data: hrefs. Kept as a plain
  // string so "wharton.edu/apply" (no scheme) is accepted and normalised
  // rather than rejected as invalid.
  linkUrl: z.string().max(500).optional().or(z.literal("")),
  linkLabel: z.enum(["details", "sign_up", "rsvp", "apply", "register"]).default("details"),
  startsAt: z.string().optional().or(z.literal("")),
  endsAt: z.string().optional().or(z.literal("")),
  // Scope to the poster's own school, or leave open to every school.
  schoolScope: z.enum(["own", "all"]).default("all"),
});

// ---------- pre-launch waitlist ----------

/**
 * A graduation year is a <select> of the next nine intakes, so a value outside
 * that window did not come from a student using the form. Bounded rather than
 * free because users.grad_year drives year arithmetic across the app, and a
 * waitlist row seeds it at conversion.
 */
export function gradYearWindow(now: Date = new Date()): { min: number; max: number } {
  const year = now.getUTCFullYear();
  return { min: year, max: year + 8 };
}

const waitlistShared = {
  name: z.string().min(1, "Name is required").max(200),
  email: z.string().email("Enter a valid email").max(200),
  // Checked here rather than trusted from the checkbox's `required` attribute,
  // for the reason signupSchema gives: that attribute is a browser convenience
  // and says nothing about what arrived in the POST. A consent record is worth
  // having only if it is defensible.
  emailConsent: z.literal("on", {
    message: "Tick the box so we can email you when Offerly opens.",
  }),
};

export function waitlistSchema(now: Date = new Date()) {
  const { min, max } = gradYearWindow(now);
  return z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("student"),
      ...waitlistShared,
      school: z.string().min(1, "Tell us where you study").max(200),
      gradYear: z.coerce
        .number()
        .int()
        .min(min, "Choose your graduation year")
        .max(max, "Choose your graduation year"),
    }),
    z.object({
      kind: z.literal("firm"),
      ...waitlistShared,
      firmName: z.string().min(1, "Firm name is required").max(200),
      title: z.string().min(1, "Your title is required").max(200),
    }),
  ]);
}

export type WaitlistInput = z.infer<ReturnType<typeof waitlistSchema>>;
