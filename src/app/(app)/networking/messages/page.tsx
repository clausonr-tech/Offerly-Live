import { getCurrentUserId } from "@/lib/current-user";
import MessagesView from "../../messages/MessagesView";

export const metadata = { title: "Messages" };

/** The inbox with no conversation open. /messages/[userId] opens one. */
export default async function CommunityMessagesPage() {
  const viewerId = await getCurrentUserId();
  return <MessagesView viewerId={viewerId} selectedId={null} />;
}
