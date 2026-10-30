"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ExternalLink } from "lucide-react";
import FirmLogo from "./FirmLogo";
import TrackToggle from "../applications/TrackToggle";
import ExpandableGrid from "../ExpandableGrid";
import EmptyState from "@/components/EmptyState";
import { formatPosting } from "@/lib/posting-format";
import { externalHref } from "@/lib/safe-url";
import { shortRoleTitle } from "@/lib/role-title";

// Exported: InternshipBrowser owns the filtering and sorting and renders this
// component with whatever survives, so both files have to agree on the shape.
export type Posting = {
  id: string;
  roleTitle: string;
  location: string | null;
  categories: string[];
  matchScore: number;
  programYear: number;
  deadlineStatus: "tbd" | "confirmed" | "rolling" | "closed";
  deadlineText: string | null;
  deadlineDate: Date | null;
  descriptionFull: string;
  requirementsFull?: string | null;
  sourceUrl: string;
  applicationUrl: string | null;
  recruiterName: string | null;
  recruiterTitle: string | null;
  recruiterEmail: string | null;
  recruiterPhone: string | null;
  firmName: string;
  firmSlug: string;
  firmWebsite: string;
};

export const DEADLINE_STYLES: Record<Posting["deadlineStatus"], string> = {
  confirmed: "bg-success-50 text-success-700",
  rolling: "bg-gold-50 text-gold-700",
  tbd: "bg-warmgray-100 text-warmgray-600",
  closed: "bg-error-50 text-error-600",
};

