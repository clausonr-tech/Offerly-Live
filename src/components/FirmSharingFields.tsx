import { FIRM_SHARING_NOT_SHARED, FIRM_SHARING_SHARED } from "@/lib/policy";

/**
 * The "share my profile with firms" checkbox and exactly what it means.
 *
 * One component for every place a student is asked - the last onboarding
 * step, the consent screen after a policy change, and Settings - so the
 * question and its fine print cannot drift apart between them. Submits as
 * `shareWithFirms=on` when ticked; unticked is the default and means no.
 */
export default function FirmSharingFields({ defaultChecked = false }: { defaultChecked?: boolean }) {
  return (
    <div className="border border-brand-100 bg-white px-4 py-3.5">
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          name="shareWithFirms"
          defaultChecked={defaultChecked}
          className="mt-1 h-4 w-4 shrink-0 accent-[#0b1526]"
        />
        <span>
          <span className="block text-sm font-medium text-brand-900">
            Share my profile with firms so recruiters can reach out
          </span>
          <span className="mt-0.5 block text-xs leading-relaxed text-warmgray-500">
            Optional. Verified recruiters at firms on Offerly could find you and contact you by
            message on Offerly, by email or on LinkedIn. You can turn this off any time in Settings.
          </span>
        </span>
      </label>
      <div className="mt-3 grid gap-3 pl-7 text-xs leading-relaxed text-warmgray-600 sm:grid-cols-2">
        <div>
          <p className="font-medium text-brand-900">Firms would see</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {FIRM_SHARING_SHARED.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        <div>
          <p className="font-medium text-brand-900">Firms never see</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {FIRM_SHARING_NOT_SHARED.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
