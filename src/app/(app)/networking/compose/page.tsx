import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/current-user";
import { canPostToFeed } from "@/lib/feed";
import PostComposer from "../PostComposer";

/** Posting, for club and firm accounts. */
export default async function ComposePage() {
  const user = await getCurrentUser();
  // The nav hides this tab for accounts that cannot post, but the route has to
  // refuse on its own too - a hidden link is not an access control.
  if (!canPostToFeed(user)) redirect("/networking");
  return <PostComposer />;
}
