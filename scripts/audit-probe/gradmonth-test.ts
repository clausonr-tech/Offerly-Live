// No type may ask the drafter for a graduation month: the profile holds only a
// year (users.gradYear), so the drafter followed GAP_RULES and left an
// unfillable "[graduation month]" in the body - 12 of 28 emails in the OUTPUT-1
// audit were unsendable for exactly this reason.
import { EMAIL_TYPES } from "../../src/lib/draft-templates";
let bad = 0;
for (const t of EMAIL_TYPES) {
  for (const note of t.promptNotes ?? []) {
    if (/graduation month/i.test(note) && !/never (ask for a graduation month|leave a placeholder)|isn't given/i.test(note)) {
      console.log(`FAIL ${t.id}: ${note}`); bad++;
    }
  }
}
console.log(bad === 0 ? `${EMAIL_TYPES.length}/${EMAIL_TYPES.length} types: no unfillable graduation-month request` : `${bad} failing`);
process.exit(bad === 0 ? 0 : 1);
