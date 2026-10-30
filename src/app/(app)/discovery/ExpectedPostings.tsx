import { CalendarClock, ExternalLink } from "lucide-react";

import { expectedDueLabel, expectedLabel, type ExpectedPosting } from "@/lib/expected-postings";
import { shortRoleTitle } from "@/lib/role-title";
import { externalHref } from "@/lib/safe-url";

import FirmLogo from "./FirmLogo";

/**
 * Roles expected to open this cycle, carried from last cycle's posting (see
 * lib/expected-postings). Drawn so they cannot be mistaken for open ones: a
 * dashed card, an "Expected" tag, the date it is expected rather than a
 * deadline, and a link to the firm's careers page in place of Apply.
 */
function ExpectedRoleCard({ role, showFirm = true }: { role: ExpectedPosting; showFirm?: boolean }) {
  const due = expectedDueLabel(role);
  // Read-boundary guard: the careers page is carried over from a CRAWLED
  // posting, so it is a string a firm's own site supplied. Same policy the
  // write boundary applies - see lib/safe-url. A refused value renders no
  // link at all, which is already what a firm with no careers page gets.
  const careers = externalHref(role.careersUrl);
  return (
    <li className="rounded-lg border border-dashed border-brand-200 bg-white/70 p-4">
      <div className="flex items-start gap-3">
        {showFirm && <FirmLogo domain={role.firmWebsite} name={role.firmName} size={28} />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-sm bg-[#eceff3] px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-[#475467]">
              Expected
            </span>
            {showFirm && <span className="text-xs font-medium text-warmgray-600">{role.firmName}</span>}
          </div>
          <p className="mt-1 text-sm font-semibold text-brand-900" title={role.roleTitle}>
            {shortRoleTitle(role.roleTitle) || role.roleTitle}
          </p>
          {role.location && <p className="text-xs text-warmgray-500">{role.location}</p>}
          <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-brand-900">
            <CalendarClock size={13} aria-hidden className="shrink-0 text-warmgray-500" />
            {expectedLabel(role)}
          </p>
          {due && <p className="ml-[19px] text-xs text-warmgray-600">{due}</p>}
          <details className="mt-2 text-xs text-warmgray-600">
            <summary className="cursor-pointer select-none font-medium text-brand-900">
              What it was last year
            </summary>
            <p className="mt-1 whitespace-pre-line leading-relaxed">{role.descriptionFull}</p>
          </details>
          {careers && (
            <a
              href={careers}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-900 hover:underline"
            >
              {role.firmName} careers page <ExternalLink size={11} aria-hidden />
            </a>
          )}
        </div>
      </div>
    </li>
  );
}

/** How many show before "Show all". */
const FIRST = 12;

export default function ExpectedPostings({
  roles,
  programYear,
  showFirm = true,
}: {
  roles: ExpectedPosting[];
  programYear: number;
  showFirm?: boolean;
}) {
  if (roles.length === 0) return null;
  return (
    <section className="mt-10">
      <h2 className="text-base font-semibold text-brand-900">
        Opening soon for Summer {programYear}
        <span className="ml-1.5 font-normal text-warmgray-500">({roles.length})</span>
      </h2>
      <p className="mt-1 text-sm text-warmgray-600">
        These ran last cycle and are due to open again within the next month, going by last year&apos;s dates.
        None is open yet; each is replaced by the real posting as soon as it&apos;s found.
      </p>
      {/* Soonest first; the rest one click away. Hundreds of roles repeat
          each cycle, and a wall of them buried the ones opening next. */}
      <ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {roles.slice(0, FIRST).map((r) => (
          <ExpectedRoleCard key={r.id} role={r} showFirm={showFirm} />
        ))}
      </ul>
      {roles.length > FIRST && (
        <details className="group mt-3">
          <summary className="cursor-pointer list-none text-sm font-medium text-brand-900 hover:underline">
            <span className="group-open:hidden">Show all {roles.length} →</span>
            <span className="hidden group-open:inline">Show fewer</span>
          </summary>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {roles.slice(FIRST).map((r) => (
              <ExpectedRoleCard key={r.id} role={r} showFirm={showFirm} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
