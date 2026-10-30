// Sample analytics for the demo firm, so the Analytics tab can be shown
// without real students behind it. The page labels it "Sample data" in as
// many words. Deterministic - the same demo shows the same numbers every time
// - and blended with the demo's own real clicks, so clicking Apply as the demo
// student still moves the demo firm's numbers.

import { breakdown, multiBreakdown, type FirmAnalytics } from "@/lib/firm-analytics-rules";

type Own = Pick<FirmAnalytics, "postings" | "events" | "weekly"> & {
  firmName: string;
  ownPostTotals: Pick<FirmAnalytics["totals"], "applyClicks" | "applyClickStudents" | "eventClicks" | "calendarAdds" | "notified">;
  now: Date;
};

/** A small seeded generator, so "random" sample data is the same on every load. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function repeat(entries: [string, number][]): string[] {
  return entries.flatMap(([label, n]) => Array.from({ length: n }, () => label));
}

export function sampleFirmAnalytics(own: Own): FirmAnalytics {
  const rand = seeded(20260923);
  const matched = 412;
  const foundContacts = 168;
  const tracking = 131;
  const applied = 51;

  const schools = repeat([
    ["University of Pennsylvania", 58],
    ["New York University", 47],
    ["Georgetown University", 39],
    ["University of Michigan", 36],
    ["Harvard University", 31],
    ["University of Southern California", 27],
    ["Cornell University", 22],
    ["Boston College", 17],
    ["Duke University", 3],
    ["School not verified", 42],
  ]);
  const gradYears = repeat([
    ["Class of 2027", 71],
    ["Class of 2028", 164],
    ["Class of 2029", 98],
    ["Class of 2030", 22],
  ]);
  const degrees = repeat([
    ["Bachelor's", 318],
    ["Master's or MBA", 29],
    ["Not given", 8],
  ]);
  const sectorPool = ["Investment Banking", "Private Equity", "Hedge Funds", "Asset & Wealth Management", "Sales & Trading", "Venture Capital"];
  const sectors = Array.from({ length: 355 }, () => {
    const n = 1 + Math.floor(rand() * 3);
    return [...new Set(Array.from({ length: n }, () => sectorPool[Math.floor(rand() ** 1.6 * sectorPool.length)]))];
  });
  const cityPool = ["New York", "San Francisco", "Chicago", "Boston", "Los Angeles", "Charlotte", "London"];
  const locations = Array.from({ length: 355 }, () => {
    const n = 1 + Math.floor(rand() * 2);
    return [...new Set(Array.from({ length: n }, () => cityPool[Math.floor(rand() ** 1.8 * cityPool.length)]))];
  });

  // Each posting gets sample clicks on top of any real demo clicks.
  const postings = own.postings.map((p, i) => {
    const base = p.isActive ? 38 - i * 7 : 6;
    return {
      ...p,
      applyClicks: p.applyClicks + Math.max(4, base + Math.floor(rand() * 9)),
      students: 0,
      notified: p.notified + 180 - i * 25,
    };
  });
  const events = own.events.map((e, i) => ({
    ...e,
    clicks: e.clicks + 24 - i * 4 + Math.floor(rand() * 6),
    calendarAdds: e.calendarAdds + 11 - i * 2,
    notified: e.notified + 64 - i * 9,
  }));
  const weekly = own.weekly.map((w, i) => ({ ...w, count: w.count + [9, 14, 11, 22, 18, 31, 27, 36][i % 8] }));

  // Students are fewer than clicks: some click Apply on more than one visit.
  for (const p of postings) p.students = Math.max(1, Math.round(p.applyClicks * 0.8));
  const applyClicks = postings.reduce((a, p) => a + p.applyClicks, 0);
  const applyClickStudents = Math.max(1, Math.round(applyClicks * 0.8)) + own.ownPostTotals.applyClickStudents;
  return {
    firmName: own.firmName,
    isSample: true,
    studentDataShared: true,
    generatedAt: own.now,
    totals: {
      matched,
      foundContacts,
      contactsFound: 523,
      tracking,
      applied,
      interviewing: 19,
      offers: 4,
      applyClicks,
      applyClickStudents,
      eventClicks: events.reduce((a, e) => a + e.clicks, 0),
      calendarAdds: events.reduce((a, e) => a + e.calendarAdds, 0),
      notified: postings.reduce((a, p) => a + p.notified, 0) + events.reduce((a, e) => a + e.notified, 0),
    },
    // Among matched students, like the real funnel - and never growing, so
    // the sample cannot show more students applying than clicked apply.
    funnel: [
      { label: "Matched with you", count: matched },
      { label: "Found contacts at your firm", count: foundContacts },
      { label: "Tracking one of your roles", count: tracking },
      { label: "Clicked apply", count: Math.min(tracking, applyClickStudents) },
      { label: "Applied", count: Math.min(applied, tracking, applyClickStudents) },
    ],
    postings,
    events,
    schools: breakdown(schools),
    gradYears: breakdown(gradYears),
    degrees: breakdown(degrees),
    sectors: multiBreakdown(sectors),
    locations: multiBreakdown(locations),
    weekly,
  };
}
