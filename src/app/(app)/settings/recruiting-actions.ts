"use server";

import { blockedInForm } from "@/lib/content-limits";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { getCurrentUserId } from "@/lib/current-user";
import { DATA_ANSWER_KEYS, OTHER, otherFieldName } from "@/lib/recruiting-answer-keys";
import { correctCity } from "@/lib/city-spelling";
import { isValidGpa } from "@/lib/gpa";
import { parseInternshipYearAnswer } from "@/lib/internship-year";
import { canonicalCountry } from "@/lib/countries";
import { MATCHED_FIRMS } from "@/lib/match-config";
import { FIRM_PROGRAM_CATEGORIES } from "@/lib/validation";
import { matchTopFirmsForUser, pruneUnmatchedTopFirms } from "@/lib/match-top-firms";
import {
  ALL_DEEP_QUESTIONS,
  ARRAY_KEYS,
  CORE_QUESTIONS,
  SINGLE_VALUE_KEYS,
  UNSURE,
} from "@/lib/onboarding-questions";

export type RecruitingState = { error?: string; saved?: boolean } | undefined;

const SINGLE = new Set<string>(SINGLE_VALUE_KEYS);
const ARRAYS = new Set<string>([...ARRAY_KEYS, ...DATA_ANSWER_KEYS]);

/**
 * The ceilings the wizard already applies, applied here too.
 *
 * The onboarding path validates these same columns with onboardingSchema
 * (lib/validation): 50-120 characters per field, 10-60 items per answer, and
 * preferredCategories restricted to FIRM_PROGRAM_CATEGORIES. This path is
 * driven off the question bank instead, so it has to carry the same limits
 * itself - without them the only bound is the 4.4mb server-action body
 * (next.config.ts), and these columns are read ACROSS users: the student
 * directory loads every member's sectors, niches and locations, the activity
 * feed prints major in a headline, and the firms' Student matching page builds
 * its checkboxes from every sharing student's major and target locations. One
 * student's unbounded answer is therefore everyone else's page weight.
 *
 * Slightly above the wizard's own numbers so an answer the wizard accepted is
 * never rejected on a later edit.
 */
const ITEM_MAX = 120;
const ITEMS_MAX = 60;
const SINGLE_MAX = 200;

/**
 * Saves edits to the onboarding answers.
 *
 * Driven off the same question bank the wizard renders, so a question added
 * there becomes editable here without anyone remembering to update a second
 * list - the two cannot drift apart.
 */
