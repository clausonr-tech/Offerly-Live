import { Lock } from "lucide-react";
import { getCurrentUser } from "@/lib/current-user";
import { isPendingOrg } from "@/lib/feed";

import SectionTopBar from "../SectionTopBar";

/**
 * The shell every Networking view shares: the one notice that applies across
 * all of them.
 *
 * The floating icon bar that used to sit here is gone. It existed because the
 * top tab strip had no room to express a second level, so Community's four
 * views had to be reachable from somewhere else - a bar pinned to the bottom
 * of the viewport, portalled out of a transformed ancestor, tracking the
 * footer on scroll. The sidebar nests them under Networking directly, which
 * is what all of that machinery was working around. CommunityNav.tsx is kept
 * in this folder unused, in case the pattern is wanted again.
 *
 * A layout rather than something each page imports, so the notice is a fact
 * about the account stated once, not four copies that can drift.
 */
export default async function NetworkingLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const pending = isPendingOrg(user);

  return (
    <div>
      <SectionTopBar sectionHref="/networking" hubLabel="Feed" />
      {/* Lives here rather than on each page: it is a fact about the account,
          not about the view, and it was previously only shown on the feed -
          so an org account that landed on Connect first was told nothing about
          why it could not post. */}
      {pending && (
        <div className="mb-6 flex items-start gap-3 rounded-lg border border-dashed border-brand-100 p-4">
          <Lock size={16} className="mt-0.5 shrink-0 text-warmgray-500" />
          <div>
            <p className="text-sm text-brand-900">
              Your organisation account isn&apos;t approved yet.
            </p>
            <p className="mt-1 text-sm text-warmgray-500">
              You can read the feed and connect with people now. Posting unlocks once your club or
              firm is verified.
            </p>
          </div>
        </div>
      )}

      {children}
    </div>
  );
}
