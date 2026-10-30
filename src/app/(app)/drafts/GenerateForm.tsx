"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  OCCASIONS,
  autoFill,
  boxesConflict,
  occasionById,
  resolveSituation,
  situationQuestions,
  situationTypes,
  toggleBox,
  visibleSections,
  type Question,
  type RecipientHints,
} from "@/lib/draft-occasions";
import { RESUME_ACCEPT } from "@/lib/resume-formats";
import { privateTopicsIn, resumeLooksLikeSomeoneElses } from "@/lib/draft-lint";
import { blockedLanguageError } from "@/lib/content-limits";
import { externalHref } from "@/lib/safe-url";
import type { Suggestion, SuggestionSet } from "@/lib/draft-suggestions";
import { useDraftStream } from "./useDraftStream";
import DraftStreamPreview from "./DraftStreamPreview";
import { suggestDraftFields } from "./suggestion-actions";
import RecipientPicker, { type RecipientOption } from "./RecipientPicker";
import Composer from "./Composer";
import StagedProgress, { DRAFT_STAGES } from "@/components/StagedProgress";

// Every box on the form is one line tall, whether it's a single-line input, a
// select or a textarea that takes a longer answer (it scrolls as you type), so
// rows line up and nothing looks taller than its neighbour.
const inputClass =
  "block h-11 w-full rounded-md border border-brand-200 px-3 py-2 text-sm leading-6 text-brand-900 focus:border-accent-500 focus:outline-none";
const textareaClass = `${inputClass} resize-none overflow-y-auto`;

// The earlier-email questions, which an Offerly cold email to this person answers itself.
const THREAD_QUESTIONS = new Set(["originalSubject", "originalDate", "originalAsk", "followUp1Date"]);

function Field({
  label,
  hint,
  children,
  below,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  /**
   * What sits under the box - a question's "Suggested:" line. Passing it (even
   * as null) lays the field out on three rows it shares with the rest of its
   * grid row: the words, the box, then this. So the boxes in a row sit on one
   * line whatever is above them or under them, and taking a suggestion (which
   * removes its line) no longer drops that box below its neighbour.
   */
  below?: React.ReactNode;
}) {
  if (below !== undefined) {
    return (
      <label className="row-span-3 grid grid-rows-subgrid gap-y-0">
        <span className="block">
          <span className="mb-1 block text-sm font-semibold text-brand-900">{label}</span>
          {hint && <span className="mb-1.5 block text-xs leading-relaxed text-warmgray-500">{hint}</span>}
        </span>
        <div>{children}</div>
        <div>{below}</div>
      </label>
    );
  }
  return (
    // Full height + `mt-auto` on the control keeps every box in a row on the
    // same line: grid items stretch, so a field with a hint, or a label that
    // wraps, pushes only its own text down, never its box.
    <label className="flex h-full flex-col">
      <span className="mb-1 block text-sm font-semibold text-brand-900">{label}</span>
      {hint && <span className="mb-1.5 block text-xs leading-relaxed text-warmgray-500">{hint}</span>}
      <div className="mt-auto">{children}</div>
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-md border border-brand-100 bg-brand-50/40 p-4">
      <p className="text-base font-semibold text-brand-900">{title}</p>
      {children}
    </div>
  );
}

/** On a box the form checked from what Offerly knows. Unchecking it is fine. */
function AutoFilledTag() {
  return (
    <span className="rounded-full bg-white/20 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-white">
      Auto-filled
    </span>
  );
}

/** Loose school match: "USC" typed against "University of Southern California" won't match, which only means nothing is filled in. */
function sameSchoolName(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const x = norm(a ?? "");
  const y = norm(b ?? "");
  return x.length > 2 && y.length > 2 && (x === y || x.includes(y) || y.includes(x));
}

