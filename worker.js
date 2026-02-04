// KV命名空间：GLADOS_KV
// 必需环境变量：
// - GLADOS_COOKIE：多个账号cookie用'&'分隔
// 可选环境变量（积分兑换）：
// - GLADOS_EXCHANGE_PLAN：100/200/500；不填则不兑换
// - GLADOS_EXCHANGE_COOLDOWN_HOURS：兑换冷却时间（小时），默认 240（10天）
// - GLADOS_EXCHANGE_ENDPOINTS：兑换接口路径候选（逗号分隔），默认 /api/user/exchange
// - GLADOS_EXCHANGE_VERIFY：兑换后是否拉取 status 校验，默认 true
// 可选环境变量（用于Telegram通知）：
// - TELEGRAM_BOT_TOKEN
// - TELEGRAM_CHAT_ID

const GLADOS_BASE_URL = "https://glados.cloud";

const EXCHANGE_PLANS = {
  100: { planType: "plan100", requiredPoints: 100, addedDays: 10 },
  200: { planType: "plan200", requiredPoints: 200, addedDays: 30 },
  // 对齐 Devilstore/Gladoscheckin：plan500 兑换 100 天
  500: { planType: "plan500", requiredPoints: 500, addedDays: 100 }
};

function getCheckinTokens(env) {
  const configured = (env.GLADOS_CHECKIN_TOKEN || "").trim();
  const candidates = [
    "glados.cloud",
    configured,
    "glados.one",
    "glados_network",
    "glados.network"
  ];
  return candidates.filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
}

function isCheckinSuccess(checkinData) {
  const msg = (checkinData && (checkinData.message || checkinData.msg)) || "";
  if (checkinData && checkinData.code === 0) return true;
  return typeof msg === "string" && msg.toLowerCase().includes("checkin");
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  const v = String(value).trim().toLowerCase();
  if (!v) return defaultValue;
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return defaultValue;
}

function parseNumber(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  const v = Number(String(value).trim());
  return Number.isFinite(v) ? v : defaultValue;
}

function nowChinaString() {
  return new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

function getExchangePlan(env) {
  const raw = String(env.GLADOS_EXCHANGE_PLAN || "").trim();
  if (!raw) return null;
  const v = raw.toLowerCase();
  if (["off", "false", "0", "none", "disable", "disabled"].includes(v)) return null;
  const n = parseNumber(v, null);
  if (![100, 200, 500].includes(n)) return null;
  const cfg = EXCHANGE_PLANS[String(n)];
  if (!cfg) return null;
  return { plan: String(n), ...cfg };
}

function getExchangeCooldownHours(env) {
  // 默认冷却 10 天
  return Math.max(0, parseNumber(env.GLADOS_EXCHANGE_COOLDOWN_HOURS, 24 * 10));
}

function getExchangeEndpoints(env) {
  const raw = String(env.GLADOS_EXCHANGE_ENDPOINTS || "").trim();
  if (raw) {
    return raw
      .split(",")
      .map(function(s) { return s.trim(); })
      .filter(Boolean)
      .map(function(p) { return p.startsWith("/") ? p : "/" + p; });
  }
  // 对齐 Devilstore/Gladoscheckin：默认兑换接口为 /api/user/exchange
  return ["/api/user/exchange"];
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map(function(b) { return b.toString(16).padStart(2, "0"); })
    .join("");
}

async function getAccountIdFromCookie(cookie) {
  const hex = await sha256Hex(cookie);
  return hex.slice(0, 16);
}

function parseStatusData(statusData) {
  const data = statusData && statusData.data ? statusData.data : {};
  return {
    email: data.email || "未知账号",
    points: data.points,
    leftDays: data.leftDays
  };
}

async function fetchJsonSafe(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data: data, text: text };
}

function pickMessageFromApi(data, fallback) {
  if (!data) return fallback;
  const msg = data.message || data.msg;
  return msg ? String(msg) : fallback;
}

async function fetchStatus(baseUrl, headers) {
  const statusData = await fetchJson(`${baseUrl}/api/user/status`, { headers: headers });
  return parseStatusData(statusData);
}

