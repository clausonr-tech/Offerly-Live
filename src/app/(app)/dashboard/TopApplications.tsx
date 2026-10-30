import Link from "next/link";
import FirmLogo from "../discovery/FirmLogo";
import EmptyState from "@/components/EmptyState";
import { shortRoleTitle } from "@/lib/role-title";

export type TopApplication = {
  id: string;
  firmName: string;
  firmWebsite: string | null;
  roleTitle: string;
  location: string | null;
  matchReasons: string[];
  deadlineDate: Date | null;
};

const due = (d: Date | null) =>
  d ? `due ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` : null;

/**
 * The main dashboard's Top applications: the open internships that best fit
 * the student's onboarding answers (lib/internship-postings, getTopMatchedPostings).
 * Each opens the firm's own application page through the Apply route, which
 * counts the click for the firm. Replaced the "Applied yet?" checklist and
 * the shortlist-only list on 5 October 2026.
 */
export default function TopApplications({ rows }: { rows: TopApplication[] }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 flex h-6 items-center justify-between">
        <h2 className="text-sm font-medium text-warmgray-500">Top applications</h2>
        <Link href="/discovery/internships" className="text-xs text-brand-900 hover:underline">
          All internships →
        </Link>
      </div>
      {rows.length === 0 ? (
        <EmptyState>
          No open internships match your answers yet. Check your industries and graduation year in your profile, or
          browse every posting under Internships.
        </EmptyState>
      ) : (
        <>
          <p className="mb-1.5 text-[11px] text-warmgray-500">Open now, best fit for your onboarding answers first.</p>
          <div className="list-panel stagger-in divide-y divide-brand-100 overflow-hidden border border-brand-100">
            {rows.map((r) => {
              const detail = [r.location, r.matchReasons[0], due(r.deadlineDate)].filter(Boolean).join(" · ");
              return (
                // A plain <a> to our Apply route: it leaves the app for the
                // firm's board, so there is nothing to prefetch.
                <a
                  key={r.id}
                  href={`/api/postings/${r.id}/apply`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-center gap-3 px-4 py-2.5 hover:bg-brand-50"
                >
                  <FirmLogo domain={r.firmWebsite ?? ""} name={r.firmName} size={24} />
                  <span className="block min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-brand-900">
                      {r.firmName}
                      <span className="font-normal text-warmgray-500"> — {shortRoleTitle(r.roleTitle)}</span>
                    </span>
                    {detail && <span className="block truncate text-[11px] text-warmgray-500">{detail}</span>}
                  </span>
                  <span className="shrink-0 rounded-full border border-brand-200 px-2.5 py-1 text-xs font-medium text-brand-900 group-hover:border-accent-400">
                    Apply
                  </span>
                </a>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
