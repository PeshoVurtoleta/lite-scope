# SPP v1 -- Scope Probe Protocol

Status: draft for review | 2026-07-07
Normative artifacts: this document + `vectors.json` (golden vectors).
Reference implementation: `Scope.js` (`@zakkster/lite-scope`).

SPP is the wire contract of the @zakkster profiler suite. Probe packages
(lite-trace, lite-gc-profiler, lite-leak, ...) emit fixed-width numeric
records into an injected sink; consumer packages (lite-scope, lite-hud,
lite-perf-gate) decode them using out-of-band registry metadata. No probe
imports any other package. The protocol is the coupling; there is no hub.

## 1. Design constraints

1. Zero-dependency probes: the entire probe-facing contract is one duck-typed
   method, `sink.write(packed, t, a, b)` -- four numbers. A probe that is
   handed no sink pays nothing beyond a monomorphic no-op call, or installs
   nothing at all where the adapter can gate on sink presence at init.
2. Zero-GC write path: no strings, no objects, no varargs, no allocation
   after init. Strings are interned to u32 ids at init time only.
3. Dumb consumers: a consumer can demux, route, and render any stream using
   only the registry metadata and the rules in this document. Record widths
   are static per opcode -- never inferred from stream content.
4. One buffer: records interleave into a single contiguous f64 ring so that
   mux fan-out is one call, cross-thread transport is one slab copy, and
   file export is one write.

## 2. Record layout

One record = 4 f64 slots:

    [packed, t, a, b]

- `packed` = `(streamId << 16 | opcode) >>> 0`. Both fields u16; the packed
  u32 is exact in f64. Decode with `packed >>> 16` (stream) and
  `packed & 0xFFFF` (opcode). Implementations MUST use unsigned coercion
  (`>>> 0`) when packing: streamIds >= 0x8000 overflow int32 under `<<`.
- `t` = milliseconds since the scope epoch (fractional allowed). In CONT
  records this slot is payload (section 5).
- `a`, `b` = payload slots. Meaning is opcode-defined.

Canonical layout id: `SPP1:[packed,t,a,b]`.
FNV-1a 32-bit checksum of the layout id: `2232310714` (`0x850E5BBA`).
The checksum travels in the EPOCH record so independent encoders and
decoders fail loudly on layout drift rather than silently misparse.

A record whose opcode is `0x0000` (VOID) is an empty slot; consumers skip
it. This makes a zero-initialized ring self-describing: no separate
occupancy bookkeeping is required to decode a partially filled slab.

## 3. Opcode space

The high byte of the u16 opcode is the family block:

| Block | Family | Status |
|---|---|---|
| 0x00 | invalid (0x0000 = VOID) | frozen |
| 0x01 | lite-trace | frozen range |
| 0x02 | lite-gc-profiler | frozen range |
| 0x03 | lite-signal / lite-signal-profiler | frozen (see below) |
| 0x04 | lite-gpu-profiler + frame telemetry | frozen range |
| 0x05 | lite-layout-profiler | frozen range |
| 0x06 | lite-inp | frozen range |
| 0x07 | lite-worker-profiler | frozen range |
| 0x08 | lite-leak | frozen (see below) |
| 0x09 | lite-profiler phase telemetry | frozen range |
| 0x0A..0x0E | reserved for future probe families | frozen |
| 0x0F | meta + gate | frozen |

"Frozen range" means the block assignment is settled; per-op assignments
within a block are settled when that probe's adapter milestone lands, and
become normative by inclusion in `vectors.json` or a probe's vendored
vector file.

Block 0x01 per-op table (frozen -- lite-trace v1.2 adapter):

| Op | Name | Kind | a | b |
|---|---|---|---|---|
| 0x0100 | span.open | SPAN | depth | tagId |
| 0x0101 | span.close | SPAN | depth | tagId |
| 0x0102 | instant | INSTANT | tagId | 0 |
| 0x0103 | counter | COUNTER | tagId | value |
| 0x0104 | async.begin | SPAN | tagId | asyncId |
| 0x0105 | async.end | SPAN | tagId | asyncId |

