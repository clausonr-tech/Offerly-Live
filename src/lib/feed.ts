// Community feed: who may post, and how post metadata is labelled.
//
// No "server-only" here on purpose - the label maps are imported by the
// filter bar and composer, which are client components.

import type { users } from "@/db/schema";
import type { FirmProgramCategory } from "./firm-metadata";

export type PostType = "event" | "speaker_event" | "coffee_chat" | "deadline" | "announcement";

type UserRow = typeof users.$inferSelect;

export const POST_TYPES: PostType[] = [
  "event",
  "speaker_event",
  "coffee_chat",
  "deadline",
  "announcement",
];

export const POST_TYPE_LABELS: Record<PostType, string> = {
  event: "Event",
  speaker_event: "Speaker event",
  coffee_chat: "Coffee chat",
  deadline: "Deadline",
  announcement: "Announcement",
};

// The single gate for writing to the feed. Three conditions, all required:
// the account is an org, a human has approved it, and it is actually linked
// to the organisation it would be posting as. The last one matters as much
// as the others - an approved club_lead with no clubId would otherwise
// produce posts attributed to nobody.
//
// Every write path calls this. The composer UI hiding is cosmetic; this is
// what actually stops a student from posting.
export function canPostToFeed(user: Pick<UserRow, "accountType" | "orgApproved" | "clubId" | "orgFirmId">): boolean {
  if (user.accountType === "club_lead") return user.orgApproved && !!user.clubId;
  if (user.accountType === "firm") return user.orgApproved && !!user.orgFirmId;
  return false;
}

// An org account that exists but isn't cleared to post yet - shown an
// explanatory panel instead of the composer, so it doesn't look broken.
export function isPendingOrg(user: Pick<UserRow, "accountType" | "orgApproved" | "clubId" | "orgFirmId">): boolean {
  return user.accountType !== "student" && !canPostToFeed(user);
}

// Which org a post gets attributed to. Returns null when the user may not
// post at all, so callers can't accidentally write an unattributed row.
export function posterOrg(
  user: Pick<UserRow, "accountType" | "orgApproved" | "clubId" | "orgFirmId">,
): { clubId: string; firmId: null } | { clubId: null; firmId: string } | null {
  if (!canPostToFeed(user)) return null;
  if (user.accountType === "club_lead") return { clubId: user.clubId!, firmId: null };
  return { clubId: null, firmId: user.orgFirmId! };
}

// ---------- feed sorting + shapes ----------
//
// These live here rather than next to the query that uses them because
// the feed's client components import them: importing a runtime value out of the
// server-only query module pulls the Postgres driver into the browser bundle,
// which fails the build outright ("Can't resolve 'tls'").

export type PostLinkLabel = "details" | "sign_up" | "rsvp" | "apply" | "register";

// Wording for the external-link button. "Details" is the neutral default; the
// rest exist because "sign up on our site" and "read more" are different asks
// and the button should say which one it is.
export const LINK_LABELS: Record<PostLinkLabel, string> = {
  details: "Details",
  sign_up: "Sign up",
  rsvp: "RSVP",
  apply: "Apply",
  register: "Register",
};

export const LINK_LABEL_KEYS: PostLinkLabel[] = ["details", "sign_up", "rsvp", "apply", "register"];

export type FeedSort = "new" | "soon" | "old";


export type FeedFilters = {
  org?: string;
  category?: FirmProgramCategory;
  type?: PostType;
  when?: "upcoming" | "past" | "all";
  school?: "mine" | "all";
  following?: boolean;
  sort?: FeedSort;
};

export type FeedPost = {
  id: string;
  type: PostType;
  title: string;
  body: string;
  category: FirmProgramCategory | null;
  orgName: string;
  /** Domain the poster's logo is looked up from - the firm's own website, the
   *  club's site, or failing that the club's school crest. Null when we have
   *  no real domain on record; the card falls back to an initial rather than
   *  guessing one. */
  orgDomain: string | null;
  location: string | null;
  linkUrl: string | null;
  linkLabel: PostLinkLabel;
  startsAt: Date | null;
  endsAt: Date | null;
  publishedAt: Date;
  schoolName: string | null;
  isMine: boolean;
};
