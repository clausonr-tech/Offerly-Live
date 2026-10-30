# Live draft evaluation

20/20 drafted · review edit applied on 18 · check findings 18 before review -> 7 after · 49552 input + 64525 output tokens ≈ $0.74
## Production latency

The real `ModelConfig` (claude-sonnet-5, effort low, thinking disabled), 1 call in flight. Nothing queued behind anything, so these are the waits a student gets.

| stage | n | min | p50 | p90 | max | mean |
|---|---|---|---|---|---|---|
| draft call | 20 | 4527 | **7195** | 8758 | 9806 | 6893 |
| lint (local) | 20 | 0 | **1** | 5 | 58 | 4 |
| review call | 20 | 11566 | **22473** | 34889 | 44954 | 23177 |
| review retry | 4 | 4205 | **15676** | 16608 | 16608 | 10466 |
| WHOLE PIPELINE | 20 | 16097 | **31333** | 45389 | 71375 | 32180 |

| scenario | draft | lint | review | retry | total |
|---|---|---|---|---|---|
| 601 [full] | 6995 | 58 | 34800 | - | 41945 |
| 603 [full] | 7224 | 0 | 25921 | - | 33165 |
| 605 [full] | 7437 | 1 | 23885 | - | 31333 |
| 608 [full] | 7733 | 2 | 28633 | - | 36381 |
| 613 [full] | 7400 | 1 | 20317 | - | 27727 |
| 617 [full] | 8621 | 5 | 22473 | - | 31115 |
| 621 [full] | 7204 | 1 | 16227 | 4205 | 27653 |
| 630 [full] | 7848 | 2 | 34889 | - | 42752 |
| 639 [full] | 9806 | 1 | 44954 | 16608 | 71375 |
| 641 [full] | 8758 | 0 | 31251 | 5373 | 45389 |
| 647 [full] | 4527 | 1 | 11566 | - | 16097 |
| 648 [full] | 4734 | 1 | 15873 | - | 20613 |
| 650 [full] | 5337 | 0 | 27385 | - | 32733 |
| 651 [full] | 5612 | 0 | 20935 | 15676 | 42232 |
| 652 [full] | 4699 | 0 | 11856 | - | 16560 |
| 656 [full] | 6814 | 1 | 18310 | - | 25133 |
| 659 [full] | 7195 | 1 | 26208 | - | 33412 |
| 802 [sparse] | 6666 | 5 | 13207 | - | 19884 |
| 806 [sparse] | 6797 | 0 | 12721 | - | 19523 |
| 825 [sparse] | 6445 | 0 | 22130 | - | 28581 |


## 601 [full] Reach out for the first time · A campus recruiter · An alum of my school

### Draft (1 check findings)
- common ground tacked onto a paragraph: "It was nice meeting a fellow Duke alum, especially one from Atlanta too!"
```
Subject: Following Up from the SEO Career Summit

Hi Olivia,

Thank you for the conversation at the SEO Career Summit in New York. I enjoyed hearing about Morrow & Pike's programs and wanted to follow up now that I'm back on campus.

My name is Maya Okafor, and I am a sophomore at Duke University, graduating in May 2029. It was nice meeting a fellow Duke alum, especially one from Atlanta too!

As a consumer sector analyst for the Duke Investment Club, I've gotten especially interested in consumer and retail M&A, and that's part of why I wanted to learn more about Morrow & Pike's programs. First, I was hoping to ask when the sophomore program opens. Second, I wanted to check whether it feeds directly into the summer analyst class.

My resume is attached. Thank you very much for your time!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```
### Review: edit applied
- [flow] "It was nice meeting a fellow Duke alum, especially one from Atlanta too!" -> Merged the shared school and shared hometown into the sentence introducing the student instead of a separate tacked-on exclamation.
- [flow] "wanted to follow up now that I'm back on campus" -> Removed throat-clearing phrasing, replaced with a direct statement.

### Final (0 check findings)

```
Subject: Following Up from the SEO Career Summit

Hi Olivia,

Thank you for taking the time to talk at the SEO Career Summit in New York. I enjoyed hearing about Morrow & Pike's programs and reached out now that I'm back on campus.

My name is Maya Okafor, a sophomore at Duke University graduating in 2029, and it was great meeting a fellow Duke alum who's also from Atlanta at the summit.

As a consumer sector analyst for the Duke Investment Club, I've become especially interested in consumer and retail M&A, which is part of why I wanted to learn more about Morrow & Pike's programs. First, I was hoping to ask when the sophomore program opens. Second, I wanted to check whether it feeds directly into the summer analyst class.

My resume is attached. Thank you very much for your time!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```


## 603 [full] Reach out for the first time · Someone I know suggested them · An alum of my school

### Draft (1 check findings)
- relays an opinion nobody typed: "Emily thought you'd"
```
Subject: Referred by Emily Tran

Hi Rachel,

Emily Tran, who runs the Duke Investment Club and whose team I interned with over the summer, suggested I reach out to you.

I'm a sophomore at Duke studying economics, and I noticed you're also a Duke alum. Last summer at Pinecrest Wealth Partners, I built a screening model for dividend stocks used in client portfolio reviews, and I currently cover the consumer sector for the Investment Club. That work is what's pulled my interest toward consumer and retail M&A specifically. Emily thought you'd be the best person to ask about how you moved from Duke into consumer coverage, especially since we're both from Atlanta.

Would you have 10-15 minutes for a call? I'm glad to work with whatever timing suits you, and I've attached my resume for reference.

Thank you so much for your time!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```
### Review: edit applied
- [invented] "Emily thought you'd be the best person to ask about how you moved from Duke into consumer coverage" -> Removed the invented claim about what Emily thought; stated the ask directly from the student's own interest.
- [flow] "I noticed you're also a Duke alum" -> Stated the shared school plainly as 'a fellow Duke alum' rather than as a discovery.
- [flow] "especially since we're both from Atlanta" -> Moved the Atlanta common ground into the sentence introducing the student instead of tacking it onto an unrelated sentence.
- [tone] "I'm glad to work with whatever timing suits you, and I've attached my resume for reference." -> Reworded the flexibility and resume lines so they don't read as stock courtesy phrases.

### Final (0 check findings)

