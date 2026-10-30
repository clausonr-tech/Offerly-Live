"use client";

import { useActionState, useMemo, useState } from "react";
import { completeOnboarding, type ActionState } from "./actions";
import type { FirmProgramCategory } from "@/lib/firm-metadata";
import { TARGET_LOCATIONS } from "@/lib/locations";
import { SECTOR_TIER_QUESTIONS, NICHE_QUESTION_TITLES } from "@/lib/sector-questions";
import {
  CORE_QUESTIONS,
  QUESTION_SECTIONS,
  UNSURE,
  type OnboardingQuestion,
} from "@/lib/onboarding-questions";
import QuestionField from "./QuestionField";
import FirmSharingFields from "@/components/FirmSharingFields";

type Field = { question: OnboardingQuestion; options: string[] };

/**
 * One screen of the wizard. Most hold one question; related ones share a
 * screen - graduation year and target summer, a sector's bank type and its
 * coverage group, the optional details - because asked one per page they read
 * as unrelated questions and made the wizard twice as long as its content.
 */
type Step = {
  id: string;
  phase: "core" | "deep";
  fields: Field[];
  /** Heading for a multi-question screen. A one-question screen uses the question's own title. */
  title?: string;
  subtitle?: string;
  eyebrow?: string;
};

const single = (phase: Step["phase"], question: OnboardingQuestion, options: string[]): Step => ({
  id: question.key,
  phase,
  fields: [{ question, options }],
});

