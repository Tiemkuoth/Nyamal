import { decryptSecret } from "./crypto";
import { HttpError } from "./http";
import type { Env } from "./types";

type Content = {
  id: string;
  title: string;
  body: string;
  platform: string;
  media_url: string | null;
  link_url: string | null;
};

type Integration = {
  platform: string;
  secret_enc: string;
  config_json: string;
};

async function postJson(url: string, token: string, body: unknown): Promise<unknown> {
  if (!url.startsWith("https://")) throw new Error("Publishing endpoint must use HTTPS");
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Publishing API returned HTTP ${response.status}`);
  return response.json();
}

export async function publishApprovedContent(env: Env, contentId: string): Promise<void> {
  const item = await env.NYAMAL_DB.prepare(
    "SELECT * FROM content_items WHERE id=? AND status='queued'",
  ).bind(contentId).first<Content>();
  if (!item) throw new HttpError(409, "Content is not queued for publishing");
  const integration = await env.NYAMAL_DB.prepare(
    "SELECT platform,secret_enc,config_json FROM integrations WHERE platform=? AND enabled=1 AND secret_enc IS NOT NULL",
  ).bind(item.platform).first<Integration>();
  if (!integration) throw new Error(`No enabled ${item.platform} integration with a stored credential`);

  const token = await decryptSecret(env, integration.secret_enc);
  const config = JSON.parse(integration.config_json) as Record<string, unknown>;
  const version = typeof config.graph_version === "string" ? config.graph_version : "v23.0";
  let result: unknown;

  if (integration.platform === "telegram") {
    if (typeof config.chat_id !== "string" && typeof config.chat_id !== "number") {
      throw new Error("Telegram integration needs a chat_id");
    }
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chat_id,
        text: `${item.title}\n\n${item.body}${item.link_url ? `\n\n${item.link_url}` : ""}`,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await response.json() as { ok?: boolean; description?: string; result?: unknown };
    if (!response.ok || !data.ok) throw new Error(`Telegram publish failed: ${data.description ?? response.status}`);
    result = data.result;
  } else if (integration.platform === "facebook") {
    if (typeof config.page_id !== "string") throw new Error("Facebook integration needs a page_id");
    const body = new URLSearchParams({
      [item.media_url ? "caption" : "message"]: `${item.title}\n\n${item.body}`,
      access_token: token,
    });
    if (item.media_url) body.set("url", item.media_url);
    else if (item.link_url) body.set("link", item.link_url);
    const response = await fetch(
      `https://graph.facebook.com/${version}/${encodeURIComponent(config.page_id)}/${item.media_url ? "photos" : "feed"}`,
      {
      method: "POST", body, signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok) throw new Error(`Facebook publish failed with HTTP ${response.status}`);
    result = await response.json();
  } else if (integration.platform === "instagram") {
    if (typeof config.ig_user_id !== "string" || !item.media_url) {
      throw new Error("Instagram publishing needs ig_user_id and a public media_url");
    }
    const create = new URLSearchParams({
      image_url: item.media_url,
      caption: `${item.title}\n\n${item.body}`,
      access_token: token,
    });
    const created = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(config.ig_user_id)}/media`, {
      method: "POST", body: create, signal: AbortSignal.timeout(20000),
    });
    if (!created.ok) throw new Error(`Instagram media creation failed with HTTP ${created.status}`);
    const container = await created.json() as { id?: string };
    if (!container.id) throw new Error("Instagram did not return a media container ID");
    const publish = new URLSearchParams({ creation_id: container.id, access_token: token });
    const response = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(config.ig_user_id)}/media_publish`, {
      method: "POST", body: publish, signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Instagram publish failed with HTTP ${response.status}`);
    result = await response.json();
  } else if (integration.platform === "whatsapp") {
    const recipient = config.recipient ?? config.to;
    if (typeof config.phone_number_id !== "string" || typeof recipient !== "string") {
      throw new Error("WhatsApp integration needs phone_number_id and recipient");
    }
    result = await postJson(
      `https://graph.facebook.com/${version}/${encodeURIComponent(config.phone_number_id)}/messages`,
      token,
      { messaging_product: "whatsapp", to: recipient, type: "text", text: { body: `${item.title}\n\n${item.body}` } },
    );
  } else if (integration.platform === "custom_rest" || integration.platform === "naath_heritage") {
    const endpoint = config.publish_url;
    if (typeof endpoint !== "string") throw new Error("REST integration needs publish_url");
    result = await postJson(endpoint, token, {
      title: typeof config.default_title === "string" ? config.default_title : item.title,
      content: item.body,
      status: config.force_draft === false ? "published" : "draft",
      media_url: item.media_url,
      link_url: item.link_url,
    });
  } else {
    throw new Error(`Unsupported publishing platform: ${integration.platform}`);
  }

  await env.NYAMAL_DB.prepare(
    "UPDATE content_items SET status='published',published_at=CURRENT_TIMESTAMP,publish_result=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
  ).bind(JSON.stringify(result).slice(0, 2000), contentId).run();
  await env.NYAMAL_DB.batch([
    env.NYAMAL_DB.prepare(
      `UPDATE content_publications SET status='published',remote_id=?,result_json=?,published_at=CURRENT_TIMESTAMP,
       updated_at=CURRENT_TIMESTAMP WHERE content_id=? AND platform=? AND status IN ('queued','approved','scheduled','publishing')`,
    ).bind(JSON.stringify(result).slice(0, 500), JSON.stringify(result).slice(0, 2000), contentId, integration.platform),
    env.NYAMAL_DB.prepare(
      "INSERT INTO publication_events(publication_id,event,details) SELECT id,'published',? FROM content_publications WHERE content_id=? AND platform=?",
    ).bind(JSON.stringify(result).slice(0, 500), contentId, integration.platform),
  ]);
}
