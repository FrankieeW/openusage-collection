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

function successPayload(overrides) {
  const base = {
    is_available: true,
    balance_infos: [
      {
        currency: "USD",
        total_balance: "10.00",
        granted_balance: "0.00",
        topped_up_balance: "10.00",
      },
    ],
  }
  if (!overrides) return base
  return Object.assign(base, overrides)
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
    setEnv(ctx, { DEEPSEEK_OVERALL_BALANCE: "20", DEEPSEEK_PERIOD_LIMIT: "5" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("DeepSeek API key missing")
  })

  it("throws when overall balance is missing", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_PERIOD_LIMIT: "5" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("DEEPSEEK_OVERALL_BALANCE")
  })

  it("throws when period limit is missing", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_OVERALL_BALANCE: "20" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("DEEPSEEK_PERIOD_LIMIT")
  })

  it("throws when overall balance is zero", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_OVERALL_BALANCE: "0", DEEPSEEK_PERIOD_LIMIT: "5" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("DEEPSEEK_OVERALL_BALANCE")
  })

  it("renders Overall + Period lines with USD currency", async () => {
    // remaining=10, overall=20, period=5 → Overall used=10, Period used=0
    const ctx = makeCtx()
    setEnv(ctx, {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_OVERALL_BALANCE: "20",
      DEEPSEEK_PERIOD_LIMIT: "5",
    })
    ctx.util.request = vi.fn(() => ({
      status: 200,
      bodyText: JSON.stringify(successPayload()),
    }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("USD")
    expect(result.lines.map((l) => l.label)).toEqual(["Period", "Overall"])

    const period = result.lines.find((l) => l.label === "Period")
    const overall = result.lines.find((l) => l.label === "Overall")

    expect(period.used).toBe(0)
    expect(period.limit).toBe(5)
    expect(period.format).toEqual({ kind: "dollars", currency: "$" })

    expect(overall.used).toBeCloseTo(10, 2)
    expect(overall.limit).toBe(20)
    expect(overall.format).toEqual({ kind: "dollars", currency: "$" })
  })

  it("uses CNY balance and ¥ symbol when USD is absent", async () => {
    // remaining=55, overall=100, period=60 → Overall used=45, Period used=5
    const ctx = makeCtx()
    setEnv(ctx, {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_OVERALL_BALANCE: "100",
      DEEPSEEK_PERIOD_LIMIT: "60",
    })
    const payload = {
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "55.00", granted_balance: "5.00", topped_up_balance: "50.00" },
      ],
    }
    ctx.util.request = vi.fn(() => ({
      status: 200,
      bodyText: JSON.stringify(payload),
    }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("CNY")
    expect(result.lines[0].format).toEqual({ kind: "dollars", currency: "¥" })
    expect(result.lines[1].format).toEqual({ kind: "dollars", currency: "¥" })
    expect(result.lines[0].used).toBeCloseTo(45, 2)
    expect(result.lines[1].used).toBeCloseTo(5, 2)
  })

  it("prefers USD over CNY when both are present", async () => {
    // remaining=10 (USD), overall=20, period=5
    const ctx = makeCtx()
    setEnv(ctx, {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_OVERALL_BALANCE: "20",
      DEEPSEEK_PERIOD_LIMIT: "5",
    })
    const payload = {
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "100.00", granted_balance: "0.00", topped_up_balance: "100.00" },
        { currency: "USD", total_balance: "10.00", granted_balance: "0.00", topped_up_balance: "10.00" },
      ],
    }
    ctx.util.request = vi.fn(() => ({
      status: 200,
      bodyText: JSON.stringify(payload),
    }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("USD")
    expect(result.lines[0].format.currency).toBe("$")
    expect(result.lines[0].used).toBeCloseTo(10, 2)
  })

  it("clamps used to 0 when remaining exceeds cap (period fully refilled)", async () => {
    // remaining=15, period=10 → Period used clamped to 0
    const ctx = makeCtx()
    setEnv(ctx, {
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_OVERALL_BALANCE: "100",
      DEEPSEEK_PERIOD_LIMIT: "10",
    })
    ctx.util.request = vi.fn(() => ({
      status: 200,
      bodyText: JSON.stringify(successPayload({
        balance_infos: [
          { currency: "USD", total_balance: "15.00", granted_balance: "0.00", topped_up_balance: "15.00" },
        ],
      })),
    }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const period = result.lines.find((l) => l.label === "Period")
    expect(period.used).toBe(0)
    expect(period.limit).toBe(10)
  })

  it("throws when no USD or CNY balance present", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_OVERALL_BALANCE: "20", DEEPSEEK_PERIOD_LIMIT: "5" })
    const payload = {
      is_available: true,
      balance_infos: [
        { currency: "EUR", total_balance: "20.00", granted_balance: "0.00", topped_up_balance: "20.00" },
      ],
    }
    ctx.util.request = vi.fn(() => ({
      status: 200,
      bodyText: JSON.stringify(payload),
    }))

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Could not find USD or CNY balance")
  })

  it("handles auth error (401)", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "sk-bad", DEEPSEEK_OVERALL_BALANCE: "20", DEEPSEEK_PERIOD_LIMIT: "5" })
    ctx.util.request = vi.fn(() => ({ status: 401, bodyText: "Unauthorized" }))
    ctx.util.isAuthStatus = vi.fn((s) => s === 401 || s === 403)

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Session expired")
  })

  it("handles HTTP error status", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_OVERALL_BALANCE: "20", DEEPSEEK_PERIOD_LIMIT: "5" })
    ctx.util.request = vi.fn(() => ({ status: 500, bodyText: "Server Error" }))
    ctx.util.isAuthStatus = vi.fn(() => false)

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("HTTP 500")
  })

  it("handles invalid JSON response", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_OVERALL_BALANCE: "20", DEEPSEEK_PERIOD_LIMIT: "5" })
    ctx.util.request = vi.fn(() => ({ status: 200, bodyText: "not json" }))
    ctx.util.isAuthStatus = vi.fn(() => false)

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Could not parse usage data")
  })
})
