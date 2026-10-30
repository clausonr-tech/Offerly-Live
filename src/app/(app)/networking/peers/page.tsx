import Link from "next/link";

import LogoAvatar from "@/components/feed/LogoAvatar";
import { getCurrentUserId } from "@/lib/current-user";
import { getIncomingPeerRequests, getPeerCounts, getPeers } from "@/lib/peers";

import AddPeerButton from "../AddPeerButton";
import EmptyState from "@/components/EmptyState";

export const metadata = { title: "Peers" };

/** "Alex Morgan" -> "AM". Two letters at most; a third is noise at 32px. */
function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

type Person = {
  id: string;
  name: string | null;
  school: string | null;
  gradYear: number | null;
  avatarStoragePath: string | null;
};

function PersonRow({
  person,
  peerCount,
  state,
}: {
  person: Person;
  peerCount: number;
  state: "peers" | "added_you";
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <LogoAvatar
        domain={null}
        label={person.school}
        initials={initials(person.name ?? "A student")}
        photoUrl={person.avatarStoragePath}
        size={32}
      />
      <div className="min-w-0 flex-1">
        <Link
          href={`/u/${person.id}`}
          prefetch={false}
          className="block truncate text-sm font-medium text-brand-900 hover:underline"
        >
          {person.name ?? "A student"}
        </Link>
        <p className="truncate text-xs text-warmgray-500">
          {person.school ?? "School not set"}
          {person.gradYear ? ` · Class of ${person.gradYear}` : ""}
          {peerCount > 0 && ` · ${peerCount} peer${peerCount === 1 ? "" : "s"}`}
        </p>
      </div>
      <AddPeerButton userId={person.id} state={state} />
    </li>
  );
}

/**
 * Peers: the people this student actually knows, and the ones waiting on them.
 *
 * Requests lead. A pending request is the only thing on this page that needs a
 * decision, and burying it under a list of settled relationships is how it
 * gets missed - which for a mutual relationship means the pair silently never
 * forms.
 */
export default async function PeersPage() {
  const viewerId = await getCurrentUserId();
  const [peers, incoming] = await Promise.all([
    getPeers(viewerId),
    getIncomingPeerRequests(viewerId),
  ]);
  const counts = await getPeerCounts([...peers, ...incoming].map((p) => p.id));

  return (
    <div className="max-w-2xl">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-brand-900">Peers</h1>
        <p className="mt-1 text-sm text-warmgray-500">
          People you both added. Following someone is one-way and says you want to read their
          activity; a peer is mutual and says you know each other.
        </p>
      </header>

      {incoming.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-2 text-sm font-medium text-warmgray-500">
            Waiting on you ({incoming.length})
          </h2>
          <ul className="list-panel ui-round-md divide-y divide-brand-100 overflow-hidden border border-brand-100">
            {incoming.map((p) => (
              <PersonRow key={p.id} person={p} peerCount={counts.get(p.id) ?? 0} state="added_you" />
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-medium text-warmgray-500">
          Your peers ({peers.length})
        </h2>
        {peers.length === 0 ? (
          <EmptyState>
            Nobody yet. Find people on{" "}
            <Link href="/networking/connect" className="underline">
              Connect
            </Link>{" "}
            and use <span className="whitespace-nowrap">Add +</span> — you become peers once they
            add you back.
          </EmptyState>
        ) : (
          <ul className="list-panel ui-round-md divide-y divide-brand-100 overflow-hidden border border-brand-100">
            {peers.map((p) => (
              <PersonRow key={p.id} person={p} peerCount={counts.get(p.id) ?? 0} state="peers" />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
