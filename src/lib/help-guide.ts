// The help guide: what each part of the app is for, and where to go for each
// thing a student needs to do. One module behind both the help panel in the
// top bar and the full /help page, so the two never disagree.
//
// Written against the labels the UI actually shows - when a button is renamed,
// the task that names it here goes stale, so rename it here too.
//
// Section names and hrefs come from NAV_SECTIONS where there is one, so the
// guide cannot call a page something the sidebar does not.
import { NAV_SECTIONS } from "@/lib/nav-sections";

type HelpTask = {
  /** Phrased as the thing the student wants to do, not the page name. */
  label: string;
  href: string;
  /** Other words a student might type for this. Search only; never shown. */
  keywords?: string;
};

export type HelpSection = {
  href: string;
  label: string;
  /** One or two sentences: what this page is for. */
  summary: string;
  tasks: HelpTask[];
  /**
   * Other paths that belong to this page for "On this page" - /drafts is part
   * of Outreach, /tracking part of Discovery. The href itself always matches.
   */
  alsoCovers?: string[];
};

function nav(href: string): string {
  const all = NAV_SECTIONS.flatMap((s) => [s, ...(s.children ?? [])]);
  const hit = all.find((s) => s.href === href);
  if (!hit) throw new Error(`help-guide: ${href} is not in NAV_SECTIONS`);
  return hit.label;
}

/**
 * The order recruiting actually happens in. The panel shows it when a student
 * is not searching, because "where am I in this?" is the other half of "where
 * is the button?".
 */
export const RECRUITING_PATH: { title: string; body: string; href: string }[] = [
  {
    title: "Pick your firms",
    body: "Set your interests, then add the firms you are targeting.",
    href: "/dashboard",
  },
  {
    title: "Track the openings",
    body: "Bookmark the internships you will apply to and see when they open.",
    href: "/discovery/internships",
  },
  {
    title: "Find your people",
    body: "Build a list of contacts at each firm, or generate them from a firm's page.",
    href: "/contacts",
  },
  {
    title: "Reach out and follow up",
    body: "Draft a first email, then a follow-up if they have not replied.",
    href: "/outreach",
  },
  {
    title: "Keep it on the calendar",
    body: "Coffee chats, deadlines and interviews, all in one place.",
    href: "/schedule",
  },
  {
    title: "Prep for interviews",
    body: "Practise technical and behavioral rounds for your industry.",
    href: "/learn",
  },
];

