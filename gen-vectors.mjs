// gen-vectors.mjs -- golden vector generator for SPP v1 (dev script).
// vectors.json is NORMATIVE once reviewed and frozen: this generator must
// reproduce it byte-for-byte (asserted in Scope.test.mjs). Protocol changes
// that alter vectors.json are protocol changes, and require an SPP_VERSION
// discussion, not a regeneration.
//
// Usage: node gen-vectors.mjs

import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {
    SPP_VERSION, LAYOUT_ID, LAYOUT_CHECKSUM, fnv1a32, pack,
    KIND_INSTANT, KIND_SPAN, KIND_LEVEL,
    createScope, createMemorySink, readSlab
} from './Scope.js';

// Fixed wall epoch for all vectors: 2026-07-07T00:00:00Z.
const EPOCH_WALL = 1783382400000;

function slabToArray(slab) {
    return Array.from(slab);
}

function decode(slab, widthOf) {
    const out = [];
    readSlab(slab, widthOf, function (packed, t, payload, count) {
        const p = [];
        for (let i = 0; i < count; i++) p.push(payload[i]);
        out.push({packed: packed, t: t, payload: p});
    });
    return out;
}

export function buildVectors() {
    // -- packing ---------------------------------------------------------------
    const packingPairs = [
        [0, 0x0F00], // meta stream, EPOCH
        [1, 0x0100],
        [1, 0x0F01], // CONT rides a probe stream id
        [255, 0x02FF],
        [0x7FFF, 0x0800],
        [0x8000, 0x0101], // high bit of streamId exercises the >>> 0 coercion
        [0xFFFF, 0xFFFF]
    ];
    const packing = packingPairs.map(function (pair) {
        return {stream: pair[0], op: pair[1], packed: pack(pair[0], pair[1])};
    });

    // -- checksum ----------------------------------------------------------------
    const checksum = {
        layoutId: LAYOUT_ID,
        fnv1a32: fnv1a32(LAYOUT_ID),
        constant: LAYOUT_CHECKSUM
    };

    // -- epoch record ------------------------------------------------------------
    const epochSink = createMemorySink(4);
    createScope({
        sink: epochSink, clock: function () {
            return 0;
        }, epochWallMs: EPOCH_WALL
    });
    const epoch = {
        epochWallMs: EPOCH_WALL,
        sppVersion: SPP_VERSION,
        record: slabToArray(epochSink.toSlab())
    };

    // -- simple instant stream -----------------------------------------------------
    const instSink = createMemorySink(8);
    const instScope = createScope({
        sink: instSink, clock: function () {
            return 0;
        }, epochWallMs: EPOCH_WALL
    });
    const gc = instScope.register({
        name: 'gc',
        unit: 'count',
        ops: [{code: 0x0200, name: 'scavenge', kind: KIND_INSTANT}]
    });
    gc.write(0x0200, 1, 1, 0);
    gc.write(0x0200, 2, 1, 0);
    gc.write(0x0200, 3, 2, 0);
    const instantStream = {
        streamId: gc.id,
        slab: slabToArray(instSink.toSlab()),
        decoded: decode(instSink.toSlab(), instScope.widthOf)
    };

    // -- wide record (width 3: base + 2 CONT) ---------------------------------------
    const wideSink = createMemorySink(8);
    const wideScope = createScope({
        sink: wideSink, clock: function () {
            return 0;
        }, epochWallMs: EPOCH_WALL
    });
    const tr = wideScope.register({
        name: 'trace',
        unit: 'ms',
        ops: [{code: 0x0101, name: 'span.tree', kind: KIND_SPAN, width: 3}]
    });
    tr.write(0x0101, 10, 2.5, 7); // t=10, a=dur, b=tagId
    tr.cont(1, 4, 0); // depth, parent, asyncId
    tr.cont(42, 43, 44); // arbitrary extension slots
    const wideRecord = {
        streamId: tr.id,
        slab: slabToArray(wideSink.toSlab()),
        decoded: decode(wideSink.toSlab(), wideScope.widthOf)
    };

    // -- ring wrap (raw sink, no scope) ---------------------------------------------
    const wrapSink = createMemorySink(4);
    for (let n = 1; n <= 6; n++) {
        wrapSink.write(pack(1, 0x0100), n, n * 10, 0);
    }
    const ringWrap = {
        capacity: wrapSink.capacity,
        written: 6,
        size: wrapSink.size(),
        overflow: wrapSink.overflow(),
        slab: slabToArray(wrapSink.toSlab())
    };

    // -- torn chain -------------------------------------------------------------------
    // Capacity 4. Write base(width 3) + 2 CONT + one narrow record, then one
    // more narrow record: the ring overwrites the base, leaving two orphan
    // CONTs at the logical start. Decoder must skip them.
    const tornSink = createMemorySink(4);
    const SID = 1;
    tornSink.write(pack(SID, 0x0101), 10, 2.5, 7); // base, will be overwritten
    tornSink.write(pack(SID, 0x0F01), 1, 4, 0); // CONT 1 -> orphaned
    tornSink.write(pack(SID, 0x0F01), 42, 43, 44); // CONT 2 -> orphaned
    tornSink.write(pack(SID, 0x0100), 20, 5, 0); // narrow B
    tornSink.write(pack(SID, 0x0100), 30, 6, 0); // narrow C, overwrites base
    const tornWidthOf = function (packed) {
        return (packed & 0xFFFF) === 0x0101 ? 3 : 1;
    };
    const tornChain = {
        capacity: tornSink.capacity,
        slab: slabToArray(tornSink.toSlab()),
        decoded: decode(tornSink.toSlab(), tornWidthOf)
    };

    // -- interning ----------------------------------------------------------------------
    const internScope = createScope({
        clock: function () {
            return 0;
        }, epochWallMs: EPOCH_WALL
    });
    const internInput = ['alpha', 'beta', 'alpha', 'gamma', 'beta'];
    const internIds = internInput.map(function (s) {
        return internScope.intern(s);
    });
    const intern = {
        input: internInput,
        ids: internIds,
        table: internScope.stringTable()
    };

    // -- phase telemetry (block 0x09: reduced per-phase LEVEL stats) ----------------
    // One "phase-telemetry" stream, three width-1 LEVEL ops (avg/p99/max); a = stat
    // ms, b = interned phase-tag id. Two phases (physics=0, render=1) prove the b
    // slot carries a dense scope-interned id, per the block 0x01 tagId convention.
    const phaseSink = createMemorySink(16);
    const phaseScope = createScope({
        sink: phaseSink, clock: function () {
            return 0;
        }, epochWallMs: EPOCH_WALL
    });
    const physicsId = phaseScope.intern('physics');
    const renderId = phaseScope.intern('render');
    const ph = phaseScope.register({
        name: 'phase-telemetry',
        unit: 'ms',
        hz: 10,
        ops: [
            {code: 0x0900, name: 'phase.avg', kind: KIND_LEVEL},
            {code: 0x0901, name: 'phase.p99', kind: KIND_LEVEL},
            {code: 0x0902, name: 'phase.max', kind: KIND_LEVEL}
        ]
    });
    ph.write(0x0900, 100, 2, physicsId);
    ph.write(0x0901, 100, 5, physicsId);
    ph.write(0x0902, 100, 6, physicsId);
    ph.write(0x0900, 100, 8, renderId);
    ph.write(0x0901, 100, 20, renderId);
    ph.write(0x0902, 100, 24, renderId);
    const phaseTelemetry = {
        streamId: ph.id,
        tags: {physics: physicsId, render: renderId},
        table: phaseScope.stringTable(),
        slab: slabToArray(phaseSink.toSlab()),
        decoded: decode(phaseSink.toSlab(), phaseScope.widthOf)
    };

    // -- counter telemetry (block 0x0A: reduced per-counter LEVEL stats) -------------
    // One "counter-telemetry" stream, three width-1 LEVEL ops (avg/max/last); a = stat
    // count, b = interned counter-tag id. Two counters (drawCalls=0, floatsUploaded=1)
    // prove the b slot carries a dense scope-interned id, per the block 0x01 tagId
    // convention. Counters are deterministic lower-is-better integers: `last` is the
    // exact current-frame value, `max` the gated ceiling.
    const counterSink = createMemorySink(16);
    const counterScope = createScope({
        sink: counterSink, clock: function () {
            return 0;
        }, epochWallMs: EPOCH_WALL
    });
    const drawCallsId = counterScope.intern('drawCalls');
    const floatsUploadedId = counterScope.intern('floatsUploaded');
    const co = counterScope.register({
        name: 'counter-telemetry',
        unit: 'count',
        hz: 10,
        ops: [
            {code: 0x0A00, name: 'counter.avg', kind: KIND_LEVEL},
            {code: 0x0A01, name: 'counter.max', kind: KIND_LEVEL},
            {code: 0x0A02, name: 'counter.last', kind: KIND_LEVEL}
        ]
    });
    co.write(0x0A00, 100, 12, drawCallsId);
    co.write(0x0A01, 100, 20, drawCallsId);
    co.write(0x0A02, 100, 18, drawCallsId);
    co.write(0x0A00, 100, 300, floatsUploadedId);
    co.write(0x0A01, 100, 512, floatsUploadedId);
    co.write(0x0A02, 100, 400, floatsUploadedId);
    const counterTelemetry = {
        streamId: co.id,
        tags: {drawCalls: drawCallsId, floatsUploaded: floatsUploadedId},
        table: counterScope.stringTable(),
        slab: slabToArray(counterSink.toSlab()),
        decoded: decode(counterSink.toSlab(), counterScope.widthOf)
    };

    return {
        spp: SPP_VERSION,
        layoutId: LAYOUT_ID,
        layoutChecksum: LAYOUT_CHECKSUM,
        cases: {
            packing: packing,
            checksum: checksum,
            epoch: epoch,
            instantStream: instantStream,
            wideRecord: wideRecord,
            ringWrap: ringWrap,
            tornChain: tornChain,
            intern: intern,
            phaseTelemetry: phaseTelemetry,
            counterTelemetry: counterTelemetry
        }
    };
}

const scopeIsMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (scopeIsMain) {
    writeFileSync(new URL('./vectors.json', import.meta.url), JSON.stringify(buildVectors(), null, 2) + '\n');
    process.stdout.write('vectors.json written\n');
}
