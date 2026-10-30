"use client";

import MatchScore from "@/components/MatchScore";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, ExternalLink, X } from "lucide-react";
import FirmLogo from "../discovery/FirmLogo";
import GenerateContactsButton from "../discovery/firm/[slug]/GenerateContactsButton";
import type { ContactCredits } from "@/lib/contact-credits";
import ExpandableGrid from "../ExpandableGrid";
import TrackToggle from "../applications/TrackToggle";
import { TIMING_STYLES } from "@/lib/posting-timing";
import type { MatchedContact, MatchedFirmGroup } from "@/lib/discovery-matches";
import { DraftEmailButton } from "../drafts/QuickDraft";
import { expectedLabel, type ExpectedPosting } from "@/lib/expected-postings";
import { shortRoleTitle } from "@/lib/role-title";
import { externalHref } from "@/lib/safe-url";

// The match as a board rather than a scroll: 24 firms, three across, each one
// opening onto the two things a student actually does with a firm - write to
// someone there, or apply to something there. Those used to be two long flat
// lists stacked down the page (fifteen firm rows, then a hundred-odd contact
// rows), which meant the connection between a firm and its people existed only
// in the student's head and cost a page of scrolling to reconstruct.
//
// The panel spans the full grid width instead of expanding in place: two
// readable columns don't fit in a third of a row, and shrinking them to fit is
// how the detail becomes unreadable.

export default function MatchedFirmGrid({
  groups,
  removeAction,
  credits,
}: {
  groups: MatchedFirmGroup[];
  removeAction: (topFirmId: string) => Promise<void>;
  credits?: ContactCredits;
}) {
  // One at a time. Several open at once pushes the rest of the board off-screen
  // and recreates the scrolling this replaced.
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <ExpandableGrid
      items={groups}
      getKey={(g) => g.firm.id}
      isOpen={(g) => openId === g.firm.id}
      renderCard={(group) => {
        const { firm, internships, contactCount } = group;
        const expanded = openId === firm.id;
        return (
          <div
              className={`group relative flex h-full rounded-lg border bg-white transition-colors ${
                expanded ? "border-accent-400" : "border-brand-100 hover:border-accent-400"
              }`}
            >
              <button
                type="button"
                onClick={() => setOpenId(expanded ? null : firm.id)}
                aria-expanded={expanded}
                className="flex min-w-0 flex-1 items-center gap-2.5 p-3 text-left"
              >
                <FirmLogo domain={firm.website} name={firm.name} size={28} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-brand-900">{firm.name}</p>
                  <p className="truncate text-[11px] text-warmgray-500">
                    {internships.length} role{internships.length === 1 ? "" : "s"} ·{" "}
                    {/* The total, not the preview list's length. */}
                    {contactCount} contact{contactCount === 1 ? "" : "s"}
                  </p>
                </div>
                <ChevronDown
                  size={14}
                  aria-hidden
                  className={`shrink-0 text-warmgray-400 transition-transform ${expanded ? "rotate-180" : ""}`}
                />
              </button>
              <form action={removeAction.bind(null, firm.topFirmId)} className="absolute right-1 top-1">
                <button
                  type="submit"
                  title={`Remove ${firm.name}`}
                  className="flex h-5 w-5 items-center justify-center rounded-full bg-white text-warmgray-400 opacity-0 shadow-card transition-opacity hover:text-error-600 focus:opacity-100 group-hover:opacity-100"
                >
                  <X size={11} aria-hidden />
                  <span className="sr-only">Remove {firm.name}</span>
                </button>
              </form>
          </div>
        );
      }}
      renderPanel={(group) => (
        <div className="rounded-lg border border-accent-400 bg-brand-50/50 p-4">
          <FirmPanes group={group} credits={credits} />
        </div>
      )}
    />
  );
}

function PaneHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-warmgray-500">
      {children}
    </h3>
  );
}

