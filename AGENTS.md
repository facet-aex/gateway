# gateway instructions

- This is a standalone repository; it must never depend on parent/sibling source or configuration.
- Use npm only and commit this repository's own `package-lock.json` when application code begins.
- ADR-0011 permits a supervised local Demo Track before formal Phase 1 exit. ADR-0013 broadens it to public HTTPS GET provider endpoints with pinned public DNS and bounded responses; the full Phase 2 gates remain open.
- Preserve separate Run/payment state, idempotency and hostile-input boundaries when Phase 2 begins.
- Gateway must not own raw wallet/payment signing keys.
