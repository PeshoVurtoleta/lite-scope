// Scope.test.mjs -- @zakkster/lite-scope test suite (node:test).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  VERSION, SPP_VERSION, SLOTS, LAYOUT_ID, LAYOUT_CHECKSUM,
  BLOCK_TRACE, BLOCK_GC, BLOCK_SIGNAL, BLOCK_GPU, BLOCK_LAYOUT,
  BLOCK_INP, BLOCK_WORKER, BLOCK_LEAK, BLOCK_META,
  OP_VOID, OP_EPOCH, OP_CONT, OP_CLOCK_SYNC, OP_GATE_VERDICT, META_STREAM,
  KIND_LEVEL, KIND_INSTANT, KIND_SPAN, KIND_COUNTER, MAX_WIDTH, MAX_PAYLOAD,
  pack, streamOf, opOf, blockOf, fnv1a32,
  createNullSink, createMemorySink, createMuxSink, createScope, readSlab
} from '../Scope.js';

import { buildVectors } from '../gen-vectors.mjs';

const VECTORS = JSON.parse(readFileSync(new URL('../vectors.json', import.meta.url), 'utf8'));
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function fixedClock(value) {
  return function () { return value; };
}

function collect(sink) {
  const out = [];
  sink.forEach(function (p, t, a, b) { out.push([p, t, a, b]); });
  return out;
}

// ---------------------------------------------------------------------------

describe('version discipline', function () {
  it('VERSION matches package.json (triple bump)', function () {
    assert.equal(VERSION, '1.0.0');
    assert.equal(PKG.version, VERSION);
  });

  it('SPP_VERSION is 1', function () {
    assert.equal(SPP_VERSION, 1);
  });
});

describe('packing', function () {
  it('round-trips stream and op through packed u32', function () {
    const p = pack(1, 0x0100);
    assert.equal(p, 0x00010100);
    assert.equal(streamOf(p), 1);
    assert.equal(opOf(p), 0x0100);
  });

  it('is exact at the u16 extremes', function () {
    const p = pack(0xFFFF, 0xFFFF);
    assert.equal(p, 0xFFFFFFFF);
    assert.equal(streamOf(p), 0xFFFF);
    assert.equal(opOf(p), 0xFFFF);
  });

  it('handles the streamId high bit without sign corruption', function () {
    const p = pack(0x8000, 0x0101);
    assert.ok(p > 0);
    assert.equal(streamOf(p), 0x8000);
    assert.equal(opOf(p), 0x0101);
  });

  it('survives an f64 store round-trip', function () {
    const f = new Float64Array(1);
    f[0] = pack(0xFFFF, 0xFFFF);
    assert.equal(f[0] >>> 16, 0xFFFF);
    assert.equal(f[0] & 0xFFFF, 0xFFFF);
  });

  it('blockOf extracts the family block', function () {
    assert.equal(blockOf(0x0200), BLOCK_GC);
    assert.equal(blockOf(0x0F01), BLOCK_META);
    assert.equal(blockOf(0x0000), 0x00);
  });

  it('block constants cover the frozen map', function () {
    assert.deepEqual(
      [BLOCK_TRACE, BLOCK_GC, BLOCK_SIGNAL, BLOCK_GPU, BLOCK_LAYOUT, BLOCK_INP, BLOCK_WORKER, BLOCK_LEAK, BLOCK_META],
      [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x0F]
    );
  });
});

describe('layout checksum', function () {
  it('hardcoded LAYOUT_CHECKSUM equals fnv1a32(LAYOUT_ID)', function () {
    assert.equal(fnv1a32(LAYOUT_ID), LAYOUT_CHECKSUM);
  });

  it('fnv1a32 matches known vectors', function () {
    assert.equal(fnv1a32(''), 0x811C9DC5);
    assert.equal(fnv1a32('a'), 0xE40C292C);
  });
});

describe('null sink', function () {
  it('write is a callable no-op and the sink is frozen + shared', function () {
    const s = createNullSink();
    assert.equal(s, createNullSink());
    assert.ok(Object.isFrozen(s));
    assert.equal(s.write(1, 2, 3, 4), undefined);
  });
});