/** Left: who to write to. Name, how to reach them, and the overlap in a few words. */
function ContactsPane({
  firm,
  firmId,
  contacts,
  credits,
  autoGenerate,
  onAutoGenerate,
}: {
  firm: string;
  /** Needed by the sourcing action; the pane only ever had the name. */
  firmId?: string;
  contacts: MatchedContact[];
  /** Omitted where the caller has no session to read an allowance from, in
      which case the button is not offered rather than offered and broken. */
  credits?: ContactCredits;
  /** See GenerateContactsButton's autoRun. */
  autoGenerate?: boolean;
  onAutoGenerate?: () => void;
}) {
  const more = useShowMore(contacts.length, firmId ?? firm);
  return (
    <div>
      <PaneHeading>Who to reach out to</PaneHeading>
      {firmId && credits && (
        <div className="mb-3">
          <GenerateContactsButton
            firmId={firmId}
            firmName={firm}
            contactsPerRun={credits.contactsPerRun}
            autoRun={autoGenerate}
            onAutoRun={onAutoGenerate}
            credits={{
              remaining: credits.unlimited ? -1 : credits.remaining,
              limit: credits.limit,
              unlimited: credits.unlimited,
            }}
          />
        </div>
      )}
      {contacts.length === 0 ? (
        <p className="text-xs text-warmgray-500">
          No one on file at {firm} yet.{" "}
          <Link href="/contacts/new" className="text-brand-900 hover:underline">
            Add a contact →
          </Link>
        </p>
      ) : (
        <ul className="space-y-2">
          {contacts.slice(0, more.shown).map((person) => (
            <li key={person.key} className="rounded-md border border-brand-100 bg-white px-3 py-2">
              <div className="flex items-baseline justify-between gap-2">
                {person.href ? (
                  <Link
                    href={person.href}
                    className="truncate text-sm font-medium text-brand-900 hover:underline"
                  >
                    {person.name}
                  </Link>
                ) : (
                  <p className="truncate text-sm font-medium text-brand-900">{person.name}</p>
                )}
                {person.title && (
                  <span className="shrink-0 truncate text-[11px] text-warmgray-500">
                    {person.title}
                  </span>
                )}
              </div>

              {/* The same score the Industry Contacts table shows, from the same
                  component - one person cannot read 80 here and 45 there. */}
              <div className="mt-1">
                <MatchScore match={person.likelihood} width={64} />
              </div>

              {/* Two or three words, not a paragraph: the chips are what makes a
                  list of five scannable, and the full sentences live in
                  Discovery for anyone who wants them. */}
              <p className="mt-1 truncate text-[11px] text-warmgray-500">
                {person.likelihood.signals.length > 0
                  ? person.likelihood.signals
                      .slice(0, 3)
                      .map((s) => s.label)
                      .join(" · ")
                  : "No shared background on file"}
              </p>

              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                {person.email ? (
                  <a
                    href={`mailto:${person.email}`}
                    className="truncate text-[11px] text-brand-900 hover:underline"
                  >
                    {person.email}
                  </a>
                ) : (
                  <span className="text-[11px] text-warmgray-400">No email on file</span>
                )}
                {externalHref(person.linkedinUrl) && (
                  <a
                    // Provider-supplied (Crustdata), so it gets the same
                    // read-boundary guard as the crawled links here.
                    href={externalHref(person.linkedinUrl)!}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] font-medium text-brand-900 hover:underline"
                  >
                    LinkedIn →
                  </a>
                )}
                <DraftEmailButton recipientKey={person.key} name={person.name} className="ml-auto" />
              </div>
            </li>
          ))}
        </ul>
      )}
      <ShowMoreButton {...more} />
    </div>
  );
}

