import { EMAIL_TYPES, type EmailTypeId } from "./draft-templates";
import volumeIII from "./email-examples-v3.json";
import volumeIV from "./email-examples-v4.json";

// The example emails each draft type is built from, taken verbatim from the
// Offerly Email Drafts playbooks, Volumes II to IV.
//
// Every fact in these emails is fictional - the sender, schools, firms, jobs
// and recipients are made up. They are here to show format, tone and length,
// never content, and the prompt says so.
//
// Keyed by type on purpose: a type is only ever shown its own examples. A
// follow-up trained on cold emails comes out as a second cold email, and a
// cold email trained on follow-ups comes out too thin to answer.

export type EmailExample = {
  /** When an example is a variant of its type, e.g. the startup-feedback cold email. */
  note?: string;
  subject: string;
  body: string;
};

// Volume II uses invented schools throughout.
const RIDGEMONT_SIGNATURE = ["Best,", "Alex Rivera", "Ridgemont University ’29", "Calloway School of Business", "(312) 555-0188"].join("\n");
const ALDRIC_SIGNATURE = ["Best,", "Alex Rivera", "Saint Aldric University ’29", "Verrell School of Business", "(415) 555-0113"].join("\n");

type ExampleTypeId = Exclude<EmailTypeId, "custom">;

