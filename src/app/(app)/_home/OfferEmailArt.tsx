// The offer-email artwork, inlined rather than loaded via <img>.
//
// It used to be `<img src="/images/offer-email.svg">`, but text inside an
// img-loaded SVG lives in a separate, script-inaccessible document: it can't be
// sequenced against the hero typewriter and, just as importantly, can't be
// verified from the page. Inlining puts the whole intro on one clock.
//
// This component is now the ONLY copy of the artwork - the standalone .svg was
// deleted rather than left in public/, where edits to it would have looked
// effective while changing nothing on screen. Edit the markup here.
//
// How the artwork itself works: the email is drawn ONCE into #content with the
// in-focus sentence as inline tspans, then stamped twice - a blurred copy
// masked to hide that sentence, and a sharp copy masked to show only it. The
// masks are feathered and complementary, so the boundary reads as a lens
// falling out of focus rather than a cut-out. The feather is anisotropic (wide
// in x, tight in y) because consecutive lines sit only ~8 units apart and a
// symmetric feather would lift its neighbours into focus too.
//
// FRAMING: the viewBox y-origin is 23, not 0. The letter occupies y 140-906,
// whose centre is 523 - but yMid centres the crop on the viewBox's centre (500),
// so the crop sat 23 units high and clipped the attachment row off the bottom
// while wasting space above the chrome bar. Shifting the origin re-centres the
// crop on the letter itself, costing no hero height. Width is still the full
// 1600 on purpose: The card sits at
// x=110, so the 110 units of dark margin to its left are what let the hero
// wordmark overlap the card's left border - that overlap is deliberate. An
// earlier version trimmed the viewBox to x=100 to help the narrow-screen crop,
// which both removed that overlap and changed the aspect from 1.6 to 1.5,
// cropping ~50 extra units off the top and bottom of the letter at desktop
// proportions. Don't narrow the viewBox again.
//
// preserveAspectRatio "slice" is the object-cover equivalent for inline SVG
// (object-fit does nothing here). xMin only matters on narrow viewports, where
// the crop is width-constrained; at desktop the hero is wider than 1.6 so the
// full width shows and the horizontal alignment is a no-op.
//
// The `t-line` class + `--i` index on each <text> drives the typing reveal
// (see .t-line in globals.css). Because both stamps <use> the same #content,
// clipping a line there reveals the blurred and sharp copies together.
export default function OfferEmailArt({
  className,
  style,
  viewBox = "0 23 1600 1000",
  preserveAspectRatio = "xMinYMid slice",
}: {
  className?: string;
  style?: React.CSSProperties;
  /** Framing is chosen by the parent from the hero's measured shape. */
  viewBox?: string;
  preserveAspectRatio?: string;
}) {
  return (
      <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" viewBox={viewBox} preserveAspectRatio={preserveAspectRatio} width="100%" height="100%" role="img" aria-label="An offer email, blurred except for the sentence: We're excited to offer you a spot in our 2028 Summer Analyst class.">
        <defs>

          <filter id="defocus" x="-6%" y="-6%" width="112%" height="112%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
          <filter id="feather" x="-30%" y="-40%" width="160%" height="180%">
            <feGaussianBlur stdDeviation="3.5 2.5" />
          </filter>
          <filter id="cardShadow" x="-12%" y="-12%" width="124%" height="124%">
            <feDropShadow dx="0" dy="26" stdDeviation="34" floodColor="#000000" floodOpacity="0.62" />
          </filter>

          <linearGradient id="desk" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#15171c" />
            <stop offset="1" stopColor="#08090b" />
          </linearGradient>
          <radialGradient id="vignette" cx="0.5" cy="0.40" r="0.78">
            <stop offset="0" stopColor="#000000" stopOpacity="0" />
            <stop offset="1" stopColor="#000000" stopOpacity="0.55" />
          </radialGradient>
          <linearGradient id="paper" x1="0" y1="0" x2="0.35" y2="1">
            <stop offset="0" stopColor="#fdfcfa" />
            <stop offset="1" stopColor="#f4f2ec" />
          </linearGradient>


          <g id="focusArea">
            <rect x="309" y="378" width="353" height="36" rx="4" />
            <rect x="159" y="412" width="374" height="36" rx="4" />
          </g>

          <mask id="sharpOnly">
            <rect width="1600" height="1000" fill="#000000" />
            <g filter="url(#feather)" fill="#ffffff"><use href="#focusArea" /></g>
          </mask>
          <mask id="blurOnly">
            <rect width="1600" height="1000" fill="#ffffff" />
            <g filter="url(#feather)" fill="#000000"><use href="#focusArea" /></g>
          </mask>

          <g id="content">

            <rect x="150" y="65" width="21" height="21" rx="5" fill="#a8aaad" />
            <rect x="190" y="65" width="21" height="21" rx="5" fill="#a8aaad" />
            <rect x="230" y="65" width="21" height="21" rx="5" fill="#a8aaad" />
            <rect x="294" y="69" width="150" height="13" rx="6" fill="#c9c7c1" />
            <rect x="1298" y="65" width="21" height="21" rx="5" fill="#a8aaad" />
            <rect x="1338" y="65" width="21" height="21" rx="5" fill="#a8aaad" />
            <rect x="1378" y="65" width="21" height="21" rx="5" fill="#a8aaad" />
            <rect x="1418" y="65" width="21" height="21" rx="5" fill="#a8aaad" />


            <circle cx="202" cy="152" r="27" fill="#16324a" />
            <text style={{ "--i": 0 } as React.CSSProperties} className="s t-line" x="202" y="159" fontSize="18" fontWeight="700" fill="#e8dcc4" textAnchor="middle">AP</text>
            <text style={{ "--i": 1 } as React.CSSProperties} className="s name t-line" x="248" y="144">Ashgrove Partners — Campus Recruiting</text>
            <text style={{ "--i": 2 } as React.CSSProperties} className="s meta t-line" x="248" y="172">campusrecruiting@ashgrovepartners.com</text>
            <text style={{ "--i": 3 } as React.CSSProperties} className="s meta t-line" x="1434" y="144" textAnchor="end">Thu, Oct 5, 9:14 AM</text>
            <text style={{ "--i": 4 } as React.CSSProperties} className="s meta t-line" x="1434" y="172" textAnchor="end">to me</text>


            <text style={{ "--i": 5 } as React.CSSProperties} className="s subj t-line" x="166" y="224">Summer Analyst Program — Offer of Employment</text>


            <text style={{ "--i": 6 } as React.CSSProperties} className="s body t-line" x="166" y="292">Dear Jordan,</text>
            <text style={{ "--i": 7 } as React.CSSProperties} className="s body t-line" x="166" y="336">Thank you for making the time to meet with our team over the past several weeks. Following</text>
            <text style={{ "--i": 8 } as React.CSSProperties} className="s body t-line" x="166" y="370">your final round on Thursday, the Investment Banking Division has completed its review of</text>
            <text style={{ "--i": 9 } as React.CSSProperties} className="s body t-line" x="166" y="404">your candidacy.<tspan className="crisp" dx="9">We&#8217;re excited to offer you a spot</tspan></text>
            <text style={{ "--i": 10 } as React.CSSProperties} className="s body t-line" x="166" y="438"><tspan className="crisp">in our 2028 Summer Analyst class.</tspan><tspan dx="10">The program runs ten weeks from</tspan></text>
            <text style={{ "--i": 11 } as React.CSSProperties} className="s body t-line" x="166" y="472">June 1, 2028, in our New York office, and includes housing support, relocation assistance,</text>
            <text style={{ "--i": 12 } as React.CSSProperties} className="s body t-line" x="166" y="506">and the full analyst training curriculum. Your compensation, start date, and desk</text>
            <text style={{ "--i": 13 } as React.CSSProperties} className="s body t-line" x="166" y="540">placement are set out in the attached offer letter.</text>

            <text style={{ "--i": 14 } as React.CSSProperties} className="s body t-line" x="166" y="588">We ask that you confirm your decision by 5:00 PM ET on Friday, October 13. If it would help</text>
            <text style={{ "--i": 15 } as React.CSSProperties} className="s body t-line" x="166" y="622">to speak with anyone on the team beforehand, we would be glad to arrange it.</text>
            <text style={{ "--i": 16 } as React.CSSProperties} className="s body t-line" x="166" y="670">Congratulations, and welcome to the desk.</text>

            <text style={{ "--i": 17 } as React.CSSProperties} className="s body t-line" x="166" y="794">Best regards,</text>
            <text style={{ "--i": 18 } as React.CSSProperties} className="s meta t-line" x="166" y="826">Campus Recruiting  ·  Ashgrove Partners</text>


            <rect x="166" y="860" width="386" height="46" rx="9" fill="#f0ede6" stroke="#ddd8ce" strokeWidth="1.5" />
            <rect x="184" y="873" width="20" height="20" rx="4" fill="#b0aca3" />
            <text style={{ "--i": 19 } as React.CSSProperties} className="s t-line" x="216" y="889" fontSize="17" fill="#6c7075">Offer_Letter_Ashgrove_2028.pdf</text>
          </g>
        </defs>

        <style>{`.s     { font-family: -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; }
          .body  { font-size: 20px; fill: #3c4045; }
          .meta  { font-size: 17px; fill: #74787d; }
          .name  { font-size: 20px; font-weight: 700; fill: #1a1d21; }
          .subj  { font-size: 29px; font-weight: 600; fill: #14181d; }
          /* Same column, same baseline grid, flowed inline with the sentence either
             side of it - only colour and a 2px size bump mark it out. */
          .crisp { font-size: 22px; font-weight: 600; fill: #1d3f78; }`}</style>

        <rect className="art-desk" width="1600" height="1000" fill="url(#desk)" />


        <g filter="url(#cardShadow)">
          <rect className="art-paper" x="110" y="48" width="1380" height="928" rx="14" fill="url(#paper)" />
        </g>
        <rect className="art-card-border" x="110" y="48" width="1380" height="928" rx="14" fill="none" stroke="#e6e2da" strokeWidth="1.5" />
        <path d="M110 62 a14 14 0 0 1 14 -14 h1352 a14 14 0 0 1 14 14 v42 h-1380 z" fill="#eeebe4" />
        <line x1="110" y1="104" x2="1490" y2="104" stroke="#e0dcd3" strokeWidth="1.5" />
        <line x1="166" y1="252" x2="1434" y2="252" stroke="#e4e0d7" strokeWidth="1.5" />

        <use href="#content" filter="url(#defocus)" mask="url(#blurOnly)" />
        <use href="#content" mask="url(#sharpOnly)" />

        <rect className="art-vignette" width="1600" height="1000" fill="url(#vignette)" />
      </svg>
  );
}
