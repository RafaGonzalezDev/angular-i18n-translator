# ADR-0003 Resume and Overwrite Semantics

## Context

The previous translation run behavior accepted `--force` but did not implement robust skip/overwrite semantics across translated batches.

## Options considered

1. Always process all batches regardless of previous state.
2. Skip existing translations by default and provide explicit overwrite behavior.
3. Keep old behavior and only rename flags.

## Decision

Use explicit options:

- `--resume`: skip batches already translated for the target language.
- `--overwrite`: reprocess translated batches and replace target language values.
- `--dry-run`: plan execution without writing artifacts.

Default behavior for translation run is resume-friendly unless overwrite is requested.

## Consequences

- Idempotent reruns and safer failure recovery.
- Reduced unnecessary API cost by skipping completed work.
- Slightly more complex batch-state handling.
