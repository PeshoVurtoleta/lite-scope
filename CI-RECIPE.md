# CI Gate Recipe

## Quick start

1. Copy `scope.gate.mjs` into your repo root.
2. Edit the `BUDGETS` array with your package's thresholds.
3. Add to `package.json` scripts:

```json
{
  "scripts": {
    "gate": "node --expose-gc scope.gate.mjs"
  }
}
```

4. In CI, run the gate and capture the NDJSON artifact:

```yaml
# .github/workflows/gate.yml
name: SPP Gate
on: [push, pull_request]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci
      - run: npm test
      - run: node --expose-gc scope.gate.mjs > gate-result.ndjson 2>&1 || true
      - run: cat gate-result.ndjson
      - uses: actions/upload-artifact@v4
        with:
          name: gate-result
          path: gate-result.ndjson
      - run: node --expose-gc scope.gate.mjs
```

The final `run` line uses the gate's exit code (0 pass / 1 fail) to
fail the CI job. The earlier `|| true` run captures the NDJSON artifact
regardless of pass/fail.

## Budget examples

```js
// GC pause budget: scavenge pauses under 4ms
{ name: 'gc.pause.max', op: 0x0200, slot: 'a', reduce: 'max', max: 4 }

// Frame time budget: no frame over 20ms
{ name: 'frame.ms', op: 0x0410, slot: 'a', reduce: 'max', max: 20 }

// Zero leaks policy
{ name: 'leak.count', op: 0x0800, reduce: 'count', max: 0 }

// INP "good" threshold
{ name: 'inp.worst', op: 0x0602, slot: 'a', reduce: 'max', max: 200 }

// Signal graph node count stays bounded
{ name: 'signal.creates', op: 0x0301, reduce: 'count', max: 10000 }

// GPU frame time budget
{ name: 'gpu.time', op: 0x0401, slot: 'a', reduce: 'max', max: 8 }

// Layout violation count stays at zero
{ name: 'layout.violations', op: 0x0502, slot: 'a', reduce: 'last', max: 0 }
```

## VersionMatrix interop

The gate script's exit codes are compatible with the VersionMatrix
convention: 0 = pass, 1 = regression. Exit code 3 (recapture) is
reserved for the VersionMatrix's own spread/span evidence logic and is
NOT emitted by scope.gate.mjs -- the matrix runner handles recapture
semantics in its aggregate layer (`aggregate.mjs`), not in per-budget
gates. This keeps the two systems composable:

- `scope.gate.mjs` gates SPP stream budgets (single version, single run)
- VersionMatrix gates cross-version performance (spread/span evidence,
  interleaved rounds, exit 3 = "this version is faster, recapture the
  baseline")

Both produce NDJSON; both can be CI artifacts; neither reimplements the
other's logic.

## Inline scenario

For packages that drive probes programmatically:

```js
import { createScope, createMemorySink } from '@zakkster/lite-scope';
import { main, BUDGETS } from './scope.gate.mjs';

BUDGETS.push({ name: 'gc.pause', op: 0x0200, slot: 'a', reduce: 'max', max: 4 });

const sink = createMemorySink(8192);
const scope = createScope({ sink });

// ... drive your probes, run your scenario ...

main(sink.toSlab());
```
