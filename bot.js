//Telegram Bot Worker v1.0

// --- 1. 静态配置与常量 ---  
const CACHE = {
  data: {},
  json: new Map(),
  admins: new Map(),
  groupCreatorId: null,
  groupCreatorCheckedAt: 0,
  groupCreatorPromise: null,
  setupAt: 0,
  setupPromise: null,
  ts: 0,
  ttl: 60000,
  loadPromise: null,
  locks: new Set(),
  cleanup: {
    processed_updates_ts: 0,
    ratelimits_ts: 0,
    messages_ts: 0,
    mappings_ts: 0
  }
};

const DB_INIT_PROMISES = new WeakMap();

const DEFAULTS = {
  // 基础  
  pre_welcome_messages: "[]",
  verified_welcome_messages: "[]",

  // 验证  
  enable_verify: "true",
  enable_qa_verify: "true",
  captcha_mode: "turnstile",
  verif_q: "1+1=?",
  verif_a: "2",

  // 转发开关  
  enable_image_forwarding: "true",
  enable_link_forwarding: "true",
  enable_text_forwarding: "true",
  enable_channel_forwarding: "true",
  enable_forward_forwarding: "true",
  enable_audio_forwarding: "true",
  enable_sticker_forwarding: "true",
  enable_other_forwarding: "true",

  // 就寝时间与自动回复
  enable_sleep_mode: "false",
  sleep_start: "23:00",
  sleep_end: "07:00",
  sleep_msg: "💤 我睡着了，醒来第一时间看你消息哦",
  block_keywords: "[]",
  keyword_responses: "[]",
};

const DELIVERED_REACTION = "👍";
const LOCKED_NOTICE = "❌ 你已被禁言";
const DEFAULT_PRE_WELCOME = "欢迎 {name}，请先完成验证";
const DEFAULT_VERIFIED_WELCOME = `是否想拥有同款bot？不要999，不要99，也不要9.9，点击下方链接免费带回家：\n<a href="https://github.com/Rude56/telegram-topic-bot">telegram-topic-bot</a>`;

// 幂等/限流/锁参数  
const PROCESSED_UPDATES_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RATELIMIT_CLEANUP_TTL_MS = 10 * 60 * 1000;
const RATELIMIT_USER_WINDOW_MS = 2000;
const RATELIMIT_USER_MAX = 6;
const RATELIMIT_GLOBAL_WINDOW_MS = 10000;
const RATELIMIT_GLOBAL_MAX = 250;
const SUBMIT_RL_WINDOW_MS = 60000;
const SUBMIT_RL_IP_MAX = 30;
const SUBMIT_RL_UID_MAX = 10;
const TOPIC_LOCK_STALE_MS = 60 * 1000;
const TOPIC_LOCK_POLL_MAX = 8;
const TOPIC_LOCK_POLL_BASE_MS = 160;
const VERIFY_NONCE_TTL_MS = 15 * 60 * 1000;
const MESSAGES_TTL_DAYS = 30;
const QA_MAX_FAILS = 5;
const QA_LOCK_MS = 10 * 60 * 1000;

// 判断是否为转发消息
const isForwardedMessage = m => !!(m?.forward_origin || m?.forward_from || m?.forward_from_chat);

const MSG_TYPES = [
  {
    check: m => isForwardedMessage(m),
    key: "enable_forward_forwarding",
    prompt: "⚠️ 暂不接收转发消息",
    extraKey: m => (m.forward_from_chat?.type === "channel" || m.forward_origin?.chat?.type === "channel") ? "enable_channel_forwarding" : null,
    extraPrompt: "⚠️ 暂不接收频道转发消息"
  },
  { check: m => m.audio || m.voice, key: "enable_audio_forwarding", prompt: "⚠️ 暂不接收语音或音频消息" },
  { check: m => m.sticker || m.animation, key: "enable_sticker_forwarding", prompt: "⚠️ 暂不接收贴纸或 GIF 动画" },
  { check: m => m.photo || m.video || m.video_note || m.document, key: "enable_image_forwarding", prompt: "⚠️ 暂不接收图片、视频或文件" },
  { check: m => [...(m.entities || []), ...(m.caption_entities || [])].some(e => ["url", "text_link"].includes(e.type)), key: "enable_link_forwarding", prompt: "⚠️ 暂不接收包含链接的消息" },
  { check: m => !!m.text, key: "enable_text_forwarding", prompt: "⚠️ 暂不接收文字消息" },
  { check: m => !!(m.poll || m.checklist || m.location || m.venue || m.contact || m.dice || m.game || m.story || m.invoice || m.successful_payment), key: "enable_other_forwarding", prompt: "⚠️ 暂不接收投票、清单、位置等消息" }
];

// --- 2. 核心入口 ---  
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    try {
      await dbInit(env);
      if (req.method === "GET") {
        if (url.pathname === "/verify") return handleVerifyPage(url, env);
        if (url.pathname === "/") return new Response("✅ 机器人运行正常（Bot v1.0）", { status: 200 });
      }

      if (req.method === "POST") {
        if (url.pathname === "/submit_token") return handleTokenSubmit(req, env, ctx);

        if (!isTelegramWebhook(req, env)) {
          return new Response("❌ 拒绝访问（密钥不匹配）", { status: 403 });
        }

        try {
          const update = await req.json();
          const ok = await markUpdateOnce(update, env, ctx);
          if (!ok) return new Response("OK");

          ctx.waitUntil(handleUpdate(update, env, ctx));
          return new Response("OK");
        } catch {
          return new Response("❌ 请求格式不正确", { status: 400 });
        }
      }
    } catch (e) {
      console.error("Critical Worker Error:", e);
      return new Response("❌ 机器人内部错误，请稍后重试", { status: 500 });
    }

    return new Response("❌ 页面不存在（Bot v1.0）", { status: 404 });
  }
};

// --- 3. 数据库封装 ---  
const safeParse = (str, fb = {}) => {
  try { return JSON.parse(str); } catch { return fb; }
};

const sql = async (env, query, args = [], type = "run") => {
  try {
    const stmt = env.TG_BOT_DB.prepare(query).bind(...(Array.isArray(args) ? args : [args]));
    return type === "run" ? await stmt.run() : await stmt[type]();
  } catch (e) {
    console.error(`SQL Fail [${query}]:`, e);
    if (query.match(/^(INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE)/i)) throw e;
    return null;
  }
};

const tryRun = async (env, query, args = []) => {
  try {
    const stmt = env.TG_BOT_DB.prepare(query).bind(...(Array.isArray(args) ? args : [args]));
    return await stmt.run();
  } catch { return null; }
};

// 环境变量兜底键名：这几个键在 Cloudflare 里用 *_QUESTION / *_ANSWER / *_MESSAGE 命名
const ENV_KEY_MAP = { verif_q: "VERIF_QUESTION", verif_a: "VERIF_ANSWER", sleep_msg: "SLEEP_MESSAGE" };
const cfgEnvKey = k => ENV_KEY_MAP[k] || k.toUpperCase();

async function getCfg(k, env) {
  const now = Date.now();
  if (CACHE.ts && now - CACHE.ts < CACHE.ttl) {
    const envK = cfgEnvKey(k);
    return CACHE.data[k] ?? (env[envK] || DEFAULTS[k] || "");
  }

  if (!CACHE.loadPromise) {
    CACHE.loadPromise = sql(env, "SELECT key, value FROM config", [], "all").then(rows => {
      if (!rows?.results) return false;
      const data = Object.create(null);
      for (const row of rows.results) data[row.key] = row.value;
      CACHE.data = data;
      CACHE.ts = Date.now();
      return true;
    }).finally(() => { CACHE.loadPromise = null; });
  }
  await CACHE.loadPromise;
  const envK = cfgEnvKey(k);
  return CACHE.data[k] ?? (env[envK] || DEFAULTS[k] || "");
}

async function setCfg(k, v, env) {
  await sql(env, "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", [k, v]);
  CACHE.ts = 0;
  CACHE.json.delete(k);
}

async function getUser(id, env) {
  let u = await sql(env, "SELECT * FROM users WHERE user_id = ?", id, "first");
  if (!u) {
    try {
      await sql(env, "INSERT OR IGNORE INTO users (user_id, user_state, user_info_json) VALUES (?, 'new', ?)", [id, "{}"]);
    } catch { } // 并发下被别人抢先插入时，下面的 SELECT 会读到
    u = await sql(env, "SELECT * FROM users WHERE user_id = ?", id, "first");
  }
  if (!u) {
    u = { user_id: id, user_state: "new", topic_locked: 0, topic_id: null, user_info_json: "{}", topic_creating: 0, topic_create_ts: 0 };
  }
  u.topic_locked = !!u.topic_locked;
  u.user_info = safeParse(u.user_info_json, {});
  u.topic_creating = !!u.topic_creating;
  u.topic_create_ts = u.topic_create_ts || 0;
  return u;
}

async function mergeUserInfo(id, patch, env) {
  const row = await sql(env, "SELECT user_info_json FROM users WHERE user_id = ?", id, "first");
  const cur = safeParse(row?.user_info_json || "{}", {});
  const merged = { ...(cur && typeof cur === "object" ? cur : {}), ...(patch && typeof patch === "object" ? patch : {}) };
  return JSON.stringify(merged);
}

async function updUser(id, data, env) {
  if (data.user_info) {
    data.user_info_json = await mergeUserInfo(id, data.user_info, env);
    delete data.user_info;
  }
  const keys = Object.keys(data);
  if (!keys.length) return;
  const safeKeys = keys.filter(k => ["user_state", "topic_locked", "topic_id", "user_info_json", "topic_creating", "topic_create_ts"].includes(k));
  if (!safeKeys.length) return;
  const q = `UPDATE users SET ${safeKeys.map(k => `${k}=?`).join(",")} WHERE user_id=?`;
  const v = [...safeKeys.map(k => (typeof data[k] === "boolean" ? (data[k] ? 1 : 0) : data[k])), id];
  try { await sql(env, q, v); } catch (e) { console.error("Update User Failed:", e); }
}

async function dbInit(env) {
  const db = env.TG_BOT_DB;
  if (!db) return;
  let initPromise = DB_INIT_PROMISES.get(db);
  if (!initPromise) {
    initPromise = initializeDatabase(env);
    DB_INIT_PROMISES.set(db, initPromise);
  }
  try {
    await initPromise;
  } catch (e) {
    if (DB_INIT_PROMISES.get(db) === initPromise) DB_INIT_PROMISES.delete(db);
    throw e;
  }
}

