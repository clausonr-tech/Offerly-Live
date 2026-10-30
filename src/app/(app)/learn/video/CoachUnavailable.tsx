import { Wrench } from "lucide-react";

import type { UnavailableView } from "@/lib/video-interview/readiness";

/** The coach's "can't run right now" card. Detail lines only ever arrive in
 *  development (see readiness.unavailableView). */
export default function CoachUnavailable({ view }: { view: UnavailableView }) {
  return (
    <section role="status" className="list-panel flex gap-4 border border-brand-100 px-5 py-6 sm:px-6">
      <span className="mt-0.5 inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-50 text-accent-500">
        <Wrench size={18} aria-hidden />
      </span>
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-brand-900">{view.title}</h2>
        <p className="mt-1 text-sm text-warmgray-600">{view.body}</p>
        {view.detail && (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-brand-900">
            {view.detail.map((d) => (
              <li key={d} className="break-words">
                {d}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