export default function GenerateForm({
  recipients,
  initialRecipientKey,
  initialOccasionId,
  initialBoxId,
  initialOutside,
  matchNote,
  resumeFilename,
  signature,
  studentName,
  studentSchool,
  streaming,
}: {
  /** OFFERLY_DRAFT_STREAM is on: try the streaming route before the action. */
  streaming: boolean;
  /** Open on "Outside of your matched contacts" with these filled in - a
   *  thank-you prompt for someone not saved yet. Blank fields stay blank. */
  initialOutside?: { name: string | null; email: string | null; firm: string | null };
  /** For spotting a resume uploaded under someone else's name. */
  studentName: string;
  /** For filling in "An alum of my school" for someone typed in by hand. */
  studentSchool: string | null;
  /** The resume on file, attached to every cold email. Null asks for one. */
  resumeFilename: string | null;
  /** Contact details from the profile that go under the sign-off. */
  signature: { schoolEmail: string | null; phone: string | null };
  /** Matched people at matched firms - the only people the picker offers. */
  recipients: RecipientOption[];
  /** Preselect one person, for links that arrive from the Networking table. */
  initialRecipientKey?: string;
  /** Preselect what they want to do, and one box under it - for a follow-up
   *  prompt, "Follow up" with the right rung. Ignored unless both are real. */
  initialOccasionId?: string;
  initialBoxId?: string;
  /** Why there are no matched people yet, when there aren't. */
  matchNote: string | null;
}) {
  // Drafting, over the streaming route when this deploy has it on and the
  // browser can read a stream, and over the server action otherwise - the
  // hook decides, and a stream that never starts falls back without the
  // student seeing anything different (./useDraftStream).
  const draftRun = useDraftStream({ enabled: streaming });
  const { pending, draft, error: generateError } = draftRun;
  // What the student wants to do, and the boxes describing the situation.
  // Filled in from what Offerly knows about the person (autoFill below) until
  // the student changes a box themselves; a prompt that sent them here with
  // an occasion and box already knows the answer and wins.
  const initialOccasion = occasionById(initialOccasionId);
  // Only what the student chose themselves; null means "whatever the facts
  // say" (see autoFill below). Derived rather than copied into state, so a
  // new person or a newly typed school refills the form on the same render.
  const [chosenOccasionId, setChosenOccasionId] = useState<string | null>(initialOccasion?.id ?? null);
  const [chosenBoxes, setChosenBoxes] = useState<string[] | null>(
    initialOccasion &&
      initialBoxId &&
      initialOccasion.sections.some((sec) => sec.boxes.some((b) => b.id === initialBoxId))
      ? [initialBoxId]
      : null,
  );
  const [showFormat, setShowFormat] = useState(false);
  const [moreOpen, setMoreOpen] = useState<Record<string, boolean>>({});
  const [recipientKey, setRecipientKey] = useState(
    recipients.some((r) => r.key === initialRecipientKey) ? (initialRecipientKey as string) : "",
  );
  // Someone the student found themselves. The default unless a link sent them
  // here for one of their contacts: people they generated on Offerly get
  // their email from the "Draft email" button beside their name, so this form
  // is mostly for everyone else.
  const [outside, setOutside] = useState(
    recipients.length === 0 || !!initialOutside || !recipients.some((r) => r.key === initialRecipientKey),
  );
  const formRef = useRef<HTMLFormElement>(null);
  // Everything typed, keyed by field name. Held here rather than in the inputs
  // themselves because changing the recipient or the boxes re-renders the
  // sections, and uncontrolled inputs lost what was in them.
  const [values, setValues] = useState<Record<string, string>>(() => {
    const start: Record<string, string> = {};
    if (initialOutside?.name) start.outsideName = initialOutside.name;
    if (initialOutside?.email) start.outsideEmail = initialOutside.email;
    if (initialOutside?.firm) start.outsideFirm = initialOutside.firm;
    return start;
  });
  const [selectValues, setSelectValues] = useState<Record<string, string>>({});
  const [commonGround, setCommonGround] = useState("");
  const [commonGroundTouched, setCommonGroundTouched] = useState(false);
  // Set when the student says the email they're following up on is not the
  // one they drafted here, so the manual questions come back.
  const [writeOwnOriginal, setWriteOwnOriginal] = useState(false);
  const [hasGmailSignature, setHasGmailSignature] = useState(false);

  // Suggested answers for the person picked: the facts at once, then the
  // model's phrasing when it arrives (cached per person, so usually instant).
  // Shown under each field; nothing is filled in until the student says so.
  const [fieldSuggestions, setFieldSuggestions] = useState<SuggestionSet>({});
  const [taken, setTaken] = useState<string[]>([]);
  useEffect(() => {
    setFieldSuggestions({});
    setTaken([]);
    if (outside || !recipientKey) return;
    let live = true;
    void suggestDraftFields(recipientKey, false)
      .then((r) => {
        if (live && r) setFieldSuggestions(r.fields);
        return r?.withAi ? null : suggestDraftFields(recipientKey, true);
      })
      .then((r) => {
        if (live && r) setFieldSuggestions(r.fields);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [recipientKey, outside]);

  const selected = outside ? null : (recipients.find((r) => r.key === recipientKey) ?? null);
  const outsideSameSchool = sameSchoolName(values.outsideSchool, studentSchool);
  const hints: RecipientHints | null = selected
    ? {
        sameSchool: selected.commonGround.includes("Same school"),
        knownNotAlum: Boolean(selected.school?.trim()) && !selected.commonGround.includes("Same school"),
        role: selected.title,
        name: selected.name,
        hasPriorColdEmail: Boolean(selected.priorCold),
        hasFollowUp1: Boolean(selected.priorFollowUp1On),
      }
    : outside
      ? {
          sameSchool: outsideSameSchool,
          knownNotAlum: Boolean(values.outsideSchool?.trim() && studentSchool) && !outsideSameSchool,
          role: values.outsideRole,
          name: values.outsideName,
          hasPriorColdEmail: false,
          hasFollowUp1: false,
        }
      : null;
  // The form's answers: the student's own where they gave one, otherwise
  // what the facts about this person settle. Unchecking an auto-filled box
  // is a choice like any other, and from then on the boxes are theirs.
  const fill = autoFill(hints, { outside, occasionId: chosenOccasionId ?? undefined });
  const occasionId = chosenOccasionId ?? fill.occasionId;
  const checked = chosenBoxes ?? fill.boxes;
  const autoChecked = fill.boxes;

  const occasion = occasionById(occasionId);
  const resolved = occasion && checked.length > 0 ? resolveSituation(occasion.id, checked) : null;
  const situation = resolved && !("error" in resolved) ? resolved : null;
  const types = situation ? situationTypes(situation) : [];
  const lead = types[0] ?? null;

  const hasThread = types.some((t) => t.repliesInThread);
  const hasCold = types.some((t) => t.isCold);
  const priorCold = selected?.priorCold ?? null;
  const fromOfferlyEmail = Boolean(priorCold) && !writeOwnOriginal;

  // A new person starts over: their facts fill the form again.
  function resetAutoFill() {
    setChosenOccasionId(null);
    setChosenBoxes(null);
  }

  // Someone typed in by hand who is already one of their contacts.
  const typedMatch = outside
    ? recipients.find(
        (r) => values.outsideName?.trim() && r.name.trim().toLowerCase() === values.outsideName.trim().toLowerCase(),
      ) ?? null
    : null;

  const questions = situation
    ? situationQuestions(situation, (name) => selectValues[name] ?? values[name]).filter(
        (q) => !(fromOfferlyEmail && THREAD_QUESTIONS.has(q.name)),
      )
    : [];
  const sectionNames = [...new Set(questions.map((q) => q.section))];

  // Who each name on the form is, in one line, so a name typed into the wrong
  // box shows up here before it becomes a wrong email.
  const recipientName = ((outside ? values.outsideName : selected?.name) ?? "").trim();
  const asked = new Set(questions.map((q) => q.name));
  const people = (
    [
      ["referrerName", "Referred by"],
      ["firstPerson", "Sent to them by"],
      ["introducedTo", "They introduced you to"],
      ["newPerson", "They sent you to"],
      ["introTarget", "Offered to introduce you to"],
    ] as const
  )
    .filter(([name]) => asked.has(name) && values[name]?.trim())
    .map(([name, label]) => ({ name, label, value: values[name].trim() }));
  // Slurs, hateful terms or profanity anywhere on the form: named here, and
  // Generate stays off until they're gone. The server checks again.
  const labelFor: Record<string, string> = {
    ...Object.fromEntries(questions.map((q) => [q.name, q.label])),
    outsideName: "Name",
    outsideFirm: "Firm",
    outsideRole: "Role",
    outsideGroup: "Group or division",
    outsideSchool: "Their school",
    outsideBackground: "What do you know about them?",
    extraContext: "Anything else to include?",
    purpose: "What is this email for?",
  };
  const blockedMessage = blockedLanguageError([
    ...Object.entries(values).map(([name, value]) => [labelFor[name] ?? "One of your answers", value] as [string, string]),
    [labelFor.specificReason ?? "What you have in common", commonGround],
  ]);

  const personWarnings = [
    ...people
      .filter((p) => p.value.split(/\s+/).length > 4)
      .map((p) => `"${p.label}" should be just a name, but it says "${p.value}".`),
    ...people
      .filter((p) => recipientName && p.value.toLowerCase() === recipientName.toLowerCase())
      .map((p) => `${p.value} is both the person you're emailing and "${p.label}". Check the names.`),
    // A private topic typed anywhere on the form, e.g. "his gambling addiction" as what you talked about.
    ...(privateTopicsIn(Object.values(values).join(" ")).length
      ? [
          `You mentioned ${privateTopicsIn(Object.values(values).join(" "))
            .map((w) => `"${w}"`)
            .join(", ")}. Private details like that usually don't belong in a networking email, so the draft will leave them out.`,
        ]
      : []),
    ...(recipientName && !types.some((t) => t.toTeam) && recipientName.split(/\s+/).length === 1
      ? [`There's only one name for the person you're emailing, so the email will open "Hi ${recipientName},". Make sure that's their first name.`]
      : []),
  ];

  /** Name, value and change handler for a typed box. */
  const bind = (name: string) => ({
    name,
    value: values[name] ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = e.target.value;
      setValues((v) => ({ ...v, [name]: value }));
    },
  });

  /** "Suggested: ..." under a field, with the one click that uses it. */
  const suggestionFor = (name: string, current: string, use: (text: string) => void) => {
    const s = (fieldSuggestions as Record<string, Suggestion | undefined>)[name];
    if (!s || current.trim() === s.text) return null;
    return (
      <p className="mt-1 text-[11px] leading-snug text-warmgray-600">
        <span className="font-medium text-brand-900">Suggested:</span> {s.text}
        {s.basis.length > 0 && <span className="text-warmgray-500"> · from {s.basis.join(", ")}</span>}{" "}
        <button
          type="button"
          onClick={() => {
            use(s.text);
            setTaken((t) => (t.includes(name) ? t : [...t, name]));
          }}
          className="font-medium text-brand-900 underline hover:text-accent-700"
        >
          Use this
        </button>
      </p>
    );
  };

  const renderQuestion = (q: Question) => (
    <Field
      key={q.name}
      label={q.required || q.kind === "select" ? q.label : `${q.label} (optional)`}
      hint={q.hint}
      below={
        q.kind === "select"
          ? null
          : q.name === "specificReason"
            ? suggestionFor(q.name, commonGround, (text) => {
                setCommonGroundTouched(true);
                setCommonGround(text);
              })
            : suggestionFor(q.name, values[q.name] ?? "", (text) => setValues((v) => ({ ...v, [q.name]: text })))
      }
    >
      {q.kind === "select" ? (
        <select
          name={q.name}
          value={selectValues[q.name] ?? q.options?.[0]?.value}
          onChange={(e) => {
            const value = e.target.value;
            setSelectValues((v) => ({ ...v, [q.name]: value }));
          }}
          className={inputClass}
        >
          {q.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : q.name === "specificReason" ? (
        <textarea
          name="specificReason"
          rows={1}
          value={commonGround}
          onChange={(e) => {
            setCommonGroundTouched(true);
            setCommonGround(e.target.value);
          }}
          placeholder={q.placeholder}
          className={textareaClass}
        />
      ) : q.kind === "textarea" ? (
        <textarea {...bind(q.name)} rows={1} required={q.required} placeholder={q.placeholder} className={textareaClass} />
      ) : (
        <input {...bind(q.name)} type="text" required={q.required} placeholder={q.placeholder} className={inputClass} />
      )}
    </Field>
  );

  return (
    <div className="space-y-6">
    <form
      ref={formRef}
      // Submitted by hand rather than through action={}: React resets a form
      // after its action runs, which wiped everything the student typed even
      // when generating failed. The inputs stay until the email is sent.
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        void draftRun.submit(data);
      }}
      className="rounded-lg border border-brand-100 bg-white p-4"
    >
      {/* Who it's to, first and plainly: someone the student found
          themselves is what this form is mostly for, and it comes first. */}
      <p className="mb-2 text-sm font-semibold text-brand-900">Who are you writing to?</p>
      <div role="radiogroup" aria-label="Who are you writing to?" className="mb-3 grid gap-2 sm:grid-cols-2">
        {[
          {
            value: true,
            label: "Someone you found yourself",
            hint: "Met them, were referred, or found them on LinkedIn",
          },
          {
            value: false,
            label: `One of your Offerly contacts${recipients.length ? ` (${recipients.length})` : ""}`,
            hint: "People you generated or saved here",
          },
        ].map((opt) => {
          const on = outside === opt.value;
          return (
            <button
              key={opt.label}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={!opt.value && recipients.length === 0}
              onClick={() => {
                if (on) return;
                setOutside(opt.value);
                setRecipientKey("");
                setWriteOwnOriginal(false);
                resetAutoFill();
                if (!commonGroundTouched) setCommonGround("");
              }}
              className={`rounded-lg border px-3.5 py-2.5 text-left text-sm transition disabled:opacity-50 ${
                on ? "border-accent-500 bg-accent-500 text-white" : "border-brand-200 text-brand-900 hover:border-accent-400"
              }`}
            >
              <span className="block font-medium">{opt.label}</span>
              <span className={`block text-[11px] ${on ? "text-white/80" : "text-warmgray-500"}`}>{opt.hint}</span>
            </button>
          );
        })}
      </div>
      {!outside && (
        <p className="mb-3 text-xs text-warmgray-500">
          Quicker for people you generated: use <span className="font-medium text-brand-900">Draft email</span> next
          to their name, and it writes the email without leaving the page.
        </p>
      )}
      {outside && recipients.length === 0 && (
        <p className="mb-3 text-xs text-warmgray-500">
          You don&apos;t have matched contacts yet{matchNote ? `. ${matchNote}` : "."} You can still write to
          anyone below.
        </p>
      )}

      {/* Who it goes to, and what the student wants to do, on one row. */}
      <div className="grid gap-3 sm:grid-cols-3">
        {outside ? (
          <input type="hidden" name="recipient" value="outside" />
        ) : (
          <RecipientPicker
            recipients={recipients}
            initialKey={recipientKey || undefined}
            onSelect={(key) => {
              setRecipientKey(key);
              resetAutoFill();
              // Common ground is suggested under its box now, not typed in
              // for them: a connection goes in the email only once checked.
              if (!commonGroundTouched) setCommonGround("");
              setWriteOwnOriginal(false);
            }}
          />
        )}
        <Field label="What do you want to do?">
          <select
            name="occasion"
            required
            value={occasionId}
            onChange={(e) => {
              // A new occasion has different boxes; what was typed stays. One
              // with a single box ("Something else") has nothing to choose.
              // The facts fill the new occasion's boxes afresh (autoFill);
              // one with a single box ("Something else") gets that box.
              setChosenOccasionId(e.target.value);
              setChosenBoxes(null);
              setShowFormat(false);
            }}
            className={inputClass}
          >
            <option value="" disabled>
              Choose what you&apos;re writing
            </option>
            {OCCASIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <p className="mt-2 text-xs text-warmgray-500">
        {occasion
          ? occasion.description
          : "Choose who it's going to and what you want to do, and the questions for this email open below."}
      </p>

      {outside && (
        <div className="mt-4">
          <Section title="Who you're emailing">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label={types.some((t) => t.toTeam) ? "Team name" : "Name"}
                hint={types.some((t) => t.toTeam) ? "The recruiting team the inbox belongs to." : "As you'd greet them."}
              >
                <input {...bind("outsideName")} type="text" required placeholder="e.g. Jeff Chen" className={inputClass} />
              </Field>
              <Field label="Firm" hint="Where they work now.">
                <input {...bind("outsideFirm")} type="text" required placeholder="e.g. Goldman Sachs" className={inputClass} />
              </Field>
              <Field label="Email" hint="Where the email goes.">
                <input {...bind("outsideEmail")} type="email" required placeholder="e.g. jeff.chen@gs.com" className={inputClass} />
              </Field>
              <Field label="Role (optional)" hint="Their title.">
                <input {...bind("outsideRole")} type="text" placeholder="e.g. Associate" className={inputClass} />
              </Field>
              <Field label="Group or division (optional)" hint="Tailors the email to their team.">
                <input {...bind("outsideGroup")} type="text" placeholder="e.g. Energy investment banking" className={inputClass} />
              </Field>
              <Field label="Their school (optional)" hint="A shared school is the strongest opener.">
                <input {...bind("outsideSchool")} type="text" placeholder="e.g. University of Pennsylvania" className={inputClass} />
              </Field>
              <Field label="LinkedIn (optional)" hint="Full link to their profile.">
                <input {...bind("outsideLinkedin")} type="url" placeholder="https://www.linkedin.com/in/..." className={inputClass} />
              </Field>
              <Field label="What do you know about them? (optional)" hint="Past firms, how you found them, anything.">
                <textarea
                  {...bind("outsideBackground")}
                  rows={1}
                  placeholder="e.g. was at Evercore before; spoke at our finance club"
                  className={textareaClass}
                />
              </Field>
            </div>
            {typedMatch ? (
              <p className="flex flex-wrap items-center gap-2 rounded-md border border-accent-200 bg-accent-50 px-3 py-2 text-xs text-brand-900">
                {typedMatch.name} at {typedMatch.firmName} is already one of your Offerly contacts.
                <button
                  type="button"
                  onClick={() => {
                    setOutside(false);
                    setRecipientKey(typedMatch.key);
                    setWriteOwnOriginal(false);
                    resetAutoFill();
                  }}
                  className="font-semibold underline underline-offset-2"
                >
                  Use what Offerly has
                </button>
              </p>
            ) : (
              <p className="text-xs text-warmgray-500">They&apos;ll be added to your contacts when you generate.</p>
            )}
          </Section>
        </div>
      )}


      {/* The situation, as boxes. Each checked box opens its questions below. */}
      {checked.map((id) => (
        <input key={id} type="hidden" name="box" value={id} />
      ))}
      {/* Which suggestions the student took, for the record kept on the draft. */}
      <input type="hidden" name="suggestionsTaken" value={JSON.stringify(taken)} />
      {occasion && occasion.sections.flatMap((s) => s.boxes).length > 1 && (
        <div className="mt-4 space-y-4">
          {/* For one of their contacts, how they came to this person is
              already known - it replaces the "How are you connected?" boxes. */}
          {!outside && selected && occasion.id === "first_contact" && (
            <p className="rounded-md border border-brand-100 bg-brand-50 px-3 py-2 text-xs text-brand-900">
              {selected.found === "offerly"
                ? `You found ${selected.name} on Offerly, so this goes as a cold email.`
                : selected.found === "directory"
                  ? `${selected.name} is one of your Offerly matches, so this goes as a cold email.`
                  : `${selected.name} is saved in your contacts.`}
            </p>
          )}
          {visibleSections(occasion, outside).map((section) => (
            <div key={section.title}>
              <p className="mb-2 text-sm font-semibold text-brand-900">
                {section.title}{" "}
                <span className="text-xs font-normal text-warmgray-500">
                  {section.mode === "one" ? "Pick one" : "Check all that apply"}
                </span>
              </p>
              {/* An even grid: every box the same width, and every row as tall
                  as its tallest box, so a long hint doesn't make one box bigger. */}
              <div className="grid auto-rows-fr grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {section.boxes.map((box) => {
                  const on = checked.includes(box.id);
                  // Can't go with something already checked: clicking it swaps them.
                  const blocked = !on && checked.some((c) => boxesConflict(c, box.id));
                  return (
                    <button
                      key={box.id}
                      type="button"
                      aria-pressed={on}
                      title={blocked ? "Checking this unchecks a box it can't go with" : undefined}
                      onClick={() => {
                        setChosenBoxes(toggleBox(occasion, checked, box.id));
                      }}
                      className={`flex h-full w-full flex-col justify-start rounded-lg border px-3.5 py-2 text-left text-sm transition ${
                        on
                          ? "border-accent-500 bg-accent-500 text-white"
                          : blocked
                            ? "border-brand-200 text-warmgray-500 opacity-50 hover:opacity-80"
                            : "border-brand-200 text-brand-900 hover:border-accent-400"
                      }`}
                    >
                      <span className="flex items-center gap-2 font-medium">
                        {box.label}
                        {on && autoChecked.includes(box.id) && <AutoFilledTag />}
                      </span>
                      {/* Shown, not hovered: the hint is what tells two similar boxes apart. */}
                      {box.hint && (
                        <span className={`mt-0.5 block text-[11px] leading-snug ${on ? "text-white/80" : "text-warmgray-500"}`}>
                          {box.hint}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {occasion && !situation && (
        <p className="mt-3 text-xs text-warmgray-500">Check the boxes that describe the situation to see what it needs.</p>
      )}

      {situation && lead && (
        <div className="mt-5 space-y-4">
          {/* What will be written, before anything is generated. */}
          <div className="rounded-md border border-brand-100 px-4 py-3">
            <p className="text-sm text-brand-900">
              <span className="font-semibold">Writing: </span>
              {situation.summary}
            </p>
            <p className="mt-1 text-xs text-warmgray-500">
              To: <span className="font-medium text-brand-900">{recipientName || "the person you pick above"}</span> (the person you&apos;re emailing)
              {people.map((p) => (
                <span key={p.name}>
                  {" · "}
                  {p.label}: <span className="font-medium text-brand-900">{p.value}</span>
                </span>
              ))}
            </p>
            {personWarnings.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 text-xs text-error-600">
                {personWarnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            {lead.id !== "custom" && (
              <button
                type="button"
                onClick={() => setShowFormat((v) => !v)}
                className="mt-1 text-xs text-brand-900 hover:underline"
              >
                {showFormat ? "Hide what this email will include" : "What this email will include"}
              </button>
            )}
            {showFormat && lead.id !== "custom" && (
              <>
                <ol className="mt-2 grid list-decimal gap-x-6 gap-y-0.5 pl-4 text-[11px] leading-relaxed text-warmgray-500 sm:grid-cols-2">
                  {lead.format.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                {situation.also.length > 0 && (
                  <p className="mt-2 text-[11px] text-warmgray-500">
                    Follows the “{lead.label}” format and also works in:{" "}
                    {situation.also.map((b) => b.label.toLowerCase()).join(", ")}.
                  </p>
                )}
              </>
            )}
          </div>

          {/* Resume first for any email that attaches it: without one there is
              nothing to attach, and nothing to read the student's experience from. */}
          {types.some((t) => t.attachResume) && (
            <Section title="Your resume">
              {resumeFilename ? (
                <>
                  <p className="text-xs text-warmgray-500">
                    Your experience comes from <span className="font-medium text-brand-900">{resumeFilename}</span>.
                    Attach it to the email when you send it.
                  </p>
                  {resumeLooksLikeSomeoneElses(resumeFilename, studentName) && (
                    <p className="text-xs text-error-600">
                      This file looks like it&apos;s named for someone else. If it isn&apos;t your resume, upload yours on
                      your profile before drafting.
                    </p>
                  )}
                </>
              ) : (
                <Field
                  label="Upload your resume"
                  hint="Needed for this email: it's attached, and your experience and clubs are pulled from it. PDF, Word (.docx), image or text file."
                >
                  <input
                    name="resume"
                    type="file"
                    accept={RESUME_ACCEPT}
                    required
                    className="block w-full text-sm text-brand-900 file:mr-3 file:rounded-md file:border file:border-brand-300 file:bg-transparent file:px-3 file:py-1.5 file:text-sm file:text-brand-900"
                  />
                </Field>
              )}
            </Section>
          )}

          {/* The earlier email, filled in from Offerly when it was written here. */}
          {hasThread && (fromOfferlyEmail && priorCold ? (
            <Section title="The earlier email">
              <input type="hidden" name="useOfferlyOriginal" value="1" />
              <div className="rounded-md border border-brand-100 bg-white px-3 py-2.5">
                <p className="text-sm text-brand-900">
                  Replying to <span className="font-semibold">“{priorCold.subject}”</span>
                </p>
                <p className="mt-0.5 text-xs text-warmgray-500">
                  Your email to {selected?.name}, drafted {priorCold.draftedOn}
                  {types.some((t) => t.id === "follow_up_2") && selected?.priorFollowUp1On
                    ? `, and follow-up #1, drafted ${selected.priorFollowUp1On}`
                    : ""}
                  . The subject line, timing and what you asked for are all pulled from it.
                </p>
              </div>
              <button type="button" onClick={() => setWriteOwnOriginal(true)} className="text-xs text-brand-900 hover:underline">
                I sent a different email myself →
              </button>
            </Section>
          ) : null)}

          {/* Only the checked boxes' questions, each asked once. Required ones
              show; optional ones sit behind "Add more detail" when a section
              has required ones to answer first. */}
          {sectionNames.map((name) => {
            const qs = questions.filter((q) => q.section === name);
            const hasRequired = qs.some((q) => q.required);
            const main = hasRequired
              ? qs.filter(
                  (q) =>
                    q.required ||
                    q.kind === "select" ||
                    (q.name === "specificReason" && commonGround) ||
                    // A suggestion is worth seeing without a click to find it.
                    !!(fieldSuggestions as Record<string, unknown>)[q.name],
                )
              : qs;
            const extra = qs.filter((q) => !main.includes(q));
            const open = moreOpen[name] || extra.some((q) => values[q.name]);
            return (
              <Section key={name} title={name}>
                <div className="grid gap-3 sm:grid-cols-2">{main.map(renderQuestion)}</div>
                {extra.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => setMoreOpen((m) => ({ ...m, [name]: !open }))}
                      className="text-xs font-medium text-brand-900 hover:underline"
                    >
                      {open ? "Hide the optional details" : `Add more detail (optional, ${extra.length})`}
                    </button>
                    {open && <div className="grid gap-3 sm:grid-cols-2">{extra.map(renderQuestion)}</div>}
                  </>
                )}
                {name === "The earlier email" && !selected && !outside && (
                  <p className="text-xs text-warmgray-500">
                    Emailed them through Offerly? Pick them above and this fills itself in.
                  </p>
                )}
                {name === "The earlier email" && priorCold && !fromOfferlyEmail && (
                  <button type="button" onClick={() => setWriteOwnOriginal(false)} className="text-xs text-brand-900 hover:underline">
                    ← Use my Offerly email, “{priorCold.subject}”, instead
                  </button>
                )}
                {/* Read-boundary guard - the contact row's LinkedIn field, which
                    a CSV import or the sourcing run may have filled rather than
                    the student. No href means no prompt to go and look, which
                    is what a contact with no profile already shows. */}
                {name === "Tailoring it to them" && hasCold && externalHref(selected?.linkedinUrl) && (
                  <a
                    href={externalHref(selected?.linkedinUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block text-sm font-semibold text-brand-900 hover:underline"
                  >
                    Check their LinkedIn for common ground →
                  </a>
                )}
              </Section>
            );
          })}

          <Section title={lead.id === "custom" ? "Describe the email" : "Anything else"}>
            {/* One optional box: two ("anything else" and "specific details") asked the same thing. */}
            <div className="grid gap-3 sm:grid-cols-2">
              {lead.id === "custom" && (
                <Field label="What is this email for?" hint="In your own words - it'll use the closest format.">
                  <textarea
                    {...bind("purpose")}
                    rows={1}
                    required
                    placeholder="e.g. asking a former manager to be a reference"
                    className={textareaClass}
                  />
                </Field>
              )}
              <Field
                label="Anything else to include? (optional)"
                hint="Every detail you add here goes into the email, e.g. you talked about cars."
              >
                <textarea
                  {...bind("extraContext")}
                  rows={1}
                  placeholder="e.g. they spoke on a panel at my club last night"
                  className={textareaClass}
                />
              </Field>
            </div>
          </Section>

          {/* The sign-off is built from the profile. A signature the student's
              email adds on its own would repeat all of it, so ticking the box
              ends the email on "Best,". The field keeps its old name,
              gmailSignature, because the prompt input and saved drafts use it. */}
          <div className="rounded-md border border-brand-100 px-4 py-3">
            <label className="flex items-start gap-2 text-sm text-brand-900">
              <input
                name="gmailSignature"
                type="checkbox"
                checked={hasGmailSignature}
                onChange={(e) => setHasGmailSignature(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-accent-500"
              />
              <span>
                My email adds my signature automatically
                <span className="block text-xs text-warmgray-500">
                  The email will end on “Best,” so your contact info isn&apos;t in it twice.
                </span>
              </span>
            </label>
            {!hasGmailSignature && (
              <p className="mt-2 text-xs text-warmgray-500">
                {signature.schoolEmail && signature.phone ? (
                  `Signed with ${signature.schoolEmail} and ${signature.phone}.`
                ) : (
                  <>
                    Add your{" "}
                    {[!signature.schoolEmail && "school email", !signature.phone && "phone"].filter(Boolean).join(" and ")} on your{" "}
                    <Link href="/profile" className="text-brand-900 underline">
                      profile
                    </Link>{" "}
                    to sign with {!signature.schoolEmail && !signature.phone ? "them" : "it"}.
                  </>
                )}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="mt-4 flex justify-end border-t border-brand-100 pt-4">
        <button
          type="submit"
          disabled={pending || !situation || Boolean(blockedMessage)}
          className="rounded-md bg-accent-500 px-6 py-2.5 text-sm font-semibold text-white shadow-card hover:bg-accent-400 disabled:opacity-60"
        >
          {pending ? "Drafting..." : "Generate draft"}
        </button>
      </div>

      {/* Names the pipeline's current step while nothing is streaming yet -
          the same stages QuickDraft shows. On the streaming path this covers
          only the wait for the first frame: the moment real text arrives the
          preview below takes over and says what is happening itself. */}
      {pending && !draftRun.streamed && (
        <StagedProgress stages={DRAFT_STAGES} sublabel="About half a minute" className="mt-4 text-center" />
      )}

      {blockedMessage && <p className="mt-2 text-sm text-error-600">{blockedMessage}</p>}
      {generateError && <p className="mt-2 text-sm text-error-600">{generateError}</p>}
    </form>

    {/* The email as it is written, and then the one line saying the checked
        one has replaced it. Nothing in here can be copied, edited or sent.
        Keyed on the draft so the swap remounts it: the strip announcing the
        replacement is a new element, which is what makes it catch the eye
        rather than mutate quietly under one. */}
    <DraftStreamPreview key={draft?.id ?? "live"} state={draftRun} />

    {/* Keyed by draft so a new generation starts a fresh composer instead of
        keeping the previous draft's edits. */}
    {draft && (
      <Composer
        key={draft.id}
        draft={draft}
        scrollOnMount
        // Once it's sent the inputs have done their job; clear them for the next email.
        onSent={() => {
          formRef.current?.reset();
          setValues({});
          setSelectValues({});
          setCommonGround("");
          setCommonGroundTouched(false);
          setMoreOpen({});
          resetAutoFill();
        }}
      />
    )}
    </div>
  );
}
