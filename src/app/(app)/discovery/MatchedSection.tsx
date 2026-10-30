import { Suspense } from "react";
import Link from "next/link";
import { getDiscoveryMatchesForCurrentUser } from "@/lib/discovery-matches";
import { removeTopFirm } from "../dashboard/actions";
import { getContactCredits } from "@/lib/contact-credits";
import { getCurrentUser } from "@/lib/current-user";
import MatchedFirmGrid from "../dashboard/MatchedFirmGrid";
import EmptyState from "@/components/EmptyState";

// Discovery's "Your matches" tab: the same board Opportunities shows, in the
// same component, so the two pages cannot drift into two different ideas of
// what a match looks like.
//
// This replaced three separate shelves sitting above the industry grid - one
// for firms, one for roles, one for people - which split a single answer across
// three tabs and made the relationship between a firm and its own roles and
// people something the student had to reassemble by switching tabs.
//
// The matcher runs an LLM call on a student's first visit, which is seconds,
// not milliseconds. Behind Suspense that cost is paid inside this tab while the
// industry grid and the browsers on the other tabs render immediately.

function Skeleton() {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="h-3 w-3 animate-pulse rounded-full bg-accent-400" aria-hidden />
        {/* aria-live so the wait is announced, not just animated. */}
        <p className="text-sm font-medium text-brand-900" aria-live="polite">
          Finding the firms that fit you…
        </p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div
            key={i}
            className="h-[60px] animate-pulse rounded-lg border border-brand-100 bg-white"
          />
        ))}
      </div>
    </div>
  );
}

function Prompt({ children }: { children: React.ReactNode }) {
  return (
    <EmptyState>
      {children}
    </EmptyState>
  );
}

async function Matches() {
  const matches = await getDiscoveryMatchesForCurrentUser();

  if (matches.needsProfile) {
    return (
      <Prompt>
        Pick your sectors in{" "}
        <Link href="/profile/interests" className="font-medium text-brand-900 hover:underline">
          your profile
        </Link>{" "}
        and we&apos;ll match you to firms, the roles inside them, and the people to write to.
      </Prompt>
    );
  }

  if (!matches.groups.length) {
    return (
      <Prompt>
        {matches.error
          ? // Says what went wrong rather than pretending the student simply has
            // no matches. The other tabs still work regardless.
            `We couldn't build your matches just now - ${matches.error}`
          : "No matches yet."}{" "}
        <Link href="/dashboard" className="font-medium text-brand-900 hover:underline">
          External Network
        </Link>{" "}
        can run it again.
      </Prompt>
    );
  }

  // Read here rather than passed down from the page: this component already
  // awaits the match, and the allowance is per-student, not per-firm.
  const user = await getCurrentUser();
  const credits = await getContactCredits(user.id);

  const n = matches.groups.length;

  return (
    <div>
      {/* Inside the awaited component, not above the Suspense boundary: the
          count has to be the student's real one, and outside here it can only
          be a constant guessed before the match resolves. The skeleton already
          covers the wait, so nothing is lost by stating it late. */}
      <p className="mb-4 text-xs text-warmgray-500">
        Your {n} matched {n === 1 ? "firm" : "firms"}. Click any one to see who to reach out to
        there and which roles are open.
      </p>
      <MatchedFirmGrid groups={matches.groups} removeAction={removeTopFirm} credits={credits} />
    </div>
  );
}

export default function MatchedSection() {
  return (
    <div>
      <Suspense fallback={<Skeleton />}>
        <Matches />
      </Suspense>
    </div>
  );
}
