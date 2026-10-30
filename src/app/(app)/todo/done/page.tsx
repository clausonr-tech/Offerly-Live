import Link from "next/link";

import EmptyState from "@/components/EmptyState";
import { getCurrentUser } from "@/lib/current-user";
import { getCompletedHistory } from "@/lib/today-list";

import TaskRow from "../../dashboard/TaskRow";

export const metadata = { title: "Completed" };

/**
 * Everything the student has finished, a day at a time.
 *
 * The to-do page keeps a finished task for a day; this is where it lives after
 * that, with the words it had and the day it was done, on the student's own
 * calendar. Read-only: nothing here needs doing.
 */
export default async function CompletedPage() {
  const user = await getCurrentUser();
  const days = await getCompletedHistory(user.id);
  const total = days.reduce((n, d) => n + d.items.length, 0);

  return (
    <div className="max-w-4xl">
      <header className="mb-6">
        <Link href="/todo" className="text-xs text-warmgray-500 hover:text-brand-900">
          ← Back to everything to do
        </Link>
        <h1 className="mt-1 text-2xl font-semibold text-brand-900">Completed</h1>
        <p className="mt-1 text-sm text-warmgray-500">
          {total === 0
            ? "Nothing finished yet."
            : `${total} task${total === 1 ? "" : "s"} done, most recent first.`}
        </p>
      </header>

      {days.length === 0 ? (
        <EmptyState>
          Tasks you finish on your to-do list land here, a day at a time.
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {days.map((day) => (
            <section key={day.day} aria-label={day.label}>
              <h2 className="mb-2 flex items-baseline justify-between text-sm font-semibold text-brand-900">
                <span>{day.label}</span>
                <span className="text-xs font-normal text-warmgray-500">
                  {day.items.length} done
                </span>
              </h2>
              <ol className="list-panel divide-y divide-brand-100 overflow-hidden border border-brand-100">
                {day.items.map((t, i) => (
                  <TaskRow key={t.id} task={t} index={i} done />
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
