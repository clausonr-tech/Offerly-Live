// What a to-do task is, and what each kind is called on screen.
//
// Its own module with no imports, so the client components that draw a task
// can use it: lib/today-tasks.ts, which builds the tasks, is server-only.

export type TaskKind =
  | "deadline"
  | "event"
  | "follow_up"
  | "draft"
  | "coverage"
  | "outreach"
  | "interview"
  | "thank_you"
  | "apply";

export type TodayTask = {
  id: string;
  kind: TaskKind;
  title: string;
  detail: string;
  href: string;
  /** Higher is more urgent. Only used for ordering. */
  score: number;
  /**
   * Set on a row the student can tick off by hand without doing it through
   * the app - a thank-you they sent from their phone. The notification key
   * the tick closes.
   */
  doneKey?: string;
};


export const TASK_LABELS: Record<TaskKind, string> = {
  deadline: "Deadline",
  event: "Today",
  follow_up: "Follow up",
  draft: "Send",
  coverage: "Network",
  outreach: "Outreach",
  interview: "Prep",
  thank_you: "Thank",
  apply: "Apply",
};
