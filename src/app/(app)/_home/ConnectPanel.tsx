import Link from "next/link";
import type { DirectoryMember } from "@/lib/people";
import LogoAvatar from "@/components/feed/LogoAvatar";
import OpenTag from "./OpenTag";
import EmptyState from "@/components/EmptyState";

// The eighth panel, right after Interview Prep and before Drafts.
//
// Not a second rolodex. Discovery already riffles a deck of firms past you,
// and putting the same moving-cards device on a deck of PEOPLE just made this
// panel read as "the firm rolodex again, with faces instead of logos" -
// correct data, wrong idea. A directory of people isn't ambient the way a
// directory of firms is; every name in it is someone who might actually
// message you back, which asked for something you can hold still and read
// rather than something that scrolls past.
//
// A register instead: a numbered list, ruled like a ledger, standing still.
const ROSTER_MAX = 5;

export default function ConnectPanel({ members }: { members: DirectoryMember[] }) {
  const shown = members.slice(0, ROSTER_MAX);
  const schoolCount = new Set(members.map((m) => m.schoolName).filter(Boolean)).size;

  return (
    <section id="community" className="relative scroll-mt-6">
      <Link
        href="/networking"
        aria-label="Open Community"
        className="group block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
      >
        <div className="feed-divider relative overflow-hidden border-t bg-surface-1">
          {/* Fades the panel's own lighter surface into the darker page
              background at its left and right edges. */}
          <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-background to-transparent" />
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-background to-transparent" />

          <div className="px-5 pb-24 pt-8" style={{ minHeight: 373 }}>
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-warmgray-500">
                Member register
              </p>
              {/* A register that quantifies itself before listing itself -
                  Citadel's own move for a directory, in this panel's already-
                  established mono-ledger idiom rather than the marketing
                  page's big serif numerals. */}
              {members.length > 0 && (
                <p className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-warmgray-500">
                  {members.length} member{members.length === 1 ? "" : "s"}
                  {schoolCount > 0 ? ` · ${schoolCount} school${schoolCount === 1 ? "" : "s"}` : ""}
                </p>
              )}
            </div>

            {shown.length === 0 ? (
              <EmptyRegister />
            ) : (
              <ul className="mt-3 border-t border-brand-100">
                {shown.map((member) => (
                  <li key={member.id} className="flex items-center gap-3 border-b border-brand-100 py-3">
                    {/* Square, not circular - a stamped seal beside the name
                        rather than a social-app avatar, and the one thing on
                        this row that visibly says "institution", not
                        "person". */}
                    <LogoAvatar
                      domain={member.schoolDomain}
                      label={member.schoolName}
                      alt={member.schoolName ? `${member.schoolName} crest` : ""}
                      initials={member.name.trim().charAt(0).toUpperCase() || "?"}
                      size={30}
                      shape="square"
                    />

                    {/* Name over school, not side by side - a school name
                        like "University of Southern California" and a real
                        name were fighting for the same line on a narrow
                        panel, and the side that was allowed to shrink lost
                        almost everything. */}
                    <div className="min-w-0 flex-1">
                      <p className="display-serif truncate text-[15px] font-bold leading-tight text-brand-900">
                        {member.name}
                      </p>
                      <p className="truncate font-mono text-[10px] uppercase tracking-[0.12em] text-warmgray-500">
                        {member.schoolName ?? "School not set"}
                        {member.gradYear ? ` · Class of ${member.gradYear}` : ""}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-32 bg-gradient-to-t from-surface-1 via-surface-1/85 to-transparent" />

          <div className="pointer-events-none absolute bottom-6 left-0 z-20 flex items-end gap-4">
            <h2 className="ml-[0.02em] text-[8vw] font-bold italic leading-[0.85] tracking-tight text-brand-900 sm:text-4xl lg:text-5xl">
              Community
            </h2>
            <OpenTag />
          </div>
        </div>
      </Link>
    </section>
  );
}

function EmptyRegister() {
  return (
    <EmptyState className="mt-6">
      <p className="text-sm font-semibold text-brand-900">No one else here yet</p>
      <p className="mx-auto mt-1.5 max-w-xs text-xs leading-relaxed text-warmgray-600">
        Once other students join, they show up here.
      </p>
    </EmptyState>
  );
}