All width 1. Tag ids are the tracer's own intern table (dense u32); the
adapter re-emits them directly so consumers need access to the tracer's
tag list (via summary or a scope.intern bridge at registration time).

Block 0x02 per-op table (frozen -- lite-gc-profiler v1.1 adapter):

| Op | Name | Kind | a | b |
|---|---|---|---|---|
| 0x0200 | scavenge | INSTANT | durationMs | kind(1) |
| 0x0201 | major | INSTANT | durationMs | kind(4) |
| 0x0202 | incremental | INSTANT | durationMs | kind(8) |
| 0x0203 | weakcb | INSTANT | durationMs | kind(16) |
| 0x0204 | heap.sample | LEVEL | usedBytes | deltaBytes |

All width 1. Kind values in b are V8's perf_hooks constants.

Block 0x03 per-op table (frozen -- verified against Signal.js 1.9.0-canary,
opcodes stable since 1.2.1/1.6). 1:1 map from engine mutationHook(op,a,b):

| Op | Name | Engine op | a | b |
|---|---|---|---|---|
| 0x0301 | node.create | 1 | nodeId | flags |
| 0x0302 | node.dispose | 2 | nodeId | flags |
| 0x0303 | link.add | 3 | sourceId | targetId |
| 0x0304 | link.remove | 4 | sourceId | targetId |
| 0x0305 | recompute | 5 | nodeId | 0 |
| 0x0306 | flush.pass | 6 | passNumber | effectCount |
| 0x0307 | effect.enqueue | 7 | nodeId | 0 |

All width 1, kind INSTANT. The engine fires these from the single nullable
`mutationHook` listener; the adapter pre-packs headers and emits one
sink.write per event (zero allocation).

Block 0x08 per-op table (frozen -- lite-leak 1.0.0 adapter, M5):

| Op | Name | Kind | a | b |
|---|---|---|---|---|
| 0x0800 | leak | INSTANT | internedTag | internedKind |
| 0x0801 | warning | INSTANT | internedKind | internedReason |
| 0x0802 | finding | INSTANT | internedKind | 0 |
| 0x0803 | snapshot | LEVEL | trackedCount | 0 |
| 0x0804 | reclaim | COUNTER | reclaimedCount | 0 |

All width 1. lite-leak's detection is FinalizationRegistry-based; onLeak
fires when a tracked object is collected without disposal. The adapter
hooks onLeak/onWarning/onFinding and provides snapshot(tracker) for
periodic metrics. Reclaim count accumulates between snapshots.

Block 0x09 per-op table (frozen -- lite-profiler phase-telemetry probe):

| Op | Name | Kind | a | b |
|---|---|---|---|---|
| 0x0900 | phase.avg | LEVEL | avgMs | phaseTagId |
| 0x0901 | phase.p99 | LEVEL | p99Ms | phaseTagId |
| 0x0902 | phase.max | LEVEL | maxMs | phaseTagId |

All width 1. One "phase-telemetry" stream carries every registered phase; the
reduced per-phase window stats (avg / p99 / max over the frame ring) are emitted
as LEVEL samples with `phaseTagId` in b selecting the phase. Tag ids are the
producer's dense u32 phase-tag ids (a scope.intern bridge at registration, per
the block 0x01 tagId convention); consumers resolve id -> name via the scope
intern table or the profiler summary. A sink-only decoupled probe MAY instead
place the profiler's own dense phase index in b, meaningful against the
profiler's phase list. lite-profiler is the sole producer for this block; the
block owner is lite-scope (protocol home), the opcodes are inlined by the
producer, which imports nothing from this package.

Meta opcodes (block 0x0F). All are width 1 in SPP v1:

| Op | Name | t | a | b |
|---|---|---|---|---|
| 0x0F00 | EPOCH | absolute wall ms of scope t0 | SPP version (1) | layout checksum |
| 0x0F01 | CONT | payload c0 | payload c1 | payload c2 |
| 0x0F02 | CLOCK_SYNC (reserved, M3) | ms | offset ms | round-trip ms |
| 0x0F40 | GATE_VERDICT (reserved, M2) | ms | interned budget id | 0 pass / 1 fail / 3 recapture |
| 0x0F41..0x0F7F | gate sub-block, reserved | | | |

