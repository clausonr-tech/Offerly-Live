"use client";

import { useState, useTransition } from "react";
import { ChevronDown, X } from "lucide-react";
import FirmLogo from "../discovery/FirmLogo";
import ExpandableGrid from "../ExpandableGrid";
import InternshipPostings, { type Posting } from "../discovery/InternshipPostings";
import { untrackFirm } from "../applications/untrack-actions";
import EmptyState from "@/components/EmptyState";

/** The posting behind a tracked role, when one exists. Everything the shared
 *  card renders except the fields this page supplies itself. */
type TrackedPosting = Omit<Posting, "matchScore" | "firmName">;

export type TrackedRole = {
  /** The APPLICATION's id - what the untrack controls and /applications/[id]
   *  address. Not the posting's. */
  id: string;
  role: string;
  status: string;
  autoTracked: boolean;
  /** Null for a firm the student typed in themselves, or a role whose posting
   *  has left the relevant set. */
  posting: TrackedPosting | null;
  /** The application row's own URL, which is all a stub row has to offer. */
  applicationUrl: string | null;
  /** The student's recruiting cycle, for filing a stub row under. */
  cycleYear: number | null;
};

export type TrackedFirm = {
  firm: string;
  firmSlug: string | null;
  firmWebsite: string | null;
  roles: TrackedRole[];
};

// Three across, same shape as the matched-firm grid on Opportunities and
// Discovery. A full-width row per firm was a column of mostly empty space with
// a count stranded at one end; at forty-six firms that is a long scroll to
// learn very little.
//
// ExpandableGrid keeps the clicked firm's row intact and drops the panel below
// it, rather than splitting the row open at the card.
//
// Both levels of control are here deliberately: the row-level toggle matches
// every other posting card in the app, and the firm-level "stop tracking" exists
// because after a hundred-firm match one firm can contribute ten rows, and
// dropping it is one decision rather than ten clicks.

