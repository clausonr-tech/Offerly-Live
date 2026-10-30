"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink, Mail } from "lucide-react";
import { CATEGORY_LABELS, type FirmProgramCategory } from "@/lib/firm-metadata";
import { externalHref } from "@/lib/safe-url";

type Program = {
  id: string;
  category: FirmProgramCategory;
  roleLabel: string;
  timingGuidance: string;
  careersUrl: string;
  recruitingChannelLabel: string;
  recruitingChannelUrl: string;
};

/**
 * Programs grouped into one tab per SECTOR, with that sector's programs listed
 * inside it.
 *
 * There used to be one tab per program, each labelled with its category, which
 * meant JPMorgan - nine programs, six of them investment banking - rendered six
 * buttons all reading "Investment Banking". The thing that distinguishes them
 * (Equities, Research, Technology, Risk Management) lives in roleLabel and was
 * never shown, so the tab strip was both repetitive and uninformative.
 *
 * Grouping matters more since firms absorbed their sibling legal entities: a
 * merged firm carries every division's programs, so the tab strip is now the
 * answer to "which sectors does this firm recruit for?" and has to read as a
 * set of sectors rather than a run of duplicates.
 */
export default function FirmProgramTabs({
  firmName,
  programs,
}: {
  firmName: string;
  programs: Program[];
}) {
  // Grouped in first-appearance order, which keeps the firm's primary sector -
  // the one its seed lists first - at the front of the strip.
  const sectors = useMemo(() => {
    const bySector = new Map<FirmProgramCategory, Program[]>();
    for (const p of programs) {
      const list = bySector.get(p.category);
      if (list) list.push(p);
      else bySector.set(p.category, [p]);
    }
    return [...bySector.entries()].map(([category, items]) => ({ category, items }));
  }, [programs]);

  const [activeCategory, setActiveCategory] = useState(sectors[0]?.category);
  const active = sectors.find((s) => s.category === activeCategory) ?? sectors[0];

  if (!active) return null;

  return (
    <div>
      {/* One button per sector. A single-sector firm gets no strip at all -
          a lone tab is a label pretending to be a control. */}
      {sectors.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {sectors.map((s) => (
            <button
              key={s.category}
              type="button"
              onClick={() => setActiveCategory(s.category)}
              aria-pressed={s.category === active.category}
              className={`rounded-sm px-3 py-1.5 text-xs font-medium transition-colors ${
                s.category === active.category
                  ? "bg-accent-600 text-white"
                  : "border border-brand-100 bg-white text-warmgray-600 hover:border-brand-300"
              }`}
            >
              {CATEGORY_LABELS[s.category]}
              {s.items.length > 1 && (
                <span
                  className={
                    s.category === active.category
                      ? "ml-1.5 text-white/70"
                      : "ml-1.5 text-warmgray-300"
                  }
                >
                  {s.items.length}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {active.items.map((program) => (
          <ProgramCard key={program.id} firmName={firmName} program={program} />
        ))}
      </div>
    </div>
  );
}

function ProgramCard({ firmName, program }: { firmName: string; program: Program }) {
  const reminderTitle = `${firmName} - ${program.roleLabel} application`;
  // Read-boundary guard - both columns hold a firm's own link, kept current by
  // the crawl, so neither is a string this repo wrote. See lib/safe-url. A
  // refused value falls into the same branch as a missing one below: the
  // careers link is omitted, and the recruiting channel stays plain text.
  const careers = externalHref(program.careersUrl);
  const channel = externalHref(program.recruitingChannelUrl);
  return (
    <div className="rounded-lg border border-brand-100 bg-white p-5">
      <p className="text-sm font-semibold text-brand-900">{program.roleLabel}</p>
      <p className="mt-2 text-sm leading-relaxed text-warmgray-600">{program.timingGuidance}</p>
      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        {/* Both links are omitted rather than rendered empty for the
            SEC-imported directory firms, which have no verified careers
            page - an anchor with no href is a dead control, not a hint. */}
        {careers && (
          <a
            href={careers}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 font-medium text-brand-900 hover:underline"
          >
            Official careers page
            <ExternalLink size={12} />
          </a>
        )}
        {channel ? (
          <a
            href={channel}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-warmgray-500 hover:underline"
          >
            <Mail size={12} />
            {program.recruitingChannelLabel}
          </a>
        ) : (
          <span className="flex items-center gap-1 text-warmgray-500">
            <Mail size={12} />
            {program.recruitingChannelLabel}
          </span>
        )}
        <Link
          href={`/schedule?title=${encodeURIComponent(reminderTitle)}&type=deadline`}
          className="ml-auto rounded-md bg-accent-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-400 shadow-card"
        >
          Add reminder to Schedule
        </Link>
      </div>
    </div>
  );
}
