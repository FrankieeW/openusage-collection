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
        total_balance: "3.55",
        granted_balance: "0.00",
        topped_up_balance: "3.55",
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
    setEnv(ctx, { DEEPSEEK_INITIAL_BALANCE: "10" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("DeepSeek API key missing")
  })

  it("throws when initial balance is missing", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "sk-test" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("initial balance")
  })

  it("throws when initial balance is zero", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_INITIAL_BALANCE: "0" })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("initial balance")
  })

  it("returns progress line with USD currency marker", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_INITIAL_BALANCE: "10" })

    const payload = successPayload()
    ctx.util.request = vi.fn(() => ({
      status: 200,
      bodyText: JSON.stringify(payload),
    }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("USD")
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]).toMatchObject({
      label: "Balance",
      format: { kind: "dollars", currency: "$" },
    })
    // remaining = 3.55, initial = 10, used = 6.45
    expect(result.lines[0].used).toBeCloseTo(6.45, 2)
    expect(result.lines[0].limit).toBe(10)
  })

  it("uses CNY balance and currency marker when USD is absent", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_INITIAL_BALANCE: "100" })

    const payload = {
      is_available: true,
      balance_infos: [
        {
          currency: "CNY",
          total_balance: "55.00",
          granted_balance: "5.00",
          topped_up_balance: "50.00",
        },
      ],
    }
    ctx.util.request = vi.fn(() => ({
      status: 200,
      bodyText: JSON.stringify(payload),
    }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("CNY")
    expect(result.lines[0]).toMatchObject({
      label: "Balance",
      format: { kind: "dollars", currency: "¥" },
    })
    // remaining = 55.00, initial = 100, used = 45.00
    expect(result.lines[0].used).toBeCloseTo(45, 2)
    expect(result.lines[0].limit).toBe(100)
  })

  it("prefers USD over CNY when both are present", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_INITIAL_BALANCE: "50" })

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

    // Prefers USD: remaining = 10.00, initial = 50, used = 40
    expect(result.plan).toBe("USD")
    expect(result.lines[0].format).toEqual({ kind: "dollars", currency: "$" })
    expect(result.lines[0].used).toBeCloseTo(40, 2)
    expect(result.lines[0].limit).toBe(50)
  })

  it("handles USD listed after CNY in the array", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_INITIAL_BALANCE: "50" })

    const payload = {
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "100.00", granted_balance: "0.00", topped_up_balance: "100.00" },
        { currency: "USD", total_balance: "12.00", granted_balance: "0.00", topped_up_balance: "12.00" },
      ],
    }
    ctx.util.request = vi.fn(() => ({
      status: 200,
      bodyText: JSON.stringify(payload),
    }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("USD")
    expect(result.lines[0].used).toBeCloseTo(38, 2)
  })

  it("throws when no USD or CNY balance present", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_INITIAL_BALANCE: "10" })

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
    setEnv(ctx, { DEEPSEEK_API_KEY: "sk-bad", DEEPSEEK_INITIAL_BALANCE: "10" })

    ctx.util.request = vi.fn(() => ({ status: 401, bodyText: "Unauthorized" }))
    ctx.util.isAuthStatus = vi.fn((s) => s === 401 || s === 403)

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Session expired")
  })

  it("handles HTTP error status", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_INITIAL_BALANCE: "10" })

    ctx.util.request = vi.fn(() => ({ status: 500, bodyText: "Server Error" }))
    ctx.util.isAuthStatus = vi.fn(() => false)

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("HTTP 500")
  })

  it("handles invalid JSON response", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_INITIAL_BALANCE: "10" })

    ctx.util.request = vi.fn(() => ({ status: 200, bodyText: "not json" }))
    ctx.util.isAuthStatus = vi.fn(() => false)

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Could not parse usage data")
  })

  it("handles missing balance_infos", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_INITIAL_BALANCE: "10" })

    const payload = { is_available: true, balance_infos: [] }
    ctx.util.request = vi.fn(() => ({
      status: 200,
      bodyText: JSON.stringify(payload),
    }))

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Could not find USD or CNY balance")
  })

  it("reads key from all env vars", async () => {
    const ctx = makeCtx()
    setEnv(ctx, { DEEPSEEK_API_KEY: "sk-from-key", DEEPSEEK_INITIAL_BALANCE: "10" })

    const payload = successPayload()
    ctx.util.request = vi.fn(() => ({
      status: 200,
      bodyText: JSON.stringify(payload),
    }))

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).not.toThrow()
  })
})
