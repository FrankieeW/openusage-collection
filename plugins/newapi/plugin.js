(function () {
  var ENDPOINT_PATH = "/api/user/self"
  var ENV_SUFFIX_BASE_URL = "_NEWAPI_BASE_URL"
  var ENV_SUFFIX_ACCESS_TOKEN = "_NEWAPI_ACCESS_TOKEN"
  var ENV_SUFFIX_USER_ID = "_NEWAPI_USERID"
  var ENV_SUFFIX_NAME = "_NEWAPI_NAME"
  var ENV_SUFFIX_SCOPE = "_NEWAPI_SCOPE"
  var TOKEN_TO_USD_DIVISOR = 500000

  // ---- helpers ----

  function readString(value) {
    if (typeof value !== "string") return null
    var trimmed = value.trim()
    return trimmed ? trimmed : null
  }

  function readNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null
    if (typeof value !== "string") return null
    var trimmed = value.trim()
    if (!trimmed) return null
    var n = Number(trimmed)
    return Number.isFinite(n) ? n : null
  }

  // ---- env scanning ----

  // Collect all env var names from the platform.
  // Tries the platform-provided methods in priority order.
  // Returns { names, prefixOrder } where prefixOrder is non-null when
  // OPENUSAGE_NEWAPI_PREFIXES declares an explicit order.
  function getEnvNames(ctx) {
    var methods = ["names", "list", "keys"]
    for (var m = 0; m < methods.length; m++) {
      var method = methods[m]
      if (ctx.host.env && typeof ctx.host.env[method] === "function") {
        try {
          var result = ctx.host.env[method]()
          if (Array.isArray(result) && result.length > 0) {
            ctx.host.log.info("newapi: env listing via " + method + " returned " + result.length + " vars")
            return { names: result, prefixOrder: null }
          }
        } catch (e) {
          ctx.host.log.warn("newapi: env." + method + "() failed: " + String(e))
        }
      }
    }

    // Fallback: try reading a set of known prefixes from a dedicated env var.
    // OPENUSAGE_NEWAPI_PREFIXES is a comma-separated list, e.g. "HOME,WORK,LAB".
    var prefixesEnv = null
    try {
      prefixesEnv = ctx.host.env.get("OPENUSAGE_NEWAPI_PREFIXES")
    } catch (e) { /* ignore */ }
    if (prefixesEnv && typeof prefixesEnv === "string" && prefixesEnv.trim()) {
      var parts = prefixesEnv.split(",")
      var names = []
      var orderList = []
      for (var p = 0; p < parts.length; p++) {
        var prefix = parts[p].trim()
        if (prefix) {
          orderList.push(prefix)
          names.push(prefix + ENV_SUFFIX_BASE_URL)
          names.push(prefix + ENV_SUFFIX_ACCESS_TOKEN)
          names.push(prefix + ENV_SUFFIX_USER_ID)
          names.push(prefix + ENV_SUFFIX_NAME)
          names.push(prefix + ENV_SUFFIX_SCOPE)
        }
      }
      ctx.host.log.info("newapi: using OPENUSAGE_NEWAPI_PREFIXES fallback with " + parts.length + " prefixes")
      return { names: names, prefixOrder: orderList }
    }

    return { names: [], prefixOrder: null }
  }

  // Scan env var names for *_NEWAPI_BASE_URL patterns and collect configs.
  // When prefixOrder is set (from OPENUSAGE_NEWAPI_PREFIXES), use that order.
  // Otherwise sort alphabetically by prefix.
  function collectConfigs(ctx) {
    var envResult = getEnvNames(ctx)
    var names = envResult.names
    var prefixOrder = envResult.prefixOrder
    var prefixMap = {}

    for (var i = 0; i < names.length; i++) {
      var name = names[i]
      if (typeof name !== "string") continue

      var idx = name.indexOf(ENV_SUFFIX_BASE_URL)
      if (idx <= 0) continue // prefix must be non-empty

      var prefix = name.substring(0, idx)

      // Already collected this prefix
      if (prefixMap[prefix]) continue

      // Read base URL
      var baseUrlRaw = null
      try { baseUrlRaw = ctx.host.env.get(name) } catch (e) { /* ignore */ }
      var baseUrl = readString(baseUrlRaw)
      if (!baseUrl) {
        ctx.host.log.warn("newapi: " + name + " is empty, skipping prefix " + prefix)
        continue
      }

      // Read access token (required)
      var tokenName = prefix + ENV_SUFFIX_ACCESS_TOKEN
      var tokenRaw = null
      try { tokenRaw = ctx.host.env.get(tokenName) } catch (e) { /* ignore */ }
      var accessToken = readString(tokenRaw)
      if (!accessToken) {
        ctx.host.log.warn("newapi: " + tokenName + " is missing, skipping prefix " + prefix)
        continue
      }

      // Read user ID (optional)
      var userIdName = prefix + ENV_SUFFIX_USER_ID
      var userIdRaw = null
      try { userIdRaw = ctx.host.env.get(userIdName) } catch (e) { /* ignore */ }
      var userId = readString(userIdRaw)

      // Read display name (optional, defaults to prefix)
      var displayNameName = prefix + ENV_SUFFIX_NAME
      var displayNameRaw = null
      try { displayNameRaw = ctx.host.env.get(displayNameName) } catch (e) { /* ignore */ }
      var displayName = readString(displayNameRaw) || prefix

      // Read scope (optional, defaults to "detail")
      var scopeName = prefix + ENV_SUFFIX_SCOPE
      var scopeRaw = null
      try { scopeRaw = ctx.host.env.get(scopeName) } catch (e) { /* ignore */ }
      var scopeValue = readString(scopeRaw)
      var scope = scopeValue === "overview" ? "overview" : "detail"

      prefixMap[prefix] = {
        prefix: prefix,
        displayName: displayName,
        baseUrl: baseUrl.replace(/\/+$/, ""),
        accessToken: accessToken,
        userId: userId,
        scope: scope,
      }
    }

    // Sort: prefixOrder (from OPENUSAGE_NEWAPI_PREFIXES) takes priority,
    // then fall back to alphabetical.
    var sortedPrefixes
    if (prefixOrder && prefixOrder.length > 0) {
      sortedPrefixes = prefixOrder.filter(function (p) { return prefixMap[p] })
      // Append any prefixes found via env scanning but not in the explicit list
      var explicitSet = {}
      for (var ep = 0; ep < prefixOrder.length; ep++) {
        explicitSet[prefixOrder[ep]] = true
      }
      var remaining = Object.keys(prefixMap).sort().filter(function (p) { return !explicitSet[p] })
      sortedPrefixes = sortedPrefixes.concat(remaining)
    } else {
      sortedPrefixes = Object.keys(prefixMap).sort()
    }
    var configs = []
    for (var s = 0; s < sortedPrefixes.length; s++) {
      configs.push(prefixMap[sortedPrefixes[s]])
    }
    return configs
  }

  // ---- API calls ----

  function fetchQuota(ctx, config) {
    var url = config.baseUrl + ENDPOINT_PATH
    var headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + config.accessToken,
    }
    if (config.userId) {
      headers["New-Api-User"] = config.userId
    }

    var resp
    try {
      resp = ctx.util.request({
        method: "GET",
        url: url,
        headers: headers,
        timeoutMs: 15000,
      })
    } catch (e) {
      ctx.host.log.error("newapi: request failed for " + config.prefix + ": " + String(e))
      return null
    }

    if (ctx.util.isAuthStatus && ctx.util.isAuthStatus(resp.status)) {
      ctx.host.log.error("newapi: auth failed for " + config.prefix + " (HTTP " + resp.status + ")")
      return { __authError: true, config: config }
    }

    if (resp.status < 200 || resp.status >= 300) {
      ctx.host.log.error("newapi: request failed for " + config.prefix + ": HTTP " + resp.status)
      return null
    }

    var json = ctx.util.tryParseJson(resp.bodyText)
    if (!json || typeof json !== "object") {
      ctx.host.log.error("newapi: invalid JSON response for " + config.prefix)
      return null
    }

    return json
  }

  // ---- line building ----

  function buildLine(ctx, config, data) {
    // Auth error
    if (data && data.__authError) {
      return ctx.line.badge({
        label: config.displayName,
        text: "认证失败",
        color: "#ef4444",
        subtitle: "Check " + config.prefix + ENV_SUFFIX_ACCESS_TOKEN,
      })
    }

    // API-level failure
    if (!data || !data.success || !data.data) {
      var msg = (data && typeof data.message === "string")
        ? data.message
        : "查询失败"
      return ctx.line.badge({
        label: config.displayName,
        text: msg,
        color: "#ef4444",
      })
    }

    var d = data.data
    var quota = readNumber(d.quota) || 0
    var usedQuota = readNumber(d.used_quota) || 0

    // Convert token amounts to USD (divisor from reference extractor)
    var remainingUSD = quota / TOKEN_TO_USD_DIVISOR
    var usedUSD = usedQuota / TOKEN_TO_USD_DIVISOR
    var totalUSD = remainingUSD + usedUSD

    var line = ctx.line.progress({
      label: config.displayName,
      used: usedUSD,
      limit: totalUSD,
      format: { kind: "dollars" },
    })
    line.scope = config.scope
    return line
  }

  function buildPlanName(data) {
    if (data && data.success && data.data && data.data.group) {
      return readString(data.data.group) || "New API"
    }
    return "New API"
  }

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

  // ---- probe ----

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
    var primarySet = false

    for (var i = 0; i < configs.length; i++) {
      var config = configs[i]
      ctx.host.log.info("newapi: fetching quota for " + config.prefix + " (" + config.displayName + ")")

      var data = fetchQuota(ctx, config)

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
        // First successful overview progress line is the primary bar
        if (!primarySet && data && data.success && line.scope === "overview") {
          line.primaryOrder = 1
          primarySet = true
        }
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

    return { plan: planName || "New API", lines: lines }
  }

  globalThis.__openusage_plugin = { id: "newapi", probe: probe }
})()