export const HELP_SECTIONS: HelpSection[] = [
  {
    href: "/dashboard",
    label: nav("/dashboard"),
    summary:
      "Your home page: the firms you are targeting, the roles that match you, the people inside them, and what to do today.",
    alsoCovers: ["/applications"],
    tasks: [
      { label: "Add a firm you're targeting", href: "/dashboard", keywords: "track firm target add company deck" },
      { label: "Find my top firms", href: "/dashboard", keywords: "match matches refresh recommend" },
      { label: "Add an application", href: "/applications/new", keywords: "applied track apply status" },
      { label: "See who to reach out to at a firm", href: "/dashboard", keywords: "contacts people firm card" },
      { label: "Update what you're recruiting for", href: "/profile/interests", keywords: "interests preferences industry matches" },
      { label: "See all your contacts", href: "/contacts", keywords: "people list table" },
      { label: "Add a contact", href: "/contacts/new", keywords: "new person alum banker" },
      { label: "Import contacts from a spreadsheet", href: "/contacts/import", keywords: "csv upload bulk" },
    ],
  },
  {
    href: "/networking",
    label: nav("/networking"),
    summary:
      "Offerly's own network: other students recruiting alongside you, clubs, discussions, messages and the activity feed.",
    alsoCovers: ["/u"],
    tasks: [
      { label: "Find other students", href: "/networking/connect", keywords: "directory school classmates peers" },
      { label: "Message someone", href: "/networking/messages", keywords: "chat inbox dm conversation" },
      { label: "Post to the feed", href: "/networking/post", keywords: "share update" },
    ],
  },
  {
    href: "/contacts",
    label: nav("/contacts"),
    summary:
      "Every contact you have, in one table. Filter by name, firm, role or school, and click an email to write to them.",
    tasks: [
      { label: "Filter contacts by firm", href: "/contacts", keywords: "search find" },
      { label: "Write to a contact", href: "/outreach", keywords: "email draft cold" },
      { label: "Add a contact", href: "/contacts/new" },
    ],
  },
  {
    href: "/networking/peers",
    label: nav("/networking/peers"),
    summary: "Students you are connected with, and requests waiting on you.",
    tasks: [
      { label: "Accept a peer request", href: "/networking/peers", keywords: "waiting add back" },
      { label: "Find more students", href: "/networking/connect" },
    ],
  },
  {
    href: "/networking/connect",
    label: nav("/networking/connect"),
    summary: "The directory of students on Offerly. Filter by school, grad year, internships or top firms.",
    tasks: [
      { label: "Find students at your school", href: "/networking/connect", keywords: "classmates filter grad year" },
      { label: "Message a student", href: "/networking/messages" },
    ],
  },
  {
    href: "/networking/clubs",
    label: nav("/networking/clubs"),
    summary: "Your school's finance clubs, with each club's members. A club's president adds its members; following a club puts its posts in your feed.",
    tasks: [
      { label: "Follow a club", href: "/networking/clubs", keywords: "society group" },
      { label: "See who is in a club", href: "/networking/clubs", keywords: "members leadership president join" },
    ],
  },
  {
    href: "/networking/discussions",
    label: nav("/networking/discussions"),
    summary: "Threads about interviews, timelines and offers. Post under your name or anonymously.",
    tasks: [
      { label: "Start a discussion", href: "/networking/discussions", keywords: "ask question thread forum post" },
      { label: "Post anonymously", href: "/networking/discussions", keywords: "anonymous hide name" },
    ],
  },
  {
    href: "/networking/messages",
    label: nav("/networking/messages"),
    summary: "Your conversations with other students.",
    // A conversation page is a message thread, not the Networking hub.
    alsoCovers: ["/messages"],
    tasks: [{ label: "Start a conversation", href: "/networking/messages", keywords: "chat dm inbox" }],
  },
  {
    href: "/schedule",
    label: nav("/schedule"),
    summary:
      "Your recruiting calendar: interviews, deadlines, coffee chats and info sessions. Mark an event as an Interview and Offerly will prompt you to prep for it.",
    tasks: [
      { label: "Add an interview", href: "/schedule?type=interview", keywords: "superday event calendar" },
      { label: "Add a coffee chat", href: "/schedule?type=coffee_chat", keywords: "call meeting event" },
      { label: "Add a deadline", href: "/schedule?type=deadline", keywords: "due date application" },
      { label: "Connect Google Calendar", href: "/schedule", keywords: "sync gcal google" },
      { label: "Add an info session", href: "/schedule?type=info_session", keywords: "speaker event recruiting" },
    ],
  },
  {
    href: "/discovery",
    label: nav("/discovery"),
    summary:
      "Your matched firms, three across, each opening onto who to write to there and which roles are open. Open internships are under Internships, and every firm has its own view under Firms.",
    tasks: [
      { label: "See your matched firms", href: "/discovery", keywords: "matches recommended picked for me" },
      { label: "Browse open internships", href: "/discovery/internships", keywords: "jobs roles postings summer analyst" },
      { label: "Browse firms by industry", href: "/discovery/firms", keywords: "banks companies search sector" },
      { label: "Generate contacts at a firm", href: "/discovery/firms", keywords: "find people firm page" },
      { label: "See when applications open", href: "/discovery/firms", keywords: "timeline dates recruiting cycle" },
    ],
  },
  {
    href: "/discovery/internships",
    label: nav("/discovery/internships"),
    summary: "The open internships for your recruiting cycle, by industry. Track the ones you will apply to.",
    alsoCovers: ["/tracking"],
    tasks: [
      { label: "Browse open internships", href: "/discovery/internships", keywords: "jobs roles postings summer analyst" },
      { label: "Track an internship", href: "/discovery/internships", keywords: "bookmark save role" },
      { label: "See the roles you're tracking", href: "/tracking", keywords: "bookmarked saved" },
    ],
  },
  {
    href: "/discovery/firms",
    label: nav("/discovery/firms"),
    summary: "The full directory of firms, searchable and filterable by industry. Open one for its people, roles and timeline.",
    alsoCovers: ["/discovery/firm"],
    tasks: [
      { label: "Search for a firm", href: "/discovery/firms", keywords: "find bank company directory" },
      { label: "Filter firms by industry", href: "/discovery/firms", keywords: "sector banking consulting" },
    ],
  },
  {
    href: "/news",
    label: nav("/news"),
    summary: "Finance headlines, filtered by industry, for interviews and coffee chats.",
    tasks: [
      { label: "Read the latest finance news", href: "/news", keywords: "headlines markets deals" },
      { label: "News for investment banking", href: "/news?category=investment_banking", keywords: "ib" },
    ],
  },
  {
    href: "/learn",
    label: nav("/learn"),
    summary:
      "Ten-question practice rounds. Pick technical, behavioral or mixed, your difficulty and your industry.",
    tasks: [
      { label: "Practise technical questions", href: "/learn", keywords: "technicals quiz accounting valuation dcf" },
      { label: "Practise behavioral questions", href: "/learn", keywords: "fit story why" },
      // Found by sector, but opened blank: the page never preselects a sector,
      // so the student picks it there.
      { label: "Investment banking prep", href: "/learn", keywords: "ib" },
      { label: "Private equity prep", href: "/learn", keywords: "pe" },
    ],
  },
  {
    href: "/learn/video",
    label: nav("/learn/video"),
    summary:
      "A one-way video interview, like HireVue: a question, time to think, then record your answer on camera and watch it back. Recordings stay on your device.",
    tasks: [
      { label: "Practise a video interview", href: "/learn/video", keywords: "hirevue camera record one-way webcam" },
    ],
  },
  {
    href: "/outreach",
    label: nav("/outreach"),
    summary:
      "Who to write to next - follow-ups, thank-yous and people to contact - plus your past emails and past resume reviews.",
    alsoCovers: ["/drafts"],
    tasks: [
      { label: "See who to reach out to", href: "/outreach", keywords: "who to email next owe" },
      { label: "See your past emails", href: "/drafts", keywords: "drafts history sent" },
      { label: "See your past resumes", href: "/outreach/resume/history", keywords: "cv reviews history scores" },
    ],
  },
  {
    href: "/outreach/email",
    label: nav("/outreach/email"),
    summary: "Write emails to your contacts: first outreach, follow-ups, thank-yous and more.",
    tasks: [
      { label: "Write a cold email", href: "/outreach/email", keywords: "draft first outreach networking" },
      { label: "Write a follow-up", href: "/outreach/email", keywords: "follow up reply nudge" },
      { label: "Write a thank-you note", href: "/outreach/email", keywords: "thanks after call" },
    ],
  },
  {
    href: "/outreach/resume",
    label: nav("/outreach/resume"),
    summary: "Upload your resume for a scored review, line-by-line fixes and a rewritten copy.",
    tasks: [
      { label: "Get feedback on your resume", href: "/outreach/resume", keywords: "cv review resume builder" },
      { label: "See your past resumes", href: "/outreach/resume/history", keywords: "cv reviews history scores" },
    ],
  },
  {
    href: "/todo",
    label: "Everything to do",
    summary:
      "Your whole to-do list, most urgent first. The five under Today on External Network are the top of it; tick anything off here too.",
    tasks: [
      { label: "See your whole to-do list", href: "/todo", keywords: "tasks all everything list today" },
      { label: "See today's five", href: "/dashboard", keywords: "tasks today next load" },
    ],
  },
  {
    href: "/notifications",
    label: "Notifications",
    summary:
      "What the app is asking you to do: people to email before an application opens, and interviews to prep for. Each one closes when you finish it.",
    tasks: [{ label: "See what needs doing", href: "/notifications", keywords: "to do tasks bell reminders" }],
  },
  {
    href: "/profile",
    label: "Your account",
    summary:
      "Your profile, resume, connected accounts, plan and billing. Your recruiting answers here drive the firms Offerly matches you with.",
    alsoCovers: ["/settings"],
    tasks: [
      { label: "Edit your profile", href: "/profile", keywords: "name school about account" },
      { label: "Upload your resume", href: "/profile", keywords: "cv pdf" },
      { label: "Update your recruiting interests", href: "/profile/interests", keywords: "preferences industry matches" },
      { label: "Connect Google Calendar", href: "/profile/connections", keywords: "google gcal sync calendar account" },
    ],
  },
];