async function initializeDatabase(env) {
  await env.TG_BOT_DB.batch([
    env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`),
    env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY, user_state TEXT DEFAULT 'new', topic_locked INTEGER DEFAULT 0,
      topic_id TEXT, user_info_json TEXT DEFAULT '{}', topic_creating INTEGER DEFAULT 0, topic_create_ts INTEGER DEFAULT 0
    )`),
    env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS messages (
      user_id TEXT, message_id TEXT, date INTEGER, PRIMARY KEY (user_id, message_id)
    )`),
    env.TG_BOT_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date)`),
    env.TG_BOT_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_user_date ON messages(user_id, date)`),
    env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS processed_updates (update_id TEXT PRIMARY KEY, ts INTEGER)`),
    env.TG_BOT_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_processed_updates_ts ON processed_updates(ts)`),
    env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS ratelimits (key TEXT PRIMARY KEY, ts INTEGER, count INTEGER)`),
    env.TG_BOT_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ratelimits_ts ON ratelimits(ts)`),
    env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS msg_mapping (
      user_id TEXT, user_msg_id TEXT, admin_msg_id TEXT, ts INTEGER, PRIMARY KEY (user_id, user_msg_id)
    )`),
    env.TG_BOT_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_admin_msg_mapping ON msg_mapping(admin_msg_id)`),
    env.TG_BOT_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_msg_mapping_user_ts ON msg_mapping(user_id, ts)`),
    env.TG_BOT_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_users_topic_id ON users(topic_id)`)
  ]);
}

// --- 4. Telegram API ---  
async function api(token, method, body) {
  const maxRetries = 3;
  const baseBackoff = [200, 500, 1200];
  const totalWaitCapMs = 10000;
  let waited = 0;

  const waitBeforeRetry = async delayMs => {
    if (waited + delayMs > totalWaitCapMs) return false;
    waited += delayMs;
    await sleep(delayMs);
    return true;
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response;
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (e) {
      if (attempt < maxRetries && await waitBeforeRetry(baseBackoff[attempt] || 1200)) continue;
      if (method !== "setMessageReaction") console.warn(`TG API network failure [${method}]:`, e?.message || e);
      throw e;
    }

    let data;
    try {
      data = await response.json();
    } catch (e) {
      if (attempt < maxRetries && await waitBeforeRetry(baseBackoff[attempt] || 1200)) continue;
      if (method !== "setMessageReaction") console.warn(`TG API invalid response [${method}]`);
      throw new Error(`Invalid Telegram response: ${method}`);
    }

    const errorCode = Number(data?.error_code || response.status || 0);
    if (response.status === 429 || errorCode === 429) {
      const description = data?.description || `Telegram rate limit [${method}]`;
      if (attempt < maxRetries) {
        const retryAfterSec = Number(data?.parameters?.retry_after || 0);
        const delayMs = Math.min(totalWaitCapMs, Math.max(200, retryAfterSec * 1000 || baseBackoff[attempt] || 1200));
        if (await waitBeforeRetry(delayMs)) continue;
      }
      if (method !== "setMessageReaction") console.warn(`TG API rate limit [${method}]:`, description);
      throw new Error(description);
    }

    if (response.status >= 500) {
      if (attempt < maxRetries && await waitBeforeRetry(baseBackoff[attempt] || 1200)) continue;
      const error = new Error(`HTTP_${response.status}`);
      if (method !== "setMessageReaction") console.warn(`TG API server failure [${method}]:`, error.message);
      throw error;
    }

    if (!data?.ok) {
      const description = data?.description || `TG API Error (${errorCode})`;
      if (method !== "setMessageReaction") console.warn(`TG API Error [${method}]:`, description);
      throw new Error(description);
    }
    return data.result;
  }
  throw new Error(`TG API Retry Exhausted: ${method}`);
}

// --- 5. Webhook 校验 / 幂等 / 限流 / 清理 ---  
function isTelegramWebhook(req, env) {
  const secret = (env.TELEGRAM_WEBHOOK_SECRET || "").toString();
  if (!secret) return false;
  const hdr = req.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  return timingSafeEqualStr(hdr, secret);
}

function safeWaitUntil(ctx, p) {
  try { if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p); else p.catch(() => { }); } catch { try { p.catch(() => { }); } catch { } }
}

function scheduleCommandDeletion(msg, env, ctx) {
  if (!msg || msg.from?.is_bot || !msg.text) return;
  if (msg.chat.type === "private") return;
  const match = msg.text.trim().match(/^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s|$)/);
  if (!match) return;
  safeWaitUntil(ctx, api(env.BOT_TOKEN, "deleteMessage", {
    chat_id: msg.chat.id,
    message_id: msg.message_id
  }).catch(() => { }));
}

// 同一 key 在 ttl 毫秒内只执行一次（冷却提示、送达表态等）
function claimOnce(key, ttlMs) {
  if (CACHE.locks.has(key)) return false;
  CACHE.locks.add(key);
  setTimeout(() => CACHE.locks.delete(key), ttlMs);
  return true;
}

function sendTemporaryMessage(env, ctx, payload, delayMs = 10000) {
  return api(env.BOT_TOKEN, "sendMessage", payload).then(sent => {
    if (sent?.message_id != null) {
      const cleanup = sleep(delayMs).then(() => api(env.BOT_TOKEN, "deleteMessage", {
        chat_id: payload.chat_id,
        message_id: sent.message_id
      }).catch(() => { }));
      safeWaitUntil(ctx, cleanup);
    }
    return sent;
  });
}

function maybeCleanup(ctx, key, fn, minIntervalMs) {
  const now = Date.now();
  const last = CACHE.cleanup[key] || 0;
  if (now - last < minIntervalMs) return;
  CACHE.cleanup[key] = now;
  safeWaitUntil(ctx, fn());
}

async function markUpdateOnce(update, env, ctx) {
  try {
    const uid = (update && (update.update_id ?? update.updateId))?.toString();
    if (!uid) return true;
    const now = Date.now();
    const res = await tryRun(env, "INSERT OR IGNORE INTO processed_updates (update_id, ts) VALUES (?,?)", [uid, now]);
    if (!res) return true; // 数据库暂时不可用时继续处理，避免误判为重复更新
    const changes = res?.meta?.changes ?? res?.changes ?? 0;
    if (!changes) return false;
    if ((now % 97) === 7) {
      maybeCleanup(ctx, "processed_updates_ts", async () => {
        const cutoff = now - PROCESSED_UPDATES_TTL_MS;
        await sql(env, "DELETE FROM processed_updates WHERE ts < ?", [cutoff]);
      }, 60_000);
    }
    return true;
  } catch { return true; }
}

async function bumpRateKey(env, key, now) {
  const q = `INSERT INTO ratelimits (key, ts, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET count = ratelimits.count + 1, ts = excluded.ts RETURNING count`;
  const row = await sql(env, q, [key, now], "first");
  return Number(row?.count || 0);
}

async function checkRateLimit(userId, env, ctx) {
  const now = Date.now();
  const uid = userId?.toString() || "";
  if (!uid) return { allowed: true, retryAfterMs: 0 };
  const userBucket = Math.floor(now / RATELIMIT_USER_WINDOW_MS);
  const globalBucket = Math.floor(now / RATELIMIT_GLOBAL_WINDOW_MS);
  const userKey = `u:${uid}:${userBucket}`;
  const globalKey = `g:${globalBucket}`;
  const [uc, gc] = await Promise.all([bumpRateKey(env, userKey, now), bumpRateKey(env, globalKey, now)]);
  if ((now % 101) === 13) {
    maybeCleanup(ctx, "ratelimits_ts", async () => {
      const cutoff = now - RATELIMIT_CLEANUP_TTL_MS;
      await sql(env, "DELETE FROM ratelimits WHERE ts < ?", [cutoff]);
    }, 60_000);
  }
  if (gc > RATELIMIT_GLOBAL_MAX) return { allowed: false, retryAfterMs: RATELIMIT_GLOBAL_WINDOW_MS };
  if (uc > RATELIMIT_USER_MAX) return { allowed: false, retryAfterMs: RATELIMIT_USER_WINDOW_MS };
  return { allowed: true, retryAfterMs: 0 };
}

async function checkSubmitRateLimit(req, env, ctx, uidMaybe, countIp = true) {
  const now = Date.now();
  const bucket = Math.floor(now / SUBMIT_RL_WINDOW_MS);
  if (countIp) {
    const ip = (req.headers.get("CF-Connecting-IP") || req.headers.get("X-Forwarded-For") || "").split(",")[0].trim() || "0.0.0.0";
    const ipCount = await bumpRateKey(env, `s:ip:${ip}:${bucket}`, now);
    if (ipCount > SUBMIT_RL_IP_MAX) return { allowed: false, reason: "ip" };
  }
  if (uidMaybe) {
    const uidCount = await bumpRateKey(env, `s:u:${uidMaybe}:${bucket}`, now);
    if (uidCount > SUBMIT_RL_UID_MAX) return { allowed: false, reason: "uid" };
  }
  if ((now % 113) < 3) {
    maybeCleanup(ctx, "ratelimits_ts", async () => {
      await sql(env, "DELETE FROM ratelimits WHERE ts < ?", [now - RATELIMIT_CLEANUP_TTL_MS]);
    }, 60000);
  }
  return { allowed: true };
}

function maybeCleanupMessages(env, ctx) {
  const now = Date.now();
  if ((now % 131) !== 11) return;
  maybeCleanup(ctx, "messages_ts", async () => {
    const cutoffSec = Math.floor(now / 1000) - MESSAGES_TTL_DAYS * 86400;
    await sql(env, "DELETE FROM messages WHERE date < ?", [cutoffSec]);
  }, 10 * 60_000);
}

// 定期清理过期消息映射
function maybeCleanupMappings(env, ctx) {
  const now = Date.now();
  if ((now % 137) !== 19) return;
  maybeCleanup(ctx, "mappings_ts", async () => {
    await sql(env, "DELETE FROM msg_mapping WHERE ts < ?", [now - MESSAGES_TTL_DAYS * 86400000]);
  }, 10 * 60_000);
}

// --- 6. 主 update 分发 ---  
async function handleUpdate(update, env, ctx) {
  if (update.message_reaction) {
    return handleReactionSync(update.message_reaction, env);
  }

  const msg = update.message || update.edited_message;
  if (!msg) return update.callback_query ? handleCallback(update.callback_query, env, ctx) : null;
  if (update.message) scheduleCommandDeletion(msg, env, ctx);

  // 管理员在 Telegram 中关闭/重新打开话题时，同步用户是否被禁言
  if (update.message && msg.chat.id.toString() === env.ADMIN_GROUP_ID && msg.message_thread_id && (msg.forum_topic_closed || msg.forum_topic_reopened)) {
    const uid = (await sql(env, "SELECT user_id FROM users WHERE topic_id = ?", msg.message_thread_id.toString(), "first"))?.user_id;
    if (uid) await updUser(uid, { topic_locked: !!msg.forum_topic_closed }, env);
    return;
  }

  if (update.message && msg.text && msg.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase() === "/del") {
    return handleDeleteSync(msg, env, ctx);
  }
  if (update.edited_message) {
    return handleEditSync(update.edited_message, env);
  }

  if (msg.chat.type === "private") await handlePrivate(msg, env, ctx);
  else if (msg.chat.id.toString() === env.ADMIN_GROUP_ID) await handleAdminReply(msg, env, ctx);
}

// --- 7. 管理员集合 ---  
async function getGroupCreatorId(env) {
  if (!env.ADMIN_GROUP_ID) return null;
  const now = Date.now();
  if (CACHE.groupCreatorCheckedAt > now - 60000) return CACHE.groupCreatorId;
  if (CACHE.groupCreatorPromise) return CACHE.groupCreatorPromise;
  CACHE.groupCreatorPromise = (async () => {
    let ok = false;
    try {
      const members = await api(env.BOT_TOKEN, "getChatAdministrators", { chat_id: env.ADMIN_GROUP_ID });
      const creator = Array.isArray(members) ? members.find(member => member?.status === "creator") : null;
      CACHE.groupCreatorId = creator?.user?.id?.toString() || null;
      ok = true;
    } catch (e) {
      // 失败时保留上一次结果，并只退避 10 秒，避免一次网络抖动导致所有者 60 秒进不了面板
      console.warn("管理群组创建者查询失败:", e?.message || e);
    }
    CACHE.groupCreatorCheckedAt = ok ? Date.now() : Date.now() - 50000;
    CACHE.groupCreatorPromise = null;
    return CACHE.groupCreatorId;
  })();
  return CACHE.groupCreatorPromise;
}

// 所有者由 Cloudflare 变量 ADMIN_IDS 决定，多个 ID 用英文逗号分隔
function getOwnerIds(env) {
  return (env.ADMIN_IDS || "").toString().split(/[,，;；\s]+/).map(v => v.trim()).filter(Boolean);
}

async function isGroupCreator(id, env) {
  const uid = (id ?? "").toString();
  const owners = getOwnerIds(env);
  // 未配置 ADMIN_IDS 时回退为管理群组创建者，避免没有人能打开控制面板
  if (owners.length) return owners.includes(uid);
  const creatorId = await getGroupCreatorId(env);
  return !!creatorId && creatorId === uid;
}

async function isAuthAdmin(id, env) {
  if (!env.ADMIN_GROUP_ID || !id) return false;
  const key = `${env.ADMIN_GROUP_ID}:${id}`;
  const now = Date.now();
  const cached = CACHE.admins.get(key);
  if (cached && cached.expiresAt > now) return cached.isAdmin;
  try {
    const member = await api(env.BOT_TOKEN, "getChatMember", { chat_id: env.ADMIN_GROUP_ID, user_id: id });
    const isAdmin = member?.status === "administrator" || member?.status === "creator";
    if (CACHE.admins.size >= 1024) {
      for (const [cacheKey, item] of CACHE.admins) if (item.expiresAt <= now) CACHE.admins.delete(cacheKey);
      if (CACHE.admins.size >= 1024) CACHE.admins.delete(CACHE.admins.keys().next().value);
    }
    CACHE.admins.set(key, { isAdmin, expiresAt: now + 10000 });
    return isAdmin;
  } catch (e) {
    console.warn("群组管理员身份检查失败:", e?.message || e);
    return false;
  }
}

// ===== /help 文案 =====
const OWNER_HELP_TEXT = `/start 控制面板
/help 帮助
/delete_topic+用户ID 删除该用户话题并清空其数据
撤回消息不要直接删除，使用/del 命令 
锁定话题可以给用户禁言`;

// 生成“确认删除话题”的提示与按钮
function topicDeletePrompt(prefix, uid, topicId) {
  return {
    text: `⚠️ 即将删除用户 ${uid} 的话题（话题ID ${topicId}）及机器人保存的全部数据，无法撤销。请确认：`,
    reply_markup: { inline_keyboard: [[
      { text: "‼️ 确认删除话题和数据", callback_data: `${prefix}:confirm:${uid}:${topicId}` },
      { text: "取消", callback_data: `${prefix}:cancel:${uid}:${topicId}` }
    ]] }
  };
}

// --- 8. 私聊处理 ---  
async function handlePrivate(msg, env, ctx) {
  const id = msg.chat.id.toString();
  const text = msg.text || "";
  const command = text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
  const isStart = command === "/start";
  const u0 = await getUser(id, env);
  const isCreator = await isGroupCreator(id, env);

  if (command === "/help") {
    if (!isCreator) return sendTemporaryMessage(env, ctx, { chat_id: id, text: "❌ 该命令仅所有者可用。" });
    return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: OWNER_HELP_TEXT, parse_mode: "HTML" });
  }

  if (command === "/delete_topic") {
    if (!isCreator) return sendTemporaryMessage(env, ctx, { chat_id: id, text: "❌ 该命令仅所有者可用。" });
    const target = text.trim().split(/\s+/)[1] || "";
    if (!/^\d+$/.test(target)) return sendTemporaryMessage(env, ctx, { chat_id: id, text: "用法：/delete_topic <用户ID>" });
    const uid = target;
    const user = await getUser(uid, env);
    if (!user?.topic_id) return sendTemporaryMessage(env, ctx, { chat_id: id, text: "未找到该用户，或该用户没有关联的话题" });
    const topicId = user.topic_id.toString();
    return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, ...topicDeletePrompt("ptopic_delete", uid, topicId) });
  }


  if (u0.topic_locked) {
    if (claimOnce(`blocked_notice:${id}`, 10000)) safeWaitUntil(ctx, api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: LOCKED_NOTICE }).catch(() => {}));
    return;
  }

  const rl = await checkRateLimit(id, env, ctx);
  if (!rl.allowed) {
    if (claimOnce(`rlwarn:${id}`, 10000)) safeWaitUntil(ctx, api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "⏳ 请求过于频繁，请稍后再试" }).catch(() => {}));
    return;
  }

  if (isStart && isCreator) {
    if (ctx) scheduleBotSetup(ctx, env);
    return handleAdminConfig(id, null, "menu", null, null, env);
  }


  if (isCreator) {
    const stateStr = await getCfg(`admin_state:${id}`, env);
    if (stateStr) {
      const state = safeParse(stateStr);
      if (state.action === "input" || state.action === "collect_qa_question" || state.action === "collect_qa_answer") return handleAdminInput(id, msg, state, env);
      if (state.action === "collect_verified_welcome" || state.action === "collect_pre_welcome") return handleWelcomeMessagesSetupInput(id, msg, state, env);
      if (state.action === "collect_block_keywords" || state.action === "collect_auto_reply") return handleAdminBatchSetupInput(id, msg, state, env);
    }
  }

  // 除 /start 外的命令一律忽略
  if (command.startsWith("/") && !isStart) return;

  const verifyOn = await getBool("enable_verify", env);
  const qaOn = await getBool("enable_qa_verify", env);
  if (isCreator) return;

  if (u0.user_state !== "verified" && (verifyOn || qaOn)) {
    if (u0.user_state === "pending_verification") {
      if (text) return verifyAnswer(id, text, env);
      return sendTemporaryMessage(env, ctx, { chat_id: id, text: "请发送文字答案完成验证" });
    }
    return sendStart(id, msg, env);
  }

  if (isStart) {
    await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: u0.topic_id ? "✅ <b>会话已连接</b>\n可以直接发送消息" : "✅ 已验证\n请直接发送消息以联系管理员", parse_mode: "HTML" });
    return;
  }

  await handleVerifiedMsg(msg, u0, env, ctx, false);
}

async function forceResetUserVerify(userId, env) {
  const uid = userId.toString();
  await updUser(uid, { user_state: "new", user_info: { verify_nonce: "", verify_nonce_ts: 0 } }, env);
}

async function deleteUserData(userId, env) {
  const uid = userId.toString();
  const cutoffMs = Date.now() - 48 * 60 * 60 * 1000;
  const cutoffSec = Math.floor(cutoffMs / 1000);
  const rows = await sql(env,
    "SELECT user_msg_id AS message_id FROM msg_mapping WHERE user_id = ? AND ts >= ? UNION SELECT message_id FROM messages WHERE user_id = ? AND date >= ?",
    [uid, cutoffMs, uid, cutoffSec], "all");
  const recentMessageIds = [...new Set((rows?.results || []).map(r => r.message_id?.toString()).filter(Boolean))];

  // Telegram allows bots to delete incoming and outgoing private messages only within 48 hours.
  for (let i = 0; i < recentMessageIds.length; i += 10) {
    const batch = recentMessageIds.slice(i, i + 10);
    await Promise.allSettled(batch.map(message_id => api(env.BOT_TOKEN, "deleteMessage", {
      chat_id: uid,
      message_id
    })));
  }

  await env.TG_BOT_DB.batch([
    env.TG_BOT_DB.prepare("DELETE FROM msg_mapping WHERE user_id = ?").bind(uid),
    env.TG_BOT_DB.prepare("DELETE FROM messages WHERE user_id = ?").bind(uid),
    env.TG_BOT_DB.prepare("DELETE FROM ratelimits WHERE key LIKE ? OR key LIKE ?").bind(`u:${uid}:%`, `s:u:${uid}:%`),
    env.TG_BOT_DB.prepare("DELETE FROM config WHERE key = ?").bind(`admin_state:${uid}`),
    env.TG_BOT_DB.prepare("DELETE FROM users WHERE user_id = ?").bind(uid)
  ]);
  CACHE.ts = 0;
}

// --- 9. Start 流程 ---  
async function sendStart(id, msg, env) {
  const u = await getUser(id, env);
  if (u.topic_locked) return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: LOCKED_NOTICE }).catch(() => { });

  if (u.user_state === "verified") {
    return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: u.topic_id ? "✅ <b>会话已连接</b>" : "✅ 已验证", parse_mode: "HTML" });
  }

  // 已在验证页流程里的用户不再重复发欢迎语，避免刷屏
  if (u.user_state !== "pending_turnstile") {
    const savedPreWelcome = safeParse(await getCfg("pre_welcome_messages", env), []);
    if (Array.isArray(savedPreWelcome) && savedPreWelcome.length) {
      await copySavedMessagesToChat(id, savedPreWelcome, "验证前欢迎语", env);
    } else {
      const name = escapeHTML(msg.from.first_name || "User");
      const text = DEFAULT_PRE_WELCOME.replace(/{name}|{user}/g, name);
      await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text, parse_mode: "HTML" });
    }
  }

  const url = (env.WORKER_URL || "").replace(/\/$/, "");
  const vOn = await getBool("enable_verify", env);
  const qaOn = await getBool("enable_qa_verify", env);

  if (vOn && url) {
    // 验证按钮在有效期内复用同一个 nonce，重复发消息不会再让已打开的验证页失效
    const savedNonce = (u.user_info?.verify_nonce || "").toString();
    const savedTs = Number(u.user_info?.verify_nonce_ts || 0);
    const reuseNonce = /^[a-z0-9]{24}$/i.test(savedNonce) && savedTs > 0 && Date.now() - savedTs <= VERIFY_NONCE_TTL_MS;
    const nonce = reuseNonce ? savedNonce : genNonce(24);
    await updUser(id, { user_state: "pending_turnstile", user_info: { verify_nonce: nonce, verify_nonce_ts: reuseNonce ? savedTs : Date.now() } }, env);
    await api(env.BOT_TOKEN, "sendMessage", {
      chat_id: id, text: "🛡️ <b>安全验证</b>\n请点击下方按钮完成验证", parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "点击进行验证", web_app: { url: `${url}/verify?user_id=${encodeURIComponent(id)}&nonce=${encodeURIComponent(nonce)}` } }]] }
    });
  } else if (qaOn) {
    await updUser(id, { user_state: "pending_verification" }, env);
    await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "❓ <b>安全提问</b>\n" + escapeHTML(await getCfg("verif_q", env)), parse_mode: "HTML" });
  } else {
    await updUser(id, { user_state: "verified" }, env);
    await sendVerifiedWelcome(id, env);
  }
}

async function copySavedMessagesToChat(chatId, saved, label, env) {
  for (const item of Array.isArray(saved) ? saved : []) {
    if (!item?.owner_id || !item?.message_id) continue;
    try {
      await api(env.BOT_TOKEN, "copyMessage", {
        chat_id: chatId,
        from_chat_id: item.owner_id,
        message_id: item.message_id
      });
    } catch (e) {
      console.error(`${label}发送失败:`, e?.message || e);
    }
  }
}

// --- 10. 已验证用户逻辑 ---  
async function handleVerifiedMsg(msg, u, env, ctx, isAdmin = false) {
  const id = u.user_id;
  if (u.topic_locked && !isAdmin) return;
  const text = msg.text || msg.caption || "";

  // 以 / 开头的消息一律不转发
  if (text.trim().startsWith("/")) return;

  if (text) {
    const kws = await getJsonCfg("block_keywords", env);
    const hit = (Array.isArray(kws) ? kws : []).some(item => {
      const word = item?.word?.toString().trim();
      return !!word && text.toLocaleLowerCase().includes(word.toLocaleLowerCase());
    });
    if (hit) {
      return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "⚠️ 消息包含屏蔽词，未转发" });
    }
  }

  for (const t of MSG_TYPES) {
    if (!t.check(msg)) continue;
    if (!isAdmin && !(await getBool(t.key, env))) {
      return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: t.prompt });
    }
    const extraKey = t.extraKey?.(msg);
    if (!isAdmin && extraKey && !(await getBool(extraKey, env))) {
      return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: t.extraPrompt });
    }
  }

  if (text) {
    const rules = await getJsonCfg("keyword_responses", env);
    const normalizedText = text.toLocaleLowerCase();
    const match = (Array.isArray(rules) ? rules : []).find(rule => rule?.keywords && normalizedText.includes(rule.keywords.toLocaleLowerCase()));
    if (match) {
      if (match.response && typeof match.response === "object" && match.response.message_id) {
        safeWaitUntil(ctx, api(env.BOT_TOKEN, "copyMessage", { chat_id: id, from_chat_id: match.response.owner_id, message_id: match.response.message_id }).catch(() => {}));
      }
    }
  }
  let deliveryEmoji = DELIVERED_REACTION; // 默认为 👍
  // 就寝时间逻辑
  if (await getBool("enable_sleep_mode", env)) {
    const now = new Date();
    const currentTime = now.toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }).slice(0, 5);
    const start = await getCfg("sleep_start", env);
    const end = await getCfg("sleep_end", env);  
    
    let isSleeping = false;
    if (start <= end) isSleeping = (currentTime >= start && currentTime <= end);
    else isSleeping = (currentTime >= start || currentTime <= end);

    if (isSleeping) {
      deliveryEmoji = "😴"; // 就寝时切换表情
      const nowTs = Date.now();
      if (nowTs - (u.user_info.last_sleep_reply || 0) > 300000) {
        safeWaitUntil(ctx, api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: (await getCfg("sleep_msg", env)) }).catch(() => {}));
        await updUser(id, { user_info: { last_sleep_reply: nowTs } }, env);
      }
    }
  }  
  // 转发时带上表情参数
  await relayToTopic(msg, u, env, ctx, deliveryEmoji, isAdmin);
}

// 转发消息保留来源：优先 forwardMessage；受保护内容等无法转发时退回 copyMessage
async function sendRelayMessage(env, fromChatId, messageId, targetChatId, threadId, replyParams, keepSource) {
  if (keepSource) {
    try {
      return await api(env.BOT_TOKEN, "forwardMessage", {
        chat_id: targetChatId,
        from_chat_id: fromChatId,
        message_id: messageId,
        message_thread_id: threadId
      });
    } catch (e) {
      const reason = String(e?.message || "");
      // 话题不存在时直接抛出，交给调用方走“重建话题”逻辑；其他原因退回复制
      if (/message thread not found|thread not found|topic.*(not found|deleted|invalid)/i.test(reason)) throw e;
      console.warn("forwardMessage 失败，改用 copyMessage:", reason);
    }
  }
  return api(env.BOT_TOKEN, "copyMessage", {
    chat_id: targetChatId,
    from_chat_id: fromChatId,
    message_id: messageId,
    message_thread_id: threadId,
    reply_parameters: replyParams
  });
}

// --- 11. 转发到话题 ---
async function relayToTopic(msg, u, env, ctx, emoji, isAdmin = false, retried = false) {
  const uid = u.user_id;
  if (u.topic_locked && !isAdmin) return;
  const uMeta = getUMeta(msg.from, u, msg.date);
  let tid = u.topic_id;

  // 话题创建逻辑
  if (!tid) {
      const now = Date.now();
      const staleBefore = now - TOPIC_LOCK_STALE_MS;
      const lockRes = await tryRun(env, `UPDATE users SET topic_creating=1, topic_create_ts=? WHERE user_id=? AND (topic_id IS NULL OR topic_id='') AND (topic_creating=0 OR topic_create_ts < ?)`, [now, uid, staleBefore]);
      const locked = (lockRes?.meta?.changes ?? lockRes?.changes ?? 0) === 1;

      if (locked) {
        try {
          const fresh = await getUser(uid, env);
          if (fresh.topic_id) { tid = fresh.topic_id; }
          else {
            // 定义颜色列表
            const colors = [7322096, 16766590, 13338331, 9367192, 16749490, 16478047];
            // 随机选择一个颜色
            const randomColor = colors[Math.floor(Math.random() * colors.length)];
            
            const t = await api(env.BOT_TOKEN, "createForumTopic", { 
              chat_id: env.ADMIN_GROUP_ID, 
              name: uMeta.topicName,
              icon_color: randomColor // 设置随机颜色
            });
            
            tid = t.message_thread_id.toString();
            await updUser(uid, { topic_id: tid, topic_creating: 0, topic_create_ts: 0 }, env);
            u.topic_id = tid;
            await sendInfoCardToTopic(env, u, msg.from, tid);
          }
          } catch (e) {
              console.error("Topic Create Error:", e);
              await updUser(uid, { topic_creating: 0 }, env);
              const existUser = await getUser(uid, env);
              if (existUser.topic_id) tid = existUser.topic_id;
              else return api(env.BOT_TOKEN, "sendMessage", { chat_id: uid, text: "⚠️ 系统繁忙,请稍后重试" });
          }
      } else {
          for (let i = 0; i < TOPIC_LOCK_POLL_MAX; i++) {
              await sleep(Math.min(1500, TOPIC_LOCK_POLL_BASE_MS * Math.pow(2, i)) + Math.floor(Math.random() * 60));
              const fresh = await getUser(uid, env);
              if (fresh.topic_id) { tid = fresh.topic_id; u.topic_id = tid; break; }
          }
          if (!tid) return api(env.BOT_TOKEN, "sendMessage", { chat_id: uid, text: "⚠️ 系统繁忙,请稍后重试" });
      }
  }

  if (!tid) return;

  // 查找回复消息ID
  let replyToIdInAdmin = undefined;
  if (msg.reply_to_message) {
      try {
          const ref = await sql(env, "SELECT admin_msg_id FROM msg_mapping WHERE user_id = ? AND user_msg_id = ?",
              [uid, msg.reply_to_message.message_id.toString()], "first");
          if (ref) replyToIdInAdmin = ref.admin_msg_id;
      } catch { } // 查询失败按“没有引用关系”处理
  }

  const reply_parameters = replyToIdInAdmin ? {
      message_id: replyToIdInAdmin,
      ...(msg.quote ? {
          quote: msg.quote.text,
          quote_entities: msg.quote.entities,
          quote_position: msg.quote.position
      } : {})
  } : undefined;

  let relaySuccess = false;
  let sentMsgId = null;

  try {
      const res = await sendRelayMessage(env, uid, msg.message_id, env.ADMIN_GROUP_ID, tid, reply_parameters, isForwardedMessage(msg));

      if (res && res.message_id) {
          sentMsgId = res.message_id;
          relaySuccess = true;
          await sql(env, "INSERT OR REPLACE INTO msg_mapping (user_id, user_msg_id, admin_msg_id, ts) VALUES (?, ?, ?, ?)",
              [uid, msg.message_id.toString(), sentMsgId.toString(), Date.now()]);
          maybeCleanupMappings(env, ctx);
      }
  } catch (cpErr) {
      const reason = String(cpErr?.message || "");
      const threadGone = !retried && /message thread not found|thread not found|topic[_ ]?id[_ ]?invalid|topic.*(not found|deleted|invalid)/i.test(reason);
      if (threadGone) {
          await updUser(uid, { topic_id: null }, env);
          u.topic_id = null;
          return relayToTopic(msg, u, env, ctx, emoji, isAdmin, true);
      }
      return api(env.BOT_TOKEN, "sendMessage", { chat_id: uid, text: "⚠️ 转发失败: " + reason });
  }

  if (relaySuccess) {
    // 等待 Telegram 设置送达表态完成，避免媒体消息处理提前结束
    if (claimOnce(`delivered:${uid}:${msg.message_id}`, 20000)) await markDelivered(env, uid, msg.message_id, emoji);
      if (msg.text) {
          try {
              await sql(env, "INSERT OR REPLACE INTO messages (user_id, message_id, date) VALUES (?,?,?)", [uid, msg.message_id, msg.date]);
          } catch { } // 存档失败不影响转发
          maybeCleanupMessages(env, ctx);
      }
  }
}

// --- 12. 资料卡 ---  
// 发送资料卡并置顶，返回消息 ID
async function sendAndPinCard(env, u, tid, payload) {
  const card = await api(env.BOT_TOKEN, payload.photo ? "sendPhoto" : "sendMessage", {
    chat_id: env.ADMIN_GROUP_ID,
    message_thread_id: tid,
    parse_mode: "HTML",
    ...payload
  });
  await updUser(u.user_id, { user_info: { card_msg_id: card.message_id } }, env);
  await api(env.BOT_TOKEN, "pinChatMessage", { chat_id: env.ADMIN_GROUP_ID, message_id: card.message_id, message_thread_id: tid }).catch(() => { });
  return card.message_id;
}

async function sendInfoCardToTopic(env, u, tgUser, tid, date) {
  const meta = getUMeta(tgUser, u, date || Date.now() / 1000);
  let photoId = null;
  try {
    const photos = await api(env.BOT_TOKEN, "getUserProfilePhotos", { user_id: tgUser.id, limit: 1 });
    if (photos?.total_count > 0) photoId = photos.photos[0][photos.photos[0].length - 1].file_id;
  } catch (e) {
    console.warn("获取用户头像失败，改用文字资料卡:", e?.message || e);
  }

  let reason = "";
  try {
    return await sendAndPinCard(env, u, tid, photoId ? { photo: photoId, caption: meta.card } : { text: meta.card });
  } catch (e) {
    reason = e?.message || String(e);
    console.error("发送资料卡失败:", reason);
  }
  try {
    return await sendAndPinCard(env, u, tid, { text: meta.card });
  } catch (e) {
    reason = e?.message || String(e);
    console.error("文字资料卡也失败，改用简易资料卡:", reason);
  }
  try {
    const usernameStr = tgUser.username ? `@${tgUser.username}` : "无";
    return await sendAndPinCard(env, u, tid, {
      text: `⚠️ 无法生成完整资料卡\n👤 用户: ${tgUser.first_name || "User"}\n🔗 账号: ${usernameStr}\n🆔 ID: ${tgUser.id}\n❌ 错误原因: ${reason}`
    });
  } catch (finalErr) {
    console.error("保底发送也失败:", finalErr);
    return null;
  }
}


// --- 13. Web 验证页 ---  
async function handleVerifyPage(url, env) {
  const uid = url.searchParams.get("user_id") || "";
  const nonce = url.searchParams.get("nonce") || "";
  const mode = await getCfg("captcha_mode", env);
  const siteKey = mode === "recaptcha" ? env.RECAPTCHA_SITE_KEY : env.TURNSTILE_SITE_KEY;
  if (!/^\d{1,20}$/.test(uid) || !/^[a-z0-9]{24}$/i.test(nonce) || !siteKey) {
    return new Response("<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head><body style=\"font-family:sans-serif;text-align:center;padding:40px\"><h3>⚠️ 验证服务未配置</h3><p>请联系管理员检查人机验证设置</p></body></html>", {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
    });
  }

  const script = mode === "recaptcha" ? "https://www.google.com/recaptcha/api.js" : "https://challenges.cloudflare.com/turnstile/v0/api.js";
  const divClass = mode === "recaptcha" ? "g-recaptcha" : "cf-turnstile";
  const scriptUid = safeJsonForScript(uid);
  const scriptNonce = safeJsonForScript(nonce);
  const siteKeyAttr = escapeHTML(siteKey);

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script src="${script}" async defer></script>
<style>body{display:flex;justify-content:center;align-items:center;height:100vh;background:#fff;font-family:sans-serif}#c{text-align:center;padding:20px;background:#f0f0f0;border-radius:10px;max-width:92vw}</style></head>
<body><div id="c"><h3>🛡️ 安全验证</h3><div class="${divClass}" data-sitekey="${siteKeyAttr}" data-callback="S"></div><div id="m"></div></div>
<script>
const tg=window.Telegram.WebApp;tg.ready();
const UI_USER_ID=${scriptUid};
const UI_NONCE=${scriptNonce};
function S(t){
  document.getElementById('m').innerText='Wait...';
  const initData=tg.initData||"";
  fetch('/submit_token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t,userId:UI_USER_ID,nonce:UI_NONCE,initData})})
  .then(r=>r.json()).then(d=>{
    if(d.success){document.getElementById('m').innerText='✅';setTimeout(()=>{tg.close();try{window.close()}catch(e){}},800);}
    else{document.getElementById('m').innerText = d.reason==='locked' ? '❌ 你已被禁言' : (d.reason==='rate' ? '⏳ 操作过于频繁，请稍后重试' : '❌ 验证失败，请回到聊天重新发送 /start');}
  }).catch(()=>{document.getElementById('m').innerText='❌ 网络错误，请重试'});
}
</script></body></html>`;
  return new Response(html, { headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff"
  } });
}

