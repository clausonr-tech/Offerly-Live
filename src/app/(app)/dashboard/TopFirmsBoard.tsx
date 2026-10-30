"use client";

import { useRef, useState, useTransition } from "react";
import { ChevronDown, GripVertical, Plus, UserPlus, X } from "lucide-react";
import FirmLogo from "../discovery/FirmLogo";
import { FirmPanes } from "./MatchedFirmGrid";
import AddTopFirmButton from "./AddTopFirmButton";
import type { MatchedFirmGroup } from "@/lib/discovery-matches";
import type { TopFirmsState } from "./actions";
import type { ContactCredits } from "@/lib/contact-credits";

/**
 * External Network's main block: the student's top firms as a ranked list,
 * with finding people at each one a button on the row itself.
 *
 * This replaced a deck of overlapping playing cards. The deck showed a dozen
 * logos but only the uncovered strip of each name, and contact generation -
 * the thing a student most needs to do with a firm - sat inside the panel a
 * card opened, below the fold, one click past anything that said it existed.
 * Here every firm is a full row that reads at a glance (rank, name, why it was
 * picked, what's open, who you know), and the row's action is the search.
 */
export default function TopFirmsBoard({
  groups,
  totalGroups,
  credits,
  removeAction,
  reorderAction,
  firmOptions,
  addAction,
}: {
  groups: MatchedFirmGroup[];
  /** How many top firms the student has in all; `groups` may be the first slice. */
  totalGroups: number;
  credits: ContactCredits;
  removeAction: (topFirmId: string) => Promise<void>;
  /** Saves the order the student drags the list into (dashboard/actions). */
  reorderAction: (topFirmIds: string[]) => Promise<void>;
  firmOptions: { id: string; name: string }[];
  addAction: (state: TopFirmsState, formData: FormData) => Promise<TopFirmsState>;
}) {
  // One firm open at a time: two open panels push the rest of the list off
  // the screen.
  const [openId, setOpenId] = useState<string | null>(null);
  // The firm whose panel should start a search as it opens. Cleared the moment
  // the search is sent, so closing and reopening the panel never runs another.
  const [autoRunId, setAutoRunId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  // The student's own order (5 October 2026: "reorder it as the student
  // wants"). Held here so a drag lands at once; saved in the background, and
  // the next server render arrives in the same order. Firms added since are
  // appended; removed ones drop out.
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [, startSaving] = useTransition();
  const byId = new Map(groups.map((g) => [g.firm.id, g]));
  const ordered = order
    ? [...order.filter((id) => byId.has(id)).map((id) => byId.get(id)!), ...groups.filter((g) => !order.includes(g.firm.id))]
    : groups;
  const move = (firmId: string, to: number) => {
    const ids = ordered.map((g) => g.firm.id);
    const from = ids.indexOf(firmId);
    if (from < 0 || to < 0 || to >= ids.length || from === to) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    setOrder(ids);
    setAnnounce(`${byId.get(firmId)?.firm.name} moved to ${to + 1} of ${ids.length}.`);
    const topFirmIds = ids.map((id) => byId.get(id)?.firm.topFirmId).filter((x): x is string => Boolean(x));
    startSaving(() => reorderAction(topFirmIds));
  };

  const out = !credits.unlimited && credits.remaining <= 0;
  const withoutContacts = groups.filter((g) => g.contactCount === 0);
  const nextUp = withoutContacts[0] ?? null;

  const generateAt = (firmId: string) => {
    setOpenId(firmId);
    setAutoRunId(firmId);
    // The callout's button can start a search at a firm well down the list;
    // bring its row up so the result is not happening off-screen.
    requestAnimationFrame(() =>
      rowRefs.current.get(firmId)?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
    );
  };

  return (
    <section aria-labelledby="top-firms">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="top-firms" className="text-base font-semibold text-brand-900">
          Your top firms <span className="font-normal text-warmgray-500">({totalGroups})</span>
        </h2>
        <AddTopFirmButton firms={firmOptions} action={addAction} />
      </div>

      {/* The feature, stated once and plainly above the list it acts on. A
          button per row says "you can do this here"; this says what it does,
          what it costs, and where to start. */}
      <div className="mb-3 flex flex-wrap items-center gap-4 rounded-lg border border-accent-200 bg-accent-50 px-4 py-3.5">
        <span
          aria-hidden
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-500 text-[#ffffff]"
        >
          <UserPlus size={18} strokeWidth={1.75} />
        </span>
        <div className="min-w-[14rem] flex-1">
          <p className="text-sm font-semibold text-brand-900">Find people at your firms</p>
          <p className="mt-0.5 text-xs leading-relaxed text-warmgray-600">
            One search finds {credits.contactsPerRun} people at a firm worth writing to, picked
            from your school, resume and LinkedIn, with an email where one can be found.{" "}
            {withoutContacts.length > 0 ? (
              <span className="font-medium text-brand-900">
                {withoutContacts.length} of your {groups.length} firms have no contacts yet.
              </span>
            ) : (
              <span className="font-medium text-brand-900">Every firm here has people on file.</span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {nextUp && (
            <button
              type="button"
              onClick={() => generateAt(nextUp.firm.id)}
              disabled={out}
              className="flex items-center gap-1.5 bg-accent-500 px-4 py-2 text-xs font-semibold text-[#ffffff] shadow-card transition-colors hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <UserPlus size={13} aria-hidden />
              Start with {nextUp.firm.name}
            </button>
          )}
          <CreditsLine credits={credits} />
        </div>
      </div>

      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
      <ol className="list-panel divide-y divide-brand-100 overflow-hidden border border-brand-100">
        {ordered.map((group, i) => {
          const { firm, internships, contactCount } = group;
          const open = openId === firm.id;
          const openRoles = internships.length;
          return (
            <li
              key={firm.id}
              ref={(el) => {
                if (el) rowRefs.current.set(firm.id, el);
                else rowRefs.current.delete(firm.id);
              }}
              className={`${open ? "bg-brand-50/40" : ""} ${dragId === firm.id ? "opacity-50" : ""} ${
                overId === firm.id && dragId && dragId !== firm.id ? "shadow-[inset_0_2px_0_0_var(--color-accent-500)]" : ""
              }`}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                setOverId(firm.id);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId) move(dragId, i);
                setDragId(null);
                setOverId(null);
              }}
            >
              <div className="group relative flex items-center gap-3 px-4 py-3">
                {/* Drag to reorder, or focus it and use the arrow keys. */}
                <button
                  type="button"
                  draggable
                  onDragStart={(e) => {
                    setDragId(firm.id);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", firm.id);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setOverId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                    e.preventDefault();
                    move(firm.id, i + (e.key === "ArrowUp" ? -1 : 1));
                    // Keep focus on the handle as its row moves.
                    requestAnimationFrame(() =>
                      rowRefs.current.get(firm.id)?.querySelector<HTMLButtonElement>("[data-reorder]")?.focus(),
                    );
                  }}
                  data-reorder
                  aria-label={`Reorder ${firm.name}, number ${i + 1}. Use the up and down arrow keys, or drag.`}
                  title="Drag to reorder"
                  className="-ml-2 shrink-0 cursor-grab rounded p-0.5 text-warmgray-400 hover:text-brand-900 focus-visible:outline-2 focus-visible:outline-accent-500 active:cursor-grabbing"
                >
                  <GripVertical size={14} aria-hidden />
                </button>
                <span className="hidden w-5 shrink-0 text-right text-xs tabular-nums text-warmgray-500 sm:block">
                  {i + 1}
                </span>

                {/* The name and its line open the panel, like the chevron. */}
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : firm.id)}
                  aria-expanded={open}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <FirmLogo domain={firm.website} name={firm.name} size={32} />
                  <span className="min-w-0 flex-1">
                    <span
                      title={firm.name}
                      className="block truncate text-sm font-medium text-brand-900 group-hover:underline"
                    >
                      {firm.name}
                    </span>
                    <span
                      title={firm.reason ?? undefined}
                      className="block truncate text-[11px] text-warmgray-500"
                    >
                      {firm.reason ?? "Added by you"}
                    </span>
                  </span>
                </button>

                {/* Counts drop below sm - the name and the action are what a
                    phone row has room for, and the panel repeats both. */}
                <span className="hidden w-[4.75rem] shrink-0 text-right text-xs text-warmgray-500 sm:block">
                  <span className={openRoles > 0 ? "font-medium text-brand-900" : undefined}>
                    {openRoles}
                  </span>{" "}
                  open role{openRoles === 1 ? "" : "s"}
                </span>
                <span className="hidden w-[4.75rem] shrink-0 text-right text-xs sm:block">
                  {contactCount > 0 ? (
                    <span className="text-warmgray-500">
                      <span className="font-medium text-brand-900">{contactCount}</span>{" "}
                      {contactCount === 1 ? "person" : "people"}
                    </span>
                  ) : (
                    <span className="text-warmgray-500">No one yet</span>
                  )}
                </span>

                {/* Filled while a firm has nobody - that is the row that needs
                    it. Outlined once it has people: still one click, no longer
                    the loudest thing on the row. */}
                <button
                  type="button"
                  onClick={() => generateAt(firm.id)}
                  disabled={out}
                  title={out ? "No searches left this month" : undefined}
                  aria-label={`${contactCount === 0 ? "Generate contacts" : "Find more people"} at ${firm.name}`}
                  // Icon-only below sm, where the label would take the firm
                  // name's room.
                  className={`flex shrink-0 items-center sm:w-[7.25rem] justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    contactCount === 0
                      ? "bg-accent-500 text-[#ffffff] shadow-card hover:bg-accent-400"
                      : "border border-accent-500 text-accent-700 hover:bg-accent-50"
                  }`}
                >
                  <UserPlus size={12} aria-hidden />
                  <span className="hidden sm:inline">
                    {contactCount === 0 ? `Generate ${credits.contactsPerRun}` : "Find more"}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : firm.id)}
                  aria-label={open ? `Close ${firm.name}` : `Open ${firm.name}`}
                  className="shrink-0 p-1 text-warmgray-500 hover:text-brand-900"
                >
                  <ChevronDown
                    size={15}
                    aria-hidden
                    className={`transition-transform ${open ? "rotate-180" : ""}`}
                  />
                </button>

                <form
                  action={removeAction.bind(null, firm.topFirmId)}
                  className="absolute left-1 top-1/2 -translate-y-1/2"
                >
                  <button
                    type="submit"
                    title={`Remove ${firm.name}`}
                    className="flex h-5 w-5 items-center justify-center rounded-full bg-white text-warmgray-500 opacity-0 shadow-card transition-opacity hover:text-error-600 focus:opacity-100 group-hover:opacity-100"
                  >
                    <X size={11} aria-hidden />
                    <span className="sr-only">Remove {firm.name}</span>
                  </button>
                </form>
              </div>

              {open && (
                <div className="border-t border-brand-100 px-4 pb-4 pt-3">
                  <FirmPanes
                    group={group}
                    credits={credits}
                    autoGenerate={autoRunId === firm.id}
                    onAutoGenerate={() => setAutoRunId(null)}
                  />
                </div>
              )}
            </li>
          );
        })}

        {/* The list's last row adds to it, so "your firms" stays one object
            rather than a list with a control bolted on somewhere else. */}
        <li>
          <AddTopFirmButton
            firms={firmOptions}
            action={addAction}
            align="left"
            renderTrigger={({ onClick, isPending }) => (
              <button
                type="button"
                onClick={onClick}
                disabled={isPending}
                className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-warmgray-500 transition-colors hover:bg-brand-50 hover:text-brand-900"
              >
                <span className="hidden w-5 shrink-0 sm:block" />
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-brand-200">
                  <Plus size={14} aria-hidden />
                </span>
                Add a firm you&apos;re targeting
              </button>
            )}
          />
        </li>
      </ol>
    </section>
  );
}

function CreditsLine({ credits }: { credits: ContactCredits }) {
  if (credits.unlimited) {
    return <span className="text-[11px] font-medium text-success-800">Unlimited searches</span>;
  }
  return (
    <span className="text-[11px] text-warmgray-500">
      <span className={`font-medium ${credits.remaining > 0 ? "text-brand-900" : "text-error-600"}`}>
        {credits.remaining}
      </span>{" "}
      of {credits.limit} searches left this month
    </span>
  );
}