export function deadlineLabel(p: Posting): string {
  if (p.deadlineStatus === "confirmed" && p.deadlineDate) {
    return new Date(p.deadlineDate).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
  if (p.deadlineStatus === "rolling") return "Rolling";
  if (p.deadlineStatus === "closed") return "Closed";
  return "Deadline TBD";
}

export default function InternshipPostings({
  postings,
  programYear,
  industryLabels = {},
  trackedKeys,
  showIndustryTags = true,
  tagById,
  showFirm = true,
  maxColumns = 3,
}: {
  postings: Posting[];
  programYear: number;
  /** `firm|role` for everything already in the student's pipeline. Passed from
   *  the server rather than fetched here so the toggles render in their real
   *  state on first paint instead of all flashing untracked. */
  trackedKeys?: Set<string>;
  /** Slug → display name. Passed in rather than imported: the label map lives
   *  in firm-content, which pulls in the bulk firm JSON and has no business in
   *  a client bundle. */
  industryLabels?: Record<string, string>;
  /**
   * Whether to stamp each card with the industries it belongs to.
   *
   * True in the combined browser, where a cross-listed posting appears under
   * several industries and the chip is the only thing distinguishing what
   * would otherwise read as a duplicate row. False once the student has
   * clicked into one industry: every card on that page is that industry, so
   * the chip repeats the page heading on every row and buys nothing.
   */
  showIndustryTags?: boolean;
  /**
   * An extra chip for particular cards, keyed by posting id.
   *
   * Added for /tracking, which renders these same cards and needs to keep
   * saying which rows it tracked on the student's behalf ("AUTO") - a
   * distinction the old bare-title list carried and that would otherwise have
   * been lost in the move to this card. Empty everywhere else, so Discovery is
   * unchanged.
   */
  tagById?: Record<string, string>;
  /**
   * Whether each card names its firm. False inside a firm's own dropdown in
   * the internship browser, where the firm card above already says it and the
   * name on every card only took the line the role title needed.
   */
  showFirm?: boolean;
  /** Passed straight through to ExpandableGrid; see its doc comment. */
  maxColumns?: 1 | 2 | 3;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (postings.length === 0) {
    return (
      <EmptyState>
        No summer {programYear} postings matched to your profile yet. Most firms
        haven&apos;t opened this cycle — check back as the crawler picks them up.
      </EmptyState>
    );
  }

  return (
    // Cards in a grid, matching the firm and contact browsers - the three
    // Discovery tabs should look like three views of one directory rather than
    // three different products.
    <ExpandableGrid
      items={postings}
      getKey={(p) => p.id}
      isOpen={(p) => openId === p.id}
      gap="gap-3"
      maxColumns={maxColumns}
      renderCard={(p) => {
        const isOpen = openId === p.id;
        return (
          // The card keeps its column. It used to widen to span the whole row
          // when opened, which shoved its neighbours onto the next line - the
          // grid rearranging itself around a click. The detail now goes in a
          // full-width panel below the row instead, which gets the program
          // summary the same width without moving anything.
          // h-full fills the grid cell, so every card in a row is the same
          // height. min-h is what makes rows match EACH OTHER: each row is its
          // own grid (see ExpandableGrid), so stretching alone only equalises
          // within a row, and a row of short titles still came out shorter
          // than the row above it. The floor is the height of a full card - a
          // two-line title, the meta line and one tag row, plus the firm line
          // where there is one - so in practice every card lands on it.
          //
          // Spacing, type and chips match the firm cards in the Firms tab, so
          // the two directories read as one: the posting cards had grown half
          // again as tall as a firm card for the same three lines of content.
          <div
            className={`relative flex h-full flex-col rounded-lg border bg-white transition-colors ${
              showFirm ? "min-h-[7.25rem]" : "min-h-[6rem]"
            } ${isOpen ? "border-accent-400" : "border-brand-100"}`}
          >
            <button
              type="button"
              onClick={() => setOpenId(isOpen ? null : p.id)}
              aria-expanded={isOpen}
              className="flex w-full flex-1 items-start gap-2.5 p-3 pr-16 text-left transition hover:bg-brand-50/60"
            >
              {/* Only with the firm name: inside a firm's own dropdown the firm
                  card above carries the logo, and repeating it on every card
                  spent width the title needed. */}
              {showFirm && <FirmLogo domain={p.firmWebsite} name={p.firmName} size={28} />}

              {/* self-stretch + flex-col so the tag row below can be pushed to
                  the card's floor with mt-auto. The parent is items-start, so
                  without self-stretch this column is only as tall as its own
                  text and "bottom" means nothing. */}
              <span className="flex min-w-0 flex-1 flex-col self-stretch">
                {/* Firm and role on separate lines rather than joined by a dash:
                    at these title lengths the single line wrapped mid-role and
                    the firm stopped being scannable down the column. */}
                {showFirm && (
                  <span className="block truncate text-sm font-semibold text-brand-900">
                    {p.firmName}
                  </span>
                )}
                {/* The short title, shown whole. The crawled one ("2028
                    Strategic Advisory: Mergers & Acquisitions Summer Analyst
                    Program – Chicago Industrials") was clamped to two lines,
                    which cut off exactly the part that told one role from the
                    next. Shortened (lib/role-title), it fits without a clamp;
                    the full title is in the hover text and the opened detail. */}
                <span
                  title={p.roleTitle}
                  className={`text-sm leading-snug ${
                    showFirm ? "mt-0.5 text-warmgray-600" : "font-medium text-brand-900"
                  }`}
                >
                  {shortRoleTitle(p.roleTitle)}
                </span>
                {/* Both halves are conditional. /tracking renders this card
                    for applications the student typed in themselves, which
                    have no posting behind them and therefore no cycle and no
                    city - and "Summer 0" is worse than saying nothing. */}
                {(p.programYear > 0 || p.location) && (
                  <span className="mt-0.5 block truncate text-xs text-warmgray-600">
                    {[p.programYear > 0 ? `Summer ${p.programYear}` : null, p.location]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                )}

                {/* mt-auto, not mt-2: a one-line role title used to pull this
                    row up level with the middle of its neighbours' titles, so
                    the deadline and industry chips sat at three different
                    heights across one row of cards. Pinned to the bottom they
                    line up whatever the title length, and the slack opens up
                    above them instead. */}
                <span className="mt-auto flex flex-wrap items-center gap-1 pt-1">
                  <span
                    className={`rounded-sm px-1 py-px text-[10px] font-medium ${DEADLINE_STYLES[p.deadlineStatus]}`}
                  >
                    {deadlineLabel(p)}
                  </span>
                  {showIndustryTags &&
                    p.categories.map((c) => (
                      <span
                        key={c}
                        className="rounded-sm bg-brand-50 px-1 py-px text-[10px] font-medium text-brand-700"
                      >
                        {industryLabels[c] ?? c.replace(/_/g, " ")}
                      </span>
                    ))}
                  {tagById?.[p.id] && (
                    <span className="rounded-sm bg-brand-50 px-1 py-px text-[10px] font-medium text-warmgray-600">
                      {tagById[p.id]}
                    </span>
                  )}
                </span>
              </span>

              <ChevronDown
                size={16}
                aria-hidden
                className={`mt-0.5 shrink-0 text-warmgray-500 transition-transform ${isOpen ? "rotate-180" : ""}`}
              />
            </button>

            {/* Outside the button above, deliberately. A <button> nested inside
                a <button> is invalid HTML - the browser reparents it while
                parsing, so the server markup and the client tree disagree and
                React fails hydration for the entire page. Absolutely positioned
                so it still reads as sitting in the card's top corner. */}
            <span className="absolute right-9 top-3">
              <TrackToggle
                firm={p.firmName}
                role={p.roleTitle}
                applicationUrl={p.applicationUrl ?? p.sourceUrl}
                tracked={trackedKeys?.has(`${p.firmName}|${p.roleTitle}`) ?? false}
              />
            </span>

          </div>
        );
      }}
      renderPanel={(p) => (
              <div>
                <div className="rounded-lg border border-accent-400 bg-brand-50/40 p-4">
                  {/* The firm's own title, in full: the card shows a shortened
                      one, and this is where the whole thing is still read. */}
                  <p className="mb-3 text-sm font-medium text-brand-900">{p.roleTitle}</p>
                  {p.deadlineText && (
                    <p className="mb-4 border-l-2 border-brand-200 pl-3 text-xs leading-relaxed text-warmgray-500">
                      <span className="font-medium text-brand-900">Timing: </span>
                      {p.deadlineText}
                    </p>
                  )}

                  <PostingBody posting={p} />

                  {(p.recruiterName || p.recruiterEmail || p.recruiterPhone) && (
                    <div className="mt-4 rounded-md border border-brand-100 bg-white/5 p-3">
                      <p className="mb-1.5 text-[11px] uppercase tracking-wide text-warmgray-500">
                        Recruiting contact
                      </p>
                      {p.recruiterName && (
                        <p className="text-sm font-medium text-brand-900">
                          {p.recruiterName}
                          {p.recruiterTitle && (
                            <span className="font-normal text-warmgray-500">
                              {" "}
                              · {p.recruiterTitle}
                            </span>
                          )}
                        </p>
                      )}
                      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                        {p.recruiterEmail && (
                          <a
                            href={`mailto:${encodeURIComponent(p.recruiterEmail)}`}
                            className="text-accent-500 hover:underline"
                          >
                            {p.recruiterEmail}
                          </a>
                        )}
                        {p.recruiterPhone && (
                          <span className="text-warmgray-600">{p.recruiterPhone}</span>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-brand-100 pt-3 text-xs">
                    {/* The "read further" destination: everything Offerly knows
                        about the firm, rather than only this one posting. */}
                    {/* Guarded, for the same reason the cycle line above is:
                        a row the student typed in has no firm page in the
                        directory and no source URL, and a link to
                        /discovery/firm/ or to "" is a link to a 404. */}
                    {p.firmSlug && (
                      <Link
                        href={`/discovery/firm/${p.firmSlug}`}
                        className="inline-flex items-center gap-1 font-medium text-brand-900 hover:underline"
                      >
                        View {p.firmName} profile →
                      </Link>
                    )}
                    {externalHref(p.sourceUrl) && (
                      <a
                        // The read boundary for a crawled URL. The publish
                        // path refuses anything that is not a public http(s)
                        // URL, and this is the backstop where the href is
                        // actually emitted: React neutralises `javascript:`
                        // and nothing else, so a row stored before that rule
                        // existed would otherwise be a live `data:` or
                        // `vbscript:` link, and a scheme-less value would be
                        // a link back into the app. `externalHref` enforces
                        // the SAME rule as the publish path - userinfo, bare
                        // addresses, internal names and odd ports included -
                        // because a backstop that enforced less than the rule
                        // it backstops would pass exactly the old rows it
                        // exists for. See lib/safe-url.
                        href={externalHref(p.sourceUrl)!}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-warmgray-500 hover:text-brand-900 hover:underline"
                      >
                        Read the full posting
                        <ExternalLink size={11} />
                      </a>
                    )}
                    {(p.firmSlug ? p.applicationUrl : externalHref(p.applicationUrl)) && (
                      <a
                        // Through the click log when this is a directory
                        // posting, so the firm's analytics can count it (that
                        // route applies its own http(s) check - firm-links
                        // httpUrl); a row the student typed in has no firm to
                        // count for and is linked directly, so it goes
                        // through the same read-boundary guard as the source
                        // URL above.
                        href={p.firmSlug ? `/api/postings/${p.id}/apply` : externalHref(p.applicationUrl)!}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-auto inline-flex items-center gap-1 rounded-md bg-accent-500 px-3 py-1.5 font-semibold text-white hover:bg-accent-400"
                      >
                        Apply
                        <ExternalLink size={11} />
                      </a>
                    )}
                  </div>
                </div>
              </div>
      )}
    />
  );
}

/**
 * The posting body, as sections rather than one four-thousand-character
 * paragraph. See lib/posting-format.ts for what can and cannot be recovered
 * from the text the crawler stored.
 */
function PostingBody({ posting }: { posting: Posting }) {
  const [showAll, setShowAll] = useState(false);
  const formatted = useMemo(
    () =>
      formatPosting({
        description: posting.descriptionFull,
        requirements: posting.requirementsFull,
        firmName: posting.firmName,
      }),
    [posting.descriptionFull, posting.requirementsFull, posting.firmName],
  );

  const primary = formatted.sections.filter((s) => s.kind === "primary");
  const boilerplate = formatted.sections.filter((s) => s.kind === "boilerplate");

  const renderSection = (section: (typeof formatted.sections)[number], key: string) => (
    <section key={key} className="mb-4 last:mb-0">
      {section.heading && (
        <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-warmgray-500">
          {section.heading}
        </h4>
      )}
      {section.blocks.map((block, i) =>
        block.type === "list" ? (
          <ul key={i} className="mb-2 max-w-prose list-disc space-y-1 pl-5 last:mb-0">
            {block.items.map((item, j) => (
              <li key={j} className="text-sm leading-relaxed text-brand-900">
                {item}
              </li>
            ))}
          </ul>
        ) : (
          // max-w-prose is the readability fix: full-bleed on a wide screen ran
          // this past 180 characters a line, roughly triple a comfortable measure.
          <p key={i} className="mb-2 max-w-prose text-sm leading-relaxed text-brand-900 last:mb-0">
            {block.text}
          </p>
        ),
      )}
    </section>
  );

  if (formatted.sections.length === 0) return null;

  return (
    <div>
      {/* Our own restructuring of the firm's posting, not reproduced text - so
          this stays labelled a summary, and the source link below sends the
          student to the real posting. */}
      <p className="mb-2 text-[11px] uppercase tracking-wide text-warmgray-500">
        Program summary
      </p>

      {primary.map((s, i) => renderSection(s, `p${i}`))}

      {boilerplate.length > 0 && (
        <>
          {showAll && (
            <div className="mt-4 border-t border-brand-100 pt-4">
              {boilerplate.map((s, i) => renderSection(s, `b${i}`))}
            </div>
          )}
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="mt-3 text-xs font-medium text-accent-500 hover:underline"
          >
            {showAll ? "Hide firm background" : "Show full posting"}
          </button>
        </>
      )}

      {/* Always last, whatever the firm's text did with it. The crawl keeps
          only the link's label, so it points at the firm's own posting, whose
          footer carries the real policy link. */}
      {formatted.privacyNote && (
        <p className="mt-4 text-[11px] text-warmgray-500">
          {externalHref(posting.sourceUrl) ? (
            <a href={externalHref(posting.sourceUrl)!} target="_blank" rel="noreferrer" className="hover:underline">
              {formatted.privacyNote}
            </a>
          ) : (
            formatted.privacyNote
          )}
        </p>
      )}
    </div>
  );
}
