"use client";

import { useRef, useState, useTransition } from "react";
import FirmSharingFields from "@/components/FirmSharingFields";
import { setFirmSharingAction } from "./sharing-actions";

/**
 * Sharing with firms, saved the moment the box is ticked or unticked - no Save
 * button. The status beside the heading follows the box straight away; if the
 * save fails the tick goes back, so the box never shows a choice that was not
 * kept.
 */
export default function FirmSharingToggle({ initial }: { initial: boolean }) {
  const [sharing, setSharing] = useState(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [, startTransition] = useTransition();
  // Only the latest click's answer may land: an older save finishing after a
  // newer one must not overwrite the status the newer one set.
  const latest = useRef(0);

  function onChange(e: React.ChangeEvent<HTMLFormElement>) {
    const box = e.target as unknown as HTMLInputElement;
    if (box.name !== "shareWithFirms") return;
    const next = box.checked;
    const form = new FormData(e.currentTarget);
    const call = ++latest.current;
    setSharing(next);
    setStatus("saving");
    startTransition(async () => {
      try {
        await setFirmSharingAction(form);
        if (call === latest.current) setStatus("saved");
      } catch {
        if (call !== latest.current) return;
        box.checked = !next;
        setSharing(!next);
        setStatus("error");
      }
    });
  }

  return (
    <>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-brand-900">Sharing with firms</h2>
        <span className={`text-xs font-medium ${sharing ? "text-success-700" : "text-warmgray-500"}`}>
          {sharing ? "On - firms can find you" : "Off"}
        </span>
      </div>
      <form onChange={onChange} onSubmit={(e) => e.preventDefault()}>
        <FirmSharingFields defaultChecked={initial} />
      </form>
      <p aria-live="polite" className="mt-2 min-h-4 text-xs text-warmgray-500">
        {status === "saving" && "Saving..."}
        {status === "saved" && "Saved"}
        {status === "error" && <span className="text-error-600">Couldn&apos;t save that - try again.</span>}
      </p>
    </>
  );
}
