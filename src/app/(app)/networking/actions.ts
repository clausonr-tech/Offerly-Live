"use server";

import { blockedLanguageError } from "@/lib/content-limits";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { posts } from "@/db/schema";
import { getCurrentUser, getCurrentUserId } from "@/lib/current-user";
import { canPostToFeed, posterOrg } from "@/lib/feed";
import { postSchema } from "@/lib/validation";
import { CATEGORY_LABELS } from "@/lib/firm-metadata";
import { normaliseHttpUrl } from "@/lib/safe-url";
import { followTarget, isFollowTarget, unfollowTarget } from "@/lib/follows";
import { rateLimit } from "@/lib/rate-limit";
import type { FirmProgramCategory } from "@/lib/firm-metadata";

export type PostActionState = { error?: string } | undefined;

// Datetime-local inputs submit "2026-09-04T18:00" with no zone. new Date()
// reads that as local time, which is what the poster meant.
function parseDateTime(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function createPost(
  _prevState: PostActionState,
  formData: FormData,
): Promise<PostActionState> {
  const user = await getCurrentUser();

  // The real gate. The composer is already hidden from students, but this is
  // the check that matters - a student POSTing this action directly lands
  // here, not on the UI.
  const org = posterOrg(user);
  if (!canPostToFeed(user) || !org) {
    return { error: "Your account isn't approved to post to the feed." };
  }

  const blocked = blockedLanguageError([
    ["Title", formData.get("title")],
    ["Post", formData.get("body")],
    ["Location", formData.get("location")],
    ["Link label", formData.get("linkLabel")],
  ]);
  if (blocked) return { error: blocked };

  const parsed = postSchema.safeParse({
    type: formData.get("type"),
    title: formData.get("title"),
    body: formData.get("body"),
    category: formData.get("category") ?? "",
    location: formData.get("location") ?? "",
    linkUrl: formData.get("linkUrl") ?? "",
    linkLabel: formData.get("linkLabel") || "details",
    startsAt: formData.get("startsAt") ?? "",
    endsAt: formData.get("endsAt") ?? "",
    schoolScope: formData.get("schoolScope") ?? "all",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  // Reject an unknown category rather than writing it - the column is an
  // enum, so a bad value would fail at the driver with an opaque error.
  const category =
    data.category && data.category in CATEGORY_LABELS
      ? (data.category as FirmProgramCategory)
      : null;

  // A link is optional, but a link that was typed and cannot be used is a
  // mistake worth surfacing rather than silently dropping - the poster would
  // otherwise publish a "Sign up" button that goes nowhere.
  const linkUrl = normaliseHttpUrl(data.linkUrl ?? "");
  if (data.linkUrl && !linkUrl) {
    return { error: "That link doesn't look like a valid web address." };
  }

  const startsAt = parseDateTime(data.startsAt ?? "");
  const endsAt = parseDateTime(data.endsAt ?? "");
  if (endsAt && startsAt && endsAt < startsAt) {
    return { error: "The end time is before the start time." };
  }
  // Everything except a plain announcement is a thing that happens at a time.
  if (data.type !== "announcement" && !startsAt) {
    return { error: "Add a date and time for this event." };
  }

  const db = await getDb();
  await db.insert(posts).values({
    authorUserId: user.id,
    clubId: org.clubId,
    firmId: org.firmId,
    type: data.type,
    title: data.title,
    body: data.body,
    category,
    // Verified school first, claimed school as the fallback - same precedence
    // the rest of the app uses. Null means "open to every school".
    schoolId: data.schoolScope === "own" ? (user.schoolId ?? user.claimedSchoolId ?? null) : null,
    location: data.location || null,
    linkUrl,
    linkLabel: data.linkLabel,
    startsAt,
    endsAt,
    // Written from JS rather than left to the column's defaultNow(). The
    // feed compares this against the server's clock to render "2 hours ago",
    // and PGlite runs its session in a fixed Etc/GMT+5 zone - so a DB-filled
    // value lands on a different instant than every other date here (which
    // are all parsed in JS) and a brand-new post reads as hours old.
    publishedAt: new Date(),
  });

  revalidatePath("/networking");
  return undefined;
}

// ---------- follows ----------

/** Follows a student can turn over in an hour. A real student clicking down a
 *  directory page tops out in the dozens; anything near this is a loop. */
const FOLLOW_LIMIT = 300;
const FOLLOW_WINDOW_MS = 60 * 60_000;

export async function toggleFollow(input: {
  kind: "user" | "club" | "firm";
  id: string;
  following: boolean;
}): Promise<void> {
  const viewerId = await getCurrentUserId();
  // The typed signature is a promise about our own callers, not about the
  // request: this is a server action, so `input` is whatever JSON the browser
  // posted. An unknown kind used to reach the follows table as a row with no
  // target at all - see isFollowTarget. Silent, like the rest of this action:
  // the only way to get here with a bad kind is to hand-make the request.
  const target = { kind: input.kind, id: input.id };
  if (!isFollowTarget(target)) return;

  // Bound on the way IN, not per row written: a toggle loop that alternates
  // follow and unfollow writes nothing lasting but still costs a round trip
  // each, so both halves are counted.
  const gate = await rateLimit("follow:toggle", viewerId, FOLLOW_LIMIT, FOLLOW_WINDOW_MS);
  if (!gate.allowed) return;

  if (input.following) {
    await unfollowTarget(viewerId, target);
  } else {
    await followTarget(viewerId, target);
  }
  revalidatePath("/networking");
}
