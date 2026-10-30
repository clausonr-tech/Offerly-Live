# Offerly: project rules

## Every place someone can type words is checked for hateful language and profanity

Slurs, hateful terms (racist, sexist, homophobic, transphobic, ableist, religious)
and profanity are blocked everywhere a person can type words into the app, on
features that exist today and on every feature added from here on.

- **The check lives in `src/lib/content-limits.ts`.** Use `blockedLanguageError`
  for labelled fields, `blockedInForm` for a whole `FormData`, or
  `findBlockedLanguage` for a single string. Never write a separate word list.
- **Check on the server, before anything is saved, sent to a model, or shown to
  another person.** Call it at the top of the server action or API route and
  return its message as the action's error. A client-side warning is a courtesy,
  never the check.
- **Check what a model writes back** when it is shown to someone (the email
  draft pipeline and the chat assistant already do).
- **Prompts that generate text carry the rule too,** for hateful meaning in
  ordinary words that a word list can't see (see `HOUSE_RULES` in
  `src/lib/draft-prompt.ts`).
- **Nothing that takes no words needs it:** passwords, verification codes, email
  addresses, phone numbers, URLs, IDs, fixed choices and uploaded files.

`scripts/content-limits-coverage-test.ts` enforces this. It finds every exported
server action and API write route that takes input beyond IDs, and fails if one
neither calls the check nor appears in its `EXEMPT` list with a reason. When you
add an action that takes input, either add the check or add an exemption that
says why it takes no words. Run it with the other tests:

```bash
npx tsx scripts/content-limits-coverage-test.ts
npx tsx scripts/content-limits-test.ts
```

## The Help assistant learns every feature

The assistant on /help answers from `src/lib/help-knowledge.json`: one
student-facing entry per page, written by AI from that page's code, plus the
overview and the app frame. Each entry carries a hash of the code it was
written from.

- **When you add or change a page or a feature, relearn it** before you finish.
  Only pages whose code changed are re-read (a cent or two):

  ```bash
  npm run help:learn
  ```

- **Commit the regenerated `help-knowledge.json` with the code.**
- **Never hand-write an entry or put secrets, admin-only features or model
  names in one.** The script and the test both reject them.

`scripts/test/help-knowledge-coverage.test.ts` enforces this. It lists every
page a student can open and fails, naming each missing or stale page, until the
knowledge is current.
