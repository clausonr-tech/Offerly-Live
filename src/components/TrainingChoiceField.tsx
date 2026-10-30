/**
 * The "help improve Offerly's writing tools" checkbox and what it means.
 *
 * One component for every place a student is asked - sign-up, the consent
 * screen and Settings - so the question and its fine print say the same thing
 * everywhere, matching the Training Use section of the privacy policy. Submits
 * as `trainingOptIn=on` when ticked. The policy makes Training Use opt-out, so
 * new questions default to ticked; Settings passes the student's saved answer.
 */
export default function TrainingChoiceField({
  defaultChecked = true,
  className = "border border-brand-100 bg-white px-4 py-3.5",
}: {
  defaultChecked?: boolean;
  /** The box around it, so marketing-styled forms (sign-up) can match their own fields. */
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          name="trainingOptIn"
          defaultChecked={defaultChecked}
          className="mt-1 h-4 w-4 shrink-0 accent-[#0b1526]"
        />
        <span>
          <span className="block text-sm font-medium text-brand-900">Help improve Offerly&apos;s writing tools</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-warmgray-500">
            Offerly may use your drafts, your edits and your resume versions, with names and contact details
            removed, to train the models behind its writing tools. You can turn this off any time in Settings;
            turning it off deletes what we&apos;ve kept for training, though training that already happened
            can&apos;t be undone.{" "}
            <a href="/legal/ai" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              How Offerly uses AI
            </a>
          </span>
        </span>
      </label>
    </div>
  );
}
