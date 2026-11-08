# gateway instructions

- This is a standalone repository; it must never depend on parent/sibling source or configuration.
- Do not add application code until Phase 1 exit criteria pass and Phase 2 is explicitly started.
- Preserve separate Run/payment state, idempotency and hostile-input boundaries when Phase 2 begins.
- Gateway must not own raw wallet/payment signing keys.
