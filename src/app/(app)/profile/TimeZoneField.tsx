"use client";

import { useActionState } from "react";
import { COMMON_TIME_ZONES } from "@/lib/time-zone";
import { updateTimeZone, type AccountState } from "./actions";

/** "America/Argentina/Buenos_Aires" reads as "America / Argentina / Buenos Aires". */
function zoneLabel(zone: string) {
  return zone.replace(/_/g, " ").replace(/\//g, " / ");
}

/**
 * Which clock the student's times are on.
 *
 * Automatic follows the device, which is right for almost everyone. The pick
 * is for the rest: a laptop still on home time, a browser that reports UTC
 * for privacy, or someone abroad for a semester recruiting on New York hours.
 * It decides how a typed time is saved and how every event time is shown.
 */
export default function TimeZoneField({
  chosen,
  detected,
  allZones,
}: {
  chosen: string | null;
  detected: string | null;
  allZones: string[];
}) {
  const [state, action, pending] = useActionState<AccountState, FormData>(updateTimeZone, undefined);
  const common = new Set(COMMON_TIME_ZONES.map((z) => z.zone));
  // A pick the full list does not carry (an older runtime) still has to show
  // as selected rather than silently reading as the first option.
  const rest = allZones.filter((z) => !common.has(z));
  if (chosen && !common.has(chosen) && !rest.includes(chosen)) rest.unshift(chosen);

  return (
    <form action={action} className="rounded-md border border-brand-100 bg-brand-50/50 p-3">
      <label htmlFor="profile-time-zone" className="mb-1 block text-sm font-medium text-brand-900">
        Time zone
      </label>
      <div className="flex gap-2">
        <select
          id="profile-time-zone"
          name="timeZone"
          defaultValue={chosen ?? "auto"}
          className="w-full rounded-md border border-brand-200 bg-white px-3 py-1.5 text-sm text-brand-900 focus:border-accent-500 focus:outline-none"
        >
          <option value="auto">Automatic{detected ? ` (${zoneLabel(detected)})` : " (this device)"}</option>
          <optgroup label="Common">
            {COMMON_TIME_ZONES.map((z) => (
              <option key={z.zone} value={z.zone}>
                {z.label}
              </option>
            ))}
          </optgroup>
          {rest.length > 0 && (
            <optgroup label="All time zones">
              {rest.map((z) => (
                <option key={z} value={z}>
                  {zoneLabel(z)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-md bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-500 disabled:opacity-60 shadow-card"
        >
          {pending ? "Saving..." : "Save"}
        </button>
      </div>
      <p className="mt-1.5 text-xs text-warmgray-500">
        The times you enter on your schedule are saved in this zone, and your events and reminders are shown in it.
      </p>
      {state?.saved && <p className="mt-1 text-xs text-success-700">Saved.</p>}
      {state?.error && <p className="mt-1 text-xs text-error-600">{state.error}</p>}
    </form>
  );
}
