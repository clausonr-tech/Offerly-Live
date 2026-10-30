/**
 * The shape a live /person/search actually returns.
 *
 * Modelled field-for-field on one real response (2026-09-22, limit 1,
 * filtered on Evercore's company id). Every KEY here was observed; every
 * VALUE is synthetic - no real person's name, profile, education or employer
 * history is in this repository, and none needs to be, because the only thing
 * the parser can get wrong is which keys it reads.
 *
 * The one that mattered: the identifier is `crustdata_company_id`, NOT the
 * `company_id` the filter grammar uses. Reading the request as if it mirrored
 * the document meant nothing confirmed employment, and contact generation
 * would have returned nobody for every firm.
 *
 * Confirmed by a second, separately authorized request: the profile URL is at
 * `social_handles.professional_network_identifier.profile_url`, a string -
 * exactly where `fromCrustdataProfile` already looked. `urn_url` does not
 * exist, and there is no alternative person-profile URL anywhere else in the
 * payload; every other URL-ish field is a company or school asset.
 *
 * Top-level keys, in full: basic_profile, contact, crustdata_person_id,
 * education, experience, metadata, social_handles.
 */

export const EVERCORE_COMPANY_ID = 682795;
export const OTHER_COMPANY_ID = 111111;

type Employment = Record<string, unknown>;

/** One employment record in the observed shape. */
export function observedEmployment(over: Employment = {}): Employment {
  return {
    business_email_verified: true,
    company_headcount_latest: 2100,
    company_headcount_range: "1001-5000",
    company_headquarters_country: "United States",
    company_hq_location: "New York, New York, United States",
    company_hq_location_address_components: ["New York", "New York", "United States"],
    company_industries: ["Investment Banking"],
    company_professional_network_industry: "Investment Banking",
    company_professional_network_profile_url: "https://www.example-network.test/company/example",
    company_profile_picture_permalink: "https://cdn.example.test/logo.png",
    company_status: "Active",
    company_type: "Public Company",
    company_website: "https://www.evercore.com",
    crustdata_company_id: EVERCORE_COMPANY_ID,
    employment_type: "Full-time",
    end_date: null,
    function_category: "Finance",
    is_default: true,
    location: { raw: "New York, New York, United States" },
    name: "Evercore",
    position_id: 1234567,
    professional_network_id: "urn:li:fs_position:(SYNTHETIC,1234567)",
    seniority_level: "Entry Level",
    start_date: "2023-07-01",
    title: "Investment Banking Analyst",
    years_at_company: "2 years",
    years_at_company_raw: 2,
    ...over,
  };
}

/** A whole profile in the observed shape. */
export function observedProfile(over: {
  current?: Employment[];
  past?: Employment[];
  socialHandles?: unknown;
  omitSocialHandles?: boolean;
} = {}): Record<string, unknown> {
  const profile: Record<string, unknown> = {
    basic_profile: {
      current_title: "Investment Banking Analyst",
      headline: "Investment Banking Analyst at Evercore",
      location: {
        city: "New York",
        continent: "North America",
        country: "United States",
        full_location: "New York, New York, United States",
        raw: "New York, New York, United States",
        state: "New York",
      },
      name: "Synthetic Person",
      professional_network_name: "synthetic-person",
      profile_picture_permalink: "https://cdn.example.test/avatar.png",
    },
    contact: { has_business_email: true },
    crustdata_person_id: 98765432,
    education: {
      schools: [
        {
          degree: "Bachelor's degree",
          description: "Synthetic",
          end_year: 2024,
          institute_logo_permalink: "https://cdn.example.test/school.png",
          location: {
            city: null,
            continent: "North America",
            country: "United States",
            raw: "Los Angeles, California, United States",
            state: "California",
          },
          professional_network_id: "synthetic-school",
          school: "University of Southern California",
          start_year: 2020,
        },
      ],
    },
    experience: {
      employment_details: {
        current: over.current ?? [observedEmployment()],
        past: over.past ?? [
          observedEmployment({
            crustdata_company_id: OTHER_COMPANY_ID,
            name: "Somewhere Else",
            company_website: "https://somewhere-else.example",
            end_date: "2023-06-01",
            start_date: "2022-06-01",
            is_default: false,
          }),
        ],
      },
    },
  };
  /**
   * OBSERVED: `social_handles` carries three keys, and
   * `professional_network_identifier` carries exactly ONE - `profile_url`.
   * There is no `urn_url`, and no other person-profile URL anywhere in the
   * payload. The sibling handles come back present-but-empty for a profile
   * with no such account, which is the ordinary case.
   */
  if (!over.omitSocialHandles) {
    profile.social_handles =
      over.socialHandles ?? {
        dev_platform_identifier: {},
        professional_network_identifier: {
          profile_url: "https://www.linkedin.com/in/synthetic-person",
        },
        twitter_identifier: {},
      };
  }
  /** OBSERVED top-level key. Nothing reads it; recorded for fidelity. */
  profile.metadata = {};
  return profile;
}

/** The whole envelope, as the endpoint returns it. */
export function observedSearchResponse(profiles = [observedProfile()]) {
  return {
    profiles,
    next_cursor: null,
    total_count: 3494,
    total_count_relation: "eq",
    remarks: [],
  };
}
