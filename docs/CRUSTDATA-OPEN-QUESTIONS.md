# Crustdata: open questions for contact generation

Draft for Doug at Crustdata. Not sent. Every assumption these answers would change lives in
`src/lib/contact-search-provider.ts` (`CRUSTDATA_CAPABILITIES`); update it there when they answer.

## Questions

1. **Hybrid search semantics.** With `search: { query, mode: "hybrid" }`, is the query matched as AND, OR or
   semantic relevance? Would `"Trojan Investing Society TIS"` need every word, or match either spelling? Until we
   know, we send one spelling per search (`aliasStrategy: "primary-only"`). Are results relevance-ranked, or in
   an arbitrary order? We currently assume neither.
2. **Fields searched.** Which profile fields does hybrid mode read: headline, summary/about, current and past
   titles, education, activities/organizations, skills?
3. **Ranking without filtering.** Is there a way to boost results by free text without removing people who
   don't match? (Today the free text narrows: one Evercore run went from five results to none.)
4. **Match provenance.** Can a result say which field or term matched (highlights)? We will not tell a student
   "you were both in TIS" without it.
5. **Returnable fields.** Can `person/search` or `person/enrich` return activities/organizations, interests,
   summary/about, or hometown/location history? We currently treat these as unknown.
6. **Past employers.** Can we filter on past employer (company id or name)? We'd search for people who share a
   student's prior internship employer.
7. **Cost shape.** Is a larger search (about 12–20 results) followed by enriching only the chosen five
   cost-effective? What does one search result cost against one enrichment?

## What we send today (example, generated offline from our request builder)

Live runs filter on `experience.employment_details.current.company_id` from `company/identify`; this
example shows the domain fallback.

**Baseline** (one search per click in the common case; asks for up to 12; widens through the existing ladder only
while it holds fewer than five people - no pagination, no attempt to collect every alumnus):

```json
{
  "filters": {
    "op": "and",
    "conditions": [
      { "field": "experience.employment_details.current.company_website_domain", "type": "=", "value": "evercore.com" },
      { "op": "or", "conditions": [
        { "field": "experience.employment_details.current.title", "type": "(.)", "value": "Investment Banking" },
        { "field": "experience.employment_details.current.title", "type": "(.)", "value": "M&A" }
      ] },
      { "field": "experience.employment_details.current.seniority_level", "type": "in", "value": ["Entry Level", "Senior"] },
      { "field": "years_of_experience_raw", "type": "=<", "value": 20 },
      { "field": "education.schools.school", "type": "=", "value": "University of Southern California" },
      { "field": "education.schools.end_year", "type": "=>", "value": 2006 },
      { "field": "basic_profile.location.city", "type": "(.)", "value": "New York" }
    ]
  },
  "limit": 12
}
```

**Affinity** (up to three per click, one student signal each, ~5 results each; one spelling per search until
question 1 is answered). Affinity searches are off in production until the policy and DPA review are done:

```json
{
  "filters": {
    "op": "and",
    "conditions": [
      { "field": "experience.employment_details.current.company_website_domain", "type": "=", "value": "evercore.com" },
      { "op": "or", "conditions": [
        { "field": "experience.employment_details.current.title", "type": "(.)", "value": "Investment Banking" },
        { "field": "experience.employment_details.current.title", "type": "(.)", "value": "M&A" }
      ] },
      { "field": "experience.employment_details.current.seniority_level", "type": "in", "value": ["Entry Level", "Senior"] },
      { "field": "years_of_experience_raw", "type": "=<", "value": 20 },
      { "field": "education.schools.school", "type": "=", "value": "University of Southern California" }
    ]
  },
  "search": { "query": "Trojan Investing Society", "mode": "hybrid" },
  "limit": 5
}
```

**Enrichment** (one person at a time, usually once per click):

```json
{ "professional_network_profile_urls": ["https://www.linkedin.com/in/<person>"], "fields": ["contact.business_emails"] }
```
