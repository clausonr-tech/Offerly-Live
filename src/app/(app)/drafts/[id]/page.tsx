import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { emailDrafts } from "@/db/schema";
import { getCurrentUserId } from "@/lib/current-user";
import { draftAttachesResume, draftLabel, emailTypeById } from "@/lib/draft-templates";
import { findStudentResume } from "@/lib/resume-file";
import { deleteDraft, type DraftInput } from "../actions";
import Composer from "../Composer";

export default async function DraftDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const userId = await getCurrentUserId();
  const db = await getDb();

  const draft = await db.query.emailDrafts.findFirst({
    where: and(eq(emailDrafts.id, id), eq(emailDrafts.userId, userId)),
    with: { contact: { columns: { name: true, email: true } } },
  });
  if (!draft) notFound();

  const attachesResume = draftAttachesResume(emailTypeById(draft.templateId), draft.kind, draft.body);
  const resume = attachesResume ? await findStudentResume(userId) : null;
  const boundDelete = deleteDraft.bind(null, draft.id);

  // Written by this app as DraftInput[]; null for drafts from before inputs
  // were kept, which fall back to the one note that was saved then.
  const inputs: DraftInput[] = Array.isArray(draft.inputs)
    ? (draft.inputs as DraftInput[])
    : draft.purpose
      ? [{ label: "What you said this email was for", value: draft.purpose }]
      : [];

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link href="/drafts" className="text-sm text-warmgray-500 hover:underline">
            ← Past emails
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-brand-900">
            {draft.contact?.name ?? "Draft"}
          </h1>
          <p className="text-sm text-warmgray-500">
            {draftLabel(draft.kind, draft.templateId)} · Drafted {format(draft.createdAt, "MMM d, yyyy")}
          </p>
          {attachesResume && !resume && (
            <p className="mt-0.5 text-xs text-warmgray-500">
              No resume on file to attach. Upload one from your profile.
            </p>
          )}
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

      <section className="mb-6 rounded-lg border border-brand-100 bg-white p-4">
        <h2 className="text-sm font-semibold text-brand-900">What you entered</h2>
        {inputs.length > 0 ? (
          <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-[minmax(0,12rem)_1fr]">
            {inputs.map((input, i) => (
              <div key={i} className="contents">
                <dt className="text-xs text-warmgray-500">{input.label}</dt>
                <dd className="whitespace-pre-wrap text-sm text-brand-900">{input.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="mt-1 text-xs text-warmgray-500">
            This email was drafted before Offerly kept what you entered.
          </p>
        )}
      </section>

      <Composer
        draft={{
          id: draft.id,
          to: draft.contact?.email ?? "",
          contactName: draft.contact?.name ?? "",
          subject: draft.subject,
          body: draft.body,
          attachmentName: resume?.filename ?? null,
          sentAt: draft.sentAt?.toISOString() ?? null,
        }}
      />
    </div>
  );
}
