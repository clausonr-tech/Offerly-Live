import "server-only";

const CALENDAR_ROOT = "https://www.googleapis.com/calendar/v3";
const DEFAULT_DURATION_MS = 30 * 60 * 1000;

// The name of the secondary calendar Offerly creates and owns. Everything
// Offerly writes goes here rather than into the student's primary calendar,
// so they can hide it, colour it separately, or delete the whole thing
// without collateral damage to their own events.
const OFFERLY_CALENDAR_SUMMARY = "Offerly";
const OFFERLY_CALENDAR_DESCRIPTION =
  "Interviews, coffee chats and application deadlines synced from Offerly.";

// Event types that are an actual conversation with another person, and so
// get a Google Meet link. A deadline or a lecture doesn't need one.
const MEET_EVENT_TYPES = new Set(["meeting", "coffee_chat", "info_session"]);

export function eventTypeWantsMeet(type: string) {
  return MEET_EVENT_TYPES.has(type);
}

function eventsUrl(calendarId: string) {
  return `${CALENDAR_ROOT}/calendars/${encodeURIComponent(calendarId)}/events`;
}

async function googleFetch(url: string, accessToken: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  return res;
}

// ---------- reading ----------

export type GoogleCalendarSummary = {
  id: string;
  title: string;
  primary: boolean;
  backgroundColor: string | null;
};