EPOCH, CLOCK_SYNC, and gate records are written on stream 0 (META_STREAM),
which is owned by the scope and cannot be registered by probes. CONT is the
one meta opcode that rides probe stream ids (section 5). GATE_VERDICT's `b`
values deliberately mirror the established gate exit codes (0 pass,
1 regression, 3 recapture); the exit-code semantics themselves stay in the
runner layer -- `suiteGate()` delegates to `verdict()`, never reimplements.

## 4. Streams, registry, kinds

Stream ids are dense u16 values assigned at `register()`, starting at 1
(0 is meta). The registry is out-of-band metadata -- it is never emitted on
the f64 stream. A stream descriptor is:

    { name, unit?, hz?, ops: [{ code, name, kind, width?, paired? }] }

- `kind` is per-op, one of: 0 LEVEL (continuous sample -> waveform),
  1 INSTANT (point event -> blip), 2 SPAN (region), 3 COUNTER (step trace).
  Kinds are render and gating hints; they do not change decoding.
  Design note: the original sketch put `kind` on the stream. It moved to
  the op because lite-trace alone emits four kinds from one probe (spans,
  instants, counters, async), so stream-level kind was already false for
  the protocol's reference ancestor.
- SPAN ops come in two legal patterns, declared via `paired`:
  paired open/close ops carrying a correlation id in a payload slot, for
  live probes whose spans may never close; or a single complete-span op
  (t = start, one payload slot = duration) for after-the-fact export walks.
- `width` is the TOTAL record count for the op: 1 (no CONT), 2, or 3.
  Static per op, declared at registration, learned by consumers from the
  registry -- never from the stream.
- `unit` and `hz` are display hints (lite-hud renders channels from
  metadata alone; hz is the expected sample rate for LEVEL channels).

Validation happens once, at `register()` (init time). The write path
validates nothing.

## 5. Wide records: CONT chaining

Payloads wider than 2 slots chain CONT records immediately after the base:

    base:  [(sid << 16 | op),      t,  a,  b ]
    CONT:  [(sid << 16 | 0x0F01), c0, c1, c2 ]

- A CONT contributes 3 payload slots; payload order is a, b, then CONT
  slots in emission order.
- Maximum chain depth is 2 (max width 3, max payload 8 slots). Rationale:
  a decoder's pending state is bounded at two records; every known fat
  record (span tree context, leak ownership snapshots, clone-cost
  histograms) fits in 8 slots with interned ids; anything wider is a schema
  smell and should be split into multiple ops. Depth is frozen for SPP v1.
  This was flagged as the highest-risk protocol decision; it is settled
  here and exercised by the `wideRecord` and `tornChain` golden vectors.
- Chains MUST be written atomically: `write()` then `cont()` calls with no
  interleaved writes to the same sink and no yields between them.
  Single-threaded JS makes this natural; probe code that awaits or yields
  mid-chain is non-conforming.

Torn-chain rules (overwrite-oldest rings tear chains at the wrap boundary;
the base, being oldest, is overwritten first):

1. Leading CONTs at the start of a decoded slab are orphans: skip them.
2. VOID records and mid-stream orphan CONTs (a CONT whose predecessor is
   not its base or its sibling CONT, including stream-id mismatches) are
   skipped. Dev-mode consumers MAY treat mid-stream orphans as an
   assertion; robust consumers skip.
3. A chain truncated by the slab end, or terminated early by a stream-id
   mismatch, is delivered with the payload it has; the payload count tells
   the consumer what arrived.

## 6. Interning

`scope.intern(str) -> u32`, init-time only, dense ids. Payload slots carry
ids, never strings. The intern table is out-of-band: export sinks serialize
it alongside the slab (NDJSON framing lands in M6); live consumers read it
from the scope.

Scope-local namespace in v1: ids are meaningful only against the scope that
issued them. Cross-thread id namespacing is deliberately deferred to M3,
where it will be specified together with the slab-flush transport (worker
slabs travel with their thread's intern table and stream descriptors; the
receiving side remaps at ingest, off any hot path). Reserved, not designed,
here.