const VOLUME_II: Partial<Record<ExampleTypeId, EmailExample[]>> = {
  // ----------------------------------------------------------------------
  // Volume II. Every name, school, firm, club, deal and event is fictional.
  // ----------------------------------------------------------------------

  keep_in_touch: [
    {
      subject: "Checking In",
      body: `Hi Jeff,

I hope you are doing well! We spoke back in October about your path onto the long/short team at Halcombe Partners, and I wanted to check in with a quick update.

Since our call, I accepted a summer analyst position at Marrow Bay Capital, where I will be working with their consumer coverage team. I also took your advice and started keeping a weekly pitch journal, which has made me noticeably sharper in our club stock pitches.

I saw that Halcombe opened a Denver office this spring, so congratulations to you and the team. If you ever have 10 minutes to catch up this semester, I would love to hear how the year has gone for you.

Thank you again for the time you gave me in the fall!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      subject: "Update from Ridgemont",
      body: `Hi Priya,

I hope your spring is off to a great start! I really appreciated our conversation in January about your move into restructuring at Wendell & Rowe, and I wanted to send along a short update.

I was elected Vice President of the Ridgemont Investment and Trading Group in February, and I am currently running our fall pitch competition. I also enrolled in the advanced accounting course you recommended, and building three-statement models from scratch has made recruiting conversations far less intimidating.

I remember you mentioned that your group was searching for a second-year analyst, and I would be curious to hear how that went. If you have 10 minutes at some point this semester, I would love to catch up, though I completely understand if your schedule is full.

Thank you again for all of your advice!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      subject: "Following Up from Our Fall Call",
      body: `Hi Marcus,

I hope this email finds you well! We spoke last September about your career at Castlebrook Capital, and I wanted to share where things have gone since then.

I finished my sophomore year and spent the summer at Marston Pike Capital, where I worked almost entirely on carveout diligence. Your point about learning the operational side of a business before worrying about the modeling side stuck with me all summer, and it turned out to be exactly right.

I also saw that Castlebrook closed Fund IV in April, so congratulations on that. I would love to catch up for 10 minutes whenever you have the time, and either way, I appreciate the advice you gave me last fall.

Thank you so much!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      subject: "Quick Update",
      body: `Hi Elena,

I hope you are doing well! We spoke this past spring about the energy banking group at Wendell & Rowe, and I wanted to send a quick update now that the semester has started again.

I spent the summer at Brightmoor Energy, a solar developer, building project-level models for three utility-scale sites. I also followed your advice about listening to the earnings calls of the same three companies every quarter, and the difference in how much I actually understand now is remarkable.

I saw that you relocated to the Houston office, and I hope the move went smoothly! If you have 10 minutes this fall, I would love to hear how the new team has been. Thank you again for everything!

${ALDRIC_SIGNATURE}`,
    },
  ],

  cold_after_meeting: [
    {
      note: "Met at a club panel; reminds them of the question asked",
      subject: "Great Meeting You at the RITG Markets Panel",
      body: `Hi David,

Thank you for speaking at the Ridgemont Investment and Trading Group panel on Tuesday night! I was the sophomore who asked how your team sizes positions going into earnings, and your answer about starting at half size and adding after the print was easily the most useful thing I heard all evening.

My name is Alex Rivera, and I am a sophomore at Ridgemont University’s Calloway School of Business studying finance and entrepreneurship. Last summer, I worked at Marston Pike Capital, an operationally focused private equity firm that specializes in corporate carveouts and distressed investing, and I have been trying to learn as much as I can about long/short investing ever since.

Would you have 10–15 minutes for a call to continue the conversation? I am more than happy to work around your schedule, so please let me know if a specific time works better for you. I also attached a copy of my resume for your reference.

Thank you again for coming to campus, and I look forward to hearing from you!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      note: "Met at a career fair",
      subject: "Following Up from the Calloway Career Fair",
      body: `Hi Nora,

It was great talking with you at the Calloway career fair on Friday afternoon! We ended up standing in that long line by the Northfield Meridian table and talking about how you moved from mechanical engineering into banking, which I found genuinely encouraging.

As a quick reminder, my name is Alex Rivera, and I am a sophomore at Ridgemont studying finance and entrepreneurship. I am a member of the Ridgemont Investment and Trading Group, and I spent last summer at Marston Pike Capital working on corporate carveouts.

I handed you a paper copy of my resume, but I attached one here as well so that it does not get lost. If you have 15 minutes in the coming weeks, I would love to hear more about your first two years on the industrials team. I am very flexible and more than happy to work around your schedule!

Thank you so much for your time!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      note: "Talked about a shared personal interest (cars) at a mixer",
      subject: "Great Talking Cars at the Alumni Mixer",
      body: `Hi Tom,

I hope you made it home safely on Thursday! My name is Alex Rivera, and I am the sophomore who spent most of the Calloway alumni mixer asking you about your ’73 Bronco restoration and where on earth you found an original tailgate.

Beyond the cars, I really appreciated what you said about your first two years at Sterling Quay Advisors and how much of the job early on is simply being the person who catches the mistake. I am studying finance and entrepreneurship, and I have been trying to figure out whether a smaller advisory shop is the right place to start.

Would you have 10–15 minutes for a phone call in the next few weeks? I am more than happy to work around your schedule, and I attached a copy of my resume for your reference.

Thank you again for a great conversation!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      note: "They judged a case competition the student presented in",
      subject: "Ridgemont Student from the Sanderson Case Competition",
      body: `Hi Grace,

Thank you for judging the final round of the Sanderson Case Competition on Saturday! My team presented the industrials carveout, and you pushed us hard on our exit assumptions, which I have not stopped thinking about since.

My name is Alex Rivera, and I am a sophomore at Ridgemont University’s Calloway School of Business studying finance and entrepreneurship. I worked at Marston Pike Capital last summer on carveout diligence, so your feedback landed on something I care a lot about getting right.

If your schedule permits, I would love to set up a 15-minute call to hear more about how your team at Pemberton Grove actually underwrites those exits. I am very flexible and happy to work around your schedule, and I attached my resume for your reference.

Thank you so much for your time!

${RIDGEMONT_SIGNATURE}`,
    },
  ],

  cold_not_alum: [
    {
      note: "Found on LinkedIn; career path is the hook",
      subject: "Student Interested in Healthcare Coverage",
      body: `Hi Daniel,

I hope this email finds you well! My name is Alex Rivera, and I am a sophomore at Ridgemont University’s Calloway School of Business studying finance and entrepreneurship. I came across your profile on LinkedIn while researching healthcare coverage groups, and your path from a biology degree into banking stood out to me immediately.

Last summer, I worked at Marston Pike Capital, an operationally focused private equity firm, and I am currently a member of the Ridgemont Investment and Trading Group. Over the past year I have become especially interested in healthcare services, largely because of a startup I am building that helps small medical practices with the insurance process.

I know we do not share a school, so I appreciate you even reading this. Would you have 10–15 minutes for a phone or Zoom call? I am more than happy to work around your schedule, and I attached a copy of my resume for your reference.

Thank you so much for your time!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      note: "Shared hometown is the hook",
      subject: "Fellow Gaffney Native Seeking Advice",
      body: `Hi Rachel,

I hope you are doing well! My name is Alex Rivera, and I am a sophomore at Ridgemont University studying finance and entrepreneurship. I grew up in Gaffney, South Carolina, and while reading about Aldergate Capital I noticed that you went to Gaffney High as well. I do not think I have ever met another person from home working in this industry.

I found a strong passion for finance over the past two years, specifically fundamental long/short investing, and I spent last summer at Marston Pike Capital working on corporate carveouts. At Ridgemont, I am a member of the Investment and Trading Group.

I would love to hear how you got from Gaffney to Aldergate. Would you have 10–15 minutes for a quick call? I am very flexible and more than happy to work around your schedule, and I attached my resume for your reference.

Thank you so much, and go Indians!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      note: "A deal they led is the hook",
      subject: "Question About the Verrow Carveout",
      body: `Hi Samuel,

I hope this email finds you well! My name is Alex Rivera, and I am a sophomore at Ridgemont University’s Calloway School of Business studying finance and entrepreneurship.

I read about Castlebrook Capital’s carveout of the specialty chemicals unit from Verrow Industrial in Middle Market Weekly, and I saw that you led the deal. Last summer I worked at Marston Pike Capital, where I spent most of my time on carveout diligence, so reading how your team handled the transition services agreement was genuinely fascinating to me.

I understand that we have no school or mutual connection in common, but I would love to hear about your experience on that deal and at Castlebrook more broadly. Would you have 10–15 minutes for a call? I am happy to work entirely around your schedule, and I attached a copy of my resume for your reference.

Thank you very much for your time!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      note: "A podcast episode they were on is the hook",
      subject: "Enjoyed Your Middle Market Monday Episode",
      body: `Hi Angela,

I hope all is well with you! My name is Alex Rivera, and I am a junior at Saint Aldric University’s Verrell School of Business studying finance and entrepreneurship.

I listened to your episode of the Middle Market Monday podcast last week, and your point about how sourcing from family-owned businesses is really a ten-year relationship business completely reframed how I think about private equity. I had always assumed the work was mostly analytical.

At Saint Aldric, I am a member of the Verrell Finance Society, and last summer I worked at Marston Pike Capital on corporate carveouts. I would love to hear more about your career at Orcutt & Hale. Would you have 10–15 minutes to spare for a Zoom or phone call? I am very flexible and more than happy to work around your schedule.

I attached a copy of my resume for your reference. Thank you so much for your time!

${ALDRIC_SIGNATURE}`,
    },
  ],

  cold_referral: [
    {
      note: "Referred by someone the student recently spoke with",
      subject: "Referred by Sarah Chen",
      body: `Hi Michael,

I hope this email finds you well! Sarah Chen suggested that I reach out to you. I spoke with Sarah last week about her first year at Halcombe Partners, and she mentioned that you would be the best person to talk to about the credit team.

My name is Alex Rivera, and I am a sophomore at Ridgemont University’s Calloway School of Business studying finance and entrepreneurship. Last summer, I worked at Marston Pike Capital, an operationally focused private equity firm that specializes in corporate carveouts and distressed investing, which is where my interest in credit started.

Would you have 10–15 minutes for a phone or Zoom call? I am more than happy to work around your schedule, so please let me know if a specific time works best for you. I also attached a copy of my resume for your reference.

Thank you so much for your time, and I look forward to hearing from you!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      note: "Referred by a professor",
      subject: "Introduction from Professor Vance",
      body: `Hi Katherine,

I hope you are doing well! Professor Ellis Vance, who teaches my advanced accounting course at Ridgemont, recommended that I get in touch with you. He mentioned that you were one of his students years ago and that you have built a very interesting career at Sterling Quay Advisors.

My name is Alex Rivera, and I am a sophomore studying finance and entrepreneurship at Ridgemont University’s Calloway School of Business. I am a member of the Ridgemont Investment and Trading Group, and last summer I worked at Marston Pike Capital on corporate carveouts.

Professor Vance thought you would be a great person to speak with about restructuring, which is the area I have become most curious about this year. If your schedule permits, I would love to set up a 15-minute call. I am very flexible and happy to work around your schedule, and I attached my resume for your reference.

Thank you so much!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      note: "Referred by a neighbor back home",
      subject: "Referred by Your Neighbor, Dan Pruitt",
      body: `Hi Wendy,

I hope all is well with you! Dan Pruitt, my neighbor back home in Gaffney, mentioned that the two of you worked together years ago and suggested that I reach out.

My name is Alex Rivera, and I am a sophomore at Ridgemont University studying finance and entrepreneurship. I have developed an immense passion for the finance world over the past two years, especially technology-focused investing, and Dan thought you would have a much better sense than he does of how someone actually gets into growth equity.

Would you have 10 minutes for a quick call in the coming weeks? I am more than happy to work around your schedule. I also attached a copy of my resume for your reference.

Thank you so much for your time, and I look forward to hopefully speaking with you!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      note: "Referred at the end of a call with someone else at the firm",
      subject: "Connected Through Jake Abbott",
      body: `Hi Priscilla,

I hope you are having a great week! I spoke with Jake Abbott on Tuesday about his experience at Dunleavy Securities, and at the end of our call he recommended that I reach out to you to hear about the sales and trading side of the firm.

My name is Alex Rivera, and I am a junior at Saint Aldric University’s Verrell School of Business studying finance and entrepreneurship. At Saint Aldric, I am a member of the Verrell Finance Society, and last summer I worked at Marston Pike Capital on corporate carveouts and distressed situations.

Would you have 10–15 minutes for a Zoom or phone call? I know that you are extremely busy, and I appreciate any time you can spare. I am very flexible and more than happy to work around your schedule, and I attached a copy of my resume for your reference.

Thank you so much!

${ALDRIC_SIGNATURE}`,
    },
  ],

  recruiting_inbox: [
    {
      note: "Confirming an application was received",
      subject: "Ridgemont ’29, 2028 Summer Analyst Application (Req #40712)",
      body: `Hello Halcombe Partners Recruiting Team,

My name is Alex Rivera, and I am a sophomore at Ridgemont University’s Calloway School of Business studying finance and entrepreneurship, graduating in May 2029.

I submitted my application to the 2028 Summer Analyst Program in the Investment Banking Division (Req #40712) on September 4 through the portal. Last summer I worked at Marston Pike Capital, an operationally focused private equity firm specializing in corporate carveouts, and I am currently a member of the Ridgemont Investment and Trading Group.

I wanted to confirm that my application was received in full, as I did not receive a confirmation email after submitting. I attached my resume and unofficial transcript here as well, in case it is helpful.

Thank you very much for your time and consideration.

${RIDGEMONT_SIGNATURE}`,
    },
    {
      note: "Eligibility question",
      subject: "Eligibility Question: Sophomore Insight Program, Ridgemont ’29",
      body: `Hello Castlebrook Capital Campus Recruiting Team,

My name is Alex Rivera, and I am a sophomore at Ridgemont University’s Calloway School of Business studying finance and entrepreneurship, with an expected graduation date of May 2029.

I am writing about the Castlebrook Sophomore Insight Program. The posting lists eligibility as “second-year undergraduates,” and I wanted to confirm whether students graduating in 2029 are eligible this cycle, or whether the program is intended for the 2028 class.

For context, I spent last summer at Marston Pike Capital working on carveout diligence, and I serve as Vice President of the Ridgemont Investment and Trading Group. I attached my resume for your reference.

Thank you for your time, and I look forward to hearing back.

${RIDGEMONT_SIGNATURE}`,
    },
    {
      note: "Sending materials someone asked for at a career fair",
      subject: "Materials Requested at the Calloway Career Fair: Alex Rivera, Ridgemont ’29",
      body: `Hello Northfield Meridian Recruiting Team,

My name is Alex Rivera, and I am a sophomore at Ridgemont University studying finance and entrepreneurship, graduating in May 2029.

I spoke with Nora Whitfield at the Calloway career fair on Friday, September 11, and she asked me to send my resume and transcript to this inbox for the industrials coverage team. Both are attached.

Last summer I worked at Marston Pike Capital on corporate carveouts, and I am a member of the Ridgemont Investment and Trading Group. Please let me know if there is anything else the team needs from me, or any other step I should take in the process.

Thank you very much for your time.

${RIDGEMONT_SIGNATURE}`,
    },
    {
      note: "Timeline question",
      subject: "Timeline Question: 2028 Summer Analyst Program, Saint Aldric ’29",
      body: `Hello Wendell & Rowe Campus Recruiting Team,

My name is Alex Rivera, and I am a junior at Saint Aldric University’s Verrell School of Business studying finance and entrepreneurship, graduating in May 2029.

I applied to the 2028 Summer Analyst Program in the Energy Group before the August 29 deadline. I wanted to ask when candidates can expect to hear about first-round interviews, so that I can plan around my exam schedule if needed.

I also completed an additional modeling course this fall, so I attached an updated resume and transcript in case the team would like the most current version on file.

Thank you for your time and consideration.

${ALDRIC_SIGNATURE}`,
    },
  ],

  thank_you_event: [
    {
      subject: "Thank You for Last Night’s Info Session",
      body: `Hi Rebecca,

Thank you for hosting the Halcombe Partners information session at Calloway Hall on Wednesday evening! My name is Alex Rivera, and I am a sophomore studying finance and entrepreneurship.

I really appreciated your point about how the analysts who succeed are usually the ones who ask a question twice rather than guess once. That was not the kind of advice I expected to hear at an info session, and it has stayed with me since.

The session significantly increased my interest in your investment banking program. Would you have 10 minutes in the coming weeks for a short call? I am more than happy to work around your schedule.

Thank you again for making the trip to campus!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      note: "Virtual session; reminds them of the question asked in the chat",
      subject: "Thank You for the Virtual Info Session",
      body: `Hi Andrew,

Thank you for running the Castlebrook Capital virtual information session on Tuesday afternoon! I was the sophomore who asked in the chat about how small your deal teams typically are.

Your answer, that most deals run with two people and that associates are expected to talk directly to management in their first year, was genuinely surprising to me. I spent last summer at Marston Pike Capital on carveout diligence, and the contrast with how our teams were staffed was striking.

This has only increased my interest in Castlebrook. If you have 10 minutes for a quick call, I would love to hear more about how that works in practice. I am very flexible and happy to work around your schedule.

Thank you again for your time!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      note: "One of several panelists",
      subject: "Thank You for Joining the Markets Panel",
      body: `Hi Lena,

Thank you for joining the Ridgemont Investment and Trading Group markets panel on Thursday night! I know there were four speakers, so I wanted to write to you specifically about your answer on position sizing.

Your comment about never sizing a position you could not defend in a single sentence was the clearest framework I have heard on the subject, and I have already started using it in our club pitches.

The panel increased my interest in Aldergate Capital quite a bit. Would you be open to a 10–15 minute call so that I can hear more about your path there? I am more than happy to work around your schedule.

Thank you again for coming out!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      note: "Asks who else to talk to instead of for a call",
      subject: "Thank You from the Verrell Finance Society",
      body: `Hi Gerald,

Thank you so much for speaking at the Verrell Finance Society’s speaker series on Monday evening! I was the junior who introduced you and walked you over from the parking garage.

I especially enjoyed your story about spending your first six months at Orcutt & Hale convinced you were going to be fired, and how the turning point was simply learning to write things down. It was a refreshing thing to hear as someone in the middle of recruiting.

This has only increased my interest in the middle market world and in Orcutt & Hale specifically. Is there anyone else on your team you would recommend I speak with? I attached my resume in case it is useful.

Thank you again for your time!

${ALDRIC_SIGNATURE}`,
    },
  ],

  call_scheduling: [
    {
      note: "No time proposed; offers windows",
      subject: "Re: Advice on My Career",
      body: `Hi Jeff,

Thank you so much for getting back to me, and I really appreciate it!

I am happy to work entirely around your schedule. A few windows that are open on my end next week, all Eastern Time:

Tuesday, October 6: 9:00 a.m. – 12:00 p.m.
Wednesday, October 7: after 2:00 p.m.
Thursday, October 8: 8:00 a.m. – 11:00 a.m. or after 4:00 p.m.
Friday, October 9: any time before noon

If none of those work, please just name a time and I will make it work. I am glad to do Zoom or a phone call, whichever you prefer. If it is easier, send me the number you would like me to call and I will send over a calendar invite to confirm.

Thank you again, and I look forward to speaking with you!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      note: "They proposed a time that works; confirms it",
      subject: "Re: Learning About You",
      body: `Hi Ryan,

Thank you for getting back to me so quickly! Thursday at 4:30 p.m. Eastern works perfectly on my end.

I will send a calendar invite shortly so it is on your schedule. Please let me know the best number to reach you at, or if you would prefer that I send a Zoom link instead.

If anything comes up between now and then, please do not hesitate to move it, as I am very flexible.

Thank you again, and I look forward to speaking on Thursday!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      note: "They proposed a time the student can't make; offers others",
      subject: "Re: Great Meeting You at the RITG Markets Panel",
      body: `Hi David,

Thank you so much for your reply, and I truly appreciate you making the time!

Unfortunately, Wednesday at 11:00 a.m. overlaps with a class I cannot miss, and I apologize for the inconvenience. Would any of the following work instead? All times are Eastern:

Wednesday, October 7: after 1:30 p.m.
Thursday, October 8: any time before noon
Friday, October 9: 10:00 a.m. – 3:00 p.m.

If it is easier, I am also happy to take the call earlier in the morning or later in the evening, whatever is least disruptive for you. I will send a calendar invite once we land on a time.

Thank you again for your flexibility!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      note: "Confirming the call the day before",
      subject: "Re: Referred by Sarah Chen",
      body: `Hi Michael,

I hope you are having a good week! I just wanted to confirm our call tomorrow, Thursday, at 3:00 p.m. Eastern.

I will call you at the number in your signature unless you would prefer Zoom, in which case I am glad to send a link. If tomorrow has gotten busy, I am more than happy to move it to a better day, so please just let me know.

Thank you again for taking the time, and I look forward to speaking with you!

${RIDGEMONT_SIGNATURE}`,
    },
  ],

  interview_check_in: [
    {
      subject: "Re: Thank You",
      body: `Hi Rebecca,

I hope you are doing well! I interviewed for the summer analyst position on September 24 and wanted to check in as I have not heard back yet.

Our conversation about how you built a career in finance without any family background in it has stayed with me, and my interest in the role has only grown since then.

Whenever you have a moment, I would appreciate any update on where the process stands or what the timeline looks like from here. If there is any additional information you need from me, please do not hesitate to reach out.

Thank you again for your time!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      note: "New subject line; decisions were expected already",
      subject: "Following Up on the Summer Analyst Interview, Energy Group",
      body: `Hi Jessica,

I hope you are having a great week! I interviewed with your team on September 18 for the summer analyst role in the Energy Group, and I believe decisions were expected by the end of last week.

I remain very interested in the position, particularly after our conversation about how the group underwrites long-term power contracts. I completely understand that these processes often run longer than planned.

If there is any update you are able to share, I would be grateful, and please let me know if anything further is needed from me in the meantime.

Thank you so much for your time!

${ALDRIC_SIGNATURE}`,
    },
    {
      note: "Mentions a real offer deadline elsewhere, once and politely",
      subject: "Re: Growing Interest",
      body: `Hi Phoebe,

I hope you are doing well! I wanted to follow up on my interview with the distressed investing team on September 21.

Castlebrook remains my top choice, and our conversation about the Verrow carveout is a large part of why. I did want to mention, with no intent to rush your process, that I have received an offer elsewhere with a response date of October 12.

If there is any sense of where things stand by then, it would help me a great deal, and I would much rather be here. Please let me know if there is anything else I can send over.

Thank you so much for your time and consideration!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      note: "The final check-in",
      subject: "Re: Thank You",
      body: `Hi Robert,

I hope this email finds you well! I wanted to reach out one final time regarding the analyst role I interviewed for on September 14.

I am still very interested in the team, but I do not want to keep filling your inbox, so this will be my last check-in for now. If the process is still ongoing, I would welcome any update whenever it is convenient for you.

Regardless of the outcome, I am grateful for the time you and your colleagues spent with me. Thank you again!

${RIDGEMONT_SIGNATURE}`,
    },
  ],

  after_rejection: [
    {
      subject: "Thank You Regardless",
      body: `Hi Rebecca,

Thank you for letting me know, and thank you for the time you and your team spent with me throughout the process.

I am of course disappointed, but I learned a great deal, particularly from our conversation about how much of the first year is simply learning to ask better questions. That is something I will carry into the rest of my recruiting.

If you have any feedback on where I could improve, I would be grateful to hear it, though I completely understand if that is not something you are able to share. I would also love to stay in touch and to apply again next cycle if the door is open.

Thank you again for the opportunity!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      subject: "Thank You for the Opportunity",
      body: `Hi Jessica,

Thank you for the update, and for being straightforward with me about the decision.

I really enjoyed the process, especially the case round, which was the first time I had to defend an assumption under real pressure. I am walking away having learned more than I expected to.

If there is anything specific you would suggest I work on before the next cycle, I would welcome the input, but please do not feel obligated. I hope to stay in touch, and I would love to reapply next year.

Thank you again for your time and consideration!

${ALDRIC_SIGNATURE}`,
    },
  ],

  accept_offer: [
    {
      note: "To a person on the team",
      subject: "Accepting the Summer Analyst Offer",
      body: `Hi Andrew,

Thank you so much for the offer. I could not be more excited.

I am writing to formally accept the Summer Analyst position with the Castlebrook Capital investment team, beginning June 1, 2028. I signed and returned the offer letter through the portal this morning, and I have completed the background check authorization. Please let me know if anything else is outstanding on my end.

I also wanted to thank Sarah Chen, who first introduced me to the firm, and Lena Ortiz, who spent an hour on the phone with me back in January when I had no idea what I was doing.

Is there anything you would recommend I read or work on between now and June? I would love to arrive as prepared as possible. Thank you again for this opportunity!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      note: "To a recruiting team",
      subject: "Offer Acceptance: Alex Rivera, Saint Aldric ’29",
      body: `Hello Wendell & Rowe Recruiting Team,

Thank you very much for the offer. I am delighted to accept the Summer Analyst position in the Energy Group, with a start date of June 8, 2028.

I have signed and returned the offer letter and completed the onboarding forms in the portal. Please let me know if there is any additional documentation you need from me, or if there are deadlines I should have on my calendar.

I would also like to thank Elena Boyd, who spoke with me twice over the past year and was a large part of why I applied.

If there is any preparation you would recommend before the summer, I would welcome the guidance. Thank you again for this opportunity!

${ALDRIC_SIGNATURE}`,
    },
  ],

  decline_offer: [
    {
      note: "To a person on the team",
      subject: "Thank You for the Summer Analyst Offer",
      body: `Hi Michael,

Thank you so much for the Summer Analyst offer, and for the time your team put into the process.

After a great deal of thought, I have decided to accept an offer elsewhere, so I will be respectfully declining. This was not an easy decision. I ultimately chose a role that sits closer to the investing side, which is where I want to spend the early part of my career.

I want to say that everyone I met at Halcombe was generous with their time, and you in particular went well beyond what I would have expected. I hope our paths cross again, and I would love to stay in touch.

Thank you again for the opportunity!

${RIDGEMONT_SIGNATURE}`,
    },
    {
      note: "To a recruiting team",
      subject: "Respectfully Declining the Offer",
      body: `Hello Dunleavy Securities Recruiting Team,

Thank you very much for extending me an offer for the 2028 Summer Analyst Program. I am grateful for the process and for how clearly everything was communicated throughout.

After careful consideration, I have decided to decline the offer and pursue a position with another firm this summer. I recognize how many strong candidates you were choosing from, and I did not take the decision lightly.

Priscilla Hayes and Jake Abbott were both extremely generous with their time, and I would appreciate it if you passed along my thanks. I hope to stay in touch and would welcome the chance to reconnect down the road.

Thank you again for the opportunity!

${ALDRIC_SIGNATURE}`,
    },
  ],
};

