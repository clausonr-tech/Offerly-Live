import { Suspense } from "react";
import Link from "next/link";
import { getCurrentUser } from "@/lib/current-user";
import { getContactCredits } from "@/lib/contact-credits";
import { getOpportunityMatches } from "@/lib/discovery-matches";
import { countFirmsForCategories, searchFirmNames } from "@/lib/firms";
import EmptyState from "@/components/EmptyState";
import { addTopFirm, findTopFirmsForUser, removeTopFirm, reorderTopFirms } from "./actions";
import FindTopFirmsButton from "./FindTopFirmsButton";
import TopFirmsBoard from "./TopFirmsBoard";

// The dashboard's top-firms column, moved behind its own Suspense boundary.
// getOpportunityMatches is the heaviest read on the page - the whole ranked
// Discovery tree - and before this it held back every other panel: the header,
// Today and the sessions list all waited on the slowest query. Now they paint
// from their own (fast) reads while this column streams in.
//
// Fetches its own data rather than taking it as props, because everything here
// is used only here: the matches, the per-student credit count the board
// shows, the picker's opening rows, and the directory count behind the
// "new firms since you matched" banner. getCurrentUser and
// getOpportunityMatches are request-cached, so this costs no duplicate reads.

async function Content() {
  const user = await getCurrentUser();
  const preferredCategories = user.preferredCategories ?? [];

  const [matched, contactCredits, firmNameOptions, eligibleNow] = await Promise.all([
    getOpportunityMatches(),
    getContactCredits(user.id),
    searchFirmNames({ categories: user.preferredCategories }),
    countFirmsForCategories(preferredCategories),
  ]);

  const newFirmsSinceMatch =
    user.topFirmsEligibleCount != null ? Math.max(0, eligibleNow - user.topFirmsEligibleCount) : 0;

  return (
    <>
      {newFirmsSinceMatch > 0 && (
        // Told, not done for them: re-running costs an AI call and would
        // reshuffle a list the student may have curated by hand.
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-gold-200 bg-gold-50 px-3 py-2">
          <span className="text-xs text-brand-900">
            {newFirmsSinceMatch.toLocaleString()} new firm
            {newFirmsSinceMatch === 1 ? "" : "s"} match your sectors since you last matched.
          </span>
          <div className="ml-auto">
            <FindTopFirmsButton action={findTopFirmsForUser} label="Refresh matches" />
          </div>
        </div>
      )}

      {matched.groups.length === 0 ? (
        <>
          <h2 className="mb-3 text-base font-semibold text-brand-900">Your top firms</h2>
          <EmptyState>
            {preferredCategories.length === 0 ? (
              <>
                Set your preferred sectors in your{" "}
                <Link href="/profile/interests" className="text-brand-900 hover:underline">
                  profile
                </Link>{" "}
                so we can research firms tailored to you.
              </>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <p>
                  We&apos;ll research firms that fit your profile, then you can find people to
                  write to at each one.
                </p>
                <FindTopFirmsButton action={findTopFirmsForUser} />
              </div>
            )}
          </EmptyState>
        </>
      ) : (
        <>
          <TopFirmsBoard
            groups={matched.groups}
            totalGroups={matched.totalGroups}
            credits={contactCredits}
            removeAction={removeTopFirm}
            reorderAction={reorderTopFirms}
            firmOptions={firmNameOptions}
            addAction={addTopFirm}
          />
          {/* Counts what the student actually matched, not the target, so
              it never promises a longer list than exists. */}
          <Link
            href="/discovery"
            className="group/all mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-brand-900 transition-colors hover:text-accent-500"
          >
            {matched.totalGroups > matched.groups.length
              ? `See all ${matched.totalGroups} of your top firms in Discovery`
              : "Explore more firms in Discovery"}
            <span aria-hidden className="transition-transform group-hover/all:translate-x-0.5">
              →
            </span>
          </Link>
        </>
      )}
    </>
  );
}

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Loading your top firms">
      <h2 className="mb-3 text-base font-semibold text-brand-900">Your top firms</h2>
      <div className="list-panel h-96 animate-pulse border border-brand-100 bg-brand-50/60" />
    </div>
  );
}

export default function TopFirmsSection() {
  return (
    <Suspense fallback={<Skeleton />}>
      <Content />
    </Suspense>
  );
}