/** Right: what's open here. Title, location, one line of what it is, and timing. */
function RolesPane({
  group,
  fitHeight,
}: {
  group: MatchedFirmGroup;
  /** The contacts column's height beside this one. When set, the list opens
      with as many roles as fit in it, so the two columns end together. */
  fitHeight?: number | null;
}) {
  const { firm, internships } = group;
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [fit, setFit] = useState<{ key: string; height: number; count: number } | null>(null);
  const measuring =
    fitHeight != null && (fit?.key !== firm.id || fit.height !== fitHeight);
  // While measuring, every role renders so each card's real height can be
  // read; the layout effect settles the count before the browser paints.
  const base = fitHeight == null ? PAGE : measuring ? internships.length : fit!.count;
  const more = useShowMore(internships.length, firm.id, base);

  useLayoutEffect(() => {
    if (!measuring || fitHeight == null || !rootRef.current) return;
    const top = rootRef.current.getBoundingClientRect().top;
    const bottoms = Array.from(listRef.current?.children ?? []).map(
      (li) => li.getBoundingClientRect().bottom - top,
    );
    let count = bottoms.filter((b) => b <= fitHeight).length;
    // Anything left over needs the Load more row, so make room for it.
    if (count < bottoms.length) {
      count = bottoms.filter((b) => b <= fitHeight - SHOW_MORE_ROW).length;
    }
    setFit({ key: firm.id, height: fitHeight, count: Math.max(MIN_FIT, count) });
  }, [measuring, fitHeight, firm.id]);

  return (
    <div ref={rootRef}>
      <PaneHeading>Roles at {firm.name}</PaneHeading>
      {internships.length === 0 ? (
        <p className="text-xs text-warmgray-500">
          Nothing posted for your cycle yet.{" "}
          {(group.expected?.length ?? 0) === 0 && (
            <Link href={`/discovery/firm/${firm.slug}`} className="text-brand-900 hover:underline">
              See their timeline →
            </Link>
          )}
        </p>
      ) : (
        <ul ref={listRef} className="space-y-2">
          {internships.slice(0, more.shown).map((p) => (
            <li key={p.id} className="rounded-md border border-brand-100 bg-white px-3 py-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-brand-900">{p.roleTitle}</p>
                  {p.location && (
                    <p className="truncate text-[11px] text-warmgray-500">{p.location}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-start gap-2">
                  <a
                    // The read boundary for a crawled apply link, enforcing
                    // the same policy the write boundary does. React
                    // neutralises `javascript:` and nothing else, so a stored
                    // `data:`, `vbscript:`, scheme-less or
                    // `https://greenhouse.io@attacker.example/x` value would
                    // otherwise be a live link under the firm's name. No href
                    // leaves the word "Apply" as text. See lib/safe-url.
                    href={externalHref(p.applyUrl) ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-[11px] font-medium text-brand-900 hover:underline"
                  >
                    Apply
                    <ExternalLink size={11} aria-hidden />
                  </a>
                  {/* These arrive auto-tracked when the firm is matched, so the
                      toggle is mostly a way out, not a way in. */}
                  <TrackToggle
                    firm={p.firmName}
                    role={p.roleTitle}
                    applicationUrl={p.applyUrl}
                    tracked={p.tracked}
                  />
                </div>
              </div>
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-warmgray-600">
                {p.summary}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${TIMING_STYLES[p.timing.state]}`}
                >
                  {p.timing.label}
                </span>
                {p.timing.detail && (
                  <span className="text-[10px] text-warmgray-500">{p.timing.detail}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <ShowMoreButton {...more} />
      <ExpectedHere roles={group.expected ?? []} />
    </div>
  );
}

/**
 * What ran here last cycle and has not been posted for this one yet: the
 * soonest three, each with the date it is expected and the firm's careers
 * page. Never counted among the roles above, never with an Apply.
 */
function ExpectedHere({ roles }: { roles: ExpectedPosting[] }) {
  if (roles.length === 0) return null;
  return (
    <div className="mt-3 border-t border-dashed border-brand-200 pt-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-warmgray-500">
        Expected to open within a month ({roles.length})
      </p>
      <ul className="mt-1.5 space-y-1.5">
        {roles.slice(0, 3).map((r) => (
          <li key={r.id} className="rounded-md border border-dashed border-brand-200 bg-white/70 px-3 py-2">
            <p className="truncate text-sm font-medium text-brand-900" title={r.roleTitle}>
              {shortRoleTitle(r.roleTitle) || r.roleTitle}
            </p>
            <p className="text-[11px] text-warmgray-600">{expectedLabel(r)}</p>
            {externalHref(r.careersUrl) && (
              <a
                // Same guard as the apply link above: this is the registered
                // source's careers URL, stored by the crawler.
                href={externalHref(r.careersUrl)!}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-900 hover:underline"
              >
                Careers page <ExternalLink size={10} aria-hidden />
              </a>
            )}
          </li>
        ))}
      </ul>
      {roles.length > 3 && (
        <p className="mt-1 text-[11px] text-warmgray-500">
          +{roles.length - 3} more expected, on the Internships tab for your industry.
        </p>
      )}
    </div>
  );
}

/**
 * The open firm: contacts on the left, roles on the right. The roles list opens
 * at the contacts column's height, so the two columns end together instead of
 * one trailing a dozen cards past the other. Stacked on a phone, heights mean
 * nothing, and both lists open at five.
 */
export function FirmPanes({
  group,
  credits,
  autoGenerate,
  onAutoGenerate,
}: {
  group: MatchedFirmGroup;
  credits?: ContactCredits;
  /** Start a contact search on open - see GenerateContactsButton's autoRun. */
  autoGenerate?: boolean;
  onAutoGenerate?: () => void;
}) {
  const contactsRef = useRef<HTMLDivElement>(null);
  const [contactsHeight, setContactsHeight] = useState<number | null>(null);

  useEffect(() => {
    const el = contactsRef.current;
    if (!el) return;
    const wide = window.matchMedia("(min-width: 768px)");
    const read = () => setContactsHeight(wide.matches ? Math.round(el.offsetHeight) : null);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    wide.addEventListener("change", read);
    return () => {
      observer.disconnect();
      wide.removeEventListener("change", read);
    };
  }, []);

  return (
    // items-start: each column keeps its own height. Stretched, the contacts
    // column would report the roles column's height back to it.
    // grid-cols-1 below md, not the implicit track: an implicit column sizes
    // to its content's max-content width and pushed this panel past the
    // screen edge on a phone.
    <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-2">
      <div ref={contactsRef}>
        <ContactsPane
          firm={group.firm.name}
          firmId={group.firm.id}
          contacts={group.contacts}
          credits={credits}
          autoGenerate={autoGenerate}
          onAutoGenerate={onAutoGenerate}
        />
      </div>
      <RolesPane group={group} fitHeight={contactsHeight} />
    </div>
  );
}

// Five at a time. A firm like Evercore posts a dozen-plus roles, and listing
// them all turned one open panel into a page of scrolling - the thing the board
// exists to avoid. Opening a different firm starts back at the first page.
const PAGE = 5;
// Beside an empty contacts column only a card or two would fit; a floor keeps
// the roles list from looking broken.
const MIN_FIT = 3;
// The Load more line: mt-2 plus one line of text-xs.
const SHOW_MORE_ROW = 28;

function useShowMore(total: number, resetKey: string, base = PAGE) {
  const [state, setState] = useState({ key: resetKey, extra: 0 });
  const extra = state.key === resetKey ? state.extra : 0;
  return {
    base,
    shown: base + extra,
    total,
    more: () => setState({ key: resetKey, extra: extra + PAGE }),
    fewer: () => setState({ key: resetKey, extra: 0 }),
  };
}

function ShowMoreButton({ base, shown, total, more, fewer }: ReturnType<typeof useShowMore>) {
  // Everything fits on the first page: nothing to load, nothing to fold.
  if (total <= base) return null;
  const left = total - shown;
  return (
    <div className="mt-2 flex items-baseline gap-2 text-xs">
      {left > 0 ? (
        <>
          <button type="button" onClick={more} className="font-medium text-brand-900 hover:underline">
            Load {Math.min(PAGE, left)} more
          </button>
          <span className="text-warmgray-500">{left} not shown</span>
        </>
      ) : (
        <button type="button" onClick={fewer} className="font-medium text-brand-900 hover:underline">
          Show fewer
        </button>
      )}
    </div>
  );
}