async function readLimitedRequestBody(req, maxBytes) {
  const reader = req.body?.getReader();
  if (!reader) {
    const body = await req.text();
    if (new TextEncoder().encode(body).byteLength > maxBytes) throw new Error("Request too large");
    return body;
  }

  const decoder = new TextDecoder();
  let totalBytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error("Request too large");
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } catch (e) {
    try { await reader.cancel(); } catch { }
    throw e;
  } finally {
    try { reader.releaseLock(); } catch { }
  }
}

async function handleTokenSubmit(req, env, ctx) {
  try {
    const maxBodyBytes = 16384;
    const contentLength = req.headers.get("Content-Length");
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBodyBytes)) throw new Error("Request too large");
    const rlPre = await checkSubmitRateLimit(req, env, ctx, "");
    if (!rlPre.allowed) throw new Error("Rate limited");

    const body = JSON.parse(await readLimitedRequestBody(req, maxBodyBytes));
    const token = typeof body?.token === "string" ? body.token : "";
    const uiUserId = (body?.userId || "").toString();
    const nonce = (body?.nonce || "").toString();
    const initData = (body?.initData || "").toString();
    if (!token || token.length > 8192 || initData.length > 8192 || nonce.length > 64 || uiUserId.length > 20) throw new Error("Invalid request");

    if (!initData || initData.length < 20) throw new Error("Missing initData");
    const parsed = await verifyTelegramInitData(initData, env.BOT_TOKEN, 600);
    const uid = parsed?.userId?.toString();
    if (!uid) throw new Error("Missing uid");

    const rlUid = await checkSubmitRateLimit(req, env, ctx, uid, false);
    if (!rlUid.allowed) throw new Error("Rate limited");
    if (uiUserId && uiUserId !== uid) throw new Error("uid mismatch");

    const u = await getUser(uid, env);
    if (u.topic_locked && !(await isAuthAdmin(uid, env))) throw new Error("blocked");

    const savedNonce = (u.user_info?.verify_nonce || "").toString();
    const savedTs = Number(u.user_info?.verify_nonce_ts || 0);
    const expired = !savedTs || Date.now() - savedTs > VERIFY_NONCE_TTL_MS;
    if (u.user_state === "verified") return new Response(JSON.stringify({ success: true }));

    const mode = (await getCfg("captcha_mode", env)).toLowerCase();
    if (mode !== "recaptcha" && mode !== "turnstile") throw new Error("Invalid captcha mode");
    const secret = mode === "recaptcha" ? env.RECAPTCHA_SECRET_KEY : env.TURNSTILE_SECRET_KEY;
    if (typeof secret !== "string" || !secret.trim()) throw new Error("Captcha secret missing");

    const vOn = await getBool("enable_verify", env);
    if (vOn) {
      if (!nonce || !savedNonce || expired || nonce !== savedNonce) throw new Error("nonce invalid");
      await updUser(uid, { user_info: { verify_nonce: "", verify_nonce_ts: 0 } }, env);
    }

    const verifyUrl = mode === "recaptcha" ? "https://www.google.com/recaptcha/api/siteverify" : "https://challenges.cloudflare.com/turnstile/v0/siteverify";
    const params = mode === "recaptcha" ? new URLSearchParams({ secret, response: token }) : JSON.stringify({ secret, response: token });
    const headers = mode === "recaptcha" ? { "Content-Type": "application/x-www-form-urlencoded" } : { "Content-Type": "application/json" };

    const r = await fetch(verifyUrl, { method: "POST", headers, body: params });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d?.success) throw new Error("Token Invalid");

    try {
      if (parsed?.userObj) {
        const nm = ((parsed.userObj.first_name || "") + " " + (parsed.userObj.last_name || "")).trim() || (parsed.userObj.first_name || "");
        const patch = {};
        if (nm) patch.name = nm;
        if (parsed.userObj.username) patch.username = parsed.userObj.username.toString();
        if (parsed.authDate) patch.join_date = parsed.authDate;
        if (Object.keys(patch).length) await updUser(uid, { user_state: "verified", user_info: patch }, env);
        else await updUser(uid, { user_state: "verified" }, env);
      } else {
        await updUser(uid, { user_state: "verified" }, env);
      }
    } catch { await updUser(uid, { user_state: "verified" }, env); }

    const qaOn = await getBool("enable_qa_verify", env);
    if (qaOn) {
      await updUser(uid, { user_state: "pending_verification" }, env);
      await api(env.BOT_TOKEN, "sendMessage", { chat_id: uid, text: "✅ 验证通过!\n请继续回答:\n" + (await getCfg("verif_q", env)) });
    } else {
      await sendVerifiedWelcome(uid, env);
    }
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    const errMsg = String(e?.message || "");
    const code = errMsg === "blocked" ? "locked" : (errMsg === "Rate limited" ? "rate" : "fail");
    return new Response(JSON.stringify({ success: false, reason: code }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
}

async function verifyAnswer(id, ans, env) {
  const u = await getUser(id, env);
  const lockUntil = Number(u.user_info?.qa_lock_until || 0);
  if (lockUntil > Date.now()) {
    const mins = Math.max(1, Math.ceil((lockUntil - Date.now()) / 60000));
    return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: `⏳ 答案错误次数过多，请 ${mins} 分钟后再试` });
  }
  if (ans.trim() === (await getCfg("verif_a", env)).trim()) {
    await updUser(id, { user_state: "verified", user_info: { qa_fail_count: 0, qa_lock_until: 0 } }, env);
    await sendVerifiedWelcome(id, env);
    return;
  }
  const fails = Number(u.user_info?.qa_fail_count || 0) + 1;
  if (fails >= QA_MAX_FAILS) {
    await updUser(id, { user_info: { qa_fail_count: 0, qa_lock_until: Date.now() + QA_LOCK_MS } }, env);
    return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "❌ 错误次数过多，请 10 分钟后再试" });
  }
  await updUser(id, { user_info: { qa_fail_count: fails } }, env);
  return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: `❌ 错误（第 ${fails}/${QA_MAX_FAILS} 次）` });
}

