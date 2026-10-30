"use client";

import Link from "next/link";
import { ChevronDown, ExternalLink, X } from "lucide-react";
import { LEVELS, levelOf } from "@/lib/contact-level";
import { Fragment, useEffect, useMemo, useOptimistic, useRef, useState, useTransition } from "react";

import MatchScore, { scorePercent } from "@/components/MatchScore";
import { MAX_EMAILS, ordinal } from "@/lib/outreach-ladder";
import { type ResponseLikelihood } from "@/lib/response-likelihood";

import {
  markOutreachSent,
  setContactRepliedAction,
  undoOutreachSendAction,
} from "./contact-actions";
import { normalizeFirmName } from "@/lib/firm-name";
import { externalHref } from "@/lib/safe-url";
import { DraftEmailButton } from "../drafts/QuickDraft";
import { emailLabel } from "@/lib/contact-email-render";

/** One contact's cold emails, as the Outreach column shows them. */
export type OutreachView = {
  stage: "not_contacted" | "waiting" | "due" | "replied" | "finished";
  /** Oldest first. ISO strings - no Date crosses into a client component. */
  sends: { step: number; sentAt: string }[];
  nextStep: number | null;
  dueAt: string | null;
  /** The most recent recorded email, which is the only one Undo can take back. */
  undoSendId: string | null;
};

export type ContactRow = {
  id: string;
  name: string;
  firm: string | null;
  role: string | null;
  email: string | null;
  emailConfidence: string | null;
  school: string | null;
  linkedinUrl: string | null;
  connectionAngle: string | null;
  relationshipStatus: string;
  lastContactDate: string | null;
  outreach: OutreachView;
  /** From the same scorer the firm cards use - see response-likelihood.ts. */
  match: ResponseLikelihood;
};

type SortKey = "name" | "role" | "school" | "outreach" | "match";

/**
 * Firm is not here on purpose: it is the group heading below. Repeating it on
 * every row wasted a column to say the same word ten times, and sorting by it
 * did what the grouping now does permanently.
 */
const COLUMNS: { key: SortKey | null; label: string }[] = [
  { key: "match", label: "Match" },
  { key: "name", label: "Name" },
  { key: "role", label: "Role" },
  { key: null, label: "Email" },
  { key: "school", label: "School" },
  { key: null, label: "Why them" },
  { key: "outreach", label: "Outreach" },
  { key: null, label: "LinkedIn" },
];

const NO_FIRM = "No firm";
const NO_SCHOOL = "No school";

const STAGE_LABEL: Record<OutreachView["stage"], string> = {
  not_contacted: "Not contacted",
  due: "Follow-up due",
  waiting: "Waiting on reply",
  replied: "Replied",
  finished: "No reply after 3",
};

const EMAIL_OPTIONS = ["Has email", "Verified email", "No email"] as const;
function emailOf(r: ContactRow): string[] {
  if (!r.email) return ["No email"];
  return r.emailConfidence === "confirmed" ? ["Has email", "Verified email"] : ["Has email"];
}

type FilterKey = "firm" | "school" | "level" | "stage" | "email";
type Filters = Record<FilterKey, string[]>;
const NO_FILTERS: Filters = { firm: [], school: [], level: [], stage: [], email: [] };

/** Each row's value(s) for every filter. A filter with nothing picked passes
 *  every row; picks within one filter are OR, filters are AND. */
function facets(r: ContactRow): Record<FilterKey, string[]> {
  return {
    firm: [r.firm?.trim() || NO_FIRM],
    school: [r.school?.trim() || NO_SCHOOL],
    level: [levelOf(r.role)],
    stage: [STAGE_LABEL[r.outreach.stage]],
    email: emailOf(r),
  };
}

function passes(r: ContactRow, filters: Filters, skip?: FilterKey): boolean {
  const f = facets(r);
  return (Object.keys(filters) as FilterKey[]).every(
    (k) => k === skip || !filters[k].length || f[k].some((v) => filters[k].includes(v)),
  );
}


/** Anything past "not contacted" means this person has been written to. */
function isReached(row: ContactRow): boolean {
  return row.outreach.stage !== "not_contacted";
}

/**
 * Sorting by outreach puts the work first: follow-ups due, then people never
 * written to, then the ones waiting on a reply, then the finished ones.
 */
const STAGE_ORDER: Record<OutreachView["stage"], string> = {
  due: "0",
  not_contacted: "1",
  waiting: "2",
  finished: "3",
  replied: "4",
};

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

