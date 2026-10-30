import SectionTopBar from "../SectionTopBar";
import { requirePaidAccess } from "@/lib/plan-access";

/**
 * Interview Prep's frame: the navy title card every section opens with, then
 * its two views as tabs directly under it - Practice rounds and Video
 * interview (lib/nav-sections). The page used to be a full-bleed parchment
 * board in a pixel font; it now reads like the rest of the app. Only the
 * platformer game mode keeps the retro look, as its own full-screen overlay.
 */
export default async function LearnLayout({ children }: { children: React.ReactNode }) {
  await requirePaidAccess();
  return (
    <div className="space-y-6">
      {/* Literal hex: this card is always dark navy (see dashboard/page.tsx). */}
      <div className="rounded-2xl bg-gradient-to-br from-[#0b1526] via-[#1b2f4d] to-[#33517a] px-6 py-5 shadow-[0_10px_30px_-12px_rgba(11,21,38,0.55)]">
        <h1 className="app-hero-title text-2xl font-normal text-[#ffffff]">Interview Prep</h1>
        <p className="mt-1 text-sm text-[#c3cfe2]">
          Real interview questions, graded like an interviewer would - written, or on camera.
        </p>
      </div>
      <SectionTopBar sectionHref="/learn" hubLabel="Practice rounds" />
      {children}
    </div>
  );
}
