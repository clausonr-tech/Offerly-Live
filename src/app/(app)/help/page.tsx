import Link from "next/link";
import { ArrowRight, CircleUserRound, type LucideIcon } from "lucide-react";

import { getCurrentUser } from "@/lib/current-user";
import { HELP_GROUPS, RECRUITING_PATH } from "@/lib/help-guide";
import { NAV_SECTIONS } from "@/lib/nav-sections";
import HelpChat from "./HelpChat";

export const metadata = { title: "Help" };

/**
 * The sidebar sections each help card covers, so a card carries the same icon
 * the student already knows from the rail. Two cards cover two sections each
 * and show both. Read from NAV_SECTIONS, never redrawn here, so a new sidebar
 * icon arrives on the card with no edit to this page.
 */
const CARD_SECTIONS: Record<string, string[]> = {
  "/discovery": ["/discovery", "/news"],
  "/schedule": ["/schedule", "/learn"],
};

function cardIcons(href: string): LucideIcon[] {
  const icons = (CARD_SECTIONS[href] ?? [href])
    .map((h) => NAV_SECTIONS.find((s) => s.href === h)?.Icon)
    .filter((icon): icon is LucideIcon => !!icon);
  // Your account is not in the rail; it is the avatar in the top bar.
  return icons.length > 0 ? icons : [CircleUserRound];
}

/**
 * The whole guide on one page - the help panel's "Open the full guide".
 *
 * Short on purpose: the recruiting path as one line of steps, then the six
 * groups in HELP_GROUPS, two to a row across the page. The long tail of tasks
 * lives in the help menu's search, not here, so a student can take in the
 * shape of the app without scrolling through fifty links to do it.
 *
 * The assistant sits first, under the header: a student who came to Help
 * usually has a question, and asking it is quicker than finding the link.
 */
export default async function HelpPage() {
  const user = await getCurrentUser();
  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-brand-900">How Offerly works</h1>
        <p className="mt-1 text-sm text-warmgray-500">
          Press <kbd className="rounded border border-brand-100 px-1 font-mono text-[11px]">?</kbd>{" "}
          on any page to search for anything else.
        </p>
      </header>

      <HelpChat name={user.name} />

      <section aria-labelledby="path-heading" className="mb-8">
        <h2 id="path-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-warmgray-500">
          The recruiting path
        </h2>
        {/* One line, spread across the width: it is a sequence, and a wrap
            breaks the sequence into two rows that read as two lists. On a
            screen too narrow for all six it scrolls sideways instead. */}
        <ol className="flex items-center justify-between gap-0.5 overflow-x-auto pb-1">
          {RECRUITING_PATH.map((step, i) => (
            <li key={step.title} className="flex shrink-0 items-center gap-0.5">
              <Link
                href={step.href}
                title={step.body}
                className="flex items-center gap-1.5 whitespace-nowrap rounded-full py-1 pl-0.5 pr-1.5 text-[12.5px] text-brand-900 transition-colors hover:bg-brand-50"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#0b1526] text-[11px] font-semibold text-[#ffffff]">
                  {i + 1}
                </span>
                {step.title}
              </Link>
              {i < RECRUITING_PATH.length - 1 && (
                <ArrowRight size={12} aria-hidden className="shrink-0 text-warmgray-400" />
              )}
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="sections-heading">
        <h2 id="sections-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-warmgray-500">
          Every part of the app
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          {HELP_GROUPS.map((group) => (
            <article key={group.href} className="list-panel flex flex-col border border-brand-100 p-5">
              <div className="flex items-center gap-2.5">
                <span aria-hidden className="flex shrink-0 items-center gap-1 text-brand-900">
                  {cardIcons(group.href).map((Icon, i) => (
                    <Icon key={i} size={17} strokeWidth={1.75} />
                  ))}
                </span>
                <Link href={group.href} className="text-base font-medium text-brand-900 hover:underline">
                  {group.label}
                </Link>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-warmgray-500">{group.summary}</p>
              <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
                {group.tasks.map((task) => (
                  <li key={task.label}>
                    <Link href={task.href} className="text-sm text-brand-900 underline-offset-2 hover:underline">
                      {task.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
