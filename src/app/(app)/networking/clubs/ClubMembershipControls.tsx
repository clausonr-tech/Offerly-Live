"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserPlus, X } from "lucide-react";

import { addMemberAction, leaveClubAction, removeMemberAction, searchStudentsAction } from "./actions";

/** A member leaving. The only membership change a non-officer can make. */
export function LeaveClubButton({ clubId, slug }: { clubId: string; slug: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!confirm("Leave this club? Only the president can add you back.")) return;
        start(async () => {
          await leaveClubAction({ clubId, slug });
          router.refresh();
        });
      }}
      className="rounded-md border border-brand-200 px-4 py-2 text-xs font-semibold text-warmgray-600 hover:border-red-200 hover:text-red-600 disabled:opacity-60"
    >
      {pending ? "Leaving..." : "Leave club"}
    </button>
  );
}

/** The president's box: find a student by name and add them. */
export function AddMemberBox({ clubId, slug }: { clubId: string; slug: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; name: string; school: string | null; gradYear: number | null }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const seq = useRef(0);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      const rows = await searchStudentsAction({ clubId, query: term }).catch(() => []);
      if (mine === seq.current) setResults(rows);
    }, 200);
    return () => clearTimeout(t);
  }, [query, clubId]);

  const shown = query.trim().length >= 2 ? results : [];

  return (
    <div className="rounded-lg border border-brand-100 bg-white p-4">
      <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-brand-900">
        <UserPlus size={15} aria-hidden />
        Add a member
      </p>
      <p className="mb-2 text-xs text-warmgray-500">You&apos;re the president, so you decide who is in the club.</p>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search students by name"
        aria-label="Search students to add"
        className="w-full rounded-md border border-brand-200 bg-white px-3 py-2 text-sm text-brand-900 focus:border-accent-500 focus:outline-none"
      />
      {shown.length > 0 && (
        <ul className="mt-2 divide-y divide-brand-100 rounded-md border border-brand-100">
          {shown.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-brand-900">{r.name}</p>
                <p className="truncate text-xs text-warmgray-500">
                  {r.school ?? "School not set"}
                  {r.gradYear ? ` · Class of ${r.gradYear}` : ""}
                </p>
              </div>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const res = await addMemberAction({ clubId, slug, userId: r.id });
                    setError(res.error ?? null);
                    if (!res.error) {
                      setQuery("");
                      setResults([]);
                      router.refresh();
                    }
                  })
                }
                className="rounded-md bg-accent-600 px-3 py-1.5 text-xs font-semibold text-[#ffffff] hover:bg-accent-500 disabled:opacity-60"
              >
                Add
              </button>
            </li>
          ))}
        </ul>
      )}
      {query.trim().length >= 2 && shown.length === 0 && (
        <p className="mt-2 text-xs text-warmgray-500">No students match that name who aren&apos;t already members.</p>
      )}
      {error && <p className="mt-2 text-xs text-error-600">{error}</p>}
    </div>
  );
}

/** On each member's card, for the president only. */
export function RemoveMemberButton({ clubId, slug, userId, name }: { clubId: string; slug: string; userId: string; name: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <button
      type="button"
      disabled={pending}
      aria-label={`Remove ${name} from the club`}
      title={`Remove ${name}`}
      onClick={() => {
        if (!confirm(`Remove ${name} from the club?`)) return;
        start(async () => {
          await removeMemberAction({ clubId, slug, userId });
          router.refresh();
        });
      }}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-brand-200 text-warmgray-500 transition-colors hover:border-red-200 hover:text-red-600 disabled:opacity-60"
    >
      <X size={14} aria-hidden />
    </button>
  );
}
