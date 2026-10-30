/**
 * Seed the example threads on /networking/discussions.
 *
 *   npx tsx --env-file=.env.local scripts/seed-sample-discussions.ts
 *   npx tsx --env-file=.env.local scripts/seed-sample-discussions.ts --remove
 *
 * Every row is is_sample = true and has no author: examples written for an
 * empty page, not real students' experiences. The visible "Sample" label was
 * taken off at the owner's request (2026-09-25); the flag stays so --remove
 * can delete them all before launch. Re-running replaces the old samples.
 *
 * The content is written to be generic and hedged ("in my experience"): no
 * dates, compensation figures or process details asserted as fact about a
 * named firm.
 */

import { eq, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { discussionReplies, discussions } from "@/db/schema";
import { matchFirm, type DiscussionTopic } from "@/lib/discussions";

type Reply = { by: string; body: string; anonymous?: boolean };
type Thread = {
  topic: DiscussionTopic;
  firm?: string;
  by: string;
  anonymous?: boolean;
  title: string;
  body: string;
  replies: Reply[];
};

const THREADS: Thread[] = [
  {
    topic: "Interviews",
    firm: "Evercore",
    by: "Class of 2027",
    title: "Evercore first round - how technical did it get?",
    body: "Have a first round coming up for the summer analyst role. Anyone who went through it recently: was it mostly behavioral and fit, or did they go deep on technicals? Trying to figure out whether to spend the week on DCF/LBO walkthroughs or my stories.",
    replies: [
      { by: "Class of 2026", body: "Mine was maybe 70/30 fit to technicals. Walk me through your resume, why Evercore, why restructuring vs M&A, then a couple of accounting questions (walk a $10 depreciation change through the statements) and a basic DCF walkthrough. Nothing brain-teasery." },
      { by: "Anonymous", anonymous: true, body: "Know the firm's recent deals. I got asked which of their recent deals I found interesting and why, and it was obvious who had prepped that and who hadn't." },
      { by: "Class of 2027", body: "This is helpful, thank you. Going to split the week then." },
    ],
  },
  {
    topic: "Technicals",
    by: "Class of 2028",
    title: "Best way to actually learn the 3-statement walkthroughs?",
    body: "I can recite the answer to 'walk me through the 3 statements' but I fall apart on the follow-ups (what happens if inventory goes up by $10, etc). Did anyone find a method that made it click instead of memorizing?",
    replies: [
      { by: "Former summer analyst", body: "Build one tiny model yourself in Excel. Literally 5 line items on each statement, then change one input and trace it through. After doing that ten times the follow-ups stop being memorization." },
      { by: "Class of 2027", body: "Always start with the income statement, then cash flow, then balance sheet, and check that the balance sheet balances at the end. Saying the check out loud in an interview also shows you know why." },
    ],
  },
  {
    topic: "Recruiting timeline",
    by: "Class of 2029",
    anonymous: true,
    title: "Freshman here - is it too early to start networking?",
    body: "Everyone keeps saying recruiting has moved earlier. I'm a freshman interested in IB. What should I actually be doing this year vs next year so I'm not behind but also not wasting people's time?",
    replies: [
      { by: "Class of 2026", body: "Not too early, but the goal this year is different: get into the right clubs, get your GPA solid, and have a few relaxed conversations with alumni to learn what the groups actually do. The hard networking push is sophomore year." },
      { by: "Class of 2027", body: "Keep a spreadsheet from day one of everyone you talk to and what they said. By sophomore year you'll have a real list instead of starting from zero." },
      { by: "Anonymous", anonymous: true, body: "Also look for sophomore diversity/early insight programs - some firms run them specifically for first and second years." },
    ],
  },
  {
    topic: "Networking",
    by: "Class of 2027",
    title: "How many coffee chats before asking for a referral?",
    body: "I've had one good call with an analyst at a firm I really like. It felt awkward to ask for a referral on the first call. What's the norm - one call, two, more?",
    replies: [
      { by: "Former summer analyst", body: "You usually don't need to ask outright. Follow up with a thank-you, keep them posted when you apply, and ask if there's anyone else on the team they'd suggest you talk to. If it went well they'll often offer to pass your name along." },
      { by: "Class of 2026", body: "Two good conversations with the same person is usually plenty. Quality over number of calls." },
    ],
  },
  {
    topic: "Interviews",
    firm: "Goldman Sachs",
    by: "Class of 2027",
    title: "Goldman superday - what to expect?",
    body: "Made it to the superday. Anyone have a sense of the format - how many interviews, back-to-back or spread out, and whether it's mostly fit at this stage?",
    replies: [
      { by: "Anonymous", anonymous: true, body: "In my experience it was several short back-to-back interviews with people from different levels. Mostly fit and 'why this group', a few technicals mixed in. Have a crisp answer for why you want the specific group." },
      { by: "Class of 2026", body: "Be consistent across interviewers. They compare notes, so your story should be the same in every room." },
    ],
  },
  {
    topic: "Offers",
    by: "Anonymous",
    anonymous: true,
    title: "Exploding offer from a boutique while still interviewing at a BB",
    body: "Got an offer from a boutique I like, but it expires in a few days and I'm mid-process at a bank I'd prefer. Has anyone successfully asked for an extension? How did you word it?",
    replies: [
      { by: "Former summer analyst", body: "Be honest and appreciative: thank them, say you're very excited, and ask whether there's any flexibility on the deadline because you want to make a fully considered decision. Then tell the other bank you have an offer with a deadline - that can speed their process up." },
      { by: "Anonymous", anonymous: true, body: "Just don't accept and then renege. The industry is small and people remember." },
    ],
  },
  {
    topic: "Interviews",
    firm: "Blackstone",
    by: "Class of 2026",
    title: "PE on-cycle: how do people prep the modeling test?",
    body: "Looking ahead to PE recruiting after my analyst stint. For those who've done it: did you practice timed LBO paper tests and case studies? Any structure for the take-home cases?",
    replies: [
      { by: "Former analyst", body: "Paper LBOs until you can do one in under 10 minutes, then full timed models. For case studies, have a template for the memo: thesis, key risks, returns, what you'd diligence. Most people run out of time on formatting, not the math." },
    ],
  },
  {
    topic: "Internship life",
    by: "Former summer analyst",
    title: "Things I wish I knew before my summer analyst internship",
    body: "Putting this out there for anyone starting soon: write everything down, double-check every number before it goes up, ask questions in batches instead of one at a time, and learn the firm's formatting conventions in week one. Happy to answer questions below.",
    replies: [
      { by: "Class of 2027", body: "How did you handle getting staffed on something with a really short turnaround in your first week?" },
      { by: "Former summer analyst", body: "Ask the associate for a precedent to follow, confirm what 'done' looks like, and flag early if you're stuck. Nobody expects you to know everything in week one, but they do expect you to say so." },
      { by: "Class of 2028", body: "Saving this, thanks." },
    ],
  },
  {
    topic: "Technicals",
    by: "Class of 2027",
    title: "Enterprise value vs equity value question I keep getting wrong",
    body: "Why do we add cash back when going from EV to equity value, but a company's cash doesn't change its enterprise value? I get the formula but can't explain it well.",
    replies: [
      { by: "Class of 2026", body: "EV is the value of the core business to all capital providers. Cash isn't part of running the business, so it's excluded from EV. Equity holders do own that cash, so you add it back to get to their share." },
      { by: "Anonymous", anonymous: true, body: "Framing that works for me: buying the whole company, you'd pay the equity value, take on the debt, and get the cash back. Net cost = EV." },
    ],
  },
  {
    topic: "Recruiting timeline",
    by: "Class of 2028",
    title: "Non-target, starting late as a sophomore - realistic plan?",
    body: "I'm at a non-target and only decided on banking this semester. Is it realistic to land a junior summer IB internship, and should I be targeting middle market over bulge brackets?",
    replies: [
      { by: "Class of 2026", body: "Realistic, but cast a wide net: middle market banks, boutiques and regional offices take many non-target students. A strong sophomore summer (even outside banking) with something finance-related to talk about helps a lot." },
      { by: "Class of 2027", body: "Alumni from your own school are the best lever. Even two or three at a firm can make the difference." },
    ],
  },
  {
    topic: "Networking",
    firm: "Lazard",
    by: "Anonymous",
    anonymous: true,
    title: "Cold emails getting no replies - what am I doing wrong?",
    body: "Sent about 30 cold emails to analysts and associates, got 2 replies. My emails are 3 paragraphs about my background. Should they be shorter?",
    replies: [
      { by: "Former summer analyst", body: "Much shorter. Three or four sentences: who you are, the specific connection (same school, same club), and a clear small ask like a 15-minute call. Nobody reads three paragraphs from a stranger." },
      { by: "Class of 2026", body: "Send Tuesday to Thursday mornings, and follow up once after a week. A lot of replies come from the follow-up." },
    ],
  },
  {
    topic: "Exit opps",
    by: "Former analyst",
    title: "Restructuring vs M&A group for exit opportunities?",
    body: "Deciding between groups for a return offer. People say RX is great for credit/distressed funds and M&A is the default for PE. Anyone with experience on how much the group actually matters?",
    replies: [
      { by: "Anonymous", anonymous: true, body: "It matters less than people think for generalist PE, more for credit and special sits. Deal experience and how well you can talk about your deals matters most." },
    ],
  },
  {
    topic: "Interviews",
    firm: "Centerview Partners",
    by: "Class of 2027",
    title: "Elite boutique fit questions - 'why us' when they all sound the same?",
    body: "How do you give a real answer to 'why this firm' for elite boutiques when they all emphasize advisory-only, senior attention, small classes?",
    replies: [
      { by: "Class of 2026", body: "Anchor it in people and deals, not the marketing line. 'I spoke with X and Y about Z deal and what stood out was...' is specific in a way nobody else's answer will be." },
      { by: "Former summer analyst", body: "Also know the firm's industry strengths. Saying you're drawn to a sector they're known for, with a reason, lands much better than generic prestige." },
    ],
  },
  {
    topic: "General",
    by: "Class of 2028",
    title: "Which finance clubs were actually worth it?",
    body: "There are a lot of finance clubs at my school and they all want a big time commitment. For people who recruited successfully, which kinds of clubs actually helped?",
    replies: [
      { by: "Class of 2026", body: "The ones with a real alumni network in banking and structured technical training. A student investment fund with a real pitch process was the most useful for interviews in my experience." },
      { by: "Anonymous", anonymous: true, body: "Two clubs done seriously beat five on your resume. You'll get asked about them." },
    ],
  },
  {
    topic: "Offers",
    by: "Class of 2027",
    title: "Accepted an offer - how do I tell the people who helped me?",
    body: "Just accepted my summer offer. A bunch of analysts at other firms helped me along the way. Is it weird to email them? What do I say?",
    replies: [
      { by: "Former summer analyst", body: "Not weird at all, it's the right move. A short note thanking them, where you ended up, and that you'd be glad to help if they ever need anything. Those relationships last well past recruiting." },
    ],
  },
  {
    topic: "Internship life",
    firm: "Morgan Stanley",
    by: "Anonymous",
    anonymous: true,
    title: "How do you ask for feedback mid-internship without being annoying?",
    body: "Halfway through my internship and I have no idea how I'm doing. Is it normal to ask my staffer or the analysts for feedback?",
    replies: [
      { by: "Former analyst", body: "Totally normal. Ask your associate or a friendly analyst after you finish a piece of work: 'Anything I should do differently next time?' Specific and small beats a formal sit-down." },
      { by: "Class of 2026", body: "Most programs have a mid-summer review anyway. Asking before that shows you care about getting better." },
    ],
  },
];

async function main() {
  const remove = process.argv.includes("--remove");
  const db = await getDb();

  // Replies of sample threads cascade with them; sample replies on real
  // threads (there should be none) go too.
  await db.delete(discussionReplies).where(eq(discussionReplies.isSample, true));
  const removed = await db.delete(discussions).where(eq(discussions.isSample, true)).returning();
  console.log(`Removed ${removed.length} sample discussions.`);
  if (remove) return;

  const now = Date.now();
  const HOUR = 3_600_000;
  let replyTotal = 0;
  for (const [i, t] of THREADS.entries()) {
    // Spread over the last two weeks, newest first in the list above.
    const created = new Date(now - (i * 20 + 6) * HOUR);
    const replyTimes = t.replies.map((_, j) => new Date(created.getTime() + (j + 1) * 3 * HOUR));
    const last = replyTimes.at(-1) ?? created;
    const [row] = await db
      .insert(discussions)
      .values({
        anonymous: t.anonymous ?? false,
        title: t.title,
        body: t.body,
        topic: t.topic,
        firmId: t.firm ? await matchFirm(t.firm) : null,
        firmName: t.firm ?? null,
        isSample: true,
        sampleAuthor: t.anonymous ? null : t.by,
        replyCount: t.replies.length,
        lastActivityAt: last,
        createdAt: created,
      })
      .returning();
    if (t.replies.length) {
      await db.insert(discussionReplies).values(
        t.replies.map((r, j) => ({
          discussionId: row.id,
          anonymous: r.anonymous ?? false,
          body: r.body,
          isSample: true,
          sampleAuthor: r.anonymous ? null : r.by,
          createdAt: replyTimes[j],
        })),
      );
    }
    replyTotal += t.replies.length;
  }
  const withFirm = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(discussions)
    .where(sql`${discussions.isSample} and ${discussions.firmId} is not null`);
  const named = THREADS.filter((t) => t.firm).length;
  console.log(
    `Seeded ${THREADS.length} sample discussions, ${replyTotal} replies; ${withFirm[0]?.n ?? 0} of ${named} firms matched the directory.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
