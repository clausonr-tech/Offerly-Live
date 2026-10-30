// Calendar events imported from a student's inbox, before Offerly stopped
// reading Gmail, carry a "Source: gmail:<account>:<message id>" line in their
// notes that was only ever a dedup key. Those rows are still in the database,
// so the marker is stripped before notes are shown.
const GMAIL_SOURCE_MARKER_RE = /^Source: gmail:\S+$/m;

/** An event's notes as the student should see them, or null when nothing is left. */
export function displayNotes(notes: string | null) {
  if (!notes) return null;
  const cleaned = notes.replace(GMAIL_SOURCE_MARKER_RE, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}
