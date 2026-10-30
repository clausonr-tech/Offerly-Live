import { notFound } from "next/navigation";

import { getCurrentUserId } from "@/lib/current-user";
import { getPublicProfile } from "@/lib/people";
import MessagesView from "../MessagesView";

export const metadata = { title: "Messages" };

/** The inbox with one conversation open - opening it marks it read. */
export default async function ThreadPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const viewerId = await getCurrentUserId();
  if (userId === viewerId) notFound();
  if (!(await getPublicProfile(userId, viewerId))) notFound();
  return <MessagesView viewerId={viewerId} selectedId={userId} />;
}
