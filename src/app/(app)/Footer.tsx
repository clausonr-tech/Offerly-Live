
import OfferlyLogo from "@/components/brand/OfferlyLogo";


// The background is the one thing here that DOES flip: navy in light mode,
// the same dark navy as the page itself in Dealroom (.site-footer in
// globals.css), so the footer reads as the floor of that page rather than a
// fixed navy band dropped on top of it. It is a CSS class rather than the
// inline style every other colour on this component uses, because
// [data-app-theme] overrides can't win against an inline style's specificity.
//
// Every text colour below stays a literal rgba()/hex value in BOTH themes,
// same as before - this app's dark theme REDEFINES --color-white to #0a0a0a
// as a themed near-black surface token (see bg-white's own doc comment), so
// `text-white` on this footer would render as near-black-on-dark -
// functionally invisible - under dark mode specifically. `.footer-link`'s
// hover state lives in globals.css for the same reason: `hover:text-white`
// has the identical bug.
//
// One band, not a sitemap: the brand on the left, then the two things anyone
// comes to a footer for - the legal pages and a way to reach us.

const LABEL = "font-mono text-[11px] uppercase tracking-[0.16em]";
const LABEL_STYLE = { color: "rgba(255,255,255,0.5)" };
// Tall enough to hit: 24px everywhere, 44px under a finger.
const LINK = "footer-link inline-flex min-h-6 items-center gap-1.5 whitespace-nowrap transition pointer-coarse:min-h-[44px]";

export default function Footer() {
  return (
    <footer
      style={{ color: "rgba(255,255,255,0.7)", borderTop: "1px solid rgba(255,255,255,0.3)" }}
      className="site-footer mt-6"
    >
      {/* Same max-w/px pair as <main> in (app)/layout.tsx, so the footer's
          content edges sit directly under the page's. */}
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-5 sm:px-6 md:flex-row md:items-start md:justify-between lg:px-10">
        <div>
          {/* Letters in white on the navy floor; the arrow keeps its blue. */}
          <OfferlyLogo title="Offerly" className="h-9 w-auto" style={{ color: "#ffffff" }} />
          <p className="mt-1.5 text-xs" style={{ color: "rgba(255,255,255,0.6)" }}>
            Beat the cycle - the recruiting workspace for students breaking into finance.
          </p>
          <p className="mt-1 text-[11px]" style={{ color: "rgba(255,255,255,0.5)" }}>
            &copy; {new Date().getFullYear()} Offerly. Built for students recruiting into finance.
          </p>
        </div>

        {/* md:pr-16 keeps the links clear of the message bubble, which is
            fixed in the bottom-right corner (MessageBubble: right-5, h-12 w-12 -
            about 73px of the edge at this app's 17px root). The row used to run
            to the page gutter and the email address slid under it. Below md
            the row stacks on the left, away from the bubble. */}
        {/* The hosted product's legal pages and support contact used to sit
            here. Both are gone: the legal pages went with the marketing site,
            and there is no support desk behind a copy you run yourself — the
            place to raise something is the repository. */}
        <div className="flex gap-x-10 text-sm md:pr-16">
          <div>
            <p className={LABEL} style={LABEL_STYLE}>Source</p>
            <ul className="mt-1 flex flex-col sm:flex-row sm:gap-x-4">
              <li>
                <a
                  href="https://github.com/clausonr-tech/Offerly-Live"
                  target="_blank"
                  rel="noreferrer noopener"
                  className={LINK}
                >
                  GitHub
                </a>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </footer>
  );
}
