"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { NAV_SECTIONS, belongsTo, subsectionFor } from "@/lib/nav-sections";

/**
 * A section's views, as a floating bar across the top of its pages, for the
 * sections whose children are `childrenIn: "topbar"` (lib/nav-sections):
 * Internal Network (Feed, Peers, ...) and External Network (Dashboard,
 * Industry Contacts). They used to be rows under the section in the sidebar.
 * Full width, tabs sharing it evenly; on a narrow screen it scrolls sideways
 * instead.
 *
 * Sticky, not fixed: every app page sits inside `.app-reveal`, whose
 * transform makes position:fixed pin to the page instead of the viewport (see
 * CommunityNav's note). Sticky is unaffected. Used by the /networking layout
 * and by the pages that belong to a section but live elsewhere
 * (/messages/[id] for Internal Network, /contacts/* for External Network), so
 * the bar does not vanish when a conversation or a contact is opened.
 */
export default function SectionTopBar({
  sectionHref,
  hubLabel,
}: {
  /** The NAV_SECTIONS entry whose children are the tabs. */
  sectionHref: string;
  /** The first tab, for the section's own page: "Feed", "Dashboard". */
  hubLabel: string;
}) {
  const pathname = usePathname();
  const section = NAV_SECTIONS.find((s) => s.href === sectionHref)!;
  const tabs = [{ href: section.href, label: hubLabel }, ...(section.children ?? [])];
  const child = subsectionFor(section, pathname);
  const current = child?.href ?? (belongsTo(section, pathname) ? section.href : null);
  const listRef = useRef<HTMLUListElement>(null);

  // On a narrow screen the bar scrolls sideways; keep the current tab in view.
  useEffect(() => {
    const list = listRef.current;
    const tab = list?.querySelector<HTMLElement>("[aria-current]");
    if (list && tab) list.scrollLeft = tab.offsetLeft - (list.clientWidth - tab.offsetWidth) / 2;
  }, [current]);

  return (
    <nav aria-label={section.label} className="sticky top-3 z-20 mb-6">
      <ul ref={listRef} className="flex w-full gap-1 overflow-x-auto rounded-full border border-brand-100 bg-white/90 p-1 shadow-card backdrop-blur-md [scrollbar-width:none]">
        {tabs.map((t) => {
          const active = t.href === current;
          return (
            <li key={t.href} className="min-w-fit flex-1">
              <Link
                href={t.href}
                aria-current={active ? (pathname === t.href ? "page" : "location") : undefined}
                className={`block whitespace-nowrap rounded-full px-4 py-2 text-center text-sm font-medium transition-colors ${
                  active ? "bg-accent-600 text-[#ffffff]" : "text-brand-900 hover:bg-brand-50"
                }`}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
