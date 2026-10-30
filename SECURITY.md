# Security

## Reporting a vulnerability

Please report security issues privately, through GitHub's
[private vulnerability reporting](https://github.com/clausonr-tech/Offerly-Live/security/advisories/new)
rather than a public issue, so there is time to fix it before it is known.

This is maintained by one person in their own time, so please don't expect a
same-day reply. You will get an acknowledgement, and credit in the fix unless
you would rather not be named.

## What is in scope

Anything that lets a vulnerability in Offerly's own code reach a person running
it as intended: injection through stored or model-generated content, a path
that leaks one person's data into another's view, secrets escaping into the
browser bundle or into logs, a stored file being served back in a way that
executes, or a server action trusting input it should re-check.

## What is not

**Offerly has no authentication.** Identity is a single fixed local row, so
"anyone who can reach the app is the only user" is the design, not a flaw —
see the warning at the top of the README. Reports that amount to "I deployed it
publicly and strangers could use it" describe that design working as documented.

Running a modified copy against your own data, spending your own API credits,
and anything requiring an attacker to already have local access to your machine
are likewise out of scope.

## What protects you from spending

No API key ships in this repository, and none is hardcoded anywhere. Every
integration reads its credential from the environment and disables itself when
it is absent. If you ever find a key committed here, that is a real report and
a serious one — please send it.
