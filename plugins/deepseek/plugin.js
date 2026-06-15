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

  // Status thresholds (when period is exceeded).
  // - WARNING when remaining < (PERIOD_INIT - PERIOD_LIMIT)
  // - ERROR   when remaining < (PERIOD_INIT - PERIOD_LIMIT * 1.1)
  const WARNING_COLOR = "#f59e0b" // amber
  const ERROR_COLOR = "#ef4444"   // red

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

  function loadRequiredBalance(ctx, envName) {
    let value = null
    try {
      value = ctx.host.env.get(envName)
    } catch (e) {
      ctx.host.log.warn("env read failed for " + envName + ": " + String(e))
    }
    const n = readNumber(value)
    if (n === null || n <= 0) {
      throw "DeepSeek " + envName + " missing or invalid. Set it to a positive number (e.g. 120)."
    }
    return n
  }

  // Returns { currency, balance } where USD is preferred; CNY is the
  // fallback when USD is missing.
  function findBalance(balanceInfos) {
    if (!Array.isArray(balanceInfos) || balanceInfos.length === 0) return null
    let cnyBalance = null
    for (let i = 0; i < balanceInfos.length; i += 1) {
      const info = balanceInfos[i]
      if (!info || typeof info !== "object") continue
      const balance = readNumber(info.total_balance)
      if (balance === null) continue
      if (info.currency === "USD") return { currency: "USD", balance }
      if (info.currency === "CNY") cnyBalance = { currency: "CNY", balance }
    }
    return cnyBalance
  }

  // Build a "used vs cap" progress line.
  //
  // The Period line uses DEEPSEEK_PERIOD_LIMIT as the cap so the progress bar
  // reflects "how much of the soft limit has been consumed" — a healthy
  // balance (remaining >= limit) reads as 0% and an empty balance reads as
  // 100%, instead of the previous behavior where the cap was the period's
  // initial balance and the limit only influenced the color threshold.
  // Negative balances (returned by DeepSeek for accounts that have been
  // charged past zero) are clamped to 100%.
  function pushCapLine(ctx, lines, label, cap, remaining, kind, currency, color) {
    const used = Math.max(0, Math.min(cap, cap - remaining))
    const line = {
      label: label,
      used: used,
      limit: cap,
      format: { kind: kind, currency: currency },
    }
    if (color) line.color = color
    lines.push(ctx.line.progress(line))
    return { used, limit: cap }
  }

  // Classify how much of the period's self-limit has been consumed.
  // - "ok"      : used < period_limit
  // - "warning" : used >= period_limit (limit hit; remaining < init - limit)
  // - "error"   : used > period_limit * 1.1 (over by 10% of the limit)
  function classifyPeriod(periodInit, periodLimit, remaining) {
    const used = periodInit - remaining
    if (used <= periodLimit) return "ok"
    if (used <= periodLimit * 1.1) return "warning"
    return "error"
  }

  function probe(ctx) {
    const apiKey = loadApiKey(ctx)
    if (!apiKey) {
      throw "DeepSeek API key missing. Set DEEPSEEK_API_KEY."
    }

    const periodInit = loadRequiredBalance(ctx, "DEEPSEEK_PERIOD_INIT")
    const periodLimit = loadRequiredBalance(ctx, "DEEPSEEK_PERIOD_LIMIT")
    const overallBalance = loadRequiredBalance(ctx, "DEEPSEEK_OVERALL_BALANCE")

    if (periodLimit > periodInit) {
      throw "DEEPSEEK_PERIOD_LIMIT (" + periodLimit + ") cannot exceed DEEPSEEK_PERIOD_INIT (" + periodInit + ")."
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

    const status = classifyPeriod(periodInit, periodLimit, remainingBalance)
    const periodColor = status === "error" ? ERROR_COLOR : status === "warning" ? WARNING_COLOR : null

    const lines = []

    // Primary: Period (used vs PERIOD_LIMIT — the soft cap — with status color when over limit)
    pushCapLine(ctx, lines, "Period", periodLimit, remainingBalance, meta.kind, meta.symbol, periodColor)

    // Secondary: Overall
    pushCapLine(ctx, lines, "Overall", overallBalance, remainingBalance, meta.kind, meta.symbol)

    // Status badge when the period limit is breached
    if (status === "warning") {
      lines.push(
        ctx.line.badge({
          label: "Status",
          text: "Period limit reached",
          color: WARNING_COLOR,
          subtitle: "Remaining: " + meta.symbol + remainingBalance.toFixed(2) + " of " + meta.symbol + periodLimit.toFixed(2) + " allowed",
        })
      )
    } else if (status === "error") {
      const overage = remainingBalance < 0
        ? "Negative by " + meta.symbol + Math.abs(remainingBalance - (periodInit - periodLimit)).toFixed(2)
        : "Over limit"
      lines.push(
        ctx.line.badge({
          label: "Status",
          text: "Period limit exceeded",
          color: ERROR_COLOR,
          subtitle: overage,
        })
      )
    }

    return { plan: currency, lines }
  }

  globalThis.__openusage_plugin = { id: "deepseek", probe }
})()