// --- 14. initData 验签 ---  
async function verifyTelegramInitData(initData, botToken, maxAgeSec) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new Error("missing hash");
  const authDate = parseInt(params.get("auth_date") || "0", 10);
  if (!authDate) throw new Error("missing auth_date");
  const nowSec = Math.floor(Date.now() / 1000);
  if (maxAgeSec && nowSec - authDate > maxAgeSec) throw new Error("expired");
  if (authDate > nowSec + 30) throw new Error("future auth_date");

  const pairs = [];
  for (const [k, v] of params.entries()) {
    if (k !== "hash") pairs.push([k, v]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");

  const secretKey = await hmacSha256Bytes(strToBytes("WebAppData"), strToBytes(botToken));
  const calc = await hmacSha256Bytes(secretKey, strToBytes(dataCheckString));
  if (!timingSafeEqualHex(bytesToHex(calc), hash)) throw new Error("hash mismatch");

  let userObj = null;
  try { userObj = JSON.parse(params.get("user") || "{}"); } catch { }
  return { userId: userObj?.id, authDate, userObj };
}

function strToBytes(s) { return new TextEncoder().encode(s); }
async function hmacSha256Bytes(k, d) {
  const key = await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, d);
  return new Uint8Array(sig);
}
function bytesToHex(u8) { return Array.from(u8).map(b => b.toString(16).padStart(2, "0")).join(""); }
function timingSafeEqualHex(a, b) {
  const aa = (a || "").toLowerCase(), bb = (b || "").toLowerCase();
  if (aa.length !== bb.length) return false;
  let r = 0;
  for (let i = 0; i < aa.length; i++) r |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  return r === 0;
}
function timingSafeEqualStr(a, b) {
  const aa = (a || "").toString(), bb = (b || "").toString();
  if (aa.length !== bb.length) return false;
  let r = 0;
  for (let i = 0; i < aa.length; i++) r |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  return r === 0;
}

