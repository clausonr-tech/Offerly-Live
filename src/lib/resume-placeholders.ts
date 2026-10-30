// Bracketed gaps the rewrite leaves where a stronger line needs a number the
// original resume never gave - "[add figure: how many client accounts?]".
//
// Shared rather than duplicated: the exporters count them server-side and the
// UI flags them client-side, and the two must agree or the warning lies. No
// "server-only" here for that reason.

const PLACEHOLDER_ALL = /\[[^\]]+\]/g;

export function placeholdersIn(text: string | null | undefined): string[] {
  if (typeof text !== "string") return [];
  return text.match(PLACEHOLDER_ALL) ?? [];
}

/** Every placeholder across a structured resume, in reading order. */
export function collectPlaceholders(resume: {
  name?: string;
  contact?: string;
  sections?: { heading?: string; entries?: { org?: string; role?: string; location?: string; dates?: string; bullets?: string[] }[] }[];
}): string[] {
  const fields: (string | undefined)[] = [resume.name, resume.contact];
  for (const s of resume.sections ?? []) {
    fields.push(s.heading);
    for (const e of s.entries ?? []) {
      fields.push(e.org, e.role, e.location, e.dates, ...(e.bullets ?? []));
    }
  }
  return fields.flatMap(placeholdersIn);
}
