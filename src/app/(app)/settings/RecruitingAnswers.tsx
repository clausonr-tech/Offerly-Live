"use client";

import { useActionState, useState } from "react";
import { ChevronDown } from "lucide-react";
import { correctCity } from "@/lib/city-spelling";
import {
  ALL_DEEP_QUESTIONS,
  CORE_QUESTIONS,
  UNSURE,
  type OnboardingQuestion,
} from "@/lib/onboarding-questions";
import {
  DATA_ANSWER_KEYS,
  OTHER,
  OTHER_ALLOWED_KEYS,
  otherFieldName,
} from "@/lib/recruiting-answer-keys";
import { SECTOR_TIER_QUESTIONS } from "@/lib/sector-questions";
import type { FirmProgramCategory } from "@/lib/firm-metadata";
import { nicheOptionsFor } from "@/lib/niche-options";
import { saveRecruitingAnswers, type RecruitingState } from "./recruiting-actions";
import SchoolCombobox from "../SchoolCombobox";

/** A combobox question (the country picker): typed, filtered as you go, and
 *  submitted under the question's own key like any text answer. */
function ComboboxAnswer({
  q,
  initial,
  onPick,
}: {
  q: OnboardingQuestion;
  initial: string;
  onPick?: (value: string) => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <div className="mt-3">
      <label htmlFor={q.key} className="sr-only">
        {q.title}
      </label>
      <SchoolCombobox
        name={q.key}
        value={text}
        onChange={(v) => {
          setText(v);
          onPick?.(v);
        }}
        schools={q.options ?? []}
        placeholder={q.placeholder}
        className="h-11 w-full rounded-lg border border-brand-200 bg-white px-3 text-base text-brand-900 placeholder:text-warmgray-500 focus-visible:border-accent-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
      />
    </div>
  );
}

export type AnswerValues = Record<string, string | string[] | null>;

/** Options the wizard builds from data rather than from the question bank -
 *  sectors, tiers, coverage groups, locations. They are the answers firm
 *  matching leans on hardest, so an editor without them would be an editor for
 *  everything except the part that matters. */
export type DataOptions = {
  /** [storedValue, label]. Sectors are the one answer stored as a KEY
   *  ("investment_banking") rather than as its label, and firm matching reads
   *  the key - so the option value and the visible text have to differ here or
   *  saving from this form would quietly break matching. */
  sectors: [string, string][];
  ibTiers: string[];
  peTiers: string[];
  /** Grouped by sector, not flattened: the coverage question should offer the
      groups that belong to the sector the student picked, and a flat list
      offered a private-equity student "Equity Capital Markets". */
  nicheGroups: { group: string; sectors: string[] }[];
  locations: string[];
};

/**
 * One chip. Sized by its grid cell rather than by its own text, so the options
 * line up in even columns instead of a ragged run of different-width pills -
 * "M&A Advisory" and "Financial Institutions (FIG) Coverage" are the same
 * shape now.
 *
 * Long labels WRAP rather than overflow: the cell is a fixed width, so the
 * only alternatives are wrapping or spilling, and a truncated option is an
 * option the student cannot read. overflow-wrap handles the labels with no
 * spaces to break on.
 */
const chip =
  "flex h-full w-full cursor-pointer items-center justify-center rounded-full border px-3 py-1.5 text-center text-xs leading-tight [overflow-wrap:anywhere] transition focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent-500";
/**
 * The selected look, driven by the input's LIVE checked state rather than by a
 * class picked once at render.
 *
 * The chips are uncontrolled (`defaultChecked`), so the highlight used to be
 * computed from the stored answer and then never changed: clicking a chip
 * moved the radio but left the colour exactly where it was. has-[:checked]
 * reads the real state, so the fill follows the click - and with radios the
 * browser clears the previous one for us, which is the behaviour being asked
 * for here.
 */
const chipOn =
  "has-[:checked]:border-accent-500 has-[:checked]:bg-accent-50 has-[:checked]:text-brand-900";
const chipOff = "border-brand-200 text-warmgray-600 hover:border-brand-500 hover:text-brand-900";

/**
 * The stored answer as one line, shown on the collapsed row so the list can be
 * read without opening anything.
 */
