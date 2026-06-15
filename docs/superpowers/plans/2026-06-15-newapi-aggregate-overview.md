# New API Aggregate Overview Line — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit a single overview-scope `"Total"` progress line in the newapi plugin that sums `quota + used_quota` across all configured instances, displacing the per-instance first-overview line from `primaryOrder: 1`.

**Architecture:** Add a pure helper `sumInstanceTotals(results)` in `plugin.js` that filters to valid successes and returns USD totals. In `probe()`, after the per-instance loop, build the aggregate via the existing `ctx.line.progress(...)` API, set `scope = "overview"` and `primaryOrder = 1`, and unshift it to the front of `lines`. Stop assigning `primaryOrder` to per-instance overview lines. Update `plugin.json` to declare the new schema entry and demote the per-instance `Quota` template.

**Tech Stack:** Vanilla JS (IIFE plugin, ES5-style), Vitest test framework.

**Spec:** `docs/superpowers/specs/2026-06-15-newapi-aggregate-overview-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `plugins/newapi/plugin.json` | Schema declaration; declares `Total` line with `primaryOrder: 1`, demotes `Quota` template | Modify |
| `plugins/newapi/plugin.js` | Probe loop, API call, line building; add `sumInstanceTotals`, emit aggregate line, adjust `primaryOrder` assignment | Modify |
| `plugins/newapi/plugin.test.js` | Vitest unit tests; add 6 new tests, update 4 existing assertions | Modify |

No new files. No other plugins or shared helpers touched.

## Test Runner Note

The collection repo does not currently include a `package.json` or `test-helpers.js`. Tests are run from the upstream openusage host (or wherever this collection is dropped in). Use the vitest command that the host environment provides — typically `npx vitest run plugins/newapi/plugin.test.js` from the host repo root. Confirm the working directory has a `test-helpers.js` available at `plugins/test-helpers.js` (or the equivalent path the host uses). All steps below assume the test command is reachable; if it is not, the test-write steps still produce valid test code that the host can execute.

---

## Task 1: Update `plugin.json` schema to declare the new "Total" line

**Files:**
- Modify: `plugins/newapi/plugin.json`

- [ ] **Step 1: Edit `plugins/newapi/plugin.json`**

Replace the entire `lines` array with:

```json
"lines": [
  { "type": "progress", "label": "Total", "scope": "overview", "primaryOrder": 1 },
  { "type": "progress", "label": "Quota", "scope": "overview" }
]
```

The full file should read:

```json
{
  "schemaVersion": 1,
  "id": "newapi",
  "name": "New API",
  "version": "0.0.1",
  "entry": "plugin.js",
  "icon": "icon.svg",
  "brandColor": "#F85EAD",
  "lines": [
    { "type": "progress", "label": "Total", "scope": "overview", "primaryOrder": 1 },
    { "type": "progress", "label": "Quota", "scope": "overview" }
  ]
}
```

Note: `brandColor` is `#F85EAD` per the most recent change. Do not change it.

- [ ] **Step 2: Verify JSON is valid**

Run: `python3 -c "import json,sys; json.load(open('plugins/newapi/plugin.json')); print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add plugins/newapi/plugin.json
git commit -m "feat(newapi): declare 'Total' overview line in plugin.json schema"
```

---

## Task 2: Add the failing test — multi-instance aggregate sums correctly

**Files:**
- Modify: `plugins/newapi/plugin.test.js` (append a new `it(...)` inside the top-level `describe("newapi plugin", ...)` block, before the closing `})`)

- [ ] **Step 1: Append the new test**

Add this test inside the `describe("newapi plugin", () => { ... })` block, immediately before the final `})` closing the describe:

