# ADR-0001 CLI Contract

## Context

The previous CLI exposed many direct commands with inconsistent interaction patterns and no stable machine-readable contract for CI.

## Options considered

1. Keep legacy command style and only improve messaging.
2. Replace with hierarchical command taxonomy and explicit output/exit contracts.

## Decision

Adopt hierarchical taxonomy with `translate run` and `translate step`, add setup commands (`doctor`, `init`), support `--json`, and define stable exit codes.

## Consequences

- Better onboarding and operability.
- Easier CI integration and scriptability.
- Minor learning curve for new command structure.
