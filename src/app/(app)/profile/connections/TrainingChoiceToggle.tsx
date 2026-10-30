"use client";

import { useRef, useState, useTransition } from "react";
import TrainingChoiceField from "@/components/TrainingChoiceField";
import { setTrainingChoiceAction } from "./sharing-actions";

/**
 * Training Use, saved the moment the box is ticked or unticked - no Save
 * button, the same pattern as FirmSharingToggle. Unticking also deletes what
 * was being kept for training (lib/training-consent). The status beside the heading follows the box straight away; if the
 * save fails the tick goes back, so the box never shows a choice that was not
 * kept.
 */
export default function TrainingChoiceToggle({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [, startTransition] = useTransition();
  // Only the latest click's answer may land: an older save finishing after a
  // newer one must not overwrite the status the newer one set.
  const latest = useRef(0);

  function onChange(e: React.ChangeEvent<HTMLFormElement>) {
    const box = e.target as unknown as HTMLInputElement;
    if (box.name !== "trainingOptIn") return;
    const next = box.checked;
    const form = new FormData(e.currentTarget);
    const call = ++latest.current;
    setOn(next);
    setStatus("saving");
    startTransition(async () => {
      try {
        await setTrainingChoiceAction(form);
        if (call === latest.current) setStatus("saved");
      } catch {
        if (call !== latest.current) return;
        box.checked = !next;
        setOn(!next);
        setStatus("error");
      }
    });
  }

  return (
    <>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-brand-900">Improving Offerly&apos;s writing tools</h2>
        <span className={`text-xs font-medium ${on ? "text-success-700" : "text-warmgray-500"}`}>
          {on ? "On" : "Off - nothing is kept for training"}
        </span>
      </div>
      <form onChange={onChange} onSubmit={(e) => e.preventDefault()}>
        <TrainingChoiceField defaultChecked={initial} />
      </form>
      <p aria-live="polite" className="mt-2 min-h-4 text-xs text-warmgray-500">
        {status === "saving" && "Saving..."}
        {status === "saved" && "Saved"}
        {status === "error" && <span className="text-error-600">Couldn&apos;t save that - try again.</span>}
      </p>
    </>
  );
}