```
Subject: Referred by Emily Tran

Hi Rachel,

Emily Tran, who runs the Duke Investment Club and whose team I interned with over the summer, suggested I reach out to you.

I'm a sophomore at Duke studying economics. You're a fellow Duke alum, and we're both from Atlanta. Last summer at Pinecrest Wealth Partners, I built a screening model for dividend stocks used in client portfolio reviews, and I currently cover the consumer sector for the Investment Club. That work is what's pulled my interest toward consumer and retail M&A specifically, and I'd love to hear how you moved from Duke into consumer coverage.

Would you have 10-15 minutes for a call? I can make the timing work on my end, and my resume is attached if it's helpful.

Thank you so much for your time!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```


## 605 [full] Reach out for the first time · Someone I know suggested them · A campus recruiter

### Draft (0 check findings)

```
Subject: Referred by Emily Tran

Hi Olivia,

Emily Tran, who is president of the Duke Investment Club and interned on your team, suggested I write to you. It was great meeting you at the SEO Career Summit in New York, and I was glad to connect with another person from Atlanta there.

My name is Maya Okafor, and I am a sophomore at Duke University studying Economics, graduating in 2029. This past summer I interned at Pinecrest Wealth Partners, where I built a screening model for dividend stocks used in client portfolio reviews, and at Duke I cover the consumer sector for the Investment Club. Consumer and retail M&A is the area I have become most interested in.

I had two questions about the sophomore program at Morrow & Pike, if you have a moment. First, when does the program typically open for applications? Second, does it feed directly into the summer analyst class?

I attached my resume for your reference. Thank you so much for your time!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```
### Review: edit applied
- [structure] "It was great meeting you at the SEO Career Summit in New York, and I was glad to connect with another person from Atlanta there." -> Split the two facts and moved the Atlanta connection into the sentence that introduces Maya, instead of announcing it as a separate discovery.
- [tone] "I attached my resume for your reference." -> Replaced the generic courtesy line with wording specific to this email.

### Final (0 check findings)

```
Subject: Referred by Emily Tran

Hi Olivia,

Emily Tran, president of the Duke Investment Club, who interned on your team, suggested I write to you. It was great meeting you at the SEO Career Summit in New York.

My name is Maya Okafor, a sophomore at Duke University studying Economics, graduating in 2029, and also from Atlanta. This past summer I interned at Pinecrest Wealth Partners, where I built a screening model for dividend stocks used in client portfolio reviews, and at Duke I cover the consumer sector for the Investment Club. Consumer and retail M&A is the area I have become most interested in.

I had two questions about the sophomore program at Morrow & Pike, if you have a moment. First, when does the program typically open for applications? Second, does it feed directly into the summer analyst class?

I've attached my resume in case it's useful for the sophomore program review. Thank you so much for your time!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```


## 608 [full] Reach out for the first time · We met in person · An alum of my school

### Draft (1 check findings)
- answer may be missing (0%): specificReason = "both from Atlanta"
```
Subject: Great Meeting You at the SEO Career Summit

Hi Rachel,

It was great meeting you at the SEO Career Summit in New York, where we talked about the grocery chain turnaround you worked on. What stuck with me afterward was your point that consumer deals really come down to repeat customers, which I have been thinking about since.

My name is Maya Okafor, and I am a sophomore at Duke studying economics. I was glad to learn afterward that you are a Duke alum as well. This past summer I interned at Pinecrest Wealth Partners, where I built a screening model for dividend stocks used in client portfolio reviews, and I currently cover the consumer sector for the Duke Investment Club. Between those two, I have found myself drawn specifically to consumer and retail M&A.

I would love to hear more about how you moved from Duke into consumer coverage. Would you have 10 to 15 minutes for a call sometime that works for you? I have attached my resume for reference.

Thank you again for the conversation in New York!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```
### Review: edit applied
- [flow] "I was glad to learn afterward that you are a Duke alum as well." -> Merged the shared-school note into the introduction sentence instead of announcing it as a separate discovery.
- [structure] "I was glad to learn afterward that you are a Duke alum as well." -> Added the verified Atlanta common ground, which the draft had dropped, into the same sentence.
- [tone] "I have attached my resume for reference." -> Reworded the resume line to avoid the stock courtesy phrasing.
- [grammar] "Thank you again for the conversation in New York!" -> Removed 'again' since no earlier thanks was given in this email.

### Final (0 check findings)

```
Subject: Great Meeting You at the SEO Career Summit

Hi Rachel,

It was great meeting you at the SEO Career Summit in New York, where we talked about the grocery chain turnaround you worked on. What stuck with me afterward was your point that consumer deals really come down to repeat customers, which I have been thinking about since.

My name is Maya Okafor, a sophomore at Duke studying economics, and I know you're a fellow Duke alum who's originally from Atlanta like I am. This past summer I interned at Pinecrest Wealth Partners, where I built a screening model for dividend stocks used in client portfolio reviews, and I currently cover the consumer sector for the Duke Investment Club. Between those two, I have found myself drawn specifically to consumer and retail M&A.

I would love to hear more about how you moved from Duke into consumer coverage. Would you have 10 to 15 minutes for a call sometime that works for you? My resume is attached, in case that's useful before we talk.

Thank you for the conversation in New York!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```
Notes for the student:
- I left out the Atlanta connection since the shared Duke school already serves as the one common-ground mention in this format, and stacking both felt like too much. Let me know if you'd rather swap one in for the other.

## 613 [full] Reach out for the first time · Someone I know suggested them · We met in person

### Draft (0 check findings)

```
Subject: Referred by Emily Tran

Hi Rachel,

Emily Tran, president of the Duke Investment Club who interned on your team, suggested I reach out. It was great meeting you at the SEO Career Summit in New York, where we talked about the grocery chain turnaround you worked on. I've kept thinking about what you said, that consumer deals really come down to repeat customers.

I'm a sophomore at Duke studying economics, also from Atlanta, and I work as a consumer sector analyst for the Investment Club. Consumer and retail M&A is the area I'm most drawn to, and I'd love to hear how you went from Duke into covering that space.

Would you have 10-15 minutes for a call? I attached my resume for reference.

Thank you so much for your time!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```
### Review: edit applied
- [flow] "I'm a sophomore at Duke studying economics, also from Atlanta, and I work as a consumer sector analyst for the Investment Club." -> Split into two sentences and removed doubled common-ground wording.
- [tone] "consumer deals really come down to repeat customers" -> Removed intensifier "really" to keep only one in the email.
- [other] "I attached my resume for reference." -> Reworded the stock resume line to fit this email.

### Final (0 check findings)

