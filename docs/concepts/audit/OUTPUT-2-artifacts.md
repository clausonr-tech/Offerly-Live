# OUTPUT-2: the artifacts, not the prose

Written 11 October 2026 against commit `0053b1a` (`perf/draft-pipeline`). The
branch moved to `5738bad` while this ran; `git diff 0053b1a HEAD` touches none of
the files audited here (one `promptNotes` line in `draft-templates.ts`), so every
output below still reproduces on HEAD. Audits
everything the draft pipeline produces besides the sentences: the signature
block, the subject line, the class-year description, the greeting instruction,
placeholders, `notesForStudent` and the date flagging.

**Method: no model, no database, no API.** Every row below is the output of a
real call to `signatureLines`, `finishDraft`, `classYearLabel`,
`isGraduateStudent`, `buildDraftPrompt` or `draftChecks`, plus one run of the
real `runDraftPipeline` with a stubbed Anthropic client (the pattern
`scripts/draft-guard-note-test.ts` uses) for the notes filter, which lives in
`draft-pipeline.ts` and is not exported. Probes:

```
npx tsx scripts/audit-probe/output2/sig.ts          # signature block
npx tsx scripts/audit-probe/output2/sig2.ts         # the assembled sign-off
npx tsx scripts/audit-probe/output2/subject.ts      # subject line
npx tsx scripts/audit-probe/output2/classyear.ts    # class year + grad detection
npx tsx scripts/audit-probe/output2/classyear2.ts   # grad detection on real resume text
npx tsx scripts/audit-probe/output2/greeting.ts     # greeting instruction + greeting notes
npx tsx scripts/audit-probe/output2/placeholders.ts # brackets, em dashes, //n
npx tsx scripts/audit-probe/output2/dates.ts        # date flagging
npx tsx scripts/audit-probe/output2/dates2.ts       # date flagging holes
npx tsx scripts/audit-probe/output2/notes.ts        # dedupe + APP_HANDLES
```

Baseline profile for every table unless the row says otherwise: Maya Patel,
University of Pennsylvania, `mpatel@wharton.upenn.edu`, phone `5550101234`,
LinkedIn `https://www.linkedin.com/in/mayapatel`, grad year 2028, major Finance,
writing a `cold_email` to Rachel Stein (VP, Evercore), `now` = 2026-10-11.

Verdicts: **CORRECT** (what it should do), **WRONG** (a student would be hurt or
embarrassed by it), **UGLY-BUT-SAFE** (odd output, nothing false or missing).

---

## 1. The signature block

`signatureLines` + `finishDraft`'s rebuild.

