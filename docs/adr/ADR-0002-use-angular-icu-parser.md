# ADR-0002: Use Angular's parser for ICU structure

**Date**: 2026-10-04

**Status**: Accepted

## Context

Angular XLIFF messages can contain nested ICU `plural`, `select` and `selectordinal` expressions alongside inline XML placeholders. Matching braces or counting tokens with regular expressions cannot determine the relationship between nested expressions, variables, types and selector branches. Locale-specific plural categories can legitimately differ, while exact numeric cases, select cases and `other` still have structural requirements.

The same ICU acceptance contract is needed by conversion, LLM-response validation, cache verification and export. Compatibility must be assessed against Angular's message grammar rather than an unrelated generic ICU dialect.

## Alternatives considered

### Keep a custom regex/brace validator

This is lightweight but misses nested semantics and can reject valid text or accept malformed expressions. Extending it into a complete parser would increase maintenance and security risk.

### Implement a dedicated parser or adopt a generic MessageFormat package

This could reduce dependence on Angular compiler internals, but requires proving compatibility with Angular extraction, inline placeholders and nested ICU behavior. Generic ICU implementations may differ in escaping, grammar or AST semantics.

### Use Angular compiler's XML parser with expansion-form tokenization

This provides the Angular-aligned AST and parse errors needed for nested validation, at the cost of an additional runtime dependency and exposure to an experimental compiler API.

## Decision

Pin `@angular/compiler` to **22.1.4** and use `XmlParser.parse` with expansion-form tokenization inside the shared [message-content.js](<../../src/message-content.js>) boundary. Do not expose the compiler AST as a public converter/CLI contract. Other modules consume the project's message-validation API, not the compiler directly.

Compare nested ICU expressions structurally: preserve variables and types; require `other`; reject duplicate cases and invalid plural categories; retain exact numeric selectors and all source select cases; reject extra exact/select cases. Allow plural-category adaptation, comparing an added category's nested structure against the source `other` branch where appropriate. XML placeholders and interpolation multiplicity are independently checked by the same shared validator.

Treat this as an **experimental API dependency**: pin rather than float the compiler version and review any upgrade against parser fixtures and Node engine requirements. The 2.0 runtime contract is Node.js `^24.15.0 || >=26.0.0`, as declared in the [package manifest](<../../package.json>). The compiler adds approximately **5 MB** of installed runtime package footprint; that is an approximate package-size cost, not a promise about memory or startup latency.

This decision accompanies the breaking canonical-fragment change in [ADR-0001](<ADR-0001-canonical-xliff-fragments.md>). It does not make this tool a full Angular compiler or claim support for every ICU dialect. Angular extraction remains a separate step; see Angular's [translation-file guide](<https://angular.dev/guide/i18n/translation-files>) and [ICU preparation guide](<https://angular.dev/guide/i18n/prepare>).

## Consequences

**Positive**: Nested ICU validation uses Angular's grammar rather than fragile token inference. One isolated parser boundary keeps LLM acceptance, cache reuse and export consistent. The public API remains project-owned and can later wrap another parser.

**Negative**: Runtime installation is larger, the minimum Node version rises, and exact compiler pinning requires deliberate maintenance. The dependency is used at runtime even though the tool does not compile an Angular application.

**Risks**: Experimental parser behavior or AST shape can change across releases; security fixes may require an urgent pinned-version update. Mitigate with nested plural/select/selectordinal fixtures, missing/extra selectors, altered variables/types, locale category adaptation, malformed expressions and inline-placeholder regressions. Review package advisories, engine compatibility, installed footprint and performance on representative messages before upgrading. If the API becomes unsuitable, replace it behind the same shared boundary rather than leaking compiler-specific behavior into callers.
