# ADR-0002 Layered Architecture Boundaries

## Context

Command routing, output formatting, configuration logic, and infrastructure operations were mixed in the entrypoint and duplicated across modules.

## Options considered

1. Keep current module split and add utility helpers.
2. Introduce explicit layers and contracts: CLI app layer, use case orchestration, infrastructure adapters, and domain validations.

## Decision

Implement explicit service boundaries with `OutputService`, `ConfigService`, `BatchRepository`, and `TranslationProvider` contract.

## Consequences

- Better SRP and lower coupling.
- Easier to test command behavior independently of IO details.
- More files and abstractions to maintain.
