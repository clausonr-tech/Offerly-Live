import "server-only";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { contacts, firms } from "@/db/schema";
import { normalizeFirmName } from "./network-coverage";
import type { FirmProgramCategory } from "./firm-metadata";

// The student's CRM, reorganised the way the firm directory reads: company
// first, then the people inside it.
//
// A flat list of contacts stops being usable somewhere past a hundred rows -
// the same reason Discovery is not one long list of 22,000 firms. Grouping by
// employer also matches how recruiting actually works: you think "who do I know
// at Evercore", not "who do I know called Sam".
//
// Industry is not stored on a contact; it is resolved by matching the typed
// firm name against the firms directory and reading that firm's programs. So a
// contact at "Evercore Partners" inherits Evercore's sectors without anyone
// tagging them by hand.

/** Only contacts with a usable address appear. Deliberately permissive on the
 *  shape - the point is to exclude blanks and obvious junk, not to police
 *  which addresses are valid. */
function isRealEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

const SENIORITIES = [
  "Recruiter",
  "Analyst",
  "Associate",
  "Vice President",
  "Director",
  "Managing Director",
  "Partner",
  "Intern",
  "Other",
] as const;

export type Seniority = (typeof SENIORITIES)[number];

// Ordered: the first pattern that matches wins, so "Senior Associate" lands on
// Associate rather than falling through, and "Managing Director" is tested
// before "Director" would swallow it.
const SENIORITY_PATTERNS: [Seniority, RegExp][] = [
  ["Recruiter", /recruit|talent|campus|human resources|\bhr\b|people team/i],
  ["Intern", /intern(?!ational)|summer analyst|spring (week|insight)/i],
  ["Managing Director", /managing director|\bmd\b|head of|global head/i],
  ["Partner", /\bpartner\b|founder|chief|\bceo\b|\bcfo\b|\bcoo\b/i],
  ["Vice President", /vice president|\bvp\b|\bsvp\b|\bevp\b/i],
  ["Director", /director|principal|executive director/i],
  ["Associate", /associate/i],
  ["Analyst", /analyst|\banl\b/i],
];

export function seniorityOf(role: string | null | undefined): Seniority {
  if (!role) return "Other";
  for (const [label, re] of SENIORITY_PATTERNS) {
    if (re.test(role)) return label;
  }
  return "Other";
}

type DirectoryContact = {
  id: string;
  name: string;
  role: string | null;
  email: string;
  linkedinUrl: string | null;
  school: string | null;
  background: string | null;
  relationshipStatus: (typeof contacts.$inferSelect)["relationshipStatus"];
  lastContactDate: string | null;
  seniority: Seniority;
  // From the imported people directory when a row matches; null for a contact
  // the student typed in themselves. Present on the type now so the filter bar
  // can be built against it before the import lands.
  degree: string | null;
  gradYear: number | null;
  /** Prior employers, as written in the source. */
  jobHistory: string | null;
  /** Sectors of the matched firm; empty when the firm isn't in the directory. */
  industries: FirmProgramCategory[];
  /** True for rows auto-added from the recruiting directory - a published
   *  campus inbox rather than someone the student sourced. */
  isDirectoryRow: boolean;
};

export type DirectoryCompany = {
  /** Normalised firm name - stable, URL-safe key for the company page. */
  key: string;
  /** What the student typed, or the directory's name when it matched. */
  name: string;
  website: string | null;
  slug: string | null;
  industries: FirmProgramCategory[];
  contacts: DirectoryContact[];
};

export async function getContactDirectory(
  userId: string,
  /**
   * Include contacts with no email address.
   *
   * The Contacts directory excludes them - it exists to pick someone to write
   * to. The draft picker includes them: a student may well want a draft ready
   * for someone whose address they are still chasing, and silently omitting
   * them from a list they know they added reads as data loss.
   */
  opts: { includeWithoutEmail?: boolean } = {},
): Promise<DirectoryCompany[]> {
  const db = await getDb();

  const rows = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
  });

  const usable = rows.filter(
    (c) => (opts.includeWithoutEmail || isRealEmail(c.email)) && c.firm?.trim(),
  );

  const keys = [...new Set(usable.map((c) => normalizeFirmName(c.firm!)).filter(Boolean))];

  // One lookup for every firm mentioned, rather than a query per contact. The
  // firms table is large, so this is matched on the normalised name in memory
  // against only the firms whose names could collide.
  const matched = keys.length
    ? await db.query.firms.findMany({
        where: inArray(
          firms.name,
          // Cheap pre-filter: exact names first, then normalised matching below
          // catches "Evercore Partners" -> "Evercore".
          [...new Set(usable.map((c) => c.firm!.trim()))],
        ),
        with: { programs: { columns: { category: true } } },
      })
    : [];

  const firmByKey = new Map(matched.map((f) => [normalizeFirmName(f.name), f]));

  const byCompany = new Map<string, DirectoryCompany>();

  for (const c of usable) {
    const key = normalizeFirmName(c.firm!);
    if (!key) continue;
    const firm = firmByKey.get(key);
    const industries = firm
      ? ([...new Set(firm.programs.map((p) => p.category))] as FirmProgramCategory[])
      : [];

    const company =
      byCompany.get(key) ??
      ({
        key,
        name: firm?.name ?? c.firm!.trim(),
        website: firm?.website ?? null,
        slug: firm?.slug ?? null,
        industries,
        contacts: [],
      } satisfies DirectoryCompany);

    company.contacts.push({
      id: c.id,
      name: c.name,
      role: c.role,
      email: (c.email ?? "").trim(),
      linkedinUrl: c.linkedinUrl,
      school: c.school,
      background: c.background,
      relationshipStatus: c.relationshipStatus,
      lastContactDate: c.lastContactDate,
      seniority: seniorityOf(c.role),
      degree: null,
      gradYear: null,
      jobHistory: null,
      industries,
      isDirectoryRow: Boolean(c.firmRecruitingContactId),
    });

    byCompany.set(key, company);
  }

  return [...byCompany.values()]
    .map((c) => ({
      ...c,
      contacts: c.contacts.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
