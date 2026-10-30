/**
 * A club's mark: its initials on a tile in a colour derived from its name.
 *
 * Clubs have no logo upload yet, and borrowing a real club's artwork would be
 * using its mark. A monogram is honest, stable (the same name always gets the
 * same colour) and readable in both themes because its colours are literal.
 */
const PALETTE = ["#1c3560", "#7a1f2b", "#1f5d4a", "#5b3a86", "#8a5a00", "#1d5f8a", "#6b2f4f", "#2f4b2a"];

function clubInitials(name: string): string {
  const words = name
    .replace(/\(.*?\)/g, "")
    .split(/\s+/)
    .filter((w) => /^[A-Za-z&]/.test(w) && !/^(at|of|the|and|for|&)$/i.test(w));
  return (words.slice(0, 3).map((w) => w[0]).join("") || "?").toUpperCase();
}

export default function ClubLogo({ name, size = 40 }: { name: string; size?: number }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const bg = PALETTE[h % PALETTE.length];
  const initials = clubInitials(name);
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-lg font-semibold tracking-wide"
      style={{
        width: size,
        height: size,
        backgroundColor: bg,
        color: "#ffffff",
        fontSize: Math.round(size * (initials.length > 2 ? 0.3 : 0.38)),
      }}
    >
      {initials}
    </span>
  );
}
