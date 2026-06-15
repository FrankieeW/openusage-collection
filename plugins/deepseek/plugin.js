(function () {
  const USAGE_URL = "https://api.deepseek.com/user/balance"
  const API_KEY_ENV_VARS = ["DEEPSEEK_API_KEY"]

  // Currency symbol/format hints used by the renderer.
  // We pick the actual currency by inspecting the balance_infos[] response.
  const CURRENCY_META = {
    USD: { symbol: "$", kind: "dollars" },
    CNY: { symbol: "¥", kind: "dollars" },
  }
  const DEFAULT_CURRENCY = "USD"

  function readString(value) {
    if (typeof value !== "string") return null
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }

  function readNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null
    if (typeof value !== "string") return null
    const trimmed = value.trim()
    if (!trimmed) return null
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : null
  }

  function loadApiKey(ctx) {
    for (let i = 0; i < API_KEY_ENV_VARS.length; i += 1) {
      const name = API_KEY_ENV_VARS[i]
      let value = null
      try {
        value = ctx.host.env.get(name)
      } catch (e) {
        ctx.host.log.warn("env read failed for " + name + ": " + String(e))
      }
      const key = readString(value)
      if (key) {
        ctx.host.log.info("api key loaded from " + name)
        return key
      }
    }
    return null
  }

  function loadInitialBalance(ctx) {
    let value = null
    try {
      value = ctx.host.env.get("DEEPSEEK_INITIAL_BALANCE")
    } catch (e) {
      ctx.host.log.warn("env read failed for DEEPSEEK_INITIAL_BALANCE: " + String(e))
    }
    return readNumber(value)
  }

  // Returns { currency, balance, source } where source describes the
  // resolution path ("usd" | "cny" | "fallback"). USD is preferred;
  // CNY is the fallback when USD is missing.
  function findBalance(balanceInfos) {
    if (!Array.isArray(balanceInfos) || balanceInfos.length === 0) return null
    let cnyBalance = null
    for (let i = 0; i < balanceInfos.length; i += 1) {
      const info = balanceInfos[i]
      if (!info || typeof info !== "object") continue
      const balance = readNumber(info.total_balance)
      if (balance === null) continue
      if (info.currency === "USD") return { currency: "USD", balance, source: "usd" }
      if (info.currency === "CNY") cnyBalance = { currency: "CNY", balance, source: "cny" }
    }
    return cnyBalance
  }

  function probe(ctx) {
    const apiKey = loadApiKey(ctx)
    if (!apiKey) {
      throw "DeepSeek API key missing. Set DEEPSEEK_API_KEY."
    }

    const initialBalance = loadInitialBalance(ctx)
    if (initialBalance === null || initialBalance <= 0) {
      throw "DeepSeek initial balance missing or invalid. Set DEEPSEEK_INITIAL_BALANCE to your starting balance (e.g. 10.00)."
    }

    let resp
    try {
      resp = ctx.util.request({
        method: "GET",
        url: USAGE_URL,
        headers: {
          Authorization: "Bearer " + apiKey,
          Accept: "application/json",
        },
        timeoutMs: 15000,
      })
    } catch (e) {
      throw "Request failed. Check your connection."
    }

    if (ctx.util.isAuthStatus(resp.status)) {
      throw "Session expired. Check your DeepSeek API key."
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw "Request failed (HTTP " + resp.status + "). Try again later."
    }

    const json = ctx.util.tryParseJson(resp.bodyText)
    if (!json || typeof json !== "object") {
      throw "Could not parse usage data."
    }

    const balanceInfo = findBalance(json.balance_infos)
    if (!balanceInfo) {
      throw "Could not find USD or CNY balance in response."
    }

    const currency = balanceInfo.currency
    const meta = CURRENCY_META[currency] || CURRENCY_META[DEFAULT_CURRENCY]
    const remainingBalance = balanceInfo.balance
    const used = Math.max(0, initialBalance - remainingBalance)

    return {
      plan: currency,
      lines: [
        ctx.line.progress({
          label: "Balance",
          used: used,
          limit: initialBalance,
          format: { kind: meta.kind, currency: meta.symbol },
        }),
      ],
    }
  }

  globalThis.__openusage_plugin = { id: "deepseek", probe }
})()