| Case | Input | Actual output | Verdict |
|---|---|---|---|
| baseline | full profile | `["Maya Patel","University of Pennsylvania ’28","mpatel@wharton.upenn.edu","(555) 010-1234","https://www.linkedin.com/in/mayapatel"]` | CORRECT |
| no name on profile | `studentName: ""` | `["University of Pennsylvania ’28","mpatel@…","(555) 010-1234","https://…"]` — no name line, nothing invented | CORRECT |
| name is "the student" | `studentName: "the student"` | same as above, name dropped | CORRECT |
| name is "The Student" | `studentName: "The Student"` | same, dropped (compare is lowercased) | CORRECT |
| no school | `studentSchool: null` | `["Maya Patel","mpatel@…","(555) 010-1234","https://…"]` | CORRECT |
| no grad year | `studentGradYear: null` | `[…,"University of Pennsylvania",…]` — school with no `’NN` | CORRECT |
| grad year in the past | `studentGradYear: 2021` | `[…,"University of Pennsylvania ’21",…]` | UGLY-BUT-SAFE (an alum signing "Penn ’21" is normal, but the prompt has already told the model "Not a current student") |
| MBA | `studentMajor: "MBA, Finance"`, 2027 | `["Maya Patel","University of Pennsylvania","MBA Class of 2027",…]` | CORRECT |
| MS Finance | `studentMajor: "MS Finance"`, 2027 | `[…,"University of Pennsylvania","Class of 2027",…]` | UGLY-BUT-SAFE (bare "Class of 2027" reads undergraduate) |
| JD | `studentMajor: "JD"`, 2027 | `[…,"University of Pennsylvania","Class of 2027",…]` | UGLY-BUT-SAFE (same) |
| grad student, no grad year | `studentMajor: "MBA"`, year null | `["Maya Patel","University of Pennsylvania","mpatel@…",…]` — no program line | CORRECT |
| phone `+1 555 010 1234` | — | `(555) 010-1234` | CORRECT |
| phone `555.010.1234` | — | `(555) 010-1234` | CORRECT |
| phone `15550101234` | — | `(555) 010-1234` | CORRECT |
| phone `+44 20 7123 4567` | UK | `+44 20 7123 4567` (as typed) | CORRECT |
| phone `(208) CALL-NOW` | letters | `(208) CALL-NOW` (as typed) | UGLY-BUT-SAFE |
| phone `"   "` | whitespace | line omitted | CORRECT |
| phone `0101234` | 7 digits | `0101234` | UGLY-BUT-SAFE |
| LinkedIn with tracking params | `…/mayapatel?utm_source=share&trk=public_profile` | printed verbatim, params included | UGLY-BUT-SAFE |
| every field null at once | all null | `[]` | CORRECT |
| rebuild over the model's own signature | model wrote `Sincerely,\nMaya Patel\nPenn '28\nmade-up@example.com` | `…\n\nBest,\nMaya Patel\nUniversity of Pennsylvania ’28\nmpatel@wharton.upenn.edu\n(555) 010-1234\nhttps://www.linkedin.com/in/mayapatel` — invented address gone | CORRECT |
| `gmailSignature: true` | same model body | `"Hi Rachel,\n\nI am a sophomore at Penn.\n\nBest,"` | CORRECT |
| `gmailSignature: true`, model wrote its own block under `Warm regards,` | — | `"Hi Rachel,\n\nThanks.\n\nBest,"` | CORRECT |
| `gmailSignature: true`, model already ended on `Best,` | — | `"Hi Rachel,\n\nThanks.\n\nBest,"` | CORRECT |
| `gmailSignature: true`, all-null profile | — | `"…\n\nBest,"` | CORRECT |
| no closing at all in the model body | `"Hi Rachel,\n\nI am a sophomore at Penn."` | closing + full signature appended | CORRECT |
| model wrote `Best, Maya` on one line | — | collapsed to one `Best,` + signature | CORRECT |
| model wrote `Best wishes, Maya Patel` | — | collapsed to one `Best,` + signature | CORRECT |
| **model wrote `Sincerely` with no comma** | `"…\n\nSincerely\nMaya Patel"` | `"…\n\nSincerely\nMaya Patel\n\nBest,\nMaya Patel\nUniversity of Pennsylvania ’28\n…"` — **two sign-offs, name twice** | **WRONG** |
| **model wrote `Thanks!` + name** | `"…\n\nThanks!\nMaya Patel"` | same shape: `Thanks!\nMaya Patel` kept, then `Best,` + signature | **WRONG** |
| **two closings in the body** | `"…\n\nThanks,\nMaya\n\nBest,\nMaya"` | `"…\n\nThanks,\nMaya\n\nBest,\nMaya Patel\n…"` — the first closing survives | **WRONG** (the comment claims "there is only ever one sign-off") |
| **closing earlier than the last 8 lines** | `Best,\nMaya` + 9 trailing lines | both the model's `Best,\nMaya\nl1…l9` **and** a second `Best,` + signature | **WRONG** |
| empty model body | `""` | `"\nBest,\nMaya Patel\n…"` — leading blank line | UGLY-BUT-SAFE |

---

## 2. The subject line

