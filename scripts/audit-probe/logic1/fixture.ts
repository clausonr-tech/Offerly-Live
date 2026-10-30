// Shared fixture for the LOGIC-1 guard audit probes. Read-only on src/.
import type { DraftPromptInput } from "../../../src/lib/draft-prompt";
import type { ReviewProblem } from "../../../src/lib/draft-review";

export const SIGNATURE = "Best,\nAlex Rivera\nUniversity of Pennsylvania ’29\n(555) 010-1234";

export const INPUT: DraftPromptInput = {
  studentName: "Alex Rivera",
  studentSchool: "University of Pennsylvania",
  studentGradYear: 2029,
  studentPhone: "15550101234",
  contactName: "Rachel Stein",
  contactFirm: "Anchorage Capital",
  contactRole: "Vice President",
  type: "cold_referral",
  alsoTypes: ["cold_after_meeting"],
  boxIds: ["first.referred", "first.met"],
  now: new Date("2026-09-20T12:00:00"),
  brief: {
    fieldAnswers: [
      { prompt: "Referred by", value: "Jeff Moreno" },
      { prompt: "Where and when they met", value: "the WITG x WUEC panel" },
    ],
  },
};

export const p = (o: Partial<ReviewProblem>): ReviewProblem => ({
  kind: "private",
  quote: "",
  fix: "removed it",
  needsStudent: false,
  ...o,
});

export const show = (label: string, r: { ok: boolean } & Record<string, unknown>) =>
  console.log(`${label}\n    -> ${r.ok ? `ACCEPTED${r.note ? ` (note: ${String(r.note).slice(0, 60)}…)` : ""}` : `REJECTED: ${r.reason}`}`);
