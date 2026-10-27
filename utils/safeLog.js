const SENSITIVE_KEYS = new Set([
  "token",
  "vip_token",
  "viptoken",
  "cookie",
  "authorization",
  "pat",
  "gh_token",
  "userinfo",
  "password",
  "code",
  "mobile",
  "phone",
  "qrcode",
  "qrcode_img",
  "qrcode_txt",
  "qrimg",
  "key",
]);

// 邮箱单独一类：日志里保留脱敏形式（ab***@qq.com）而不是整体抹掉，
// 排查「邮件发给了谁」时仍能对应上账号，又不会泄露完整地址。
const EMAIL_KEYS = new Set(["email", "mail", "mail_to", "mailto"]);

const DISPLAY_NAME_KEYS = new Set(["nickname", "username", "display_name", "displayname"]);
const IDENTIFIER_KEYS = new Set(["userid", "user_id", "uid", "kguid", "kugouid", "t_userid"]);

function normalizeKey(key) {
  return String(key).toLowerCase();
}

function sanitizeString(value) {
  return value
    .replace(/(github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]{20,})/g, "[REDACTED]")
    .replace(/(?<!\d)(1[3-9]\d{9})(?!\d)/g, (phone) => `${phone.slice(0, 2)}*******${phone.slice(-2)}`)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (mail) => maskEmail(mail));
}

function maskDisplayName(value) {
  const text = String(value ?? "");
  const chars = Array.from(text);

  if (chars.length === 0) {
    return "";
  }
  if (chars.length === 1) {
    return `${chars[0]}********`;
  }
  if (chars.length === 2) {
    return `${chars[0]}********${chars[1]}`;
  }
  return `${chars.slice(0, 2).join("")}********${chars[chars.length - 1]}`;
}

function maskIdentifier(value) {
  const text = String(value ?? "");
  const chars = Array.from(text);

  if (chars.length === 0) {
    return "";
  }
  if (chars.length <= 2) {
    return "*".repeat(chars.length);
  }
  if (chars.length <= 6) {
    return `${chars[0]}***${chars[chars.length - 1]}`;
  }
  return `${chars.slice(0, 3).join("")}***${chars.slice(-2).join("")}`;
}

// 邮箱脱敏：保留前两位与完整域名后缀，便于用户辨认「是不是自己的邮箱」，
// 同时避免把完整地址写进日志、截图或接口响应。
function maskEmail(value) {
  const text = String(value ?? "").trim();
  const at = text.lastIndexOf("@");
  if (at <= 0) {
    return text ? maskIdentifier(text) : "";
  }
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  const head = local.slice(0, 2);
  return `${head}${"*".repeat(Math.max(2, local.length - 2))}@${domain}`;
}

function redactValue(key, value) {
  const normalizedKey = normalizeKey(key);

  if (DISPLAY_NAME_KEYS.has(normalizedKey)) {
    return maskDisplayName(value);
  }
  if (IDENTIFIER_KEYS.has(normalizedKey)) {
    return maskIdentifier(value);
  }
  if (EMAIL_KEYS.has(normalizedKey)) {
    return maskEmail(value);
  }
  if (SENSITIVE_KEYS.has(normalizedKey)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  return value;
}

function sanitizeForLog(value, depth = 0) {
  if (value == null) {
    return value;
  }
  if (typeof value !== "object") {
    return typeof value === "string" ? sanitizeString(value) : value;
  }
  if (depth >= 4) {
    return "[Object]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeForLog(item, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeForLog(redactValue(key, item), depth + 1)])
  );
}

function summarizeResponse(response) {
  const safe = sanitizeForLog(response);
  if (!safe || typeof safe !== "object") {
    return safe;
  }

  const summary = {};
  for (const key of ["status", "code", "error_code", "errcode", "error", "msg", "message", "httpStatus"]) {
    if (safe[key] !== undefined) {
      summary[key] = safe[key];
    }
  }

  if (safe.data && typeof safe.data === "object") {
    summary.data = {};
    for (const key of ["status", "code", "error_code", "errcode", "msg", "message", "nickname", "userid"]) {
      if (safe.data[key] !== undefined) {
        summary.data[key] = safe.data[key];
      }
    }
  }

  return Object.keys(summary).length > 0 ? summary : safe;
}

function shouldPrintSensitiveValue() {
  const raw = String(process.env.ALLOW_PRINT_USERINFO || "").trim().toLowerCase()
  // 中文“是”直接匹配，英文值需要小写后匹配
  return raw === "是" || ["true", "1", "yes"].includes(raw)
}

export { maskDisplayName, maskEmail, maskIdentifier, sanitizeForLog, shouldPrintSensitiveValue, summarizeResponse };
