import Link from "next/link";
import IndustryCards from "../IndustryCards";
import { CATEGORY_LABELS, CATEGORY_TAGLINES, type FirmProgramCategory } from "@/lib/firm-metadata";
import { getCurrentUser } from "@/lib/current-user";
import { internshipYearFor } from "@/lib/internship-year";
import { getRelevantPostings, scorePosting, targetProgramYear } from "@/lib/internship-postings";
import InternshipBrowser from "../InternshipBrowser";
import { getTrackedKeys } from "@/lib/discovery-matches";

export const metadata = { title: "Internships" };

const CATEGORIES = Object.keys(CATEGORY_LABELS) as FirmProgramCategory[];

const INDUSTRIES = CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }));

// Discovery's internships, as their own view under it beside Firms. They were
// the right-hand column of the hub, which held the posting grid to two columns
// and the matches beside it to half a row.
export default async function InternshipsPage() {
  const user = await getCurrentUser();

  // On `eligible`: preferredCategories deliberately not passed.
  // getRelevantPostings treats it as a hard filter, which made the industry
  // cards lie: a card counted from a preference-filtered set would read
  // "0 internships" and then open onto a page listing several. Grad-year
  // eligibility stays the only hard filter; preferences re-rank. Cycle IS
  // filtered - a closed cycle is wrong everywhere.
  const [trackedKeys, eligible] = await Promise.all([
    getTrackedKeys(user.id),
    getRelevantPostings({
      gradYear: user.gradYear,
      internshipYear: internshipYearFor(user),
      preferredCategories: null,
      includeDemo: user.isDemo,
    }),
  ]);

  // A student's cycle is their junior summer — the summer before they
  // graduate — not the upcoming one.
  const programYear = user.gradYear ? targetProgramYear(user.gradYear) : null;

  // Eligibility is the hard filter above; onboarding answers only re-rank.
  const postings = eligible
    .map((p) => ({ ...p, ...scorePosting(p, user) }))
    .sort(
      (a, b) =>
        b.matchScore - a.matchScore ||
        (a.deadlineStatus ?? "").localeCompare(b.deadlineStatus ?? "") ||
        a.firmName.localeCompare(b.firmName),
    );

  // Counted from the same set the cards' destination pages query, so a card's
  // number and its page always agree. A cross-listed posting counts under each
  // of its industries, so these deliberately sum to more than postings.length.
  const internshipCountByCategory: Partial<Record<FirmProgramCategory, number>> = {};
  for (const p of postings) {
    for (const c of p.categories) {
      const key = c as FirmProgramCategory;
      internshipCountByCategory[key] = (internshipCountByCategory[key] ?? 0) + 1;
    }
  }

  return (
    <div>
      {/* Same navy card as Discovery and Firms, so the sub-page reads as part
          of the section. Literal hex for the same reason as there. */}
      <div className="mb-8 rounded-2xl bg-gradient-to-br from-[#0b1526] via-[#1b2f4d] to-[#33517a] px-6 py-5 shadow-[0_10px_30px_-12px_rgba(11,21,38,0.55)]">
        <div className="min-w-0">
          <h1 className="app-hero-title text-2xl font-normal text-[#ffffff]">Internships</h1>
          <p className="mt-1 max-w-2xl text-sm text-[#c3cfe2]">
            {programYear
              ? `Summer ${programYear} postings — the cycle you recruit for, based on your ${user.gradYear} graduation year. A posting that spans several industries is counted under each.`
              : "Add your graduation year in your profile to see postings for your recruiting cycle."}
          </p>
        </div>
      </div>

      {trackedKeys.size > 0 && (
        <Link
          href="/tracking"
          className="mb-4 flex items-center justify-between rounded-lg border border-brand-100 bg-white px-4 py-3 text-sm hover:border-accent-400"
        >
          <span>
            <span className="block font-medium text-brand-900">
              You&apos;re tracking {trackedKeys.size} role
              {trackedKeys.size === 1 ? "" : "s"}
            </span>
            <span className="block text-xs text-warmgray-500">
              Review them and stop tracking any you don&apos;t want
            </span>
          </span>
          <span aria-hidden className="shrink-0 text-warmgray-500">
            →
          </span>
        </Link>
      )}

      <IndustryCards
        items={CATEGORIES.map((category) => ({
          value: category,
          label: CATEGORY_LABELS[category],
          count: internshipCountByCategory[category] ?? 0,
          href: `/discovery/${category}/internships`,
          description: CATEGORY_TAGLINES[category],
        }))}
        unit="internship"
      />
      {programYear && (
        <div className="mt-8">
          <InternshipBrowser
            trackedKeys={trackedKeys}
            postings={postings}
            industries={INDUSTRIES}
            programYear={programYear}
          />
        </div>
      )}
    </div>
  );
}
