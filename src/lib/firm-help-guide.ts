// What the firm portal is, in plain words: the overview the firm Help
// assistant learns from (scripts/help-knowledge-learn.ts, audience "firm"),
// and the help menu's short guide in the portal's top bar.

export const FIRM_PORTAL_PURPOSE =
  "The Offerly firm portal is where recruiters at banks, funds and other finance firms post internships and campus events " +
  "to the college students who match with their firm, and see how those students engage.";

export type FirmGuideItem = {
  title: string;
  href: string;
  /** The full answer: the Help page and the firm assistant read this. */
  body: string;
  /** One line for the help menu, where the full body is too long to scan -
   *  the same job RECRUITING_PATH's bodies do in the student menu. */
  line: string;
  /** Extra words the menu's search matches, beyond the title and line. */
  keywords: string;
};

export const FIRM_GUIDE: FirmGuideItem[] = [
  {
    title: "Post an internship",
    line: "Add a role, its sectors and how to apply. Matched, eligible students are notified.",
    keywords: "job role posting listing apply new create",
    href: "/firms/internships/new",
    body:
      "Open Postings, click \"New posting\" and choose Internship. Give the role title, the sectors, which summer it runs, and a link or " +
      "email to apply through. Everything else is yours to write: the description, the requirements, and any extra details " +
      "you want to add as your own labelled fields. It goes live straight away in the internships list students browse, and " +
      "every student matched with your firm who is eligible gets a notification.",
  },
  {
    title: "Post a speaker event or info session",
    line: "Pick the schools it is for. Matched students there are notified.",
    keywords: "event info session speaker coffee chat webinar calendar schools",
    href: "/firms/events/new",
    body:
      "Open Postings, click \"New posting\" and choose Event. Pick the schools it is for, or open it to students anywhere. Students " +
      "matched with your firm at those schools are notified, and the event shows on your firm's page for them, with a button " +
      "to add it to their calendar.",
  },
  {
    title: "See how students engage",
    line: "Totals of who was notified, applied or saved - never a group under five.",
    keywords: "analytics stats numbers clicks views data engagement report",
    href: "/firms/analytics",
    body:
      "Analytics shows totals only: how many students were told about your posts, clicked apply, opened or saved your events, " +
      "and - counting only students who chose to share their profile with firms - how many matched with you, found contacts at your firm or tracked your roles, " +
      "and which schools and class years they come from. Groups of fewer than five students are never shown.",
  },
  {
    title: "Edit or close a post",
    line: "Change a post, or close it to stop showing it. Its analytics are kept.",
    keywords: "edit change update close remove delete reopen hide",
    href: "/firms/postings",
    body:
      "Open the post from Postings to edit it, or click \"Close\" to stop showing it to students. Switch between All, " +
      "Internships and Events at the top of the tab. Closed posts " +
      "keep their analytics and can be reopened.",
  },
  {
    title: "Find students to reach out to",
    href: "/firms/students",
    line: "Set what you're looking for and see the students who match, best first.",
    keywords: "students matching candidates recruit search requirements message email linkedin resume reach out talent",
    body:
      "Open Student matching and set your requirements: class years, sectors, cities, schools, degrees and majors. " +
      "Any group left empty accepts anyone, and the requirements are saved for your whole team. You see the students " +
      "who meet them, best first, with why each one matches - students who put your firm on their own shortlist come " +
      "first. Message them on Offerly, email them, open their LinkedIn or read their resume. Only students who chose to " +
      "share their profile with firms ever appear, and never their GPA or visa status.",
  },
  {
    title: "Add or remove teammates",
    line: "Approve colleagues who sign up, remove leavers, hand over ownership.",
    keywords: "team colleague member owner invite approve remove access",
    href: "/firms/team",
    body:
      "Colleagues sign up at /firms/signup with their work email. Your firm's owner approves them on the Team page, " +
      "removes anyone who leaves - which signs them out everywhere at once - and can click \"Make owner\" to hand the " +
      "firm to a colleague, becoming a member themselves.",
  },
  {
    title: "Signing in",
    line: "Your work email and password. A code resets a forgotten password.",
    keywords: "login sign in password reset forgot code account email",
    href: "/firms/login",
    body:
      "Sign in at /firms/login with your work email and password. Your work email is confirmed with a code once, when " +
      "you create the account. Forgot your password? Click \"Forgot password?\" and we'll email a code to reset it. A " +
      "sign-in lasts two weeks.",
  },
];

export const FIRM_HELP_STARTERS = [
  "How do I post an internship?",
  "Who sees my event?",
  "What do the analytics show?",
  "How do I add a teammate?",
] as const;

/**
 * The help menu's search: every guide item whose title, line or keywords hold
 * each word typed, by word start - the same matching as the student menu's
 * searchHelp, over the firm guide instead. Title hits rank first.
 */
export function searchFirmGuide(query: string, limit = 6): FirmGuideItem[] {
  const words = query.toLowerCase().split(/[^a-z0-9&]+/).filter(Boolean);
  if (words.length === 0) return [];
  const startsWord = (haystack: string, w: string) =>
    haystack.toLowerCase().split(/[^a-z0-9&]+/).some((part) => part.startsWith(w));
  return FIRM_GUIDE.map((item) => ({
    item,
    all: `${item.title} ${item.line} ${item.keywords}`,
    score: words.filter((w) => startsWord(item.title, w)).length,
  }))
    .filter(({ all }) => words.every((w) => startsWord(all, w)))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item }) => item);
}
