// The firm portal's rail: three sections and nothing else. Team and Help live
// in the top bar, beside the account menu, because they are about the account
// rather than about posting. Internships and events share one Postings tab -
// they are the two things a firm posts, and two tabs split one job in half.
import { BarChart3, Megaphone, Users } from "lucide-react";
import type { NavSection } from "@/lib/nav-sections";

export const FIRM_NAV_SECTIONS: NavSection[] = [
  { href: "/firms/postings", label: "Postings", Icon: Megaphone },
  { href: "/firms/analytics", label: "Analytics", Icon: BarChart3 },
  { href: "/firms/students", label: "Student matching", Icon: Users },
];
