import { sameSchool as sameSchoolAnywhere } from "@/lib/school-name";
export type UserProfile = {
  school: string | null;
  hometown: string | null;
  interests: string | null;
  targetGroup: string | null;
  // Collected in onboarding. Weighted just under same-school because a shared
  // club is usually a warmer, more specific intro than a shared campus - the
  // alum ran the same organisation the student is in now.
  clubsAndActivities?: string | null;
};

type ContactForScoring = {
  school: string | null;
  background: string | null;
  notes: string | null;
};

export type RelevanceResult = { score: number; reasons: string[] };

const norm = (s?: string | null) => (s ?? "").toLowerCase().trim();

// The same school typed different ways - one table for the whole app, in
// lib/school-name.ts.
export function sameSchool(a: string, b: string): boolean {
  return sameSchoolAnywhere(a, b);
}

// Deterministic relevance score based on overlap between the student's own
// profile and a contact's own manually-entered fields. No external data.
export function computeRelevanceScore(
  user: UserProfile,
  contact: ContactForScoring,
): RelevanceResult {
  let score = 0;
  const reasons: string[] = [];

  if (user.school && contact.school && sameSchool(user.school, contact.school)) {
    score += 40;
    reasons.push("Same school");
  }

  const haystack = norm(`${contact.background ?? ""} ${contact.notes ?? ""}`);

  if (user.hometown && norm(user.hometown).length > 2 && haystack.includes(norm(user.hometown))) {
    score += 20;
    reasons.push(`Connected to ${user.hometown}`);
  }

  if (user.clubsAndActivities) {
    const clubs = norm(user.clubsAndActivities)
      .split(/[,;]+/)
      .map((c) => c.trim())
      .filter((c) => c.length > 3);
    const matchedClubs = clubs.filter((c) => haystack.includes(c));
    if (matchedClubs.length > 0) {
      score += Math.min(matchedClubs.length * 18, 35);
      reasons.push(`Same organisation: ${matchedClubs.slice(0, 2).join(", ")}`);
    }
  }

  if (user.interests) {
    const interestWords = norm(user.interests)
      .split(/[,;]+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 2);
    const matched = interestWords.filter((w) => haystack.includes(w));
    if (matched.length > 0) {
      score += Math.min(matched.length * 10, 30);
      reasons.push(`Shared interest: ${matched.slice(0, 2).join(", ")}`);
    }
  }

  return { score, reasons };
}

export function hasProfileSignal(user: UserProfile) {
  return Boolean(user.school || user.hometown || user.interests || user.clubsAndActivities);
}