// --- 15. 辅助函数 ---  
const getBool = async (k, e) => (await getCfg(k, e)) === "true";
const getJsonCfg = async (k, e) => {
  const raw = await getCfg(k, e);
  const cached = CACHE.json.get(k);
  if (cached?.raw === raw) return cached.value;
  const value = safeParse(raw, []);
  CACHE.json.set(k, { raw, value });
  return value;
};
function safeJsonForScript(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => ({
    "<": "\\u003c", ">": "\\u003e", "&": "\\u0026",
    "\u2028": "\\u2028", "\u2029": "\\u2029"
  })[char]);
}
function escapeHTML(t) { return (t || "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
function genNonce(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += (b % 36).toString(36);
  return s;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const getUMeta = (tgUser, dbUser, d) => {
  const id = tgUser.id.toString();
  const name = (((tgUser.first_name || "") + " " + (tgUser.last_name || "")).trim() || tgUser.first_name || "User");
  const timeStr = new Date(d * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  
  // 优先使用 Telegram 资料里的用户名，其次用数据库里保存的
  const username = tgUser.username ? `@${tgUser.username}` : (dbUser.user_info?.username ? `@${dbUser.user_info.username}` : "无");
  
  return { 
      userId: id, 
      name, 
      topicName: name.substring(0, 128), 
      card: `👤: <code>${escapeHTML(name)}</code>\n🔗: ${escapeHTML(username)}\n🆔: <code>${escapeHTML(id)}</code>\n🕒: <code>${escapeHTML(timeStr)}</code>` 
  };
};
// --- 16. Commands ---  
async function registerCommands(env) {
  try {
    await api(env.BOT_TOKEN, "deleteMyCommands", { scope: { type: "default" } });
    await api(env.BOT_TOKEN, "setMyCommands", {
      commands: [{ command: "del", description: "双向撤回（需引用）" }],
      scope: { type: "chat", chat_id: env.ADMIN_GROUP_ID }
    });
    await api(env.BOT_TOKEN, "setMyCommands", {
      commands: [
        { command: "start", description: "开始" },
        { command: "del", description: "双向撤回(需引用)" }
      ],
      scope: { type: "default" }
    });
    await api(env.BOT_TOKEN, "setMyCommands", {
      commands: [
        { command: "del", description: "双向撤回(需引用)" },
        { command: "reset", description: "重置用户验证" },
        { command: "new_card", description: "新建资料卡" },
        { command: "delete_topic", description: "删除用户话题" }
      ],
      scope: { type: "chat_administrators", chat_id: env.ADMIN_GROUP_ID }
    });
    const creatorId = await getGroupCreatorId(env);
    const ownerIds = getOwnerIds(env);
    // 未配置 ADMIN_IDS 时，把管理群组创建者当作所有者，保证仍有入口
    const effectiveOwners = ownerIds.length ? ownerIds : (creatorId ? [creatorId] : []);
    for (const ownerId of effectiveOwners) {
      await api(env.BOT_TOKEN, "setMyCommands", {
        commands: [
          { command: "start", description: "控制面板" },
          { command: "help", description: "帮助" }
        ],
        scope: { type: "chat", chat_id: Number(ownerId) }
      });
    }
    if (creatorId && !effectiveOwners.includes(creatorId)) {
      await api(env.BOT_TOKEN, "deleteMyCommands", { scope: { type: "chat", chat_id: Number(creatorId) } });
    }
  } catch (e) {
    console.warn("Telegram 命令菜单注册失败:", e?.message || e);
  }
}
async function registerWebhook(env) {
  const url = (env.WORKER_URL || "").toString().trim().replace(/\/+$/, "");
  const secret = (env.TELEGRAM_WEBHOOK_SECRET || "").toString();
  if (!url || !secret) return;
  try {
    await api(env.BOT_TOKEN, "setWebhook", {
      url,
      secret_token: secret,
      allowed_updates: ["message", "edited_message", "callback_query", "message_reaction"]
    });
  } catch (e) {
    console.warn("Webhook 更新类型配置失败:", e?.message || e);
  }
}

function scheduleBotSetup(ctx, env) {
  const now = Date.now();
  if (CACHE.setupPromise) {
    safeWaitUntil(ctx, CACHE.setupPromise);
    return;
  }
  if (now - CACHE.setupAt < 5 * 60 * 1000) return;
  CACHE.setupAt = now;
  CACHE.setupPromise = Promise.allSettled([registerCommands(env), registerWebhook(env)])
    .finally(() => { CACHE.setupPromise = null; });
  safeWaitUntil(ctx, CACHE.setupPromise);
}

// --- 17. 回调处理 ---  
// 删除话题：取消
function cancelTopicDelete(cb, env) {
  const msg = cb.message;
  return api(env.BOT_TOKEN, "editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text: "已取消删除" })
    .catch(() => { })
    .then(() => api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "已取消删除" }).catch(() => { }));
}

// 删除话题：确认（私聊与群组共用）
async function confirmTopicDelete(cb, env, uid, topicId) {
  const msg = cb.message;
  const user = await getUser(uid, env);
  if (!user?.topic_id || user.topic_id.toString() !== topicId.toString()) {
    await api(env.BOT_TOKEN, "editMessageReplyMarkup", { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => { });
    return alertCallback(cb, env, "该话题已变化或不存在，请重新发送命令");
  }
  try {
    await api(env.BOT_TOKEN, "deleteForumTopic", { chat_id: env.ADMIN_GROUP_ID, message_thread_id: topicId });
  } catch (e) {
    return alertCallback(cb, env, `删除话题失败，用户数据未删除：${e.message || e}`);
  }
  await deleteUserData(uid, env);
  await api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "话题及用户数据已删除" }).catch(() => { });
  return api(env.BOT_TOKEN, "editMessageText", {
    chat_id: msg.chat.id, message_id: msg.message_id,
    text: `✅ 已删除用户 ${uid} 的话题（话题ID ${topicId}）及机器人保存的数据`
  }).catch(() => { });
}

// 按钮回调的弹窗提示
function alertCallback(cb, env, text = "无权操作") {
  return api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text, show_alert: true }).catch(() => { });
}

async function handleCallback(cb, env, ctx) {
  const { data, message: msg, from } = cb;
  const [act, p1, p2, p3] = (data || "").split(":");

  if (act === "welcome" && (p1 === "confirm" || p1 === "cancel")) {
      if (!(await isGroupCreator(from.id, env))) return alertCallback(cb, env);
      await api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
      if (p2 !== "pre" && p2 !== "post") return;
      const phase = p2;
      const expectedAction = phase === "pre" ? "collect_pre_welcome" : "collect_verified_welcome";
      if (p1 === "cancel") {
          await sql(env, "DELETE FROM config WHERE key=?", [`admin_state:${from.id}`]);
          await api(env.BOT_TOKEN, "sendMessage", { chat_id: from.id, text: "已取消本次设置，之前保存的欢迎消息不变" });
          return refreshAdminPanel(msg.chat.id, msg.message_id, "welcome", env);
      }
      const state = safeParse(await getCfg(`admin_state:${from.id}`, env), null);
      if (!state || state.action !== expectedAction) {
          return api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "设置状态已过期，请重新开始", show_alert: true }).catch(() => {});
      }
      const completed = await completeWelcomeMessagesSetup(from.id, state, phase, env);
      return completed ? refreshAdminPanel(msg.chat.id, msg.message_id, "welcome", env) : null;
  }

  if (act === "batch" && (p1 === "confirm" || p1 === "cancel")) {
      if (!(await isGroupCreator(from.id, env))) return api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "无权操作", show_alert: true }).catch(() => {});
      const state = safeParse(await getCfg(`admin_state:${from.id}`, env), null);
      if (!state || !["collect_block_keywords", "collect_auto_reply"].includes(state.action)) {
          return api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "设置状态已过期，请重新开始", show_alert: true }).catch(() => {});
      }
      await api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
      const menuKey = state.action === "collect_block_keywords" ? "kw" : "ar";
      if (p1 === "cancel") {
          await sql(env, "DELETE FROM config WHERE key=?", [`admin_state:${from.id}`]);
          await api(env.BOT_TOKEN, "sendMessage", { chat_id: from.id, text: "已取消本次添加，之前保存的内容不变" });
          return refreshAdminPanel(msg.chat.id, msg.message_id, menuKey, env);
      }
      const completed = await completeAdminBatchSetup(from.id, state, env);
      return completed ? refreshAdminPanel(msg.chat.id, msg.message_id, menuKey, env) : null;
  }

  if (act === "ptopic_delete" && (p1 === "confirm" || p1 === "cancel")) {
      if (!(await isGroupCreator(from.id, env))) return alertCallback(cb, env, "只有主人可以操作");
      if (msg?.chat?.type !== "private" || msg?.chat?.id?.toString() !== from.id.toString()) return alertCallback(cb, env, "确认消息已失效，请重新发送 /delete_topic");
      return p1 === "cancel" ? cancelTopicDelete(cb, env) : confirmTopicDelete(cb, env, p2, p3);
  }

  if (act === "gtopic_delete" && (p1 === "confirm" || p1 === "cancel")) {
      if (!(await isAuthAdmin(from.id, env))) return alertCallback(cb, env);
      if (msg?.chat?.id?.toString() !== env.ADMIN_GROUP_ID) return alertCallback(cb, env, "确认消息已失效，请在管理群重新发送 /delete_topic");
      return p1 === "cancel" ? cancelTopicDelete(cb, env) : confirmTopicDelete(cb, env, p2, p3);
  }

  if (act === "config") {
      if (!(await isGroupCreator(from.id, env))) return alertCallback(cb, env);
      await api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id }).catch(() => { });
      const [, t, k, v] = (data || "").split(":");
      if (["toggle", "captcha", "qa_cancel", "input_cancel"].includes(t)) {
        return handleAdminConfig(msg.chat.id, msg.message_id, t, k, v, env);
      }
      if (t === "del") return handleAdminConfig(msg.chat.id, msg.message_id, t, k, v, env);
      if (t === "cl") {
        const result = await handleAdminConfig(msg.chat.id, null, t, k, v, env);
        await api(env.BOT_TOKEN, "deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});
        return result;
      }
      return handleAdminConfig(msg.chat.id, msg.message_id, t, k, v, env);
  }

}

