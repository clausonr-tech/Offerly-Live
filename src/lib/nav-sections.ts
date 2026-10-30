// The single list behind the app's navigation - the sidebar that runs down
// every signed-in page.
//
// It used to feed two separately-rendered copies of a horizontal tab strip
// (the header bar, and the one /home faded in once its hero retired) which
// drifted apart repeatedly. The strip is gone; the sidebar is the only
// consumer now, but the list stays in its own module so a section can be
// added without touching a component.
import type { LucideIcon } from "lucide-react";
import { BookOpen, Calendar, Compass, Newspaper, Send, Target, Users } from "lucide-react";

export type NavSection = {
  href: string;
  label: string;
  /**
   * The mark beside the label in the rail. Top-level sections only: the
   * children sit indented under a hairline and already read as subordinate,
   * and a second column of icons inside that indent crowds a 15rem rail
   * without telling the reader anything the nesting has not already said.
   *
   * Decorative, not informative - the label is right there - so the rail
   * renders these aria-hidden.
   */
  Icon?: LucideIcon;
  /**
   * Second-level views belonging to this section. The sidebar shows them
   * nested beneath their parent, and only while that section is the one being
   * read - a permanently-expanded tree of every sub-view in the app is a
   * directory listing, not a navigation.
   */
  children?: NavSection[];
  /**
   * Where the children are shown. "sidebar" (the default) nests them under
   * the section in the rail; "topbar" leaves the rail entry alone and shows
   * them as the floating bar across the top of the section's pages
   * (app/(app)/SectionTopBar). They are still the section's children either
   * way - which page is current, and Help, read them from here.
   */
  childrenIn?: "sidebar" | "topbar";
  /**
   * Part of Offerly Pro (lib/plan-access): a free account sees the section in
   * the rail with a lock and lands on /upgrade when it opens it. The rail
   * deliberately still shows these - what the free tier is missing IS the
   * pitch - so they are marked rather than filtered out.
   */
  paid?: boolean;
  /**
   * Older top-level routes whose pages belong to this section - a contact's
   * page still lives at /contacts/[id], a message thread at /messages/[id].
   * Without these the rail lit up nothing on those pages, so a student who
   * clicked through from Industry Contacts appeared to have left Networking.
   * Prefixes, matched the same way as `href`.
   */
  aliases?: string[];
};