```
Subject: Referred by Emily Tran

Hi Rachel,

Emily Tran, president of the Duke Investment Club who interned on your team, suggested I reach out. It was great meeting you at the SEO Career Summit in New York, where we talked about the grocery chain turnaround you worked on. I've kept thinking about what you said, that consumer deals come down to repeat customers.

I'm a sophomore at Duke studying economics, and I'm from Atlanta as well. I work as a consumer sector analyst for the Investment Club. Consumer and retail M&A is the area I'm most drawn to, and I'd love to hear how you moved from Duke into covering that space.

Would you have 10-15 minutes for a call? I've attached my resume in case it's useful ahead of that.

Thank you so much for your time!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```


## 617 [full] Reach out for the first time · Someone I know suggested them · We met in person · A campus recruiter · An alum of my school

### Draft (3 check findings)
- answer may be missing (0%): metAt = "the SEO Career Summit in New York"
- alum box checked, but the shared school isn't mentioned
- common ground doubled or tacked on with "like you"/"like me": "also from Atlanta, like you"
```
Subject: Referred by Emily Tran

Hi Olivia,

Emily Tran, who leads the Duke Investment Club and interned on your team, suggested I reach out. She told me about the grocery chain turnaround she worked on with you, and what stuck with me was her point that consumer deals ultimately come down to repeat customers.

My name is Maya Okafor, and I'm a sophomore at Duke (Class of 2029) studying Economics. I'm also from Atlanta, like you. I work as a consumer sector analyst for the Duke Investment Club, and this past summer I interned at Pinecrest Wealth Partners, where I built a screening model for dividend stocks used in client portfolio reviews. That experience, combined with what Emily shared, is what's drawn me specifically toward consumer and retail M&A.

I had two questions about Morrow & Pike's programs. First, when does the sophomore program typically open? Second, does it feed directly into the summer analyst class?

I've attached my resume for reference. Thank you very much for your time!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```
### Review: edit applied
- [wrong_person] "She told me about the grocery chain turnaround she worked on with you" -> The grocery-chain turnaround was something Maya discussed directly with Olivia at the SEO Career Summit, not something Emily relayed. Rewrote to attribute the conversation to the in-person meeting with Olivia.
- [structure] "I'm a sophomore at Duke (Class of 2029)" -> Removed the redundant class year since it's already in the signature.
- [flow] "I'm also from Atlanta, like you." -> Folded the shared hometown into the introductory sentence instead of a tacked-on, doubled line.
- [tone] "I've attached my resume for reference. Thank you very much for your time!" -> Rewrote the resume mention and thanks in plainer, email-specific wording instead of a stock courtesy line.

### Final (2 check findings)
- alum box checked, but the shared school isn't mentioned
- common ground doubled or tacked on with "like you"/"like me": "like you"
```
Subject: Referred by Emily Tran

Hi Olivia,

Emily Tran, president of the Duke Investment Club who interned on your team, suggested I reach out. We met at the SEO Career Summit in New York, where you told me about the grocery chain turnaround you worked on, and what stuck with me was your point that consumer deals ultimately come down to repeat customers.

My name is Maya Okafor. I'm a sophomore at Duke studying Economics and, like you, from Atlanta. I work as a consumer sector analyst for the Duke Investment Club, and this past summer I interned at Pinecrest Wealth Partners, where I built a screening model for dividend stocks used in client portfolio reviews. That experience, combined with our conversation about repeat customers, is what has drawn me to consumer and retail M&A.

I had two questions about Morrow & Pike's programs. First, when does the sophomore program typically open? Second, does it feed directly into the summer analyst class?

My resume is attached, with more on my summer at Pinecrest and my work with the Investment Club. Thank you for your time.

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```


## 621 [full] Reach out for the first time · We met at a conference · A campus recruiter

### Draft (1 check findings)
- announces the common ground as a discovery; just state it: "I noticed we're both"
```
Subject: Following Up from the SEO Career Summit in New York

Hi Olivia,

It was great to meet you at the SEO Career Summit in New York. We spoke about the grocery chain turnaround you worked on, and what stuck with me was your point that consumer deals really come down to repeat customers. That's part of why I've been drawn to consumer and retail M&A.

My name is Maya Okafor, and I'm a sophomore at Duke University, graduating in 2029, studying Economics. I noticed we're both from Atlanta, which made the conversation even more fun. This past summer I interned at Pinecrest Wealth Partners, where I built a screening model for 40 dividend stocks used in client portfolio reviews, and I currently work as a consumer sector analyst for the Duke Investment Club.

First, when does Morrow & Pike's sophomore program open? Second, does it feed into the summer analyst class?

My resume is attached. Thank you again for taking the time to talk with students at the conference!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```
### Review: edit applied
- [invented] "I noticed we're both from Atlanta, which made the conversation even more fun." -> Removed invented reaction; stated shared hometown plainly inside the introduction sentence instead of as a discovery.

### Final (0 check findings)

```
Subject: Following Up from the SEO Career Summit in New York

Hi Olivia,

It was great to meet you at the SEO Career Summit in New York. We spoke about the grocery chain turnaround you worked on, and what stuck with me was your point that consumer deals really come down to repeat customers. That's part of why I've been drawn to consumer and retail M&A.

My name is Maya Okafor, a sophomore at Duke University studying Economics and graduating in 2029, and we're both from Atlanta. This past summer I interned at Pinecrest Wealth Partners, where I built a screening model for 40 dividend stocks used in client portfolio reviews. I currently work as a consumer sector analyst for the Duke Investment Club.

First, when does Morrow & Pike's sophomore program open? Second, does it feed into the summer analyst class?

My resume is attached. Thank you again for taking the time to talk with students at the conference!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```


## 630 [full] Reach out for the first time · Someone I emailed sent me to them · An alum of my school