async function fetchPoints(baseUrl, headers) {
  const pointsData = await fetchJson(`${baseUrl}/api/user/points`, { headers: headers });
  const raw = (pointsData && pointsData.points !== undefined) ? pointsData.points : null;
  const points = parseNumber(raw, null);
  return Number.isFinite(points) ? points : null;
}

function verifyExchangeByStatus(beforeStatus, afterStatus, plan) {
  const beforePoints = Number(beforeStatus && beforeStatus.points);
  const afterPoints = Number(afterStatus && afterStatus.points);
  const beforeLeftDays = Number(beforeStatus && beforeStatus.leftDays);
  const afterLeftDays = Number(afterStatus && afterStatus.leftDays);

  const pointsSpentOk =
    Number.isFinite(beforePoints) &&
    Number.isFinite(afterPoints) &&
    (beforePoints - afterPoints) >= plan.requiredPoints;

  const leftDaysAddedOk =
    Number.isFinite(beforeLeftDays) &&
    Number.isFinite(afterLeftDays) &&
    (afterLeftDays - beforeLeftDays) >= plan.addedDays;

  return pointsSpentOk || leftDaysAddedOk;
}

async function maybeExchangePoints(env, baseUrl, headers, accountId, beforeStatus) {
  const plan = getExchangePlan(env);
  if (!plan) return null;

  let points = Number(beforeStatus && beforeStatus.points);
  if (!Number.isFinite(points)) {
    const p = await fetchPoints(baseUrl, headers);
    if (Number.isFinite(p)) points = p;
  }
  if (!Number.isFinite(points)) return { enabled: true, attempted: false, plan: plan.plan, skippedReason: "无法获取积分" };
  if (points < plan.requiredPoints) {
    return {
      enabled: true,
      attempted: false,
      plan: plan.plan,
      skippedReason: `积分不足（当前${points}，需要${plan.requiredPoints}）`
    };
  }

  const cooldownHours = getExchangeCooldownHours(env);
  const key = `exchange:last:${accountId}`;
  const stored = await env.GLADOS_KV.get(key);
  let record = null;
  try {
    record = stored ? JSON.parse(stored) : null;
  } catch {
    record = null;
  }
  if (cooldownHours > 0 && record && record.lastAttemptAt) {
    const lastAttempt = Date.parse(record.lastAttemptAt);
    const now = Date.now();
    if (Number.isFinite(lastAttempt) && (now - lastAttempt) < cooldownHours * 3600 * 1000) {
      return {
        enabled: true,
        attempted: false,
        plan: plan.plan,
        skippedReason: `冷却中（上次尝试：${record.lastAttemptAt}）`
      };
    }
  }

  const endpoints = getExchangeEndpoints(env);
  const verify = parseBoolean(env.GLADOS_EXCHANGE_VERIFY, true);
  // 对齐 Devilstore/Gladoscheckin：payload 使用 planType
  const payload = { planType: plan.planType };

  let lastError = null;
  let lastApiMessage = null;

  for (const path of endpoints) {
    const url = `${baseUrl}${path}`;
    try {
      const resp = await fetchJsonSafe(url, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload)
      });
      lastApiMessage = pickMessageFromApi(resp.data, resp.text || `HTTP ${resp.status}`);

      if (!resp.ok) {
        lastError = new Error(lastApiMessage);
        continue;
      }

      // 兑换属于“有副作用”的操作：只要请求返回 2xx，就不要再继续尝试其它 endpoint，
      // 避免因“验证失败/延迟”导致重复扣积分/重复兑换。
      let afterStatus = null;
      let verified = false;
      if (verify) {
        try {
          afterStatus = await fetchStatus(baseUrl, headers);
          verified = verifyExchangeByStatus(beforeStatus, afterStatus, plan);
        } catch (e) {
          lastError = e;
          verified = false;
        }
      }

      const apiSaysSuccess = resp.data && resp.data.code === 0;
      const success = verified || apiSaysSuccess;
      const time = nowChinaString();

      const recordToStore = {
        lastAttemptAt: new Date().toISOString(),
        lastSuccessAt: success ? new Date().toISOString() : (record && record.lastSuccessAt ? record.lastSuccessAt : null),
        plan: plan.plan,
        endpoint: path,
        message: lastApiMessage
      };
      await env.GLADOS_KV.put(key, JSON.stringify(recordToStore));

      return {
        enabled: true,
        attempted: true,
        plan: plan.plan,
        requiredPoints: plan.requiredPoints,
        addedDays: plan.addedDays,
        success: success,
        message: success
          ? (lastApiMessage || "兑换成功")
          : (verify ? (lastApiMessage || "兑换请求已发送，但验证失败") : (lastApiMessage || "兑换失败")),
        time: time,
        endpoint: path,
        afterStatus: success ? (afterStatus || null) : null
      };
    } catch (e) {
      lastError = e;
    }
  }

  const failAt = nowChinaString();
  const failRecord = {
    lastAttemptAt: new Date().toISOString(),
    lastSuccessAt: record && record.lastSuccessAt ? record.lastSuccessAt : null,
    plan: plan.plan,
    endpoint: null,
    message: (lastError && lastError.message) ? lastError.message : (lastApiMessage || "兑换失败")
  };
  await env.GLADOS_KV.put(key, JSON.stringify(failRecord));

  return {
    enabled: true,
    attempted: true,
    plan: plan.plan,
    requiredPoints: plan.requiredPoints,
    addedDays: plan.addedDays,
    success: false,
    message: failRecord.message,
    time: failAt
  };
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`接口返回非JSON: ${url} (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const msg = data && (data.message || data.msg);
    throw new Error(msg ? `HTTP ${res.status}: ${msg}` : `HTTP ${res.status}`);
  }
  return data;
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>GLaDOS签到</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@sweetalert2/theme-dark@4/dark.css">
  <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
  <style>
    .account-item {
      border-bottom: 1px solid #e5e7eb;
      padding-bottom: 1rem;
      margin-bottom: 1rem;
    }
    .success-text { color: #10b981; }
    .error-text { color: #ef4444; }
  </style>
</head>
<body class="bg-gray-100 min-h-screen">
  <div class="container mx-auto px-4 py-8">
    <div class="bg-white rounded-lg shadow-lg p-6 mb-6">
      <h1 class="text-2xl font-bold text-gray-800 mb-4">GLaDOS签到状态</h1>
      <div class="space-y-4">
        <div class="flex items-center justify-between">
          <span class="text-gray-600">上次签到:</span>
          <span id="lastCheck" class="text-gray-800">LAST_CHECK_TIME</span>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-gray-600">状态:</span>
          <span id="status" class="text-STATUS_COLOR-500">STATUS_TEXT</span>
        </div>
      </div>
    </div>
    <div class="bg-white rounded-lg shadow-lg p-6">
      <h2 class="text-xl font-bold text-gray-800 mb-4">账号状态</h2>
      <div id="accounts" class="space-y-4">ACCOUNTS_HTML</div>
    </div>
    <div class="mt-6 text-center">
      <button id="checkinBtn" class="bg-blue-500 hover:bg-blue-600 text-white font-bold py-2 px-4 rounded">
        手动签到
      </button>
    </div>
  </div>
  <script>
    document.getElementById("checkinBtn").addEventListener("click", async function() {
      try {
        const result = await Swal.fire({
          title: "确认签到?",
          text: "将尝试为所有账号签到",
          icon: "question",
          showCancelButton: true,
          confirmButtonText: "确定",
          cancelButtonText: "取消"
        });
        
        if (result.isConfirmed) {
          Swal.fire({
            title: "正在签到...",
            allowOutsideClick: false,
            didOpen: function() {
              Swal.showLoading();
            }
          });
          
          const response = await fetch("/checkin", { 
            method: "POST",
            headers: {
              'Content-Type': 'application/json'
            }
          });
          
          if (!response.ok) {
            throw new Error('网络响应不正常');
          }
          
          const data = await response.json();
          
          if (data.success) {
            let successMsg = "";
            data.results.forEach(function(item) {
              if (item.success) {
                successMsg += item.email + ": " + translateMessage(item.message) + "<br>";
              }
            });
            
            await Swal.fire({
              icon: "success",
              title: "签到成功",
              html: successMsg || "所有账号签到成功",
              timer: 3000
            });
            location.reload();
          } else {
            let errorMsg = "";
            data.results.forEach(function(item) {
              errorMsg += item.email + ": " + translateMessage(item.message) + "<br>";
            });
            
            await Swal.fire({
              icon: "error",
              title: "签到失败",
              html: errorMsg
            });
          }
        }
      } catch (error) {
        await Swal.fire({
          icon: "error",
          title: "请求失败",
          text: error.message
        });
      }
    });

    function translateMessage(msg) {
      if (!msg) return "未知状态";
      if (msg.includes("Got") && msg.includes("Points")) {
        const points = msg.match(/\\d+/)?.[0] || "0";
        return "✅ 签到成功，获得 " + points + " 积分";
      }
      if (msg.includes("Checkin Repeats")) return "⏰ 今日已签到";
      if (msg.includes("Please Checkin Tomorrow")) return "🔄 请明日再来";
      return msg;
    }
  </script>
</body>
</html>`;

