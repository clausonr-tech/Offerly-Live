import { Suspense } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { Bodoni_Moda, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import { getCurrentUser } from "@/lib/current-user";
import { repairOnboardingFlag } from "@/lib/onboarding-state";
import Logo from "./Logo";
import Sidebar from "./Sidebar";
import Footer from "./Footer";
import UserMenu from "./UserMenu";
import MessageBubbleSlot from "./MessageBubbleSlot";
import HelpMenu from "./HelpMenu";
import TimeZoneCookie from "./TimeZoneCookie";
import PromptFlashSlot from "./PromptFlashSlot";
import NotificationSlot from "./NotificationSlot";
import { RAIL_COOKIE, parseRailState } from "@/lib/sidebar-rail";
import { QuickDraftProvider } from "./drafts/QuickDraft";
import ApiKeyNotice from "./ApiKeyNotice";

// Every page in here is one person's own data, read from the database on each
// request — none of it was ever worth prerendering. Saying so explicitly also
// keeps `next build` from opening the embedded PGlite database from several
// render workers at once, which aborts its WASM engine. See the note in
// lib/current-user.ts for why this is declared here and not in that lookup.
export const dynamic = "force-dynamic";

// Authenticated-app-only type system - a trading-desk "Dealroom" identity,
// kept off the marketing/auth/onboarding pages on purpose (see [data-app-theme="terminal"]
// in globals.css, which scopes every color/shadow token to this subtree only).
// Bodoni Moda gives section headers real editorial weight; Plex Sans/Mono are
// a deliberate, cohesive pair (IBM's own type system) standing in for the
// generic Inter/Roboto default, with Plex Mono carrying the ticker-style data.
const displaySerif = Bodoni_Moda({
  variable: "--font-app-display",
  subsets: ["latin"],
});
const plexSans = IBM_Plex_Sans({
  variable: "--font-app-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});
const plexMono = IBM_Plex_Mono({
  variable: "--font-app-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const jar = await cookies();
  // Read here, beside the theme, for the same reason: the first painted HTML
  // has to carry the right rail width, or the page lurches sideways after
  // hydration on every load. See lib/sidebar-rail.
  const rail = parseRailState(jar.get(RAIL_COOKIE)?.value);

  // The firm-portal and consent gates that stood here are gone with the
  // screens they guarded. Consent was agreement to Offerly's handling of your
  // data before it collected any; self-hosted there is no one to agree with,
  // because the data never leaves the machine running this. Any outside
  // service it does reach is one you configured with your own key.
  //
  // Note consentedPolicyVersion is deliberately left null on the local user:
  // it is also what gates training capture (lib/training-rule.ts) and firm
  // sharing (lib/firm-sharing.ts), and both should stay off.

  // Onboarding is first-run guidance: a new account answers it once and the
  // answers are remembered from then on (and are editable in Settings).
  //
  // The repair below is for accounts that already HAVE answers but are missing
  // the flag recording it - seeded rows, or ones predating the questionnaire.
  // Without it the gate sends them back to "Add your LinkedIn" on every single
  // navigation. It writes at most once, because it sets the flag it checks.
  if (!user.onboardingCompletedAt) {
    const answered = await repairOnboardingFlag(user);
    if (!answered) {
      redirect(user.profileLinksPromptedAt ? "/onboarding" : "/onboarding/links");
    }
  }
  const initial = (user.name ?? user.email ?? "?").trim().charAt(0).toUpperCase();

  return (
    <div
      // Light only - dark mode was removed. The attribute stays because
      // portals and theme-scoped CSS target [data-app-theme].
      data-app-theme="light"
      // pl on lg only: that is where the rail stops being an overlay and
      // starts occupying a column the page has to make room for.
      // flex column + flex-1 on <main> is what keeps the footer on the floor
      // of the viewport. Without it a short page left the footer sitting
      // directly under its content with dead background below it, because the
      // min-h-screen stretched THIS box while the footer stayed at its natural
      // position. The marketing layout has always done it this way.
      // The sidebar is position:fixed (.app-sidebar), so it is out of flow and
      // never becomes a flex item here.
      // `app-shell` replaces what was `lg:pl-60`. The padding is no longer a
      // fixed step - it follows --rail-w so it tracks the rail when it
      // retracts, and a Tailwind utility cannot read a variable that another
      // rule sets conditionally. See the .app-shell block in globals.css.
      className={`${displaySerif.variable} ${plexSans.variable} ${plexMono.variable} terminal-canvas app-shell flex min-h-screen flex-col bg-background`}
    >
      {/* The rail renders the brand block itself, so the mark sits in the same
          column as the sections rather than floating above a page that begins
          further left.

          A plain <a>, deliberately not next/link: the mark is the way back to
          the top of the app from anywhere, and it is meant to land you on a
          FRESH page rather than restoring whatever state Opportunities was
          last left in. A client-side <Link> cannot do that - navigating to
          /dashboard while already there is a no-op. A real document load
          resets it. */}
      <Sidebar
        initialRail={rail}
        // Nothing is behind a plan in this build, so no section is ever shown
        // locked. The prop stays so the sidebar keeps the branch.
        lockPaidSections={false}
        brand={
          <a
            href="/dashboard"
            aria-label="Offerly - back to External Network"
            className="flex items-center text-brand-900 transition hover:opacity-80"
          >
            <Logo />
          </a>
        }
        actions={
          <>
            {/* Beside the bell rather than in the rail: help is about every
                page, not one section, and it sits with the other controls
                that follow the student around. Not streamed - it needs no
                query, so it paints with the bar. */}
            <HelpMenu />
            {/* Streamed, like the message bubble: the rail must not wait on a
                notification query to paint. Nothing renders until it lands,
                because a badge that appears and then changes its number is
                worse than one that appears once. */}
            <Suspense fallback={null}>
              <NotificationSlot userId={user.id} />
            </Suspense>
            <UserMenu name={user.name ?? user.email} initial={initial} />
          </>
        }
      />

      {/* The one-time heads-up: an application a month out with people still
          to email there, or an interview coming up with technicals unpractised. It is position:fixed and
          removes itself after a few seconds, so it occupies no space here and
          pushes nothing down. Streamed like the bubble below, and renders
          nothing at all when there is nothing to say. */}
      <Suspense fallback={null}>
        <PromptFlashSlot />
      </Suspense>
      {/* Reports the browser's time zone for the prompts that run on the
          student's own clock. Renders nothing. */}
      <TimeZoneCookie />

      {/* The gutter steps up with the viewport rather than sitting at a flat
          16px. On a wide screen the left of the page is cushioned by the
          sidebar panel while the right had only those 16px to the window edge,
          so the content read as pushed against it. The Footer carries the
          identical max-w/px pair so the two line up - change one, change both. */}
      {/* Holds the one "Draft email" panel every contact row opens - see
          drafts/QuickDraft. It wraps the page so a button anywhere reaches it. */}
      <QuickDraftProvider>
        <ApiKeyNotice />
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-10">{children}</main>
      </QuickDraftProvider>
      <Footer />
      {/* Streamed, not awaited - see MessageBubbleSlot. Nothing on the page
          depends on it, so it must never hold the page up. */}
      <Suspense fallback={null}>
        <MessageBubbleSlot userId={user.id} />
      </Suspense>
    </div>
  );
}