// --- 18. 管理员回复 ---
async function handleAdminReply(msg, env, ctx) {
  // 话题中的普通成员可以回复用户；只在运行命令时查询 Telegram 管理员身份
  if (!msg.message_thread_id || msg.from.is_bot) return;
  const command = (msg.text || "").trim().split(/\s+/)[0].split("@")[0].toLowerCase();
  const isAdmin = command.startsWith("/") ? await isAuthAdmin(msg.from.id, env) : false;
  if (command.startsWith("/") && !isAdmin) return;

  // 查找当前话题对应的用户ID
  const uid = (await sql(env, "SELECT user_id FROM users WHERE topic_id = ?", msg.message_thread_id.toString(), "first"))?.user_id;
  if (!uid) return;

  if (command.startsWith("/")) {
      const u = await getUser(uid, env);
      if (command === "/reset") {
          await forceResetUserVerify(uid, env);
          safeWaitUntil(ctx, api(env.BOT_TOKEN, "sendMessage", { chat_id: uid, text: "⚠️ 管理员要求您重新验证，请发送 /start" }).catch(() => {}));
          return sendTemporaryMessage(env, ctx, { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "✅ 已重置用户验证" });
      }
      if (command === "/new_card") {
          if (!u.topic_id) return sendTemporaryMessage(env, ctx, { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "此用户没有关联的话题，无法创建资料卡" });
          try {
              const tgUser = await api(env.BOT_TOKEN, "getChat", { chat_id: uid });
              const newCardId = await sendInfoCardToTopic(env, u, tgUser, u.topic_id, Date.now() / 1000);
              if (!newCardId) throw new Error("Telegram 没有返回新资料卡消息");
              return sendTemporaryMessage(env, ctx, { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "✅ 已新建并置顶用户资料卡，旧资料卡保留" });
          } catch (e) {
              return sendTemporaryMessage(env, ctx, { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: `❌ 新建资料卡失败：${e.message || e}` });
          }
      }
      if (command === "/delete_topic") {
          const target = (msg.text || "").trim().split(/\s+/)[1] || "";
          const targetUid = target || uid;
          if (!/^\d+$/.test(targetUid)) return sendTemporaryMessage(env, ctx, { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "用法：/delete_topic <用户ID>；在本用户话题内也可直接发送 /delete_topic" });
          const targetUser = await getUser(targetUid, env);
          if (!targetUser?.topic_id) return sendTemporaryMessage(env, ctx, { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "未找到该用户，或该用户没有关联的话题" });
          const targetTopicId = targetUser.topic_id.toString();
          return api(env.BOT_TOKEN, "sendMessage", {
              chat_id: msg.chat.id,
              message_thread_id: msg.message_thread_id,
              ...topicDeletePrompt("gtopic_delete", targetUid, targetTopicId)
          });
      }
      // 未知命令不转发给用户
      return;
  }

  // 处理回复关系
  let replyToIdInUser = undefined;
  if (msg.reply_to_message) {
      try {
          const ref = await sql(env, "SELECT user_msg_id FROM msg_mapping WHERE admin_msg_id = ?",
              [msg.reply_to_message.message_id.toString()], "first");
          if (ref) replyToIdInUser = ref.user_msg_id;
      } catch { } // 查询失败按“没有引用关系”处理
  }

  // 使用展开运算符一次性构建对象，避免 IDE 报错
  const reply_parameters = replyToIdInUser ? {
      message_id: replyToIdInUser,
      ...(msg.quote ? {
          quote: msg.quote.text,
          quote_entities: msg.quote.entities,
          quote_position: msg.quote.position
      } : {})
  } : undefined;

  try {
      // 发送消息（转发消息保留来源；私聊没有话题，threadId 传 undefined）
      const sent = await sendRelayMessage(env, msg.chat.id, msg.message_id, uid, undefined, reply_parameters, isForwardedMessage(msg));

      // 记录消息映射
      if (sent && sent.message_id) {
          await sql(env, "INSERT OR REPLACE INTO msg_mapping (user_id, user_msg_id, admin_msg_id, ts) VALUES (?, ?, ?, ?)",
              [uid, sent.message_id.toString(), msg.message_id.toString(), Date.now()]);
          maybeCleanupMappings(env, ctx);
      }
  } catch (e) {
      safeWaitUntil(ctx, api(env.BOT_TOKEN, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "❌ 发送失败 (用户可能已停止Bot)" }).catch(() => { }));
  }
}

// --- 19. 控制面板 ---  
// 统一的键名到前端标签的映射表
const LABEL_MAP = {
  "qa": "❓ 问题验证",
  "sleep_start": "😴 睡觉时间",
  "sleep_end": "⏰ 起床时间",
  "sleep_msg": "💤 提示语",
  "ar": "🤖 自动回复",
  "kw": "🚫 屏蔽词"
};

async function refreshAdminPanel(cid, oldMessageId, key, env) {
  if (oldMessageId) await api(env.BOT_TOKEN, "deleteMessage", { chat_id: cid, message_id: oldMessageId }).catch(() => {});
  return handleAdminConfig(cid, null, "menu", key, null, env);
}
function makeToggleButton(label, key, enabled) {
  return {
    text: enabled ? `❌ 关闭${label}` : `✅ 开启${label}`,
    callback_data: `config:toggle:${key}:${!enabled}`
  };
}

async function handleAdminConfig(cid, mid, type, key, val, env) {
const render = (content, kb) => {
  const isRichMessage = content && typeof content === "object" && Array.isArray(content.blocks);
  const method = isRichMessage ? (mid ? "editMessageText" : "sendRichMessage") : (mid ? "editMessageText" : "sendMessage");
  /** @type {Record<string, any>} */
  const body = { chat_id: cid, reply_markup: kb };
  if (mid) body.message_id = mid;
  if (isRichMessage) body.rich_message = { blocks: content.blocks };
  else { body.text = content; body.parse_mode = "HTML"; }
  return api(env.BOT_TOKEN, method, body);
};
const back = { text: "🔙 返回", callback_data: "config:menu" };

try {
  if (!type || type === "menu") {
    if (!key) return render("⚙️ <b>控制面板</b>", {
      inline_keyboard: [
        [{ text: "🛡️ 人机验证", callback_data: "config:menu:base" }, { text: "👋 欢迎语", callback_data: "config:menu:welcome" }],
        [{ text: "🤖 自动回复", callback_data: "config:menu:ar" }, { text: "🚫 屏蔽词", callback_data: "config:menu:kw" }],
        [{ text: "👀 消息过滤", callback_data: "config:menu:fl" }, { text: "🌙 就寝时间", callback_data: "config:menu:sleep" }],
      ]
    });
    if (key === "base") {
      const mode = await getCfg("captcha_mode", env);
      const captchaOn = await getBool("enable_verify", env);
      const qaOn = await getBool("enable_qa_verify", env);
      const captchaText = !captchaOn ? "❌ 关闭" : mode === "recaptcha" ? "✅ Google" : "✅ Cloudflare";
      return render(`<b>人机验证设置</b>\n人机验证：${captchaText}\n问题验证：${qaOn ? "✅ 已开启" : "❌ 已关闭"}`, {
        inline_keyboard: [
          [{ text: "🛡️ 人机验证", callback_data: "config:menu:captcha" }],
          [{ text: "❓ 问题验证", callback_data: "config:menu:qa" }],
          [back]
        ]
      });
    }
    if (key === "qa") {
      const question = await getCfg("verif_q", env);
      const answer = await getCfg("verif_a", env);
      const qaOn = await getBool("enable_qa_verify", env);
      return render(`<b>问题验证</b>\n开关状态：${qaOn ? "✅ 已开启" : "❌ 已关闭"}\n\n<b>当前问题：</b>\n${escapeHTML(question)}\n\n<b>当前答案：</b>\n<code>${escapeHTML(answer)}</code>`, {
        inline_keyboard: [
          [{ text: "🔄 重置问题和答案", callback_data: "config:qa_reset" }],
          [makeToggleButton("问题验证", "enable_qa_verify", qaOn)],
          [{ text: "🔙 返回", callback_data: "config:menu:base" }]
        ]
      });
    }
    if (key === "captcha") {
      const mode = await getCfg("captcha_mode", env);
      const enabled = await getBool("enable_verify", env);
      const selected = mode === "recaptcha" ? "google" : "cf";
      const captchaStatus = !enabled ? "❌ 关闭" : selected === "google" ? "✅ Google" : "✅ Cloudflare";
      const option = (name, label) => ({ text: `${selected === name ? "✅ " : ""}${label}`, callback_data: `config:captcha:${name}` });
      return render(`<b>人机验证</b>\n开关状态：${captchaStatus}\n\n人机验证和问题验证相互独立`, {
        inline_keyboard: [
          [option("google", "Google"), option("cf", "Cloudflare")],
          [makeToggleButton("人机验证", "enable_verify", enabled)],
          [{ text: "🔙 返回", callback_data: "config:menu:base" }]
        ]
      });
    }
    if (key === "welcome") {
      const preSaved = safeParse(await getCfg("pre_welcome_messages", env), []);
      const postSaved = safeParse(await getCfg("verified_welcome_messages", env), []);
      const preCount = Array.isArray(preSaved) ? preSaved.length : 0;
      const postCount = Array.isArray(postSaved) ? postSaved.length : 0;
      const preSummary = preCount ? `${preCount} 条消息` : "默认欢迎语";
      const postSummary = postCount ? `${postCount} 条消息` : "默认欢迎语";
      return render(`<b>👋 欢迎语</b>\n\n验证前：${preSummary}\n验证后：${postSummary}`, {
        inline_keyboard: [
          [{ text: "重新设置验证前消息", callback_data: "config:add:pre_welcome" }],
          [{ text: "重新设置验证后消息", callback_data: "config:add:verified_welcome" }],
          [back]
        ]
      });
    }
    if (key === "fl") {
      const panel = await getFilterPanel(env);
      return render(panel.text, panel.reply_markup);
    }
    if (["ar", "kw"].includes(key)) {
      const page = Math.max(1, Number.parseInt(val || "1", 10) || 1);
      const panel = await getListPanel(key, env, page);
      return render(panel.rich_message, panel.reply_markup);
    }
    if (key === "sleep") {
      const on = await getBool("enable_sleep_mode", env);
      const start = await getCfg("sleep_start", env);
      const end = await getCfg("sleep_end", env);
      const msgText = await getCfg("sleep_msg", env);
      return render(`🌙 <b>就寝时间</b>\n开关状态：${on ? "✅ 已开启" : "❌ 已关闭"}\n睡觉时间：<code>${start}</code> - <code>${end}</code>\n提示语：${escapeHTML(msgText)}`, {
        inline_keyboard: [
          [{ text: "😴 睡觉时间", callback_data: "config:edit:sleep_start" }, { text: "⏰ 起床时间", callback_data: "config:edit:sleep_end" }],
          [{ text: "💤 提示语", callback_data: "config:edit:sleep_msg" }],
          [makeToggleButton("就寝时间", "enable_sleep_mode", on)],
          [back]
        ]
      });
    }
  }
  if (type === "captcha") {
    if (key === "google") {
      await setCfg("captcha_mode", "recaptcha", env);
    } else if (key === "cf") {
      await setCfg("captcha_mode", "turnstile", env);
    } else {
      return;
    }
    return handleAdminConfig(cid, mid, "menu", "captcha", null, env);
  }
  if (type === "qa_default") {
    await setCfg("verif_q", DEFAULTS.verif_q, env);
    await setCfg("verif_a", DEFAULTS.verif_a, env);
    await setCfg("enable_qa_verify", "true", env);
    await sql(env, "DELETE FROM config WHERE key=?", [`admin_state:${cid}`]);
    return handleAdminConfig(cid, mid, "menu", "qa", null, env);
  }
  if (type === "qa_cancel") {
    await sql(env, "DELETE FROM config WHERE key=?", [`admin_state:${cid}`]);
    return handleAdminConfig(cid, mid, "menu", "qa", null, env);
  }
  if (type === "qa_reset") {
    await setCfg(`admin_state:${cid}`, JSON.stringify({ action: "collect_qa_question", key: "qa", panel_message_id: mid }), env);
    return render("<b>重置问题验证</b>\n请发送第一条消息作为问题，再发送第二条消息作为答案；完成后自动开启。\n\n如果不发送任何内容，点击“确认”即可恢复默认问题和答案。点击“取消重置”会保留原设置", {
      inline_keyboard: [[{ text: "确认", callback_data: "config:qa_default" }], [{ text: "取消重置", callback_data: "config:qa_cancel" }]]
    });
  }
  if (type === "input_cancel") {
    const state = safeParse(await getCfg(`admin_state:${cid}`, env), null);
    await sql(env, "DELETE FROM config WHERE key=?", [`admin_state:${cid}`]);
    return handleAdminConfig(cid, mid, "menu", configReturnPage(state?.key), null, env);
  }
  if (type === "toggle") {
    await setCfg(key, val, env);
    if (key === "enable_sleep_mode") return handleAdminConfig(cid, mid, "menu", "sleep", null, env);
    if (key === "enable_qa_verify") return handleAdminConfig(cid, mid, "menu", "qa", null, env);
    if (key === "enable_verify") return handleAdminConfig(cid, mid, "menu", "captcha", null, env);
    const panel = await getFilterPanel(env);
    return render(panel.text, panel.reply_markup);
  }
  if (type === "del") {
    const realK = key === "kw" ? "block_keywords" : "keyword_responses";
    let list = await getJsonCfg(realK, env);
    list = Array.isArray(list) ? list : [];
    const indexMatch = (val || "").match(/^idx_(\d+)_p_(\d+)$/);
    let page = Math.max(1, Number.parseInt(indexMatch?.[2] || "1", 10) || 1);
    if (!indexMatch) return;
    const index = Number.parseInt(indexMatch[1], 10);
    if (index >= 0 && index < list.length) list.splice(index, 1);
    await setCfg(realK, JSON.stringify(list), env);
    const pageCount = Math.max(1, Math.ceil(list.length / 8));
    page = Math.min(page, pageCount);
    const panel = await getListPanel(key, env, page);
    panel.rich_message.blocks.unshift({ type: "paragraph", text: "✅ 已删除一项" });
    return render(panel.rich_message, panel.reply_markup);
  }
  if (type === "add" && ["verified_welcome", "pre_welcome"].includes(key)) {
    const phase = key === "pre_welcome" ? "pre" : "post";
    const action = phase === "pre" ? "collect_pre_welcome" : "collect_verified_welcome";
    const phaseLabel = phase === "pre" ? "验证前" : "验证后";
    await setCfg(`admin_state:${cid}`, JSON.stringify({ action, messages: [], panel_message_id: mid }), env);
    return render(`请依次发送${phaseLabel}的消息\n\n请勿修改或删除已发送的素材消息`, {
      inline_keyboard: [
        [{ text: "恢复默认", callback_data: `welcome:confirm:${phase}` }],
        [{ text: "取消本次", callback_data: `welcome:cancel:${phase}` }]
      ]
    });
  }
  if (type === "add" && key === "kw") {
    await setCfg(`admin_state:${cid}`, JSON.stringify({ action: "collect_block_keywords", words: [], panel_message_id: mid }), env);
    return render("请按“每行一个词”的格式发送屏蔽词；可以一次发送多行，空行自动忽略。\n\n发送完后点击“确认完成”保存；点击“取消本次”会保留原设置", {
      inline_keyboard: [[{ text: "确认完成", callback_data: "batch:confirm" }], [{ text: "取消本次", callback_data: "batch:cancel" }]]
    });
  }
  if (type === "add" && key === "ar") {
    await setCfg(`admin_state:${cid}`, JSON.stringify({ action: "collect_auto_reply", pairs: [], pending: null, panel_message_id: mid }), env);
    return render("按顺序添加自动回复：\n1. 先发送一条文字消息，作为触发词\n2. 直接回复这条触发词消息，发送自动回复内容\n3. 继续添加其他触发词和回复\n\n全部添加后只需点击一次“确认完成”。请勿修改或删除已保存的回复素材", {
      inline_keyboard: [[{ text: "确认完成", callback_data: "batch:confirm" }], [{ text: "取消本次", callback_data: "batch:cancel" }]]
    });
  }
  if (type === "edit") {
    await setCfg(`admin_state:${cid}`, JSON.stringify({ action: "input", key, panel_message_id: mid }), env);
    const label = LABEL_MAP[key] || key;
    let promptText = `请输入新的 <b>${label}</b>`;

    if (key === "sleep_start" || key === "sleep_end") {
        promptText = `请输入新的 <b>${label}</b>\n请输入 24 小时制时间，例如 8:00、23:30`;
    }

    return api(env.BOT_TOKEN, "editMessageText", { 
        chat_id: cid, 
        message_id: mid, 
        text: promptText,
        reply_markup: { inline_keyboard: [[{ text: "取消", callback_data: "config:input_cancel" }]] }, 
        parse_mode: "HTML" 
    });
  }

} catch (e) { console.error("handleAdminConfig error:", e); }
}

