// Scope.js -- @zakkster/lite-scope
// Scope Probe Protocol (SPP v1): registry, sinks, and timebase for the
// @zakkster profiler suite.
//
// Zero-dependency single-file ESM. Zero-GC on the write path: one record is
// 4 f64 slots, strings are interned at init time only, and the entire
// probe-facing contract is a single monomorphic sink.write(packed, t, a, b).
//
// Normative protocol: PROTOCOL.md. Conformance fixtures: vectors.json.
// Probe packages never import this file; they receive a sink (or channel)
// by dependency injection and speak the protocol, not the package.

export const VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

export const SPP_VERSION = 1;

// One record = 4 f64 slots: [packed, t, a, b]
//   packed = (streamId << 16 | opcode) >>> 0    (both u16, exact in f64)
//   t      = ms since scope epoch (in CONT records this slot is payload c0)
//   a, b   = payload slots       (in CONT records: c1, c2)
export const SLOTS = 4;

// Canonical layout identifier and its FNV-1a 32-bit checksum. The checksum
// is a hardcoded constant (not computed at module init) so bundlers can
// tree-shake fnv1a32 when unused; a self-test asserts the two agree.
export const LAYOUT_ID = 'SPP1:[packed,t,a,b]';
export const LAYOUT_CHECKSUM = 2232310714; // fnv1a32(LAYOUT_ID) === 0x850E5BBA

// Opcode blocks (high byte of the u16 opcode). Block 0x00 is invalid so a
// zeroed ring slot is self-describing empty; block 0x0F is reserved for
// meta/gate records emitted through the scope itself.
export const BLOCK_TRACE = 0x01;
export const BLOCK_GC = 0x02;
export const BLOCK_SIGNAL = 0x03; // provisional: frozen range, open assignments
export const BLOCK_GPU = 0x04;
export const BLOCK_LAYOUT = 0x05;
export const BLOCK_INP = 0x06;
export const BLOCK_WORKER = 0x07;
export const BLOCK_LEAK = 0x08; // provisional: frozen range, open assignments
export const BLOCK_META = 0x0F;

// Meta opcodes. OP_CONT rides any streamId (it continues that stream's
// preceding record); the rest are written on META_STREAM (streamId 0).
export const OP_VOID = 0x0000; // empty slot marker; consumers skip
export const OP_EPOCH = 0x0F00; // t=abs wall ms of scope t0, a=SPP_VERSION, b=LAYOUT_CHECKSUM
export const OP_CONT = 0x0F01; // wide-record continuation: [packed, c0, c1, c2]
export const OP_CLOCK_SYNC = 0x0F02; // reserved for M3: a=offset ms, b=round-trip ms
export const OP_GATE_VERDICT = 0x0F40; // reserved for M2: a=interned budget id, b=0 pass|1 fail|3 recapture

export const META_STREAM = 0;

// Channel kinds (declared per op at registration; render hints for consumers).
export const KIND_LEVEL = 0; // continuous sample -> waveform
export const KIND_INSTANT = 1; // point event -> blip
export const KIND_SPAN = 2; // region (paired open/close ops, or complete-with-duration)
export const KIND_COUNTER = 3; // monotonic-ish value -> step trace

// Wide records: total width in records (base + CONT chain), static per op.
export const MAX_WIDTH = 3; // base + at most 2 CONT records
export const MAX_PAYLOAD = 8; // 2 base slots + 2 chains * 3 slots

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

export function pack(streamId, opcode) {
    return ((streamId << 16) | opcode) >>> 0;
}

export function streamOf(packed) {
    return packed >>> 16;
}

export function opOf(packed) {
    return packed & 0xFFFF;
}

export function blockOf(opcode) {
    return (opcode >>> 8) & 0xFF;
}

