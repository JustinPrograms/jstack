# Review signal and optional nits

Issue #34 reports that `jstack-review` nits can be tedious to address, while some are useful. The current skill says to omit noisy nits but also puts **Nit** in the ordered findings list and asks every finding for a fix direction. That leaves the threshold subjective and makes minor suggestions look like required corrections. No saved review examples or PR review comments were available in this repository during this investigation, so the examples below are illustrative cases to validate in live reviews, not observed user feedback.

## Examples to distinguish

| Candidate feedback | Disposition | Why |
| --- | --- | --- |
| A new function uses `data` for both the request body and parsed response, making a later assignment hard to follow. | Optional nit, when requested | A specific reader could confuse two values; renaming is bounded and improves the changed code. |
| Rename `result` to `response` because one reviewer prefers that style. | Omit | No concrete confusion or maintenance cost is shown. |
| Reformat a test block that already follows the repository formatter. | Omit | It creates churn without a benefit. |
| A changed retry path can submit the same payment twice after a timeout. | Should fix or blocker, based on impact | Reachable incorrect behavior belongs in required findings, regardless of how small the edit looks. |
| A new helper duplicates an existing validation rule that callers already share. | Investigate as a potential required finding | If differing behavior can cause a reachable defect, report that defect. If it is only mild duplication, offer it as an optional improvement when requested. |

## Decision

Default reviews report supported blockers and should-fix items. Nits appear only when the user asks for them, in a short **Optional improvements** section. Related suggestions are grouped and each needs a concrete benefit. They never become required implementation handoffs. This uses the existing conversational request to control strictness, with no new configuration or host-specific behavior.

## Assessment

Run the V5 scenario in `workflow-evaluations.md` and sample real reviews before and after this change. For comparable diffs, record required defects found or missed, optional suggestions per review, repeated or subjective suggestions, reviewer triage time, and which optional suggestions the user considered useful. Review the default and explicit-nits modes on the same seeded cases. Keep the change only if required-defect recall stays intact and the default produces fewer low-value suggestions; revise the threshold if useful nits disappear even when requested. No live host results are claimed here.
