// 500 generated cases for each of the outreach features and their fixes,
// checked against invariants (and, where the rule is non-trivial, against an
// independent reference implementation). Seeded, so a failure is repeatable:
// the case number in its name is the seed.
//
// No model calls, no database: every rule here is pure.

import { test } from "node:test";
import assert from "node:assert/strict";

import { contactEmailToShow, shouldRenderEmail } from "@/lib/contact-email-render";
import { orderTopFirms } from "@/lib/discovery-matches";
import {
  OCCASIONS,
  autoFill,
  boxesConflict,
  occasionById,
  resolveSituation,
  situationQuestions,
  visibleSections,
  type RecipientHints,
} from "@/lib/draft-occasions";
import { cleanEventDescription } from "@/lib/event-description";
import { normalizeFirmName } from "@/lib/firm-name";
import {
  REMIND_AFTER_DAYS,
  REMIND_AGAIN_DAYS,
  generatedFlashKey,
  generatedNotificationKey,
  generatedTitle,
  unreachedByFirm,
  type ContactRow,
} from "@/lib/generated-reminders";
import { bellRow } from "@/lib/notification-row";
import { toNotificationList, type NotificationRow } from "@/lib/notifications";
import { industryLabel, sectorLabel } from "@/lib/question-bank/picker-labels";
import { QUIZ_SPECIALTIES } from "@/lib/question-bank/specialties";
import { CATEGORY_LABELS, QUIZ_CATEGORIES, type QuizCategory } from "@/lib/question-bank/types";
import { industryFor, quickDraftForm, sentenceCase } from "@/lib/quick-draft";
import { postingPlacement } from "@/lib/upcoming-applications";

const CASES = 500;
const DAY = 86_400_000;