describe('memory sink', function () {
  it('rounds capacity up to a power of two', function () {
    assert.equal(createMemorySink(5).capacity, 8);
    assert.equal(createMemorySink(4).capacity, 4);
    assert.equal(createMemorySink(1).capacity, 1);
  });

  it('rejects non-positive capacity', function () {
    assert.throws(function () { createMemorySink(0); }, RangeError);
    assert.throws(function () { createMemorySink(-3); }, RangeError);
    assert.throws(function () { createMemorySink(Infinity); }, RangeError);
  });

  it('stores records in slot order', function () {
    const s = createMemorySink(4);
    s.write(pack(1, 0x0100), 1, 10, 11);
    s.write(pack(1, 0x0100), 2, 20, 21);
    assert.deepEqual(collect(s), [
      [pack(1, 0x0100), 1, 10, 11],
      [pack(1, 0x0100), 2, 20, 21]
    ]);
  });

  it('wraps with overwrite-oldest and keeps order', function () {
    const s = createMemorySink(4);
    for (let n = 1; n <= 6; n++) s.write(pack(1, 0x0100), n, 0, 0);
    const ts = collect(s).map(function (r) { return r[1]; });
    assert.deepEqual(ts, [3, 4, 5, 6]);
  });

  it('accounts size, totalWritten, overflow across the wrap', function () {
    const s = createMemorySink(4);
    for (let n = 1; n <= 3; n++) s.write(0x00010100, n, 0, 0);
    assert.equal(s.size(), 3);
    assert.equal(s.totalWritten(), 3);
    assert.equal(s.overflow(), 0);
    for (let n = 4; n <= 6; n++) s.write(0x00010100, n, 0, 0);
    assert.equal(s.size(), 4);
    assert.equal(s.totalWritten(), 6);
    assert.equal(s.overflow(), 2);
  });

  it('toSlab equals forEach order and is a copy', function () {
    const s = createMemorySink(4);
    for (let n = 1; n <= 6; n++) s.write(pack(1, 0x0100), n, n * 10, 0);
    const slab = s.toSlab();
    const flat = [];
    s.forEach(function (p, t, a, b) { flat.push(p, t, a, b); });
    assert.deepEqual(Array.from(slab), flat);
    slab[1] = 999;
    assert.equal(collect(s)[0][1], 3);
  });

  it('clear resets accounting', function () {
    const s = createMemorySink(4);
    for (let n = 1; n <= 6; n++) s.write(0x00010100, n, 0, 0);
    s.clear();
    assert.equal(s.size(), 0);
    assert.equal(s.totalWritten(), 0);
    assert.equal(s.overflow(), 0);
    assert.deepEqual(collect(s), []);
  });
});

describe('mux sink', function () {
  it('fans out one write to every sink in order', function () {
    const a = createMemorySink(4);
    const b = createMemorySink(4);
    const m = createMuxSink([a, b]);
    m.write(pack(1, 0x0100), 1, 2, 3);
    assert.deepEqual(collect(a), [[pack(1, 0x0100), 1, 2, 3]]);
    assert.deepEqual(collect(b), [[pack(1, 0x0100), 1, 2, 3]]);
  });

  it('copies the sink list at creation', function () {
    const a = createMemorySink(4);
    const list = [a];
    const m = createMuxSink(list);
    list.push(createMemorySink(4));
    m.write(1, 2, 3, 4);
    assert.equal(a.size(), 1);
  });

  it('rejects non-arrays and entries without write()', function () {
    assert.throws(function () { createMuxSink({}); }, TypeError);
    assert.throws(function () { createMuxSink([{}]); }, TypeError);
  });
});

describe('scope: epoch and timebase', function () {
  it('emits the EPOCH meta record at creation', function () {
    const s = createMemorySink(4);
    createScope({ sink: s, clock: fixedClock(0), epochWallMs: 123 });
    assert.deepEqual(collect(s), [[pack(META_STREAM, OP_EPOCH), 123, SPP_VERSION, LAYOUT_CHECKSUM]]);
  });

  it('emitEpoch re-emits on demand', function () {
    const s = createMemorySink(4);
    const scope = createScope({ sink: s, clock: fixedClock(0), epochWallMs: 123 });
    s.clear();
    scope.emitEpoch();
    assert.equal(collect(s).length, 1);
    assert.equal(opOf(collect(s)[0][0]), OP_EPOCH);
  });

  it('now() is relative to the clock value at creation', function () {
    let tick = 100;
    const scope = createScope({ clock: function () { return tick; } });
    assert.equal(scope.now(), 0);
    tick = 107.5;
    assert.equal(scope.now(), 7.5);
  });

  it('setClockOffset shifts now() (worker alignment slot)', function () {
    let tick = 100;
    const scope = createScope({ clock: function () { return tick; } });
    scope.setClockOffset(50);
    tick = 110;
    assert.equal(scope.now(), 60);
    assert.equal(scope.clockOffset(), 50);
  });

  it('defaults to the null sink and rejects sinks without write()', function () {
    const scope = createScope();
    assert.equal(typeof scope.sink.write, 'function');
    assert.throws(function () { createScope({ sink: {} }); }, TypeError);
  });

  it('exposes epochWallMs', function () {
    const scope = createScope({ clock: fixedClock(0), epochWallMs: 456 });
    assert.equal(scope.epochWallMs, 456);
  });
});

