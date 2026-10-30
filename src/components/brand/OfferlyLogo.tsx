import { ARROW_PATH, LETTERS_PATH, LOGO_BLUE, MARK_VIEWBOX, RING_PATH, WORDMARK_VIEWBOX } from "./logo-paths";

/**
 * The Offerly logo, as inline SVG.
 *
 * "wordmark" is the full logo; "mark" is the O and arrow alone, for anywhere
 * square or tight (the collapsed rail, the favicon). Size it with a height
 * class - the width follows the aspect. Letters take the surrounding text
 * colour, so set `color` (or a text-* class) on the element or its parent.
 *
 * Decorative by default: every place it sits is already a link or heading
 * that names Offerly. Pass `title` where the logo IS the name.
 */
export default function OfferlyLogo({
  variant = "wordmark",
  className,
  title,
  style,
}: {
  variant?: "wordmark" | "mark";
  className?: string;
  title?: string;
  style?: React.CSSProperties;
}) {
  const mark = variant === "mark";
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={mark ? MARK_VIEWBOX : WORDMARK_VIEWBOX}
      className={className}
      style={style}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      <path fill="currentColor" fillRule="evenodd" d={mark ? RING_PATH : LETTERS_PATH} />
      <path fill={LOGO_BLUE} fillRule="evenodd" d={ARROW_PATH} />
    </svg>
  );
}