function summarise(
  value: string | string[] | null,
  labels?: Record<string, string>,
  unsureLabel?: string,
): string | null {
  const chosen = Array.isArray(value) ? value : value ? [value] : [];
  if (!chosen.length) return null;
  return chosen
    .map((v) => (v === UNSURE ? (unsureLabel ?? "Not sure yet") : (labels?.[v] ?? v)))
    .join(", ");
}

function Field({
  q,
  value,
  labels,
  /** The accordion row carries the question text, so it is not repeated here. */
  headingInRow = false,
  onPick,
  onPickMany,
  followUpValue,
}: {
  q: OnboardingQuestion;
  value: string | string[] | null;
  labels?: Record<string, string>;
  headingInRow?: boolean;
  /** Fired when a chip is chosen, so a later question can depend on it. */
  onPick?: (value: string) => void;
  /** Stored text of q.followUp, which lives outside this question's value. */
  followUpValue?: string;
  /**
   * Every option currently ticked, for multi questions. onPick reports the one
   * chip that was just clicked, which is right for a summary line and wrong
   * for anything that has to know the full answer - like which tier questions
   * to show once a student picks two sectors.
   */
  onPickMany?: (values: string[]) => void;
}) {
  const selected = Array.isArray(value) ? value : value ? [value] : [];
  // Deduplicated: each option is its own key, and a repeated one would collide.
  const options = [...new Set(q.options ?? [])];
  const allowOther = OTHER_ALLOWED_KEYS.includes(q.key);
  /** A saved answer that is not one of the offered chips came from "Other",
      so it reopens as Other with the text already filled in. */
  const storedCustom =
    allowOther && selected.length === 1 && selected[0] !== UNSURE && !options.includes(selected[0])
      ? selected[0]
      : null;
  const [otherOn, setOtherOn] = useState(!!storedCustom);
  /** Only the locations question is a list of places, so it is the only one
      whose typed answer gets spell-corrected. */
  const fixesSpelling = q.key === "targetLocations";

  /** Settle the typed answer: fix its spelling, and tell the row about it. */
  const commit = (input: HTMLInputElement) => {
    const fixed = fixesSpelling ? correctCity(input.value) : input.value.trim();
    if (fixed !== input.value) input.value = fixed;
    onPick?.(fixed);
  };
  const withUnsure = [
    ...options,
    ...(allowOther ? [OTHER] : []),
    ...(q.unsureLabel ? [UNSURE] : []),
  ];

  return (
    <fieldset className={headingInRow ? "" : "border-t border-brand-100 pt-4"}>
      <legend className="sr-only">{q.title}</legend>
      {!headingInRow && <p className="text-sm font-semibold text-brand-900">{q.title}</p>}
      {q.subtitle && <p className="mt-1 text-xs leading-relaxed text-warmgray-600">{q.subtitle}</p>}

      {q.kind === "combobox" ? (
        <ComboboxAnswer q={q} initial={typeof value === "string" ? value : ""} onPick={onPick} />
      ) : q.kind === "text" || q.kind === "longtext" ? (
        <>
          <label htmlFor={q.key} className="sr-only">
            {q.title}
          </label>
          {q.kind === "longtext" ? (
            <textarea
              id={q.key}
              name={q.key}
              rows={3}
              maxLength={q.maxLength}
              defaultValue={typeof value === "string" ? value : ""}
              placeholder={q.placeholder}
              className="mt-3 w-full rounded-lg border border-brand-200 bg-white px-3 py-2.5 text-base text-brand-900 placeholder:text-warmgray-500 focus-visible:border-accent-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
            />
          ) : (
            <input
              id={q.key}
              name={q.key}
              maxLength={q.maxLength}
              defaultValue={typeof value === "string" ? value : ""}
              placeholder={q.placeholder}
              className="mt-3 h-11 w-full rounded-lg border border-brand-200 bg-white px-3 text-base text-brand-900 placeholder:text-warmgray-500 focus-visible:border-accent-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
            />
          )}
        </>
      ) : (
        // auto-rows-fr equalises the row heights, so a two-line option does
        // not leave its neighbours short - every chip ends up the same box.
        <div className="mt-3 grid auto-rows-fr grid-cols-2 gap-2 sm:grid-cols-3">
          {withUnsure.map((opt) => {
            const on = opt === OTHER ? !!storedCustom : selected.includes(opt);
            const label =
              opt === UNSURE
                ? (q.unsureLabel ?? "Not sure yet")
                : opt === OTHER
                  ? "Other"
                  : (labels?.[opt] ?? opt);
            const radio = (
                <input
                  type={q.kind === "multi" ? "checkbox" : "radio"}
                  name={q.key}
                  value={opt}
                  defaultChecked={on}
                  onChange={(e) => {
                    setOtherOn(opt === OTHER);
                    // The summary shows the typed text once there is one; until
                    // then the sentinel would read as "__other__".
                    onPick?.(opt === OTHER ? (storedCustom ?? "") : opt);
                    // Read back off the form rather than tracking a parallel
                    // copy in state: these inputs are uncontrolled, so the DOM
                    // is the one place that always agrees with what is ticked.
                    const form = e.currentTarget.form;
                    if (form && q.kind === "multi") {
                      onPickMany?.(
                        Array.from(
                          form.querySelectorAll<HTMLInputElement>(
                            `input[name="${q.key}"]:checked`,
                          ),
                        ).map((i) => i.value),
                      );
                    }
                  }}
                  className="sr-only"
                />
              );

              // The chosen "Other" chip IS the text field - you type in the
              // bubble rather than in a box underneath it. A <div>, not a
              // <label>: a label wrapping a text input hands clicks to the
              // first control inside it, which would pull focus off the very
              // field being clicked into.
              if (opt === OTHER && otherOn) {
                return (
                  <div key={opt} className={`${chip} ${chipOff} ${chipOn}`}>
                    {radio}
                    <input
                      type="text"
                      // Remounts when the SAVED value changes, so the field
                      // picks up what was stored. defaultValue is read once at
                      // mount, so without this the box would still show the
                      // pre-save text after a round trip.
                      key={storedCustom ?? ""}
                      name={otherFieldName(q.key)}
                      defaultValue={storedCustom ?? ""}
                      placeholder="Type a city"
                      maxLength={80}
                      autoFocus
                      onInput={(e) => onPick?.(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        // A text input inside a form submits it on Enter, and
                        // React clears uncontrolled fields once a form action
                        // finishes - so Enter emptied the box the student had
                        // just typed into. Enter here means "I'm done with this
                        // answer", not "save the whole form"; that is what the
                        // Save button is for.
                        e.preventDefault();
                        commit(e.currentTarget);
                        e.currentTarget.blur();
                      }}
                      onBlur={(e) => commit(e.currentTarget)}
                      className="w-full bg-transparent text-center text-xs text-brand-900 outline-none placeholder:text-warmgray-500"
                    />
                  </div>
                );
              }

              return (
                <label key={opt} className={`${chip} ${chipOff} ${chipOn}`}>
                  {radio}
                  {label}
                </label>
              );
          })}
        </div>
      )}

      {/* The typed half of a question whose first half is a choice - same
          shape as the wizard's, so a student editing later sees what they
          answered first. Saved under its own key; recruiting-actions walks
          follow-ups explicitly for exactly that reason. */}
      {q.followUp && (
        <label className="mt-3 block">
          <span className="text-sm text-warmgray-600">{q.followUp.label}</span>
          <input
            type="text"
            name={q.followUp.key}
            defaultValue={followUpValue ?? ""}
            maxLength={q.followUp.maxLength}
            placeholder={q.followUp.placeholder}
            className="ui-round-md mt-1 w-full border border-brand-200 bg-white px-3 py-2 text-sm text-brand-900 placeholder:text-warmgray-300 focus:border-accent-400 focus:outline-none"
          />
        </label>
      )}
    </fieldset>
  );
}

