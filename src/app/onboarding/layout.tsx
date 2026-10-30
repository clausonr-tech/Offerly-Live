// Renders nothing of its own — it exists to mark onboarding as dynamic.
//
// Every page here reads the local user from the database, and the embedded
// PGlite that backs a self-hosted copy takes one connection at a time. Left
// prerenderable, `next build` opens it from several workers at once and aborts
// its WASM engine. See the note in lib/current-user.ts.
export const dynamic = "force-dynamic";

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return children;
}
