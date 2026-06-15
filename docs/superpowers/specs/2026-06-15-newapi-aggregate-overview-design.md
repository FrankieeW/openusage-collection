# New API — Aggregate Overview Line

**Date:** 2026-06-15
**Status:** Approved (brainstorming → spec)
**Plugin:** `plugins/newapi/`
**Schema version:** 1

## Goal

Add a single overview-scope progress line, labeled **"Total"**, that sums
`quota + used_quota` across all configured New API instances and displays
the aggregate on the homepage (主页). The aggregate becomes the new
`primaryOrder: 1` bar; existing per-instance behavior is preserved.

## Motivation

The current `newapi` plugin produces one progress line per configured
instance (`*_NEWAPI_BASE_URL`, …). The first overview-scope instance
inherits `primaryOrder: 1`, so the homepage surfaces only one instance's
quota. Users with multiple New API servers have no single-glance view of
their combined remaining/used quota.

## Design

### Aggregate line

A new progress line is emitted by `probe()`:

| Property        | Value                          |
|-----------------|--------------------------------|
| Type            | `progress`                     |
| Label           | `"Total"`                      |
| Scope           | `"overview"` (主页 only)        |
| `primaryOrder`  | `1`                            |
| `used` (USD)    | `Σ used_quota / 500000`        |
| `limit` (USD)   | `Σ (quota + used_quota) / 500000` |
| `format`        | `{ kind: "dollars" }`          |

The aggregate is computed only from instances that returned a valid
success response (see *Inclusion rule* below). It is emitted at the
front of the `lines` array so it renders first on the homepage.

### Inclusion rule

An instance contributes to the aggregate iff **all** of the following
hold:

- `data` is truthy.
- `data.__authError` is falsy.
- `data.success === true`.
- `data.data` is an object.
- `readNumber(data.data.quota)` and `readNumber(data.data.used_quota)`
  both return finite numbers.

Auth errors, network failures, HTTP non-2xx, `success: false`, malformed
JSON, and missing/non-numeric quota fields are **all excluded** from
the sum. The corresponding per-instance error badge continues to be
emitted unchanged.

### Per-instance primaryOrder demotion

Previously, the loop in `probe()` set `line.primaryOrder = 1` on the
first overview-scope instance line. After this change, the aggregate
holds `primaryOrder = 1` and **per-instance overview lines get no
`primaryOrder`**. Per-instance detail lines are unaffected.

### Edge cases

| Scenario                                  | Behavior                                                    |
|-------------------------------------------|-------------------------------------------------------------|
| All instances fail                        | `probe()` throws "All NEWAPI requests failed" (unchanged). Aggregate is not emitted. |
| Some succeed, some fail                   | Aggregate sums the successful subset; failed instances show their existing badge. |
| Exactly one successful instance           | Aggregate is still emitted with values equal to that instance's bar. |
| All successful instances have 0 quota     | Aggregate emits `used=0, limit=0` (matches per-instance zero handling). |
| All instances return `success: false`     | Unreachable in practice: `anySuccess` guard throws first.   |

### Architecture

In `plugins/newapi/plugin.js`:

- **New helper `sumInstanceTotals(results)`** — pure function. Input:
  array of `{ config, data }` from the per-instance loop. Output:
  `{ used, limit }` in USD, summed only over instances matching the
  inclusion rule. Returns `{ used: 0, limit: 0 }` when no instance
  qualifies.
- **`buildLine()`** — unchanged.
- **`probe()`** — after the per-instance loop:
  1. Call `sumInstanceTotals(results)`.
  2. If `anySuccess`, build the aggregate line via
     `ctx.line.progress({ label: "Total", used, limit, format: { kind: "dollars" } })`,
     set `scope = "overview"` and `primaryOrder = 1`, **unshift** it
     to position 0 of `lines`.
  3. Stop setting `primaryOrder` on per-instance overview lines.

### `plugin.json` update

```json
"lines": [
  { "type": "progress", "label": "Total", "scope": "overview", "primaryOrder": 1 },
  { "type": "progress", "label": "Quota", "scope": "overview" }
]
```

`Quota` remains as the per-instance template: each instance emits one
progress line with a dynamic label (e.g., `"Home"`, `"Work"`) and
`scope = config.scope` (from `_NEWAPI_SCOPE`). `primaryOrder: 1` moves
from `Quota` to `Total` in the schema.

## Testing

