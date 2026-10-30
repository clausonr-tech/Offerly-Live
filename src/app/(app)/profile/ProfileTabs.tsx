"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PROFILE_TABS } from "@/lib/profile-tabs";

/** Underlined tab strip, the same idiom as Outreach and Discovery. Real links, so each tab has a URL. */
export default function ProfileTabs() {
  const pathname = usePathname();

  return (
    <nav aria-label="Profile sections" className="flex gap-1 border-b border-brand-100">
      {PROFILE_TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              active
                ? "border-accent-500 text-brand-900"
                : "border-transparent text-warmgray-500 hover:text-brand-900"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