export default function TrackedFirmList({
  firms,
  /** Slug -> display name for the industry chips, passed from the server for
   *  the same reason InternshipPostings takes it: the label map lives in
   *  firm-content, which drags the bulk firm JSON into a client bundle. */
  industryLabels,
}: {
  firms: TrackedFirm[];
  industryLabels: Record<string, string>;
}) {
  // One open at a time: the panel takes the full width of the grid, so two open
  // at once would push the firms below them a screen apart.
  const [openFirm, setOpenFirm] = useState<string | null>(null);
  // Removed firms disappear immediately rather than waiting for the server
  // round trip; the page revalidates behind it.
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();

  const visible = firms.filter((f) => !removed.has(f.firm));

  if (!visible.length) {
    return (
      <EmptyState>
        You&apos;re not tracking anything yet. Roles you track - and everything
        added automatically when you match a firm - collect here.
      </EmptyState>
    );
  }

  const stopTrackingFirm = (firm: string) => {
    setRemoved((prev) => new Set(prev).add(firm));
    startTransition(async () => {
      try {
        await untrackFirm(firm);
      } catch {
        setRemoved((prev) => {
          const next = new Set(prev);
          next.delete(firm);
          return next;
        });
      }
    });
  };

  return (
    <ExpandableGrid
      items={visible}
      getKey={(f) => f.firm}
      isOpen={(f) => openFirm === f.firm}
      renderCard={(f) => {
        const expanded = openFirm === f.firm;
        return (
          <div
            className={`group relative flex h-full rounded-lg border bg-white transition-colors ${
              expanded
                ? "border-accent-400"
                : "border-brand-100 hover:border-accent-400"
            }`}
          >
            <button
              type="button"
              onClick={() => setOpenFirm(expanded ? null : f.firm)}
              aria-expanded={expanded}
              className="flex min-w-0 flex-1 items-center gap-2.5 p-3 text-left"
            >
              {/* Applications store the firm as free text, so a row whose name
                    doesn't match the directory has no domain. FirmLogo already
                    treats an empty domain as "no logo" and falls back to the
                    monogram, which is exactly right here. */}
              <FirmLogo domain={f.firmWebsite ?? ""} name={f.firm} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-brand-900">
                  {f.firm}
                </span>
                <span className="block truncate text-[11px] text-warmgray-500">
                  {f.roles.length} role{f.roles.length === 1 ? "" : "s"} tracked
                </span>
              </span>
              <ChevronDown
                size={14}
                aria-hidden
                className={`shrink-0 text-warmgray-400 transition-transform ${expanded ? "rotate-180" : ""}`}
              />
            </button>
            {/* Outside the button above: a <button> nested in a <button> is
                  invalid HTML and breaks hydration for the whole page. */}
            <button
              type="button"
              disabled={isPending}
              onClick={() => stopTrackingFirm(f.firm)}
              title={`Stop tracking all ${f.roles.length} roles at ${f.firm}`}
              className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-white text-warmgray-400 opacity-0 shadow-card transition-opacity hover:text-error-600 focus:opacity-100 group-hover:opacity-100 disabled:opacity-50"
            >
              <X size={11} aria-hidden />
              <span className="sr-only">
                Stop tracking all roles at {f.firm}
              </span>
            </button>
          </div>
        );
      }}
      renderPanel={(f) => (
        <div className="rounded-lg border border-accent-400 bg-brand-50/50 p-4">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-warmgray-500">
              {f.roles.length} role{f.roles.length === 1 ? "" : "s"} tracked at{" "}
              {f.firm}
            </h3>
            <button
              type="button"
              disabled={isPending}
              onClick={() => stopTrackingFirm(f.firm)}
              className="flex items-center gap-1 text-[11px] font-medium text-warmgray-500 hover:text-error-600 disabled:opacity-50"
            >
              <X size={11} aria-hidden />
              Stop tracking this firm
            </button>
          </div>
          {/* The same card the Internships tab renders, not a list of bare
              titles. A tracked role and a browsable posting are the same
              thing, and showing one as a line of text and the other as a full
              card made them look like two different objects - a student could
              not see the deadline, the city or the cycle on something they had
              already decided to apply to, which is exactly when those matter
              most.

              Every role here is tracked by definition, so the toggles inside
              render as "tracked" and untrack on click. */}
          <InternshipPostings
            postings={f.roles.map((r) => asPosting(f, r))}
            programYear={f.roles[0]?.posting?.programYear ?? f.roles[0]?.cycleYear ?? 0}
            industryLabels={industryLabels}
            trackedKeys={new Set(f.roles.map((r) => `${f.firm}|${r.role}`))}
            // Keyed on what asPosting used as the card id: the posting's id
            // when there was one, the application's when there was not.
            tagById={Object.fromEntries(
              f.roles
                .filter((r) => r.autoTracked)
                .map((r) => [r.posting?.id ?? r.id, "Auto"]),
            )}
          />
        </div>
      )}
    />
  );
}

/**
 * A tracked role in the shape the shared posting card expects.
 *
 * When the role matched a posting this is that posting, unchanged. When it did
 * not - a firm the student typed in themselves, or one whose posting has since
 * closed - the card is built from the application row alone: the title they
 * gave it, their own link, and NOTHING invented. No deadline, no location, no
 * industry chips, no description, so the card shows "Deadline TBD" and opens
 * onto whatever is actually there.
 *
 * `matchScore` is zero throughout: this page is a list of decisions the student
 * has already made, so there is nothing left to rank them by.
 */
function asPosting(firm: TrackedFirm, role: TrackedRole): Posting {
  if (role.posting) {
    return { ...role.posting, matchScore: 0, firmName: firm.firm };
  }
  return {
    // Falls back to the APPLICATION id, which is unique per row and is what
    // the card's key needs.
    id: role.id,
    roleTitle: role.role,
    location: null,
    categories: [],
    matchScore: 0,
    programYear: role.cycleYear ?? 0,
    deadlineStatus: "tbd",
    deadlineText: null,
    deadlineDate: null,
    descriptionFull: "",
    requirementsFull: null,
    sourceUrl: role.applicationUrl ?? "",
    applicationUrl: role.applicationUrl,
    recruiterName: null,
    recruiterTitle: null,
    recruiterEmail: null,
    recruiterPhone: null,
    firmName: firm.firm,
    firmSlug: firm.firmSlug ?? "",
    firmWebsite: firm.firmWebsite ?? "",
  };
}
