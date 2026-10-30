import Link from "next/link";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { contacts } from "@/db/schema";
import { getCurrentUserId } from "@/lib/current-user";
import ApplicationForm from "../ApplicationForm";
import { createApplication } from "../actions";

export default async function NewApplicationPage() {
  const userId = await getCurrentUserId();
  const db = await getDb();
  const contactOptions = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    columns: { id: true, name: true, firm: true },
  });

  return (
    <div className="max-w-2xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-brand-900">Add application</h1>
        <Link href="/dashboard" className="text-sm text-warmgray-500 hover:underline">
          Cancel
        </Link>
      </div>
      <ApplicationForm
        action={createApplication}
        contactOptions={contactOptions}
        submitLabel="Add application"
      />
    </div>
  );
}