async function getFilterPanel(env) {
  const switches = [
    { label: "转发", key: "enable_forward_forwarding" },
    { label: "媒体", key: "enable_image_forwarding" },
    { label: "语音", key: "enable_audio_forwarding" },
    { label: "贴纸", key: "enable_sticker_forwarding" },
    { label: "链接", key: "enable_link_forwarding" },
    { label: "频道", key: "enable_channel_forwarding" },
    { label: "文本", key: "enable_text_forwarding" },
    { label: "其他", key: "enable_other_forwarding" }
  ];
  const states = await Promise.all(switches.map(item => getBool(item.key, env)));
  const buttons = switches.map((item, index) => ({
    text: `${states[index] ? "✅" : "❌"} ${item.label}`,
    callback_data: `config:toggle:${item.key}:${!states[index]}`
  }));
  return {
    text: "🛠 <b>消息过滤</b>\n点击下方按钮切换过滤状态\n✅代表放行，❌ 代表过滤",
    reply_markup: {
      inline_keyboard: [
        [buttons[0], buttons[1]],
        [buttons[2], buttons[3]],
        [buttons[4], buttons[5]],
        [buttons[6], buttons[7]],
        [{ text: "🔙 返回", callback_data: "config:menu" }]
      ]
    }
  };
}

async function getListPanel(type, env, requestedPage = 1) {
  const isAutoReply = type === "ar";
  const cfgKey = isAutoReply ? "keyword_responses" : "block_keywords";
  const items = await getJsonCfg(cfgKey, env);
  const list = Array.isArray(items) ? items : [];
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(list.length / pageSize));
  const page = Math.min(Math.max(1, Number.parseInt(String(requestedPage), 10) || 1), pageCount);
  const start = (page - 1) * pageSize;
  const current = list.slice(start, start + pageSize);
  const title = LABEL_MAP[type] || type;
  const headers = isAutoReply ? ["序号", "触发词", "回复预览"] : ["序号", "屏蔽词"];
  const rows = current.map((item, offset) => {
    const trigger = isAutoReply ? (item?.keywords || "（空触发词）") : (item?.word || "（空屏蔽词）");
    const clean = value => shortText(String(value).replace(/[\r\n]+/g, " "), isAutoReply ? 42 : 72);
    const row = [String(start + offset + 1), clean(trigger)];
    if (isAutoReply) row.push(clean(autoReplyPreview(item)));
    return row;
  });
  const description = isAutoReply ? "以下是已设置的触发词和回复内容" : "以下是已设置的屏蔽词";
  const cells = [
    headers.map(text => ({ text, is_header: true, align: "center" })),
    ...rows.map(row => row.map((text, index) => ({ text, align: index === 0 ? "center" : "left" })))
  ];
  /** @type {Array<Record<string, any>>} */
  const blocks = [
    { type: "heading", text: title, size: 3 },
    { type: "paragraph", text: "共 " + list.length + " 项" },
    { type: "paragraph", text: description }
  ];
  if (!rows.length) blocks.push({ type: "paragraph", text: "暂无内容，点击下方“添加”开始设置" });
  blocks.push({ type: "table", cells, is_bordered: true, is_striped: true, is_compact: true });
  blocks.push({ type: "footer", text: "点击表格对应序号删除" });
  const keyboard = [];
  for (let offset = 0; offset < current.length; offset += 4) {
    const buttons = current.slice(offset, offset + 4).map((item, rowOffset) => {
      const index = start + offset + rowOffset;
      return {
        text: String(index + 1),
        callback_data: "config:del:" + type + ":idx_" + index + "_p_" + page
      };
    });
    keyboard.push(buttons);
  }
  if (pageCount > 1) {
    keyboard.push([
      ...(page > 1 ? [{ text: "◀ 上一页", callback_data: "config:menu:" + type + ":" + (page - 1) }] : []),
      { text: page + "/" + pageCount, callback_data: "config:menu:" + type + ":" + page },
      ...(page < pageCount ? [{ text: "下一页 ▶", callback_data: "config:menu:" + type + ":" + (page + 1) }] : [])
    ]);
  }
  keyboard.push([{ text: "➕ 添加", callback_data: "config:add:" + type }], [{ text: "🔙 返回", callback_data: "config:menu" }]);
  return { rich_message: { blocks }, reply_markup: { inline_keyboard: keyboard } };
}

function configReturnPage(key) {
  if (key === "qa") return "qa";
  if (["verif_q", "verif_a"].includes(key)) return "base";
  if (["sleep_start", "sleep_end", "sleep_msg"].includes(key)) return "sleep";
  if (["enable_forward_forwarding", "enable_image_forwarding", "enable_audio_forwarding", "enable_sticker_forwarding", "enable_link_forwarding", "enable_channel_forwarding", "enable_text_forwarding", "enable_other_forwarding"].includes(key)) return "fl";
  return null;
}

