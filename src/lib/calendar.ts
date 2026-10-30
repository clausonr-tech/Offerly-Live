type CalendarEvent = {
  id: string;
  title: string;
  notes: string | null;
  eventDate: Date;
  endDate?: Date | null;
};

const DEFAULT_DURATION_MS = 30 * 60 * 1000;

function toUtcStamp(d: Date) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function resolveEnd(event: CalendarEvent) {
  return event.endDate && event.endDate > event.eventDate
    ? event.endDate
    : new Date(event.eventDate.getTime() + DEFAULT_DURATION_MS);
}

export function buildGoogleCalendarUrl(event: CalendarEvent) {
  const start = event.eventDate;
  const end = resolveEnd(event);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates: `${toUtcStamp(start)}/${toUtcStamp(end)}`,
  });
  if (event.notes) params.set("details", event.notes);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * One text value, folded so it cannot end the content line it sits in.
 *
 * RFC 5545 escapes backslash, semicolon, comma and the line break. The break
 * rule used to cover LF alone, which left a bare CR intact - and since
 * buildICS joins its content lines with CRLF, a tolerant importer reads that
 * CR as the end of the line and whatever follows it as a new property
 * (URL:, ATTENDEE:, an entire VALARM).
 *
 * The text in an exported event is not always the student's own: a firm's
 * event title and location are copied into their calendar when they add a
 * recruiting event, so the export has to treat it as somebody else's writing.
 * Every line ending - CRLF, bare CR, LF, and the Unicode separators some
 * editors paste - becomes the escaped "\n" that ICS means by one, and the
 * remaining C0 controls, which no calendar entry needs and some parsers also
 * treat as breaks, are dropped rather than passed through. Tab is left alone:
 * it is ordinary text in an ICS value.
 */
function escapeICSText(text: string) {
  return (
    text
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r\n|[\r\n\u2028\u2029]/g, "\\n")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
  );
}

export function buildICS(events: CalendarEvent[]) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Offerly//EN", "CALSCALE:GREGORIAN"];

  for (const event of events) {
    const start = event.eventDate;
    const end = resolveEnd(event);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.id}@recruit-os`,
      `DTSTAMP:${toUtcStamp(new Date())}`,
      `DTSTART:${toUtcStamp(start)}`,
      `DTEND:${toUtcStamp(end)}`,
      `SUMMARY:${escapeICSText(event.title)}`,
    );
    if (event.notes) lines.push(`DESCRIPTION:${escapeICSText(event.notes)}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}