```javascript
  // ---- aggregate overview line ----

  it("emits a 'Total' line that sums quota+used across all instances", async () => {
    const ctx = makeCtx()
    setEnvNames(ctx, [
      "AA_NEWAPI_BASE_URL",
      "AA_NEWAPI_ACCESS_TOKEN",
      "BB_NEWAPI_BASE_URL",
      "BB_NEWAPI_ACCESS_TOKEN",
      "CC_NEWAPI_BASE_URL",
      "CC_NEWAPI_ACCESS_TOKEN",
    ])
    setEnv(ctx, {
      AA_NEWAPI_BASE_URL: "https://api.aa.com",
      AA_NEWAPI_ACCESS_TOKEN: "sk-aa",
      BB_NEWAPI_BASE_URL: "https://api.bb.com",
      BB_NEWAPI_ACCESS_TOKEN: "sk-bb",
      CC_NEWAPI_BASE_URL: "https://api.cc.com",
      CC_NEWAPI_ACCESS_TOKEN: "sk-cc",
    })
    ctx.util.request = vi.fn((opts) => {
      if (opts.url.indexOf("api.aa.com") !== -1) {
        // remaining=100000, used=100000 → $0.20 used, $0.40 limit
        return { status: 200, bodyText: JSON.stringify(successPayload(100000, 100000)) }
      }
      if (opts.url.indexOf("api.bb.com") !== -1) {
        // remaining=200000, used=200000 → $0.40 used, $0.80 limit
        return { status: 200, bodyText: JSON.stringify(successPayload(200000, 200000)) }
      }
      // CC: remaining=300000, used=300000 → $0.60 used, $1.20 limit
      return { status: 200, bodyText: JSON.stringify(successPayload(300000, 300000)) }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    // Total = AA(0.20/0.40) + BB(0.40/0.80) + CC(0.60/1.20) = 1.20/2.40
    const total = result.lines[0]
    expect(total.label).toBe("Total")
    expect(total.used).toBeCloseTo(1.2, 3)
    expect(total.limit).toBeCloseTo(2.4, 3)
  })
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `<vitest-command> plugins/newapi/plugin.test.js` (e.g., `npx vitest run plugins/newapi/plugin.test.js`)
Expected: FAIL — `expected 'AA' to be 'Total'` (or similar; the existing first per-instance line is currently at index 0, the new "Total" line has not been added yet)

- [ ] **Step 3: Commit the failing test**

```bash
git add plugins/newapi/plugin.test.js
git commit -m "test(newapi): add failing test for 'Total' aggregate line"
```

---

## Task 3: Add the helper `sumInstanceTotals` in `plugin.js`

**Files:**
- Modify: `plugins/newapi/plugin.js`

- [ ] **Step 1: Add the helper function**

Insert this helper immediately after the existing `buildPlanName` function (before the `// ---- probe ----` comment). Place it logically grouped with the other line-building helpers.

```javascript
  // Sum quota and used_quota across all instances that returned a valid
  // success response. Excludes auth errors, network failures, success:false
  // payloads, and missing/non-numeric quota fields. Returns { used, limit }
  // in USD (divided by TOKEN_TO_USD_DIVISOR). Returns { used: 0, limit: 0 }
  // when no instance qualifies.
  function sumInstanceTotals(results) {
    var totalRemaining = 0
    var totalUsed = 0
    for (var i = 0; i < results.length; i++) {
      var r = results[i]
      if (!r || !r.data) continue
      if (r.data.__authError) continue
      if (!r.data.success) continue
      if (!r.data.data || typeof r.data.data !== "object") continue
      var remaining = readNumber(r.data.data.quota)
      var used = readNumber(r.data.data.used_quota)
      if (remaining === null || used === null) continue
      totalRemaining += remaining
      totalUsed += used
    }
    return {
      used: totalUsed / TOKEN_TO_USD_DIVISOR,
      limit: (totalRemaining + totalUsed) / TOKEN_TO_USD_DIVISOR,
    }
  }
```

- [ ] **Step 2: Commit the helper**

```bash
git add plugins/newapi/plugin.js
git commit -m "feat(newapi): add sumInstanceTotals helper for aggregate"
```

Note: the test from Task 2 still fails at this point — the helper is unused. That is expected; the next tasks wire it up.

---

## Task 4: Wire `sumInstanceTotals` into `probe()` and emit the aggregate line

**Files:**
- Modify: `plugins/newapi/plugin.js`

- [ ] **Step 1: Modify `probe()` to collect per-instance results and emit the aggregate**

