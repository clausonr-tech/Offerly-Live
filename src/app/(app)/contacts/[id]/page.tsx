import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { contacts } from "@/db/schema";
import { getCurrentUser } from "@/lib/current-user";
import { computeRelevanceScore, hasProfileSignal } from "@/lib/relevance";
import { externalHref } from "@/lib/safe-url";
import ContactForm from "../ContactForm";
import { DraftEmailButton } from "../../drafts/QuickDraft";
import {
  deleteContact,
  updateContact,
} from "../actions";
import EmptyState from "@/components/EmptyState";

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUser();
  const db = await getDb();

  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, id), eq(contacts.userId, user.id)),
  });

  if (!contact) notFound();

  const boundUpdate = updateContact.bind(null, contact.id);
  const boundDelete = deleteContact.bind(null, contact.id);

  const relevance = computeRelevanceScore(user, contact);
  // Read-boundary guard - sourceUrl is written by the sourcing run from a
  // third-party provider's response, never typed by the student. See
  // lib/safe-url; a refused value shows no "Sourced from" line, exactly as a
  // hand-added contact with no source already does.
  const sourceHref = externalHref(contact.sourceUrl);

  return (
    <div className="max-w-2xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link href="/contacts" className="text-sm text-warmgray-500 hover:underline">
            ← Industry Contacts
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-brand-900">
            {contact.name}
          </h1>
          {sourceHref && (
            <a
              href={sourceHref}
              target="_blank"
              rel="noreferrer"
              className="mt-1 flex items-center gap-1 text-xs text-warmgray-500 hover:text-brand-900"
            >
              <ExternalLink size={11} />
              Sourced from the firm&apos;s official site
            </a>
          )}
          <div className="mt-2">
            <DraftEmailButton recipientKey={`contact-${contact.id}`} name={contact.name} />
          </div>
        </div>
        <form action={boundDelete}>
          <button
            type="submit"
            className="rounded-md border border-error-200 px-3 py-1.5 text-sm font-medium text-error-600 hover:bg-error-50"
          >
            Delete
          </button>
        </form>
      </div>

      {!hasProfileSignal(user) ? (
        <EmptyState size="sm" className="mb-4">
          Fill in your{" "}
          <Link href="/profile/interests" className="text-brand-900 hover:underline">
            profile
          </Link>{" "}
          (school, hometown, interests) to see relevance matches here.
        </EmptyState>
      ) : relevance.reasons.length > 0 ? (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {relevance.reasons.map((r) => (
            <span
              key={r}
              className="rounded-sm border border-success-200 bg-success-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-success-800"
            >
              {r}
            </span>
          ))}
        </div>
      ) : null}

      <ContactForm action={boundUpdate} defaultValues={contact} submitLabel="Save changes" />
    </div>
  );
}
