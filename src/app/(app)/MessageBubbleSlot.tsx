import { getThreads } from "@/lib/people";
import MessageBubble from "./MessageBubble";

/**
 * The floating message bubble, fetched off the critical path.
 *
 * The layout used to `await getThreads(...)` inline, which meant every page in
 * the app - Opportunities, News, Interview Prep, all of them - waited on a
 * messages query before a single byte of HTML went out. Measured at ~590ms
 * against the remote database, for a badge in the bottom-right corner.
 *
 * Split into its own async component so the layout can wrap it in Suspense:
 * the page streams immediately and the bubble arrives when its query lands.
 * The fallback is deliberately `null` rather than a skeleton - this is a
 * floating ornament, and a placeholder pulsing in the corner of every page
 * would draw more attention than the thing it stands in for.
 */
export default async function MessageBubbleSlot({ userId }: { userId: string }) {
  const unreadThreads = (await getThreads(userId)).filter((t) => t.unread);
  return <MessageBubble unreadThreads={unreadThreads} />;
}