describe('scope: interning', function () {
  it('assigns dense ids and is idempotent', function () {
    const scope = createScope({ clock: fixedClock(0) });
    assert.equal(scope.intern('alpha'), 0);
    assert.equal(scope.intern('beta'), 1);
    assert.equal(scope.intern('alpha'), 0);
  });

  it('stringTable snapshots without exposing internals', function () {
    const scope = createScope({ clock: fixedClock(0) });
    scope.intern('alpha');
    const t = scope.stringTable();
    t.push('injected');
    assert.deepEqual(scope.stringTable(), ['alpha']);
  });

  it('channel.intern is the scope intern (shared table)', function () {
    const scope = createScope({ clock: fixedClock(0) });
    const ch = scope.register({ name: 'x', ops: [{ code: 0x0100, name: 'e', kind: KIND_INSTANT }] });
    assert.equal(scope.intern('alpha'), 0);
    assert.equal(ch.intern('alpha'), 0);
    assert.equal(ch.intern('beta'), 1);
  });
});

describe('scope: registration', function () {
  function opInstant(code) {
    return { code: code, name: 'op' + code.toString(16), kind: KIND_INSTANT };
  }

  it('assigns dense stream ids from 1 (0 is meta)', function () {
    const scope = createScope({ clock: fixedClock(0) });
    const a = scope.register({ name: 'a', ops: [opInstant(0x0100)] });
    const b = scope.register({ name: 'b', ops: [opInstant(0x0200)] });
    assert.equal(a.id, 1);
    assert.equal(b.id, 2);
    assert.equal(META_STREAM, 0);
  });

  it('streams() returns frozen descriptors with defaults applied', function () {
    const scope = createScope({ clock: fixedClock(0) });
    scope.register({
      name: 'gc', unit: 'count', hz: 10,
      ops: [{ code: 0x0200, name: 'scavenge', kind: KIND_INSTANT }]
    });
    const d = scope.streams();
    assert.equal(d.length, 1);
    assert.equal(d[0].id, 1);
    assert.equal(d[0].name, 'gc');
    assert.equal(d[0].unit, 'count');
    assert.equal(d[0].hz, 10);
    assert.ok(Object.isFrozen(d[0]));
    assert.ok(Object.isFrozen(d[0].ops));
    assert.deepEqual(d[0].ops[0], { code: 0x0200, name: 'scavenge', kind: KIND_INSTANT, width: 1, paired: false });
  });

  it('rejects bad stream descriptors', function () {
    const scope = createScope({ clock: fixedClock(0) });
    assert.throws(function () { scope.register(null); }, TypeError);
    assert.throws(function () { scope.register({ name: '', ops: [opInstant(0x0100)] }); }, TypeError);
    assert.throws(function () { scope.register({ name: 'x', ops: [] }); }, TypeError);
  });

  it('rejects op codes in reserved blocks 0x00 and 0x0F', function () {
    const scope = createScope({ clock: fixedClock(0) });
    assert.throws(function () {
      scope.register({ name: 'x', ops: [{ code: 0x0000, name: 'v', kind: 0 }] });
    }, RangeError);
    assert.throws(function () {
      scope.register({ name: 'x', ops: [{ code: 0x0042, name: 'v', kind: 0 }] });
    }, RangeError);
    assert.throws(function () {
      scope.register({ name: 'x', ops: [{ code: 0x0F00, name: 'v', kind: 0 }] });
    }, RangeError);
  });

  it('rejects duplicate op codes, bad kinds, bad widths, non-u16 codes', function () {
    const scope = createScope({ clock: fixedClock(0) });
    assert.throws(function () {
      scope.register({ name: 'x', ops: [opInstant(0x0100), opInstant(0x0100)] });
    }, RangeError);
    assert.throws(function () {
      scope.register({ name: 'x', ops: [{ code: 0x0100, name: 'v', kind: 4 }] });
    }, RangeError);
    assert.throws(function () {
      scope.register({ name: 'x', ops: [{ code: 0x0100, name: 'v', kind: 0, width: MAX_WIDTH + 1 }] });
    }, RangeError);
    assert.throws(function () {
      scope.register({ name: 'x', ops: [{ code: 0x10000, name: 'v', kind: 0 }] });
    }, RangeError);
  });

  it('kind constants are 0..3', function () {
    assert.deepEqual([KIND_LEVEL, KIND_INSTANT, KIND_SPAN, KIND_COUNTER], [0, 1, 2, 3]);
  });
});