// Volume III: Volume I rewritten with invented details (it replaces the
// original Volume I examples, which used real schools and firms), cold emails
// from harder positions, follow-ups to every kind of first email, and new
// types. Parsed from the playbook PDF into JSON rather than hand-copied into
// template literals.
const VOLUME_III = volumeIII as unknown as Partial<Record<ExampleTypeId, (EmailExample & { section: number })[]>>;

// Volume IV: MBA, transfer, international and late-senior senders, recruiters
// treated as people, and the situations with no template before it.
const VOLUME_IV = volumeIV as unknown as Partial<Record<ExampleTypeId, (EmailExample & { section: number })[]>>;

/** Every type's examples, oldest volume first. */
export const EMAIL_EXAMPLES = Object.fromEntries(
  EMAIL_TYPES.filter((t) => t.id !== "custom").map((t) => [
    t.id,
    [
      ...(VOLUME_II[t.id as ExampleTypeId] ?? []),
      ...(VOLUME_III[t.id as ExampleTypeId] ?? []),
      ...(VOLUME_IV[t.id as ExampleTypeId] ?? []),
    ].map(
      ({ note, subject, body }) => ({ ...(note ? { note } : {}), subject, body }),
    ),
  ]),
) as Record<ExampleTypeId, EmailExample[]>;
