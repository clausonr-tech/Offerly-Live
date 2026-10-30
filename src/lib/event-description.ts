// A firm board's event description, as a student should read it.
//
// Some boards (Bank of America's among them) hand over their listing as a
// dump of form fields - "~~DATADICT_OPTGROUP_POSTING_LIST_OPP_ID~~:14548
// Title:EMEA | Paris | ... Event Date:24 Sep 2026 05:00 PM CEST Region:Europe,
// Middle East & Africa Country:France Line of Business:GLOBAL MARKETS". The
// title and date are already on the card, so they go; the template markers
// and ids go; what is left is the where and the which, as one plain line:
// "France · Europe, Middle East & Africa · Global Markets".
//
// A description that is ordinary prose comes back unchanged, bar whitespace.
// Pure, so every shape the boards send can be tested.

/** Field names these dumps use, longest first so "Event Date" wins over "Date". */
const KEYS = [
  "Line of Business",
  "Business Area",
  "Business Line",
  "Event Date",
  "Event Type",
  "Event Time",
  "Start Date",
  "End Date",
  "Description",
  "Location",
  "Country",
  "Region",
  "Division",
  "Program",
  "Format",
  "Venue",
  "Title",
  "Date",
  "Time",
  "City",
  "Type",
];

/** On the card already, or never worth a student's attention. */
const DROP = new Set(["title", "event date", "event time", "start date", "end date", "date", "time", "type", "event type"]);

/** The order the rest are shown in: where, then which part of the firm. */
const ORDER = ["city", "location", "venue", "country", "region", "line of business", "business area", "business line", "division", "program", "format"];

const KEY_RE = new RegExp(`(?:^|\\s)(${KEYS.map((k) => k.replace(/ /g, "\\s+")).join("|")})\\s*:`, "gi");

/** "GLOBAL MARKETS" reads as shouting; "Global Markets" does not. Acronyms stay. */
function calm(value: string): string {
  const letters = value.replace(/[^A-Za-z]/g, "");
  if (letters.length < 4 || value !== value.toUpperCase()) return value;
  return value
    .toLowerCase()
    .replace(/\b([a-z])([a-z]*)/g, (_, a: string, b: string) => (b.length <= 1 && /^(of|a|an|&)$/.test(a + b) ? a + b : a.toUpperCase() + b))
    .replace(/\b(Emea|Apac|Amer|Latam|Usa|Uk|Us|Ib|Ecm|Dcm|M&a)\b/g, (m) => m.toUpperCase());
}

export function cleanEventDescription(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Template markers and the id that follows them: "~~DATADICT_..~~:14548".
  const templated = /~~[A-Z0-9_]+~~|\{\{[^}]*\}\}/.test(raw);
  let text = raw
    .replace(/~~[A-Z0-9_]+~~\s*:?\s*\d*/g, " ")
    .replace(/\{\{[^}]*\}\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;

  const hits = [...text.matchAll(KEY_RE)];
  // A form dump is two or more known fields, or any that came wrapped in a
  // template marker or open the text ("Title:..." and nothing else). One
  // field mid-sentence is someone's prose that happens to say "Location:".
  const dump = hits.length >= 2 || (hits.length === 1 && (templated || (hits[0].index ?? 0) === 0));
  if (!dump) return text;

  const fields = new Map<string, string>();
  const lead = text.slice(0, hits[0].index ?? 0).trim();
  hits.forEach((m, i) => {
    const key = m[1].replace(/\s+/g, " ").toLowerCase();
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < hits.length ? (hits[i + 1].index ?? text.length) : text.length;
    const value = text
      .slice(start, end)
      .replace(/[|,;\s]+$/, "")
      .replace(/\.{3}$|…$/, "")
      .trim();
    if (value && !fields.has(key)) fields.set(key, value);
  });

  const prose = fields.get("description");
  const parts = ORDER.map((k) => fields.get(k))
    .filter((v): v is string => !!v && !DROP.has(v.toLowerCase()))
    .map(calm);
  // Anything else the dump carried that is neither dropped nor ordered.
  for (const [k, v] of fields) {
    if (DROP.has(k) || ORDER.includes(k) || k === "description") continue;
    parts.push(calm(v));
  }
  const line = [...new Set(parts)].join(" · ");
  text = [lead && !/^[\W\d]*$/.test(lead) ? lead : "", prose ?? "", line].filter(Boolean).join(" ");
  return text || null;
}