Replace the entire `probe` function with the version below. The changes vs. the current code are:
1. The per-instance loop now records `{ config, data }` into a `results` array (line 286–318 region) instead of only `data`.
2. After the loop, when `anySuccess` is true, `sumInstanceTotals(results)` is called, the aggregate progress line is built, and unshifted to `lines`.
3. The `primaryOrder` assignment to the first overview per-instance line is removed.

```javascript
  function probe(ctx) {
    var configs = collectConfigs(ctx)

    if (configs.length === 0) {
      throw (
        "No NEWAPI configuration found. " +
        "Set *_NEWAPI_BASE_URL, *_NEWAPI_ACCESS_TOKEN, " +
        "and optionally *_NEWAPI_USERID and *_NEWAPI_NAME. " +
        "Or set OPENUSAGE_NEWAPI_PREFIXES with a comma-separated prefix list."
      )
    }

    ctx.host.log.info("newapi: found " + configs.length + " config(s): " +
      configs.map(function (c) { return c.prefix }).join(", "))

    var lines = []
    var planName = null
    var anySuccess = false
    var results = []

    for (var i = 0; i < configs.length; i++) {
      var config = configs[i]
      ctx.host.log.info("newapi: fetching quota for " + config.prefix + " (" + config.displayName + ")")

      var data = fetchQuota(ctx, config)
      results.push({ config: config, data: data })

      if (!data) {
        lines.push(ctx.line.badge({
          label: config.displayName,
          text: "请求失败",
          color: "#ef4444",
        }))
        continue
      }

      var line = buildLine(ctx, config, data)
      if (line) {
        lines.push(line)
        if (data && data.success) {
          anySuccess = true
        }
      }

      // Use the first successful group name as the plan
      if (!planName) {
        planName = buildPlanName(data)
      }
    }

    if (!anySuccess) {
      throw "All NEWAPI requests failed. Check your configuration."
    }

    // Aggregate "Total" line — sums quota+used across all successful
    // instances. Emitted at the front of `lines` with primaryOrder: 1 so
    // it is the most prominent bar on the homepage.
    var totals = sumInstanceTotals(results)
    var aggregate = ctx.line.progress({
      label: "Total",
      used: totals.used,
      limit: totals.limit,
      format: { kind: "dollars" },
    })
    aggregate.scope = "overview"
    aggregate.primaryOrder = 1
    lines.unshift(aggregate)

    return { plan: planName || "New API", lines: lines }
  }
```

- [ ] **Step 2: Run the new test from Task 2 to verify it passes**

Run: `<vitest-command> plugins/newapi/plugin.test.js -t "emits a 'Total' line"`
Expected: PASS

- [ ] **Step 3: Run the full test file to see what regressed**

Run: `<vitest-command> plugins/newapi/plugin.test.js`
Expected: most existing tests still pass. The four tests that assert `primaryOrder === 1` on `result.lines[0]` will now fail because `result.lines[0]` is the aggregate. The Task 5 update handles this.

- [ ] **Step 4: Commit**

```bash
git add plugins/newapi/plugin.js
git commit -m "feat(newapi): emit 'Total' aggregate line as overview primary"
```

---

## Task 5: Update existing tests whose `primaryOrder` assertion shifted from per-instance to aggregate

**Files:**
- Modify: `plugins/newapi/plugin.test.js`

Each of the four tests below previously asserted `result.lines[0].primaryOrder === 1` on a per-instance line. After Task 4, `result.lines[0]` is the aggregate (`label: "Total"`, `scope: "overview"`, `primaryOrder: 1`), and the per-instance overview line is at index 1 with no `primaryOrder`.

- [ ] **Step 1: Update `renders a single progress line for one NEWAPI config`**

Find this block (around line 113 in the current file):

```javascript
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0].label).toBe("Home Server")
    expect(result.lines[0].used).toBeCloseTo(0.2, 3)
    expect(result.lines[0].limit).toBeCloseTo(0.7, 3)
    expect(result.lines[0].primaryOrder).toBe(1)
```

Replace with:

