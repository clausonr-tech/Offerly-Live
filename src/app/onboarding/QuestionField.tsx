"use client";

import { UNSURE, type OnboardingQuestion } from "@/lib/onboarding-questions";
import SchoolCombobox from "@/app/(app)/SchoolCombobox";

// Renders one question. Split out of the wizard because the wizard was
// previously chips-only, and the question bank now mixes single-select,
// multi-select, and two sizes of free text.
export default function QuestionField({
  question,
  options,
  value,
  unsure,
  onToggle,
  onSetText,
  onToggleUnsure,
  followUpValue,
  onSetFollowUp,
}: {
  question: OnboardingQuestion;
  options: string[];
  value: string[];
  unsure: boolean;
  onToggle: (v: string) => void;
  onSetText: (v: string) => void;
  onToggleUnsure: () => void;
  /** Current text of question.followUp, and how to change it. */
  followUpValue?: string;
  onSetFollowUp?: (v: string) => void;
}) {
  if (question.kind === "combobox") {
    // Typed, but only a listed name is kept - see the action. The dropdown
    // is the same one the school picker uses, so it filters as you type.
    return (
      <div>
        <label htmlFor={`${question.key}-input`} className="sr-only">
          {question.title}
        </label>
        <SchoolCombobox
          name={`${question.key}-input`}
          value={value[0] ?? ""}
          onChange={onSetText}
          schools={options}
          placeholder={question.placeholder}
          className="w-full border border-brand-200 bg-white px-3 py-2 text-sm text-brand-900 placeholder:text-warmgray-300 focus:border-accent-400 focus:outline-none"
        />
        {value[0] && !options.some((o) => o.toLowerCase() === value[0].trim().toLowerCase()) && (
          <p className="mt-1 text-[11px] text-warmgray-500">Pick a country from the list, or leave this blank.</p>
        )}
      </div>
    );
  }

  if (question.kind === "text" || question.kind === "longtext") {
    const disabled = unsure;
    return (
      <div>
        {question.kind === "longtext" ? (
          <textarea
            rows={5}
            disabled={disabled}
            value={value[0] ?? ""}
            maxLength={question.maxLength}
            onChange={(e) => onSetText(e.target.value)}
            placeholder={question.placeholder}
            className="w-full border border-brand-200 bg-white px-3 py-2 text-sm text-brand-900 placeholder:text-warmgray-300 focus:border-accent-400 focus:outline-none disabled:opacity-40"
          />
        ) : (
          <input
            type="text"
            disabled={disabled}
            value={value[0] ?? ""}
            maxLength={question.maxLength}
            onChange={(e) => onSetText(e.target.value)}
            placeholder={question.placeholder}
            className="w-full border border-brand-200 bg-white px-3 py-2 text-sm text-brand-900 placeholder:text-warmgray-300 focus:border-accent-400 focus:outline-none disabled:opacity-40"
          />
        )}
        {question.maxLength && !disabled && (
          <p className="mt-1 text-right text-[11px] text-warmgray-300">
            {(value[0] ?? "").length}/{question.maxLength}
          </p>
        )}
        {question.unsureLabel && <UnsureChip label={question.unsureLabel} on={unsure} onClick={onToggleUnsure} />}
      </div>
    );
  }

  const single = question.kind === "single";
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const selected = value.includes(option) && !unsure;
          return (
            <button
              key={option}
              type="button"
              onClick={() => onToggle(option)}
              className={`px-3.5 py-2 text-sm font-medium transition-colors ${
                selected
                  ? "bg-accent-600 text-white"
                  : "border border-brand-200 bg-white text-warmgray-600 hover:border-accent-400"
              } ${unsure ? "opacity-40" : ""}`}
            >
              {option}
            </button>
          );
        })}

        {/* Sits inside the same group as the answers, styled identically.
            It is still a recorded answer rather than a skip - but a student
            reads a differently-styled control as "not one of my choices",
            which made the honest option the hardest one to pick. */}
        {question.unsureLabel && (
          <button
            type="button"
            onClick={onToggleUnsure}
            className={`px-3.5 py-2 text-sm font-medium transition-colors ${
              unsure
                ? "bg-accent-600 text-white"
                : "border border-brand-200 bg-white text-warmgray-600 hover:border-accent-400"
            }`}
          >
            {question.unsureLabel}
          </button>
        )}
      </div>

      {/* The typed half of a question whose first half is a choice.
          Underneath the chips rather than beside them: the choice narrows,
          the box describes, and reading them in that order is how a student
          thinks about their own degree. Disabled while "not sure" is on, for
          the same reason the chips grey out - one answer per question. */}
      {question.followUp && (
        <label className="mt-4 block">
          <span className="text-sm text-warmgray-600">{question.followUp.label}</span>
          <input
            type="text"
            disabled={unsure}
            value={followUpValue ?? ""}
            maxLength={question.followUp.maxLength}
            onChange={(e) => onSetFollowUp?.(e.target.value)}
            placeholder={question.followUp.placeholder}
            className="mt-1 w-full border border-brand-200 bg-white px-3 py-2 text-sm text-brand-900 placeholder:text-warmgray-300 focus:border-accent-400 focus:outline-none disabled:opacity-40"
          />
        </label>
      )}

      {!single && options.length > 0 && (
        <p className="mt-2 text-[11px] text-warmgray-300">Pick as many as apply.</p>
      )}
    </div>
  );
}

// Used by the free-text questions, which have no button group for it to join.
// Matches the answer buttons' styling so the control reads the same wherever
// it appears.
function UnsureChip({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mt-4 px-3.5 py-2 text-sm font-medium transition-colors ${
        on
          ? "bg-accent-600 text-white"
          : "border border-brand-200 bg-white text-warmgray-600 hover:border-accent-400"
      }`}
    >
      {label}
    </button>
  );
}

export { UNSURE };
