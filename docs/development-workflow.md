# Development and Copilot review workflow

1. Implement the requested change on a branch and open a PR against `main`.
2. Request a Copilot review. Repository rules enable automatic review, including new pushes; verify that a review actually completes for the latest commit.
3. Read the review comments, verify each finding, and fix confirmed problems. Document why a finding is not applicable when necessary.
4. Push corrections and request another review if one is not triggered automatically.
5. Wait for CI on the latest commit. CI currently checks types and builds the app; test and browser results must be reported separately.
6. Merge only after relevant findings are addressed, CI passes, and the user has authorized merging. A successful Copilot workflow run alone does not prove that review comments were posted or that the latest commit was reviewed.

Copilot uses `.github/copilot-instructions.md` for project conventions and review priorities. These instructions apply after they are available on the PR base branch.

For a separate task explicitly delegated by the user, create an issue with scope, acceptance criteria, and verification expectations, then assign it to Copilot when the account and repository support the coding agent. Review its changes through the same PR workflow.

Copilot reviews provide additional feedback; the repository's current rules do not require a human approval or successful CI to merge. Keep those workflow checks explicit until required checks are configured.