// FNV-1a 32-bit over the code units of an ASCII string.
export function fnv1a32(str) {
    let h = 0x811C9DC5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

// ---------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------
// The probe-facing sink contract is exactly one method:
//   write(packed, t, a, b)   -- four numbers, no return value contract.
// Everything below implements that contract.

function scopeNoopWrite() {
}

const SCOPE_NULL_SINK = Object.freeze({write: scopeNoopWrite});

/** Shared no-op sink. Probes injected with this cost one monomorphic call. */
export function createNullSink() {
    return SCOPE_NULL_SINK;
}

function scopePow2(n) {
    let c = 1;
    while (c < n) c <<= 1;
    return c;
}

/**
 * In-memory ring sink. Capacity is rounded up to a power of two (records).
 * Overwrite-oldest backpressure, bitmask head advance, zero allocation on
 * write. forEach() is allocation-free; toSlab() allocates (export path only).
 */
export function createMemorySink(capacityRecords) {
    const wanted = capacityRecords === undefined ? 4096 : capacityRecords;
    if (!(wanted > 0) || !isFinite(wanted)) {
        throw new RangeError('lite-scope: memory sink capacity must be a positive finite number');
    }
    const cap = scopePow2(wanted);
    const mask = cap - 1;
    const slab = new Float64Array(cap * SLOTS);
    let total = 0; // records ever written

    return {
        capacity: cap,

        write(packed, t, a, b) {
            const i = (total & mask) << 2;
            slab[i] = packed;
            slab[i + 1] = t;
            slab[i + 2] = a;
            slab[i + 3] = b;
            total++;
        },

        /** Live records currently held (<= capacity). */
        size() {
            return total < cap ? total : cap;
        },

        /** Records ever written, including overwritten ones. */
        totalWritten() {
            return total;
        },

        /** Records lost to overwrite-oldest. */
        overflow() {
            return total > cap ? total - cap : 0;
        },

        /** Iterate live records oldest-first. Allocation-free. cb(packed, t, a, b). */
        forEach(cb) {
            const n = total < cap ? total : cap;
            const start = total - n;
            for (let k = 0; k < n; k++) {
                const i = ((start + k) & mask) << 2;
                cb(slab[i], slab[i + 1], slab[i + 2], slab[i + 3]);
            }
        },

        /** Ordered copy of live records as a contiguous Float64Array. Allocates. */
        toSlab() {
            const n = total < cap ? total : cap;
            const start = total - n;
            const out = new Float64Array(n * SLOTS);
            for (let k = 0; k < n; k++) {
                const i = ((start + k) & mask) << 2;
                const o = k << 2;
                out[o] = slab[i];
                out[o + 1] = slab[i + 1];
                out[o + 2] = slab[i + 2];
                out[o + 3] = slab[i + 3];
            }
            return out;
        },

        clear() {
            total = 0;
        }
    };
}

/** Fan-out sink. The sink list is copied and frozen at creation. */
export function createMuxSink(sinks) {
    if (!Array.isArray(sinks)) {
        throw new TypeError('lite-scope: mux sink expects an array of sinks');
    }
    const list = sinks.slice();
    const n = list.length;
    for (let i = 0; i < n; i++) {
        if (!list[i] || typeof list[i].write !== 'function') {
            throw new TypeError('lite-scope: mux sink entry ' + i + ' has no write()');
        }
    }
    return {
        write(packed, t, a, b) {
            for (let i = 0; i < n; i++) list[i].write(packed, t, a, b);
        }
    };
}

// ---------------------------------------------------------------------------
// Scope: registry + intern table + timebase
// ---------------------------------------------------------------------------

function scopeDefaultClock() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return function scopePerfClock() {
            return performance.now();
        };
    }
    return function scopeDateClock() {
        return Date.now();
    };
}