/**
 * The onboarding answers, editable after the fact.
 *
 * Rendered from the same question bank the wizard uses, so this is not a
 * second copy of the questions that can fall out of step with the first - a
 * question added to the bank shows up here automatically.
 */
export default function RecruitingAnswers({
  values,
  options,
  defaultOpen = false,
}: {
  values: AnswerValues;
  options: DataOptions;
  /** Start expanded - on the Interests tab this editor is the page, not a footnote. */
  defaultOpen?: boolean;
}) {
  const [state, formAction, pending] = useActionState<RecruitingState, FormData>(
    saveRecruitingAnswers,
    undefined,
  );
  const [open, setOpen] = useState(defaultOpen);
  /** Which question's answers are showing. One at a time, so the box stays
      short - the whole point of the list is that thirteen questions with every
      option visible ran to several screens. */
  const [openKey, setOpenKey] = useState<string | null>(null);

  /**
   * The sector currently chosen in the FORM, not the one last saved - later
   * questions have to follow the chip the student just clicked, not the answer
   * from the last save.
   */
  const storedSectors = Array.isArray(values.preferredCategories)
    ? (values.preferredCategories as string[])
    : values.preferredCategories
      ? [values.preferredCategories as string]
      : [];
  const [sectors, setSectors] = useState<string[]>(storedSectors);
  /**
   * Chips picked since the page loaded, so the collapsed rows show what is
   * actually selected rather than what was last saved. Without this the header
   * row read "Private Equity" while the questions underneath had already
   * switched to investment banking - the summary and the form disagreeing
   * about the same answer.
   */
  const [picked, setPicked] = useState<Record<string, string>>({});

  const titles: Record<string, string> = {
    preferredCategories: "Which sectors are you recruiting for?",
    ibTierPreferences: "What type of investment bank?",
    peTierPreferences: "What type of fund?",
    nicheInterests: "Any particular product or coverage group?",
    targetLocations: "Where do you want to work?",
  };
  const sectorLabelsPicked = sectors
    .map((s) => options.sectors.find(([v]) => v === s)?.[1])
    .filter((l): l is string => Boolean(l));
  /** The coverage groups behind every sector the student picked, deduped -
   *  see nicheOptionsFor. */
  const nicheOptions = nicheOptionsFor(options.nicheGroups, sectorLabelsPicked);
  /** Which tier question this sector asks, if any. Investment banking asks
      about bank type, private equity about fund type, and the rest ask
      neither - the same mapping onboarding already uses. */
  const tierKeys = new Set(
    sectors
      .map((s) => SECTOR_TIER_QUESTIONS[s as FirmProgramCategory]?.key)
      .filter((k): k is "ibTierPreferences" | "peTierPreferences" => Boolean(k)),
  );

  const optionsFor: Record<string, string[]> = {
    preferredCategories: options.sectors.map(([v]) => v),
    ibTierPreferences: options.ibTiers,
    peTierPreferences: options.peTiers,
    nicheInterests: nicheOptions,
    targetLocations: options.locations,
  };

  /**
   * Questions that no longer apply are left OUT rather than hidden.
   *
   * That is the opposite of how the accordion hides collapsed questions, and
   * deliberately so: a hidden input still submits, which would preserve a bank
   * tier for a student who has moved to private equity. Dropping it clears the
   * stored answer on the next save, which is what "no longer relevant" should
   * mean. Anything still relevant stays mounted and keeps its value.
   */
  const relevant = (key: string): boolean => {
    // Both tier questions when both sectors are picked. This gate is not
    // cosmetic: a question that is not rendered submits nothing, and the save
    // action reads these keys with getAll, so an unmounted question saves an
    // empty array over whatever was there. Keyed on a single sector, adding
    // private equity to an existing banking answer silently erased the bank
    // tiers on the next save.
    if (key === "ibTierPreferences" || key === "peTierPreferences") return tierKeys.has(key);
    if (key === "nicheInterests") return nicheOptions.length > 0;
    return true;
  };
  // Built from the shared key list, so this form and the action that saves it
  // can never disagree about which answers exist.
  const dataQuestions: OnboardingQuestion[] = DATA_ANSWER_KEYS.map((key) => ({
    key,
    section: "core" as const,
    // Multi, because every one of these columns is an array.
    //
    // That is the rule: a `.array()` column takes as many answers as the
    // student has, a scalar column takes one. All five DATA_ANSWER_KEYS -
    // sectors, both tier questions, coverage groups and locations - are
    // arrays, and onboarding already asks them as multi ("Pick as many as
    // apply", "Pick every type you'd genuinely consider").
    //
    // This form used to force them to "single", which made it a quiet
    // narrowing of answers the student had already given: someone who chose
    // Investment Banking AND Private Equity during onboarding, then opened
    // this form and touched anything, saved one sector back over two. The
    // matcher intersects on these lists, so the effect was a shrinking
    // shortlist with no visible cause.
    //
    // The action was always ready for this - it reads these keys with
    // formData.getAll - so only the input type was wrong.
    kind: "multi" as const,
    title: titles[key],
    options: optionsFor[key],
    unsureLabel: key === "preferredCategories" ? undefined : "Not sure yet",
  }))
    .filter((q) => relevant(q.key))
    .filter((q) => q.options.length);

  const sectorLabels = Object.fromEntries(options.sectors);

  /**
   * Degree level leads, here as well as in the wizard.
   *
   * It decides which programmes exist for this student at all - a Summer
   * Analyst seat is undergraduates only, a Summer Associate seat is MBA and
   * advanced master's - so every answer below it is read in its light, and a
   * student correcting it is the one edit that changes what the whole list
   * means.
   *
   * It has to be lifted out explicitly because this page builds its order from
   * the data-driven questions first and the question bank second, which is the
   * opposite of the wizard's order. Leaving that alone put degree level fifth,
   * behind sectors and tiers, so the two screens disagreed about which
   * question came first.
   */
  const ordered = [...dataQuestions, ...CORE_QUESTIONS, ...ALL_DEEP_QUESTIONS];
  const questions = [
    ...ordered.filter((q) => q.key === "degreeLevel"),
    ...ordered.filter((q) => q.key !== "degreeLevel"),
  ].filter((q) => q.kind !== "multi" || q.options?.length);

  return (
    <section className="rounded-xl border border-brand-100 p-5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="recruiting-answers"
        className="flex w-full items-center justify-between gap-4 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
      >
        <span>
          <span className="block text-sm font-semibold text-brand-900">Recruiting answers</span>
          <span className="mt-1 block text-xs leading-relaxed text-warmgray-600">
            What you told us during onboarding. Changing these changes your firm matches.
          </span>
        </span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={`shrink-0 text-warmgray-600 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <form id="recruiting-answers" action={formAction} className="mt-5 space-y-5">
          {/* Questions as a list, answers revealed one at a time.
              
              Every Field stays MOUNTED and is hidden with CSS rather than
              unmounted. A question absent from the DOM submits nothing, and
              the save action reads a missing key as "cleared" - so unmounting
              the collapsed ones would wipe every answer the student did not
              happen to have open. Hidden inputs still submit; disabled ones
              would not, which is why this hides rather than disables. */}
          <div className="divide-y divide-brand-100 overflow-hidden rounded-lg border border-brand-100">
            {questions.map((q) => {
              const isOpen = openKey === q.key;
              const answer = summarise(
                picked[q.key] ?? values[q.key] ?? null,
                q.key === "preferredCategories" ? sectorLabels : undefined,
                q.unsureLabel,
              );
              return (
                <div key={q.key}>
                  <button
                    type="button"
                    onClick={() => setOpenKey(isOpen ? null : q.key)}
                    aria-expanded={isOpen}
                    aria-controls={`answers-${q.key}`}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-500"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-brand-900">{q.title}</span>
                      <span
                        className={`mt-0.5 block truncate text-xs ${
                          answer ? "text-warmgray-600" : "text-warmgray-500 italic"
                        }`}
                      >
                        {answer ?? "Not answered yet"}
                      </span>
                    </span>
                    <ChevronDown
                      size={15}
                      aria-hidden="true"
                      className={`shrink-0 text-warmgray-500 transition-transform motion-reduce:transition-none ${
                        isOpen ? "rotate-180" : ""
                      }`}
                    />
                  </button>

                  <div id={`answers-${q.key}`} hidden={!isOpen} className="px-4 pb-4">
                    <Field
                      q={q}
                      value={values[q.key] ?? null}
                      labels={q.key === "preferredCategories" ? sectorLabels : undefined}
                      headingInRow
                      followUpValue={
                        q.followUp && typeof values[q.followUp.key] === "string"
                          ? (values[q.followUp.key] as string)
                          : undefined
                      }
                      onPick={(v) => {
                        setPicked((prev) => ({ ...prev, [q.key]: v }));
                      }}
                      onPickMany={(vs) => {
                        if (q.key === "preferredCategories") setSectors(vs);
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-3 border-t border-brand-100 pt-4">
            <button
              type="submit"
              disabled={pending}
              aria-busy={pending}
              className="inline-flex h-11 items-center rounded-full bg-brand-900 px-5 text-sm font-medium text-white transition hover:bg-brand-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:cursor-not-allowed disabled:opacity-80"
            >
              {pending ? "Saving..." : "Save answers"}
            </button>
            {state?.saved && (
              <p role="status" className="text-sm text-success-700">
                Saved.
              </p>
            )}
            {state?.error && (
              <p role="alert" className="text-sm text-error-600">
                {state.error}
              </p>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
