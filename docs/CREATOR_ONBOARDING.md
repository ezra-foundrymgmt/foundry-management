# Creator activation

`CREATOR_ACTIVATION_V1` converts a valid creator record into an operationally provisioned account through 26 deterministic steps.

## Prerequisites

The creator must exist and be eligible, with signed contract, adult confirmation, passed jurisdiction review, contact email, timezone, assigned team, and collected boundaries. All blockers are evaluated before provisioning so a validation failure cannot leave partial external state.

## Idempotency and concurrency

The active run key is creator-scoped. A database unique constraint and lock ensure concurrent starts return one active run. Each provisioned resource also has a versioned key such as `creator:{id}:slack:creator-channel:v1`. Provider adapters and CreatorOS both retain that key.

## Failure and resume

Every step records status, attempts, timestamps, provider, external ID, and safe error. Transient failures may retry with bounded exponential backoff; validation failures remain blocked. A resume skips successful steps, retries the failed step, and continues. `WAITING_EXTERNAL` is a successful pause, not a failure.

Operational provisioning completes before baseline readiness. Activation becomes complete only after the baseline requirement is satisfied. Cancellation does not delete created resources.

## Completion criteria

All deterministic setup and mock provisioning steps must succeed, integration requests and reporting schedules must exist, baseline readiness must be true, and the final activation step must succeed. The workflow emits and audits state changes throughout.
