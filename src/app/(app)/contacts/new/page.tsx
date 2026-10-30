import Link from "next/link";
import ContactForm from "../ContactForm";
import { createContact } from "../actions";

export default async function NewContactPage({
  searchParams,
}: {
  searchParams: Promise<{ firm?: string; role?: string }>;
}) {
  const { firm, role } = await searchParams;

  return (
    <div className="max-w-2xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-brand-900">Add contact</h1>
        <Link href="/contacts" className="text-sm text-warmgray-500 hover:underline">
          Cancel
        </Link>
      </div>
      <ContactForm action={createContact} submitLabel="Add contact" defaultValues={{ firm, role }} />
    </div>
  );
}
