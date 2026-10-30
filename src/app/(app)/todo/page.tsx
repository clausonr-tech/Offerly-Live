import Link from "next/link";

import EmptyState from "@/components/EmptyState";
import { getCurrentUser } from "@/lib/current-user";
import { getEverything } from "@/lib/today-list";

import TaskRow from "../dashboard/TaskRow";

export const metadata = { title: "Everything to do" };

/**
 * The whole to-do list - "See everything" from the five on Opportunities.
 *
 * Same tasks, same order, same tick: the five on the dashboard are the top of
 * this list. Below it, what was finished in the last day, crossed out; after a
 * day a finished task lives only in the completed history (/todo/done).
 */
export default async function TodoPage() {
  const user = await getCurrentUser();
  const { open, recentlyDone, completedCount } = await getEverything(user);

  return (
    <div className="max-w-4xl">
      <header className="mb-6">
        <Link href="/dashboard" className="text-xs text-warmgray-500 hover:text-brand-900">
          ← Back to External Network
        </Link>
        <h1 className="mt-1 text-2xl font-semibold text-brand-900">Everything to do</h1>
        <p className="mt-1 text-sm text-warmgray-500">
          {open.length === 0
            ? "Nothing outstanding."
            : `${open.length} task${open.length === 1 ? "" : "s"}, most urgent first. Your five on External Network are the top of this list.`}
        </p>
      </header>

      {open.length === 0 ? (
        <EmptyState>
          Nothing to do right now. Tasks show up here when an interview, a follow-up, a thank-you or a
          deadline comes up.
        </EmptyState>
      ) : (
        <ol className="list-panel divide-y divide-brand-100 overflow-hidden border border-brand-100">
          {open.map((t, i) => (
            <TaskRow key={t.id} task={t} index={i} />
          ))}
        </ol>
      )}

      {recentlyDone.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-warmgray-500">
            Done in the last day ({recentlyDone.length})
          </h2>
          <ol className="list-panel divide-y divide-brand-100 overflow-hidden border border-brand-100">
            {recentlyDone.map((t, i) => (
              <TaskRow key={t.id} task={t} index={i} done />
            ))}
          </ol>
        </section>
      )}

      {completedCount > 0 && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-brand-100 px-4 py-3 text-sm">
          <span className="text-warmgray-500">
            Finished tasks stay here for a day, then move to your history.
          </span>
          <Link href="/todo/done" className="shrink-0 font-medium text-brand-900 hover:underline">
            See all completed ({completedCount}) →
          </Link>
        </div>
      )}
    </div>
  );
}
