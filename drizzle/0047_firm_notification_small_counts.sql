-- Remove the firm notifications that name a group of one to four students.
--
-- The firm Analytics numbers are floored at MIN_GROUP (5): a total below that
-- reads "Fewer than 5" rather than as a number, because on a page a firm reads
-- about a school or a cohort, "1 apply click" is one identifiable student. The
-- notification generator printed the raw count instead. It is fixed; the rows
-- it already wrote are not, and they cannot heal on their own, because
-- firm_notifications is written with `onConflictDoNothing` on
-- (firm_id, dedupe_key) and the fix did not change the dedupe keys. Every
-- approved account at the firm is served every row, newest first, with no age
-- cut-off.
--
-- SIX TEMPLATES, ENUMERATED FROM EVERY VERSION OF THE GENERATOR. The file has
-- existed in exactly four versions (git log --follow on
-- src/lib/firm-insights-rules.ts), and this covers all of them - including two
-- leaks that only the earliest two could write:
--
--   weekly      title  "Last week: N click(s) on your posts"
--   reach       title  "<posting> reached N matched student(s)"   [earliest two
--                      versions only; later ones floor it through reach()]
--   deadline    body   "N apply click(s) so far. Edit the deadline ..."
--   milestone   body   "... and N click(s) so far."               [the event
--                      saves milestone, whose click half is unbounded below]
--   event_soon  body   "N student(s) saved it to their calendar."  [earliest]
--                      "Fewer than 5 student saved it ..."        [later: the
--                      singular gave back the number the floor had hidden]
--   surge       body   "... against N all of last week."
--
-- WHY MATCHING TEXT IS SOUND HERE, having been unsound once. The first attempt
-- at this migration matched invented patterns against `body` alone and was
-- wrong three ways - it never looked at `title`, where the weekly leak lives;
-- one clause could not match any row that has ever existed; and one matched
-- what the FIXED generator writes, so it deleted correct rows on every replay.
-- The answer is not a broader pattern: a notification title embeds the firm's
-- own posting title, so a posting called "Analyst Program 2" puts a small
-- standalone number in a row that leaks nothing, and any rule loose enough to
-- catch "Last week: 1 click" would take that with it.
--
-- What makes these six sound is that each is anchored to a template read out of
-- git, and in every one of them the matched span contains no firm-authored
-- text: five match the body, which is generated wholly from numbers and fixed
-- words, and the one that matches a title is anchored to the END of the string,
-- after " reached ". A deliberately-named posting cannot reach them.
--
-- And none of them can match what the generator writes NOW: every count goes
-- through countLabel, so a figure below five is the words "Fewer than 5" and
-- never a digit. That is what makes this replay-safe without a date: a second
-- run finds nothing because nothing writes these shapes any more.
-- scripts/test/firm-notification-small-counts.test.ts holds that as a test, by
-- generating every (title, body) each historical template could produce - over
-- counts either side of the floor, and with posting titles that themselves
-- contain small numbers - and checking that exactly the leaking ones go.
--
-- Deleting rather than rewriting: these rows are generated, so the next
-- insights run writes whatever is still true, and with the row gone its dedupe
-- key is free for the floored wording to land.
DELETE FROM "firm_notifications"
 WHERE "title" ~ '^Last week: [1-4] clicks? on your posts$'
    OR "title" ~ ' reached [1-4] matched students?$'
    OR "body"  ~ '^[1-4] apply clicks? so far\.'
    OR "body"  ~ ' and [1-4] clicks? so far\.$'
    OR "body"  ~ '^[1-4] students? saved it to their calendar\.$'
    OR "body"  ~ '^Fewer than [0-9]+ student saved it to their calendar\.$'
    OR "body"  ~ ' against [1-4] all of last week\.$';