## 7. Timebase

`t` is milliseconds since the scope epoch. The scope captures a clock base
at creation; `now()` returns `clock() - base + offset`. The clock is
injectable (defaults to `performance.now`), matching the DI discipline of
lite-trace (`opts.clock`) and lite-perf-gate.

The EPOCH record maps relative time to wall-clock time: its `t` slot is the
absolute wall ms of scope t0. It is emitted into the sink at scope creation
and can be re-emitted (`emitEpoch()`) for late-attached or cleared sinks.

`offset` is the worker alignment slot: main-thread scopes leave it 0;
worker scopes set it from the clock-sync handshake so that all `t` values
in a merged view share the main thread's timeline. The handshake itself is
lite-worker-profiler's, promoted to a lite-scope service in M3; SPP v1
freezes only the interface (`setClockOffset(ms)`) and the reserved
CLOCK_SYNC meta opcode.

## 8. Ring contract

- Capacity in records, rounded up to a power of two.
- Head advance by bitmask; overwrite-oldest backpressure.
- Accounting: `size()` (live records), `totalWritten()`, `overflow()`
  (records lost). Mirrors lite-trace's ring-mode `_alloc` accounting.
- `forEach(cb)` iterates live records oldest-first, allocation-free.
- `toSlab()` produces an ordered contiguous copy (allocates; export and
  transport paths only, never hot).

## 9. lite-trace alignment -- REVISION against the proposal

The proposal stated: "Align the SPP slot layout to lite-trace's ring record
so its export is a reinterpret, not a transform." Inspection of the
published lite-trace 1.1.0 falsifies this. Its ring is structure-of-arrays:
nine parallel arrays (`_parent` Int32, `_start`/`_end` Float64, `_depth`
Uint16, `_tagId` Int32, `_type` Uint8, `_asyncId` Int32, `_counterVal`
Float64, plus `_args` -- an untyped object array). An interleaved AoS f64
protocol cannot reinterpret SoA storage, and `_args` payloads could never
ride an f64 stream regardless of layout.

SPP stays AoS interleaved -- constraint 4 (one buffer) is what makes mux,
transport, and export trivial, and per-probe SoA layouts would push a
schema into every consumer. lite-trace's role is revised from binary
ancestor to semantic ancestor:

- Its type vocabulary maps 1:1 onto SPP kinds: 0 span -> SPAN,
  1 instant -> INSTANT, 2 counter -> COUNTER, 3/4 asyncBegin/asyncEnd ->
  SPAN with `paired: true` and the asyncId in a payload slot.
- Its per-tracer tag interning (`_intern`, Map + dense array) is the model
  for `scope.intern`.
- Its ring accounting is the model for the SPP ring contract (section 8).
- Its SPP export (lite-trace v1.2) is a walk-and-emit transform over the
  existing allocation-free iterators -- off the hot path -- or a live
  dual-write in the `createTraceProbe({ sink })` adapter. `_args` objects
  do not cross into SPP; interned label ids only.

## 10. Conformance

`vectors.json` is normative. It fixes: packing (including the streamId
high-bit case), the layout checksum, the EPOCH record, a plain instant
stream, a width-3 record with its decoded payload, ring wrap-around with
accounting, torn-chain decoding, intern id assignment, and per-phase telemetry
(block 0x09: three LEVEL ops carrying an interned phase-tag id in b).

Probe repos copy-vendor the vector file (no dev dependency) and assert
against it under `node:test`. The generator (`gen-vectors.mjs`) must
reproduce the committed file byte-for-byte; a change to the vectors is a
protocol change and requires an SPP version discussion, not a regeneration.

## 11. Deferred / reserved

- NDJSON export framing (slab + intern table + descriptors): M6, with the
  CI recipe.
- SharedArrayBuffer ring variant behind COOP/COEP: M3, optional path.
- Cross-thread intern namespacing and descriptor transport: M3.
- Gate sub-block records beyond GATE_VERDICT: M2, shaped by `suiteGate()`.