// Every calendar the student has subscribed to and left visible. Reading
// across all of them (rather than only "primary") is what makes the Schedule
// page show their real week - classes, club events and personal entries
// usually live on secondary calendars.
async function listCalendars(accessToken: string): Promise<GoogleCalendarSummary[]> {
  const res = await googleFetch(
    `${CALENDAR_ROOT}/users/me/calendarList?maxResults=250&minAccessRole=reader`,
    accessToken,
  );
  if (!res.ok) {
    throw new Error(`Google calendarList failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const items: unknown[] = data.items ?? [];

  return items
    .map((item) => {
      const c = item as {
        id: string;
        summary?: string;
        primary?: boolean;
        selected?: boolean;
        deleted?: boolean;
        backgroundColor?: string;
      };
      // `selected` is Google's own "is this ticked in the sidebar" flag, and
      // it is omitted (rather than set false) on the primary calendar. Respect
      // it: a calendar the student has hidden in Google should stay hidden here.
      if (c.deleted) return null;
      if (c.selected === false && !c.primary) return null;
      return {
        id: c.id,
        title: c.summary || "(untitled calendar)",
        primary: Boolean(c.primary),
        backgroundColor: c.backgroundColor ?? null,
      };
    })
    .filter((c): c is GoogleCalendarSummary => c !== null);
}

export type GoogleCalendarEvent = {
  id: string;
  title: string;
  start: string; // ISO
  end: string | null; // ISO
  htmlLink: string;
  allDay: boolean;
  calendarId: string;
  calendarTitle: string;
  meetUrl: string | null;
  /** The entry's notes. An interview invitation often says so only here. */
  notes: string | null;
  /** Carries a Zoom, Meet, Teams or Webex link - a call, whatever it is titled. */
  videoCall: boolean;
  /** Everyone else invited, lower-cased: not the student, not a room, not a
   *  no-reply or calendar address. */
  attendeeEmails: string[];
  /** The same people, with the name the invitation gives them, when it does. */
  attendees: { email: string; name: string | null }[];
  /** The student said no to the invitation. */
  declined: boolean;
  /** One instance of a repeating entry - a weekly 1:1, a class. */
  recurring: boolean;
  /** Google's own kind: "default" for an ordinary entry; "outOfOffice",
   *  "focusTime" and "workingLocation" are blocks of time, not meetings. */
  eventType: string;
};

/**
 * Video-call links as they appear in an entry's location or notes.
 *
 * The host name starts after a character that cannot be part of one, rather
 * than at a \b. With \b, every letter/hyphen transition inside a long run
 * ("a-a-a-a-...") is a place the match may start, and at each one the greedy
 * [\w-]+ runs to the end of the run and then backtracks a character at a time
 * looking for a dot - quadratic in the length of the run. The text this runs
 * on is an invitation description, which anyone who can send the student an
 * invitation writes. A hyphen is part of a host label anyway, so it was never
 * a place a host name begins: "not-zoom.us/" is a different domain and never
 * was a Zoom link.
 */
const VIDEO_LINK =
  /(?:^|[^\w-])(?:[\w-]+\.)?(?:zoom\.us|zoomgov\.com|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com|gotomeeting\.com|meet\.goto\.com|bluejeans\.com|chime\.aws|facetime\.apple\.com)\//i;

/**
 * How much of an invitation's location and notes is scanned for a link.
 *
 * Generous enough that no real invitation is truncated - Google's own
 * description limit is a few kilobytes of HTML, and a meeting link sits near
 * the top of it - but a fixed bound rather than "whatever the sender wrote",
 * so the scan cost of an entry a stranger put on the calendar is capped.
 */
const VIDEO_SCAN_LOCATION_CHARS = 1_000;
const VIDEO_SCAN_NOTES_CHARS = 10_000;

/** A location that is only the name of a video app: "Zoom", "Google Meet". */
const VIDEO_PLACE =
  /^\s*(?:zoom(?: meeting| call)?|google meet|g ?meet|meet|(?:microsoft |ms )?teams(?: meeting| call)?|webex|facetime|skype)\s*$/i;

/**
 * Addresses on an invitation that are not a person anyone could thank: a
 * no-reply sender, a calendar or a room, a scheduling bot.
 */
const NOT_A_PERSON =
  /(?:^|[._+-])(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|mailer-daemon|calendar|scheduler|scheduling|bot)(?:[._+-]|@)|@(?:group|resource|import)\.calendar\.google\.com$|@(?:calendly\.com|zoom\.us|goodtime\.io|modernloop\.io|x\.ai)$/i;

/** Whether an invitee is a person, reading past a plus-tag: a person's
 *  "dana.reed+calendar@gmail.com" is still Dana. */
function isPerson(email: string): boolean {
  return !NOT_A_PERSON.test(email.replace(/\+[^@]*@/, "@"));
}

type RawGoogleEvent = {
  id: string;
  summary?: string;
  htmlLink: string;
  status?: string;
  hangoutLink?: string;
  location?: string;
  description?: string;
  recurringEventId?: string;
  eventType?: string;
  attendees?: {
    email?: string;
    displayName?: string;
    self?: boolean;
    resource?: boolean;
    responseStatus?: string;
  }[];
  conferenceData?: { entryPoints?: { entryPointType?: string }[] };
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

/** One item from Google's events list, or null for one that did not happen. */
export function parseGoogleEvent(
  item: unknown,
  calendar: Pick<GoogleCalendarSummary, "id" | "title">,
): GoogleCalendarEvent | null {
  const e = item as RawGoogleEvent;
  if (!e || typeof e !== "object" || !e.id) return null;
  if (e.status === "cancelled") return null;
  // An all-day event uses `date` (YYYY-MM-DD) instead of `dateTime`;
  // callers need to know which, because a date-only value has no timezone
  // and must not be rendered as midnight local.
  const allDay = Boolean(e.start?.date && !e.start?.dateTime);
  const start = e.start?.dateTime ?? e.start?.date;
  if (!start) return null;
  const end = e.end?.dateTime ?? e.end?.date ?? null;
  const attendees = Array.isArray(e.attendees) ? e.attendees : [];
  const people = attendees
    // Not the student, not a room, and not anyone who turned it down - they
    // were not there to thank.
    .filter((a) => a && !a.self && !a.resource && typeof a.email === "string" && a.responseStatus !== "declined")
    .map((a) => ({
      email: a.email!.trim().toLowerCase(),
      name: typeof a.displayName === "string" && a.displayName.trim() ? a.displayName.trim() : null,
    }))
    .filter((a) => a.email && isPerson(a.email));
  return {
    id: e.id,
    title: e.summary || "(untitled)",
    start,
    end,
    htmlLink: e.htmlLink,
    allDay,
    calendarId: calendar.id,
    calendarTitle: calendar.title,
    meetUrl: e.hangoutLink ?? null,
    notes: e.description ?? null,
    videoCall:
      !!e.hangoutLink ||
      (Array.isArray(e.conferenceData?.entryPoints) &&
        e.conferenceData.entryPoints.some((p) => p?.entryPointType === "video")) ||
      VIDEO_LINK.test(
        `${(e.location ?? "").slice(0, VIDEO_SCAN_LOCATION_CHARS)} ${(e.description ?? "").slice(0, VIDEO_SCAN_NOTES_CHARS)}`,
      ) ||
      // A location typed by hand as just the app's name.
      VIDEO_PLACE.test(e.location ?? ""),
    attendeeEmails: people.map((a) => a.email),
    attendees: people,
    declined: attendees.some((a) => a?.self && a.responseStatus === "declined"),
    recurring: !!e.recurringEventId,
    eventType: e.eventType ?? "default",
  };
}

/** Pages read per calendar before stopping: 1,000 entries in the window. */
const MAX_PAGES = 4;

async function listEventsForCalendar(
  accessToken: string,
  calendar: GoogleCalendarSummary,
  timeMin: Date,
  timeMax: Date,
): Promise<GoogleCalendarEvent[]> {
  const out: GoogleCalendarEvent[] = [];
  let pageToken: string | undefined;
  // Every page, not just the first: Google returns 250 at most, oldest first,
  // so a busy calendar would otherwise lose its most recent entries - the ones
  // a thank-you or an interview is about.
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      // Expands recurring events into their individual instances, so a weekly
      // class shows on every week rather than once on its start date.
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await googleFetch(`${eventsUrl(calendar.id)}?${params.toString()}`, accessToken);
    if (!res.ok) {
      throw new Error(`Google Calendar list failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    const items: unknown[] = data.items ?? [];
    for (const item of items) {
      const parsed = parseGoogleEvent(item, calendar);
      if (parsed) out.push(parsed);
    }
    pageToken = typeof data.nextPageToken === "string" ? data.nextPageToken : undefined;
    if (!pageToken) break;
  }
  return out;
}

// Read-only: lists the student's events across every visible calendar in a
// window, to display alongside their Offerly events. Never modifies anything.
// A single calendar failing (revoked share, transient 5xx) drops that calendar
// rather than the whole read.
export async function listCalendarEvents(
  accessToken: string,
  timeMin: Date,
  timeMax: Date,
): Promise<GoogleCalendarEvent[]> {
  const calendars = await listCalendars(accessToken);

  const results = await Promise.allSettled(
    calendars.map((calendar) => listEventsForCalendar(accessToken, calendar, timeMin, timeMax)),
  );

  const events = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  return events.sort((a, b) => a.start.localeCompare(b.start));
}

// ---------- the Offerly calendar ----------

// Returns the id of the student's Offerly calendar, creating it if this is the
// first sync or if they deleted it on Google's side. `knownId` is whatever we
// stored last time; it is verified before use so a stale id doesn't cause
// every write to fail silently.
export async function ensureOfferlyCalendar(
  accessToken: string,
  knownId: string | null,
): Promise<string> {
  if (knownId) {
    const res = await googleFetch(
      `${CALENDAR_ROOT}/calendars/${encodeURIComponent(knownId)}`,
      accessToken,
    );
    if (res.ok) return knownId;
    // 404/410 = they deleted it; 403 = we lost access to it. Either way the
    // right move is to make a fresh one. Anything else is a real failure.
    if (res.status !== 404 && res.status !== 410 && res.status !== 403) {
      throw new Error(`Google calendar lookup failed: ${res.status} ${await res.text()}`);
    }
  }

  const res = await googleFetch(`${CALENDAR_ROOT}/calendars`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      summary: OFFERLY_CALENDAR_SUMMARY,
      description: OFFERLY_CALENDAR_DESCRIPTION,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google calendar create failed: ${res.status} ${await res.text()}`);
  }
  const created = await res.json();
  return created.id as string;
}

// ---------- writing ----------

export type CalendarEventInput = {
  title: string;
  notes?: string | null;
  eventDate: Date;
  endDate?: Date | null;
  // Adds a Google Meet link to the event. Only meaningful on create - Google
  // issues the conference at creation time.
  withMeet?: boolean;
  // Minutes before the event for Google to notify. Omit to inherit the
  // student's own calendar defaults; pass explicit offsets for things they
  // need real lead time on, like an application window opening.
  reminderMinutes?: number[];
};

export type WrittenCalendarEvent = {
  id: string;
  htmlLink: string;
  meetUrl: string | null;
};

function eventBody(event: CalendarEventInput) {
  const start = event.eventDate;
  const end =
    event.endDate && event.endDate > start
      ? event.endDate
      : new Date(start.getTime() + DEFAULT_DURATION_MS);

  return {
    summary: event.title,
    description: event.notes ?? undefined,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    ...(event.reminderMinutes?.length
      ? {
          reminders: {
            useDefault: false,
            overrides: event.reminderMinutes.map((minutes) => ({ method: "popup", minutes })),
          },
        }
      : {}),
  };
}

// Google returns the Meet URL as `hangoutLink` once the conference is
// provisioned, but on a freshly-created event it may only be present as an
// entry point inside conferenceData. Check both; null is a valid answer.
function readMeetUrl(payload: unknown): string | null {
  const e = payload as {
    hangoutLink?: string;
    conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  };
  if (e.hangoutLink) return e.hangoutLink;
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video");
  return video?.uri ?? null;
}

// Creates a single event on the student's Offerly calendar.
export async function createCalendarEvent(
  accessToken: string,
  calendarId: string,
  event: CalendarEventInput,
): Promise<WrittenCalendarEvent> {
  // conferenceDataVersion=1 is required for Google to honour a createRequest;
  // without it the conferenceData block is silently ignored and no Meet link
  // is issued.
  const query = event.withMeet ? "?conferenceDataVersion=1" : "";

  const res = await googleFetch(`${eventsUrl(calendarId)}${query}`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      ...eventBody(event),
      ...(event.withMeet
        ? {
            conferenceData: {
              createRequest: {
                requestId: crypto.randomUUID(),
                conferenceSolutionKey: { type: "hangoutsMeet" },
              },
            },
          }
        : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`Google Calendar create failed: ${res.status} ${await res.text()}`);
  }
  const created = await res.json();
  return { id: created.id, htmlLink: created.htmlLink, meetUrl: readMeetUrl(created) };
}

// Pushes an edit made in Offerly onto the already-synced Google copy, so
// retiming or renaming an event here doesn't leave a stale duplicate there.
// Sync is one-way by design: Offerly is the source of truth for events it
// created, and changes made on Google's side are not pulled back.
export async function updateCalendarEvent(
  accessToken: string,
  calendarId: string,
  googleEventId: string,
  event: CalendarEventInput,
): Promise<WrittenCalendarEvent> {
  const res = await googleFetch(
    `${eventsUrl(calendarId)}/${encodeURIComponent(googleEventId)}`,
    accessToken,
    { method: "PATCH", body: JSON.stringify(eventBody(event)) },
  );
  if (!res.ok) {
    throw new Error(`Google Calendar update failed: ${res.status} ${await res.text()}`);
  }
  const updated = await res.json();
  return { id: updated.id, htmlLink: updated.htmlLink, meetUrl: readMeetUrl(updated) };
}

// Removes a previously-synced event from the student's Google Calendar, so
// deleting it in Offerly doesn't leave an orphaned copy behind. A 404
// (already gone on Google's side) is treated as success, not an error.
export async function deleteCalendarEvent(
  accessToken: string,
  calendarId: string,
  googleEventId: string,
): Promise<void> {
  const res = await googleFetch(
    `${eventsUrl(calendarId)}/${encodeURIComponent(googleEventId)}`,
    accessToken,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`Google Calendar delete failed: ${res.status} ${await res.text()}`);
  }
}
