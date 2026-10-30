import Link from "next/link";
import { format } from "date-fns";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { emailDrafts } from "@/db/schema";
import { getCurrentUserId } from "@/lib/current-user";
import { draftLabel } from "@/lib/draft-templates";
import EmptyState from "@/components/EmptyState";

/**
 * Every email the student has drafted, most recently touched first.
 *
 * Its own page rather than a list under the Outreach form: that page is for
 * writing the next email, and a growing list beneath it pushed the thing the
 * student came to do out of view.
 */
export default async function PastEmailsPage() {
  const userId = await getCurrentUserId();
  const db = await getDb();

  const drafts = await db.query.emailDrafts.findMany({
    where: eq(emailDrafts.userId, userId),
    orderBy: [desc(emailDrafts.updatedAt)],
    columns: { id: true, kind: true, templateId: true, subject: true, updatedAt: true },
    with: { contact: { columns: { name: true, firm: true } } },
  });

  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/outreach" className="text-sm text-warmgray-500 hover:underline">
        ← Outreach
      </Link>
      <h1 className="mt-1 text-2xl font-semibold text-brand-900">Your past emails</h1>
      <p className="mt-1 text-sm text-warmgray-500">
        Open one to see what you entered and the draft as you last left it.
      </p>

      {drafts.length === 0 ? (
        <EmptyState className="mt-6">
          No emails yet.{" "}
          <Link href="/outreach/email" className="text-brand-900 underline">
            Draft your first one
          </Link>
          .
        </EmptyState>
      ) : (
        <div className="mt-6 divide-y divide-brand-100 overflow-hidden rounded-lg border border-brand-100 bg-white">
          {drafts.map((d) => (
            <Link
              key={d.id}
              href={`/drafts/${d.id}`}
              className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-brand-50"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-brand-900">{d.subject}</p>
                <p className="truncate text-xs text-warmgray-500">
                  {[d.contact?.name ?? "Unknown contact", d.contact?.firm].filter(Boolean).join(", ")} ·{" "}
                  {draftLabel(d.kind, d.templateId)}
                </p>
              </div>
              <span className="shrink-0 text-xs text-warmgray-500">Edited {format(d.updatedAt, "MMM d")}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