/** mulberry32: small, fast, and the same sequence for the same seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
    subset: <T>(xs: readonly T[]): T[] => xs.filter(() => next() < 0.4),
  };
}

async function cases(t: { test: (name: string, fn: () => void) => Promise<void> }, check: (r: ReturnType<typeof rng>, i: number) => void) {
  for (let i = 1; i <= CASES; i++) await t.test(`case ${i}`, () => check(rng(i * 7919), i));
}

const NAMES = ["Jane Doe", "Sam Lee", "Priya Nair", "Ana", "  Luis  Ortega ", "O'Brien Kelly", "Zoë Müller", "Li Wei"];
const FIRMS = ["PJT Partners", "Evercore", "Moelis & Company", "Lazard", "Centerview Partners", "Bank of America"];
const DIVISIONS = ["Investment Banking", "Sales & Trading", "Equity Research", "Private Equity", "Asset Management", "Restructuring"];
const SENIORITY = ["Analyst", "Associate", "Vice President", "VP", "Senior Associate", "Managing Director", "Director", ""];

// ---------------------------------------------------------------- 1. Draft email button

test("1. Draft email: the one-click form is always one the server accepts, and says only what is known", async (t) => {
  await cases(t, (r) => {
    const division = r.pick(DIVISIONS);
    const role = r.chance(0.15)
      ? null
      : [r.pick(SENIORITY), r.chance(0.6) ? division : r.pick(["Healthcare", "M&A", "Restructuring", ""])]
          .filter(Boolean)
          .join(r.pick([" ", ", ", " - "]));
    const divisions = r.subset(DIVISIONS);
    const facts = {
      name: r.pick(NAMES),
      firm: r.chance(0.1) ? r.pick([null, "", "  "]) : r.pick(FIRMS),
      role,
      connectionAngle: r.chance(0.5) ? r.pick(["Both played club soccer", "  ", "Same hometown: Austin"]) : null,
      background: r.chance(0.5) ? r.pick(["Ex-Goldman", "", "Worked in healthcare coverage"]) : null,
      linkedinUrl: r.chance(0.7) ? "https://www.linkedin.com/in/x" : null,
      sameSchool: r.chance(0.5),
      divisions,
    };
    const { box, fields } = quickDraftForm(facts);

    assert.equal(box, facts.sameSchool ? "first.alum" : "first.not_alum");
    const situation = resolveSituation("first_contact", [box]);
    assert.ok(!("error" in situation), "the server rejects the situation");
    for (const q of situationQuestions(situation, (n) => fields[n])) {
      if (q.required) assert.ok(fields[q.name]?.trim(), `required "${q.name}" left blank`);
    }
    for (const [k, v] of Object.entries(fields)) {
      assert.doesNotMatch(v, /undefined|null|\[object/, `${k} leaks a missing value: ${v}`);
      assert.ok(v.trim(), `${k} is blank`);
    }
    assert.match(fields.extraContext, /Zoom/);
    assert.match(fields.extraContext, /never invent/);
    assert.doesNotMatch(fields.extraContext, /the area .* works in/);

    const industry = industryFor(role, divisions);
    if (industry) {
      assert.equal(fields.financeInterest, sentenceCase(industry));
      assert.ok(fields.extraContext.includes(sentenceCase(industry)));
    } else {
      assert.equal(fields.financeInterest, undefined);
    }
    const named = divisions.find((d) => (role ?? "").toLowerCase().includes(d.toLowerCase()));
    if (named) assert.equal(industry, named, "a division named in the title is the industry");
    assert.equal(sentenceCase(sentenceCase(industry ?? "x")), sentenceCase(industry ?? "x"));

    if (facts.sameSchool) {
      assert.equal(fields.howFound, undefined);
      assert.equal(fields.whyThem, undefined);
    } else {
      assert.equal(fields.howFound.startsWith("LinkedIn"), Boolean(facts.linkedinUrl));
      // Written by the app, never copied from the profile.
      assert.match(fields.whyThem, /^Their work (in .+ )?at .+, and the path that took them there$/);
      for (const text of [facts.connectionAngle, facts.background]) {
        if (text?.trim()) assert.ok(!Object.values(fields).some((v) => v.includes(text.trim())), "profile text copied into the student's words");
      }
    }
  });
});

// ---------------------------------------------------------------- 2. Notification "Go do it"

test("2. Notifications: every open job keeps its own link for Go do it, in the right order and count", async (t) => {
  await cases(t, (r) => {
    const now = Date.UTC(2026, 8, 24);
    const rows = Array.from({ length: r.int(0, 12) }, (_, i) => {
      const done = r.chance(0.3);
      return {
        id: `n${i}`,
        userId: "u",
        kind: r.pick(["outreach", "follow_up", "thank_you", "interview_prep", "application_deadline"]),
        dedupeKey: `k${i}`,
        subjectKey: null,
        title: r.pick(["Email Jane Doe", "", "  Prep for\nLazard  ", "Send a thank-you"]),
        body: r.pick(["and 2 others at PJT Partners you haven't emailed", "", "2nd email · Evercore · no reply since 14 Sep"]),
        href: r.pick(["/discovery/firm/pjt-partners", "/outreach/email?occasion=thanks", "/learn", "https://evercore.tal.net/apply"]),
        expiresAt: null,
        createdAt: new Date(now - i * DAY),
        bumpedAt: new Date(now - r.int(0, 10_000) * 60_000),
        readAt: r.chance(0.5) ? new Date(now) : null,
        doneAt: done ? new Date(now) : null,
        doneSource: done ? "manual" : null,
      } as unknown as NotificationRow;
    });
    const list = toNotificationList(rows);
    const open = rows.filter((x) => !x.doneAt);
    assert.equal(list.openCount, open.length);
    assert.equal(list.unreadCount, open.filter((x) => !x.readAt).length);
    for (const item of list.open) {
      const src = rows.find((x) => x.id === item.id)!;
      assert.equal(item.href, src.href, "the Go do it link is the job's own");
      assert.ok(item.href.startsWith("/") || item.href.startsWith("https://"));
      const line = bellRow({ title: item.title, body: item.body });
      assert.ok(line.title.length > 0 && !line.title.includes("\n"), "a row always reads as one line");
    }
    for (let i = 1; i < list.open.length; i++) {
      assert.ok(list.open[i - 1].bumpedAt >= list.open[i].bumpedAt, "newest firing first");
    }
  });
});

// ---------------------------------------------------------------- 3. Reminder for people found and never emailed

function referenceUnreached(rows: ContactRow[], now: number) {
  const firms = new Map<string, { name: string; reached: Map<string, boolean>; found: ContactRow[] }>();
  for (const row of rows) {
    const firm = row.firm?.trim();
    if (!firm) continue;
    const key = normalizeFirmName(firm);
    if (!key) continue;
    const f = firms.get(key) ?? { name: firm, reached: new Map<string, boolean>(), found: [] as ContactRow[] };
    const who = row.name.trim().toLowerCase();
    f.reached.set(who, f.reached.get(who) === true || row.relationshipStatus !== "not_contacted");
    if (row.enrichedAt) f.found.push(row);
    firms.set(key, f);
  }
  const out: { firmKey: string; lead: string; others: number; days: number; stage: number }[] = [];
  for (const [firmKey, f] of firms) {
    let lead: ContactRow | null = null;
    for (const c of f.found) {
      if (f.reached.get(c.name.trim().toLowerCase())) continue;
      if (now - c.enrichedAt!.getTime() < REMIND_AFTER_DAYS * DAY) continue;
      if (
        !lead ||
        c.enrichedAt!.getTime() < lead.enrichedAt!.getTime() ||
        (c.enrichedAt!.getTime() === lead.enrichedAt!.getTime() && c.name.localeCompare(lead.name) < 0)
      ) {
        lead = c;
      }
    }
    if (!lead) continue;
    const days = Math.floor((now - lead.enrichedAt!.getTime()) / DAY);
    const unreached = [...f.reached.values()].filter((v) => !v).length;
    out.push({ firmKey, lead: lead.id, others: Math.max(0, unreached - 1), days, stage: days >= REMIND_AGAIN_DAYS ? 2 : 1 });
  }
  return out;
}

test("3. Reminders: who is named, how many others, and when, match a reference count", async (t) => {
  await cases(t, (r, i) => {
    const now = new Date(Date.UTC(2026, 8, 24, 12));
    const rows: ContactRow[] = Array.from({ length: r.int(0, 14) }, (_, j) => ({
      id: `c${i}-${j}`,
      name: r.pick([...NAMES, "jane doe", "JANE DOE "]),
      firm: r.chance(0.08) ? r.pick([null, "", " "]) : r.pick([...FIRMS, "pjt partners", "PJT Partners, Inc."]),
      enrichedAt: r.chance(0.7) ? new Date(now.getTime() - r.int(0, 12) * DAY - r.int(0, 23) * 3_600_000) : null,
      relationshipStatus: r.chance(0.7) ? "not_contacted" : r.pick(["reached_out", "replied", "meeting_scheduled"]),
    }));
    const got = unreachedByFirm(rows, normalizeFirmName, now);
    const want = referenceUnreached(rows, now.getTime());
    assert.deepEqual(
      got.map((f) => ({ firmKey: f.firmKey, lead: f.lead.contactId, others: f.others, days: f.days, stage: f.stage })).sort((a, b) => a.firmKey.localeCompare(b.firmKey)),
      want.sort((a, b) => a.firmKey.localeCompare(b.firmKey)),
    );
    for (let k = 1; k < got.length; k++) assert.ok(got[k - 1].days >= got[k].days, "longest wait first");
    for (const f of got) {
      assert.ok(f.days >= REMIND_AFTER_DAYS);
      assert.equal(f.people.length, f.others + 1, "everyone left, each once");
      assert.equal(f.people[0], f.lead.name, "the lead first");
      assert.equal(
        generatedTitle(f),
        f.people.length === 1 ? `Email ${f.lead.name} at ${f.firmName}` : `Email ${f.people.length} people at ${f.firmName}`,
        "named by the firm",
      );
      assert.equal(generatedNotificationKey(f.firmKey), `generated:${f.firmKey}`);
      assert.equal(generatedFlashKey(f), `generated:${f.firmKey}:s${f.stage}`);
    }
  });
});

// ---------------------------------------------------------------- 4. Draft form auto-fill

const RECRUITER = /\b(recruit\w*|talent|campus|early careers?|human resources|hr)\b/i;
const TEAM = /\b(team|recruiting|careers|inbox|office|committee)\b/i;

test("4. Auto-fill: the boxes it checks are valid, visible, and exactly what the facts settle", async (t) => {
  await cases(t, (r) => {
    const sameSchool = r.chance(0.4);
    const hints: RecipientHints = {
      sameSchool,
      knownNotAlum: !sameSchool && r.chance(0.6),
      role: r.pick([null, "Analyst", "Campus Recruiter", "Talent Acquisition", "Vice President", "HR Partner"]),
      name: r.pick(["Dana Reed", "Morrow Recruiting Team", "Careers Inbox", "Sam Lee"]),
      hasPriorColdEmail: r.chance(0.4),
      hasFollowUp1: r.chance(0.4),
    };
    const outside = r.chance(0.5);
    const chosen = r.chance(0.5) ? r.pick(OCCASIONS).id : undefined;
    const fill = autoFill(r.chance(0.05) ? null : hints, { outside, occasionId: chosen });
    if (!fill.occasionId) return;
    const occasion = occasionById(fill.occasionId)!;
    if (chosen) assert.equal(fill.occasionId, chosen, "the student's own occasion is kept");

    const all = new Set(occasion.sections.flatMap((s) => s.boxes.map((b) => b.id)));
    const shown = new Set(visibleSections(occasion, outside).flatMap((s) => s.boxes.map((b) => b.id)));
    for (const b of fill.boxes) {
      assert.ok(all.has(b), `${b} is not in ${occasion.id}`);
      if (all.size > 1) assert.ok(shown.has(b), `${b} is checked but hidden`);
    }
    for (const a of fill.boxes) for (const b of fill.boxes) if (a !== b) assert.ok(!boxesConflict(a, b), `${a} + ${b}`);
    for (const s of occasion.sections) {
      if (s.mode === "one") assert.ok(s.boxes.filter((b) => fill.boxes.includes(b.id)).length <= 1);
    }
    if (fill.boxes.length > 0) assert.ok(!("error" in resolveSituation(fill.occasionId, fill.boxes)));
    if (!outside) {
      assert.ok(!fill.boxes.some((b) => ["first.referred", "first.met", "first.conference", "first.pointed"].includes(b)));
    }

    if (occasion.id === "first_contact") {
      const inbox = TEAM.test(hints.name ?? "");
      const recruiter = !inbox && RECRUITER.test(hints.role ?? "");
      assert.equal(fill.boxes.includes("first.alum"), !inbox && sameSchool);
      assert.equal(fill.boxes.includes("first.not_alum"), !inbox && !sameSchool && !!hints.knownNotAlum && !recruiter);
      assert.equal(fill.boxes.includes("first.recruiter"), recruiter);
    }
    if (occasion.id === "follow_up" && hints.hasPriorColdEmail && !TEAM.test(hints.name ?? "") && !RECRUITER.test(hints.role ?? "")) {
      assert.deepEqual(fill.boxes, [hints.hasFollowUp1 ? "follow.final" : "follow.first"]);
    }
  });
});

// ---------------------------------------------------------------- 5. Apply button (open now)

test("5. Apply: a row is offered Apply (Open now) only when it is actually open", async (t) => {
  await cases(t, (r) => {
    const today = "2026-09-24";
    const base = Date.UTC(2026, 8, 24);
    const when = () => (r.chance(0.25) ? null : new Date(base + r.int(-20, 40) * DAY + r.int(0, 23) * 3_600_000));
    const p = {
      opensAt: when(),
      deadlineDate: when(),
      deadlineStatus: r.pick(["confirmed", "rolling", "estimated", null]),
      timingState: r.pick(["open", "upcoming", "closed", "unknown"] as const),
    };
    const placed = postingPlacement(p as Parameters<typeof postingPlacement>[0], today);
    const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
    const opensDay = day(p.opensAt);
    const dueDay = day(p.deadlineDate);

    if (opensDay && opensDay > today) {
      assert.deepEqual(placed && { section: placed.section, kind: placed.kind }, { section: "upcoming", kind: "opens" });
      return;
    }
    if (!placed) {
      assert.ok(!(opensDay === today));
      assert.ok(!(p.deadlineStatus === "rolling" && p.timingState === "open"));
      assert.ok(!(p.deadlineStatus === "confirmed" && dueDay && dueDay >= today));
      return;
    }
    assert.equal(placed.section, "current", "only a future opening is Upcoming here");
    if (placed.kind === "due") {
      assert.equal(p.deadlineStatus, "confirmed");
      assert.ok(dueDay && dueDay >= today, "a passed deadline is never offered Apply");
    }
    if (placed.kind === "opens") assert.equal(opensDay, today);
    if (placed.kind === "undated") assert.ok(placed.rolling && p.timingState === "open");
  });
});

// ---------------------------------------------------------------- 6. Event descriptions

const EVENT_KEYS = {
  Region: ["Europe, Middle East & Africa", "Asia", "AMERICAS"],
  Country: ["France", "Japan", "UNITED STATES"],
  "Line of Business": ["GLOBAL MARKETS", "Global Banking", "Wealth Management"],
  City: ["Paris", "New York", "Tokyo"],
};

test("6. Event descriptions: a field dump reads as one plain line, and prose is left alone", async (t) => {
  await cases(t, (r) => {
    if (r.chance(0.25)) {
      const prose = r.pick([
        "Join us for an evening with our M&A team.",
        "Meet the Restructuring group.  Location: New York office.",
        "Coffee chat\nwith analysts",
      ]);
      assert.equal(cleanEventDescription(prose), prose.replace(/\s+/g, " ").trim());
      return;
    }
    const title = r.pick(["EMEA | Paris | Quantitative Strategies & Data Group | Recruitment Event", "Summer Analyst Info Session"]);
    const kept = Object.entries(EVENT_KEYS).filter(() => r.chance(0.6));
    const parts = [
      r.chance(0.8) ? `~~DATADICT_OPTGROUP_POSTING_LIST_OPP_ID~~:${r.int(1000, 99999)}` : "",
      `Title:${title}`,
      r.chance(0.8) ? `Event Date:${r.int(1, 28)} Sep 2026 05:00 PM CEST` : "",
      ...kept.map(([k, vs]) => `${k}:${r.pick(vs)}`),
    ].filter(Boolean);
    const raw = parts.join(" ") + (r.chance(0.3) ? "..." : "");
    const out = cleanEventDescription(raw) ?? "";
    assert.doesNotMatch(out, /~~|DATADICT|Title:|Event Date:|\bCEST\b/, out);
    assert.ok(!out.includes(title), "the title is on the card already");
    for (const [k] of kept) {
      const v = raw.match(new RegExp(`${k}:([^:]+?)(?= [A-Z][a-z]+( of [A-Z][a-z]+)?:|\\.\\.\\.|$)`))?.[1]?.trim();
      if (v) assert.ok(out.toLowerCase().includes(v.toLowerCase()), `${k} "${v}" missing from "${out}"`);
    }
    for (const w of out.split(/[\s·,]+/)) if (w.replace(/[^A-Za-z]/g, "").length >= 6) assert.notEqual(w, w.toUpperCase(), `still shouting: ${w}`);
  });
});

// ---------------------------------------------------------------- 7. Deck order

test("7. Deck: firms the student added lead, newest first, then the matcher's order", async (t) => {
  await cases(t, (r) => {
    const rows = Array.from({ length: r.int(0, 60) }, (_, i) => ({
      id: `f${i}`,
      source: r.chance(0.3) ? "manual" : "ai_matched",
      createdAt: new Date(Date.UTC(2026, 0, 1) + r.int(0, 300) * DAY + i),
    }));
    const out = orderTopFirms(rows);
    assert.equal(out.length, rows.length);
    assert.deepEqual(new Set(out.map((x) => x.id)), new Set(rows.map((x) => x.id)));
    const firstMatched = out.findIndex((x) => x.source !== "manual");
    if (firstMatched >= 0) assert.ok(out.slice(firstMatched).every((x) => x.source !== "manual"), "every added firm before every matched one");
    for (let i = 1; i < out.length; i++) {
      const [a, b] = [out[i - 1], out[i]];
      if (a.source === "manual" && b.source === "manual") assert.ok(a.createdAt >= b.createdAt);
      if (a.source !== "manual" && b.source !== "manual") assert.ok(a.createdAt <= b.createdAt);
    }
    const newest = rows.filter((x) => x.source === "manual").sort((a, b) => +b.createdAt - +a.createdAt)[0];
    if (newest) assert.equal(out.slice(0, 12)[0].id, newest.id, "the one just added is on the twelve-card deck");
  });
});

// ---------------------------------------------------------------- 8. Email on the firm page's contact rows

test("8. Firm page rows: a found address passes the gate, a typed one shows as typed", async (t) => {
  await cases(t, (r) => {
    const c = {
      email: r.pick([null, "", "  ", "jane.doe@pjt.com", " Sam.Lee@evercore.com "]),
      emailConfidence: r.pick([null, "verified", "catch_all", "predicted", "confirmed", "rejected"]),
      emailDomainRelevant: r.pick([true, false, null]),
      emailSource: r.pick([null, "crustdata", "pattern_inference"]),
      enrichedAt: r.pick([null, new Date(Date.UTC(2026, 8, 1))]),
    };
    const shown = contactEmailToShow(c);
    if (!c.email?.trim()) return assert.equal(shown, null);
    if (c.emailSource || c.enrichedAt) assert.equal(shown, shouldRenderEmail(c) ? c.email.trim() : null);
    else assert.equal(shown, c.email.trim());
  });
});

// ---------------------------------------------------------------- 9. Practice Industry and Sector boxes

test("9. Practice setup: the Sector box asks for a sector in every industry picked", async (t) => {
  await cases(t, (r) => {
    const categories = r.subset(QUIZ_CATEGORIES) as QuizCategory[];
    const specialties: Partial<Record<QuizCategory, string[]>> = {};
    for (const c of categories) specialties[c] = r.subset(QUIZ_SPECIALTIES[c]);
    const needsSector = r.chance(0.7);

    const ind = industryLabel(categories, needsSector);
    const sec = sectorLabel(categories, specialties);
    if (categories.length === 0) {
      assert.equal(ind, needsSector ? "Pick an industry" : "Any industry");
      assert.equal(sec, "Pick an industry first");
      return;
    }
    if (categories.length <= 2) for (const c of categories) assert.ok(ind.includes(CATEGORY_LABELS[c]));
    else assert.ok(ind.endsWith(`+${categories.length - 1} more`));

    if (categories.length === 1) {
      const picked = specialties[categories[0]]!;
      assert.equal(
        sec,
        picked.length === 0
          ? `All ${CATEGORY_LABELS[categories[0]]}`
          : picked.length === 1
            ? picked[0]
            : `${picked.length} sectors`,
      );
      return;
    }
    const segments = sec.split(" · ");
    assert.equal(segments.length, categories.length, "one sector answer per industry");
    categories.forEach((c, i) => {
      assert.ok(segments[i].startsWith(`${CATEGORY_LABELS[c]}: `), segments[i]);
      const picked = specialties[c]!;
      const tail = segments[i].slice(CATEGORY_LABELS[c].length + 2);
      assert.equal(tail, picked.length === 0 ? "All" : picked.length === 1 ? picked[0] : `${picked.length} sectors`);
    });
  });
});
