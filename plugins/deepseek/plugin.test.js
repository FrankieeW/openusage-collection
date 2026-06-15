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

  // ----- ok state: remaining (20) >= period limit (20) -----
  // Period line: used = limit - remaining = 0, limit = 20 → 0%
  it("renders ok state with no status badge when remaining is at or above the limit", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_PERIOD_INIT: "120",
      DEEPSEEK_PERIOD_LIMIT: "20",
      DEEPSEEK_OVERALL_BALANCE: "200",
    })
    ctx.util.request = vi.fn(() => ({ status: 200, bodyText: JSON.stringify(successPayload(20)) }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines).toHaveLength(2) // Period + Overall, no badge
    expect(result.lines.map((l) => l.label)).toEqual(["Period", "Overall"])

    const period = result.lines.find((l) => l.label === "Period")
    expect(period.used).toBeCloseTo(0, 2)
    expect(period.limit).toBe(20)
    expect(period.color).toBeUndefined()
  })

  // ----- period bar at 50%: remaining=10, limit=20 → used=10/20 -----
  it("scales the Period bar to the limit (used = limit - remaining)", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_PERIOD_INIT: "120",
      DEEPSEEK_PERIOD_LIMIT: "20",
      DEEPSEEK_OVERALL_BALANCE: "200",
    })
    // remaining=10 → period line: used=20-10=10, limit=20 → 50%
    // classify: init-used = 120-10 = 110 > 20 → already error
    ctx.util.request = vi.fn(() => ({ status: 200, bodyText: JSON.stringify(successPayload(10)) }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const period = result.lines.find((l) => l.label === "Period")
    expect(period.used).toBeCloseTo(10, 2)
    expect(period.limit).toBe(20)
  })

  // ----- period bar at 100% with positive remaining above zero: clamp to 100% -----
  it("clamps the Period bar to 100% when remaining reaches zero", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_PERIOD_INIT: "120",
      DEEPSEEK_PERIOD_LIMIT: "20",
      DEEPSEEK_OVERALL_BALANCE: "200",
    })
    // remaining=0 → used=20-0=20, limit=20 → 100%
    ctx.util.request = vi.fn(() => ({ status: 200, bodyText: JSON.stringify(successPayload(0)) }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const period = result.lines.find((l) => l.label === "Period")
    expect(period.used).toBeCloseTo(20, 2)
    expect(period.limit).toBe(20)
  })

  // ----- negative remaining (e.g. account charged past zero) -----
  it("clamps the Period bar to 100% when remaining is negative", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_PERIOD_INIT: "120",
      DEEPSEEK_PERIOD_LIMIT: "20",
      DEEPSEEK_OVERALL_BALANCE: "200",
    })
    // remaining=-50 → raw used=20-(-50)=70 → clamp to 20/20=100%
    ctx.util.request = vi.fn(() => ({ status: 200, bodyText: JSON.stringify(successPayload(-50)) }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const period = result.lines.find((l) => l.label === "Period")
    expect(period.used).toBeCloseTo(20, 2)
    expect(period.limit).toBe(20)
  })

  // ----- warning state: init-used just over the limit, but under 1.1x limit -----
  // Use a config where the period's used (init - remaining) crosses the warning
  // band while leaving enough slack in the period bar to be visibly partial.
  it("emits warning badge when init-used exceeds period limit by ≤ 10%", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_PERIOD_INIT: "120",
      DEEPSEEK_PERIOD_LIMIT: "80",
      DEEPSEEK_OVERALL_BALANCE: "200",
    })
    // remaining = 35 → init-used = 85 → exceeds 80 by 5 (=80*0.0625) → warning
    // period bar: used = 80-35 = 45 → 45/80 = 56%
    ctx.util.request = vi.fn(() => ({ status: 200, bodyText: JSON.stringify(successPayload(35)) }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const period = result.lines.find((l) => l.label === "Period")
    expect(period.used).toBeCloseTo(45, 2)
    expect(period.limit).toBe(80)
    expect(period.color).toBe("#f59e0b")

    const badge = result.lines.find((l) => l.type === "badge")
    expect(badge).toBeTruthy()
    expect(badge.text).toBe("Period limit reached")
    expect(badge.color).toBe("#f59e0b")
  })

  // ----- error state: init-used exceeds limit by > 10% -----
  it("emits error badge when init-used exceeds period limit by > 10%", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_PERIOD_INIT: "120",
      DEEPSEEK_PERIOD_LIMIT: "80",
      DEEPSEEK_OVERALL_BALANCE: "200",
    })
    // remaining = 20 → init-used = 100 → exceeds 80 by 20 (=80*0.25) → error
    // period bar: used = 80-20 = 60 → 60/80 = 75%
    ctx.util.request = vi.fn(() => ({ status: 200, bodyText: JSON.stringify(successPayload(20)) }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const period = result.lines.find((l) => l.label === "Period")
    expect(period.used).toBeCloseTo(60, 2)
    expect(period.limit).toBe(80)
    expect(period.color).toBe("#ef4444")

    const badge = result.lines.find((l) => l.type === "badge")
    expect(badge.text).toBe("Period limit exceeded")
    expect(badge.color).toBe("#ef4444")
  })

  // ----- exact warning boundary: init-used = period_limit + 1 -----
  it("treats init-used = period_limit + 1 as warning", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_PERIOD_INIT: "120",
      DEEPSEEK_PERIOD_LIMIT: "80",
      DEEPSEEK_OVERALL_BALANCE: "200",
    })
    // remaining = 39 → init-used = 81 (= limit + 1) → warning
    ctx.util.request = vi.fn(() => ({ status: 200, bodyText: JSON.stringify(successPayload(39)) }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const badge = result.lines.find((l) => l.type === "badge")
    expect(badge).toBeTruthy()
    expect(badge.text).toBe("Period limit reached")
  })

  // ----- exact error boundary: init-used = period_limit * 1.1 + 1 -----
  it("treats init-used = period_limit * 1.1 + 1 as error", async () => {
    const ctx = makeCtx()
    setEnv(ctx, {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_PERIOD_INIT: "120",
      DEEPSEEK_PERIOD_LIMIT: "80",
      DEEPSEEK_OVERALL_BALANCE: "200",
    })
    // limit * 1.1 = 88; init-used = 89 → error
    // remaining = 120 - 89 = 31
    ctx.util.request = vi.fn(() => ({ status: 200, bodyText: JSON.stringify(successPayload(31)) }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const badge = result.lines.find((l) => l.type === "badge")
    expect(badge).toBeTruthy()
    expect(badge.text).toBe("Period limit exceeded")
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
