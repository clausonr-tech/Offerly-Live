import { getNotifications } from "@/lib/notifications";

import { toneForNotification } from "@/lib/label-colors";

import NotificationBell, { type BellItem } from "./NotificationBell";

/** "3d", "just now" - short enough for the corner of a row. */
function relative(when: Date, now: Date): string {
  const mins = Math.round((now.getTime() - when.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * The bell, fetched off the critical path.
 *
 * Streamed like the message bubble: the rail paints immediately and the bell
 * arrives when its query lands. Rendering nothing while it loads is right -
 * a count that appears and then changes is worse than one that appears once.
 */
export default async function NotificationSlot({ userId }: { userId: string }) {
  const now = new Date();
  const list = await getNotifications(userId, now);
  const toItem = (i: (typeof list.open)[number]): BellItem => ({
    id: i.id,
    title: i.title,
    body: i.body,
    href: i.href,
    when: relative(i.bumpedAt, now),
    read: i.read,
    tone: toneForNotification(i.kind),
    logo: i.firm,
    subline: i.subline,
  });

  return <NotificationBell items={list.open.map(toItem)} unreadCount={list.unreadCount} />;
}