Six new tests in `plugins/newapi/plugin.test.js`:

1. **Multi-instance aggregate sums correctly** — three instances with
   distinct quotas; expect `Total.used` and `Total.limit` to equal the
   element-wise sum.
2. **Aggregate appears first on overview with `primaryOrder: 1`** —
   verify `result.lines[0].label === "Total"`, `scope === "overview"`,
   `primaryOrder === 1`.
3. **Aggregate excludes failed instances** — two success + one auth
   error; expect the aggregate to equal the sum of the two successful
   only.
4. **Aggregate still emits with a single instance** — one config only;
   expect `result.lines` to start with the aggregate followed by the
   per-instance line.
5. **Per-instance overview lines no longer carry `primaryOrder`** —
   regression test for the demotion.
6. **Aggregate never emits when all configs fail** — in a new test
   with every request returning HTTP 500, assert that `probe()` throws
   and that no emitted line has `label === "Total"`. **Note on
   assertion shape:** `probe()` throws a raw string (e.g.,
   `throw "All NEWAPI requests failed. Check your configuration."`),
   not an `Error` instance. The test therefore asserts
   `expect(caught).toBeTruthy()` plus
   `expect(String(caught)).toMatch(/All NEWAPI requests failed/)`,
   not `expect(caught).toBeInstanceOf(Error)`.

All existing tests must continue to pass. The following four existing
assertions must be updated to reflect the new ordering:

- `renders a single progress line for one NEWAPI config` —
  `result.lines[0].primaryOrder === 1` now refers to the aggregate
  (label `"Total"`); the per-instance line at index 1 has
  `primaryOrder === undefined`.
- `renders multiple lines sorted by prefix` — same shift; AA
  per-instance line at index 1 has no `primaryOrder`.
- `discovers configs via OPENUSAGE_NEWAPI_PREFIXES fallback` — DC1
  per-instance line at index 1 has no `primaryOrder`.
- `respects OPENUSAGE_NEWAPI_PREFIXES order over alphabetical` — ZETA
  per-instance line at index 1 has no `primaryOrder`.

In addition, three more pre-existing tests read per-instance
attributes from `result.lines[0]` without asserting `primaryOrder`.
They break for the same `lines[0]` shift reason and were caught by
the final code review (not by the spec's list of 4 above):

- `uses _NEWAPI_NAME for the progress bar label` — the per-instance
  label is now at `lines[1]`, not `lines[0]`.
- `falls back to prefix as label when _NEWAPI_NAME is not set` — same
  shift, per-instance label at `lines[1]`.
- `defaults to detail scope with no primaryOrder` — `length` is 2
  (aggregate + per-instance), not 1; per-instance `scope` and
  `primaryOrder` are at `lines[1]`.

Out of scope: two pre-existing tests (`shows auth error badge on
401`, `shows error badge when API returns success: false`) were
broken in the original newapi plugin commit — they expected
`result.lines` to be populated, but `probe()` throws before
returning when the only configured instance fails (the `anySuccess`
guard has been there since the original commit). **Resolved
during implementation (commit `e582615`):** both tests updated to
assert the throw happens with the expected message, matching the
actual `probe()` behavior. Same fix shape as the Task 9 test.

**Test-helpers.js note:** A minimal `plugins/test-helpers.js` was
drafted during the final review to enable local test runs of the
newapi suite (the collection repo has no test harness; the upstream
openusage host provides its own). It was rolled back because a
generic harness for all 21 plugins is a much larger effort — the
draft only supported newapi's conventions and broke the other 20
plugin test files when vitest discovered them. Running newapi
tests still requires the upstream host's harness.

The four updated tests must also assert that the line at index 0 has
`label === "Total"` and `scope === "overview"`.

## Files touched

- `plugins/newapi/plugin.json` — schema update.
- `plugins/newapi/plugin.js` — add `sumInstanceTotals`, emit aggregate,
  adjust `primaryOrder` logic.
- `plugins/newapi/plugin.test.js` — six new tests + targeted updates
  to two existing assertions.

No changes to other plugins, `README.md`, or shared test helpers.

## Out of scope

- Emitting the aggregate on the detail scope (kept off-spec per the
  user's emphasis on homepage only).
- A subtitle showing instance counts (user explicitly declined).
- Hiding the aggregate when only one instance is configured (user
  explicitly chose "always show").
- Replacing per-instance error badges with an aggregate error badge.
