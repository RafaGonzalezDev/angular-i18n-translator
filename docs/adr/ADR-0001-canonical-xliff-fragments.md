# ADR-0001: Use canonical XLIFF fragments in versioned CSV

**Date**: 2026-10-04

**Status**: Accepted

## Context

The 1.x CSV representation could not reliably distinguish literal text that looked like `<x>` from an actual inline XLIFF placeholder. Decoding text and subsequently guessing which strings were markup could turn literal text into elements or escape genuine placeholders. CSV quoting does not solve this XML ambiguity. The same representation must survive source extraction, manual editing, LLM translation, batch caches, validation and XLF export.

Version 2.0 must reject corrupt or ambiguous content before writing exports. It must preserve meaning/description notes, placeholder multiplicity, attributes and nesting, and interpolations in text and attributes. Missing translations must remain visible rather than silently borrowing the source.

## Alternatives considered

### Continue using plain strings with markup inference

This would preserve apparent 1.x compatibility but cannot recover whether a tag-looking substring was originally text or an element. Heuristics can silently corrupt content; adding more regular expressions does not recover lost provenance.

### Separate text and inline markup into a structured JSON model

A typed AST would remove ambiguity but would make the first-class, manually editable CSV significantly harder to inspect and would require a larger public format and adapter surface.

### Store canonical XML fragments with an explicit format version

XML already represents the text/element distinction. Entity escaping keeps literal text unambiguous while genuine inline placeholders remain elements. A required marker makes the interpretation explicit and allows future deliberate migrations.

## Decision

Use canonical XLIFF message fragments in `source` and target-language cells and require `__content_format=xliff-fragment-v1` on every persisted CSV row. Keep metadata fields such as `note` and `meaning` as ordinary strings. Serialize text/CDATA as escaped XML text; serialize supported inline elements as markup. CSV quoting remains a separate layer.

For example, literal `Fish & chips <x>` becomes `Fish &amp; chips &lt;x&gt;`, while a real placeholder remains `<x id="INTERPOLATION" equiv-text="{{name}}"/>`. Export parses the fragment before serializing it into XLF; it does not guess tags or perform ad hoc decode/re-escape cycles.

Centralize the fragment and structural contract in [message-content.js](<../../src/message-content.js>) and persisted CSV format enforcement in [csv-records.js](<../../src/csv-records.js>). Apply the same message checks at LLM acceptance, cache reuse, CSV validation and export. Reject invalid XML/entities/characters, unknown inline elements, DOCTYPE/custom entities, duplicate/missing IDs, changed context and missing targets. Treat legitimate source-identical targets as warnings; strict validation can reject them.

Ship this as **2.0.0**, not a compatible patch. Reject unmarked legacy CSV and unknown/mixed markers without inference. Migration must preserve originals, regenerate canonical CSV from the original XLIFF 1.2 source and manually reapply reviewed translations by ID. Simply adding the marker to ambiguous legacy rows is not valid migration. See the [migration guide](<../../README.md#migrating-from-1x>).

## Consequences

**Positive**: Literal text and placeholders round-trip without ambiguity; shared validation prevents different stages from accepting different structural contracts. Physical CSV locations make manual repair actionable. Missing translations remain explicit instead of producing deceptively complete exports.

**Negative**: This breaks existing CSV and batch-cache compatibility. Manual editors must understand XML entity escaping as well as CSV quoting. Original lexical XML spelling is normalized rather than preserved byte-for-byte.

**Risks**: A model or editor can introduce invalid fragments or remove the marker. All persisted reads enforce the format and all target acceptance/export paths validate structure. Regression tests cover literal placeholder-looking text, entities/CDATA, repeated and nested placeholders, changed attributes, multiline CSV and missing targets. Structural validity does not certify translation quality.

## Related decisions

- [ADR-0002: Use Angular's parser for ICU structure](<ADR-0002-use-angular-icu-parser.md>)
