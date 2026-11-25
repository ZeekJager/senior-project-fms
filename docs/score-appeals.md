# Score appeals and complaints (FMS-159)

Card: FMS-159 (SE-203). A driver who believes a flag, an incident or a month's score is wrong appeals it, with photos or files, and follows it to a decision. An approved appeal corrects the score, and every step is kept.

Code:

- backend: `packages/backend/src/modules/analytics/` (`domain/appeal.ts`, the rules; `application/appeal.service.ts`; `api/appeal.routes.ts`; `infrastructure/appeal.repository.ts`), and `modules/alert/application/notice.service.ts` for the driver's notices;
- frontend: `pages/Driver/Appeals.tsx` (My appeals, an appeal, a new one), `pages/Appeals/` (S-36, the reviewers' queue), `features/appeals/`;
- migration 079.

## What can be appealed

| Target | From | When the window starts |
|---|---|---|
| A speeding or idling flag | The driver's trip it was raised on | When it was observed |
| An incident | The incidents with the driver on them | When it happened |
| A month's score | My score, once the month has ended | The end of the month in Addis Ababa |

- **Appeal or complaint.** An appeal asks for the score to be corrected. A complaint says something was unfair; an upheld complaint may correct the score, but need not.
- **Reason:** *Wrong data or GPS error*, *Not my trip*, *Road or traffic conditions*, *Vehicle fault* or *Other*, and an explanation of 20 to 2,000 characters.
- **Files:** up to 5, 5 MB each, JPEG, PNG, WebP or PDF, checked by their first bytes (the name and the declared type are ignored), from the camera or the phone's files. They are stored in the document storage under `appeals/<appeal id>/`.
- **The window:** within `appeal_window_days` (a setting, 30) of when it happened. Later is `409 CONFLICT_APPEAL_WINDOW_CLOSED`.
- **One at a time:** one open appeal per flag, per incident and per driver's month (`409 CONFLICT_APPEAL_OPEN`). Once it is decided or withdrawn, it may be appealed again.
- A driver appeals only their own: anyone else's flag or incident is `404`.

## Statuses

```text
Submitted -> Under review -> Approved or Rejected -> Closed
     \______________/
       Withdrawn -> Closed
```

| Step | Who | From |
|---|---|---|
| Claim | A reviewer | Submitted |
| Write in the thread | The driver or a reviewer | Submitted, Under review |
| Approve or reject (a note is required) | A reviewer | Under review |
| Withdraw | The driver | Submitted, Under review |
| Acknowledge the decision | The driver | Approved, Rejected |
| Close by itself | The system, 7 days after the decision | Approved, Rejected |

Any other step is `409 CONFLICT_INVALID_STATE_TRANSITION` (the card's `invalid_transition`, in `details`). Steps lock the appeal's row, so two reviewers cannot both claim or decide it.

## Review

- **Who:** `appeal:review` (admin, fleet manager, depot admin) claims, writes and decides the appeals of their depots; `appeal:read` (those and the compliance officer) reads them. An appeal is in the depot the driver belonged to when they sent it. A depot admin of another depot gets `404`.
- **The queue** (S-36, `/appeals`): oldest first, *To review*, *Overdue*, *Decided* and *Closed*, by depot. Each appeal shows the evidence beside it: the driver's explanation and files, the GPS track of the flag's trip (or 30 minutes either side of a flag or incident on no trip), the trip's flags with the appealed one marked, and the month's score with its parts.
- **The deadline:** `appeal_review_working_days` (a setting, 5) working days, Monday to Friday in Addis Ababa, from when it was sent; public holidays are not known. Past it, the appeal is marked overdue, and the `appeal-escalation` job (every 15 minutes) raises an `appeal_overdue` alert for the depot's admins, once.
- **Own reports:** a reviewer who reported the incident, or reviewed the flag, cannot decide the appeal against it (`409 CONFLICT_OWN_REPORT`); another reviewer must. Nor can the manager who gave the feedback an appeal disagrees with: *I disagree* on feedback (FMS-158, [driver-feedback.md](driver-feedback.md)) sends `feedback_id` with the appeal.

## The correction

An approved appeal says what it takes out of the score:

| Correction | Takes out |
|---|---|
| `exclude_flag` | The flag |
| `exclude_incident` | The incident |
| `exclude_trip` | The whole trip: its km and time, and every flag and incident on it |

For an appeal against a month's score, the reviewer names the driver's flag, incident or trip of that month it takes out (`item_id`).

- The correction is a row of `analytics.score_exclusions`. The original data is never changed or deleted: the score reads its flags and incidents from `analytics.score_flag_facts` and `score_incident_facts`, which say `score_excluded` (the row itself, or the trip it was on), and leaves out the trips the exclusions name. The driver performance report's trips and km leave out an excluded trip too.
- **The score and the rank** change at once: they are worked out live (docs/analytics.md). The score before and after, worked out in the decision's own transaction, are kept on the appeal, and the driver's score card shows *Corrected after appeal: 72 to 80*.
- **The trip risk model:** an excluded flag, an excluded accident or an excluded trip is no safety event in `analytics.trip_risk_facts`, so the next training leaves it out (docs/ml-trip-risk.md).

## The driver's side

- *My appeals* in the driver app (from My day): their appeals, newest first, each with its status, decision, note, score correction and timeline, the thread to answer the reviewer, *Withdraw* and *I have read the decision*.
- *Appeal or complain*: what it is about (the flags, incidents and months still in the window), why, what happened, and photos or files. It needs signal: the files go with it.
- *Appeal this score* on My score, for a month that has ended.
- **Notices:** a reviewer claiming it (in the app), a question in the thread and the decision (in the app and by push, when push is on). They are notices, not alerts: `alert.notifications` rows with no alert, `entity_type` `appeal`, opening the appeal (`/driver/appeals/<id>`).

## The timeline and the audit

- Every step is a row of `analytics.appeal_events`, with who and when: `submitted`, `claimed`, `commented` (with its words), `approved` and `rejected` (with the note), `withdrawn`, `escalated`, `acknowledged`, `closed`, and `attachment_opened`. Rows are never updated or deleted, and appeals are never deleted (`fms_app` has no `DELETE` on them).
- **Files** download only by a signed link that lasts 15 minutes (`GET /appeals/{id}/attachments/{attachmentId}/link`), handed only to the driver and the appeal's reviewers. Each link is an `attachment_opened` step; the driver's timeline leaves those out.
- Every write is also an audited mutation (S-10).
- **Events:** `AppealSubmitted`, `AppealClaimed`, `AppealCommented` (`by`: driver or reviewer), `AppealApproved`, `AppealRejected`, `AppealWithdrawn`, `AppealClosed`, `AppealOverdue` and `ScoreCorrected` (`month`, `correction`, `score_before`, `score_after`). They are the card's `appeal.submitted` and the rest, named as CONVENTIONS.md has events. Each carries `appeal_id`, `driver_id` and `depot_id`, never the explanation or a note.

## Figures

`GET /appeals/kpis?from=&to=` (`appeal:read`): appeals opened in the period, those decided, the share approved and the median days from sending to a decision, in the caller's depots. The KPI dashboard (FMS-160) is to show them.

## API

| Route | Needs |
|---|---|
| `POST /appeals` (multipart with `files`, or JSON) | `appeal:submit` |
| `GET /appeals/mine`, `GET /appeals/appealable` | `appeal:submit` |
| `GET /appeals?status=&depot_id=&overdue=`, `GET /appeals/kpis` | `appeal:read` |
| `GET /appeals/{id}` | The driver's own, or `appeal:read` in the depot |
| `POST /appeals/{id}/claim`, `POST /appeals/{id}/decision` | `appeal:review` |
| `POST /appeals/{id}/comments` | The driver's own, or `appeal:review` |
| `POST /appeals/{id}/withdraw`, `POST /appeals/{id}/acknowledge` | The driver's own |
| `GET /appeals/{id}/attachments/{attachmentId}/link` | The driver's own, or `appeal:read` in the depot |
| `GET /appeal-attachments/{id}/content?expires=&signature=` | The signed link |

The contract is in [openapi.yaml](openapi.yaml).

## Tests

`src/modules/analytics/domain/appeal.test.ts` covers the status flow, the corrections, the window, the working-day deadline and the file types. `test/integration/score-appeals.test.ts` covers the card's acceptance criteria: an appeal of a speeding flag with 2 photos seen at once by the reviewer with the flag's track; invalid steps, a second open appeal and one past 30 days refused; Exclude flag and Exclude trip correcting the score and rank at once and the trip risk labels; no decision without a note, and the driver told by push; escalation past the deadline; the timeline, and the files only for the driver and the reviewers. `test/integration/data-scope.test.ts` checks no depot's appeal reaches another depot's users.

## Not covered

- Public holidays in the review deadline: only weekends are skipped.
- The KPI dashboard's tiles: the figures are served for FMS-160 to show.
- Notifying the reviewer of the driver's answers: the queue and an open appeal refresh every 30 seconds.
- Offline sending: an appeal with files needs signal (the offline queue takes fill-ups, inspections and incidents).
