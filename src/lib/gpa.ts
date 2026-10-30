// A GPA as a student writes it. Shared by onboarding, the Interests tab and
// the resume reader, so all three accept exactly the same thing.
//
// 0 to 4.3 because a few schools grade above 4.0; up to two decimals because
// that is how transcripts report it. Plain module - the check runs in forms
// and on the server alike.

export function isValidGpa(value: string): boolean {
  const v = value.trim();
  if (!/^\d(\.\d{1,2})?$/.test(v)) return false;
  const n = Number(v);
  return n >= 0 && n <= 4.3;
}