function scopeValidateOp(op, seen, streamName) {
    if (!op || typeof op !== 'object') {
        throw new TypeError('lite-scope: stream "' + streamName + '": op descriptor must be an object');
    }
    const code = op.code;
    if (!Number.isInteger(code) || code < 0 || code > 0xFFFF) {
        throw new RangeError('lite-scope: stream "' + streamName + '": op code must be a u16');
    }
    const block = blockOf(code);
    if (block === 0x00) {
        throw new RangeError('lite-scope: stream "' + streamName + '": op block 0x00 is invalid (0x0000 is the empty-slot marker)');
    }
    if (block === BLOCK_META) {
        throw new RangeError('lite-scope: stream "' + streamName + '": op block 0x0F is reserved for meta/gate records');
    }
    if (seen.has(code)) {
        throw new RangeError('lite-scope: stream "' + streamName + '": duplicate op code 0x' + code.toString(16));
    }
    seen.add(code);
    if (typeof op.name !== 'string' || op.name.length === 0) {
        throw new TypeError('lite-scope: stream "' + streamName + '": op name must be a non-empty string');
    }
    const kind = op.kind;
    if (!Number.isInteger(kind) || kind < 0 || kind > 3) {
        throw new RangeError('lite-scope: stream "' + streamName + '": op kind must be 0..3');
    }
    const width = op.width === undefined ? 1 : op.width;
    if (!Number.isInteger(width) || width < 1 || width > MAX_WIDTH) {
        throw new RangeError('lite-scope: stream "' + streamName + '": op width must be 1..' + MAX_WIDTH);
    }
    return Object.freeze({
        code: code,
        name: op.name,
        kind: kind,
        width: width,
        paired: op.paired === true
    });
}

/**
 * Create a scope: one registry, one intern table, one timebase, one sink.
 * All registration and interning is init-time; nothing here belongs on a
 * hot path except the channel write/cont calls it hands out.
 *
 * options:
 *   sink        -- injected sink (default: shared null sink)
 *   clock       -- ms clock function (default: performance.now)
 *   epochWallMs -- absolute wall-clock ms of scope t0 (default: Date.now())
 */
export function createScope(options) {
    const opts = options || {};
    const sink = opts.sink !== undefined && opts.sink !== null ? opts.sink : SCOPE_NULL_SINK;
    if (typeof sink.write !== 'function') {
        throw new TypeError('lite-scope: injected sink has no write()');
    }
    const clock = typeof opts.clock === 'function' ? opts.clock : scopeDefaultClock();
    const epochWall = opts.epochWallMs === undefined ? Date.now() : opts.epochWallMs;
    const base = clock();
    let offset = 0;

    const strings = [];
    const stringMap = new Map();

    const descriptors = []; // index = streamId - 1, frozen
    const widthMap = new Map(); // packed(u32) -> width
    let nextId = 1;

    function now() {
        return clock() - base + offset;
    }

    /** Worker-side clock alignment slot (handshake lands in M3). */
    function setClockOffset(ms) {
        offset = ms;
    }

    function clockOffset() {
        return offset;
    }

    /** Intern a string. Init-time only; ids are dense u32, scope-local. */
    function intern(str) {
        let id = stringMap.get(str);
        if (id === undefined) {
            id = strings.length;
            strings.push(str);
            stringMap.set(str, id);
        }
        return id;
    }

    /** Snapshot of the intern table (export path; allocates). */
    function stringTable() {
        return strings.slice();
    }

    /** Emit (or re-emit) the EPOCH meta record into the sink. */
    function emitEpoch() {
        sink.write(pack(META_STREAM, OP_EPOCH), epochWall, SPP_VERSION, LAYOUT_CHECKSUM);
    }

    /** Write a meta/gate record on stream 0 (consumer bridges, not probes). */
    function metaWrite(op, t, a, b) {
        sink.write(pack(META_STREAM, op), t, a, b);
    }

    /**
     * Register a probe stream. Descriptor:
     *   { name, unit?, hz?, ops: [{ code, name, kind, width?, paired? }] }
     * Returns a channel: { id, write(op, t, a, b), cont(c0, c1, c2), intern }.
     * write/cont are the only calls permitted on hot paths; they validate
     * nothing and allocate nothing.
     */
    function register(desc) {
        if (!desc || typeof desc !== 'object') {
            throw new TypeError('lite-scope: register() expects a descriptor object');
        }
        if (typeof desc.name !== 'string' || desc.name.length === 0) {
            throw new TypeError('lite-scope: stream name must be a non-empty string');
        }
        if (!Array.isArray(desc.ops) || desc.ops.length === 0) {
            throw new TypeError('lite-scope: stream "' + desc.name + '": ops must be a non-empty array');
        }
        if (nextId > 0xFFFF) {
            throw new RangeError('lite-scope: stream id space exhausted (u16)');
        }
        const seen = new Set();
        const ops = [];
        for (let i = 0; i < desc.ops.length; i++) {
            ops.push(scopeValidateOp(desc.ops[i], seen, desc.name));
        }
        const sid = nextId++;
        for (let i = 0; i < ops.length; i++) {
            widthMap.set(pack(sid, ops[i].code), ops[i].width);
        }
        descriptors.push(Object.freeze({
            id: sid,
            name: desc.name,
            unit: typeof desc.unit === 'string' ? desc.unit : '',
            hz: typeof desc.hz === 'number' ? desc.hz : 0,
            ops: Object.freeze(ops)
        }));

        const contPacked = pack(sid, OP_CONT);
        return {
            id: sid,
            write(op, t, a, b) {
                sink.write(((sid << 16) | op) >>> 0, t, a, b);
            },
            cont(c0, c1, c2) {
                sink.write(contPacked, c0, c1, c2);
            },
            intern: intern
        };
    }

    /** Registered stream descriptors (copy of the frozen list). */
    function streams() {
        return descriptors.slice();
    }

    /** Total record width for a packed header. Unregistered ops read as 1. */
    function widthOf(packed) {
        const op = packed & 0xFFFF;
        if (((op >>> 8) & 0xFF) === BLOCK_META) return 1; // meta/gate are width 1 in SPP v1
        const w = widthMap.get(packed >>> 0);
        return w === undefined ? 1 : w;
    }

    emitEpoch();

    return {
        sink: sink,
        epochWallMs: epochWall,
        now: now,
        setClockOffset: setClockOffset,
        clockOffset: clockOffset,
        intern: intern,
        stringTable: stringTable,
        register: register,
        streams: streams,
        widthOf: widthOf,
        emitEpoch: emitEpoch,
        metaWrite: metaWrite
    };
}

