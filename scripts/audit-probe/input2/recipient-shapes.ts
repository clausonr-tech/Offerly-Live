// INPUT-2 probe 5/6b: what the prompt looks like for each resolveRecipient
// outcome, reproduced from the fields resolveRecipient actually sets.
import { buildDraftPrompt, type DraftPromptInput } from "../../../src/lib/draft-prompt";
import { fullInput } from "./fields";

const base = fullInput("cold_email");

// resolveRecipient "outside": contact.background = [group && `Group: ${group}`, about].join(". ")
const outsideFull: Partial<DraftPromptInput> = {
  contactGroup: "Healthcare M&A",
  contactBackground: "Group: Healthcare M&A. Spoke at our club last spring",
  contactSchool: null,
  contactRole: "Vice President",
  contactNotes: null,
  contactConnectionAngle: null,
  contactFirmDivisions: [],
  detectedOverlaps: [],
  alumniSchool: null,
};

// "outside" with every optional field blank: only name, firm, email are required.
const outsideBlank: Partial<DraftPromptInput> = {
  contactRole: null, contactSchool: null, contactBackground: null, contactNotes: null,
  contactGroup: null, contactConnectionAngle: null, contactFirmDivisions: [],
  detectedOverlaps: [], alumniSchool: null,
};

// a directory person with null firm/role/school: saveAsContact copies
// person.title -> role, person.school -> school, person.jobHistory -> background
const directoryNulls: Partial<DraftPromptInput> = {
  contactRole: null, contactSchool: null, contactBackground: null, contactNotes: null,
  contactGroup: null, contactConnectionAngle: null, contactFirmDivisions: [],
  detectedOverlaps: [], alumniSchool: null,
};

const section = (t: string) => t.slice(t.indexOf("RECIPIENT\n"), t.indexOf("\n\nTHIS EMAIL"));

for (const [name, over] of [["outside, all fields", outsideFull], ["outside, every optional blank", outsideBlank], ["directory person, null firm/role/school", { ...directoryNulls, contactFirm: null }]] as const) {
  const { userText } = buildDraftPrompt({ ...base, ...over } as DraftPromptInput);
  console.log(`\n### ${name}\n${section(userText)}`);
}

// group duplication check
const dup = buildDraftPrompt({ ...base, ...outsideFull } as DraftPromptInput).userText;
console.log(`\nMEASURED: "Healthcare M&A" appears ${dup.split("Healthcare M&A").length - 1} times in the prompt`);