export async function saveRecruitingAnswers(
  _prev: RecruitingState,
  formData: FormData,
): Promise<RecruitingState> {
  const blocked = blockedInForm(formData, {});
  if (blocked) return { error: blocked };
  const userId = await getCurrentUserId();
  const updates: Record<string, unknown> = {};
  const unsure: string[] = [];

  // The data-driven answers are not in the question bank, so they have to be
  // walked explicitly alongside it - iterating the bank alone is exactly how
  // they came to be editable but unsaveable.
  const keys = [
    ...DATA_ANSWER_KEYS.map((key) => ({ key, multi: true })),
    ...[...CORE_QUESTIONS, ...ALL_DEEP_QUESTIONS].map((q) => ({ key: q.key, multi: false })),
    // A follow-up is rendered inside another question but saved under its own
    // key, so it has to be walked explicitly here too. Omitting it is the
    // same bug the comment above describes: editable on screen, silently
    // discarded on save.
    ...[...CORE_QUESTIONS, ...ALL_DEEP_QUESTIONS]
      .filter((q) => q.followUp)
      .map((q) => ({ key: q.followUp!.key, multi: false })),
  ];

  for (const q of keys) {
    if (!SINGLE.has(q.key) && !ARRAYS.has(q.key)) continue;

    if (ARRAYS.has(q.key)) {
      const raw = formData.getAll(q.key).map(String);
      if (raw.includes(UNSURE)) unsure.push(q.key);
      const picked = raw.filter((v) => v !== UNSURE && v !== OTHER);

      // "Other" is only ever a placeholder for what the student typed - the
      // sentinel itself must never reach the column, or matching would compare
      // firms against the literal string "__other__".
      if (raw.includes(OTHER)) {
        const typed = String(formData.get(otherFieldName(q.key)) ?? "").trim();
        // Corrected here as well as in the field: the client fix is a
        // courtesy, and a server action's input is a public entry point.
        const value = q.key === "targetLocations" ? correctCity(typed) : typed;
        if (value) picked.push(value);
      }

      if (picked.length > ITEMS_MAX || picked.some((v) => v.length > ITEM_MAX)) {
        return { error: "That's more than this answer can hold. Shorten it and save again." };
      }
      // A sector that is not one of the real ones would be stored and then fed
      // to a pg-enum filter by matching and Discovery, which throws. Only the
      // known categories are kept.
      const bounded =
        q.key === "preferredCategories"
          ? picked.filter((v) => (FIRM_PROGRAM_CATEGORIES as readonly string[]).includes(v))
          : picked;

      updates[q.key] = bounded.length ? bounded : null;
    } else {
      const raw = String(formData.get(q.key) ?? "").trim();
      if (raw.length > SINGLE_MAX) {
        return { error: "That answer is too long. Shorten it and save again." };
      }
      if (raw === UNSURE) {
        unsure.push(q.key);
        updates[q.key] = null;
      } else {
        updates[q.key] = raw || null;
      }
    }
  }

  // Rendered from CORE_QUESTIONS but not a plain column (the answer is
  // "Summer 2028", the column an integer), so the loop above skips it - which
  // is how an edited target summer used to be silently dropped. "Not sure"
  // clears it, so internshipYearFor falls back to gradYear - 1.
  const internship = String(formData.get("targetInternshipYear") ?? "").trim();
  if (internship === UNSURE) {
    unsure.push("targetInternshipYear");
    updates.targetInternshipYear = null;
  } else {
    const year = parseInternshipYearAnswer(internship);
    if (year) updates.targetInternshipYear = year;
  }

  // A recorded "not sure" is real signal - it tells the matcher to favour
  // broad exposure - so it is preserved here rather than collapsing to null.
  updates.onboardingUnsure = unsure.length ? unsure : null;

  if (typeof updates.homeCountry === "string") {
    const country = canonicalCountry(updates.homeCountry);
    if (!country) return { error: "Pick your country from the list, or leave it blank." };
    updates.homeCountry = country;
  }

  if (typeof updates.gpaBand === "string" && !isValidGpa(updates.gpaBand)) {
    return { error: "Enter your GPA as a number, like 3.72, or leave it blank." };
  }

  const gradYear = String(formData.get("gradYear") ?? "").trim();
  if (/^\d{4}$/.test(gradYear)) updates.gradYear = Number(gradYear);

  try {
    const db = await getDb();

    // Whether the answers that DRIVE matching actually moved. Compared against
    // what is stored rather than assumed from the form: re-saving the page
    // without touching a chip should not invalidate a match.
    const before = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        preferredCategories: true,
        ibTierPreferences: true,
        peTierPreferences: true,
        nicheInterests: true,
        targetLocations: true,
      },
    });
    const sameList = (a?: string[] | null, b?: unknown) =>
      JSON.stringify([...(a ?? [])].sort()) ===
      JSON.stringify([...((b as string[] | undefined) ?? [])].sort());
    const matchInputsChanged =
      !!before &&
      DATA_ANSWER_KEYS.some(
        (key) =>
          key in updates &&
          !sameList(before[key as keyof typeof before] as string[] | null, updates[key]),
      );

    await db.update(users).set(updates).where(eq(users.id, userId));

    // Reconsider the list the answers drive, or the two quietly disagree from
    // here on. Only runs when the inputs moved, so an unrelated edit (GPA, a
    // background answer) never disturbs a good match.
    //
    // Both halves, in order: drop the firms the new answers exclude, then fill
    // the gap that leaves. This used to do the first half here and arrange the
    // second by clearing topFirmsMatchedAt, which re-opened the matcher that
    // Discovery ran on render. Discovery no longer matches on render - that
    // was the page-load loop - so the re-match has to happen here, on the edit
    // that caused it, the same way onboarding matches on the answers it saves.
    if (matchInputsChanged) {
      await pruneUnmatchedTopFirms(userId);
      const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
      if (updated) {
        try {
          await matchTopFirmsForUser(updated, MATCHED_FIRMS);
        } catch (err) {
          // Saving the answers is the thing the student asked for; matching is
          // a consequence. A failure here must not lose their edit.
          console.error("[settings] re-matching top firms failed", err);
        }
      }
    }
  } catch (err) {
    console.error("[settings] saving recruiting answers failed", err);
    return { error: "Couldn't save that. Try again." };
  }

  revalidatePath("/profile/interests");
  revalidatePath("/dashboard");
  revalidatePath("/discovery");
  return { saved: true };
}
