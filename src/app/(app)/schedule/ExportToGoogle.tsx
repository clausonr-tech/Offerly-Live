"use client";

import { useState, useTransition } from "react";
import { CalendarPlus } from "lucide-react";
import { exportScheduleToGoogle } from "./actions";

/**
 * Sends the schedule to Google, when asked.
 *
 * Deliberately a button and not a setting. Offerly pulls a student's calendar
 * so their week shows up here; putting Offerly's rows onto a calendar their
 * team, family or school can see is a different act, and it should take a
 * decision rather than happen because a connection exists.
 */
export default function ExportToGoogle({
  connected,
  configured,
}: {
  connected: boolean;
  configured: boolean;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  // Nothing to offer if Google was never set up for this deployment.
  if (!configured) return null;

  return (
    <div className="flex items-center gap-2">
      {result && <span className="text-xs text-warmgray-500">{result}</span>}
      <button
        type="button"
        disabled={pending || !connected}
        // The one-way promise used to be a paragraph in the connect banner on
        // every visit. It belongs on the control that breaks it, not above the
        // calendar forever - so it is here, on the button that does the write.
        title={
          connected
            ? "Copies your Offerly schedule onto a separate Offerly calendar in your Google account, which you can hide or delete any time. Nothing is written back unless you press this."
            : "Connect a Google account first"
        }
        onClick={() =>
          start(async () => {
            const res = await exportScheduleToGoogle();
            setResult(
              res?.error
                ? res.error
                : res?.exported === 0
                  ? "Already up to date"
                  : `Exported ${res?.exported}`,
            );
          })
        }
        className="inline-flex items-center gap-1.5 rounded-md border border-brand-200 px-3 py-1.5 text-xs font-medium text-brand-900 transition hover:bg-brand-50 disabled:opacity-50"
      >
        <CalendarPlus size={13} />
        {pending ? "Exporting…" : "Export to Google"}
      </button>
    </div>
  );
}
