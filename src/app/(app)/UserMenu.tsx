"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PROFILE_TABS } from "@/lib/profile-tabs";

export default function UserMenu({
  name,
  initial,
  heading = "Profile",
  items = PROFILE_TABS,
}: {
  name: string;
  initial: string;
  /** The menu's links. The student profile tabs by default. */
  heading?: string;
  items?: readonly { href: string; label: string; description: string }[];
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2"
      >
        <span className="hidden text-sm text-warmgray-500 hover:text-brand-900 sm:inline">{name}</span>
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-500 text-xs font-semibold text-white">
          {initial}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-xl border border-brand-100 bg-white py-1 shadow-lg"
        >
          <p className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-warmgray-500">
            {heading}
          </p>
          {items.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-4 py-2 hover:bg-brand-50"
            >
              <span className="block text-sm text-brand-900">{tab.label}</span>
              <span className="block text-xs text-warmgray-500">{tab.description}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