| Case | Input | Actual output | Verdict |
|---|---|---|---|
| reply, plain thread subject | `follow_up_1`, `originalSubject: "Coffee chat"` | `Re: Coffee chat` | CORRECT |
| reply, `"Re: Coffee chat"` | — | `Re: Coffee chat` | CORRECT |
| reply, `"RE: Coffee chat"` | — | `Re: Coffee chat` | CORRECT |
| reply, `"Fwd: Re: Coffee chat"` | — | `Re: Coffee chat` | CORRECT |
| reply, `"RE:RE: Coffee"` | — | `Re: Coffee` | CORRECT |
| reply, `"Re - Coffee"` | — | `Re: Coffee` | CORRECT |
| reply, thread subject `""` | — | `Following up` (the model's subject) | CORRECT |
| reply, thread subject `"   "` | — | `Following up` | CORRECT |
| reply, thread subject `"Re:"` | — | `Following up` | CORRECT |
| reply type, brief carries `threadSubject` not `originalSubject` | `follow_up_1` | `Following up` — thread lost | UGLY-BUT-SAFE (upstream `draft-request.ts:344` refuses the request without `originalSubject`, so unreachable today) |
| **non-reply type with a `threadSubject`** | `cold_email`, `threadSubject: "Coffee chat"` | **`Re: Coffee chat`** on a first-contact email | **WRONG** (latent: only six non-reply types collect the field today, none of them cold) |
| non-reply, model returns `Re: Quick question` | — | `Quick question` | CORRECT |
| non-reply, model returns `Fwd: Re: Quick question` | — | `Quick question` | CORRECT |
| model subject with an em dash | `Penn student — quick question` | `Penn student, quick question` | CORRECT |
| **model subject with an en dash** | `Penn student – quick question` | `Penn student – quick question` (unchanged) | UGLY-BUT-SAFE |
| **model subject, digit range em dash** | `Summer 2023—2025 recruiting` | **`Summer 2023, 2025 recruiting`** | **WRONG** (the body protects `(\d)—(\d)`; the subject does not) |
| model subject `Penn—–student` | — | `Penn, –student` | UGLY-BUT-SAFE |
| empty model subject | `""` | `University of Pennsylvania Student Reaching Out` | CORRECT |
| empty model subject, no school | `""`, school null | `Hello` | CORRECT |
| whitespace-only model subject | `"   "` | `University of Pennsylvania Student Reaching Out` | CORRECT |
| model subject `"Re:"` only | — | `University of Pennsylvania Student Reaching Out` | CORRECT |
| **model subject is only an em dash** | `"—"` | **`,`** — a one-character subject | **WRONG** (fallback never fires: the rewrite runs before the `\|\|`) |
| very long model subject (219 chars) | — | passed through whole, uncut | UGLY-BUT-SAFE |
| very long thread subject | — | `Re: ` + all 219 chars | CORRECT (threading needs it intact) |
| thread subject with an em dash | `Coffee — Thursday` | `Re: Coffee — Thursday` (em dash kept) | CORRECT |
| thread subject padded with spaces | `"  Coffee chat  "` | `Re: Coffee chat` | CORRECT |
| **thread subject containing a newline** | `"Coffee\nchat"` | `"Re: Coffee\nchat"` — two-line subject | UGLY-BUT-SAFE (the student copies the subject by hand; no send path takes it as a header) |

---

## 3. Class year and student description

`classYearLabel(2028, now)` across the rollover, and both `2026` / `2027` for contrast:

| `now` | gradYear 2026 | 2027 | 2028 | Verdict |
|---|---|---|---|---|
| 2026-01-15 … 2026-05-15 | `"senior"` | `"junior"` | `"sophomore"` | CORRECT |
| 2026-06-15, 2026-07-15 | `null` | `"junior"` | `"sophomore"` | CORRECT |
| 2026-08-15 … 2026-12-15 | `null` | `"senior"` | `"junior"` | CORRECT (August rollover, as documented) |

| Case | Input | Actual output | Verdict |
|---|---|---|---|
| June boundary | 2026-05-31 / 2026-06-01, gradYear 2026 | `"senior"` / `null` | CORRECT (matches "graduated by June") |
| spread at 2026-10-11 | 2024/2025/2026 | `null` / `null` / `null` | CORRECT |
| | 2027/2028/2029/2030 | `"senior"` / `"junior"` / `"sophomore"` / `"freshman"` | CORRECT |
| 5+ years out | 2031, 2032 | `null`; the prompt then says `Graduation year: 2031` with no class year | CORRECT (says nothing rather than something odd) |
| graduated, undergrad | gradYear 2026 in October | prompt: `Graduated in 2026. Not a current student: describe them by their degree and their work since…` | CORRECT |
| **graduated, graduate student** | `studentMajor: "MBA"`, gradYear 2024 | prompt: `Graduate student (graduates 2024). Never call them a freshman…` — **still a current student** | **WRONG** (`hasGraduated` is never consulted on the graduate branch) |

`isGraduateStudent` on the **major** field:

| Input major | Output | Verdict |
|---|---|---|
| `"MBA, Finance"`, `"MS Finance"`, `"M.S. in Finance"`, `"Master of Science in Finance"`, `"Masters in Finance"`, `"MSF"`, `"MFin"`, `"LLM"`, `"JD"`, `"mba"` | `true` | CORRECT |
| `"Finance"`, `"Pre-MBA"`, `"pre-MBA analyst"`, `"Rutgers Business School"`, `"BS/MS"` | `false` | CORRECT (the documented negative cases hold) |
| **`"BS/MS Finance"`** | **`true`** | **WRONG** — `(?<!\/)` guards the bare `MS` token, but the separate `\bM\.?S\.? (in )?Finance\b` alternative has no guard |
| **`"Economics (MBA pipeline)"`** | **`true`** | **WRONG** |
| `"J.D. Power"` | `true` | UGLY-BUT-SAFE — the comment names this as a case that must not count; it only stays safe because the regex is applied to the major, never to resume text |
| `"Ph.D. candidates"` | `true` | UGLY-BUT-SAFE — same |

`isGraduateStudent` on a resume summary in the **real** format
(`resume-profile.formatSummary`: `EDUCATION` / `- School · detail`):

| Case | Input (education line) | Output | Verdict |
|---|---|---|---|
| undergraduate | `- Vanderbilt University · BS in Economics, May 2028` | `false` | CORRECT |
| master's | `- Vanderbilt University · MS in Finance, May 2027` | `true` | CORRECT |
| MBA | `- Wharton · MBA, May 2027` | `true` | CORRECT |
| spelled out | `- Vanderbilt University · Master of Science in Finance, 2027` | `true` | CORRECT |
| `"Candidate for MBA, 2027"` | — | `false` | UGLY-BUT-SAFE (degree must follow the `·`) |
| school called "Business School" | `- Rutgers Business School · BS in Finance, 2028` | `false` | CORRECT (the documented case) |
| employer `J.D. Power` in WORK EXPERIENCE | — | `false` | CORRECT (the documented case) |
| `J.D. Power` on an EDUCATION line | `- J.D. Power · Scholar, 2025` | `false` | CORRECT |
| `Ph.D. candidates` in a club highlight | — | `false` | CORRECT (the documented case) |
| master's only in WORK EXPERIENCE | `- Vanderbilt · MS Finance teaching assistant · 2025` | `false` | CORRECT (education lines only) |
| comma-separated, no `·` | `- Vanderbilt University, MS Finance, 2027` | `false` | UGLY-BUT-SAFE (not the format the app writes) |
| **next header not ALL CAPS** | `EDUCATION\n- Rutgers · BS Finance, 2028\n\nWork experience\n- Vanderbilt · MS Finance TA · 2025` | **`true`** | UGLY-BUT-SAFE (section break is `^[A-Z0-9&@ ]{4,}$`; the app always writes caps headers, so only legacy text bleeds) |
| no EDUCATION section | `WORK EXPERIENCE\n- Wharton · MBA candidate · 2027` | `false` | CORRECT |

What the false positive then produces (`signatureLines`):

```
major "BS/MS Finance":            grad=true   ["Maya Patel","University of Pennsylvania","Class of 2028",…]
major "Economics (MBA pipeline)": grad=true   ["Maya Patel","University of Pennsylvania","MBA Class of 2028",…]
major "Pre-MBA":                  grad=false  ["Maya Patel","University of Pennsylvania ’28",…]
```

---

## 4. The greeting

`greetingInstruction` is private, so it is read back off the prompt
`buildDraftPrompt` actually produces. "(none)" means no instruction, i.e. the
house default `Hi {first name},`.

| Case | Input `contactName` | Actual output | Verdict |
|---|---|---|---|
| ordinary name | `Rachel Stein` | (none) → house default | CORRECT |
| shouting | `RACHEL STEIN` | `Greeting: write "Hi Rachel," - the first name only, without titles, credentials or anything in brackets.` | CORRECT |
| lowercase | `marcus lee` | `… write "Hi Marcus," …` | CORRECT |
| doctor | `Dr. Amy Adams` | `Greeting: write "Dear Dr. Adams," - never their first name alone.` | CORRECT |
| doctor, no period | `Dr Amy Adams` | `… "Dear Dr. Adams," …` | CORRECT |
| **Dean as a first name** | `Dean Martin` | (none) → `Hi Dean,` | CORRECT (documented) |
| Dean as a title | `Dean Amy Adams` | `… "Dear Dean Adams," …` | CORRECT |
| professor | `Professor Amy Adams` / `Prof. Adams` | `… "Dear Professor Adams," …` | CORRECT |
| credentials | `Rachel Stein, CFA` | `… "Hi Rachel," …` | CORRECT |
| suffix | `Rachel Stein, Jr.` | `… "Hi Rachel," …` | CORRECT |
| nickname | `Rachel (Rae) Stein` | `… "Hi Rachel," …` | CORRECT |
| **bare email address** | `rachel@firm.com` | **`Greeting: write "Hi Rachel@firm.com," …`** | **WRONG** |
| name + angle-bracket email | `Rachel Stein <rachel@firm.com>` | `… "Hi Rachel," …` | CORRECT |
| team | `Campus Recruiting` | `Greeting: this is a team or inbox, not a person. Write "Hello Campus Recruiting,", never "Hi Campus Recruiting,".` | CORRECT |
| team | `Evercore Recruiting Team` | `… Write "Hello Evercore Recruiting Team," …` | CORRECT |
| to whom | `To Whom It May Concern` / lowercase | `Greeting: no name was given. Write "Hello," - never "To whom it may concern".` | CORRECT |
| single name | `Rachel` | (none) → `Hi Rachel,` + a student note (below) | CORRECT |
| **empty name** | `""` or `"   "` | **(none)** — no instruction at all, while "To whom" gets `Hello,` | UGLY-BUT-SAFE |
| name that is the firm | `Evercore` | (none) → `Hi Evercore,` + a student note (below) | UGLY-BUT-SAFE (caught after the fact, not before) |
| honorific | `Mr. Marcus Lee` / `MS. AMY ADAMS` | `… "Hi Marcus," …` / `… "Hi Amy," …` | CORRECT |
| trailing credential, no comma | `Amy Adams PhD` | (none) → `Hi Amy,` | CORRECT |
| apostrophe / hyphen | `O'Brien`, `Jean-Luc Picard` | (none) | CORRECT |
| **title that is also a role** | `Team Lead Rachel Stein` | **(none)** — `team(?!\s+lead)` excludes it, so "first name" = "Team" | UGLY-BUT-SAFE |
| non-Latin | `李 明` | (none) | CORRECT |
| double space | `Rachel  Stein` | (none) | CORRECT |

`draftChecks(...).forStudent` on the finished greeting:

| Case | Input | Actual output | Verdict |
|---|---|---|---|
| greeting is the firm | name `Evercore`, firm `Evercore`, `Hi Evercore,` | `["The email opens \"Hi Evercore,\", which is part of the firm's name. Check the name of the person you're emailing."]` | CORRECT |
| greeting is one word of the firm | name `Goldman`, firm `Goldman Sachs & Co.`, `Hi Goldman,` | same note | CORRECT |
| one name on file | name `Rachel`, `Hi Rachel,` | `["There's only one name on file … Make sure that's their first name."]` | CORRECT |
| full name | name `Rachel Stein`, `Hi Rachel,` | `[]` | CORRECT |
| team / titled | `Campus Recruiting`, `Dr. Amy Adams` | `[]` (exempt) | CORRECT |
| **greeting with no comma** | name `Rachel`, `Hi Rachel` | `[]` — the check needs `,$`, so it is silent | UGLY-BUT-SAFE |

---

## 5. Gaps and placeholders

Composer (`Composer.tsx:75`) finds unfilled gaps with `/\[[^\]\n]{2,}\]/g` over
subject + body and blocks sending, so what `finishDraft` does to a bracket is
also what the send gate sees.

| Case | Input body | Actual output | Verdict |
|---|---|---|---|
| plain placeholder | `I am interested in [their group].` | unchanged; `brackets out: ["[their group]"]` | CORRECT |
| placeholder in the last body line, no closing | `I applied to [the role].` | kept, closing appended after it | CORRECT |
| placeholder in the subject | subject `Question about [their group]` | `Question about [their group]` | CORRECT |
| placeholder before a `//n` break | `… [their group].//nI had two questions.` | `… [their group].\n\nI had two questions.` — bracket intact | CORRECT |
| **em dash inside a placeholder** | `Could we talk [date — time]?` | **`[date, time]`** | UGLY-BUT-SAFE (still a bracket, but no longer equal to the `gaps[].placeholder` string the model reported) |
| **digit range inside a placeholder** | `I worked there [2023—2025].` | **`[2023-2025]`** | UGLY-BUT-SAFE (same) |
| em dash inside a placeholder, in the subject | `[date — time] confirmation` | `[date, time] confirmation` | UGLY-BUT-SAFE |
| en dash inside a placeholder | `[date – time]` | unchanged | CORRECT |
| **`//n` inside a placeholder** | `[their//nGroup]` | `[their\n\nGroup]`; `brackets out: null` — **the send gate stops seeing it** | **WRONG** |
| placeholder inside the model's signature | `Best,\nMaya Patel\n[phone number]\nPenn '28` | signature rebuilt; `brackets out: null` | CORRECT |
| **placeholder after the sign-off** | `Best,\nMaya\n\nP.S. I applied to [the role].` | the whole P.S. deleted, no note | UGLY-BUT-SAFE (by design, but real content disappears silently) |
| placeholder after the sign-off, `gmailSignature` | same | body ends `Best,`; P.S. gone | UGLY-BUT-SAFE |
| placeholder spanning a newline | `[their\ngroup]` | preserved, but Composer's regex excludes `\n` → invisible to the gate | UGLY-BUT-SAFE |
| one-character placeholder | `[x]` | preserved, invisible to the gate (`{2,}`) | UGLY-BUT-SAFE |
| double brackets | `[[their group]]` | preserved | UGLY-BUT-SAFE |
| bracket that looks like a closing | last line `[Best, Maya]` | kept, real `Best,` appended after it | UGLY-BUT-SAFE |
| `gaps` array itself | any | never touched by `finishDraft` | CORRECT |

The em-dash and `//n` rewrites on their own:

| Input | Actual output | Verdict |
|---|---|---|
| `M&A.//nI had two questions.` | `M&A.\n\nI had two questions.` | CORRECT |
| `See https://x.com//next for details.` | unchanged | CORRECT |
| `See https://cal.com//Newslots for times.` | unchanged (the rule needs a literal `//n` then a capital) | CORRECT |
| `See //Newslots.cal.com for times.` | unchanged | CORRECT |
| `I worked 2023—2025 there.` / `2023 — 2025` | `2023-2025` | CORRECT |
| `— one point\n— another` | `- one point\n- another` | CORRECT |
| `The team—the whole team—was great.` | `The team, the whole team, was great.` | CORRECT |
| **`The team – the whole team – was great.`** | unchanged (en dash) | UGLY-BUT-SAFE |
| `Trailing dash //\nnext line.` | `Trailing dash \nnext line.` (trailing space left) | UGLY-BUT-SAFE |
| `lowercase after //nhere.` | unchanged | CORRECT |

---

## 6. `notesForStudent`

One real `runDraftPipeline` run (stub client, `review: null`) with 25 candidate
notes in the model's `notesForStudent`: **25 in, 14 out.**

Notes the filter is for, correctly removed:

| Note | Result | Verdict |
|---|---|---|
| `Attach your resume to the email before you send it.` | STRIPPED | CORRECT |
| `Attach the resume to this email.` | STRIPPED | CORRECT |
| `Your resume will be attached automatically.` | STRIPPED | CORRECT |
| `Your Gmail signature will be added after the sign-off.` | STRIPPED | CORRECT |
| `Gmail adds your signature, so the email ends on Best,.` | STRIPPED | CORRECT |
| `I left the signature block to your email client.` | STRIPPED | CORRECT |
| `I didn't include your phone number in the signature.` | STRIPPED | CORRECT |
| `I did not include your email address.` | STRIPPED | CORRECT |

Notes that legitimately mention a resume, correctly kept:

| Note | Result | Verdict |
|---|---|---|
| `The review added "Pinecrest", which isn't in what you typed - it may have come from your resume. Check it reads right before you send.` (the guard's proper-noun note) | KEPT | CORRECT |
| `Your resume lists the internship as 2024; this email calls it recent. Check which is right.` | KEPT | CORRECT |
| `The resume on file is named for someone else. Check you uploaded yours.` | KEPT | CORRECT |
| `Attach your unofficial transcript before sending.` | KEPT | CORRECT |
| `Double-check "October 5" - that date wasn't in what you entered.` | KEPT | CORRECT |
| `This email mentions "laid off". Private or sensitive details usually don't belong…` | KEPT | CORRECT |
| `There's only one name on file for the person you're emailing…` | KEPT | CORRECT |

Where it fails:

| Note | Result | Verdict |
|---|---|---|
| `Remember to attach a copy of your resume.` | KEPT | **WRONG** (app-handled, leaks) |
| `Don't forget your resume.` | KEPT | **WRONG** |
| `Please attach your résumé.` | KEPT | **WRONG** (accented spelling) |
| `Add your resume as an attachment.` | KEPT | **WRONG** |
| `Your email signature will be added automatically, so the draft ends on Best,.` | KEPT | **WRONG** (only "gmail signature" / "signature block/line" are matched) |
| `I didn't add your phone number.` | KEPT | **WRONG** (only "include" is matched) |
| `Her signature block says she has moved to the London office, so check the firm name.` | STRIPPED | **WRONG** (about the recipient's signature, not the student's) |
| `Attach your resume to the firm's application portal, not to this email - they asked for it there.` | STRIPPED | **WRONG** (the one case where the student really must do it by hand) |
| `Attach your unofficial transcript before sending.` twice, one lowercased | both KEPT (exact duplicate deduped, case variant not) | UGLY-BUT-SAFE |

---

## 7. The date flagging

| Case | Typed by the student | Draft says | Actual note | Verdict |
|---|---|---|---|---|
| numeric → month name | `call on 10/5` | `October 5` | none | CORRECT |
| abbreviated + ordinal | `call on 10/5` | `Oct. 5th` | none | CORRECT |
| day-first | `call on 10/5` | `5 October` | none | CORRECT |
| "of" form, different date | `call on 10/5` | `the 3rd of September` | `Double-check "3rd of September" - that date wasn't in what you entered.` | CORRECT |
| flipped reading | `call on 10/5` | `May 10` | none | CORRECT (documented: both readings count as given) |
| invented date | nothing | `October 5` | `Double-check "October 5" …` | CORRECT |
| same date twice | nothing | `October 5` … `October 5` | one note | CORRECT |
| two invented dates | nothing | `Oct 5` … `Nov 6` | two notes, each naming the date as written | CORRECT |
| date only in the subject | nothing | subject `Following up on October 5` | `Double-check "October 5" …` | CORRECT |
| `Sept 5` | nothing | `Sept 5` | `Double-check "Sept 5" …` | CORRECT |
| month + year, no day | nothing | `June 2026`, `March 2026` | none | CORRECT |
| ordinal with no month | nothing | `the 5th` | none | CORRECT |
| date after the sign-off | nothing | `Best,\nMaya\nSee you October 5` | body cut back to `Thanks.`; **no note** | CORRECT (the text never reaches the student) |
| date in the model's signature lines | nothing | `Best,\nMaya Patel\nPenn, October 5 cohort` | signature rebuilt; no note | CORRECT |
| hyphenated URL path | nothing | `https://cal.com/maya/October-5.` | none | CORRECT |
| numeric URL path | nothing | `https://cal.com/maya/10/5` | none | CORRECT |
| phone-shaped field | `studentPhone: "208/315"` | `August 15` | flagged | CORRECT |
| date in the resume summary | resume `started August 15` | `August 15` | none | UGLY-BUT-SAFE (anything in the input counts as "entered", including resume text the student never typed) |
| **`1/2 hour` whitelists two dates** | `we spoke for 1/2 hour` | `January 2 or February 1` | **none** | **WRONG** |
| **February 30, typed** | `maybe February 30?` | `February 30` | **none** | UGLY-BUT-SAFE (only the prompt asks for a bracket; nothing deterministic checks the calendar) |
| February 30, invented | nothing | `February 30` | `Double-check "February 30" …` | CORRECT |
| **invented numeric date** | nothing | `Could we speak 11/20?` | **none** | **WRONG** |
| **invented ISO date** | nothing | `2026-11-20` | **none** | **WRONG** |
| **invented weekday** | nothing | `next Tuesday` | **none** | UGLY-BUT-SAFE (out of the rule's stated scope) |
| month name used as a verb | nothing | `May 5 suits me, and I may 6 be free.` | `Double-check "May 5" …`, **`Double-check "may 6" …`** | UGLY-BUT-SAFE (false positive; the input is contrived) |
| URL with a space before the day | nothing | `…/maya/October 5 slot` | flagged | UGLY-BUT-SAFE |

---

## What is solid

- **The August rollover and the June graduation boundary.** Verified month by
  month for three graduation years; every label is the one the comment claims.
  Five-plus years out returns `null` rather than inventing a label.
- **Graduate detection against the resume format the app actually writes.** All
  three counter-examples the comment names (`Rutgers Business School`,
  `J.D. Power`, `Ph.D. candidates`) are correctly `false` in resume text, and a
  master's in WORK EXPERIENCE does not count as the student's own degree.
- **`gmailSignature: true` ends on `Best,` with nothing after it** — in all four
  shapes tried, including when the model wrote its own signature block under a
  different closing.
- **The signature rebuild deletes what the model invented**: a made-up email
  address, a `[phone number]` placeholder, a mis-formatted school line. Phone
  normalises from three formats; a UK number and a lettered number pass through
  as typed rather than being mangled; `"the student"` and an empty name are
  never printed; an all-null profile yields `[]`, not blank lines.
- **Thread subjects.** `Re:`, `RE:`, `Fwd: Re:`, `RE:RE:` and `Re - ` all
  collapse to exactly one `Re: `, padding is trimmed, an em dash inside a thread
  subject is left alone (threading survives), and an empty or `Re:`-only thread
  subject falls back instead of producing `Re: `.
- **The greeting instruction** on 30 name shapes: honorifics, credentials,
  suffixes, nicknames, angle-bracket emails, ALL CAPS, all-lowercase, team
  inboxes, "To whom it may concern", and the `Dean Martin` / `Dean Amy Adams`
  distinction — all correct.
- **Placeholders survive `finishDraft`** in the body and the subject, and the
  `//n` rewrite cannot damage a URL (it needs a literal `//n` followed by a
  capital; `x.com//next`, `cal.com//Newslots` and `//Newslots.cal.com` were all
  left alone).
- **The date rule's core.** Every month-name form the students' and models'
  prose uses maps to the same key; a date that was typed numerically is
  recognised in any written form; notes are one-per-date; the subject is
  checked; text the rebuild deletes is excluded, so no note ever points at
  words the student cannot see.
- **The guard's proper-noun note reaches the student**, is not stripped by the
  notes filter, and is not duplicated. Re-verified here, independently of
  `scripts/draft-guard-note-test.ts`.
- **`draftChecks`'s greeting notes**: the firm-name greeting and the
  single-name-on-file greeting both fire, and full names, teams and titled
  recipients correctly produce nothing.

---

## Ranked findings

1. **`"BS/MS Finance"` turns a sophomore into a graduate student** (artifact 3).
   `(?<!pre-)(?<!\/)` guards the bare degree tokens, but the `\bM\.?S\.? (in )?Finance\b`
   alternative is unguarded. Consequence: the signature drops the class year and
   prints `Class of 2028`, and the prompt instructs the model to "lead with the
   prior career" and that "they recruit at the associate level, not analyst" —
   for a 20-year-old. `"Economics (MBA pipeline)"` goes further and prints
   `MBA Class of 2028`. Dual-degree majors are common enough that this will be
   live.
2. **A graduate student who has already graduated is still called a current
   student** (artifact 3). MBA + gradYear 2024 yields `Graduate student
   (graduates 2024)`, where an undergraduate gets `Graduated in 2024. Not a
   current student`. Consequence: an alum introduces themselves as a student.
3. **The notes filter leaks the notes it exists to delete and deletes two it
   should keep** (artifact 6). Six realistic phrasings of "attach your resume" /
   "your signature is automatic" pass — the comment says "nearly every live
   draft carried one of these" — while a note about *the recipient's* signature
   block and the one legitimate "attach it to the portal yourself" note are
   silently removed.
4. **Two sign-offs in one email, three ways** (artifact 1). A closing without a
   comma (`Sincerely\nMaya`, `Thanks!\nMaya`) is not recognised; an earlier
   closing survives when a later one exists; a closing further than 8 lines from
   the end is missed. Each leaves the student's name printed twice above a
   second `Best,`. The code comment claims "there is only ever one sign-off".
5. **A subject line of `,`** (artifact 2). The em-dash rewrite runs before the
   `||` fallback, so a model subject of `"—"` becomes `","` instead of
   `University of Pennsylvania Student Reaching Out`. Same bug class:
   `Summer 2023—2025 recruiting` → `Summer 2023, 2025 recruiting`, because the
   digit-range protection exists only in the body chain.
6. **`Hi Rachel@firm.com,`** (artifact 4). A contact typed in as a bare email
   address is greeted by their address. `greetingName` strips `<…>` but not a
   naked address.
7. **The draft's invented dates are only caught when they carry a month name**
   (artifact 7). `11/20`, `2026-11-20` and `next Tuesday` get no note. And
   `1/2 hour` in what the student typed whitelists both January 2 and February 1,
   so a model that proposes either is not flagged.
8. **A fabricated `Re:` is one stale `brief` field away** (artifact 2).
   `finishDraft` trusts `brief.threadSubject` for every non-`repliesInThread`
   type: `cold_email` + `threadSubject` produces `Re: Coffee chat` on a first
   contact. Not reachable through today's forms (the six types that collect the
   field are all genuine replies), but nothing in `finishDraft` enforces that,
   and the comment claims the opposite ("an email with no thread to reply in
   never gets a made-up `Re:`").
9. **The em-dash rewrite edits placeholders** (artifact 5). `[date — time]` →
   `[date, time]`, so the body text no longer equals the `gaps[].placeholder`
   string the model reported. A `//n` inside a bracket splits it across lines and
   Composer's `/\[[^\]\n]{2,}\]/g` stops seeing it — the send gate goes quiet on
   a real gap.
10. **Content after the sign-off disappears with no note** (artifact 5). A model
    P.S. carrying the student's actual ask is deleted silently.
11. **Small things, each visible to one student**: an empty `contactName` gets no
    greeting instruction while "To whom it may concern" gets `Hello,`;
    `Team Lead Rachel Stein` gets none either, leaving "first name" = `Team`;
    an en dash survives every rewrite although the house rule bans the dash; a
    greeting without a trailing comma skips the firm-name and single-name checks;
    note dedupe is case-sensitive; subjects are never length-capped and keep
    newlines; an empty model body yields a leading blank line; `I may 6 be free`
    is flagged as a date.

## Fix list, in order

1. `GRADUATE_MAJOR`: carry the `(?<!\/)` guard (and a `(?<!BS)`-style one) onto
   the `M\.?S\.? (in )?Finance` alternative, and require the MBA token not to be
   inside a parenthetical qualifier. Add `"BS/MS Finance"` and
   `"Economics (MBA pipeline)"` to whatever test covers `"Pre-MBA"`.
2. In `buildDraftPrompt`, check `hasGraduated` **before** the graduate-student
   branch, so a graduate with a past year gets the same "not a current student"
   line an undergraduate gets.
3. `APP_HANDLES`: match on the subject rather than the phrasing — e.g. a
   resume-attachment clause (`attach\b[^.]{0,30}\bresum[eé]`) plus
   `\b(your|the) (email )?signature\b` — and anchor the signature clause to the
   student's own signature so a note about the recipient's does not die. Decide
   explicitly whether "attach it to the portal" is exempt.
4. Sign-off detection: make `CLOSING` accept a closing with no comma, take the
   **first** closing in the trailing region rather than the last, and widen or
   drop the 8-line window.
5. Build the subject in the order the fallback expects: strip the reply prefix,
   apply the **body's** full dash chain (digit-range protection included), then
   fall back when the result is empty or punctuation-only.
6. `greetingName`: drop a bare email address to its local part, or return no
   first name so the "Hello," branch takes over.
7. Extend the date rule over numeric dates in the draft (`\d{1,2}/\d{1,2}`,
   ISO), and stop `1/2`-style fractions from whitelisting dates — require a
   date-ish context or ignore `1/2`, `1/4`, `3/4`.
8. Gate the non-reply `Re:` on the type actually collecting a thread subject,
   instead of on the field being present.
9. Run the em-dash and `//n` rewrites outside `[...]` spans, so a placeholder is
   byte-identical to its `gaps` entry.
10. When the rebuild deletes a non-empty tail after the sign-off, add one
    `notesForStudent` line saying what was removed.
11. Treat `greetingInstruction("")` like "To whom it may concern"; cap the
    subject's length and strip its newlines; lowercase the key when deduping
    notes.
