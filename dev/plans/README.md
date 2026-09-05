# Plans and handoffs

## Active queue

No active plans.

Use this directory for approved implementation plans, not a second backlog.
Unplanned proposals and priorities belong in the work tracker. Historical plans
are context, never current executor authority.

## Lifecycle

Manual plans use `YYMMDD-short-slug.md`. The Linear Spec operation uses the exact
issue key, such as `FER-273.md`. Reconcile the active queue before adding either.
Record the intended outcome, source revision, status, and dependencies when
needed for safe continuation.

Implementation or review approval is not the same as landing. Keep the active
plan until its change lands; then remove it and update the active queue. Do not
keep an `archive/` copy or duplicate historical workflows here.

Use merged pull requests and `git log -- dev/plans/` for shipped work and retired
plans. Revalidate historical assumptions before proposing a new change.
