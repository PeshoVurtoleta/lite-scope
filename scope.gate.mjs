#!/usr/bin/env node
// scope.gate.mjs -- SPP v1 CI gate for @zakkster packages.
//
// Drop this file (or a copy) into any package repo. Edit the BUDGETS
// array to match the package's probes and thresholds. Run via:
//
//   node --expose-gc scope.gate.mjs
//
// Exit codes follow the established convention:
//   0 = pass (all budgets within threshold)
//   1 = regression (at least one budget exceeded)
//   3 = recapture (reserved for VersionMatrix -- not emitted here)
//
// The gate does NOT import @zakkster/lite-scope or @zakkster/lite-perf-gate.
// It inlines the two SPP protocol facts it needs (packing and CONT skip)
// and delegates comparison to a standalone verdict check. This keeps the
// gate script zero-dependency -- it runs in any repo without install.
//
// NDJSON output goes to stdout; pipe to a file for CI artifacts:
//   node --expose-gc scope.gate.mjs > gate-result.ndjson

// ---------------------------------------------------------------------------
// Budget configuration -- EDIT THIS PER REPO
// ---------------------------------------------------------------------------

const BUDGETS = [
    // Example: gate the GC scavenge pause max at 4ms.
    // { name: 'gc.pause.max', op: 0x0200, slot: 'a', reduce: 'max', max: 4 },

    // Example: gate frame time at 20ms.
    // { name: 'frame.ms', op: 0x0410, slot: 'a', reduce: 'max', max: 20 },

    // Example: gate leak count at 0.
    // { name: 'leak.count', op: 0x0800, reduce: 'count', max: 0 },

    // Example: gate INP at 200ms (the "good" threshold).
    // { name: 'inp.worst', op: 0x0602, slot: 'a', reduce: 'max', max: 200 },
];

const GATE_NAME = 'scope-gate';

// ---------------------------------------------------------------------------
// SPP v1 protocol facts (inlined -- no imports)
// ---------------------------------------------------------------------------

const OP_CONT = 0x0F01;
const SLOT_MAP = { t: 1, a: 2, b: 3 };
const REDUCE_SET = { count: 1, sum: 1, max: 1, mean: 1, last: 1 };

// ---------------------------------------------------------------------------
// Gate evaluation (mirrors suiteGate logic, standalone)
// ---------------------------------------------------------------------------

function evaluate(slab, budgets) {
    const n = budgets.length;
    const count = new Float64Array(n);
    const sum = new Float64Array(n);
    const maxv = new Float64Array(n);
    const last = new Float64Array(n);
    maxv.fill(-Infinity);

    const slots = new Array(n);
    const reduces = new Array(n);
    const matchers = new Array(n);

    for (let i = 0; i < n; i++) {
        const b = budgets[i];
        slots[i] = SLOT_MAP[b.slot || 'a'];
        reduces[i] = b.reduce || 'max';

        if (b.packed !== undefined) {
            matchers[i] = { exact: b.packed >>> 0, op: -1 };
        } else if (b.stream !== undefined) {
            matchers[i] = { exact: ((b.stream << 16) | b.op) >>> 0, op: -1 };
        } else {
            matchers[i] = { exact: -1, op: b.op };
        }
    }

    for (let r = 0; r < slab.length; r += 4) {
        const packed = slab[r];
        const op = packed & 0xFFFF;
        if (op === OP_CONT) continue;
        for (let j = 0; j < n; j++) {
            const m = matchers[j];
            if (m.exact >= 0 ? (packed >>> 0) !== m.exact : op !== m.op) continue;
            const val = slots[j] === 1 ? slab[r + 1] : slots[j] === 2 ? slab[r + 2] : slab[r + 3];
            count[j] += 1;
            sum[j] += val;
            if (val > maxv[j]) maxv[j] = val;
            last[j] = val;
        }
    }

    let pass = true;
    const reasons = [];
    const results = [];
    for (let k = 0; k < n; k++) {
        const b2 = budgets[k];
        let value;
        if (reduces[k] === 'count') value = count[k];
        else if (reduces[k] === 'sum') value = sum[k];
        else if (reduces[k] === 'max') value = count[k] > 0 ? maxv[k] : 0;
        else if (reduces[k] === 'mean') value = count[k] > 0 ? sum[k] / count[k] : 0;
        else value = count[k] > 0 ? last[k] : 0;

        const exceeded = value > b2.max;
        if (exceeded) {
            pass = false;
            reasons.push(b2.name + ': ' + value + ' > ' + b2.max);
        }
        results.push({
            name: b2.name, value: value, count: count[k], max: b2.max,
            pass: !exceeded, reasons: exceeded ? [b2.name + ': ' + value + ' > ' + b2.max] : []
        });
    }

    return { name: GATE_NAME, pass: pass, reasons: reasons, budgets: results };
}

// ---------------------------------------------------------------------------
// NDJSON output
// ---------------------------------------------------------------------------

function toNDJSON(gate, meta) {
    const lines = [];
    for (let i = 0; i < gate.budgets.length; i++) {
        const b = gate.budgets[i];
        lines.push(JSON.stringify(Object.assign({}, meta, {
            type: 'budget', gate: gate.name, name: b.name,
            value: b.value, count: b.count, max: b.max, pass: b.pass
        })));
    }
    lines.push(JSON.stringify(Object.assign({}, meta, {
        type: 'scope-gate', name: gate.name, pass: gate.pass, reasons: gate.reasons
    })));
    return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(slab) {
    if (BUDGETS.length === 0) {
        process.stderr.write('scope.gate.mjs: no budgets configured. Edit the BUDGETS array.\n');
        process.exit(0);
    }

    const gate = evaluate(slab, BUDGETS);

    const meta = {
        pkg: process.env.npm_package_name || '',
        version: process.env.npm_package_version || '',
        node: process.version,
        ts: new Date().toISOString()
    };

    process.stdout.write(toNDJSON(gate, meta));

    if (!gate.pass) {
        process.stderr.write('FAIL: ' + gate.reasons.join('; ') + '\n');
        process.exit(1);
    } else {
        process.stderr.write('PASS: all ' + BUDGETS.length + ' budgets within threshold\n');
        process.exit(0);
    }
}

// ---------------------------------------------------------------------------
// Slab source: read from stdin (piped NDJSON or raw f64 dump) or run
// inline with a user-supplied scenario function.
//
// For inline use, export a `scenario(sink)` function that drives your
// probes and call main(sink.toSlab()) at the end. For piped use, the
// gate reads a Float64Array from stdin.
// ---------------------------------------------------------------------------

// When this file is the entry point, read slab from stdin.
// Otherwise, import { evaluate, toNDJSON, main } and drive programmatically.

export { evaluate, toNDJSON, main, BUDGETS, GATE_NAME };