function shortText(value, maxLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join("")}…` : text;
}

function autoReplyPreview(item) {
  const preview = item?.response_preview;
  return typeof preview === "string" && preview.trim() ? preview : "已保存回复素材";
}

async function handleAdminInput(id, msg, state, env) {
  const text = msg.text || "";
  if (text.trim().startsWith("/")) {
    return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "请发送普通文字；如需关闭或取消，请点击面板下方的按钮" });
  }

  const key = state.key;
  const input = text.trim();
  if (state.action === "collect_qa_question") {
    if (!input) return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "问题不能为空。请发送问题文字，或点击“取消重置”保留原设置" });
    await setCfg(`admin_state:${id}`, JSON.stringify({ action: "collect_qa_answer", key: "qa", question: input, panel_message_id: state.panel_message_id }), env);
    return api(env.BOT_TOKEN, "editMessageText", { chat_id: id, message_id: state.panel_message_id, text: "✅ 已收到问题。请发送第二条消息作为答案；如不想继续，请点击“取消重置”保留原设置", reply_markup: { inline_keyboard: [[{ text: "取消重置", callback_data: "config:qa_cancel" }]] } });
  }
  if (state.action === "collect_qa_answer") {
    if (!input) return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "答案不能为空。请发送答案文字，或点击“取消重置”保留原设置" });
    await setCfg("verif_q", state.question, env);
    await setCfg("verif_a", input, env);
    await setCfg("enable_qa_verify", "true", env);
    await sql(env, "DELETE FROM config WHERE key=?", [`admin_state:${id}`]);
    await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "✅ 问题和答案已更新，问题验证已开启" });
    return refreshAdminPanel(id, state.panel_message_id, "qa", env);
  }
  let value = text;
  try {
    if (key === "sleep_start" || key === "sleep_end") {
      value = text.trim().replace(/\s*[：；;:]\s*/g, ":");
      if (/^\d:\d{2}$/.test(value)) value = "0" + value;
      if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(value)) {
        return api(env.BOT_TOKEN, "sendMessage", {
          chat_id: id,
          text: "❌ <b>时间格式错误</b>\n请输入 00:00 至 23:59，例如 <code>08:00</code>、<code>23:30</code>",
          parse_mode: "HTML"
        });
      }
    }

    await setCfg(key, value, env);
    await sql(env, "DELETE FROM config WHERE key=?", ["admin_state:" + id]);
  } catch (e) {
    return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "❌ 失败: " + e.message }).catch(() => {});
  }

  const label = LABEL_MAP[key] || key;
  const displayValue = escapeHTML(value.substring(0, 100));
  await api(env.BOT_TOKEN, "sendMessage", {
    chat_id: id,
    text: "✅ <b>" + escapeHTML(label) + "</b> 已更新:\n" + displayValue,
    parse_mode: "HTML"
  }).catch(() => {});
  await refreshAdminPanel(id, state.panel_message_id, configReturnPage(key), env);
}

async function completeWelcomeMessagesSetup(id, state, phase, env) {
  const messages = Array.isArray(state.messages) ? state.messages : [];
  const key = phase === "pre" ? "pre_welcome_messages" : "verified_welcome_messages";
  const saved = messages.map(message_id => ({ owner_id: id.toString(), message_id }));
  await setCfg(key, JSON.stringify(saved), env);
  await sql(env, "DELETE FROM config WHERE key=?", [`admin_state:${id}`]);
  const phaseLabel = phase === "pre" ? "验证前" : "验证后";
  const summary = messages.length
    ? `已设置 ${messages.length} 条自定义消息，原有消息已替换。请勿修改或删除这些素材消息`
    : "未添加自定义消息，已恢复默认欢迎语";
  await api(env.BOT_TOKEN, "sendMessage", {
    chat_id: id,
    text: `✅ ${phaseLabel}欢迎语设置完成。${summary}`
  });
  return true;
}

async function handleWelcomeMessagesSetupInput(id, msg, state, env) {
  const text = (msg.text || "").trim();
  const phase = state.action === "collect_pre_welcome" ? "pre" : "post";
  if (text.startsWith("/")) {
    return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "请发送欢迎素材；完成或取消设置请点击面板上的按钮" });
  }
  if (!msg.message_id) return;
  state.messages = Array.isArray(state.messages) ? state.messages : [];
  const isFirstMessage = state.messages.length === 0;
  state.messages.push(msg.message_id);
  await setCfg(`admin_state:${id}`, JSON.stringify(state), env);
  if (!isFirstMessage) return;
  return api(env.BOT_TOKEN, "editMessageReplyMarkup", {
    chat_id: id,
    message_id: state.panel_message_id,
    reply_markup: {
      inline_keyboard: [
        [{ text: "确认并替换", callback_data: `welcome:confirm:${phase}` }],
        [{ text: "取消本次", callback_data: `welcome:cancel:${phase}` }]
      ]
    }
  }).catch(error => console.warn("欢迎语确认按钮更新失败:", error?.message || error));
}
async function completeAdminBatchSetup(id, state, env) {
  if (state.action === "collect_block_keywords") {
    const words = Array.isArray(state.words) ? state.words : [];
    if (!words.length) {
      await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "还没有收到屏蔽词。请按“每行一个词”的格式发送，再点击“确认完成”" });
      return false;
    }
    const current = safeParse(await getCfg("block_keywords", env), []);
    const saved = Array.isArray(current) ? current : [];
    const seen = new Set(saved.map(item => item?.word?.trim().toLocaleLowerCase()).filter(Boolean));
    const additions = [];
    for (const word of words) {
      const normalized = word.toLocaleLowerCase();
      if (!seen.has(normalized)) {
        additions.push(word);
        seen.add(normalized);
      }
    }
    for (const word of additions) saved.push({ id: `${Date.now()}_${saved.length}`, word });
    await setCfg("block_keywords", JSON.stringify(saved), env);
    await sql(env, "DELETE FROM config WHERE key=?", [`admin_state:${id}`]);
    await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: `✅ 设置完成，新增 ${additions.length} 个屏蔽词；重复项已跳过` });
    return true;
  }

  if (state.action === "collect_auto_reply") {
    if (state.pending) {
      await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "最后一个触发词还没有对应回复。请直接回复那条触发词消息发送回复内容，再点击“确认完成”" });
      return false;
    }
    const pairs = Array.isArray(state.pairs) ? state.pairs : [];
    if (!pairs.length) {
      await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "还没有完成任何自动回复配对。请先发送触发词，再回复它发送回复内容" });
      return false;
    }
    const current = safeParse(await getCfg("keyword_responses", env), []);
    const saved = Array.isArray(current) ? current : [];
    saved.push(...pairs);
    await setCfg("keyword_responses", JSON.stringify(saved), env);
    await sql(env, "DELETE FROM config WHERE key=?", [`admin_state:${id}`]);
    await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: `✅ 设置完成，已添加 ${pairs.length} 组自动回复。请勿修改或删除对应的回复素材消息` });
    return true;
  }
  return false;
}

async function handleAdminBatchSetupInput(id, msg, state, env) {
  const text = (msg.text || "").trim();
  const menuKey = state.action === "collect_block_keywords" ? "kw" : "ar";
  if (text.startsWith("/")) {
    return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "请使用设置面板上的按钮确认或取消；输入内容请直接发送普通消息" });
  }

  if (state.action === "collect_block_keywords") {
    const words = text.split(/\r?\n/).map(word => word.trim()).filter(Boolean);
    if (!words.length) return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "请发送屏蔽词，每行一个词；空行会自动忽略" });
    if (words.some(word => word.length > 256)) return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "每个屏蔽词最多 256 个字符；本条消息未添加，请修改后重发" });
    state.words = Array.isArray(state.words) ? state.words : [];
    state.words.push(...words);
    await setCfg("admin_state:" + id, JSON.stringify(state), env);
    return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "已收到 " + words.length + " 个屏蔽词，累计 " + state.words.length + " 个。可以继续发送（每行一个词），或点击“确认完成”" });
  }

  if (state.action === "collect_auto_reply") {
    state.pairs = Array.isArray(state.pairs) ? state.pairs : [];
    if (!state.pending) {
      if (!text || text.startsWith("/")) return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "请先发送一条普通文字消息作为触发词" });
      state.pending = { message_id: msg.message_id, text };
      await setCfg(`admin_state:${id}`, JSON.stringify(state), env);
      return;
    }
    if (msg.reply_to_message?.message_id !== state.pending.message_id) {
      return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "请直接回复刚才的触发词消息发送回复内容；完成后再添加下一组" });
    }
    state.pairs.push({
      id: `${Date.now()}_${state.pairs.length}`,
      keywords: state.pending.text,
      response: { owner_id: id.toString(), message_id: msg.message_id },
      response_preview: getMessagePreview(msg)
    });
    state.pending = null;
    await setCfg(`admin_state:${id}`, JSON.stringify(state), env);
    return;
  }
}

function getMessagePreview(msg) {
  const text = (msg.text || msg.caption || "").trim();
  if (text) return shortText(text, 90);
  const kinds = [
    ["photo", "图片"], ["video", "视频"], ["animation", "GIF"], ["document", "文件"],
    ["audio", "音频"], ["voice", "语音"], ["video_note", "视频留言"], ["sticker", "贴纸"],
    ["location", "位置"], ["venue", "地点"], ["contact", "联系人"], ["poll", "投票"]
  ];
  const kind = kinds.find(([key]) => msg[key]);
  return kind ? `[${kind[1]}]` : "[消息素材]";
}

async function sendVerifiedWelcome(id, env) {
  const saved = safeParse(await getCfg("verified_welcome_messages", env), []);
  if (Array.isArray(saved) && saved.length) {
    await copySavedMessagesToChat(id, saved, "验证后消息", env);
  } else {
    await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: DEFAULT_VERIFIED_WELCOME, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  }
  return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "✅ 通过验证，请直接发送消息联系管理员" });
}

// --- 20. 表态同步，编辑，撤回 ---
async function handleReactionSync(reactionUpdate, env) {
  const { chat, message_id, new_reaction } = reactionUpdate;
  if (!chat?.id || !message_id) return;
  const cid = chat.id.toString();
  const mid = message_id.toString();
  const isAdmin = cid === env.ADMIN_GROUP_ID;

  // 根据表态发生的聊天位置，从数据库查找映射的消息 ID
  const mapping = isAdmin
    ? await sql(env, "SELECT * FROM msg_mapping WHERE admin_msg_id = ?", [mid], "first")
    : await sql(env, "SELECT * FROM msg_mapping WHERE user_id = ? AND user_msg_id = ?", [cid, mid], "first");

  if (!mapping) return;

  const targetChat = isAdmin ? mapping.user_id : env.ADMIN_GROUP_ID;
  const targetMsg = isAdmin ? mapping.user_msg_id : mapping.admin_msg_id;
  const targetMessageId = Number(targetMsg);
  if (!Number.isSafeInteger(targetMessageId) || targetMessageId < 1) {
    console.warn(`双向表态同步失败：无效的目标消息 ID [${targetMsg}]`);
    return;
  }

  try {
    // 调用 API 将新的表情数组同步到对方的消息上
    await api(env.BOT_TOKEN, "setMessageReaction", {
      chat_id: targetChat,
      message_id: targetMessageId,
      reaction: Array.isArray(new_reaction) ? new_reaction : [], // 空数组用于同步取消表态
      is_big: false
    });
  } catch (e) {
    console.warn(`双向表态同步失败 [${cid}:${mid} -> ${targetChat}:${targetMsg}]:`, e?.message || e);
  }
}
async function markDelivered(env, chatId, messageId, emoji = DELIVERED_REACTION) {
  try {
    await api(env.BOT_TOKEN, "setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji: emoji }],
      is_big: false
    });
  } catch (e) {
    console.warn(`送达表态设置失败 [chat=${chatId}, message=${messageId}]:`, e?.message || e);
  }
}

// /del
async function handleDeleteSync(msg, env, ctx) {
  const thread = { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id };
  const replyTo = msg.reply_to_message;
  // 话题里 Telegram 会默认“回复话题根消息”，根消息 ID 就等于话题 ID，这不是用户主动引用
  const isTopicRootQuote = !!replyTo && (replyTo.message_id === msg.message_thread_id
    || !!(replyTo.forum_topic_created || replyTo.forum_topic_edited || replyTo.forum_topic_closed || replyTo.forum_topic_reopened));
  if (!replyTo?.message_id || isTopicRootQuote) {
    return sendTemporaryMessage(env, ctx, { ...thread, text: "⚠️ 请引用要撤回的消息后，再发送 /del" });
  }
  const chatId = msg.chat.id.toString();
  const isAdminGroup = chatId === env.ADMIN_GROUP_ID;
  const isOwner = Number(msg.from.id) === Number(replyTo.from?.id);
  if (!isOwner && !(await isAuthAdmin(msg.from.id, env))) {
    return sendTemporaryMessage(env, ctx, { ...thread, text: "❌ 你只能撤回自己发送的消息" });
  }
  const mapping = isAdminGroup
    ? await sql(env, "SELECT * FROM msg_mapping WHERE admin_msg_id = ?", [replyTo.message_id.toString()], "first")
    : await sql(env, "SELECT * FROM msg_mapping WHERE user_id = ? AND user_msg_id = ?", [chatId, replyTo.message_id.toString()], "first");
  if (mapping) {
    const results = await Promise.allSettled([
      api(env.BOT_TOKEN, "deleteMessage", { chat_id: mapping.user_id, message_id: mapping.user_msg_id }),
      api(env.BOT_TOKEN, "deleteMessage", { chat_id: env.ADMIN_GROUP_ID, message_id: mapping.admin_msg_id })
    ]);
    if (results.every(result => result.status === "fulfilled")) {
      await sql(env, "DELETE FROM msg_mapping WHERE admin_msg_id = ?", [mapping.admin_msg_id.toString()]).catch(() => {});
      return sendTemporaryMessage(env, ctx, { ...thread, text: "✅ 删除成功" });
    }
    return sendTemporaryMessage(env, ctx, { ...thread, text: "❌ 删除失败" });
  }
  try {
    await api(env.BOT_TOKEN, "deleteMessage", { chat_id: msg.chat.id, message_id: replyTo.message_id });
    return sendTemporaryMessage(env, ctx, { ...thread, text: "✅ 删除成功" });
  } catch {
    return sendTemporaryMessage(env, ctx, { ...thread, text: "❌ 删除失败" });
  }
}

async function handleEditSync(msg, env) {
  const mid = msg.message_id.toString();
  const cid = msg.chat.id.toString();
  const isAdmin = cid === env.ADMIN_GROUP_ID;

  const mapping = isAdmin
    ? await sql(env, "SELECT * FROM msg_mapping WHERE admin_msg_id = ?", [mid], "first")
    : await sql(env, "SELECT * FROM msg_mapping WHERE user_id = ? AND user_msg_id = ?", [cid, mid], "first");

  if (!mapping) return;

  const targetChat = isAdmin ? mapping.user_id : env.ADMIN_GROUP_ID;
  const targetMsg = isAdmin ? mapping.user_msg_id : mapping.admin_msg_id;
  const content = msg.text || msg.caption || "";

  try {
    await api(env.BOT_TOKEN, msg.text ? "editMessageText" : "editMessageCaption", {
      chat_id: targetChat, message_id: targetMsg,
      [msg.text ? "text" : "caption"]: content + (isAdmin ? "" : "\n\n(📝 用户已修改内容)")
    });
  } catch (e) { console.warn("编辑同步失败:", e?.message || e); }
}
