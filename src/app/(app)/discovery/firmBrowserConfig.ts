// Plain module, deliberately not the "use server" one: a file carrying that
// directive may only export async functions, so a shared constant has to live
// outside it. Imported by both the action and the pages that render the browser.
export const FIRM_PAGE_SIZE = 60;

// The all-firms directory on /discovery/firms opens with a longer first page
// and then grows in smaller steps: a student scanning one firm type wants a
// real screenful up front, and each "show more" after that is a top-up rather
// than another wall. Sector pages keep FIRM_PAGE_SIZE for both.
export const FIRM_DIRECTORY_FIRST_PAGE = 100;
export const FIRM_DIRECTORY_MORE = 50;
