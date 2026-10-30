"use client";

import { useEffect, useState } from "react";

export type ProgressStage = {
  /** Seconds after mount at which this stage becomes the one shown. */
  at: number;
  label: string;
};

/**
 * A pending state that names what the server is doing instead of spinning
 * silently. The stages are time-based on the client - the server action is a
 * single await, so there is no live signal to read - but their order and
 * rough proportions mirror the pipeline they describe (the drafting call runs
 * first and takes most of the wait; the review pass follows). The final
 * output still arrives all at once, checked, exactly as before: this changes
 * what the wait feels like, never what is shown at the end.
 */
export default function StagedProgress({
  stages,
  sublabel,
  className,
}: {
  /** In ascending `at` order; the first should be `at: 0`. */
  stages: ProgressStage[];
  /** One quiet line under the stage, e.g. how long the whole thing takes. */
  sublabel?: string;
  className?: string;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const tick = setInterval(() => setElapsed((Date.now() - started) / 1000), 1000);
    return () => clearInterval(tick);
  }, []);

  const current = stages.reduce((shown, s) => (elapsed >= s.at ? s : shown), stages[0]);
  const step = stages.indexOf(current) + 1;

  return (
    <div className={className ?? "py-10 text-center"} role="status">
      <div className="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-[#c5cfe0] border-t-[#24447a]" />
      {/* aria-live so each stage change is announced, not just repainted. */}
      <p className="text-sm font-medium text-[#0b1526]" aria-live="polite">
        {current.label}
      </p>
      <p className="mt-1 text-xs text-[#5f6b7a]">
        {sublabel ? `${sublabel} · ` : ""}step {step} of {stages.length}
      </p>
    </div>
  );
}

/** The email pipeline's true order: gather, write, then the review pass. */
export const DRAFT_STAGES: ProgressStage[] = [
  { at: 0, label: "Reading your profile and what you share…" },
  { at: 5, label: "Writing the email…" },
  { at: 20, label: "Fact-checking every line against your details…" },
  { at: 45, label: "Applying the reviewer's fixes…" },
];
