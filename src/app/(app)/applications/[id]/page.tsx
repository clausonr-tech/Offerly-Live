import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { applicationContacts, applications, contacts, internshipPostings } from "@/db/schema";
import { getCurrentUserId } from "@/lib/current-user";
import ApplicationForm from "../ApplicationForm";
import { deleteApplication, updateApplication } from "../actions";
import { externalHref } from "@/lib/safe-url";

export default async function ApplicationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const userId = await getCurrentUserId();
  const db = await getDb();

  const application = await db.query.applications.findFirst({
    where: and(eq(applications.id, id), eq(applications.userId, userId)),
  });
  if (!application) notFound();

  // When this application's link is a directory posting's, the click goes
  // through the same counter as the Apply button on Discovery, so the firm's
  // analytics see it. A link the student typed that matches no posting is
  // left exactly as it is.
  const posting = application.applicationUrl
    ? await db.query.internshipPostings.findFirst({
        where: eq(internshipPostings.applicationUrl, application.applicationUrl),
        columns: { id: true },
      })
    : null;
  const trackedApply = posting ? `/api/postings/${posting.id}/apply` : null;
  // Read-boundary guard. TrackToggle guards what it WRITES and the dashboard
  // guards what it READS, but this page rendered the stored string raw - and a
  // row written before that rule existed, or typed into the form before
  // applicationSchema checked the scheme, is exactly the row worth stopping.
  // One call covers both branches: externalHref passes an in-app path like the
  // tracked route straight through. See lib/safe-url.
  const applyHref = externalHref(trackedApply ?? application.applicationUrl);

  const [contactOptions, links] = await Promise.all([
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      columns: { id: true, name: true, firm: true },
    }),
    db.query.applicationContacts.findMany({
      where: eq(applicationContacts.applicationId, application.id),
      columns: { contactId: true },
    }),
  ]);

  const boundUpdate = updateApplication.bind(null, application.id);
  const boundDelete = deleteApplication.bind(null, application.id);

  return (
    <div className="max-w-2xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link href="/dashboard" className="text-sm text-warmgray-500 hover:underline">
            ← External Network
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-brand-900">
            {application.firm} - {application.role}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {applyHref && (
            <a
              href={applyHref}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-md bg-accent-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-accent-400 shadow-card"
            >
              Click here to open the application
              <ExternalLink size={14} />
            </a>
          )}
          <form action={boundDelete}>
            <button
              type="submit"
              className="rounded-md border border-error-200 px-3 py-1.5 text-sm font-medium text-error-600 hover:bg-error-50"
            >
              Delete
            </button>
          </form>
        </div>
      </div>
      <ApplicationForm
        action={boundUpdate}
        defaultValues={application}
        contactOptions={contactOptions}
        linkedContactIds={links.map((l) => l.contactId)}
        submitLabel="Save changes"
      />
    </div>
  );
}