async function sendTelegramNotification(env, message) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  
  try {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: message,
        disable_web_page_preview: true
      })
    });
  } catch (error) {
    console.error("Telegram通知发送失败:", error);
  }
}

async function handleRequest(env) {
  const stored = await env.GLADOS_KV.get("results");
  const results = stored ? JSON.parse(stored) : [];
  const lastCheck = await env.GLADOS_KV.get("lastCheck") || "尚未签到";
  
  let statusColor = "gray";
  let statusText = "未知状态";
  let accountsHtml = "";

  if (results.length > 0) {
    const allSuccess = results.every(function(r) { return r.success; });
    statusColor = allSuccess ? "green" : "red";
    statusText = allSuccess ? "全部成功" : "部分失败";
    
    accountsHtml = results.map(function(r) {
      const exchangeHtml = r.exchange && r.exchange.enabled ? `
        <div class="text-sm text-gray-500 mt-1">
          积分兑换(${r.exchange.plan}): ${
            r.exchange.attempted
              ? (r.exchange.success ? "✅ " : "❌ ") + (r.exchange.message || "未知结果")
              : "⏭️ 跳过（" + (r.exchange.skippedReason || "未触发") + "）"
          }
        </div>
      ` : "";
      return `
        <div class="account-item">
          <div class="flex items-center justify-between">
            <span class="font-medium">${r.email}</span>
            <span class="${r.success ? "success-text" : "error-text"}">
              ${r.success ? "✅" : "❌"} ${translateMessage(r.message)}
            </span>
          </div>
          ${(r.points !== undefined && r.points !== null) ? `
          <div class="text-sm text-gray-500 mt-1">
            当前积分: ${r.points}
          </div>
          ` : ""}
          ${(r.leftDays !== undefined && r.leftDays !== null) ? `
          <div class="text-sm text-gray-500 mt-1">
            剩余天数: ${r.leftDays}
          </div>
          ` : ""}
          ${exchangeHtml}
        </div>
      `;
    }).join("");
  } else {
    accountsHtml = '<div class="text-gray-500 py-4 text-center">暂无签到记录</div>';
  }

  const html = HTML_TEMPLATE
    .replace("LAST_CHECK_TIME", lastCheck)
    .replace("STATUS_COLOR", statusColor)
    .replace("STATUS_TEXT", statusText)
    .replace("ACCOUNTS_HTML", accountsHtml);

  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

async function handleCheckin(env) {
  const cookies = env.GLADOS_COOKIE.split("&");
  const results = [];
  let notificationMessage = "📋 GLaDOS签到结果\n\n";
  const baseUrl = GLADOS_BASE_URL;
  const tokens = getCheckinTokens(env);
  const exchangePlan = getExchangePlan(env);

  for (const cookie of cookies) {
    if (!cookie.trim()) continue;
    
    try {
      const trimmedCookie = cookie.trim();
      const headers = {
        cookie: trimmedCookie,
        "referer": `${baseUrl}/console/checkin`,
        "origin": baseUrl,
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "content-type": "application/json;charset=UTF-8"
      };

      let checkinData = null;
      let usedToken = null;
      let lastCheckinError = null;

      for (const token of tokens) {
        try {
          const data = await fetchJson(`${baseUrl}/api/user/checkin`, {
            method: "POST",
            headers: headers,
            body: JSON.stringify({ token })
          });

          if (!isCheckinSuccess(data)) {
            const msg = (data && (data.message || data.msg)) || "签到失败";
            throw new Error(msg);
          }

          checkinData = data;
          usedToken = token;
          break;
        } catch (e) {
          lastCheckinError = e;
        }
      }

      if (!checkinData) {
        throw lastCheckinError || new Error("签到请求失败");
      }
      let status = await fetchStatus(baseUrl, headers);
      const accountId = await getAccountIdFromCookie(trimmedCookie);

      let exchange = null;
      if (exchangePlan) {
        exchange = await maybeExchangePoints(env, baseUrl, headers, accountId, status);
        if (exchange && exchange.afterStatus) {
          status = exchange.afterStatus;
        }
      }

      // 3. 处理结果
      const result = {
        email: status.email,
        points: status.points,
        leftDays: status.leftDays,
        success: isCheckinSuccess(checkinData),
        message: checkinData.message || checkinData.msg || "签到失败",
        baseUrl: baseUrl,
        token: usedToken,
        time: nowChinaString(),
        exchange: exchange
      };
      
      results.push(result);
      notificationMessage += `${result.success ? "✅" : "❌"} ${result.email}: ${translateMessage(result.message)}\n`;
      if (result.points !== undefined && result.points !== null) notificationMessage += `   当前积分: ${result.points}\n`;
      if (result.leftDays !== undefined && result.leftDays !== null) {
        notificationMessage += `   剩余天数: ${result.leftDays}\n`;
      }
      if (exchangePlan && result.exchange) {
        if (!result.exchange.attempted) {
          notificationMessage += `   积分兑换(${result.exchange.plan}): 跳过（${result.exchange.skippedReason || "未触发"}）\n`;
        } else {
          notificationMessage += `   积分兑换(${result.exchange.plan}): ${result.exchange.success ? "成功" : "失败"}（${result.exchange.message || "无返回"}）\n`;
        }
      }
      notificationMessage += "\n";

    } catch (error) {
      const errorMessage = (error && error.message) ? error.message : String(error);
      const errorResult = {
        email: "未知账号",
        success: false,
        message: errorMessage,
        time: nowChinaString()
      };
      results.push(errorResult);
      notificationMessage += `❌ 未知账号: ${errorMessage}\n\n`;
    }
  }

  // 保存结果
  await env.GLADOS_KV.put("results", JSON.stringify(results));
  await env.GLADOS_KV.put("lastCheck", 
    nowChinaString()
  );

  // 发送Telegram通知
  await sendTelegramNotification(env, notificationMessage);

  return new Response(JSON.stringify({
    success: results.some(function(r) { return r.success; }),
    results: results
  }), {
    headers: { 
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

function translateMessage(msg) {
  if (!msg) return "未知状态";
  if (msg.includes("Got") && msg.includes("Points")) {
    const points = msg.match(/\d+/)?.[0] || "0";
    return "✅ 签到成功，获得 " + points + " 积分";
  }
  if (msg.includes("Checkin Repeats")) return "⏰ 今日已签到";
  if (msg.includes("Please Checkin Tomorrow")) return "🔄 请明日再来";
  if (msg.toLowerCase().includes("please checkin via")) return "⚠️ 需要通过新站点签到（Cookie/Token 可能需要更新）";
  return msg;
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
          }
        });
      }
      if (request.method === "POST" && url.pathname === "/checkin") {
        const response = await handleCheckin(env);
        return response;
      }
      return await handleRequest(env);
    } catch (error) {
      await sendTelegramNotification(env, `❌ 签到系统错误: ${error.message}`);
      return new Response(error.stack, { status: 500 });
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCheckin(env));
  }
};
