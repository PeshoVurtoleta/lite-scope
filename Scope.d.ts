// Type definitions for @zakkster/lite-scope 1.1.0
// Protocol: PROTOCOL.md (SPP v1). Conformance: vectors.json.

export const VERSION: string;
export const SPP_VERSION: number;
export const SLOTS: number;
export const LAYOUT_ID: string;
export const LAYOUT_CHECKSUM: number;

export const BLOCK_TRACE: number;
export const BLOCK_GC: number;
export const BLOCK_SIGNAL: number;
export const BLOCK_GPU: number;
export const BLOCK_LAYOUT: number;
export const BLOCK_INP: number;
export const BLOCK_WORKER: number;
export const BLOCK_LEAK: number;
export const BLOCK_PHASE: number;
export const BLOCK_META: number;

export const OP_VOID: number;
export const OP_EPOCH: number;
export const OP_CONT: number;
export const OP_CLOCK_SYNC: number;
export const OP_GATE_VERDICT: number;
export const META_STREAM: number;

export const KIND_LEVEL: number;
export const KIND_INSTANT: number;
export const KIND_SPAN: number;
export const KIND_COUNTER: number;
export const MAX_WIDTH: number;
export const MAX_PAYLOAD: number;

export function pack(streamId: number, opcode: number): number;
export function streamOf(packed: number): number;
export function opOf(packed: number): number;
export function blockOf(opcode: number): number;
export function fnv1a32(str: string): number;

/** The entire probe-facing contract: four numbers in, nothing out. */
export interface ScopeSink {
  write(packed: number, t: number, a: number, b: number): void;
}

export interface MemorySink extends ScopeSink {
  readonly capacity: number;
  size(): number;
  totalWritten(): number;
  overflow(): number;
  forEach(cb: (packed: number, t: number, a: number, b: number) => void): void;
  toSlab(): Float64Array;
  clear(): void;
}

export interface OpDescriptor {
  code: number;
  name: string;
  /** KIND_LEVEL | KIND_INSTANT | KIND_SPAN | KIND_COUNTER */
  kind: number;
  /** Total records for this op (base + CONT chain), 1..MAX_WIDTH. Default 1. */
  width?: number;
  /** SPAN ops: paired open/close pattern (vs complete-with-duration). */
  paired?: boolean;
}

export interface StreamDescriptor {
  readonly id: number;
  readonly name: string;
  readonly unit: string;
  readonly hz: number;
  readonly ops: readonly Required<OpDescriptor>[];
}

export interface Channel {
  readonly id: number;
  write(op: number, t: number, a: number, b: number): void;
  cont(c0: number, c1: number, c2: number): void;
  intern(str: string): number;
}

export interface ScopeOptions {
  sink?: ScopeSink;
  clock?: () => number;
  epochWallMs?: number;
}

export interface Scope {
  readonly sink: ScopeSink;
  readonly epochWallMs: number;
  now(): number;
  setClockOffset(ms: number): void;
  clockOffset(): number;
  intern(str: string): number;
  stringTable(): string[];
  register(desc: {
    name: string;
    unit?: string;
    hz?: number;
    ops: OpDescriptor[];
  }): Channel;
  streams(): StreamDescriptor[];
  widthOf(packed: number): number;
  emitEpoch(): void;
  metaWrite(op: number, t: number, a: number, b: number): void;
}

export function createNullSink(): ScopeSink;
export function createMemorySink(capacityRecords?: number): MemorySink;
export function createMuxSink(sinks: ScopeSink[]): ScopeSink;
export function createScope(options?: ScopeOptions): Scope;

/**
 * Reference decoder for contiguous record slabs. Groups CONT chains and
 * applies the torn-chain rules. The payload argument is a shared scratch
 * buffer, valid only until the next callback; readSlab is not reentrant.
 */
export function readSlab(
  slab: Float64Array,
  widthOf: (packed: number) => number,
  cb: (packed: number, t: number, payload: Float64Array, payloadCount: number) => void
): void;
