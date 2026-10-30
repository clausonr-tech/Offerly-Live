import type { RecruitingEventKind } from "@/lib/monitoring/recruiting-events";

/**
 * The parts of a recruiting event the browser is allowed to know about.
 *
 * Deliberately separate from `recruiting-events-feed.ts`, which is
 * `server-only` because it opens the database. The list component is a client
 * component - it needs the labels and the row shape, and importing them from
 * the feed module would pull the database client into the browser bundle.
 * The kind union is imported as a type, which erases at build time.
 */

export type { RecruitingEventKind };

/** One event, as the server hands it to the client. */
export type FirmRecruitingEvent = {
  id: string;
  title: string;
  kind: RecruitingEventKind;
  /** A firm's own words for an "Other event", shown in place of the kind label. */
  kindLabel: string | null;
  /** Null when the source published no parseable date. Never inferred. */
  eventDate: Date | null;
  registrationDeadline: Date | null;
  school: string | null;
  location: string | null;
  eventUrl: string;
  /** Trimmed for display; the full text stays in the row. */
  summary: string | null;
  /** Posted by the firm itself on the firm portal, rather than read from its careers site. */
  postedByFirm: boolean;
};

export const EVENT_KIND_LABELS: Record<RecruitingEventKind, string> = {
  info_session: "Info session",
  coffee_chat: "Coffee chat",
  networking: "Networking",
  insight_day: "Insight day",
  speaker_event: "Speaker event",
  // "other" is the parser's deliberate not-guessed bucket, so the badge says
  // the neutral thing rather than picking a kind the title did not state.
  other: "Event",
};
