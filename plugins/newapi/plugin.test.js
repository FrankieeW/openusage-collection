import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

function setEnvNames(ctx, names) {
  // Mock env listing — try the methods the plugin checks in priority order
  if (ctx.host.env.names) {
    ctx.host.env.names.mockReturnValue(names)
  }
  if (ctx.host.env.list) {
    ctx.host.env.list.mockReturnValue(names)
  }
  if (ctx.host.env.keys) {
    ctx.host.env.keys.mockReturnValue(names)
  }
}

function setEnv(ctx, values) {
  ctx.host.env.get.mockImplementation((name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : null
  )
}

function successPayload(quota, usedQuota, group) {
  return {
    success: true,
    data: {
      quota: quota,
      used_quota: usedQuota,
      group: group || "VIP套餐",
    },
  }
}

function failurePayload(message) {
  return {
    success: false,
    message: message || "查询失败",
  }
}

describe("newapi plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ---- discovery ----

  it("throws when no NEWAPI env vars are configured", async () => {
    const ctx = makeCtx()
    setEnvNames(ctx, [])
    setEnv(ctx, {})
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("No NEWAPI configuration found")
  })

  it("throws when OPENUSAGE_NEWAPI_PREFIXES fallback has no valid configs", async () => {
    const ctx = makeCtx()
    setEnvNames(ctx, [])
    setEnv(ctx, {
      OPENUSAGE_NEWAPI_PREFIXES: "HOME,WORK",
      HOME_NEWAPI_BASE_URL: "https://api1.example.com",
      // Missing HOME_NEWAPI_ACCESS_TOKEN
      WORK_NEWAPI_BASE_URL: "https://api2.example.com",
      // Missing WORK_NEWAPI_ACCESS_TOKEN
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("No NEWAPI configuration found")
  })

  // ---- single config ----

  it("renders a single progress line for one NEWAPI config", async () => {
    const ctx = makeCtx()
    setEnvNames(ctx, [
      "HOME_NEWAPI_BASE_URL",
      "HOME_NEWAPI_ACCESS_TOKEN",
      "HOME_NEWAPI_USERID",
      "HOME_NEWAPI_NAME",
      "HOME_NEWAPI_SCOPE",
      "OTHER_VAR",
    ])
    setEnv(ctx, {
      HOME_NEWAPI_BASE_URL: "https://api.example.com",
      HOME_NEWAPI_ACCESS_TOKEN: "sk-test-token",
      HOME_NEWAPI_USERID: "123",
      HOME_NEWAPI_NAME: "Home Server",
      HOME_NEWAPI_SCOPE: "overview",
    })
    // quota=250000, used=100000 → remaining=$0.50, used=$0.20, total=$0.70
    ctx.util.request = vi.fn(() => ({
      status: 200,
      bodyText: JSON.stringify(successPayload(250000, 100000)),
    }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("VIP套餐")
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
  })

  // ---- multiple configs sorted by prefix ----

  it("renders multiple lines sorted by prefix", async () => {
    const ctx = makeCtx()
    setEnvNames(ctx, [
      "BB_NEWAPI_BASE_URL",
      "BB_NEWAPI_ACCESS_TOKEN",
      "AA_NEWAPI_BASE_URL",
      "AA_NEWAPI_ACCESS_TOKEN",
      "AA_NEWAPI_SCOPE",
      "CC_NEWAPI_BASE_URL",
      "CC_NEWAPI_ACCESS_TOKEN",
    ])
    setEnv(ctx, {
      AA_NEWAPI_BASE_URL: "https://api.aa.com",
      AA_NEWAPI_ACCESS_TOKEN: "sk-aa",
      AA_NEWAPI_SCOPE: "overview",
      BB_NEWAPI_BASE_URL: "https://api.bb.com",
      BB_NEWAPI_ACCESS_TOKEN: "sk-bb",
      CC_NEWAPI_BASE_URL: "https://api.cc.com",
      CC_NEWAPI_ACCESS_TOKEN: "sk-cc",
    })
    ctx.util.request = vi.fn((opts) => {
      if (opts.url.indexOf("api.aa.com") !== -1) {
        return { status: 200, bodyText: JSON.stringify(successPayload(100000, 100000, "AA Plan")) }
      }
      if (opts.url.indexOf("api.bb.com") !== -1) {
        return { status: 200, bodyText: JSON.stringify(successPayload(200000, 200000, "BB Plan")) }
      }
      return { status: 200, bodyText: JSON.stringify(successPayload(300000, 300000, "CC Plan")) }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

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
  })

  // ---- display name from env ----

  it("uses _NEWAPI_NAME for the progress bar label", async () => {
    const ctx = makeCtx()
    setEnvNames(ctx, [
      "PROD_NEWAPI_BASE_URL",
      "PROD_NEWAPI_ACCESS_TOKEN",
      "PROD_NEWAPI_NAME",
    ])
    setEnv(ctx, {
      PROD_NEWAPI_BASE_URL: "https://api.prod.com",
      PROD_NEWAPI_ACCESS_TOKEN: "sk-prod",
      PROD_NEWAPI_NAME: "生产环境",
    })
    ctx.util.request = vi.fn(() => ({
      status: 200,
      bodyText: JSON.stringify(successPayload(500000, 500000)),
    }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    // Aggregate at index 0; per-instance "生产环境" at index 1
    expect(result.lines[0].label).toBe("Total")
    expect(result.lines[1].label).toBe("生产环境")
  })

  // ---- prefix as fallback label when no NAME set ----

  it("falls back to prefix as label when _NEWAPI_NAME is not set", async () => {
    const ctx = makeCtx()
    setEnvNames(ctx, [
      "MYAPI_NEWAPI_BASE_URL",
      "MYAPI_NEWAPI_ACCESS_TOKEN",
    ])
    setEnv(ctx, {
      MYAPI_NEWAPI_BASE_URL: "https://api.myapi.com",
      MYAPI_NEWAPI_ACCESS_TOKEN: "sk-myapi",
    })
    ctx.util.request = vi.fn(() => ({
      status: 200,
      bodyText: JSON.stringify(successPayload(100000, 50000)),
    }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    // Aggregate at index 0; per-instance "MYAPI" (prefix fallback) at index 1
    expect(result.lines[0].label).toBe("Total")
    expect(result.lines[1].label).toBe("MYAPI")
  })

  // ---- auth error ----

  it("shows auth error badge on 401", async () => {
    const ctx = makeCtx()
    setEnvNames(ctx, [
      "BAD_NEWAPI_BASE_URL",
      "BAD_NEWAPI_ACCESS_TOKEN",
    ])
    setEnv(ctx, {
      BAD_NEWAPI_BASE_URL: "https://api.bad.com",
      BAD_NEWAPI_ACCESS_TOKEN: "sk-bad",
    })
    ctx.util.request = vi.fn(() => ({ status: 401, bodyText: "Unauthorized" }))
    ctx.util.isAuthStatus = vi.fn((s) => s === 401 || s === 403)

    const plugin = await loadPlugin()
    // probe() throws when the only configured instance fails (anySuccess guard)
    let caught
    try {
      plugin.probe(ctx)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeTruthy()
    expect(String(caught)).toMatch(/All NEWAPI requests failed/)
  })

  // ---- API failure response ----

  it("shows error badge when API returns success: false", async () => {
    const ctx = makeCtx()
    setEnvNames(ctx, [
      "ERR_NEWAPI_BASE_URL",
      "ERR_NEWAPI_ACCESS_TOKEN",
    ])
    setEnv(ctx, {
      ERR_NEWAPI_BASE_URL: "https://api.err.com",
      ERR_NEWAPI_ACCESS_TOKEN: "sk-err",
    })
    ctx.util.request = vi.fn(() => ({
      status: 200,
      bodyText: JSON.stringify(failurePayload("余额不足")),
    }))

    const plugin = await loadPlugin()
    // probe() throws when the only configured instance fails (anySuccess guard)
    let caught
    try {
      plugin.probe(ctx)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeTruthy()
    expect(String(caught)).toMatch(/All NEWAPI requests failed/)
  })

  // ---- throws when all requests fail ----

  it("throws when all configs fail", async () => {
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
    // Both requests fail → throws
    expect(() => plugin.probe(ctx)).toThrow("All NEWAPI requests failed")
  })

  // ---- zero quota ----

  it("handles zero quota gracefully", async () => {
    const ctx = makeCtx()
    setEnvNames(ctx, [
      "ZERO_NEWAPI_BASE_URL",
      "ZERO_NEWAPI_ACCESS_TOKEN",
    ])
    setEnv(ctx, {
      ZERO_NEWAPI_BASE_URL: "https://api.zero.com",
      ZERO_NEWAPI_ACCESS_TOKEN: "sk-zero",
    })
    ctx.util.request = vi.fn(() => ({
      status: 200,
      bodyText: JSON.stringify(successPayload(0, 0, "Free")),
    }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("Free")
    expect(result.lines[0].used).toBe(0)
    expect(result.lines[0].limit).toBe(0)
  })

  // ---- optional userId header ----

  it("includes New-Api-User header when userId is set", async () => {
    const ctx = makeCtx()
    setEnvNames(ctx, [
      "API_NEWAPI_BASE_URL",
      "API_NEWAPI_ACCESS_TOKEN",
      "API_NEWAPI_USERID",
    ])
    setEnv(ctx, {
      API_NEWAPI_BASE_URL: "https://api.example.com",
      API_NEWAPI_ACCESS_TOKEN: "sk-token",
      API_NEWAPI_USERID: "user-456",
    })
    ctx.util.request = vi.fn(() => ({
      status: 200,
      bodyText: JSON.stringify(successPayload(100000, 50000)),
    }))

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    const callArgs = ctx.util.request.mock.calls[0][0]
    expect(callArgs.headers["New-Api-User"]).toBe("user-456")
  })

  // ---- OPENUSAGE_NEWAPI_PREFIXES fallback ----

  it("discovers configs via OPENUSAGE_NEWAPI_PREFIXES fallback", async () => {
    const ctx = makeCtx()
    setEnvNames(ctx, []) // no env listing available
    setEnv(ctx, {
      OPENUSAGE_NEWAPI_PREFIXES: "DC1,DC2",
      DC1_NEWAPI_BASE_URL: "https://dc1.example.com",
      DC1_NEWAPI_ACCESS_TOKEN: "sk-dc1",
      DC1_NEWAPI_NAME: "Data Center 1",
      DC1_NEWAPI_SCOPE: "overview",
      DC2_NEWAPI_BASE_URL: "https://dc2.example.com",
      DC2_NEWAPI_ACCESS_TOKEN: "sk-dc2",
      DC2_NEWAPI_NAME: "Data Center 2",
    })
    ctx.util.request = vi.fn(() => {
      return { status: 200, bodyText: JSON.stringify(successPayload(500000, 0)) }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

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
  })

  // ---- OPENUSAGE_NEWAPI_PREFIXES order overrides alphabetical sort ----

  it("respects OPENUSAGE_NEWAPI_PREFIXES order over alphabetical", async () => {
    const ctx = makeCtx()
    setEnvNames(ctx, []) // no env listing
    setEnv(ctx, {
      OPENUSAGE_NEWAPI_PREFIXES: "ZETA,ALPHA,BETA",
      ZETA_NEWAPI_BASE_URL: "https://api.zeta.com",
      ZETA_NEWAPI_ACCESS_TOKEN: "sk-zeta",
      ZETA_NEWAPI_SCOPE: "overview",
      ALPHA_NEWAPI_BASE_URL: "https://api.alpha.com",
      ALPHA_NEWAPI_ACCESS_TOKEN: "sk-alpha",
      BETA_NEWAPI_BASE_URL: "https://api.beta.com",
      BETA_NEWAPI_ACCESS_TOKEN: "sk-beta",
    })
    ctx.util.request = vi.fn(() => ({
      status: 200,
      bodyText: JSON.stringify(successPayload(100000, 0)),
    }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

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
  })

  // ---- default scope is "detail", no primaryOrder ----

  it("defaults to detail scope with no primaryOrder", async () => {
    const ctx = makeCtx()
    setEnvNames(ctx, [
      "SVC_NEWAPI_BASE_URL",
      "SVC_NEWAPI_ACCESS_TOKEN",
    ])
    setEnv(ctx, {
      SVC_NEWAPI_BASE_URL: "https://api.svc.com",
      SVC_NEWAPI_ACCESS_TOKEN: "sk-svc",
    })
    ctx.util.request = vi.fn(() => ({
      status: 200,
      bodyText: JSON.stringify(successPayload(100000, 0)),
    }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    // Aggregate at index 0; per-instance line at index 1
    expect(result.lines).toHaveLength(2)
    expect(result.lines[0].label).toBe("Total")
    expect(result.lines[1].scope).toBe("detail")
    expect(result.lines[1].primaryOrder).toBeUndefined()
  })

  // ---- default plan name when group is missing ----

  it("uses default plan name when group is not in response", async () => {
    const ctx = makeCtx()
    setEnvNames(ctx, [
      "DEF_NEWAPI_BASE_URL",
      "DEF_NEWAPI_ACCESS_TOKEN",
    ])
    setEnv(ctx, {
      DEF_NEWAPI_BASE_URL: "https://api.def.com",
      DEF_NEWAPI_ACCESS_TOKEN: "sk-def",
    })
    ctx.util.request = vi.fn(() => ({
      status: 200,
      bodyText: JSON.stringify({ success: true, data: { quota: 100000, used_quota: 0 } }),
    }))

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("New API")
  })

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
})
