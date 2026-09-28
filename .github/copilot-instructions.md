# OracleDataForge development and review instructions

## Project
- Oracle-only browser IDE: React 18, TypeScript, Vite, and Tailwind frontend in `src/`; Express and node-oracledb backend in `server/`.
- Keep node-oracledb in Thin mode. Do not add Oracle Instant Client, other database drivers, or application AI integrations unless explicitly requested.
- Support Node.js 22 and newer. Follow existing component, API, state, and SQL utility patterns.

## Oracle and security
- Enforce roles, connection read-only mode, and write/destructive-operation confirmation on the server. UI visibility is not authorization.
- Use bind variables for values. Validate and quote identifiers using existing helpers; SQL identifiers cannot be value binds.
- Preserve worksheet transaction ownership and connection/session isolation. Oracle DDL commits implicitly; do not promise rollback for DDL.
- Release Oracle resources on errors and cancellation. Preserve bounded result fetching and full-value exports.
- Never commit `data/`, environment files, passwords, wallet files, tokens, or private connection details. Never return credentials to browser storage or logs.
- Keep loopback defaults, origin checks, authentication, and encryption requirements for LAN access. Read `docs/security.md` and `docs/credentials.md` before changing these boundaries.

## Frontend
- Preserve unsaved source, active spec/body, caret, selection, scroll, and search state while switching open object tabs. Closing a tab should release its editor.
- Review retained editors for changes to the active connection and for unintended background requests.
- Keep editor input and syntax highlighting synchronized, including long SQL lines and horizontal scrolling.
- Keep navigation and result controls accessible on small screens. Verify overflow, pinned columns, resizing, keyboard access, and full-value inspection where relevant.
- Keep display clipping separate from exported data. Do not truncate values in CSV/JSON because the grid clips them visually.

## Verification and review
- Use `npm run typecheck` and `npm run build` for implementation verification. Run existing relevant tests when testing is requested; do not execute SQL against a user's database merely to validate UI changes.
- CI runs typecheck, the existing test suite, and build. Report any additional targeted or browser verification separately.
- For UI changes, report browser verification separately from compilation, including viewport and interaction checked.
- Focus reviews on reproducible correctness, data loss, authorization, resource handling, and regressions. Include the file, relevant code, triggering scenario, and proposed correction.
- Distinguish confirmed defects from suggestions. Avoid unrelated rewrites and unsupported findings.
- Keep PRs scoped to the requested work and include a summary, actual validation, and remaining limitations.
