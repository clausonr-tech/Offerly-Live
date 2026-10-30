"use client";

import { useRouter } from "next/navigation";

// The News section's one control: which view to read. The student's digest is
// the default (no query string), then today's top stories, then each sector.
// A select rather than fifteen pills - the row of pills wrapped to three lines
// on a laptop and pushed the stories below the fold.
export default function NewsViewSelect({
  value,
  options,
}: {
  value: string;
  options: { value: string; label: string }[];
}) {
  const router = useRouter();
  return (
    <label className="inline-flex items-center gap-2 text-sm text-warmgray-600">
      <span className="font-medium text-brand-900">Show</span>
      <select
        value={value}
        onChange={(e) => router.push(e.target.value === "digest" ? "/news" : `/news?category=${e.target.value}`)}
        className="rounded-sm border border-brand-100 bg-white px-3 py-1.5 text-sm text-brand-900 hover:border-brand-200 focus:border-accent-400 focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