// Opportunities and Applications used to be two separate tabs, then one
// (/dashboard, carrying the tracked pipeline). The pipeline has since moved
// again, to Schedule, so /dashboard is now the firms you're targeting and
// what's due at them - still one entry, not two.
//
// Drafts was folded in the same way, into Outreach. Contacts lives under
// External Network as "Industry Contacts".
//
// Alerts is gone rather than folded - it was a standalone inbox of
// "a firm you watch just opened a role" rows, and nothing else linked to it.
export const NAV_SECTIONS: NavSection[] = [
  // Community and Networking were two tabs asking the same question from
  // opposite ends - "who is out there" and "who do I already have" - and a
  // student moved between them constantly. They are one section now, under
  // the name that describes the activity rather than the audience.
  //
  // The hub itself is the feed plus a handful of this student's own contacts;
  // everything below is another view of the same section.
  //
  // Second, directly under Opportunities. Finding a role and knowing someone
  // inside it are the two halves of the same week, so the section a student
  // opens next sits next to the one they land on.
  {
    href: "/networking",
    // "Internal Network" since 2026-09-27: every view in it is other Offerly
    // students. Industry Contacts - people at firms, who are not on Offerly -
    // moved to External Network, next to the firms they work at.
    label: "Internal Network",
    Icon: Users,
    // Its views are the floating bar across the top of every Networking page,
    // not rows under it in the rail.
    childrenIn: "topbar",
    // /u is a student's profile, opened from the feed, Peers, Connect or Clubs.
    aliases: ["/u"],
    children: [
      // Peers before Connect: Connect is the directory of everyone, Peers is
      // the handful you actually know, and the smaller, warmer list is the one
      // a student opens more often.
      { href: "/networking/peers", label: "Peers" },
      { href: "/networking/connect", label: "Connect" },
      { href: "/networking/clubs", label: "Clubs" },
      { href: "/networking/discussions", label: "Discussions" },
      { href: "/networking/messages", label: "Messages", aliases: ["/messages"] },
    ],
  },
  // Second since 2026-09-25, when Networking moved to the top at the owner's
  // request. Still the page a student lands on after signing in.
  // /applications/* is the tracked-application form and detail pages, and
  // /todo the full list behind the dashboard's five tasks - both are reached
  // from Opportunities and link back to it.
  //
  // Renamed "External Network" on 2026-09-27: the firms and jobs a student is
  // after, and the people inside them. Industry Contacts lives at /contacts
  // (/networking/contacts redirects there) and is a tab across its top.
  {
    href: "/dashboard",
    label: "External Network",
    paid: true,
    Icon: Target,
    aliases: ["/applications", "/todo"],
    // A tab beside "Dashboard" across the top of the page, like Internal
    // Network's views, rather than a row nested under it in the rail.
    childrenIn: "topbar",
    children: [{ href: "/contacts", label: "Industry Contacts" }],
  },
  { href: "/schedule", label: "Schedule", Icon: Calendar, paid: true },
  // The hub is the student's matches. Internships and the ~25k-row firm
  // directory are views underneath: both want the full width, and a different
  // job ("browse") than the hub ("act").
  {
    href: "/discovery",
    label: "Discovery",
    Icon: Compass,
    // Deliberately NOT paid: internship postings, the firm directory and the
    // match recommendations stay open on every plan. Charging jobseekers for
    // access to listings is what the California Job Listing Services Act
    // reaches (legal/drafts/subscription-terms.md section 3.4) - the paid
    // tiers sell tools, never listings.
    children: [
      // /tracking is the list of roles tracked from these internships.
      { href: "/discovery/internships", label: "Internships", aliases: ["/tracking"] },
      // A single firm's page is part of the directory it was opened from.
      { href: "/discovery/firms", label: "Firms", aliases: ["/discovery/firm"] },
    ],
  },
  { href: "/news", label: "News", Icon: Newspaper, paid: true },
  // Practice rounds is the hub; Video interview is a tab beside it, across
  // the top of the page under its header (learn/layout.tsx).
  {
    href: "/learn",
    label: "Interview Prep",
    Icon: BookOpen,
    paid: true,
    childrenIn: "topbar",
    children: [{ href: "/learn/video", label: "Video interview" }],
  },
  // The hub is who to write to next plus the record of what went out; the two
  // tools that do the writing sit underneath, like Networking's views. They
  // were two tabs on the hub, which hid the resume builder behind a click the
  // rail never showed. /drafts is the history of past emails, one click from
  // the hub.
  {
    href: "/outreach",
    label: "Outreach",
    Icon: Send,
    paid: true,
    aliases: ["/drafts"],
    children: [
      { href: "/outreach/email", label: "Email drafts" },
      // The history of reviews is part of the builder it was taken in.
      { href: "/outreach/resume", label: "Resume builder" },
    ],
  },
];

/** Whether `pathname` is `prefix` itself or somewhere beneath it. */
function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/** Whether `pathname` belongs to `item` - its own href or any of its aliases. */
export function belongsTo(item: NavSection, pathname: string): boolean {
  return [item.href, ...(item.aliases ?? [])].some((p) => under(pathname, p));
}

/**
 * The section a path belongs to, or null off the map.
 *
 * Prefix matching against `href + "/"`, not a bare `startsWith`, so a future
 * `/newsletter` could never light up News. A section's own subtree wins over
 * another section's alias, so an alias can never steal a page from the
 * section whose URL it is actually under.
 */
export function sectionFor(pathname: string, sections: NavSection[] = NAV_SECTIONS): NavSection | null {
  return (
    sections.find((section) => under(pathname, section.href)) ??
    sections.find(
      (section) =>
        belongsTo(section, pathname) ||
        (section.children ?? []).some((child) => belongsTo(child, pathname)),
    ) ??
    null
  );
}

/**
 * The second-level view a path belongs to inside `section`, or null when it
 * is the section's hub (or a view with no row of its own, like the composer).
 *
 * Prefix matching, like `sectionFor`: a thread under /messages/[id] still
 * highlights Messages, where an exact match lit up nothing once the reader
 * went one level deeper.
 */
export function subsectionFor(section: NavSection, pathname: string): NavSection | null {
  return section.children?.find((child) => belongsTo(child, pathname)) ?? null;
}