// ---------------------------------------------------------------------------
// Reference decoder
// ---------------------------------------------------------------------------

// Shared payload scratch: valid only until the next cb invocation, and
// readSlab is therefore NOT reentrant. Consumers copy if they retain.
const SCOPE_READ_SCRATCH = new Float64Array(MAX_PAYLOAD);

/**
 * Decode a contiguous record slab (e.g. memorySink.toSlab()), grouping wide
 * records with their CONT chains. Torn-chain rules per PROTOCOL.md:
 * leading orphan CONTs (base overwritten by the ring) are skipped, as are
 * VOID slots and mid-stream orphan CONTs; a chain truncated at the slab end
 * or by a stream-id mismatch is delivered with the payload it has.
 *
 * cb(packed, t, payload, payloadCount) -- payload is a shared scratch
 * Float64Array; payload[0]=a, payload[1]=b, then 3 slots per CONT record.
 */
export function readSlab(slab, widthOf, cb) {
    const nRec = (slab.length / SLOTS) | 0;
    let k = 0;
    while (k < nRec && (slab[k << 2] & 0xFFFF) === OP_CONT) k++;
    while (k < nRec) {
        const i = k << 2;
        const p = slab[i];
        const op = p & 0xFFFF;
        if (op === OP_VOID || op === OP_CONT) {
            k++;
            continue;
        }
        const t = slab[i + 1];
        SCOPE_READ_SCRATCH[0] = slab[i + 2];
        SCOPE_READ_SCRATCH[1] = slab[i + 3];
        let count = 2;
        let used = 1;
        const sid = p >>> 16;
        const w = widthOf(p);
        while (used < w && k + used < nRec) {
            const j = (k + used) << 2;
            const cp = slab[j];
            if ((cp & 0xFFFF) !== OP_CONT || (cp >>> 16) !== sid) break;
            SCOPE_READ_SCRATCH[count] = slab[j + 1];
            SCOPE_READ_SCRATCH[count + 1] = slab[j + 2];
            SCOPE_READ_SCRATCH[count + 2] = slab[j + 3];
            count += 3;
            used++;
        }
        cb(p, t, SCOPE_READ_SCRATCH, count);
        k += used;
    }
}
