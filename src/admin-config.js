export const SANHE_PAGE_ID = "157645098246646";
export const GRAPH_VERSION = "v23.0";
export const ADMIN_SCOPES = ["business_management", "pages_show_list", "pages_manage_metadata", "pages_messaging"];

export function adminConfig(env = process.env) {
  const keys = ["META_APP_ID", "META_LOGIN_CONFIG_ID", "META_APP_SECRET", "ADMIN_FB_USER_IDS", "ADMIN_SESSION_SECRET", "ADMIN_ALLOWED_PAGE_ID", "PUBLIC_BASE_URL"];
  if (keys.some(key => typeof env[key] !== "string" || !env[key].trim())) return null;
  if (Buffer.byteLength(env.ADMIN_SESSION_SECRET, "utf8") < 32) return null;
  const ids = env.ADMIN_FB_USER_IDS.split(",").map(id => id.trim());
  if (ids.some(id => !/^\d+$/.test(id))) return null;
  if (![env.META_APP_ID, env.META_LOGIN_CONFIG_ID].every(id => /^\d+$/.test(id))) return null;
  if (env.ADMIN_ALLOWED_PAGE_ID !== SANHE_PAGE_ID) return null;
  const businessId = env.ADMIN_ALLOWED_BUSINESS_ID?.trim() || "";
  if (businessId && !/^\d+$/.test(businessId)) return null;
  try {
    const url = new URL(env.PUBLIC_BASE_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return {
      appId: env.META_APP_ID, configId: env.META_LOGIN_CONFIG_ID, appSecret: env.META_APP_SECRET,
      sessionSecret: env.ADMIN_SESSION_SECRET, allowedIds: new Set(ids), pageId: SANHE_PAGE_ID,
      businessId, origin: url.origin, callback: `${url.origin}/admin/callback`,
    };
  } catch { return null; }
}
