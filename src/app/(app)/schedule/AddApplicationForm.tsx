import { Plus } from "lucide-react";

// Deliberately three fields. The full editor lives at /applications/new; this
// is the "I just found something on a firm's site" path, and asking for status
// or compensation here would make that slower than not using it.
export default function AddApplicationForm({
  action,
}: {
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <div>
      <h2 className="mb-2 text-base font-semibold text-brand-900">Add an application</h2>
      <form
        action={action}
        className="flex flex-wrap items-end gap-3 rounded-lg border border-brand-100 bg-white p-4"
      >
        <label className="min-w-[9rem] flex-1">
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-warmgray-500">
            Firm
          </span>
          <input
            name="firm"
            required
            maxLength={120}
            placeholder="Moelis & Company"
            className="w-full border border-brand-200 bg-white px-3 py-2 text-sm text-brand-900 placeholder:text-warmgray-300 focus:border-accent-400 focus:outline-none"
          />
        </label>
        <label className="min-w-[9rem] flex-1">
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-warmgray-500">
            Role
          </span>
          <input
            name="role"
            required
            maxLength={160}
            placeholder="Summer Analyst"
            className="w-full border border-brand-200 bg-white px-3 py-2 text-sm text-brand-900 placeholder:text-warmgray-300 focus:border-accent-400 focus:outline-none"
          />
        </label>
        <label className="min-w-[11rem] flex-[1.4]">
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-warmgray-500">
            Application link (optional)
          </span>
          <input
            name="applicationUrl"
            type="url"
            placeholder="https://..."
            className="w-full border border-brand-200 bg-white px-3 py-2 text-sm text-brand-900 placeholder:text-warmgray-300 focus:border-accent-400 focus:outline-none"
          />
        </label>
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 bg-accent-500 px-4 py-2 text-sm font-semibold text-white hover:bg-accent-400"
        >
          <Plus size={14} />
          Track it
        </button>
      </form>
      <p className="mt-1.5 text-[11px] text-warmgray-500">
        Adds it to your tracking list and puts a dated reminder on your schedule - and on your
        Google Calendar if one is connected.
      </p>
    </div>
  );
}
