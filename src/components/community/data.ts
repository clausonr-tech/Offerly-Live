import { Building2, GraduationCap, Route, BadgeCheck, Share2, Users } from "lucide-react";
import type { CSSProperties, ComponentType } from "react";

type IconComponent = ComponentType<{
  className?: string;
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
}>;

export type GroupId = "peers" | "alumni" | "clubs";

type CommunityMember = {
  /** Two letters. Drawn as a gradient chip - no remote images, no image domains. */
  initials: string;
  tone: AvatarTone;
};

export type AvatarTone = keyof typeof AVATAR_TONES;

// Muted, desaturated pairs. Deliberately not neon: these sit behind a
// professional recruiting product, not a social app.
export const AVATAR_TONES = {
  steel: "from-[#3c5a72] to-[#243747]",
  violet: "from-[#584d80] to-[#332c52]",
  teal: "from-[#2f6a6d] to-[#1d4548]",
  sand: "from-[#6a5a45] to-[#40382c]",
  indigo: "from-[#3f4b80] to-[#252d50]",
  slate: "from-[#4a5565] to-[#2b323d]",
} as const;

export type CommunityGroup = {
  id: GroupId;
  label: string;
  description: string;
  /** One line of "what is happening here right now". */
  activity: string;
  /** Revealed when the cluster is selected. */
  message: string;
  /** Professional context chips. Keep to three or fewer. */
  tags: string[];
  /** Describes the affordance. Not a live action - nothing is sent. */
  actionLabel: string;
  icon: IconComponent;
  members: CommunityMember[];
  /** Beam + glow colour for this cluster. */
  accent: string;
  /** Sideways bow of the beam, in px. Sign picks which way it bends. */
  curvature: number;
  /** Desktop placement inside the constellation. Static classes so Tailwind
      can see them and so there is no layout shift on hydration. */
  positionClass: string;
};

// ---------------------------------------------------------------------------
// EDIT HERE. Names, descriptions, example activity, messages, tags and action
// labels for the three clusters all live in this array - nothing else needs
// touching to change the copy. Adding a fourth group works too: give it a
// positionClass and the beams, glows and keyboard order follow automatically.
// ---------------------------------------------------------------------------
export const COMMUNITY_GROUPS: CommunityGroup[] = [
  {
    id: "peers",
    label: "Peers",
    description: "Find students targeting similar industries, roles, and firms.",
    activity: "Maya is also recruiting for investment banking.",
    message: "Comparing notes on the Goldman superday timeline.",
    tags: ["Investment Banking", "New York", "Goldman Sachs"],
    actionLabel: "Message peer",
    icon: Users,
    accent: "#5a9ccc",
    curvature: -54,
    positionClass: "md:left-[21%] md:top-[19%]",
    members: [
      { initials: "MC", tone: "steel" },
      { initials: "RP", tone: "indigo" },
      { initials: "JL", tone: "slate" },
    ],
  },
  {
    id: "alumni",
    label: "Alumni",
    description: "Connect with alumni who can share experience, context, and advice.",
    activity: "Daniel · USC '22 · JPMorgan",
    message: "Happy to share what helped me prepare.",
    tags: ["Mentorship", "JPMorgan"],
    actionLabel: "Connect with alumni",
    icon: GraduationCap,
    accent: "#9184d6",
    curvature: 54,
    positionClass: "md:left-[79%] md:top-[19%]",
    members: [
      { initials: "DO", tone: "violet" },
      { initials: "SK", tone: "indigo" },
      { initials: "AT", tone: "steel" },
    ],
  },
  {
    id: "clubs",
    label: "Clubs",
    description: "Coordinate recruiting efforts with the organizations you already trust.",
    activity: "Trojan Investing Society",
    message: "Technical prep session · Thursday",
    tags: ["Campus", "Technical Prep"],
    actionLabel: "Open club workspace",
    icon: Building2,
    accent: "#5fb0b5",
    curvature: 0,
    positionClass: "md:left-[50%] md:top-[81%]",
    members: [
      { initials: "TI", tone: "teal" },
      { initials: "BW", tone: "sand" },
      { initials: "NV", tone: "slate" },
    ],
  },
];

// ---------------------------------------------------------------------------
// The signed-in student at the centre. Placeholder until this reads from the
// session - swap the four fields and the avatar follows from `initials`.
// ---------------------------------------------------------------------------
export const CENTRAL_USER = {
  name: "Alex Morgan",
  initials: "AM",
  subtitle: "USC · Class of 2028",
  focus: "Investment Banking",
  youLabel: "You",
};

/**
 * The three rows under the community heading.
 *
 * `text` is the claim and `detail` is what actually happens - kept apart so
 * the list still scans in one glance, and the explanation is there for anyone
 * who stops on a row rather than being paid for by everyone who does not.
 */
export const BENEFITS: { icon: IconComponent; text: string; detail: string }[] = [
  {
    icon: Route,
    text: "Find people on the same recruiting path",
    detail:
      "Your feed is filtered to students chasing the same sector and the same cycle as you - not a general campus wall. When someone a year ahead lands the summer analyst seat you are targeting, you see how their timeline actually ran, which firms opened when, and what they were asked.",
  },
  {
    icon: BadgeCheck,
    text: "Know who you are taking advice from",
    // Deliberately claims attribution, not truth. A verified school email
    // proves someone is at that school - it does not prove they sat the
    // superday they are describing, and saying otherwise would be the exact
    // overclaim this row is supposed to be the answer to.
    detail:
      "Every account is tied to a verified school email, so advice comes with a real school and class year attached. You can see exactly who is talking - the part anonymous forums leave out.",
  },
  {
    icon: Share2,
    text: "Turn club knowledge into shared momentum",
    detail:
      "Most of what a finance club knows lives in one spreadsheet and leaves when its officers graduate. Clubs here keep their firm lists, timelines and prep material in one place that survives the handover, so each year starts from what the last one learned rather than from nothing.",
  },
];