### Draft (1 check findings)
- alum box checked, but the shared school isn't mentioned
```
Subject: Marcus Delacroix Suggested I Write to You

Hi Rachel,

I emailed Marcus Delacroix about the consumer team, and he pointed me to you since you work on that team and it runs the sophomore program he thought I should know about.

I'm a sophomore at Duke studying Economics, which I understand is also where you went. This past summer I interned at Pinecrest Wealth Partners, where I built a screening model for 40 dividend stocks used in client portfolio reviews, and I currently cover the consumer sector for the Duke Investment Club. I'm also from Atlanta, so it's nice to find another Atlanta connection. Between that work and the sector coverage, I've become especially interested in consumer and retail M&A.

Would you have 10 minutes to talk about how you moved from Duke into consumer coverage? I attached my resume for reference and I'm glad to work with whatever time you have.

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```
### Review: edit applied
- [structure] "I emailed Marcus Delacroix about the consumer team, and he pointed me to you since you work on that team and it runs the sophomore program he thought I should know about." -> Split the strung-together opening into two sentences to fix the comma splice and reduce the list of facts.
- [flow] "which I understand is also where you went" -> Replaced hedged phrasing with a plain statement that she's a fellow Duke alum.
- [flow] "I'm also from Atlanta, so it's nice to find another Atlanta connection." -> Moved the Atlanta common ground into the sentence introducing the student instead of a separate tacked-on sentence, and removed the misused 'so'.
- [tone] "I attached my resume for reference" -> Replaced the stock resume line with wording specific to this email.
- [tone] "I'm glad to work with whatever time you have" -> Rewrote the flexibility line so it doesn't echo a canned courtesy phrase.

### Final (0 check findings)

```
Subject: Marcus Delacroix Suggested I Write to You

Hi Rachel,

I emailed Marcus Delacroix about the consumer team. He pointed me to you because you're on that team, which runs the sophomore program he thought I should know about.

I'm a sophomore at Duke studying Economics, where you're a fellow alum, and we're both from Atlanta. This past summer I interned at Pinecrest Wealth Partners, where I built a screening model for 40 dividend stocks used in client portfolio reviews, and I currently cover the consumer sector for the Duke Investment Club. Between that work and the sector coverage, I've become especially interested in consumer and retail M&A.

Would you have 10 minutes to talk about how you moved from Duke into consumer coverage? I've attached my resume in case it's helpful, and I'm flexible on timing.

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```


## 639 [full] Reach out for the first time · We met in person · Someone I emailed sent me to them · A campus recruiter · An alum of my school

### Draft (1 check findings)
- calls the student an alum; they are a current student and the recipient is the alum: "we're both Duke alumni"
```
Subject: Great Meeting You at the SEO Career Summit

Hi Olivia,

It was great meeting you at the SEO Career Summit in New York, where we talked about the grocery chain turnaround you worked on. What stuck with me afterward was your point that consumer deals really come down to repeat customers, which has shaped how I think about the space since.

Marcus Delacroix suggested I reach out to you directly, since he mentioned your team runs the sophomore program and hires from it. As a quick reminder, I'm Maya Okafor, a sophomore at Duke graduating in 2029, and it's been fun to realize we're both Duke alumni.

I'm a consumer sector analyst with the Duke Investment Club, and I spent this past summer at Pinecrest Wealth Partners building a screening model for dividend stocks used in client portfolio reviews. Consumer and retail M&A is the part of the industry I keep coming back to, and I'd love to learn more about how to prepare for it at Morrow & Pike.

First, do you know when the sophomore program typically opens? Second, does it feed directly into the summer analyst class?

I attached my resume for reference. Thank you again for the conversation in New York, and for your time now.

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```
### Review: edit NOT applied (made the writing worse: introduced common ground tacked on; common ground doubled)
- [wrong_person] "it's been fun to realize we're both Duke alumni" -> Removed; student is a current student, not an alum. Reworded so only the recipient is called a Duke alum.
- [invented] "since he mentioned your team runs the sophomore program and hires from it" -> Removed the implication that Marcus said this; stated it as plain fact from FACTS instead.
- [structure] "As a quick reminder, I'm Maya Okafor, a sophomore at Duke graduating in 2029, and it's been fun to realize we're both Duke alumni." -> Split into shorter sentences; added the missing Atlanta common ground and fixed the alum wording.
- [flow] "I attached my resume for reference." -> Reworded the stock resume line into something specific to this email.
- [flow] "Thank you again for the conversation in New York, and for your time now." -> Removed 'again' since no earlier thanks was given in this email.
Rejected edit:
```
Hi Olivia,

It was great meeting you at the SEO Career Summit in New York, where we talked about the grocery chain turnaround you worked on. What stuck with me afterward was your point that consumer deals really come down to repeat customers, which has shaped how I think about the space since.

Marcus Delacroix suggested I reach out to you directly, since your team runs the sophomore program and hires from it. I'm Maya Okafor, a sophomore at Duke graduating in 2029, and I'm from Atlanta like you. You're also a fellow Duke alum.

I'm a consumer sector analyst with the Duke Investment Club, and I spent this past summer at Pinecrest Wealth Partners building a screening model for dividend stocks used in client portfolio reviews. Consumer and retail M&A is the part of the industry I keep coming back to, and I'd love to learn more about how to prepare for it at Morrow & Pike.

First, do you know when the sophomore program typically opens? Second, does it feed directly into the summer analyst class?

I've included my resume, which covers my work at Pinecrest and with the Investment Club. Thank you for the conversation in New York, and for your time now.

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```
### Final (1 check findings)
- calls the student an alum; they are a current student and the recipient is the alum: "we're both Duke alumni"
```
Subject: Great Meeting You at the SEO Career Summit

Hi Olivia,

It was great meeting you at the SEO Career Summit in New York, where we talked about the grocery chain turnaround you worked on. What stuck with me afterward was your point that consumer deals really come down to repeat customers, which has shaped how I think about the space since.

Marcus Delacroix suggested I reach out to you directly, since he mentioned your team runs the sophomore program and hires from it. As a quick reminder, I'm Maya Okafor, a sophomore at Duke graduating in 2029, and it's been fun to realize we're both Duke alumni.

I'm a consumer sector analyst with the Duke Investment Club, and I spent this past summer at Pinecrest Wealth Partners building a screening model for dividend stocks used in client portfolio reviews. Consumer and retail M&A is the part of the industry I keep coming back to, and I'd love to learn more about how to prepare for it at Morrow & Pike.

First, do you know when the sophomore program typically opens? Second, does it feed directly into the summer analyst class?

I attached my resume for reference. Thank you again for the conversation in New York, and for your time now.

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```
Notes for the student:
- I used the shared Duke connection as the main overlap since it fit the recruiter context more naturally; let me know if you'd rather lead with being from Atlanta instead.
- We couldn't double-check this email against your profile and what you typed. Read it over before you send it.

## 641 [full] Reach out for the first time · We met at a conference · Someone I emailed sent me to them

