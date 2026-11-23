import { decryptSecret, constantTimeEqual } from "./crypto";
import { json, HttpError } from "./http";
import { generateReply } from "./ai";
import {
  finishAutoReply,
  classifyCommunityText,
  communitySystemContext,
  getCommunitySettings,
  recordCommunityActivity,
  recordCommunityIncident,
  reserveAutoReply,
  requiresHumanReview,
  welcomeText,
} from "./community";
import { sendOwnerNotification } from "./telegram";
import type { Env, ExecutionContextLike } from "./types";

const encoder = new TextEncoder();

type InboundMessage = {
  id: string;
  platform: "facebook" | "instagram" | "whatsapp";
  senderId: string;
  text: string;
  businessId?: string;
};

type Integration = {
  platform: string;
  enabled: number;
  secret_enc: string | null;
  app_secret_enc: string | null;
  verify_token_enc: string | null;
  config_json: string;
};

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export async function sendApprovedSocialIncident(
  env: Env,
  incident: {
    platform: "facebook" | "instagram" | "whatsapp";
    sender_id: string;
    community_id: string | null;
    proposed_response: string;
  },
): Promise<void> {
  const integration = await loadIntegration(env, incident.platform);
  if (!integration?.enabled || !integration.secret_enc) {
    throw new Error(`${incident.platform} integration is disabled or has no access token`);
  }
  const token = await decryptSecret(env, integration.secret_enc);
  const config = JSON.parse(integration.config_json) as Record<string, unknown>;
  await sendPlatformReply(
    incident.platform,
    incident.sender_id,
    incident.community_id,
    incident.proposed_response,
    token,
    config,
  );
}

function decodeHex(value: string): Uint8Array | undefined {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) return undefined;
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function verifyMetaSignature(body: string, header: string | null, appSecret: string): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const supplied = decodeHex(header.slice(7));
  if (!supplied) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    copyToArrayBuffer(encoder.encode(appSecret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    copyToArrayBuffer(encoder.encode(body)),
  ));
  let mismatch = supplied.length ^ digest.length;
  for (let i = 0; i < Math.max(supplied.length, digest.length); i++) {
    mismatch |= (supplied[i] ?? 0) ^ (digest[i] ?? 0);
  }
  return mismatch === 0;
}

function stringId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value
    : typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : undefined;
}

function parseMetaMessages(payload: unknown, platform: "facebook" | "instagram"): InboundMessage[] {
  if (!payload || typeof payload !== "object") return [];
  const data = payload as {
    object?: string;
    entry?: Array<{
      id?: string;
      messaging?: Array<{
        sender?: { id?: string };
        message?: { mid?: string; text?: string; is_echo?: boolean };
        postback?: { payload?: string };
        referral?: { ref?: string };
      }>;
    }>;
  };
  if (platform === "facebook" && data.object !== "page") return [];
  if (platform === "instagram" && !["instagram", "page"].includes(data.object ?? "")) return [];
  const entries = Array.isArray(data.entry) ? data.entry : [];
  const messages: InboundMessage[] = [];
  for (const entry of entries) {
    for (const event of entry.messaging ?? []) {
      const message = event.message;
      const sender = stringId(event.sender?.id);
      const text = typeof message?.text === "string" && message.text.trim()
        ? message.text.trim()
        : typeof event.postback?.payload === "string" && event.postback.payload.trim()
          ? event.postback.payload.trim()
          : typeof event.referral?.ref === "string" && event.referral.ref.trim()
            ? event.referral.ref.trim()
            : "";
      const id = message?.mid ?? event.postback?.payload ?? event.referral?.ref;
      if (!sender || !id || message?.is_echo || !text) continue;
      messages.push({
        id: `${id}:${sender}`,
        platform,
        senderId: sender,
        text: text.slice(0, 4000),
        businessId: stringId(entry.id),
      });
    }
  }
  return messages;
}

