"use client";

import { useActionState } from "react";
import { CalendarPlus, Check, ExternalLink } from "lucide-react";
import { EVENT_KIND_TONES, LABEL_TONES } from "@/lib/label-colors";
import { EVENT_KIND_LABELS, type FirmRecruitingEvent } from "@/lib/recruiting-event-display";
import { externalHref } from "@/lib/safe-url";
import { addRecruitingEventToCalendar, type AddEventState } from "./actions";

/**
 * The recruiting events the crawler files for this firm.
 *
 * These arrive as a by-product of the classifier rejecting them - an info
 * session reads exactly like an internship and is not one. Shown here because
 * a coffee chat with a firm is worth a great deal to a student, and until this
 * existed the rows were written and never read.
 *
 * Dates are printed exactly as strongly as they were extracted. An event whose
 * source published no time says so, and offers the link instead of a calendar
 * button - a calendar entry at an invented time is worse than one the student
 * has to open.
 */
export default function FirmRecruitingEvents({
  firmName,
  slug,
  events,
}: {
  firmName: string;
  slug: string;
  events: FirmRecruitingEvent[];
}) {
  // The section is rendered only when there is something in it; the firm page
  // decides that, so there is no empty state to design here.
  return (
    <div className="mt-6">
      <h2 className="mb-2 text-base font-semibold text-brand-900">
        Recruiting events at {firmName}
      </h2>
      <div className="divide-y divide-brand-100 overflow-hidden rounded-lg border border-brand-100 bg-white">
        {events.map((event) => (
          <EventRow key={event.id} event={event} slug={slug} />
        ))}
      </div>
      <p className="mt-1.5 text-xs text-warmgray-500">
        {events.every((e) => e.postedByFirm)
          ? `Posted by ${firmName} on Offerly.`
          : events.some((e) => e.postedByFirm)
            ? `Some posted by ${firmName} on Offerly, the rest read from its own board. Times are shown only where the listing published one.`
            : `Read from ${firmName}’s own board. Times are shown only where the listing published one.`}
      </p>
    </div>
  );
}

function EventRow({ event, slug }: { event: FirmRecruitingEvent; slug: string }) {
  const [state, action, pending] = useActionState<AddEventState, FormData>(
    addRecruitingEventToCalendar,
    undefined,
  );

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
              style={{
                background: LABEL_TONES[EVENT_KIND_TONES[event.kind] ?? "coverage"].bg,
                color: LABEL_TONES[EVENT_KIND_TONES[event.kind] ?? "coverage"].fg,
              }}
            >
              {event.kind === "other" && event.kindLabel ? event.kindLabel : EVENT_KIND_LABELS[event.kind]}
            </span>
            {event.school && (
              <span className="text-[11px] font-medium text-success-700">{event.school}</span>
            )}
          </div>

          <a
            // The read boundary for a crawled link. The feed already refuses
            // anything that is not a public http(s) URL, and this is the
            // backstop in the place that actually emits the href - React
            // neutralises `javascript:` and nothing else, so a stored
            // `data:` or `vbscript:` value would otherwise be a live link.
            // undefined leaves the title as text rather than a broken link.
            href={externalHref(event.eventUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 flex items-start gap-1 text-sm font-medium text-brand-900 hover:underline"
          >
            <span className="min-w-0">{event.title}</span>
            <ExternalLink size={11} className="mt-1 shrink-0 text-warmgray-500" aria-hidden />
          </a>

          <p className="mt-0.5 text-xs text-warmgray-500">
            {event.eventDate ? formatEventDate(event.eventDate) : "Date not published"}
            {event.location ? ` · ${event.location}` : ""}
          </p>

          {event.registrationDeadline && (
            <p className="text-xs text-warmgray-500">
              Registration closes {formatDay(event.registrationDeadline)}
            </p>
          )}

          {event.summary && (
            <p className="mt-1 text-xs text-warmgray-600">{event.summary}</p>
          )}
        </div>

        {/* No button without a date. The action refuses one too, so a stale
            page cannot get past this. */}
        {event.eventDate &&
          (state?.success ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-success-700">
              <Check className="h-3.5 w-3.5" aria-hidden />
              {state.success}
            </span>
          ) : (
            <form action={action} className="shrink-0">
              <input type="hidden" name="recruitingEventId" value={event.id} />
              <input type="hidden" name="slug" value={slug} />
              <button
                type="submit"
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-md border border-brand-200 px-2.5 py-1 text-xs font-medium text-brand-900 hover:border-accent-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <CalendarPlus className="h-3.5 w-3.5" aria-hidden />
                {pending ? "Adding..." : "Add to my calendar"}
              </button>
            </form>
          ))}
      </div>

      {state?.error && <p className="mt-1 text-xs text-error-600">{state.error}</p>}
    </div>
  );
}

/** Weekday and time, since a student is deciding whether they can be there. */
function formatEventDate(date: Date) {
  const day = date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "long",
  });
  // Midnight means the source gave a day and no clock time - the parser stores
  // it that way rather than guessing an hour, so printing "00:00" would invent
  // a precision the listing never had.
  if (date.getHours() === 0 && date.getMinutes() === 0) return day;
  return `${day}, ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function formatDay(date: Date) {
  return date.toLocaleDateString(undefined, { day: "numeric", month: "long" });
}