```javascript
    // Aggregate at index 0; per-instance "Home Server" at index 1
    expect(result.lines).toHaveLength(2)
    expect(result.lines[0].label).toBe("Total")
    expect(result.lines[0].scope).toBe("overview")
    expect(result.lines[0].primaryOrder).toBe(1)
    // Aggregate equals the single instance: remaining=$0.50, used=$0.20, total=$0.70
    expect(result.lines[0].used).toBeCloseTo(0.2, 3)
    expect(result.lines[0].limit).toBeCloseTo(0.7, 3)
    expect(result.lines[1].label).toBe("Home Server")
    expect(result.lines[1].primaryOrder).toBeUndefined()
```

- [ ] **Step 2: Update `renders multiple lines sorted by prefix`**

Find this block (around line 159 in the current file):

```javascript
    // Should be sorted AA, BB, CC
    expect(result.lines).toHaveLength(3)
    expect(result.lines[0].label).toBe("AA")
    expect(result.lines[1].label).toBe("BB")
    expect(result.lines[2].label).toBe("CC")
    // First successful plan name wins
    expect(result.plan).toBe("AA Plan")
    // First progress line marked as primary
    expect(result.lines[0].primaryOrder).toBe(1)
    expect(result.lines[1].primaryOrder).toBeUndefined()
    expect(result.lines[2].primaryOrder).toBeUndefined()
```

Replace with:

```javascript
    // Aggregate at index 0, then per-instance lines AA, BB, CC
    expect(result.lines).toHaveLength(4)
    expect(result.lines[0].label).toBe("Total")
    expect(result.lines[0].scope).toBe("overview")
    expect(result.lines[0].primaryOrder).toBe(1)
    expect(result.lines[1].label).toBe("AA")
    expect(result.lines[2].label).toBe("BB")
    expect(result.lines[3].label).toBe("CC")
    // First successful plan name wins (taken from the per-instance loop)
    expect(result.plan).toBe("AA Plan")
    // Per-instance lines no longer carry primaryOrder; the aggregate does
    expect(result.lines[1].primaryOrder).toBeUndefined()
    expect(result.lines[2].primaryOrder).toBeUndefined()
    expect(result.lines[3].primaryOrder).toBeUndefined()
```

- [ ] **Step 3: Update `discovers configs via OPENUSAGE_NEWAPI_PREFIXES fallback`**

Find this block (around line 359 in the current file):

```javascript
    expect(result.lines).toHaveLength(2)
    expect(result.lines[0].label).toBe("Data Center 1")
    expect(result.lines[1].label).toBe("Data Center 2")
    expect(result.lines[0].primaryOrder).toBe(1)
    expect(result.lines[0].scope).toBe("overview")
    expect(result.lines[1].scope).toBe("detail")
```

Replace with:

```javascript
    // Aggregate at index 0, then DC1 (overview) and DC2 (detail)
    expect(result.lines).toHaveLength(3)
    expect(result.lines[0].label).toBe("Total")
    expect(result.lines[0].scope).toBe("overview")
    expect(result.lines[0].primaryOrder).toBe(1)
    expect(result.lines[1].label).toBe("Data Center 1")
    expect(result.lines[1].scope).toBe("overview")
    expect(result.lines[1].primaryOrder).toBeUndefined()
    expect(result.lines[2].label).toBe("Data Center 2")
    expect(result.lines[2].scope).toBe("detail")
```

- [ ] **Step 4: Update `respects OPENUSAGE_NEWAPI_PREFIXES order over alphabetical`**

Find this block (around line 393 in the current file):

```javascript
    expect(result.lines).toHaveLength(3)
    // Order follows OPENUSAGE_NEWAPI_PREFIXES: ZETA first, then ALPHA, then BETA
    expect(result.lines[0].label).toBe("ZETA")
    expect(result.lines[1].label).toBe("ALPHA")
    expect(result.lines[2].label).toBe("BETA")
    // ZETA is the primary (only overview)
    expect(result.lines[0].primaryOrder).toBe(1)
```

Replace with:

