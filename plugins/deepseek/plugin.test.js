import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

function setEnv(ctx, envValues) {
  ctx.host.env.get.mockImplementation((name) =>
    Object.prototype.hasOwnProperty.call(envValues, name) ? envValues[name] : null
  )
}

function successPayload(remaining) {
  return {
    is_available: true,
    balance_infos: [
      {
        currency: "USD",
        total_balance: String(remaining),
        granted_balance: "0.00",
        topped_up_balance: String(remaining),
      },
    ],
  }
}

describe("deepseek plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("throws when API key is missing", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_PERIOD_INIT: "120", DEEPSEEK_PERIOD_LIMIT: "20", DEEPSEEK_OVERALL_BALANCE: "200" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("DeepSeek API key missing")
  })

  it("throws when period init is missing", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_PERIOD_LIMIT: "20", DEEPSEEK_OVERALL_BALANCE: "200" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("DEEPSEEK_PERIOD_INIT")
  })

  it("throws when period limit is missing", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_PERIOD_INIT: "120", DEEPSEEK_OVERALL_BALANCE: "200" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("DEEPSEEK_PERIOD_LIMIT")
  })

  it("throws when overall balance is missing", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_PERIOD_INIT: "120", DEEPSEEK_PERIOD_LIMIT: "20" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("DEEPSEEK_OVERALL_BALANCE")
  })

  it("throws when period limit exceeds period init", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_PERIOD_INIT: "20",
      DEEPSEEK_PERIOD_LIMIT: "100",
      DEEPSEEK_OVERALL_BALANCE: "200",
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("cannot exceed")
  })

  // ----- ok state: remaining = 110, used = 10 (under limit of 20) -----
  it("renders ok state with no status badge when under limit", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_PERIOD_INIT: "120",
      DEEPSEEK_PERIOD_LIMIT: "20",
      DEEPSEEK_OVERALL_BALANCE: "200",
    })
    ctx.util.request = vi.fn(() => ({ status: 200, bodyText: JSON.stringify(successPayload(110)) }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines).toHaveLength(2) // Period + Overall, no badge
    expect(result.lines.map((l) => l.label)).toEqual(["Period", "Overall"])

    const period = result.lines.find((l) => l.label === "Period")
    expect(period.used).toBeCloseTo(10, 2)
    expect(period.limit).toBe(20)
    expect(period.color).toBeUndefined()
  })

  // ----- warning state: remaining = 95, used = 25 (over 20 by ≤ 10%) -----
  it("emits warning badge when used exceeds period limit by ≤ 10%", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_PERIOD_INIT: "120",
      DEEPSEEK_PERIOD_LIMIT: "20",
      DEEPSEEK_OVERALL_BALANCE: "200",
    })
    // remaining = 95 → used = 25 → exceeds 20 by 5 (25% of 20) → still warning
    // (warning threshold is 20 * 1.1 = 22)
    ctx.util.request = vi.fn(() => ({ status: 200, bodyText: JSON.stringify(successPayload(95)) }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const period = result.lines.find((l) => l.label === "Period")
    expect(period.color).toBe("#f59e0b")

    const badge = result.lines.find((l) => l.type === "badge")
    expect(badge).toBeTruthy()
    expect(badge.text).toBe("Period limit reached")
    expect(badge.color).toBe("#f59e0b")
  })

  // ----- error state: remaining = 90, used = 30 (over 20 by 50%) -----
  it("emits error badge when used exceeds period limit by > 10%", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_PERIOD_INIT: "120",
      DEEPSEEK_PERIOD_LIMIT: "20",
      DEEPSEEK_OVERALL_BALANCE: "200",
    })
    // remaining = 90 → used = 30 → exceeds 20 by 10 (50% of 20) → error
    ctx.util.request = vi.fn(() => ({ status: 200, bodyText: JSON.stringify(successPayload(90)) }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const period = result.lines.find((l) => l.label === "Period")
    expect(period.color).toBe("#ef4444")

    const badge = result.lines.find((l) => l.type === "badge")
    expect(badge.text).toBe("Period limit exceeded")
    expect(badge.color).toBe("#ef4444")
  })

  // ----- exact warning boundary: used = 20 + 1 (just over) -----
  it("treats used = period_limit as warning threshold", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_PERIOD_INIT: "120",
      DEEPSEEK_PERIOD_LIMIT: "20",
      DEEPSEEK_OVERALL_BALANCE: "200",
    })
    // remaining = 100 → used = 20 (= limit) → "ok" (per classify logic, > not >=)
    ctx.util.request = vi.fn(() => ({ status: 200, bodyText: JSON.stringify(successPayload(100)) }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines).toHaveLength(2) // no badge
  })

  // ----- exact error boundary: used = 22 (limit + 10%) -----
  it("treats used = period_limit * 1.1 as warning (boundary, not error)", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_PERIOD_INIT: "120",
      DEEPSEEK_PERIOD_LIMIT: "20",
      DEEPSEEK_OVERALL_BALANCE: "200",
    })
    // remaining = 98 → used = 22 (= limit * 1.1) → still warning
    ctx.util.request = vi.fn(() => ({ status: 200, bodyText: JSON.stringify(successPayload(98)) }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const badge = result.lines.find((l) => l.type === "badge")
    expect(badge.text).toBe("Period limit reached")
  })

  // ----- CNY currency -----
  it("uses CNY ¥ symbol throughout", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_PERIOD_INIT: "120",
      DEEPSEEK_PERIOD_LIMIT: "20",
      DEEPSEEK_OVERALL_BALANCE: "200",
    })
    const payload = {
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "110.00", granted_balance: "0.00", topped_up_balance: "110.00" },
      ],
    }
    ctx.util.request = vi.fn(() => ({ status: 200, bodyText: JSON.stringify(payload) }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("CNY")
    expect(result.lines[0].format.currency).toBe("¥")
    expect(result.lines[1].format.currency).toBe("¥")
  })

  // ----- error path: no USD/CNY balance -----
  it("throws when no USD or CNY balance present", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_PERIOD_INIT: "120",
      DEEPSEEK_PERIOD_LIMIT: "20",
      DEEPSEEK_OVERALL_BALANCE: "200",
    })
    const payload = {
      is_available: true,
      balance_infos: [
        { currency: "EUR", total_balance: "20.00", granted_balance: "0.00", topped_up_balance: "20.00" },
      ],
    }
    ctx.util.request = vi.fn(() => ({ status: 200, bodyText: JSON.stringify(payload) }))

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Could not find USD or CNY balance")
  })

  // ----- error path: auth -----
  it("handles auth error (401)", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {
      DEEPSEEK_API_KEY: "sk-bad",
      DEEPSEEK_PERIOD_INIT: "120",
      DEEPSEEK_PERIOD_LIMIT: "20",
      DEEPSEEK_OVERALL_BALANCE: "200",
    })
    ctx.util.request = vi.fn(() => ({ status: 401, bodyText: "Unauthorized" }))
    ctx.util.isAuthStatus = vi.fn((s) => s === 401 || s === 403)

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Session expired")
  })
})
