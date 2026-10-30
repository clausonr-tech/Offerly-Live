import { AVATAR_TONES, type AvatarTone } from "./data";

// Initials rather than a photo on purpose: the section works with no remote
// images, no next.config image domains, and nothing to 404 in a fresh clone.
export default function InitialsAvatar({
  initials,
  tone,
  size = "md",
  ring = "ring-[#0b1526]",
}: {
  initials: string;
  tone: AvatarTone;
  size?: "sm" | "md" | "lg";
  ring?: string;
}) {
  const box =
    size === "lg" ? "h-16 w-16 text-lg" : size === "sm" ? "h-7 w-7 text-[10px]" : "h-9 w-9 text-xs";

  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br ${AVATAR_TONES[tone]} ${box} font-medium tracking-wide text-white/90 ring-2 ${ring}`}
    >
      {initials}
    </span>
  );
}