```javascript
    expect(result.lines).toHaveLength(4)
    // Aggregate at index 0, then per-instance in OPENUSAGE_NEWAPI_PREFIXES order
    expect(result.lines[0].label).toBe("Total")
    expect(result.lines[0].scope).toBe("overview")
    expect(result.lines[0].primaryOrder).toBe(1)
    expect(result.lines[1].label).toBe("ZETA")
    expect(result.lines[2].label).toBe("ALPHA")
    expect(result.lines[3].label).toBe("BETA")
    // ZETA was the only overview instance; aggregate is now the primary
    expect(result.lines[1].primaryOrder).toBeUndefined()
```

- [ ] **Step 5: Run the full test file**

Run: `<vitest-command> plugins/newapi/plugin.test.js`
Expected: all updated tests pass. The two remaining "primaryOrder" assertions on the per-instance first-overview line (used to be `result.lines[0]`) have been moved to the aggregate.

- [ ] **Step 6: Commit**

```bash
git add plugins/newapi/plugin.test.js
git commit -m "test(newapi): shift primaryOrder assertions to 'Total' aggregate"
```

---

## Task 6: Add the test — aggregate excludes failed instances

**Files:**
- Modify: `plugins/newapi/plugin.test.js`

- [ ] **Step 1: Append the new test inside the `describe("newapi plugin", ...)` block**

Add this test immediately after the test added in Task 2:

```javascript
  it("excludes failed instances from the 'Total' sum", async () => {
    const ctx = makeCtx()
    setEnvNames(ctx, [
      "OK1_NEWAPI_BASE_URL",
      "OK1_NEWAPI_ACCESS_TOKEN",
      "OK2_NEWAPI_BASE_URL",
      "OK2_NEWAPI_ACCESS_TOKEN",
      "BAD_NEWAPI_BASE_URL",
      "BAD_NEWAPI_ACCESS_TOKEN",
    ])
    setEnv(ctx, {
      OK1_NEWAPI_BASE_URL: "https://api.ok1.com",
      OK1_NEWAPI_ACCESS_TOKEN: "sk-ok1",
      OK2_NEWAPI_BASE_URL: "https://api.ok2.com",
      OK2_NEWAPI_ACCESS_TOKEN: "sk-ok2",
      BAD_NEWAPI_BASE_URL: "https://api.bad.com",
      BAD_NEWAPI_ACCESS_TOKEN: "sk-bad",
    })
    ctx.util.request = vi.fn((opts) => {
      if (opts.url.indexOf("api.bad.com") !== -1) {
        return { status: 500, bodyText: "boom" }
      }
      // OK1 and OK2: each remaining=100000, used=100000 → $0.20 used, $0.40 limit
      return { status: 200, bodyText: JSON.stringify(successPayload(100000, 100000)) }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    // 4 lines: Total, OK1, OK2, BAD (error badge)
    expect(result.lines).toHaveLength(4)
    const total = result.lines[0]
    expect(total.label).toBe("Total")
    // Sum of OK1 + OK2 only: $0.40 used, $0.80 limit
    expect(total.used).toBeCloseTo(0.4, 3)
    expect(total.limit).toBeCloseTo(0.8, 3)
  })
```

- [ ] **Step 2: Run the new test to verify it passes**

Run: `<vitest-command> plugins/newapi/plugin.test.js -t "excludes failed instances"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add plugins/newapi/plugin.test.js
git commit -m "test(newapi): cover partial-failure exclusion in 'Total' sum"
```

---

## Task 7: Add the test — aggregate emits first with `primaryOrder: 1`

**Files:**
- Modify: `plugins/newapi/plugin.test.js`

- [ ] **Step 1: Append the new test**