function pick(sectionHref: string, label: string): HelpTask {
  const task = HELP_SECTIONS.find((s) => s.href === sectionHref)?.tasks.find((t) => t.label === label);
  if (!task) throw new Error(`help-guide: no task "${label}" under ${sectionHref}`);
  return task;
}

export type HelpGroup = { label: string; href: string; summary: string; tasks: HelpTask[] };

/**
 * The full /help page, consolidated: six groups of three, two to a row.
 *
 * Fourteen sections and some fifty links was a page a student scrolled past
 * rather than read. These are the few things each part of the app is for;
 * everything else is still one search away in the help menu, which searches
 * every task in HELP_SECTIONS. Tasks are picked from there by label, so a
 * renamed task fails loudly here instead of quietly going stale.
 */
export const HELP_GROUPS: HelpGroup[] = [
  {
    label: nav("/dashboard"),
    href: "/dashboard",
    summary: "Where you land: the firms you're targeting, roles that match you, your contacts inside them, and what to do today.",
    tasks: [
      pick("/dashboard", "Add a firm you're targeting"),
      pick("/dashboard", "Add an application"),
      pick("/notifications", "See what needs doing"),
    ],
  },
  {
    label: `${nav("/discovery")} & ${nav("/news")}`,
    href: "/discovery",
    summary: "Every open internship and every firm, by industry, plus the headlines to know.",
    tasks: [
      pick("/discovery/internships", "Browse open internships"),
      pick("/discovery", "Browse firms by industry"),
      pick("/news", "Read the latest finance news"),
    ],
  },
  {
    label: nav("/networking"),
    href: "/networking",
    summary: "The students recruiting alongside you: the feed, peers, clubs and messages.",
    tasks: [
      pick("/networking", "Find other students"),
      pick("/networking", "Message someone"),
      pick("/networking", "Post to the feed"),
    ],
  },
  {
    label: nav("/outreach"),
    href: "/outreach",
    summary: "Emails to your contacts, from the first note to the thank-you.",
    tasks: [
      pick("/outreach", "See who to reach out to"),
      pick("/outreach/email", "Write a cold email"),
      pick("/outreach/resume", "Get feedback on your resume"),
    ],
  },
  {
    label: `${nav("/schedule")} & ${nav("/learn")}`,
    href: "/schedule",
    summary: "Interviews, deadlines and coffee chats on one calendar, and practice rounds before the day.",
    tasks: [
      pick("/schedule", "Add an interview"),
      pick("/profile", "Connect Google Calendar"),
      pick("/learn", "Practise technical questions"),
    ],
  },
  {
    label: "Your account",
    href: "/profile",
    summary: "Your profile, your resume, and the interests Offerly matches you on.",
    tasks: [
      pick("/profile", "Edit your profile"),
      pick("/profile", "Upload your resume"),
      pick("/profile", "Update your recruiting interests"),
    ],
  },
];