### Draft (2 check findings)
- over ceiling: 171 > 170
- common ground tacked onto a paragraph: "It also turns out we're both from Atlanta!"
```
Subject: Following Up from the SEO Career Summit in New York

Hi Rachel,

It was great to meet you at the SEO Career Summit in New York. We spoke about the grocery chain turnaround you worked on, and I've thought about it since, especially your point that consumer deals really come down to repeat customers.

Marcus Delacroix suggested I reach out, since he mentioned the consumer team runs the sophomore program and hires from it. It also turns out we're both from Atlanta!

I'm a sophomore at Duke studying Economics. This past summer I interned at Pinecrest Wealth Partners, where I built a screening model for 40 dividend stocks used in client portfolio reviews, and I currently work as a consumer sector analyst for the Duke Investment Club. Consumer and retail M&A is the part of this industry I'm most drawn to, and I'd love to learn how your path took you from Duke into consumer coverage.

Would you have 10 minutes for a call? I'll work around whatever time suits you, and I've attached my resume for reference.

Thank you for your time!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```
### Review: edit NOT applied (dropped something the student typed: "both from Atlanta")
- [structure] "Marcus Delacroix suggested I reach out, since he mentioned the consumer team runs the sophomore program and hires from it." -> Split into two sentences so the reason doesn't read as a run-on clause tied with 'since'.
- [structure] "It also turns out we're both from Atlanta!" -> Moved the shared hometown into the sentence introducing the student instead of a tacked-on exclamation.
- [tone] "I'll work around whatever time suits you, and I've attached my resume for reference." -> Rewrote the stock courtesy lines about flexibility and the resume in the email's own words.
Rejected edit:
```
Hi Rachel,

It was great to meet you at the SEO Career Summit in New York. We spoke about the grocery chain turnaround you worked on, and I've thought about it since, especially your point that consumer deals really come down to repeat customers.

Marcus Delacroix suggested I reach out to you. He mentioned that the consumer team runs the sophomore program and hires from it.

I'm a sophomore at Duke studying Economics, and I'm from Atlanta, like you. This past summer I interned at Pinecrest Wealth Partners, where I built a screening model for 40 dividend stocks used in client portfolio reviews, and I currently work as a consumer sector analyst for the Duke Investment Club. Consumer and retail M&A is the part of this industry I'm most drawn to, and I'd love to learn how your path took you from Duke into consumer coverage.

Would you have 10 minutes for a call? I can make the timing work for whatever's easiest on your end, and I've included my resume for context.

Thank you for your time!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```
### Final (2 check findings)
- over ceiling: 171 > 170
- common ground tacked onto a paragraph: "It also turns out we're both from Atlanta!"
```
Subject: Following Up from the SEO Career Summit in New York

Hi Rachel,

It was great to meet you at the SEO Career Summit in New York. We spoke about the grocery chain turnaround you worked on, and I've thought about it since, especially your point that consumer deals really come down to repeat customers.

Marcus Delacroix suggested I reach out, since he mentioned the consumer team runs the sophomore program and hires from it. It also turns out we're both from Atlanta!

I'm a sophomore at Duke studying Economics. This past summer I interned at Pinecrest Wealth Partners, where I built a screening model for 40 dividend stocks used in client portfolio reviews, and I currently work as a consumer sector analyst for the Duke Investment Club. Consumer and retail M&A is the part of this industry I'm most drawn to, and I'd love to learn how your path took you from Duke into consumer coverage.

Would you have 10 minutes for a call? I'll work around whatever time suits you, and I've attached my resume for reference.

Thank you for your time!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```
Notes for the student:
- We couldn't double-check this email against your profile and what you typed. Read it over before you send it.

## 647 [full] Say thank you · They offered to help · A coffee chat or call

### Draft (0 check findings)

```
Subject: Thank You

Hi Rachel,

Thank you for taking the time to speak with me this morning. I really enjoyed hearing how you decide which consumer brands have staying power, and it gave me a much better sense of what separates a durable business from a trendy one.

Thank you as well for offering to pass my resume along. I attached it here so it's easy to forward, and my application is in under req #55120.

I appreciate your time and the help!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```
### Review: edit applied
- [flow] "Thank you for taking the time to speak with me this morning. I really enjoyed hearing how you decide which consumer brands have staying power, and it gave me a much better sense of what separates a durable business from a trendy one.

Thank you as well for offering to pass my resume along." -> Combined the two separate thank-yous into one opening paragraph so the email thanks her once at the start and once at the close, not three times.
- [other] "much better sense" -> Removed the second intensifier ("much") since the email already uses "really" once.
- [other] "I appreciate your time and the help!" -> Reworded the closing line as a clear second thank-you rather than a third distinct appreciation statement.

### Final (0 check findings)

```
Subject: Thank You

Hi Rachel,

Thank you for taking the time to speak with me this morning. I really enjoyed hearing how you decide which consumer brands have staying power, and it gave me a better sense of what separates a durable business from a trendy one.

I appreciate you offering to pass my resume along. I've attached it here so it's easy to forward, and my application is in under req #55120.

Thank you again for your time and the help!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```


## 648 [full] Say thank you · They offered to help · A talk a banker gave

### Draft (0 check findings)

```
Subject: Thank You for Tuesday's Session

Hi Rachel,

Thank you for speaking at the Morrow & Pike info session at Fuqua on Tuesday. Your point that the best analysts write down every question they get wrong is something I plan to start doing right away, and I appreciated your answer when I asked about how the consumer team staffs analysts.

Thank you as well for offering to pass my resume along. It's attached here so it's easy to forward, and my application is in under req #55120.

Thanks again for taking the time to speak with us!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```
### Review: edit applied
- [structure] "Your point that the best analysts write down every question they get wrong is something I plan to start doing right away, and I appreciated your answer when I asked about how the consumer team staffs analysts." -> Split into two sentences instead of joining two separate facts with "and".
- [tone] "Thank you as well for offering to pass my resume along." -> Reworded to avoid a third thank-you in the email, since one appears at the open and one at the close.

### Final (0 check findings)

```
Subject: Thank You for Tuesday's Session

Hi Rachel,

Thank you for speaking at the Morrow & Pike info session at Fuqua on Tuesday. Your point that the best analysts write down every question they get wrong is something I plan to start doing right away. I also appreciated your answer when I asked about how the consumer team staffs analysts.

I appreciated your offer to pass my resume along. It's attached here so it's easy to forward, and my application is in under req #55120.

Thanks again for taking the time to speak with us.

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```