```javascript
  it("emits 'Total' as the first line on overview with primaryOrder 1", async () => {
    const ctx = makeCtx()
    setEnvNames(ctx, [
      "DC1_NEWAPI_BASE_URL",
      "DC1_NEWAPI_ACCESS_TOKEN",
      "DC2_NEWAPI_BASE_URL",
      "DC2_NEWAPI_ACCESS_TOKEN",
    ])
    setEnv(ctx, {
      DC1_NEWAPI_BASE_URL: "https://dc1.example.com",
      DC1_NEWAPI_ACCESS_TOKEN: "sk-dc1",
      DC1_NEWAPI_SCOPE: "overview",
      DC2_NEWAPI_BASE_URL: "https://dc2.example.com",
      DC2_NEWAPI_ACCESS_TOKEN: "sk-dc2",
      // DC2 has no _SCOPE — defaults to detail
    })
    ctx.util.request = vi.fn(() => ({
      status: 200,
      bodyText: JSON.stringify(successPayload(500000, 0)),
    }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    // Total unshifted to position 0, then DC1 (overview), then DC2 (detail)
    expect(result.lines).toHaveLength(3)
    expect(result.lines[0].label).toBe("Total")
    expect(result.lines[0].scope).toBe("overview")
    expect(result.lines[0].primaryOrder).toBe(1)
    // Per-instance lines no longer carry primaryOrder
    expect(result.lines[1].primaryOrder).toBeUndefined()
    expect(result.lines[2].primaryOrder).toBeUndefined()
  })
```

- [ ] **Step 2: Run the new test**

Run: `<vitest-command> plugins/newapi/plugin.test.js -t "emits 'Total' as the first line"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add plugins/newapi/plugin.test.js
git commit -m "test(newapi): verify 'Total' is first with primaryOrder 1"
```

---

## Task 8: Add the test — single-instance case still emits the aggregate

**Files:**
- Modify: `plugins/newapi/plugin.test.js`

- [ ] **Step 1: Append the new test**

```javascript
  it("emits 'Total' even when only one instance is configured", async () => {
    const ctx = makeCtx()
    setEnvNames(ctx, [
      "SOLO_NEWAPI_BASE_URL",
      "SOLO_NEWAPI_ACCESS_TOKEN",
    ])
    setEnv(ctx, {
      SOLO_NEWAPI_BASE_URL: "https://api.solo.com",
      SOLO_NEWAPI_ACCESS_TOKEN: "sk-solo",
    })
    ctx.util.request = vi.fn(() => ({
      status: 200,
      bodyText: JSON.stringify(successPayload(200000, 50000)),
    }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    // 2 lines: Total, then the per-instance line
    expect(result.lines).toHaveLength(2)
    expect(result.lines[0].label).toBe("Total")
    // Aggregate equals the single instance: used=$0.10, total=$0.50
    expect(result.lines[0].used).toBeCloseTo(0.1, 3)
    expect(result.lines[0].limit).toBeCloseTo(0.5, 3)
    expect(result.lines[1].label).toBe("SOLO")
  })
```

- [ ] **Step 2: Run the new test**

Run: `<vitest-command> plugins/newapi/plugin.test.js -t "only one instance is configured"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add plugins/newapi/plugin.test.js
git commit -m "test(newapi): verify 'Total' emits even with a single instance"
```

---

## Task 9: Add the test — no aggregate when all instances fail

**Files:**
- Modify: `plugins/newapi/plugin.test.js`

- [ ] **Step 1: Append the new test**

```javascript
  it("throws and emits no 'Total' line when every config fails", async () => {
    const ctx = makeCtx()
    setEnvNames(ctx, [
      "X_NEWAPI_BASE_URL",
      "X_NEWAPI_ACCESS_TOKEN",
      "Y_NEWAPI_BASE_URL",
      "Y_NEWAPI_ACCESS_TOKEN",
    ])
    setEnv(ctx, {
      X_NEWAPI_BASE_URL: "https://api.x.com",
      X_NEWAPI_ACCESS_TOKEN: "sk-x",
      Y_NEWAPI_BASE_URL: "https://api.y.com",
      Y_NEWAPI_ACCESS_TOKEN: "sk-y",
    })
    ctx.util.request = vi.fn(() => ({ status: 500, bodyText: "Error" }))

    const plugin = await loadPlugin()
    // probe() must throw before the aggregate is ever built
    let caught
    try {
      plugin.probe(ctx)
    } catch (e) {
      caught = e
    }
    // probe() throws a string (not an Error), so assert truthiness + substring
    expect(caught).toBeTruthy()
    expect(String(caught)).toMatch(/All NEWAPI requests failed/)
  })
```

