// OUTPUT-2 audit probe shared fixtures. Read-only on src/.
import type { DraftPromptInput } from "../../../src/lib/draft-prompt";

export const NOW = new Date("2026-10-11T12:00:00Z");

export const base: DraftPromptInput = {
  studentName: "Maya Patel",
  studentSchool: "University of Pennsylvania",
  studentSchoolEmail: "mpatel@wharton.upenn.edu",
  studentPhone: "5550101234",
  studentLinkedinUrl: "https://www.linkedin.com/in/mayapatel",
  studentGradYear: 2028,
  studentMajor: "Finance",
  contactName: "Rachel Stein",
  contactFirm: "Evercore",
  contactRole: "Vice President",
  type: "cold_email",
  now: NOW,
};

export const show = (v: unknown) => JSON.stringify(v);
export function row(label: string, input: unknown, output: unknown) {
  console.log(`CASE: ${label}`);
  console.log(`  IN : ${typeof input === "string" ? input : show(input)}`);
  console.log(`  OUT: ${typeof output === "string" ? output : show(output)}`);
  console.log("");
}
