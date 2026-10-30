/**
 * Fill one student's inbox with messages from the sample students.
 *
 *   npx tsx --env-file=.env.local scripts/seed-sample-messages.ts "Aidan Matus-Enochs"
 *   npx tsx --env-file=.env.local scripts/seed-sample-messages.ts --remove
 *
 * Run after seed-sample-peers.ts. Every message is FROM a sample student TO
 * the named student - none is written as if the named student sent it, so
 * nothing in their inbox puts words in their mouth. Senders carry the Sample
 * tag wherever they appear. Re-running replaces them; --remove deletes every
 * message to or from a sample student.
 */

import { and, eq, inArray, or } from "drizzle-orm";

import { getDb } from "@/db/client";
import { messages, users, userTopFirms, firms } from "@/db/schema";

type Ctx = { first: string; school: string; firm: string; firm2: string; year: string };
type Convo = { msgs: ((c: Ctx) => string)[]; unread?: boolean };

const CONVOS: Convo[] = [
  {
    unread: true,
    msgs: [
      (c) => `Hey! Saw we're both targeting ${c.firm} - are you applying to the summer analyst role this cycle?`,
      () => `I've been doing coffee chats with a few analysts there. Happy to compare notes if you want, I can send you the questions I've been asking.`,
    ],
  },
  {
    unread: true,
    msgs: [(c) => `Hi! I'm ${c.first}, ${c.year} at ${c.school}. Would you be down to do a mock interview swap this week? I can do technicals if you do fit questions.`],
  },
  {
    msgs: [
      () => `Do you know if anyone's put together a list of the superday questions from last year? My group chat has been useless lol`,
      () => `Nvm found some in the Discussions tab, super helpful`,
    ],
  },
  {
    unread: true,
    msgs: [(c) => `How are you prepping for first rounds? I have mine with ${c.firm2} on Thursday and I'm kind of freaking out`],
  },
  {
    msgs: [(c) => `Random question - if you haven't heard back from someone at ${c.firm} after a week, do you follow up again or wait? Trying to figure out the etiquette.`],
  },
  {
    msgs: [
      () => `Tip if you're cold emailing: someone in Discussions said to keep it to 3 sentences. I went from 1 reply out of 20 to 6 out of 20.`,
      () => `Passing it on!`,
    ],
  },
  {
    unread: true,
    msgs: [(c) => `Are you going to the ${c.firm} info session next week? Thinking of going but don't know anyone else going`],
  },
  {
    msgs: [(c) => `Hi! We matched on Meet Peers - looks like we're both into PE and ${c.firm}. Would love to connect and maybe grab a virtual coffee sometime.`],
  },
  {
    msgs: [
      () => `Quick one: when you walk through a DCF do you start with unlevered free cash flow or revenue? I keep going back and forth on how much detail to give.`,
      () => `I usually open with the big picture and let them ask for more, but curious what you do.`,
    ],
  },
  {
    msgs: [(c) => `Hey! I'm putting together a small study group for technicals - 4 of us so far, mostly ${c.school} people. We meet Sunday nights over Zoom. Want in?`],
  },
  {
    unread: true,
    msgs: [
      () => `Just got the offer!!!`,
      (c) => `The LBO question we drilled in my study group literally came up word for word at ${c.firm}. Still in shock`,
    ],
  },
  {
    msgs: [(c) => `Do you have a contact at ${c.firm2}? Trying to find someone in their restructuring group and coming up empty.`],
  },
  {
    msgs: [
      () => `How are you tracking all your applications? I've got like 30 in a spreadsheet and it's getting out of hand.`,
      () => `Just found the applications tab on here, never mind haha`,
    ],
  },
  {
    msgs: [(c) => `Hi, I'm a ${c.year} and just starting to recruit. Any advice on what I should be doing now vs next year? Everyone at ${c.school} says something different.`],
  },
  {
    msgs: [(c) => `Saw your post in the feed, love it. If you're ever in the city for ${c.firm} stuff let me know, would be cool to meet up.`],
  },
];

const classLabel = (y: number | null) => (y ? `Class of ${y}` : "a student");

async function main() {
  const remove = process.argv.includes("--remove");
  const db = await getDb();

  const samples = await db
    .select({ id: users.id, name: users.name, school: users.school, gradYear: users.gradYear })
    .from(users)
    .where(eq(users.isSample, true));
  const sampleIds = samples.map((s) => s.id);
  if (sampleIds.length) {
    const gone = await db
      .delete(messages)
      .where(or(inArray(messages.senderId, sampleIds), inArray(messages.recipientId, sampleIds)))
      .returning();
    console.log(`Removed ${gone.length} sample messages.`);
  }
  if (remove) return;

  const name = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!name) throw new Error('Name the student to fill, e.g. "Aidan Matus-Enochs".');
  const [to] = await db
    .select({ id: users.id, school: users.school })
    .from(users)
    .where(and(eq(users.name, name), eq(users.isSample, false)));
  if (!to) throw new Error(`No real student named ${name}.`);
  if (samples.length < CONVOS.length) throw new Error("Run seed-sample-peers.ts first.");

  // Classmates first - the people most likely to write - then everyone else.
  const senders = [
    ...samples.filter((s) => s.school && s.school === to.school),
    ...samples.filter((s) => s.school !== to.school),
  ].slice(0, CONVOS.length);

  const tops = await db
    .select({ userId: userTopFirms.userId, firm: firms.name })
    .from(userTopFirms)
    .innerJoin(firms, eq(firms.id, userTopFirms.firmId))
    .where(inArray(userTopFirms.userId, senders.map((s) => s.id)));
  const firmsOf = new Map<string, string[]>();
  for (const t of tops) firmsOf.set(t.userId, [...(firmsOf.get(t.userId) ?? []), t.firm]);

  const HOUR = 3_600_000;
  const now = Date.now();
  let total = 0;
  for (const [i, convo] of CONVOS.entries()) {
    const s = senders[i];
    const f = firmsOf.get(s.id) ?? [];
    const ctx: Ctx = {
      first: (s.name ?? "").split(" ")[0] || "there",
      school: s.school ?? "my school",
      firm: f[0] ?? "Goldman Sachs",
      firm2: f[1] ?? f[0] ?? "Evercore",
      year: classLabel(s.gradYear),
    };
    // Newest conversations first in CONVOS order; each spread over a few minutes.
    const start = now - (i * 17 + 1) * HOUR;
    await db.insert(messages).values(
      convo.msgs.map((m, j) => {
        const at = new Date(start + j * 4 * 60_000);
        return {
          senderId: s.id,
          recipientId: to.id,
          body: m(ctx),
          createdAt: at,
          readAt: convo.unread ? null : new Date(at.getTime() + HOUR),
        };
      }),
    );
    total += convo.msgs.length;
  }
  console.log(`Seeded ${total} messages in ${CONVOS.length} conversations to ${name}; ${CONVOS.filter((c) => c.unread).length} unread.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