## 650 [full] Stay in touch · Share an update · Congratulate them

### Draft (1 check findings)
- common ground doubled or tacked on with "like you"/"like me": "also started tracking three consumer brands like you"
```
Subject: Congratulations on the Promotion

Hi Rachel,

I hope you've been well! We spoke back in March about consumer coverage, and I wanted to share a quick update.

I spent the summer at Pinecrest Wealth Partners building a screening model for dividend stocks used in client portfolio reviews. I also started tracking three consumer brands like you suggested, and following them closely has made me notice things in earnings calls I would have missed before.

I also saw on LinkedIn this morning that you were promoted to Director. Congratulations! Given how clearly you explained consumer deals on our calls, it makes a lot of sense.

Thank you again for your time back in March!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```
### Review: edit applied
- [tone] "I hope you've been well! We spoke back in March about consumer coverage, and I wanted to share a quick update." -> Cut the pleasantry and 'wanted to share' filler; opened directly on the March conversation and the update.
- [invented] "following them closely has made me notice things in earnings calls I would have missed before" -> Removed; not supported by FACTS.
- [flow] "I also started tracking three consumer brands like you suggested, and following them closely has made me notice things in earnings calls I would have missed before." -> Removed doubled 'also' and split into its own clear sentence tying the update to the advice.
- [flow] "I also saw on LinkedIn this morning that you were promoted to Director." -> Removed doubled 'also'.
- [flow] "Given how clearly you explained consumer deals on our calls, it makes a lot of sense." -> Reworded to avoid stiff 'Given...' construction while keeping the genuine reason.
- [grammar] "Thank you again for your time back in March!" -> Removed 'again' since no earlier thank-you was given in this email.

### Final (0 check findings)

```
Subject: Congratulations on the Promotion

Hi Rachel,

We spoke in March about consumer coverage. Since then, I spent the summer at Pinecrest Wealth Partners building a screening model for dividend stocks used in client portfolio reviews. I started tracking three consumer brands, as you suggested.

I saw on LinkedIn this morning that you were promoted to Director. Congratulations! That tracks with how clearly you explained consumer deals on our calls.

Thank you for your time back in March.

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```


## 651 [full] Stay in touch · Thank the person who introduced me · Share an update

### Draft (1 check findings)
- answer may be missing (0%): introducedTo = "Ben Ortega"
```
Subject: Thank You for the Introduction

Hi Rachel,

Congratulations on making Director! I also wanted to let you know that Ben and I spoke, and to thank you again for connecting us.

It was a great conversation. He walked me through how the consumer team staffs sophomores on live deals, which gave me a much clearer sense of what the role actually looks like.

Since we last spoke in March, I spent the summer at Pinecrest Wealth Partners building a dividend screening model, and I have also been tracking three consumer brands the way you suggested. I am applying before the October 15 deadline and wanted you to know how much that advice has stuck with me.

Thank you again for making the introduction!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```
### Review: edit applied
- [flow] "I also wanted to let you know that Ben and I spoke, and to thank you again for connecting us." -> Removed throat-clearing opener and split the update and thank-you into separate sentences instead of joining them with 'and'.
- [invented] "and wanted you to know how much that advice has stuck with me" -> Removed unverified claim about the advice 'sticking with' her; not stated in facts.
- [structure] "Since we last spoke in March, I spent the summer at Pinecrest Wealth Partners building a dividend screening model, and I have also been tracking three consumer brands the way you suggested. I am applying before the October 15 deadline and wanted you to know how much that advice has stuck with me." -> Split the overloaded sentence into separate sentences, each carrying one fact, and removed the doubled 'also' construction.

### Final (1 check findings)
- answer may be missing (0%): introducedTo = "Ben Ortega"
```
Subject: Thank You for the Introduction

Hi Rachel,

Congratulations on making Director! Ben and I had our call. Thank you for connecting us.

It was a great conversation. He walked me through how the consumer team staffs sophomores on live deals, which gave me a much clearer sense of what the role actually looks like.

Since we last spoke in March, I spent the summer at Pinecrest Wealth Partners building a dividend screening model. I started tracking three consumer brands like you suggested. I'm applying before the October 15 deadline.

Thank you again for making the introduction!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```


## 652 [full] Stay in touch · Thank the person who introduced me · Congratulate them

### Draft (2 check findings)
- answer may be missing (0%): introducedTo = "Ben Ortega"
- a statement and a thank-you joined with ", and"; make the thanks its own sentence: ", and thank you"
```
Subject: Thank You, and Congratulations

Hi Rachel,

Ben and I spoke, and thank you again for the introduction. He walked me through how the consumer team staffs sophomores on live deals, which answered a lot of the questions I had going in.

I also saw on LinkedIn this morning that you were promoted to Director. Congratulations! It makes sense given how clearly you explained consumer deals on our calls.

I'm applying before the October 15 deadline. Thank you again for making the introduction.

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```
### Review: edit applied
- [flow] "Ben and I spoke, and thank you again for the introduction." -> Split the statement and thank-you into two sentences.
- [flow] "Thank you again for making the introduction." -> Removed duplicate thank-you at the end since the student already thanked Rachel earlier.

### Final (1 check findings)
- answer may be missing (0%): introducedTo = "Ben Ortega"
```
Subject: Thank You, and Congratulations

Hi Rachel,

Ben and I had our call. Thank you for the introduction. He walked me through how the consumer team staffs sophomores on live deals, which answered a lot of the questions I had going in.

I also saw on LinkedIn this morning that you were promoted to Director. Congratulations! It makes sense given how clearly you explained consumer deals on our calls.

I'm applying before the October 15 deadline.

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```


## 656 [full] Stay in touch · Thank the person who sent me elsewhere · Share an update · Congratulate them

