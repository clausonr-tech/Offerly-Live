import Link from "next/link";

import EmptyState from "@/components/EmptyState";
import { getCurrentUser } from "@/lib/current-user";
import { getNotifications } from "@/lib/notifications";

import NotificationTask from "./NotificationTask";

export const metadata = { title: "Notifications" };

/**
 * Everything the app is asking this student to do, at full width.
 *
 * The bell is the glance; this is the sit-down. Same rows, same order, but with
 * room for the thing the dropdown has no space for: how far through each job
 * they already are, and therefore whether it is one the app will close by
 * itself or one only they can answer for.
 *
 * Finished work is not here, and is not anywhere. A to-do list that keeps its
 * own history stops being a to-do list.
 */
export default async function NotificationsPage({
  searchParams,
}: {
  // Set by the bell: the job that was clicked, to land on and highlight.
  searchParams: Promise<{ focus?: string }>;
}) {
  const { focus } = await searchParams;
  const user = await getCurrentUser();
  const { open } = await getNotifications(user.id);

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-brand-900">What needs doing</h1>
        <p className="mt-1 text-sm text-warmgray-500">
          {open.length === 0
            ? "Everything the app has asked you to do is done."
            : `${open.length} outstanding. Each one closes itself once you have finished it, or you can tick it off.`}
        </p>
      </header>

      {open.length === 0 ? (
        <EmptyState>
          Nothing outstanding. Prompts land here when an application is coming up
          at a firm where you know people, and stay until the work is done.{" "}
          <Link href="/dashboard" className="text-brand-900 hover:underline">
            Back to External Network
          </Link>
        </EmptyState>
      ) : (
        <ul className="list-panel stagger-in divide-y divide-brand-100 overflow-hidden border border-brand-100">
          {open.map((item) => (
            <NotificationTask
              key={item.id}
              id={item.id}
              title={item.title}
              body={item.body}
              href={item.href}
              progress={item.progress}
              kind={item.kind}
              focused={item.id === focus}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