type OutreachChange =
  | { id: string; type: "sent" }
  | { id: string; type: "undo" }
  | { id: string; type: "replied"; replied: boolean };

/** What the row shows the instant a button is pressed, before the server answers. */
function applyChange(o: OutreachView, change: OutreachChange): OutreachView {
  if (change.type === "replied") {
    return change.replied
      ? { ...o, stage: "replied", nextStep: null, dueAt: null }
      : { ...o, stage: o.sends.length ? "waiting" : "not_contacted" };
  }
  if (change.type === "undo") {
    const sends = o.sends.slice(0, -1);
    return { ...o, sends, stage: sends.length ? "waiting" : "not_contacted", undoSendId: null };
  }
  const step = o.nextStep ?? o.sends.length + 1;
  const sends = [...o.sends, { step, sentAt: new Date().toISOString() }];
  return {
    ...o,
    sends,
    stage: step >= MAX_EMAILS ? "finished" : "waiting",
    nextStep: step >= MAX_EMAILS ? null : step + 1,
  };
}

export function ContactGrid({
  rows,
  initialQuery = "",
}: {
  rows: ContactRow[];
  /**
   * What the filter box starts with, from `?q=` on the page.
   *
   * How a prompt elsewhere in the app lands a student on ONE firm's people:
   * the outreach banner links here with the firm's name, and the table opens
   * showing that firm's group rather than all seventeen rows with the right
   * one somewhere below the fold. Only the initial value - it is a normal
   * editable filter from the first keystroke.
   */
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "name", asc: true });
  const [, startTransition] = useTransition();

  // Every button has to answer instantly - a student working down a list of
  // twenty should never wait for a round trip between rows.
  const [optimistic, setOptimistic] = useOptimistic(
    rows,
    (state: ContactRow[], change: OutreachChange) =>
      state.map((r) => (r.id === change.id ? { ...r, outreach: applyChange(r.outreach, change) } : r)),
  );

  // Filtered, then split by firm, then sorted inside each firm. A student works
  // this list one firm at a time - that is how outreach actually happens - so
  // the firm is the unit, and the sort orders people within it.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    // A firm typed one way finds it written another: the outreach banner links
    // here as "?q=GS" when the student saved some people at "GS" and others at
    // "Goldman Sachs", and every one of them is someone it is counting.
    const firmKey = q ? normalizeFirmName(q) : "";
    const filtered = optimistic.filter(
      (r) =>
        (!q ||
          [r.name, r.firm, r.role, r.school, r.email].some((v) => v?.toLowerCase().includes(q)) ||
          (!!firmKey && !!r.firm && normalizeFirmName(r.firm) === firmKey)) &&
        passes(r, filters),
    );

    const value = (r: ContactRow) =>
      sort.key === "outreach"
        ? STAGE_ORDER[r.outreach.stage]
        : sort.key === "match"
          ? // Padded so 9 sorts below 80 rather than above it.
            String(scorePercent(r.match.score)).padStart(4, "0")
          : ((r[sort.key] as string | null) ?? "");

    const byFirm = new Map<string, ContactRow[]>();
    for (const row of filtered) {
      const firm = row.firm?.trim() || NO_FIRM;
      byFirm.set(firm, [...(byFirm.get(firm) ?? []), row]);
    }

    return [...byFirm.entries()]
      .map(([firm, rows]) => ({
        firm,
        rows: [...rows].sort((a, b) => {
          const cmp = value(a).localeCompare(value(b), undefined, { sensitivity: "base" });
          return sort.asc ? cmp : -cmp;
        }),
      }))
      // Most contacts first - the firms a student has actually worked on. The
      // ones with no firm go last rather than sorting into the middle.
      .sort((a, b) =>
        a.firm === NO_FIRM ? 1 : b.firm === NO_FIRM ? -1 : b.rows.length - a.rows.length,
      );
  }, [optimistic, query, sort, filters]);

  const visible = groups.flatMap((g) => g.rows);

  // Each option's count is how many rows it would show given everything else
  // already picked, so a dropdown never offers a choice that empties the table
  // without saying so.
  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matchesText = (r: ContactRow) =>
      !q || [r.name, r.firm, r.role, r.school, r.email].some((v) => v?.toLowerCase().includes(q));
    const out = {} as Record<FilterKey, { value: string; count: number }[]>;
    for (const key of Object.keys(NO_FILTERS) as FilterKey[]) {
      const counts = new Map<string, number>();
      for (const r of optimistic) {
        if (!matchesText(r) || !passes(r, filters, key)) continue;
        for (const v of facets(r)[key]) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      // Picked values stay listed even at zero, so they can be unticked.
      for (const v of filters[key]) if (!counts.has(v)) counts.set(v, 0);
      const fixed: readonly string[] | null =
        key === "level" ? LEVELS : key === "stage" ? Object.values(STAGE_LABEL) : key === "email" ? EMAIL_OPTIONS : null;
      const entries = [...counts.entries()].map(([value, count]) => ({ value, count }));
      out[key] = fixed
        ? fixed.filter((v) => counts.has(v)).map((v) => ({ value: v, count: counts.get(v)! }))
        : entries.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    }
    return out;
  }, [optimistic, query, filters]);

  const toggle = (key: FilterKey, value: string) =>
    setFilters((f) => ({
      ...f,
      [key]: f[key].includes(value) ? f[key].filter((v) => v !== value) : [...f[key], value],
    }));
  const active = (Object.keys(filters) as FilterKey[]).flatMap((k) => filters[k].map((v) => ({ key: k, value: v })));

  function act(change: OutreachChange, run: () => Promise<unknown>) {
    startTransition(async () => {
      setOptimistic(change);
      await run();
    });
  }

  if (!rows.length) {
    return (
      <p className="rounded-md border border-brand-100 p-6 text-sm text-warmgray-500">
        No contacts yet. Open a firm on External Network and use “Generate 5 contacts”, or add someone
        manually from Discovery.
      </p>
    );
  }

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, firm, role, school or email"
          aria-label="Search contacts"
          className="w-full max-w-xs rounded-md border border-brand-300 bg-transparent px-3 py-1.5 text-sm text-brand-900 placeholder:text-warmgray-500"
        />
        <FilterMenu label="Firm" options={options.firm} picked={filters.firm} onToggle={(v) => toggle("firm", v)} searchable />
        <FilterMenu label="School" options={options.school} picked={filters.school} onToggle={(v) => toggle("school", v)} searchable />
        <FilterMenu label="Level" options={options.level} picked={filters.level} onToggle={(v) => toggle("level", v)} />
        <FilterMenu label="Outreach" options={options.stage} picked={filters.stage} onToggle={(v) => toggle("stage", v)} />
        <FilterMenu label="Email" options={options.email} picked={filters.email} onToggle={(v) => toggle("email", v)} />
        <p className="ml-auto shrink-0 text-xs text-warmgray-500">
          {visible.filter(isReached).length} of {visible.length} reached
        </p>
      </div>
      {(active.length > 0 || query) && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {active.map((a) => (
            <button
              key={`${a.key}:${a.value}`}
              type="button"
              onClick={() => toggle(a.key, a.value)}
              aria-label={`Remove filter ${a.value}`}
              className="inline-flex items-center gap-1 rounded-full border border-accent-500 bg-accent-50 px-2.5 py-0.5 text-xs font-medium text-brand-900"
            >
              {a.value}
              <X size={11} aria-hidden />
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setFilters(NO_FILTERS);
              setQuery("");
            }}
            className="ml-1 text-xs text-warmgray-500 underline-offset-2 hover:text-brand-900 hover:underline"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Wide table, so it scrolls inside its own box rather than the page. */}
      <div className="overflow-x-auto rounded-md border border-brand-100">
        <table className="w-full min-w-[66rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-brand-100 bg-brand-50/60">
              {COLUMNS.map((col) => (
                <th
                  key={col.label}
                  scope="col"
                  className="whitespace-nowrap px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-warmgray-500"
                >
                  {col.key ? (
                    <button
                      type="button"
                      onClick={() =>
                        setSort((s) =>
                          s.key === col.key ? { key: s.key, asc: !s.asc } : { key: col.key!, asc: true },
                        )
                      }
                      className="cursor-pointer hover:text-brand-900"
                    >
                      {col.label}
                      {sort.key === col.key && (sort.asc ? " ↑" : " ↓")}
                    </button>
                  ) : (
                    col.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const done = group.rows.filter(isReached).length;
              return (
                <Fragment key={group.firm}>
                  {/* The firm is a band across the table rather than a column,
                      so the columns stay aligned down the whole page and the
                      name is said once instead of once per row. */}
                  <tr>
                    <th
                      scope="colgroup"
                      colSpan={COLUMNS.length}
                      className="firm-band px-3 py-2 text-left"
                    >
                      <span className="text-sm font-medium">{group.firm}</span>
                      {/* Same white ink at reduced opacity rather than a grey
                          token, so the count sits on the navy in both themes. */}
                      <span className="ml-2 text-xs font-normal opacity-70">
                        {done} of {group.rows.length} reached
                      </span>
                    </th>
                  </tr>
                  {group.rows.map((row) => {
                    const reached = isReached(row);
                    return (
                      <tr
                        key={row.id}
                        // Background only - the text colour stays exactly as it
                        // is on every other row, in both themes.
                        className={`border-b border-brand-100 ${reached ? "bg-signal-cyan/10" : ""}`}
                      >
                        <td className="px-3 py-2">
                          <MatchScore match={row.match} />
                        </td>
                        <td className="px-3 py-2 font-medium text-brand-900">
                          {/* Stacked: beside the name, the button squeezed
                              every name onto two lines in this column. The name
                              is plain text - the LinkedIn column at the far
                              right is the link. */}
                          <div className="flex flex-col items-start gap-1">
                            {row.name}
                            <DraftEmailButton recipientKey={`contact-${row.id}`} name={row.name} />
                          </div>
                        </td>
                        <td className="px-3 py-2 text-brand-900">{row.role ?? "—"}</td>
                        <td className="px-3 py-2">
                          {row.email ? (
                            // Straight into the draft form, already addressed
                            // to this person. An address in a table is only
                            // useful as the first step of writing to them.
                            <Link
                              href={`/outreach?contact=${row.id}`}
                              className="font-mono text-xs text-brand-900 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-900"
                              title={`Draft an email to ${row.name}`}
                            >
                              {row.email}
                              {/* What the address is, in the same words as the
                                  generate button: verified and confirmed say
                                  nothing, a catch-all or predicted one says
                                  so, and only an older unchecked one says
                                  "unverified". It used to say "unverified" on
                                  every sourced address, verified ones too. */}
                              {(() => {
                                const tag =
                                  emailLabel(row.emailConfidence) ??
                                  (row.emailConfidence && !["confirmed", "verified"].includes(row.emailConfidence)
                                    ? "unverified"
                                    : null);
                                return tag ? (
                                  <span className="ml-1 font-sans text-[10px] uppercase tracking-wide text-warmgray-500">
                                    {tag}
                                  </span>
                                ) : null;
                              })()}
                            </Link>
                          ) : (
                            <span className="text-warmgray-500">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-brand-900">{row.school ?? "—"}</td>
                        <td className="max-w-[18rem] px-3 py-2 text-brand-900">
                          {row.connectionAngle ?? <span className="text-warmgray-500">—</span>}
                        </td>
                        <td className="px-3 py-2 align-top">
                          <OutreachCell
                            outreach={row.outreach}
                            onSent={() =>
                              act({ id: row.id, type: "sent" }, () => markOutreachSent(row.id))
                            }
                            onUndo={(sendId) =>
                              act({ id: row.id, type: "undo" }, () => undoOutreachSendAction(sendId))
                            }
                            onReplied={(replied) =>
                              act({ id: row.id, type: "replied", replied }, () =>
                                setContactRepliedAction({ contactId: row.id, replied }),
                              )
                            }
                          />
                        </td>
                        <td className="px-3 py-2">
                          {/* Read-boundary guard: a contact's LinkedIn URL is
                              stored data - the sourcing run copies it out of a
                              third-party provider's response, and a CSV import
                              takes whatever the file said. React neutralises
                              only `javascript:`, so the guard is what stops a
                              stored scheme executing in this origin. No href
                              means the cell falls back to the dash. */}
                          {externalHref(row.linkedinUrl) ? (
                            <a
                              href={externalHref(row.linkedinUrl)}
                              target="_blank"
                              rel="noreferrer noopener"
                              aria-label={`${row.name} on LinkedIn`}
                              className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-accent-600 px-2.5 py-1 text-xs font-semibold text-[#ffffff] shadow-card hover:bg-accent-500"
                            >
                              LinkedIn
                              <ExternalLink size={11} aria-hidden />
                            </a>
                          ) : (
                            <span className="text-warmgray-500">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {!visible.length && (
        <p className="mt-3 text-sm text-warmgray-500">Nothing matches “{query}”.</p>
      )}

      <p className="mt-3 text-xs text-warmgray-500">
        Shaded rows are people you have written to. Copying an email out of Outreach marks it sent;
        use “Mark sent” for one you wrote somewhere else. A follow-up comes due a week after each
        email, up to three, and stops as soon as you mark that they replied.{" "}
        <Link href="/outreach" className="underline">
          Go to Outreach
        </Link>
      </p>
    </>
  );
}

/**
 * One contact's cold emails, in the order a student reads them: where it
 * stands, what has gone and when, and the one or two things to do next.
 *
 * Deliberately words, not icons - "2nd email due" is the whole message, and a
 * row of symbols would need a legend.
 */
function OutreachCell({
  outreach,
  onSent,
  onUndo,
  onReplied,
}: {
  outreach: OutreachView;
  onSent: () => void;
  onUndo: (sendId: string) => void;
  onReplied: (replied: boolean) => void;
}) {
  const { stage, sends, nextStep, dueAt, undoSendId } = outreach;

  const status =
    stage === "not_contacted"
      ? { text: "Not contacted", tone: "text-warmgray-500" }
      : stage === "due"
        ? { text: `${ordinal(nextStep ?? 2)} email due`, tone: "font-semibold text-[#9a4d00]" }
        : stage === "waiting"
          ? {
              text: `Waiting · ${ordinal(nextStep ?? 2)} email ${dueAt ? shortDate(dueAt) : ""}`,
              tone: "text-brand-900",
            }
          : stage === "replied"
            ? { text: "Replied", tone: "font-semibold text-[#1e6b3a]" }
            : { text: `No reply after ${MAX_EMAILS}`, tone: "text-warmgray-500" };

  const link = "text-[11px] text-brand-900 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-900";

  return (
    <div className="min-w-[11rem] text-xs">
      <p className={status.tone}>{status.text}</p>

      {sends.length > 0 && (
        <ol className="mt-1 space-y-0.5 text-[11px] text-warmgray-500">
          {sends.map((s, i) => (
            <li key={s.step} className="flex items-center gap-1.5">
              <span>
                {ordinal(s.step)} · {shortDate(s.sentAt)}
              </span>
              {/* Only the latest email can be taken back, and only one Offerly
                  has a record of - see undoOutreachSend. */}
              {i === sends.length - 1 && undoSendId && stage !== "replied" && (
                <button
                  type="button"
                  onClick={() => onUndo(undoSendId)}
                  aria-label={`Take back the ${ordinal(s.step)} email`}
                  title="Take this back"
                  className="leading-none text-warmgray-500 hover:text-brand-900"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ol>
      )}

      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
        {nextStep && stage !== "replied" && (
          <button type="button" onClick={onSent} className={link}>
            Mark {ordinal(nextStep)} sent
          </button>
        )}
        {sends.length > 0 && stage !== "replied" && (
          <button type="button" onClick={() => onReplied(true)} className={link}>
            They replied
          </button>
        )}
        {stage === "replied" && (
          <button type="button" onClick={() => onReplied(false)} className={link}>
            Undo reply
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * One filter's dropdown: tick any number of values, each with how many rows it
 * would show. Long lists (firms, schools) get a box to narrow them.
 */
function FilterMenu({
  label,
  options,
  picked,
  onToggle,
  searchable = false,
}: {
  label: string;
  options: { value: string; count: number }[];
  picked: string[];
  onToggle: (value: string) => void;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const shown = find.trim()
    ? options.filter((o) => o.value.toLowerCase().includes(find.trim().toLowerCase()))
    : options;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium transition ${
          picked.length ? "border-accent-500 bg-accent-50 text-brand-900" : "border-brand-300 text-brand-900 hover:bg-brand-50"
        }`}
      >
        {label}
        {picked.length > 0 && (
          <span className="rounded-full bg-accent-600 px-1.5 text-[10px] font-semibold text-[#ffffff]">{picked.length}</span>
        )}
        <ChevronDown size={12} aria-hidden />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`Filter by ${label.toLowerCase()}`}
          className="absolute left-0 top-full z-30 mt-1 w-64 rounded-md border border-brand-100 bg-white p-2 shadow-card"
        >
          {searchable && (
            <input
              autoFocus
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder={`Find a ${label.toLowerCase()}`}
              aria-label={`Find a ${label.toLowerCase()}`}
              className="mb-1.5 w-full rounded border border-brand-200 bg-white px-2 py-1 text-xs text-brand-900 focus:border-accent-500 focus:outline-none"
            />
          )}
          <ul className="max-h-64 overflow-y-auto">
            {shown.length === 0 && <li className="px-2 py-1.5 text-xs text-warmgray-500">No matches.</li>}
            {shown.map((o) => (
              <li key={o.value}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-brand-900 hover:bg-brand-50">
                  <input type="checkbox" checked={picked.includes(o.value)} onChange={() => onToggle(o.value)} />
                  <span className="min-w-0 flex-1 truncate">{o.value}</span>
                  <span className="tabular-nums text-warmgray-500">{o.count}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
