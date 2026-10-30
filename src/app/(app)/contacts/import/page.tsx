import Link from "next/link";
import ImportForm from "./ImportForm";

export default function ImportContactsPage() {
  return (
    <div className="max-w-3xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-brand-900">Import contacts</h1>
          <p className="mt-1 text-sm text-warmgray-500">
            Bring in contacts from a CSV file - no retyping.
          </p>
        </div>
        <Link href="/contacts" className="text-sm text-warmgray-500 hover:underline">
          Cancel
        </Link>
      </div>
      <ImportForm />
    </div>
  );
}