export default function OnboardingWizard({
  sectorOptions,
  nicheGroups,
}: {
  sectorOptions: [FirmProgramCategory, string][];
  nicheGroups: { group: string; sectors: string[] }[];
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    completeOnboarding,
    undefined,
  );

  const [stepIndex, setStepIndex] = useState(0);
  // One flat answer map keyed by question key; every answer is an array so
  // single-select, multi-select and text share one code path.
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [unsure, setUnsure] = useState<Record<string, boolean>>({});
  const [wantsDeep, setWantsDeep] = useState<boolean | null>(null);
  const [touched, setTouched] = useState(false);
  // Whether the target summer on screen is our gradYear - 1 suggestion rather
  // than the student's own pick - see toggle.
  const [summerSuggested, setSummerSuggested] = useState(false);
  // The last step, after every path through the questions: the terms, then the
  // optional firm-sharing question. Both endings ("Finish" and the gate's
  // "Skip for now") land here instead of submitting straight away.
  const [finishing, setFinishing] = useState(false);

  const categories = answers.preferredCategories ?? [];
  const categoryValues = useMemo(
    () =>
      categories
        .map((label) => sectorOptions.find(([, l]) => l === label)?.[0])
        .filter((v): v is FirmProgramCategory => Boolean(v)),
    [categories, sectorOptions],
  );

  // Sector + its follow-ups are computed from earlier answers, so the wizard
  // is exactly as long as it needs to be for this student.
  const sectorSteps: Step[] = useMemo(() => {
    const sectorStep = single(
      "core",
      {
        key: "preferredCategories",
        section: "core",
        kind: "multi",
        required: true,
        title: "What sector of finance are you trying to recruit for?",
        subtitle:
          "Pick as many as apply - casting a wide net early is normal, and you can change this any time.",
      },
      sectorOptions.map(([, label]) => label),
    );

    // One screen per sector: its tier question (banking and PE only) and its
    // coverage-group question together, since both narrow the same thing.
    const followUps: Step[] = categories.flatMap((categoryLabel) => {
      const categoryValue = sectorOptions.find(([, l]) => l === categoryLabel)?.[0];
      const fields: Field[] = [];

      const tier = categoryValue ? SECTOR_TIER_QUESTIONS[categoryValue] : undefined;
      if (tier) {
        fields.push({
          options: tier.options,
          question: {
            key: tier.key,
            section: "core",
            kind: "multi",
            title: tier.title,
            subtitle: tier.subtitle,
            unsureLabel: "I don't know the difference yet",
          },
        });
      }

      const group = nicheGroups.find((g) => g.group === categoryLabel);
      if (group?.sectors.length) {
        fields.push({
          options: group.sectors,
          question: {
            // Scoped to the sector, not the bare field name. A student picking
            // two sectors gets two of these questions back to back, and with a
            // shared key they shared one answer slot: "I'm not sure yet" on the
            // first came up already selected on the second, and chips picked
            // under PE showed as picked under IB. The submitted field is still
            // `nicheInterests` - see fieldNameFor.
            key: `nicheInterests:${categoryValue ?? categoryLabel}`,
            section: "core",
            kind: "multi",
            title:
              (categoryValue && NICHE_QUESTION_TITLES[categoryValue]) ||
              `What area of ${categoryLabel} are you looking to recruit for?`,
            subtitle: "Most people don't know this yet. That's a fine answer.",
            unsureLabel: "I'm not sure yet",
          },
        });
      }

      if (fields.length === 0) return [];
      return [
        {
          id: `sector:${categoryValue ?? categoryLabel}`,
          phase: "core" as const,
          fields,
          ...(fields.length > 1
            ? {
                title: categoryLabel,
                subtitle: "Two quick ones about what you're after here. Not knowing yet is a fine answer to both.",
              }
            : {}),
        },
      ];
    });

    return [sectorStep, ...followUps];
  }, [categories, sectorOptions, nicheGroups]);

  const coreSteps: Step[] = useMemo(() => {
    const q = (key: string) => CORE_QUESTIONS.find((c) => c.key === key)!;
    const locations = q("targetLocations");
    return [
      {
        id: "degree",
        phase: "core",
        title: "Your degree",
        fields: [
          { question: q("degreeLevel"), options: q("degreeLevel").options ?? [] },
          { question: q("gpaBand"), options: [] },
        ],
      },
      {
        id: "timeline",
        phase: "core",
        title: "When are you recruiting?",
        fields: [
          { question: q("gradYear"), options: q("gradYear").options ?? [] },
          { question: q("targetInternshipYear"), options: q("targetInternshipYear").options ?? [] },
        ],
      },
      ...sectorSteps,
      single("core", locations, [...TARGET_LOCATIONS]),
    ];
  }, [sectorSteps]);

  // Each section is one screen.
  const deepSteps: Step[] = useMemo(
    () =>
      QUESTION_SECTIONS.map((s) => ({
        id: s.id,
        phase: "deep" as const,
        title: s.label,
        subtitle: s.blurb,
        eyebrow: "Optional",
        fields: s.questions
          .filter((q) => !q.showIf || q.showIf(categoryValues))
          .map((q) => ({ question: q, options: q.options ?? [] })),
      })).filter((s) => s.fields.length > 0),
    [categoryValues],
  );
  const deepQuestionCount = deepSteps.reduce((n, s) => n + s.fields.length, 0);

  const steps = wantsDeep ? [...coreSteps, ...deepSteps] : coreSteps;
  const atGate = wantsDeep === null && stepIndex === coreSteps.length;
  const clamped = Math.min(stepIndex, steps.length - 1);
  const current = steps[clamped];
  const isFirst = clamped === 0 && !atGate;
  const isLastOverall = wantsDeep === true && stepIndex === steps.length - 1;

  const val = (k: string) => answers[k] ?? [];
  const isUnsure = (k: string) => Boolean(unsure[k]);

  function toggle(q: OnboardingQuestion, option: string) {
    setUnsure((u) => ({ ...u, [q.key]: false }));
    if (q.key === "targetInternshipYear") setSummerSuggested(false);
    const cur = answers[q.key] ?? [];
    if (q.kind !== "single") {
      setAnswers((prev) => ({
        ...prev,
        [q.key]: cur.includes(option) ? cur.filter((v) => v !== option) : [...cur, option],
      }));
      return;
    }
    const picked = cur[0] === option ? [] : [option];
    const next: Record<string, string[]> = { [q.key]: picked };

    // Graduation year and target summer share a screen, and for most students
    // the summer is the one before their final year. Filled in as a suggestion
    // they can see and change - and only while they have not picked a summer
    // themselves, so it never overwrites their own answer.
    if (q.key === "gradYear") {
      const ownSummer = !summerSuggested && ((answers.targetInternshipYear ?? []).length > 0 || unsure.targetInternshipYear);
      if (!ownSummer) {
        const summer = picked[0] ? `Summer ${Number(picked[0]) - 1}` : "";
        const offered = CORE_QUESTIONS.find((c) => c.key === "targetInternshipYear")?.options ?? [];
        const suggest = offered.includes(summer);
        next.targetInternshipYear = suggest ? [summer] : [];
        setSummerSuggested(suggest);
      }
    }
    setAnswers((prev) => ({ ...prev, ...next }));
  }

  function setText(q: OnboardingQuestion, v: string) {
    setUnsure((u) => ({ ...u, [q.key]: false }));
    setAnswers((prev) => ({ ...prev, [q.key]: v ? [v] : [] }));
  }

  function toggleUnsure(q: OnboardingQuestion) {
    if (q.key === "targetInternshipYear") setSummerSuggested(false);
    setUnsure((u) => {
      const next = !u[q.key];
      if (next) setAnswers((prev) => ({ ...prev, [q.key]: [] }));
      return { ...u, [q.key]: next };
    });
  }

  // "Not sure yet" is a recorded answer, so it satisfies a required question.
  // Without this, adding the escape hatch to recruitingStage/gradYear would
  // let a student pick it and then be blocked with no way forward.
  const answered = (q: OnboardingQuestion) => val(q.key).length > 0 || isUnsure(q.key);
  const fields = current?.fields ?? [];
  const hasAnswer = fields.some((f) => answered(f.question));
  const canAdvance = fields.every((f) => !f.question.required || answered(f.question));
  const anyRequired = fields.some((f) => f.question.required);

  if (finishing) {
    return (
      <form action={formAction} className="w-full max-w-lg">
        <HiddenAnswers answers={answers} unsure={unsure} sectorOptions={sectorOptions} />
        <p className="label-eyebrow text-xs text-accent-500">Last step</p>
        <h1 className="mt-3 text-2xl font-normal text-brand-900">Before you finish</h1>
        <p className="mt-2 text-sm leading-relaxed text-warmgray-500">
          One required agreement, and one optional choice about firms.
        </p>

        <label className="mt-6 flex items-start gap-3 border border-brand-100 bg-white px-4 py-3.5">
          <input
            type="checkbox"
            name="acceptTerms"
            required
            className="mt-1 h-4 w-4 shrink-0 accent-[#0b1526]"
          />
          <span className="text-sm text-brand-900">
            I agree to Offerly&rsquo;s{" "}
            <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              Terms of Service
            </a>{" "}
            and{" "}
            <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              Privacy Policy
            </a>
            .
          </span>
        </label>

        <div className="mt-3">
          <FirmSharingFields />
        </div>

        {state?.error && <p className="mt-3 text-sm text-error-600">{state.error}</p>}

        <div className="mt-8 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setFinishing(false)}
            className="px-4 py-2 text-base font-semibold text-brand-900 hover:text-brand-900"
          >
            ← Back
          </button>
          <button
            type="submit"
            disabled={pending}
            className="bg-accent-500 px-6 py-2.5 text-sm font-semibold text-white shadow-card hover:bg-accent-400 disabled:opacity-60"
          >
            {pending ? "Saving..." : "Finish"}
          </button>
        </div>
      </form>
    );
  }

  // Gate screen between the required core and the optional deep dive.
  if (atGate) {
    return (
      <form action={formAction} className="w-full max-w-lg">
        <HiddenAnswers answers={answers} unsure={unsure} sectorOptions={sectorOptions} />
        <p className="label-eyebrow text-xs text-accent-500">Core questions done</p>
        <h1 className="mt-3 text-2xl font-normal text-brand-900">
          Want to sharpen your matches?
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-warmgray-500">
          You have enough for us to build your firm list right now. There&rsquo;s one more page
          of {deepQuestionCount} optional questions - skip any of them - and they&rsquo;re what
          turn a generic list into one that actually reflects you. You can answer them any time
          from your profile.
        </p>
        <div className="mt-8 flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              setWantsDeep(true);
              setStepIndex(coreSteps.length);
            }}
            className="bg-accent-500 px-5 py-2.5 text-sm font-semibold text-white shadow-card hover:bg-accent-400"
          >
            Keep going →
          </button>
          <button
            type="button"
            onClick={() => setFinishing(true)}
            className="px-4 py-2.5 text-base font-semibold text-brand-900 hover:text-brand-900"
          >
            Skip for now
          </button>
        </div>
        {state?.error && <p className="mt-3 text-sm text-error-600">{state.error}</p>}
      </form>
    );
  }

  const multi = current.fields.length > 1;
  const heading = multi ? current.title : current.fields[0].question.title;
  const subheading = multi ? current.subtitle : current.fields[0].question.subtitle;

  return (
    <form action={formAction} className="w-full max-w-lg">
      <HiddenAnswers answers={answers} unsure={unsure} sectorOptions={sectorOptions} />

      <div className="flex items-baseline justify-between">
        <p className="label-eyebrow text-xs text-accent-500">
          {current.eyebrow ?? "Getting started"}
        </p>
        <p className="text-[11px] text-warmgray-300">
          {clamped + 1} of {steps.length}
        </p>
      </div>
      <div className="mt-2 flex gap-1">
        {steps.map((s, i) => (
          <span
            key={`${s.id}-${i}`}
            className={`h-1 flex-1 ${i <= clamped ? "bg-accent-500" : "bg-brand-100"}`}
          />
        ))}
      </div>

      <h1 className="mt-6 text-2xl font-normal leading-snug text-brand-900">{heading}</h1>
      {subheading && <p className="mt-2 text-sm leading-relaxed text-warmgray-500">{subheading}</p>}

      {current.fields.map(({ question, options }) => (
        <div key={question.key} className={multi ? "mt-7" : "mt-6"}>
          {multi && (
            <>
              <h2 className="text-base font-medium leading-snug text-brand-900">{question.title}</h2>
              {question.subtitle && (
                <p className="mt-1 text-xs leading-relaxed text-warmgray-500">{question.subtitle}</p>
              )}
            </>
          )}
          <div className={multi ? "mt-3" : ""}>
            <QuestionField
              question={question}
              options={options}
              value={val(question.key)}
              unsure={isUnsure(question.key)}
              onToggle={(v) => toggle(question, v)}
              followUpValue={question.followUp ? (val(question.followUp.key)[0] ?? "") : undefined}
              onSetFollowUp={(v) => {
                const key = question.followUp?.key;
                if (key) setAnswers((prev) => ({ ...prev, [key]: v ? [v] : [] }));
              }}
              onSetText={(v) => setText(question, v)}
              onToggleUnsure={() => toggleUnsure(question)}
            />
          </div>
          {multi && question.key === "targetInternshipYear" && summerSuggested && (
            <p className="mt-2 text-[11px] text-warmgray-500">
              Filled in from your graduation year - change it if you&rsquo;re on a different path.
            </p>
          )}
        </div>
      ))}

      {touched && !canAdvance && (
        <p className="mt-3 text-sm text-error-600">
          {multi ? "We do need an answer to each of these to continue." : "This one we do need to continue."}
        </p>
      )}
      {state?.error && <p className="mt-3 text-sm text-error-600">{state.error}</p>}

      <div className="mt-8 flex items-center justify-between">
        <button
          type="button"
          onClick={() => {
            setTouched(false);
            setStepIndex((i) => Math.max(0, i - 1));
          }}
          disabled={isFirst}
          className="px-4 py-2 text-base font-semibold text-brand-900 hover:text-brand-900 disabled:opacity-0"
        >
          ← Back
        </button>

        {isLastOverall ? (
          <button
            type="button"
            onClick={() => setFinishing(true)}
            className="bg-accent-500 px-6 py-2.5 text-sm font-semibold text-white shadow-card hover:bg-accent-400"
          >
            Next →
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              setTouched(true);
              if (canAdvance) {
                setTouched(false);
                setStepIndex((i) => i + 1);
              }
            }}
            className="bg-accent-600 px-6 py-2.5 text-sm font-semibold text-white shadow-card hover:bg-accent-500"
          >
            {anyRequired || hasAnswer ? "Next" : "Skip"} →
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * The form field a state key submits under.
 *
 * Most keys are the field. The per-sector questions suffix theirs with the
 * sector (`nicheInterests:private_equity`) so each question owns its own answer
 * and its own "not sure" flag, and collapse back to one field here - the column
 * behind them is a single text array.
 */
function fieldNameFor(key: string): string {
  const i = key.indexOf(":");
  return i === -1 ? key : key.slice(0, i);
}

// Every accumulated answer is mirrored into hidden inputs so the single
// submit - which can happen at the gate OR at the very end - always carries
// the whole wizard.
function HiddenAnswers({
  answers,
  unsure,
  sectorOptions,
}: {
  answers: Record<string, string[]>;
  unsure: Record<string, boolean>;
  sectorOptions: [FirmProgramCategory, string][];
}) {
  return (
    <>
      {Object.entries(answers).flatMap(([key, values]) =>
        values.map((v, i) => {
          // sectors are stored by enum value, displayed by label
          const out =
            key === "preferredCategories"
              ? sectorOptions.find(([, l]) => l === v)?.[0]
              : v;
          return out ? (
            <input key={`${key}-${i}`} type="hidden" name={fieldNameFor(key)} value={out} />
          ) : null;
        }),
      )}
      {/* Deduped: two sector-scoped questions collapse to one field, and being
          unsure about both should not write the same flag twice. */}
      {[
        ...new Set(
          Object.entries(unsure)
            .filter(([, on]) => on)
            .map(([key]) => fieldNameFor(key)),
        ),
      ].map((field) => (
        <input key={`u-${field}`} type="hidden" name="onboardingUnsure" value={field} />
      ))}
      <input type="hidden" name="_unsureSentinel" value={UNSURE} />
    </>
  );
}
