import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { ChevronRight, FileText, Mail } from "lucide-react";
import { getDb } from "@/db/client";
import { emailDrafts, resumeReviews } from "@/db/schema";
import { getCurrentUser } from "@/lib/current-user";
import { getAllTasks } from "@/lib/today-tasks";
import type { TaskKind } from "@/lib/task-types";
import EmptyState from "@/components/EmptyState";
import TaskRow from "../dashboard/TaskRow";

export const metadata = { title: "Outreach" };

/** The to-do kinds that are an email to someone: who to write to next. */
const OUTREACH_KINDS: ReadonlySet<TaskKind> = new Set([
  "thank_you",
  "follow_up",
  "outreach",
  "draft",
  "coverage",
]);

/** How many people the hub lists before "See all", so the history cards
 *  below stay in view: a firm list with no contacts yet is dozens of rows. */
const SHOWN = 8;

/** Query params that address the email form rather than this hub. */
const FORM_PARAMS = ["contact", "occasion", "box", "thank"];

/**
 * Outreach: who to write to next, and the record of what has gone out.
 *
 * The two tools live beneath it in the rail - Email drafts at /outreach/email
 * and the Resume builder at /outreach/resume - the way Networking's views sit
 * under Networking. They used to be two tabs on this page.
 */
export default async function OutreachHub({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  // Every follow-up, thank-you and "Draft to" link in the app was built as
  // /outreach?contact=...&occasion=..., and Help linked ?tab=resume. They
  // still land where they meant to, with the rest of the query intact.
  if (params.tab === "resume") redirect("/outreach/resume");
  if (FORM_PARAMS.some((k) => typeof params[k] === "string")) {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (k !== "tab" && typeof v === "string") query.set(k, v);
    }
    redirect(`/outreach/email?${query}`);
  }

  const user = await getCurrentUser();
  const db = await getDb();

  const [tasks, drafts, reviews] = await Promise.all([
    getAllTasks(user),
    db.query.emailDrafts.findMany({ where: eq(emailDrafts.userId, user.id), columns: { id: true } }),
    db.query.resumeReviews.findMany({ where: eq(resumeReviews.userId, user.id), columns: { id: true } }),
  ]);
  // Already highest score first, the same order as the list on Opportunities.
  const toWrite = tasks.filter((t) => OUTREACH_KINDS.has(t.kind));
  const showAll = params.all === "1";
  const shown = showAll ? toWrite : toWrite.slice(0, SHOWN);

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-brand-900">Outreach</h1>
        <p className="mt-1 text-sm text-warmgray-500">
          The two things people see of you: what you send them, and what they read after.
        </p>
      </div>

      <section className="mb-8">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold text-brand-900">Who to reach out to</h2>
          <Link href="/outreach/email" className="shrink-0 text-sm font-medium text-brand-900 hover:underline">
            Write an email →
          </Link>
        </div>
        {toWrite.length === 0 ? (
          <EmptyState>
            Nobody is waiting on you. Follow-ups, thank-yous and people to contact show up here as they come due.
          </EmptyState>
        ) : (
          <ol className="list-panel divide-y divide-brand-100 overflow-hidden border border-brand-100">
            {shown.map((t, i) => (
              <TaskRow key={t.id} task={t} index={i} />
            ))}
          </ol>
        )}
        {toWrite.length > SHOWN && (
          <Link
            href={showAll ? "/outreach" : "/outreach?all=1"}
            scroll={false}
            className="mt-2 inline-block text-sm font-medium text-brand-900 hover:underline"
          >
            {showAll ? "Show fewer" : `See all ${toWrite.length} →`}
          </Link>
        )}
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <HistoryCard
          href="/drafts"
          Icon={Mail}
          title="Your past emails"
          detail={
            drafts.length === 0
              ? "Nothing drafted yet."
              : `${drafts.length} email${drafts.length === 1 ? "" : "s"}, with what you entered for each.`
          }
        />
        <HistoryCard
          href="/outreach/resume/history"
          Icon={FileText}
          title="Your past resumes"
          detail={
            reviews.length === 0
              ? "No resume reviewed yet."
              : `${reviews.length} review${reviews.length === 1 ? "" : "s"}, and how each scored.`
          }
        />
      </section>
    </div>
  );
}

function HistoryCard({
  href,
  Icon,
  title,
  detail,
}: {
  href: string;
  Icon: typeof Mail;
  title: string;
  detail: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-lg border border-brand-100 bg-white px-4 py-3 hover:border-brand-200 hover:bg-brand-50"
    >
      <Icon size={18} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-warmgray-500" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-brand-900">{title}</span>
        <span className="block text-xs text-warmgray-500">{detail}</span>
      </span>
      <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-warmgray-500" />
    </Link>
  );
}
