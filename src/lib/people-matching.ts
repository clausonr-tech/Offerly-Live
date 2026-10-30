import "server-only";
import { and, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { directoryPeople } from "@/db/schema";
import type { UserProfile } from "./relevance";

// Who a student should write to, from the imported people directory.
//
// Read live on every request rather than copied into each student's contacts.
// That is the whole reason an update to the spreadsheet reaches every student
// immediately: there is no per-student snapshot to go stale, and nobody has to
// run a sync. Delisted rows are excluded here, so a person who left a firm
// stops being suggested the moment the next import runs - while any notes the
// student already wrote about them survive.

/** The student fields this matcher reads. */
export type MatchUser = UserProfile & { gradYear?: number | null };

export type PeopleMatch = {
  id: string;
  name: string;
  title: string | null;
  firmName: string;
  school: string | null;
  degree: string | null;
  gradYear: number | null;
  jobHistory: string | null;
  linkedinUrl: string | null;
  email: string | null;
  /** Why they are worth an email, e.g. "Same school". Strongest first. */
  reasons: string[];
  score: number;
};

const norm = (s?: string | null) => (s ?? "").toLowerCase().trim();

/**
 * Scores one person against the student.
 *
 * Separate from computeRelevanceScore because the fields differ: that one reads
 * a student's own CRM row (free-text notes), this reads structured directory
 * columns - school, degree, job history - and can be specific about which
 * overlap it found.
 */
function scorePerson(user: MatchUser, p: {
  school: string | null;
  jobHistory: string | null;
  gradYear: number | null;
}): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  if (user.school && p.school && norm(user.school) === norm(p.school)) {
    score += 50;
    reasons.push("Same school");
  }

  const history = norm(p.jobHistory);

  if (user.hometown && norm(user.hometown).length > 2 && history.includes(norm(user.hometown))) {
    score += 15;
    reasons.push(`Connected to ${user.hometown}`);
  }

  if (user.clubsAndActivities) {
    const clubs = norm(user.clubsAndActivities)
      .split(/[,;\n]/)
      .map((c) => c.trim())
      // Two-character fragments match everything; they are noise, not overlap.
      .filter((c) => c.length > 3);
    const matched = clubs.filter((c) => history.includes(c));
    if (matched.length > 0) {
      score += Math.min(matched.length * 15, 30);
      reasons.push(`Also in ${matched.slice(0, 2).join(", ")}`);
    }
  }

  // A recent graduate is close enough to remember recruiting and junior enough
  // to reply. Deliberately small - it is a tiebreak, not a reason to write.
  if (p.gradYear && user.gradYear) {
    const gap = user.gradYear - p.gradYear;
    if (gap >= 1 && gap <= 6) score += 8;
  }

  return { score, reasons };
}

/** Top `perFirm` people at each of the given firms, best overlap first. */
export async function findPeopleToReachOut(
  user: MatchUser,
  firmIds: string[],
  perFirm = 3,
): Promise<PeopleMatch[]> {
  if (firmIds.length === 0) return [];
  const db = await getDb();

  const rows = await db.query.directoryPeople.findMany({
    where: and(
      inArray(directoryPeople.firmId, firmIds),
      // Someone who has left the firm is not someone to cold-email about it.
      isNull(directoryPeople.delistedAt),
    ),
  });

  const byFirm = new Map<string, PeopleMatch[]>();
  for (const p of rows) {
    const { score, reasons } = scorePerson(user, p);
    const match: PeopleMatch = {
      id: p.id,
      name: p.name,
      title: p.title,
      firmName: p.firmName,
      school: p.school,
      degree: p.degree,
      gradYear: p.gradYear,
      jobHistory: p.jobHistory,
      linkedinUrl: p.linkedinUrl,
      email: p.email,
      reasons,
      score,
    };
    const list = byFirm.get(p.firmId ?? p.firmName) ?? [];
    list.push(match);
    byFirm.set(p.firmId ?? p.firmName, list);
  }

  // Per firm, not overall: one firm the student happens to know well would
  // otherwise fill the panel and hide every other target on their list.
  return [...byFirm.values()]
    .flatMap((list) =>
      list.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, perFirm),
    )
    .sort((a, b) => b.score - a.score || a.firmName.localeCompare(b.firmName));
}
