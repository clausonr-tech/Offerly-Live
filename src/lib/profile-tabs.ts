// The profile's tabs. One list behind both the tab strip on the profile pages
// and the dropdown under the avatar, so a tab added here shows up in both -
// the same reason NAV_SECTIONS exists for the top nav.
//
// Plain module: the dropdown and the tab strip are client components.

export type ProfileTab = { href: string; label: string; description: string };

export const PROFILE_TABS: ProfileTab[] = [
  { href: "/profile", label: "Account", description: "Your details, contact info and resume" },
  { href: "/profile/interests", label: "Information", description: "Sectors and your background" },
  { href: "/profile/connections", label: "Connections", description: "Google Calendar, texts" },
  // Billing and Security are not here in the open-source build: there is no
  // plan to pay for, and no login email, password or session to manage. To
  // start over, delete the local-data/ directory.
];