describe('scope: channel writes', function () {
  it('write emits [packed, t, a, b] on the assigned stream', function () {
    const s = createMemorySink(8);
    const scope = createScope({ sink: s, clock: fixedClock(0), epochWallMs: 0 });
    const ch = scope.register({ name: 'gc', ops: [{ code: 0x0200, name: 'scavenge', kind: KIND_INSTANT }] });
    s.clear();
    ch.write(0x0200, 5, 1, 2);
    assert.deepEqual(collect(s), [[pack(ch.id, 0x0200), 5, 1, 2]]);
  });

  it('cont emits an OP_CONT record carrying the channel stream id', function () {
    const s = createMemorySink(8);
    const scope = createScope({ sink: s, clock: fixedClock(0), epochWallMs: 0 });
    const ch = scope.register({ name: 't', ops: [{ code: 0x0101, name: 'w', kind: KIND_SPAN, width: 2 }] });
    s.clear();
    ch.write(0x0101, 1, 2, 3);
    ch.cont(4, 5, 6);
    const rows = collect(s);
    assert.deepEqual(rows[1], [pack(ch.id, OP_CONT), 4, 5, 6]);
  });

  it('metaWrite emits on stream 0', function () {
    const s = createMemorySink(8);
    const scope = createScope({ sink: s, clock: fixedClock(0), epochWallMs: 0 });
    s.clear();
    scope.metaWrite(OP_GATE_VERDICT, 7, 3, 1);
    assert.deepEqual(collect(s), [[pack(META_STREAM, OP_GATE_VERDICT), 7, 3, 1]]);
  });

  it('reserved meta opcodes hold their frozen values', function () {
    assert.deepEqual([OP_VOID, OP_EPOCH, OP_CONT, OP_CLOCK_SYNC, OP_GATE_VERDICT],
      [0x0000, 0x0F00, 0x0F01, 0x0F02, 0x0F40]);
  });
});

describe('scope: widthOf', function () {
  it('returns registered width, 1 for unknown, 1 for meta block', function () {
    const scope = createScope({ clock: fixedClock(0) });
    const ch = scope.register({ name: 't', ops: [{ code: 0x0101, name: 'w', kind: KIND_SPAN, width: 3 }] });
    assert.equal(scope.widthOf(pack(ch.id, 0x0101)), 3);
    assert.equal(scope.widthOf(pack(ch.id, 0x0102)), 1);
    assert.equal(scope.widthOf(pack(META_STREAM, OP_EPOCH)), 1);
    assert.equal(scope.widthOf(pack(9, OP_GATE_VERDICT)), 1);
  });
});

describe('readSlab', function () {
  it('groups a full CONT chain into one payload', function () {
    const s = createMemorySink(8);
    const scope = createScope({ sink: s, clock: fixedClock(0), epochWallMs: 0 });
    const ch = scope.register({ name: 't', ops: [{ code: 0x0101, name: 'w', kind: KIND_SPAN, width: 3 }] });
    s.clear();
    ch.write(0x0101, 10, 1, 2);
    ch.cont(3, 4, 5);
    ch.cont(6, 7, 8);
    const out = [];
    readSlab(s.toSlab(), scope.widthOf, function (p, t, payload, count) {
      out.push([p, t, Array.from(payload.subarray(0, count))]);
    });
    assert.deepEqual(out, [[pack(ch.id, 0x0101), 10, [1, 2, 3, 4, 5, 6, 7, 8]]]);
    assert.equal(MAX_PAYLOAD, 8);
  });

  it('skips leading orphan CONTs (torn chain after wrap)', function () {
    const s = createMemorySink(4);
    s.write(pack(1, 0x0101), 10, 1, 2);
    s.write(pack(1, OP_CONT), 3, 4, 5);
    s.write(pack(1, OP_CONT), 6, 7, 8);
    s.write(pack(1, 0x0100), 20, 0, 0);
    s.write(pack(1, 0x0100), 30, 0, 0); // overwrites the base
    const out = [];
    readSlab(s.toSlab(), function () { return 1; }, function (p, t) { out.push(t); });
    assert.deepEqual(out, [20, 30]);
  });

  it('skips VOID slots and mid-stream orphan CONTs', function () {
    const slab = new Float64Array(3 * SLOTS);
    slab.set([pack(1, 0x0100), 1, 0, 0], 0);
    slab.set([OP_VOID, 0, 0, 0], SLOTS); // zeroed slot
    slab.set([pack(1, OP_CONT), 9, 9, 9], 2 * SLOTS); // orphan: base declared width 1
    const out = [];
    readSlab(slab, function () { return 1; }, function (p, t) { out.push(t); });
    assert.deepEqual(out, [1]);
  });

  it('stops a chain on stream-id mismatch and delivers the truncated payload', function () {
    const slab = new Float64Array(2 * SLOTS);
    slab.set([pack(1, 0x0101), 10, 1, 2], 0);
    slab.set([pack(2, OP_CONT), 3, 4, 5], SLOTS); // different stream: not ours
    const seen = [];
    readSlab(slab, function (p) { return (p & 0xFFFF) === 0x0101 ? 3 : 1; }, function (p, t, payload, count) {
      seen.push([p >>> 16, count]);
    });
    // The base is delivered truncated (2 payload slots); the foreign-stream
    // CONT is a mid-stream orphan and is skipped, per the torn-chain rules.
    assert.deepEqual(seen, [[1, 2]]);
  });

  it('delivers a chain truncated by the slab end', function () {
    const slab = new Float64Array(2 * SLOTS);
    slab.set([pack(1, 0x0101), 10, 1, 2], 0);
    slab.set([pack(1, OP_CONT), 3, 4, 5], SLOTS);
    const out = [];
    readSlab(slab, function () { return 3; }, function (p, t, payload, count) {
      out.push(Array.from(payload.subarray(0, count)));
    });
    assert.deepEqual(out, [[1, 2, 3, 4, 5]]);
  });
});