function parseWhatsAppMessages(payload: unknown): InboundMessage[] {
  if (!payload || typeof payload !== "object") return [];
  const data = payload as {
    object?: string;
    entry?: Array<{
      changes?: Array<{
        value?: {
          metadata?: { phone_number_id?: string };
          messages?: Array<{
            id?: string;
            from?: string;
            from_user_id?: string;
            type?: string;
            text?: { body?: string };
          }>;
        };
      }>;
    }>;
  };
  if (data.object !== "whatsapp_business_account") return [];
  const messages: InboundMessage[] = [];
  for (const entry of data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      for (const message of value?.messages ?? []) {
        const sender = stringId(message.from_user_id) ?? stringId(message.from);
        if (!sender || !message.id || message.type !== "text" || !message.text?.body?.trim()) continue;
        messages.push({
          id: message.id,
          platform: "whatsapp",
          senderId: sender,
          text: message.text.body.trim().slice(0, 4000),
          businessId: stringId(value?.metadata?.phone_number_id),
        });
      }
    }
  }
  return messages;
}

async function loadIntegration(env: Env, platform: string): Promise<Integration | null> {
  return env.NYAMAL_DB.prepare(
    "SELECT platform,enabled,secret_enc,app_secret_enc,verify_token_enc,config_json FROM integrations WHERE platform=?",
  ).bind(platform).first<Integration>();
}

async function insertIncoming(env: Env, messages: InboundMessage[]): Promise<string[]> {
  const ids: string[] = [];
  for (const message of messages.slice(0, 10)) {
    const storedId = `${message.platform}:${message.id}`;
    const inserted = await env.NYAMAL_DB.prepare(
      `INSERT OR IGNORE INTO inbound_messages(id,platform,sender_id,text,business_id)
       VALUES(?,?,?,?,?)`,
    ).bind(storedId, message.platform, message.senderId, message.text, message.businessId ?? null).run();
    if (inserted.meta.changes) ids.push(storedId);
  }
  return ids;
}

