import { redirect } from "next/navigation";

// The marketing site used to own `/`. With it gone, a fresh clone should land
// in onboarding. This stays a one-liner because onboarding routes itself from
// there: it sends you to /dashboard once you've finished it, and on to the
// next unfinished step while you haven't.
export default function Home() {
  redirect("/onboarding");
}