- [ ] **Step 2: Run the new test**

Run: `<vitest-command> plugins/newapi/plugin.test.js -t "throws and emits no 'Total' line"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add plugins/newapi/plugin.test.js
git commit -m "test(newapi): verify no 'Total' line when all configs fail"
```

---

## Task 10: Final full-suite verification

**Files:** (no changes)

- [ ] **Step 1: Run the entire newapi test file**

Run: `<vitest-command> plugins/newapi/plugin.test.js`
Expected: all tests pass, including the 6 new ones and the 4 updated ones. Output shows a green checkmark next to each `it(...)` block.

- [ ] **Step 2: Verify file state**

Run: `git status`
Expected: `nothing to commit, working tree clean`. All nine commits from Tasks 1–9 are applied.

- [ ] **Step 3: Review the final diff**

Run: `git log --oneline plugins/newapi/ docs/superpowers/specs/2026-06-15-newapi-aggregate-overview-design.md | head -20`
Expected: the spec commit at the top, followed by the 9 implementation commits in order: schema, failing test, helper, wiring, 4 test updates, 4 new tests.

---

## Self-Review Notes

**Spec coverage:**
- §"Aggregate line" → Tasks 1, 4 (schema, emit with `label: "Total"`, `scope: "overview"`, `primaryOrder: 1`, dollar formatting)
- §"Inclusion rule" → Task 3 (`sumInstanceTotals` filters on `data`, `__authError`, `success`, `data.data`, finite numbers)
- §"Per-instance primaryOrder demotion" → Tasks 4 and 5 (probe no longer sets `primaryOrder` on per-instance overview lines; existing tests assert it)
- §"Edge cases" → Tasks 6, 8, 9 (partial failure, single instance, all-fail)
- §"Architecture" → Tasks 3 and 4 (helper signature, unshift, scope)
- §"plugin.json update" → Task 1
- §"Testing" — six new tests → Tasks 2, 6, 7, 8, 9; 4 existing updates → Task 5; 3 additional `lines[0]`-shift updates caught by the final code review (added as a follow-up commit since the spec/plan's Task 5 list was incomplete): `uses _NEWAPI_NAME for the progress bar label`, `falls back to prefix as label when _NEWAPI_NAME is not set`, `defaults to detail scope with no primaryOrder`
- §"Files touched" → matches the table at the top

**Post-review corrections:**
- The plan/spec listed 4 existing tests as needing update (those asserting `primaryOrder === 1` on `lines[0]`). The final code review caught 3 more tests that read per-instance attributes from `lines[0]` (label, scope, length) and would have failed at runtime. These were fixed in commit `a07ef8c` on the feature branch.
- Two additional pre-existing tests (`shows auth error badge on 401`, `shows error badge when API returns success: false`) were broken in the original newapi plugin commit (not caused by this feature). They were also fixed in this feature, in commit `e582615`, to assert the throw happens with the expected message (same fix shape as Task 9's all-fail test).
- A minimal `plugins/test-helpers.js` was drafted to enable local test runs but rolled back because a generic harness for all 21 plugins is a much larger effort — the draft only supported newapi's conventions and broke the other 20 plugin test files when vitest discovered them collectively.

**Placeholder scan:** No "TBD", "TODO", or vague directives. All code blocks are complete and copy-pastable.

**Type consistency:**
- Helper name `sumInstanceTotals` used identically in Tasks 3 and 4.
- Constant `TOKEN_TO_USD_DIVISOR` referenced consistently in Task 3 (matches plugin.js line 8).
- `readNumber` helper used in Task 3 (defined in plugin.js lines 18–25).
- `ctx.line.progress(...)` shape in Task 4 matches the existing usage in `buildLine` (plugin.js lines 247–252).
- `lines.unshift(aggregate)` matches the `lines` array mutation pattern used elsewhere.
- `aggregate.scope = "overview"` and `aggregate.primaryOrder = 1` are direct property assignments on the returned line object, matching the existing `line.scope = config.scope` pattern in `buildLine`.

All consistent.