async function processOne(env: Env, id: string): Promise<void> {
  const claimed = await env.NYAMAL_DB.prepare(
    `UPDATE inbound_messages SET status='processing',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND status='pending' AND julianday(next_attempt_at)<=julianday('now')`,
  ).bind(id).run();
  if (!claimed.meta.changes) return;
  const row = await env.NYAMAL_DB.prepare(
    "SELECT id,platform,sender_id,text,business_id,attempts FROM inbound_messages WHERE id=?",
  ).bind(id).first<{
    id: string;
    platform: "facebook" | "instagram" | "whatsapp";
    sender_id: string;
    text: string;
    business_id: string | null;
    attempts: number;
  }>();
  if (!row) return;

  let replyReservation: string | null = null;
  try {
    const integration = await loadIntegration(env, row.platform);
    if (!integration?.enabled || !integration.secret_enc) {
      throw new Error(`${row.platform} integration is disabled or has no access token`);
    }
    const config = JSON.parse(integration.config_json) as Record<string, unknown>;
    if (row.platform === "whatsapp" && typeof config.phone_number_id === "string"
      && row.business_id !== config.phone_number_id) {
      throw new Error("Incoming WhatsApp message does not match the configured phone number");
    }
    const settings = await getCommunitySettings(env);
    const analysis = classifyCommunityText(row.text, settings);
    if (analysis.risk !== "safe") {
      const incident = await recordCommunityIncident(env, {
        sourceKey: row.id,
        platform: row.platform,
        kind: "moderation",
        risk: analysis.risk,
        reason: analysis.reason,
        messageText: row.text,
        senderId: row.sender_id,
        communityId: row.business_id ?? undefined,
        messageId: row.id,
      });
      if (incident.inserted && settings.notify_admin) {
        try {
          await sendOwnerNotification(
            env,
            `Nyamal flagged a ${analysis.risk.replaceAll("_", " ")} ${row.platform} message. Review it in the Community Manager.`,
          );
        } catch (error) {
          console.error("Could not notify the owner about a social-message incident", { id: row.id, error });
        }
      }
      await env.NYAMAL_DB.prepare(
        "UPDATE inbound_messages SET status='completed',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      ).bind(id).run();
      return;
    }
    if (requiresHumanReview(row.text)) {
      const incident = await recordCommunityIncident(env, {
        sourceKey: `${row.id}:sensitive`,
        platform: row.platform,
        kind: "escalation",
        risk: "sensitive",
        reason: "The message may need a human response; Nyamal did not generate or publish an answer.",
        messageText: row.text,
        senderId: row.sender_id,
        communityId: row.business_id ?? undefined,
        messageId: row.id,
      });
      if (incident.inserted && settings.notify_admin) {
        try {
          await sendOwnerNotification(env, `A ${row.platform} community message needs human attention. Review it in the Community Manager.`);
        } catch (error) {
          console.error("Could not notify the owner about a social escalation", { id: row.id, error });
        }
      }
      await env.NYAMAL_DB.prepare(
        "UPDATE inbound_messages SET status='completed',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      ).bind(id).run();
      return;
    }
    const token = await decryptSecret(env, integration.secret_enc);
    const previous = await env.NYAMAL_DB.prepare(
      "SELECT 1 FROM inbound_messages WHERE platform=? AND sender_id=? AND status='completed' AND id<>? LIMIT 1",
    ).bind(row.platform, row.sender_id, row.id).first();
    let answer: string;
    const shouldAutoReply = settings.autonomy_level >= 2 && settings.social_auto_replies;
    const responseEventKey = `${row.id}:response`;
    const reserved = shouldAutoReply
      ? await reserveAutoReply(env, settings, row.platform, row.sender_id, responseEventKey)
      : false;
    if (shouldAutoReply && !reserved) {
      await recordCommunityActivity(env, {
        eventKey: `${row.id}:reply-throttled`,
        platform: row.platform,
        eventType: "response_throttled",
        actorId: row.sender_id,
        remoteId: row.id,
      });
      await env.NYAMAL_DB.prepare(
        "UPDATE inbound_messages SET status='completed',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      ).bind(id).run();
      return;
    }
    if (reserved) replyReservation = responseEventKey;
    try {
      answer = await generateReply(env, `${row.platform}:${row.sender_id}`, row.text, "chat", {
        persist: shouldAutoReply,
        systemContext: communitySystemContext(settings),
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("No enabled model")) throw error;
      answer = "Hi! I’m Nyamal, an AI assistant. I’m not ready to answer messages yet; please try again later.";
    }
    if (!previous && settings.welcome_enabled) {
      answer = `${welcomeText(settings)}\n\n${answer}`;
    }
    if (!shouldAutoReply) {
      const incident = await recordCommunityIncident(env, {
        sourceKey: `${row.id}:response`,
        platform: row.platform,
        kind: "response",
        risk: "safe",
        reason: settings.autonomy_level === 1
          ? "Autonomy Level 1 requires approval before any response is sent."
          : "Automatic replies are disabled; review this suggested response before sending.",
        messageText: row.text,
        proposedResponse: answer,
        senderId: row.sender_id,
        communityId: row.business_id ?? undefined,
        messageId: row.id,
      });
      if (incident.inserted && settings.notify_admin) {
        try {
          await sendOwnerNotification(env, `A ${row.platform} reply draft is waiting for approval in the Community Manager.`);
        } catch (error) {
          console.error("Could not notify the owner about a social reply draft", { id: row.id, error });
        }
      }
      await env.NYAMAL_DB.prepare(
        "UPDATE inbound_messages SET status='completed',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      ).bind(id).run();
      return;
    }
    await sendPlatformReply(row.platform, row.sender_id, row.business_id, answer, token, config);
    if (replyReservation) {
      await finishAutoReply(env, replyReservation, true);
      replyReservation = null;
    }
    if (!previous && settings.welcome_enabled) {
      await recordCommunityActivity(env, {
        eventKey: `${row.id}:welcome`,
        platform: row.platform,
        eventType: "member_welcomed",
        actorId: row.sender_id,
        remoteId: row.id,
      });
    }
    await env.NYAMAL_DB.prepare(
      "UPDATE inbound_messages SET status='completed',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?",
    ).bind(id).run();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown inbound message error";
    if (replyReservation) {
      try {
        await finishAutoReply(env, replyReservation, false);
      } catch (reservationError) {
        console.error("Could not release a failed social reply reservation", { id, error: reservationError });
      }
    }
    const retry = row.attempts < 3;
    await env.NYAMAL_DB.prepare(
      `UPDATE inbound_messages
       SET status=?,last_error=?,next_attempt_at=datetime('now',?),updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
    ).bind(retry ? "pending" : "failed", detail.slice(0, 500), retry ? `+${row.attempts * 2} minutes` : "+0 minutes", id).run();
    console.error("Inbound social message processing failed", { id, platform: row.platform, error });
  }
}

export async function processPendingIncoming(env: Env, ids?: string[], limit = 3): Promise<void> {
  let pendingIds = ids;
  if (!pendingIds) {
    await env.NYAMAL_DB.prepare(
      `UPDATE inbound_messages SET status='pending',next_attempt_at=CURRENT_TIMESTAMP
       WHERE status='processing' AND updated_at < datetime('now','-2 minutes')`,
    ).run();
    const rows = await env.NYAMAL_DB.prepare(
      `SELECT id FROM inbound_messages
       WHERE status='pending' AND julianday(next_attempt_at)<=julianday('now')
       ORDER BY received_at LIMIT ?`,
    ).bind(limit).all<{ id: string }>();
    pendingIds = (rows.results ?? []).map((row) => row.id);
  }
  for (const id of pendingIds.slice(0, limit)) await processOne(env, id);
}

async function sendPlatformReply(
  platform: "facebook" | "instagram" | "whatsapp",
  recipient: string,
  businessId: string | null,
  text: string,
  token: string,
  config: Record<string, unknown>,
): Promise<void> {
  const version = typeof config.graph_version === "string" ? config.graph_version : "v27.0";
  let endpoint: string;
  let body: Record<string, unknown>;
  if (platform === "whatsapp") {
    const phoneNumberId = typeof config.phone_number_id === "string" ? config.phone_number_id : businessId;
    if (!phoneNumberId) throw new Error("WhatsApp phone_number_id is not configured");
    endpoint = `https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}/messages`;
    body = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: "text",
      text: { body: text.slice(0, 4000) },
    };
  } else {
    if (platform === "facebook" && typeof config.page_id === "string"
      && businessId && config.page_id !== businessId) {
      throw new Error("Incoming Facebook message does not match the configured Page");
    }
    if (platform === "instagram" && typeof config.ig_user_id === "string"
      && businessId && config.ig_user_id !== businessId) {
      throw new Error("Incoming Instagram message does not match the configured account");
    }
    const accountId = platform === "facebook" ? "me" : businessId
      ?? (typeof config.ig_user_id === "string" ? config.ig_user_id : undefined);
    if (!accountId) throw new Error("Messaging account ID is not configured");
    const host = platform === "instagram" ? "graph.instagram.com" : "graph.facebook.com";
    endpoint = `https://${host}/${version}/${encodeURIComponent(accountId)}/messages`;
    body = {
      recipient: { id: recipient },
      message: { text: platform === "instagram" ? truncateUtf8(text, 1000) : text.slice(0, 2000) },
      messaging_type: "RESPONSE",
    };
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const responseText = (await response.text()).slice(0, 500);
    throw new Error(`${platform} reply API returned HTTP ${response.status}: ${responseText}`);
  }
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > maximumBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}

async function handleVerification(request: Request, env: Env, platform: string): Promise<Response> {
  const integration = await loadIntegration(env, platform);
  if (!integration?.enabled || !integration.verify_token_enc) {
    throw new HttpError(403, "Webhook verification credentials are not configured");
  }
  const url = new URL(request.url);
  if (url.searchParams.get("hub.mode") !== "subscribe") throw new HttpError(403, "Invalid webhook mode");
  const configured = await decryptSecret(env, integration.verify_token_enc);
  const provided = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge");
  if (!challenge || !constantTimeEqual(configured, provided)) {
    throw new HttpError(403, "Webhook verify token did not match");
  }
  return new Response(challenge, { headers: { "Content-Type": "text/plain" } });
}

export async function handleSocialWebhook(
  request: Request,
  env: Env,
  context: ExecutionContextLike,
  platform: "facebook" | "instagram" | "whatsapp",
): Promise<Response> {
  if (request.method === "GET") return handleVerification(request, env, platform);
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const integration = await loadIntegration(env, platform);
  if (!integration?.enabled || !integration.secret_enc || !integration.app_secret_enc) {
    return new Response("Webhook credentials are not configured", { status: 503 });
  }
  const body = await request.text();
  if (body.length > 1_000_000) return new Response("Payload too large", { status: 413 });
  const appSecret = await decryptSecret(env, integration.app_secret_enc);
  if (!await verifyMetaSignature(body, request.headers.get("X-Hub-Signature-256"), appSecret)) {
    return new Response("Invalid webhook signature", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const messages = platform === "whatsapp"
    ? parseWhatsAppMessages(payload)
    : parseMetaMessages(payload, platform);
  const ids = await insertIncoming(env, messages);
  if (ids.length) context.waitUntil(processPendingIncoming(env, ids, 10));
  return json({ ok: true, accepted: ids.length });
}