describe('golden vectors (vectors.json is normative)', function () {
  it('generator reproduces the committed vectors byte-for-byte', function () {
    assert.deepEqual(buildVectors(), VECTORS);
  });

  it('packing vectors round-trip through this implementation', function () {
    for (const c of VECTORS.cases.packing) {
      assert.equal(pack(c.stream, c.op), c.packed);
      assert.equal(streamOf(c.packed), c.stream);
      assert.equal(opOf(c.packed), c.op);
    }
  });

  it('checksum vector matches the hardcoded constant', function () {
    assert.equal(VECTORS.layoutChecksum, LAYOUT_CHECKSUM);
    assert.equal(VECTORS.cases.checksum.fnv1a32, LAYOUT_CHECKSUM);
    assert.equal(VECTORS.layoutId, LAYOUT_ID);
  });

  it('epoch vector matches a fresh scope emission', function () {
    const s = createMemorySink(4);
    createScope({ sink: s, clock: fixedClock(0), epochWallMs: VECTORS.cases.epoch.epochWallMs });
    assert.deepEqual(Array.from(s.toSlab()), VECTORS.cases.epoch.record);
  });

  it('torn-chain vector decodes to the expected records', function () {
    const slab = Float64Array.from(VECTORS.cases.tornChain.slab);
    const out = [];
    readSlab(slab, function (p) { return (p & 0xFFFF) === 0x0101 ? 3 : 1; }, function (p, t, payload, count) {
      out.push({ packed: p, t: t, payload: Array.from(payload.subarray(0, count)) });
    });
    assert.deepEqual(out, VECTORS.cases.tornChain.decoded);
  });
});

describe('source discipline', function () {
  it('shipped sources are ASCII-only', function () {
    for (const f of ['../Scope.js', '../Scope.d.ts', '../gen-vectors.mjs', './Scope.test.mjs']) {
      const text = readFileSync(new URL(f, import.meta.url), 'utf8');
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        assert.ok(c < 128 || c === 0x00D7 || c === 0x00B5, f + ': non-ASCII at index ' + i);
      }
    }
  });

  it('no console/debugger/TODO in shipped source', function () {
    const text = readFileSync(new URL('../Scope.js', import.meta.url), 'utf8');
    assert.ok(!/console\.|debugger|TODO/.test(text));
  });

  it('package.json holds the ecosystem conventions', function () {
    assert.equal(PKG.sideEffects, false);
    assert.equal(PKG.license, 'MIT');
    assert.equal(PKG.type, 'module');
    assert.deepEqual(Object.keys(PKG.exports['.']), ['types', 'node', 'import', 'default']);
    for (const f of ['CHANGELOG.md', 'llms.txt', 'README.md', 'LICENSE']) {
      assert.ok(PKG.files.includes(f), 'files[] missing ' + f);
    }
    assert.ok(PKG.files.includes('PROTOCOL.md'), 'files[] missing PROTOCOL.md (vendoring source)');
    assert.ok(PKG.files.includes('vectors.json'), 'files[] missing vectors.json (vendoring source)');
  });
});
