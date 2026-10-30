"use client";

import { useState } from "react";
import { Video } from "lucide-react";
import { externalHref } from "@/lib/safe-url";
import { deleteEvent, toggleEventCompleted } from "./actions";
import EditEventForm from "./EditEventForm";

export type EventType =
  | "meeting"
  | "coffee_chat"
  | "deadline"
  | "info_session"
  | "personal"
  | "interview";

export type ScheduleRowEvent = {
  id: string;
  type: EventType;
  title: string;
  notes: string | null;
  // Serialized for the client boundary; the server keeps Date objects.
  eventDate: string;
  endDate: string | null;
  // The same two instants as datetime-local values on the student's clock,
  // for the editor; see toRowEvent in page.tsx.
  eventDateInput: string;
  endDateInput: string;
  completed: boolean;
  googleSyncStatus: "none" | "pending" | "synced" | "dismissed";
  googleMeetUrl: string | null;
  contactId: string | null;
  applicationId: string | null;
  contactName: string | null;
  applicationLabel: string | null;
  // Precomputed on the server: the "add this to Google by hand" template URL,
  // and the notes with Offerly's internal sync markers stripped out.
  googleCalendarUrl: string;
  visibleNotes: string | null;
};

const EVENT_TYPE_LABELS: Record<EventType, string> = {
  meeting: "Meeting",
  coffee_chat: "Coffee chat",
  deadline: "Deadline",
  info_session: "Info session",
  interview: "Interview",
  personal: "Personal",
};

const EVENT_TYPE_COLORS: Record<EventType, string> = {
  meeting: "border border-brand-200 bg-brand-50 text-brand-800",
  coffee_chat: "border border-accent-300 bg-accent-50 text-accent-700",
  deadline: "border border-error-200 bg-error-50 text-error-700",
  info_session: "border border-accent-200 bg-accent-50 text-accent-700",
  interview: "border border-error-200 bg-error-50 text-error-600",
  personal: "border border-brand-100 bg-brand-50 text-warmgray-600",
};

function formatDate(iso: string, timeZone: string) {
  return new Date(iso).toLocaleString(undefined, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** `timeZone` is the student's (lib/time-zone-server), so the row reads the
 *  same on the server render and in a browser set to another zone. */
export default function EventRow({ event, timeZone }: { event: ScheduleRowEvent; timeZone: string }) {
  // Held here rather than inside the form so the open editor can render on its
  // own line below the row instead of being squeezed into the button group.
  const [editing, setEditing] = useState(false);
  const synced = event.googleSyncStatus === "synced";
  // Read-boundary guard on both Google links. The Meet URL is whatever the
  // Calendar API's `hangoutLink` or conference entry point said, and the
  // "add by hand" URL is built from the event - neither is checked anywhere
  // else, and both are the same policy as every other outside link in the app
  // (lib/safe-url). A real meet.google.com or calendar.google.com URL passes
  // byte-for-byte; a refused one drops its button rather than leaving a dead
  // one, which is what an event with no Meet already looks like.
  const meetHref = externalHref(event.googleMeetUrl);
  const addToGoogleHref = externalHref(event.googleCalendarUrl);

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={`inline-flex rounded-sm px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${EVENT_TYPE_COLORS[event.type]}`}
          >
            {EVENT_TYPE_LABELS[event.type]}
          </span>
          <div className="min-w-0">
            <p
              className={`text-sm font-medium ${event.completed ? "text-warmgray-500 line-through" : "text-brand-900"}`}
            >
              {event.title}
            </p>
            <p className="text-xs text-warmgray-500">
              {formatDate(event.eventDate, timeZone)}
              {event.contactName && <> · {event.contactName}</>}
              {event.applicationLabel && <> · {event.applicationLabel}</>}
              {synced && <> · on your Offerly calendar</>}
            </p>
            {event.visibleNotes && (
              <p
                className="mt-0.5 max-w-3xl overflow-hidden text-xs text-warmgray-500"
                style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}
                title={event.visibleNotes}
              >
                {event.visibleNotes}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {meetHref && (
            <a
              href={meetHref}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 rounded-md border border-accent-300 bg-accent-50 px-2.5 py-1 text-xs font-medium text-accent-700 hover:bg-accent-100"
            >
              <Video size={12} />
              Join Meet
            </a>
          )}
          {/* Once an event is on the student's Offerly calendar, offering "add
              to Google Calendar" again would just create a duplicate. The
              manual template link is for the un-synced case only. */}
          {!synced && addToGoogleHref && (
            <a
              href={addToGoogleHref}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-brand-100 px-2.5 py-1 text-xs font-medium text-brand-900 hover:bg-brand-50"
            >
              Add to Google Calendar
            </a>
          )}
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="rounded-md border border-brand-100 px-2.5 py-1 text-xs font-medium text-brand-900 hover:bg-brand-50"
          >
            {editing ? "Close" : "Edit"}
          </button>
          <form action={toggleEventCompleted.bind(null, event.id, !event.completed)}>
            <button
              type="submit"
              className="rounded-md border border-brand-100 px-2.5 py-1 text-xs font-medium text-warmgray-600 hover:bg-brand-50"
            >
              {event.completed ? "Mark upcoming" : "Mark done"}
            </button>
          </form>
          <form action={deleteEvent.bind(null, event.id)}>
            <button
              type="submit"
              className="rounded-md border border-error-200 px-2.5 py-1 text-xs font-medium text-error-600 hover:bg-error-50"
            >
              Delete
            </button>
          </form>
        </div>
      </div>

      {editing && (
        <div className="mt-3">
          <EditEventForm event={event} onDone={() => setEditing(false)} />
        </div>
      )}
    </div>
  );
}