/**
 * The help for the page at this path, or null for one the guide does not
 * cover. The most specific match wins, so /contacts gets its own
 * help rather than External Network's.
 */
export function helpFor(pathname: string): HelpSection | null {
  let best: HelpSection | null = null;
  let bestLen = -1;
  for (const section of HELP_SECTIONS) {
    for (const prefix of [section.href, ...(section.alsoCovers ?? [])]) {
      const hit = pathname === prefix || pathname.startsWith(prefix + "/");
      if (hit && prefix.length > bestLen) {
        best = section;
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

export type HelpResult = { task: HelpTask; section: HelpSection };

/**
 * Tasks matching what the student typed, best first.
 *
 * Every word has to appear somewhere in the task, its keywords or its section
 * name, as the start of a word - so "int" finds "interview" and "internships"
 * but "view" does not find "interview". Hits in the task's own label rank above
 * hits only in its keywords. The same task can sit under two sections (Add a
 * contact); it is listed once.
 */
export function searchHelp(query: string, limit = 8): HelpResult[] {
  // Split exactly as the searched text is split below, so "follow-up" and
  // "you're" are the words they match rather than tokens nothing contains.
  const words = query.toLowerCase().split(/[^a-z0-9&]+/).filter(Boolean);
  if (words.length === 0) return [];

  const startsWord = (haystack: string, w: string) =>
    haystack.split(/[^a-z0-9&]+/).some((part) => part.startsWith(w));

  const scored: (HelpResult & { score: number })[] = [];
  const seen = new Set<string>();
  for (const section of HELP_SECTIONS) {
    for (const task of section.tasks) {
      const label = task.label.toLowerCase();
      const all = `${label} ${task.keywords ?? ""} ${section.label.toLowerCase()}`;
      if (!words.every((w) => startsWord(all, w))) continue;
      const key = `${task.label}|${task.href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const score = words.filter((w) => startsWord(label, w)).length;
      scored.push({ task, section, score });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ task, section }) => ({ task, section }));
}
