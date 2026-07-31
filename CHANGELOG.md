# Changelog

## 1.1.0 - 2026-08-01

Block 0x09 assigned: lite-profiler phase telemetry. Reduced per-phase window
stats (avg / p99 / max) as three width-1 LEVEL ops 0x0900-0x0902, one
"phase-telemetry" stream, `phaseTagId` in slot b.

Additive per-op assignment in a previously-reserved block. SPP_VERSION stays 1:
no layout change, no existing-op change, and every pre-existing golden vector is
byte-identical -- only a new `phaseTelemetry` case is appended. This is the
sanctioned "normative by inclusion in vectors.json" path (PROTOCOL.md sec 3),
not a protocol break.

- Scope.js / Scope.d.ts: `BLOCK_PHASE = 0x09`. No per-op consts (per the
  block-0x04 frame-telemetry precedent, probe opcodes live in the producer +
  PROTOCOL.md + vectors.json, never in Scope.js).
- PROTOCOL.md: block-table row split (0x09 assigned, 0x0A..0x0E still reserved)
  + block 0x09 per-op table; conformance list notes the new case.
- gen-vectors.mjs / vectors.json: `phaseTelemetry` golden case -- intern bridge
  (physics=0, render=1), tag ids in b, decoded payloads.
- Version bump 1.1.0 in source, test, package.json.

## 1.0.0 - 2026-07-08

Protocol freeze. All 10 opcode blocks (0x01-0x08, 0x0F) have per-op
tables settled and verified by probe adapter test suites.

- PROTOCOL.md: frozen per-op tables for blocks 0x01 (trace, 6 ops),
  0x02 (gc, 5 ops), 0x03 (signal, 7 ops, live-verified against
  Signal.js 1.9.0-canary), 0x04 (gpu 4 ops + frame telemetry 6 ops),
  0x05 (layout, 3 ops), 0x06 (inp, 3 ops), 0x07 (worker, 4 ops),
  0x08 (leak, 5 ops). Zero provisional items remain.
- scope.gate.mjs: drop-in CI gate script. Evaluates SPP stream budgets,
  exit 0/1, NDJSON output. VersionMatrix-compatible (exit 3 reserved,
  not emitted -- the matrix runner handles recapture in its own layer).
- CI-RECIPE.md: GitHub Actions recipe, budget examples, inline scenario
  pattern, VersionMatrix interop documentation.
- Version bump 1.0.0 in source, test, package.json.

## 0.1.0 - 2026-07-07

Initial release: SPP v1 milestones M0 + M1.

- PROTOCOL.md: normative SPP v1 spec. Record layout [packed, t, a, b],
  opcode family blocks, CONT chaining (max width 3, static per-op widths,
  torn-chain rules), scope-local interning, injectable timebase with EPOCH
  meta record, pow2 overwrite-oldest ring contract.
- Revised the lite-trace alignment claim: lite-trace 1.1.0 is
  structure-of-arrays, so its SPP export is a walk-and-emit transform, not
  a reinterpret; lite-trace is the protocol's semantic ancestor (kinds,
  interning, ring accounting).
- vectors.json golden vectors + gen-vectors.mjs generator (byte-for-byte
  reproduction asserted in tests). Vectors are normative.
- Scope.js: createScope (registry, intern table, timebase, meta writes),
  createMemorySink / createMuxSink / createNullSink, readSlab reference
  decoder. Blocks 0x03 (signal) and 0x08 (leak) reserved as provisional.
- 54 tests under node:test.
