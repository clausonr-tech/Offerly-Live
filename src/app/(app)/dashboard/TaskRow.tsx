"use client";

import Link from "next/link";
import { Check } from "lucide-react";
import { useState, useTransition } from "react";

import { LABEL_TONES } from "@/lib/label-colors";
import { TASK_LABELS, type TodayTask } from "@/lib/task-types";

import { completeTask } from "./todo-actions";

type RowTask = Pick<TodayTask, "id" | "kind" | "title" | "detail" | "href">;

/**
 * One task: its number, what it is, and a tick.
 *
 * Done - ticked here, or finished elsewhere so the app stopped listing it -
 * it stays where it was, crossed out, rather than disappearing: the list is a
 * record of the day's progress as well as of what is left. The tick answers
 * at once; the server records it and the page catches up.
 */
export default function TaskRow({
  task,
  index,
  done: doneOnServer = false,
}: {
  task: RowTask;
  index: number;
  done?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [tickedHere, setTickedHere] = useState(false);
  const done = doneOnServer || tickedHere;

  return (
    <li className="flex items-center">
      <Link
        href={task.href}
        aria-disabled={done}
        className={`flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 transition-opacity ${
          done ? "opacity-55" : "hover:bg-brand-50"
        }`}
      >
        <span className="w-4 shrink-0 text-xs tabular-nums text-warmgray-500">{index + 1}</span>
        {/* One width for every kind, so each title starts at the same x
            whatever the chip says - THANK and NETWORK used to push theirs to
            different places. Its colour is its kind's (lib/label-colors). */}
        <span
          className="w-[5.25rem] shrink-0 rounded-sm px-1.5 py-px text-center text-[10px] font-semibold uppercase tracking-wide"
          style={{ background: LABEL_TONES[task.kind].bg, color: LABEL_TONES[task.kind].fg }}
        >
          {TASK_LABELS[task.kind]}
        </span>
        <span className="min-w-0 flex-1">
          <span
            // Two lines, not one: in External Network's right-hand column a
            // single truncated line cut most event names off after two words.
            className={`line-clamp-2 text-sm font-medium leading-snug text-brand-900 ${done ? "line-through decoration-1" : ""}`}
          >
            {task.title}
          </span>
          <span className={`block truncate text-[11px] text-warmgray-500 ${done ? "line-through" : ""}`}>
            {task.detail}
          </span>
        </span>
        {!done && <span className="shrink-0 text-warmgray-500">→</span>}
      </Link>
      {/* Outside the link: ticking it off is not following it. */}
      <button
        type="button"
        disabled={pending || done}
        aria-pressed={done}
        aria-label={done ? `"${task.title}" is done` : `Mark "${task.title}" as done`}
        title={done ? "Done" : "Mark as done"}
        onClick={() =>
          startTransition(async () => {
            setTickedHere(true);
            await completeTask(task.id);
          })
        }
        className={`mr-3 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors ${
          done
            ? "border-[#1e6b3a] bg-[#1e6b3a] text-[#ffffff]"
            : "border-brand-200 text-warmgray-500 hover:border-brand-900 hover:text-brand-900"
        }`}
      >
        <Check size={13} strokeWidth={2.25} />
      </button>
    </li>
  );
}
