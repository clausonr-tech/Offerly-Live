import Link from "next/link";

import EmptyState from "@/components/EmptyState";
import type { TodayList as TodayListData } from "@/lib/today-list";

import LoadNextButton from "./LoadNextButton";
import TaskRow from "./TaskRow";

/**
 * The first thing on Opportunities: five things worth doing today.
 *
 * Five at a time, and they stay put. A finished task is crossed out in its
 * place instead of disappearing, so the list shows the day's progress. When
 * all five are crossed out, the next five are one click away, and the whole
 * list is always one link away - this panel earns its place at the top by
 * being short enough to read standing up.
 */
export default function TodayList({ list, timeZone }: { list: TodayListData; timeZone: string }) {
  // The student's day, not the server's: in UTC it is already tomorrow by
  // 8pm in New York.
  const today = new Date().toLocaleDateString(undefined, {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const doneCount = list.items.filter((i) => i.done).length;
  const next = Math.min(5, list.waiting);

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-brand-900">
          Today
          {list.items.length > 0 && (
            <span className="ml-2 text-xs font-normal text-warmgray-500">
              {doneCount} of {list.items.length} done
            </span>
          )}
        </h2>
        <span className="text-xs text-warmgray-500">{today}</span>
      </div>

      {list.items.length === 0 ? (
        <EmptyState>
          Nothing due today. Add a deadline or a coffee chat on your{" "}
          <Link href="/schedule" className="text-brand-900 hover:underline">
            Schedule
          </Link>{" "}
          and it will show up here.
        </EmptyState>
      ) : (
        <ol className="list-panel stagger-in divide-y divide-brand-100 overflow-hidden border border-brand-100">
          {list.items.map((t, i) => (
            <TaskRow key={t.id} task={t} index={i} done={t.done} />
          ))}
        </ol>
      )}

      {list.finished && (
        // The reward for clearing five, and the way to the next five. Only once
        // all five are done: loading more while some are open would bury them.
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#1e6b3a]/25 bg-[#e6f4ea] px-4 py-2.5 text-sm text-[#1e6b3a]">
          <span>
            {next > 0
              ? `All ${list.items.length} done.`
              : `All ${list.items.length} done. That's everything on your list for now.`}
          </span>
          {next > 0 && <LoadNextButton count={next} />}
        </div>
      )}

      {list.total > 0 && (
        <div className="mt-2 text-right">
          <Link href="/todo" className="text-xs font-medium text-brand-900 hover:underline">
            See everything ({list.total}) →
          </Link>
        </div>
      )}
    </div>
  );
}