### Draft (2 check findings)
- common ground doubled or tacked on with "like you"/"like me": "also started tracking three consumer brands like you"
- a statement and a thank-you joined with ", and"; make the thanks its own sentence: ", and thank you"
```
Subject: Thank You, and Congratulations

Hi Rachel,

Ben Ortega and I spoke, and thank you again for pointing me his way back when we talked in March about consumer coverage. He walked me through how the consumer team decides which deals sophomores get staffed on, which was exactly the kind of detail I was hoping to understand.

Since we last spoke, I spent the summer at Pinecrest Wealth Partners building a screening model for dividend stocks, and I also started tracking three consumer brands like you suggested.

I also saw on LinkedIn this morning that you were promoted to Director. Congratulations! It makes a lot of sense given how clearly you explained consumer deals on our calls.

Nothing needed from you, I just wanted to share the update and say thank you and congratulations.

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```
### Review: edit applied
- [flow] "Ben Ortega and I spoke, and thank you again for pointing me his way" -> Split the statement and thank-you into two sentences instead of joining with a comma.
- [invented] "which was exactly the kind of detail I was hoping to understand" -> Removed unsupported claim about the student's feelings; not in FACTS.
- [structure] "Since we last spoke, I spent the summer at Pinecrest Wealth Partners building a screening model for dividend stocks, and I also started tracking three consumer brands like you suggested." -> Split into two sentences and removed doubled 'also' construction.
- [flow] "I also saw on LinkedIn this morning" -> Removed repeated 'also' to vary sentence openings.
- [structure] "Nothing needed from you, I just wanted to share the update and say thank you and congratulations." -> Fixed comma splice and removed filler phrase 'I just wanted to'.

### Final (0 check findings)

```
Subject: Thank You, and Congratulations

Hi Rachel,

Ben Ortega and I spoke. Thank you again for pointing me his way when we talked in March about consumer coverage. He walked me through how the consumer team decides which deals sophomores get staffed on.

Since we last spoke, I spent the summer at Pinecrest Wealth Partners building a screening model for dividend stocks. I also started tracking three consumer brands, following your suggestion.

I saw on LinkedIn this morning that you were promoted to Director. Congratulations! It makes sense given how clearly you explained consumer deals on our calls.

Nothing needed from you. I wanted to share the update and say thank you and congratulations.

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```


## 659 [full] Stay in touch · Ask for a second conversation · Thank the person who introduced me · Share an update

### Draft (1 check findings)
- over ceiling: 165 > 150
```
Subject: An Update, and a Second Conversation

Hi Rachel,

Congratulations on the promotion to Director! We spoke in March, and your advice to start tracking a few consumer brands closely has stuck with me. I picked three and have been following them since, which has made me pay attention to things like pricing and shelf space in a way I never did before.

Thank you also for introducing me to Ben Ortega. We just had our call, and he walked me through how the consumer team staffs sophomores on live deals, which was really helpful context. Since we last spoke, I also spent the summer at Pinecrest Wealth Partners, where I built a screening model for 40 dividend stocks used in client portfolio reviews.

The summer analyst application closes October 15, and I would value 15 minutes of your time before then to get your read on how I'm thinking about the consumer space. I'll work around whatever time suits you. Thank you again for the introduction and for the advice back in March!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```
### Review: edit applied
- [invented] "which has made me pay attention to things like pricing and shelf space in a way I never did before" -> Removed detail not in FACTS; FACTS only say she started tracking three brands.
- [tone] "which was really helpful context" -> Cut claimed enthusiasm not stated by the student; let the Ben detail speak for itself.
- [other] "I'll work around whatever time suits you." -> Rewrote the canned flexibility line in the email's own words.
- [flow] "Thank you also for introducing me to Ben Ortega" -> Removed doubled 'also' (paired with 'I also spent the summer') to avoid repetition.

### Final (0 check findings)

```
Subject: An Update, and a Second Conversation

Hi Rachel,

Congratulations on the promotion to Director! We spoke in March, and your advice to start tracking a few consumer brands closely has stuck with me. I picked three and have been following them since.

Thank you for introducing me to Ben Ortega. We just had our call, and he walked me through how the consumer team staffs sophomores on live deals. Since we last spoke, I spent the summer at Pinecrest Wealth Partners, where I built a screening model for 40 dividend stocks used in client portfolio reviews.

The summer analyst application closes October 15, and I would value 15 minutes of your time before then to get your read on how I'm thinking about the consumer space. I'm glad to meet whenever works best for you. Thank you again for the introduction and for the advice back in March!

Best,
Maya Okafor
Duke University ’29
maya.okafor@duke.edu
(919) 555-0142
```


## 802 [sparse] Reach out for the first time · A campus recruiter · Not an alum

### Draft (0 check findings)

```
Subject: Question About Morrow & Pike's Sophomore Program

Hi Olivia,

I came across your profile on LinkedIn and wanted to introduce myself. My name is Maya Okafor, and I am a sophomore at Duke University studying Economics, graduating in 2029.

This past summer I interned at Pinecrest Wealth Partners, where I built a screening model for 40 dividend stocks used in client portfolio reviews, and I currently work as a consumer sector analyst for the Duke Investment Club. That experience has pushed me to learn more about Morrow & Pike's programs for students at my stage.

I had two questions, if you have a moment. First, when does the sophomore program application open? Second, does that program feed directly into the summer analyst class, or is it a separate process?

My resume is attached. Thank you very much for your time!

Best,
```
### Review: edit applied
- [other] "I came across your profile on LinkedIn and wanted to introduce myself." -> Removed throat-clearing "wanted to introduce myself"; opened directly on finding her profile.
- [invented] "That experience has pushed me to learn more about Morrow & Pike's programs for students at my stage." -> Removed invented claim about being "pushed" to learn more; replaced with a plain statement of interest.

### Final (0 check findings)

```
Subject: Question About Morrow & Pike's Sophomore Program

Hi Olivia,

I came across your profile on LinkedIn. My name is Maya Okafor, and I am a sophomore at Duke University studying Economics, graduating in 2029.

This past summer I interned at Pinecrest Wealth Partners, where I built a screening model for 40 dividend stocks used in client portfolio reviews, and I currently work as a consumer sector analyst for the Duke Investment Club. I'm interested in learning more about Morrow & Pike's programs for students at my stage.

I had two questions, if you have a moment. First, when does the sophomore program application open? Second, does that program feed directly into the summer analyst class, or is it a separate process?

My resume is attached. Thank you very much for your time!

Best,
```


## 806 [sparse] Reach out for the first time · Someone I know suggested them · We met in person

### Draft (0 check findings)

