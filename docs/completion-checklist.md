# Completion checkpoint — 28 October 2026

Scope derived from README, docs/roadmap.md, docs/cloud-setup.md, and source inspection.
The existing local planner is functional; the entire collaboration roadmap is not complete.

- [x] Inspect instructions, Next.js bundled client/server guide, README, roadmap, code, and initial git changes.
- [x] Preserve existing worker recovery changes (package.json, cloud worker/lock and related documentation/tests).
- [x] Show flight and transport arrivals on their destination calendar day, sorted by arrival instant, with destination timezone and original document/event identity. Same-day journeys appear once; date-line arrivals may be on the previous calendar day.
- [x] Preserve explicitly known month/day as `--MM-DD` when extraction has no travel year. Review asks for the year; incomplete dates cannot import even when review is acknowledged. Purchase year is never substituted.
- [x] Add regression coverage for arrival ordering, date-line arrivals, and partial-date import confirmation.
- [ ] Implement device synchronization, conflict resolution and explicit migration of local trips.
- [ ] Decide guest/account data isolation and implement account-scoped local storage.
- [ ] Implement complete backups including original attachments (current JSON export remains plan-only).
- [ ] Implement genuine invitations/roles and server-enforced shared access.
- [ ] Add phone-visible worker availability/budget and explicit queue cancellation/recovery.
- [ ] Run fresh browser interaction checks on these changes and physical-phone/Safari acceptance.

The remaining account/shared-data work requires product decisions on ownership, migration,
conflicts and access roles before a schema is committed. No live database migration,
recognition/model request, deployment, credential change or publication was performed.

Validation: 202 tests across 19 files pass with normal Windows access. The sandbox
initially caused 12 failures in file protection and loopback tests; all passed when
run outside it. TypeScript and formatting checks pass. No lint script is configured.
`npm run build:pages` passes and generates `out/` for `/Vmeste/`.
The default Turbopack build encountered a Windows junction collision under `.next`;
production is also validated using `npm run build -- --webpack`.
