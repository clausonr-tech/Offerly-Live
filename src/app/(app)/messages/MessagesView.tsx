import Link from "next/link";
import { ArrowLeft, MessageSquare } from "lucide-react";

import LogoAvatar from "@/components/feed/LogoAvatar";
import SampleTag from "@/components/SampleTag";
import { getStudentTimeZone } from "@/lib/time-zone-server";
import {
  getMessageablePeople,
  getPublicProfile,
  getThread,
  getThreads,
  markThreadRead,
  type ThreadSummary,
} from "@/lib/people";

import Composer from "./[userId]/Composer";
import MessageBubble from "./[userId]/MessageBubble";
import NewMessageButton from "./NewMessageButton";
import ScrollToEnd from "./ScrollToEnd";
import ThreadList, { type ThreadRow } from "./ThreadList";

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
}

/**
 * Times on the student's own clock (their profile's zone, else their
 * browser's) - this renders on the server, whose clock is UTC in production.
 */
function clock(zone: string) {
  const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleString("en-US", { timeZone: zone, ...o });
  const dayKey = (d: Date) => fmt(d, { year: "numeric", month: "2-digit", day: "2-digit" });
  const today = dayKey(new Date());
  const yesterday = dayKey(new Date(Date.now() - 86_400_000));
  const sameYear = (d: Date) => fmt(d, { year: "numeric" }) === fmt(new Date(), { year: "numeric" });
  return {
    time: (d: Date) => fmt(d, { hour: "numeric", minute: "2-digit" }),
    /** "2:14 PM" today, "Yesterday", "Mon" this week, "Sep 12", "Sep 12, 2025". */
    list(d: Date) {
      const k = dayKey(d);
      if (k === today) return fmt(d, { hour: "numeric", minute: "2-digit" });
      if (k === yesterday) return "Yesterday";
      if (Date.now() - d.getTime() < 6 * 86_400_000) return fmt(d, { weekday: "short" });
      return fmt(d, sameYear(d) ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
    },
    day(d: Date) {
      const k = dayKey(d);
      if (k === today) return "Today";
      if (k === yesterday) return "Yesterday";
      return fmt(d, sameYear(d) ? { weekday: "long", month: "long", day: "numeric" } : { month: "long", day: "numeric", year: "numeric" });
    },
    full: (d: Date) => fmt(d, { dateStyle: "medium", timeStyle: "short" }),
  };
}

function toRow(t: ThreadSummary, c: ReturnType<typeof clock>): ThreadRow {
  return {
    otherId: t.otherId,
    otherName: t.otherName,
    otherSchool: t.otherSchool,
    otherSchoolDomain: t.otherSchoolDomain,
    otherPhoto: t.otherPhoto,
    otherIsSample: t.otherIsSample,
    lastBody: t.lastBody,
    lastFromMe: t.lastFromMe,
    when: c.list(t.lastAt),
    unreadCount: t.unreadCount,
  };
}

/**
 * The Messages page: conversations on the left, the open one on the right.
 *
 * /networking/messages renders it with nothing open; /messages/[userId] with
 * that conversation open (which marks it read). On a phone only one pane shows
 * at a time - the list, or the conversation with a back arrow.
 */
export default async function MessagesView({ viewerId, selectedId }: { viewerId: string; selectedId: string | null }) {
  const other = selectedId ? await getPublicProfile(selectedId, viewerId) : null;
  if (other) await markThreadRead(viewerId, other.id);
  const [threads, people, thread] = await Promise.all([
    getThreads(viewerId),
    getMessageablePeople(viewerId),
    other ? getThread(viewerId, other.id) : Promise.resolve([]),
  ]);
  const summary = threads.find((t) => t.otherId === other?.id);
  const c = clock(await getStudentTimeZone());

  // Messages grouped under a date line whenever the day changes.
  const days: { label: string; items: typeof thread }[] = [];
  for (const m of thread) {
    const label = c.day(m.createdAt);
    if (days.at(-1)?.label !== label) days.push({ label, items: [] });
    days.at(-1)!.items.push(m);
  }

  return (
    <div className="flex h-[calc(100vh-12rem)] min-h-[32rem] overflow-hidden rounded-xl border border-brand-100 bg-white shadow-card">
      {/* Conversations */}
      <aside
        className={`${other ? "hidden md:flex" : "flex"} w-full flex-col border-r border-brand-100 md:w-80 md:shrink-0`}
      >
        <div className="flex items-center justify-between px-4 pb-3 pt-4">
          <h1 className="text-lg font-semibold text-brand-900">Messages</h1>
          <NewMessageButton people={people} />
        </div>
        <ThreadList threads={threads.map((t) => toRow(t, c))} selectedId={other?.id ?? null} />
      </aside>

      {/* The open conversation */}
      <section className={`${other ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col`}>
        {!other ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-900">
              <MessageSquare size={20} aria-hidden />
            </span>
            <p className="text-sm font-medium text-brand-900">Your messages</p>
            <p className="max-w-xs text-sm text-warmgray-500">
              Pick a conversation, or start a new one with the pencil button.
            </p>
          </div>
        ) : (
          <>
            <header className="flex items-center gap-3 border-b border-brand-100 px-4 py-3">
              <Link
                href="/networking/messages"
                aria-label="All messages"
                className="flex h-8 w-8 items-center justify-center rounded-full text-brand-900 hover:bg-brand-50 md:hidden"
              >
                <ArrowLeft size={16} aria-hidden />
              </Link>
              <LogoAvatar
                domain={other.schoolDomain}
                label={other.school}
                alt=""
                initials={initials(other.name)}
                photoUrl={summary?.otherPhoto ?? null}
                size={40}
              />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 truncate text-sm font-semibold text-brand-900">
                  {other.name}
                  {other.isSample && <SampleTag />}
                </p>
                <p className="truncate text-xs text-warmgray-500">
                  {other.school ?? "School not set"}
                  {other.gradYear ? ` · Class of ${other.gradYear}` : ""}
                </p>
              </div>
              <Link
                href={`/u/${other.id}`}
                className="shrink-0 rounded-full border border-brand-200 px-3 py-1.5 text-xs font-medium text-brand-900 transition hover:bg-brand-50"
              >
                View profile
              </Link>
            </header>

            <ScrollToEnd deps={thread.length} className="min-h-0 flex-1 overflow-y-auto bg-brand-50/40 px-4 py-4">
              {thread.length === 0 ? (
                <p className="py-16 text-center text-sm text-warmgray-500">No messages yet. Say hello to {other.name}.</p>
              ) : (
                days.map((day) => (
                  <div key={day.label}>
                    <div className="my-3 flex items-center gap-3 text-[11px] font-medium text-warmgray-500">
                      <span className="h-px flex-1 bg-brand-100" />
                      {day.label}
                      <span className="h-px flex-1 bg-brand-100" />
                    </div>
                    <ol className="space-y-2">
                      {day.items.map((m) => (
                        <li key={m.id} className={m.fromMe ? "flex justify-end" : "flex justify-start"}>
                          <MessageBubble
                            id={m.id}
                            body={m.body}
                            fromMe={m.fromMe}
                            sentAt={m.createdAt.toISOString()}
                            when={c.time(m.createdAt)}
                            whenTitle={c.full(m.createdAt)}
                            edited={!!m.editedAt}
                          />
                        </li>
                      ))}
                    </ol>
                  </div>
                ))
              )}
            </ScrollToEnd>

            <div className="border-t border-brand-100 px-4 pb-2 pt-1">
              <Composer recipientId={other.id} name={other.name} />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