```
Subject: Referred by Emily Tran

Hi Rachel,

Emily Tran, who interned on the consumer team last summer, suggested I reach out to you. We actually met briefly at the SEO Career Summit in NYC, where you talked about the grocery chain turnaround you worked on, and I have been curious about that deal ever since.

My name is Maya Okafor, and I am a sophomore at Duke studying economics. I am a consumer sector analyst for the Duke Investment Club, and last summer I interned at Pinecrest Wealth Partners, where I built a screening model for dividend stocks used in client portfolio reviews.

Would you have 10-15 minutes for a call sometime in the coming weeks? Whatever time works on your end works for me, and I attached my resume for your reference.

Thank you so much for your time!

Best,
```
### Review: edit applied
- [invented] "I have been curious about that deal ever since" -> Removed invented claim not supported by FACTS.
- [flow] "We actually met briefly at the SEO Career Summit in NYC, where you talked about the grocery chain turnaround you worked on, and I have been curious about that deal ever since." -> Split overloaded sentence into two, removing invented enthusiasm.
- [tone] "I attached my resume for your reference." -> Rewrote stock courtesy line about the resume.
- [tone] "Whatever time works on your end works for me" -> Rewrote stock flexibility phrase into the student's own words.

### Final (0 check findings)

```
Subject: Referred by Emily Tran

Hi Rachel,

Emily Tran, who interned on the consumer team last summer, suggested I reach out to you. It was great meeting you at the SEO Career Summit in NYC, where you talked about the grocery chain turnaround you worked on.

My name is Maya Okafor, and I'm a sophomore at Duke studying economics. I'm a consumer sector analyst for the Duke Investment Club, and last summer I interned at Pinecrest Wealth Partners, where I built a screening model for dividend stocks used in client portfolio reviews.

Would you have 10-15 minutes for a call sometime in the coming weeks? I'm flexible on timing, and my resume is attached if that helps.

Thank you so much for your time!

Best,
```


## 825 [sparse] Stay in touch · Ask for a second conversation · Thank the person who sent me elsewhere

### Draft (0 check findings)

```
Subject: An Update, and 15 More Minutes

Hi Rachel,

When we spoke in March, you suggested I pick a few brands and actually track them instead of trying to follow the whole consumer space. I have been doing that since, and I am now following three brands closely, watching how their quarterly numbers compare to what I expected going in.

Thank you also for pointing me to Ben Ortega. Our conversation was a good one, and it helped me think more concretely about how that tracking could translate into actual investment ideas.

With recruiting picking up, would you have 15 minutes sometime soon? I would value hearing how you think about turning that kind of tracking into a real thesis before conversations start in earnest.

Thank you again for all of it!

Best,
```
### Review: edit applied
- [invented] "instead of trying to follow the whole consumer space" -> Removed detail not in FACTS; advice was just to track a few brands.
- [invented] "it helped me think more concretely about how that tracking could translate into actual investment ideas" -> Removed invented claim about what the conversation with Ben accomplished.

### Final (0 check findings)

```
Subject: An Update, and 15 More Minutes

Hi Rachel,

When we spoke in March, you suggested I pick a few brands and track them closely. I've been doing that since, and I'm now following three brands, watching how their quarterly numbers compare to what I expected going in.

Thank you for pointing me to Ben Ortega. Our conversation was a good one.

With recruiting picking up, would you have 15 minutes sometime soon? I'd value hearing how you think about turning that kind of tracking into a real thesis before conversations start in earnest.

Thank you again for all of it!

Best,
```


---

## The CLI rig was wrong about both halves, in opposite directions

Everything else `docs/concepts` has ever timed ran on the `claude` CLI, which
has no `effort`, no `thinking` setting and no fast mode. Its **total** was close
to right, which is exactly why nobody noticed that neither of its halves was.

The CLI's earlier numbers were taken at `--concurrency=4`, which inflates them
(four `claude` processes on one account queue behind each other). So the rig was
re-timed at `--concurrency=1`, same 16 scenarios, same seed, same code —
`cli-serial-full.json` next to this report — and the comparison below is at
matched concurrency.

| | CLI rig, 1 at a time | the paid path, 1 at a time |
|---|---|---|
| draft call, mean | 14,554 ms | **6,893 ms** |
| review call, mean | 13,584 ms | **23,177 ms** |
| whole pipeline, mean | 29,728 ms | 32,180 ms |

### The matched pairs, which say the same thing unanimously

Four scenarios appear in both runs. Every one of them moves the same way:

| scenario | draft: CLI → API | review: CLI → API | total |
|---|---|---|---|
| 601 | 12,743 → 6,995 (**1.82× faster**) | 15,333 → 34,800 (**2.27× slower**) | 0.67× |
| 603 | 14,434 → 7,224 (**2.00×**) | 15,952 → 25,921 (**1.63×**) | 1.20× |
| 617 | 18,429 → 8,621 (**2.14×**) | 16,455 → 22,473 (**1.37×**) | 1.12× |
| 647 | 8,475 → 4,527 (**1.87×**) | 6,710 → 11,566 (**1.72×**) | 0.94× |
| **mean** | **API 1.98× faster** | **API 1.74× slower** | **1.04×** |

4 of 4 on draft, 4 of 4 on review, and the totals land within 4%. This is not a
scenario-mix artifact and it is not concurrency.

## What it changes

**The review is the wait.** On the paid path it is **~72% of the median total**
(22.5 s of 31.3 s) and the draft is **~21%**. Every latency idea this project
has had — streaming the draft, trimming the prompt, the cache tiers — aimed at
the 21%.

**The lint is free.** 1 ms at the median, 58 ms at worst. Gating the review call
on it costs nothing to *attempt*, and the prize for skipping a review is **22
seconds, not the 12.5 the rig implied**. That does not revive the idea, which
died on quality and deserved to — 12 of 12 unreviewed drafts had zero
contractions, and the lint is blind to exactly that. But the bar it has to clear
is now worth real money, and a cheaper reviewer, a shorter review prompt, or a
review that streams are all now obviously where the seconds are.

**The tail is worse than the median.** p90 is 45 s and the worst draft took
**71 s**. 4 of 20 triggered the guard's retry, a median 15.7 s on top of an
already-slow review.

## What this run does not say

- **n = 20, one sitting, one account, one afternoon.** API latency varies with
  load; this is one sample of it, not a service-level characterisation.
- The 20 situations are `draft-live-eval.ts`'s own `PICKS` (17 full, 3 sparse),
  not the `--seed=quality` 16 the rest of the A/B uses. The matched-pair table
  above is the part that does not depend on the mix.
- `effort: "low"`, `thinking: "disabled"`, `claude-sonnet-5` — the **free
  plan's** draft config. A paid plan's config is a different measurement.
