import { decryptSecret, encryptSecret } from "./crypto";
import { authorizeAdmin } from "./auth";
import {
  discoverProviderModels,
  generateReply,
  providerCandidate,
  testProviderConnection,
  validateAiImages,
} from "./ai";
import { boundedInteger, HttpError, json, readJson, requiredString } from "./http";
import { PROVIDER_LIMITATIONS, PROVIDER_PRESETS, type ProviderProtocol } from "./provider-catalog";
import {
  getCommunitySettings,
  recordCommunityActivity,
  saveCommunitySettings,
  validateCommunitySettings,
} from "./community";
import {
  approveTelegramWelcomeDelivery,
  deleteTelegramMessage,
  registerTelegramWebhook,
  retryTelegramWelcomeBatch,
  sendTelegramIncidentResponse,
  sendTelegramWelcomeTest,
} from "./telegram";
import { sendApprovedSocialIncident } from "./social-inbox";
import {
  getAssistantBehaviorSettings,
  saveAssistantBehaviorSettings,
  validateAssistantBehaviorSettings,
} from "./workspace-settings";
import type { Env } from "./types";

async function audit(env: Env, action: string, target?: string): Promise<void> {
  await env.NYAMAL_DB.prepare(
    "INSERT INTO audit_logs(actor,action,target) VALUES('admin',?,?)",
  ).bind(action, target ?? null).run();
}

function secureProviderUrl(value: unknown): string {
  const raw = requiredString(value, "base_url", 8, 500);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "Provider endpoint must be a valid HTTPS URL");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipLiteral = hostname.includes(":") || /^\d+(?:\.\d+){3}$/.test(hostname);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || ipLiteral || hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new HttpError(400, "Provider endpoint must be a public HTTPS URL without credentials, query, or fragment");
  }
  return url.toString().replace(/\/+$/, "");
}

function providerProtocol(value: unknown): ProviderProtocol {
  const protocol = typeof value === "string" ? value : "";
  if (protocol === "openai") return "openai-compatible";
  if (!["openai-compatible", "gemini", "anthropic", "cohere", "azure-openai"].includes(protocol)) {
    throw new HttpError(400, "Unsupported provider API protocol");
  }
  return protocol as ProviderProtocol;
}

function providerAuthHeader(value: unknown, protocol: ProviderProtocol): string {
  const header = typeof value === "string" && value
    ? value
    : protocol === "gemini" ? "x-goog-api-key"
      : protocol === "anthropic" ? "x-api-key"
        : protocol === "azure-openai" ? "api-key" : "Authorization";
  if (!["Authorization", "x-api-key", "x-goog-api-key", "api-key", "none"].includes(header)) {
    throw new HttpError(400, "Unsupported provider API-key header");
  }
  return header;
}

function capabilityMap(value: unknown): Record<string, "supported" | "unsupported"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const allowed = new Set([
    "chat", "reasoning", "coding", "vision", "image_generation", "audio_input",
    "audio_output", "video_input", "search", "tool_calling", "structured_output",
  ]);
  const result: Record<string, "supported" | "unsupported"> = {};
  for (const [key, state] of Object.entries(value as Record<string, unknown>)) {
    if (allowed.has(key) && (state === "supported" || state === "unsupported")) {
      result[key] = state;
    }
  }
  return result;
}

async function overview(env: Env): Promise<Response> {
  const [tasks, providers, models, content, usage, pending] = await Promise.all([
    env.NYAMAL_DB.prepare("SELECT status,COUNT(*) n FROM tasks GROUP BY status").all<{ status: string; n: number }>(),
    env.NYAMAL_DB.prepare("SELECT COUNT(*) n FROM ai_providers WHERE enabled=1").first<{ n: number }>(),
    env.NYAMAL_DB.prepare("SELECT COUNT(*) n FROM ai_models WHERE enabled=1").first<{ n: number }>(),
    env.NYAMAL_DB.prepare("SELECT status,COUNT(*) n FROM content_items GROUP BY status").all<{ status: string; n: number }>(),
    env.NYAMAL_DB.prepare("SELECT COUNT(*) requests,COALESCE(SUM(success),0) successes,COALESCE(SUM(input_tokens),0) input_tokens,COALESCE(SUM(output_tokens),0) output_tokens FROM ai_usage_logs WHERE date(created_at)=date('now')").first(),
    env.NYAMAL_DB.prepare("SELECT COUNT(*) n FROM tasks WHERE status='Awaiting Approval'").first<{ n: number }>(),
  ]);
  return json({
    tasks: Object.fromEntries((tasks.results ?? []).map((item) => [item.status, item.n])),
    providers: providers?.n ?? 0,
    models: models?.n ?? 0,
    content: Object.fromEntries((content.results ?? []).map((item) => [item.status, item.n])),
    usage_today: usage,
    pending_approvals: pending?.n ?? 0,
  });
}

async function saveProvider(env: Env, body: Record<string, unknown>): Promise<Response> {
  const id = requiredString(body.id, "id", 1, 80);
  if (!/^[\w-]+$/.test(id)) throw new HttpError(400, "Invalid provider id");
  const name = requiredString(body.name, "name", 1, 100);
  const protocol = providerProtocol(body.api_protocol ?? body.kind);
  const kind = protocol === "gemini" ? "gemini" : "openai";
  const preset = PROVIDER_PRESETS.find((item) => item.id === body.preset_id);
  if (preset && preset.protocol !== protocol) throw new HttpError(400, "Provider preset and API protocol do not match");
  const baseUrl = secureProviderUrl(body.base_url);
  const authHeader = providerAuthHeader(body.auth_header, protocol);
  const authPrefix = typeof body.auth_prefix === "string"
    ? body.auth_prefix.slice(0, 40)
    : protocol === "anthropic" || protocol === "gemini" || protocol === "azure-openai" ? "" : "Bearer ";
  const modelListPath = typeof body.model_list_path === "string"
    ? body.model_list_path.trim()
    : preset?.model_list_path ?? "/models";
  if (modelListPath && (!modelListPath.startsWith("/") || modelListPath.startsWith("//") || modelListPath.includes(".."))) {
    throw new HttpError(400, "Model-list path must be a safe relative path");
  }
  const apiVersion = typeof body.api_version === "string" ? body.api_version.trim() : preset?.api_version ?? null;
  if (protocol === "azure-openai" && !apiVersion) throw new HttpError(400, "Azure OpenAI requires its deployments API version");
  const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
  const secret = apiKey ? await encryptSecret(env, requiredString(apiKey, "api_key", 1, 4000)) : null;
  const priority = boundedInteger(body.priority, "priority", 100, 1, 10000);
  if (!secret && !await env.NYAMAL_DB.prepare(
    "SELECT 1 FROM ai_credentials WHERE provider_id=?",
  ).bind(id).first()) {
    throw new HttpError(400, "An API key is required when creating a provider");
  }
  const statements = [
    env.NYAMAL_DB.prepare(
      `INSERT INTO ai_providers(id,name,kind,base_url,enabled,priority,api_protocol,auth_header,auth_prefix,model_list_path,api_version)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,base_url=excluded.base_url,
         enabled=excluded.enabled,priority=excluded.priority,api_protocol=excluded.api_protocol,
         auth_header=excluded.auth_header,auth_prefix=excluded.auth_prefix,
         model_list_path=excluded.model_list_path,api_version=excluded.api_version`,
    ).bind(id, name, kind, baseUrl, body.enabled === false ? 0 : 1, priority, protocol,
      authHeader, authPrefix, modelListPath || null, apiVersion || null),
  ];
  if (secret) {
    statements.push(env.NYAMAL_DB.prepare(
      "INSERT INTO ai_credentials(provider_id,secret_enc,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(provider_id) DO UPDATE SET secret_enc=excluded.secret_enc,updated_at=CURRENT_TIMESTAMP",
    ).bind(id, secret));
  }
  await env.NYAMAL_DB.batch(statements);
  await audit(env, "ai.provider.saved", id);
  return json({ ok: true, id, secret: "stored encrypted; never returned" });
}

async function saveModel(env: Env, body: Record<string, unknown>): Promise<Response> {
  const id = typeof body.id === "string" && body.id ? body.id : crypto.randomUUID();
  const providerId = requiredString(body.provider_id, "provider_id", 1, 80);
  const modelName = requiredString(body.model_name, "model_name", 1, 200);
  if (!await env.NYAMAL_DB.prepare("SELECT 1 FROM ai_providers WHERE id=?").bind(providerId).first()) {
    throw new HttpError(404, "Provider not found");
  }
  const taskTypes = typeof body.task_types === "string" ? body.task_types.trim() : "chat,content,analysis";
  const supportedTasks = new Set(["chat", "content", "analysis", "research", "coding", "translation", "summarization", "all"]);
  const tasks = taskTypes.split(",").map((item) => item.trim()).filter(Boolean);
  if (tasks.some((task) => !supportedTasks.has(task))) throw new HttpError(400, "Unsupported model task type");
  const capabilities = capabilityMap(body.capabilities_json ?? body.capabilities);
  const capabilityText = typeof body.capabilities === "string"
    ? body.capabilities.slice(0, 500)
    : Object.entries(capabilities).filter(([, state]) => state === "supported").map(([key]) => key).join(",");
  const optionalInteger = (value: unknown, name: string, maximum: number): number | null => (
    value === undefined || value === null || value === ""
      ? null
      : boundedInteger(value, name, 1, 1, maximum)
  );
  const optionalCost = (value: unknown, name: string): number | null => {
    if (value === undefined || value === null || value === "") return null;
    const cost = Number(value);
    if (!Number.isFinite(cost) || cost < 0 || cost > 1_000_000) {
      throw new HttpError(400, `${name} must be a non-negative number`);
    }
    return cost;
  };
  const catalogStatus = body.catalog_status === "discovered" ? "discovered" : "manual";
  await env.NYAMAL_DB.prepare(
    `INSERT INTO ai_models(id,provider_id,model_name,display_name,enabled,priority,task_types,context_window,capabilities,
       daily_token_limit,daily_request_limit,capabilities_json,catalog_status,last_seen_at,input_cost_per_million,output_cost_per_million)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ?='discovered' THEN CURRENT_TIMESTAMP ELSE NULL END,?,?)
     ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id,model_name=excluded.model_name,
       display_name=excluded.display_name,enabled=excluded.enabled,priority=excluded.priority,
       task_types=excluded.task_types,context_window=excluded.context_window,capabilities=excluded.capabilities,
       daily_token_limit=excluded.daily_token_limit,daily_request_limit=excluded.daily_request_limit,
       capabilities_json=excluded.capabilities_json,catalog_status=excluded.catalog_status,
       last_seen_at=COALESCE(excluded.last_seen_at,ai_models.last_seen_at),
       input_cost_per_million=excluded.input_cost_per_million,output_cost_per_million=excluded.output_cost_per_million`,
  ).bind(
    id, providerId, modelName, typeof body.display_name === "string" ? body.display_name : modelName,
    body.enabled === false ? 0 : 1, boundedInteger(body.priority, "priority", 100, 1, 10000),
    taskTypes, optionalInteger(body.context_window, "context_window", 10_000_000), capabilityText || "unknown",
    optionalInteger(body.daily_token_limit, "daily_token_limit", 2_000_000_000),
    optionalInteger(body.daily_request_limit, "daily_request_limit", 2_000_000_000),
    JSON.stringify(capabilities), catalogStatus, catalogStatus,
    optionalCost(body.input_cost_per_million, "input_cost_per_million"),
    optionalCost(body.output_cost_per_million, "output_cost_per_million"),
  ).run();
  await audit(env, "ai.model.saved", id);
  return json({ ok: true, id });
}

async function publishContent(env: Env, contentId: string): Promise<Response> {
  const item = await env.NYAMAL_DB.prepare(
    "SELECT id,title,status,platform FROM content_items WHERE id=?",
  ).bind(contentId).first<{ id: string; title: string; status: string; platform: string }>();
  if (!item || item.status !== "approved") throw new HttpError(409, "Content must be approved before publishing");
  if (item.platform === "draft") throw new HttpError(400, "Choose a publishing platform before queuing this draft");
  const integration = await env.NYAMAL_DB.prepare(
    "SELECT 1 FROM integrations WHERE platform=? AND enabled=1 AND secret_enc IS NOT NULL",
  ).bind(item.platform).first();
  if (!integration) throw new HttpError(409, `No enabled ${item.platform} integration with stored credentials`);
  const taskId = crypto.randomUUID();
  await env.NYAMAL_DB.prepare(
    "INSERT INTO tasks(id,name,task_type,payload_json,priority,status,timezone,next_execution_at) VALUES(?,?,'content.publish',?,5,'Pending',?,CURRENT_TIMESTAMP)",
  ).bind(taskId, `Publish: ${item.title}`, JSON.stringify({ content_id: contentId }), env.NYAMAL_TIMEZONE ?? "UTC").run();
  await env.NYAMAL_DB.batch([
    env.NYAMAL_DB.prepare("UPDATE content_items SET status='queued',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(contentId),
    env.NYAMAL_DB.prepare(
      `INSERT INTO content_publications(id,content_id,platform,content_version,status,next_attempt_at,idempotency_key)
       VALUES(?,?,?,?, 'queued',CURRENT_TIMESTAMP,?)
       ON CONFLICT(content_id,platform,content_version) DO UPDATE SET status='queued',next_attempt_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`,
    ).bind(crypto.randomUUID(), contentId, item.platform, 1,
      `content:${contentId}:${item.platform}:1`),
  ]);
  await audit(env, "content.publish.queued", contentId);
  return json({ ok: true, task_id: taskId });
}

export async function handleAdmin(request: Request, env: Env, path: string): Promise<Response> {
  await authorizeAdmin(request, env);
  const method = request.method;
  if (path === "/overview" && method === "GET") return overview(env);
  if (path === "/settings/assistant-behavior" && method === "GET") {
    return json({ settings: await getAssistantBehaviorSettings(env) });
  }
  if (path === "/settings/assistant-behavior" && method === "PUT") {
    const settings = validateAssistantBehaviorSettings(await readJson(request));
    await saveAssistantBehaviorSettings(env, settings);
    await audit(env, "settings.assistant_behavior.updated");
    return json({ settings });
  }
  if (path === "/community/settings" && method === "GET") {
    return json({ settings: await getCommunitySettings(env) });
  }
  if (path === "/community/settings" && method === "PUT") {
    const settings = validateCommunitySettings(await readJson(request));
    await saveCommunitySettings(env, settings);
    await audit(env, "community.settings.updated");
    return json({ settings });
  }
  if (path === "/community/welcome/test" && method === "POST") {
    const body = await readJson(request);
    const chatId = requiredString(body.chat_id, "chat_id", 1, 24);
    if (!/^-?\d+$/.test(chatId) || !Number.isSafeInteger(Number(chatId)) || Number(chatId) === 0) {
      throw new HttpError(400, "Telegram chat ID must be a non-zero integer");
    }
    const type = body.type === undefined ? "collective" : body.type;
    if (type !== "individual" && type !== "collective") {
      throw new HttpError(400, "Welcome test type must be individual or collective");
    }
    await sendTelegramWelcomeTest(env, chatId, type);
    await audit(env, "community.welcome.tested", `${type}:${chatId}`);
    return json({ ok: true });
  }
  if (path === "/community/welcome/batches" && method === "GET") {
    const limit = boundedInteger(new URL(request.url).searchParams.get("limit"), "limit", 30, 1, 100);
    const batches = await env.NYAMAL_DB.prepare(
      `SELECT b.id,b.chat_id,b.status,b.safe_to_retry,b.last_error,b.created_at,
         COUNT(DISTINCT e.user_id) member_count,COUNT(DISTINCT d.id) message_count
       FROM telegram_welcome_batches b
       LEFT JOIN telegram_welcome_events e ON e.batch_id=b.id
       LEFT JOIN telegram_welcome_deliveries d ON d.batch_id=b.id
       WHERE b.status IN ('ready','review','failed')
       GROUP BY b.id ORDER BY b.created_at DESC LIMIT ?`,
    ).bind(limit).all();
    return json({ batches: batches.results ?? [] });
  }
  const welcomeRetry = path.match(/^\/community\/welcome\/batches\/([^/]+)\/retry$/);
  if (welcomeRetry && method === "POST") {
    await retryTelegramWelcomeBatch(env, welcomeRetry[1]);
    await audit(env, "community.welcome.retry_requested", welcomeRetry[1]);
    return json({ ok: true });
  }
  if (path === "/community/overview" && method === "GET") {
    const [pending, integrations, events, recent] = await Promise.all([
      env.NYAMAL_DB.prepare(
        "SELECT COUNT(*) n FROM community_incidents WHERE status IN ('pending','failed')",
      ).first<{ n: number }>(),
      env.NYAMAL_DB.prepare(
        "SELECT COUNT(*) n FROM integrations WHERE enabled=1 AND platform IN ('telegram','facebook','instagram','whatsapp')",
      ).first<{ n: number }>(),
      env.NYAMAL_DB.prepare(
        `SELECT event_type,COUNT(*) n FROM community_activity
         WHERE created_at>=datetime('now','-7 days') GROUP BY event_type`,
      ).all<{ event_type: string; n: number }>(),
      env.NYAMAL_DB.prepare(
        `SELECT id,platform,event_type,actor_id,remote_id,details,created_at
         FROM community_activity WHERE event_type<>'response_reserved' ORDER BY id DESC LIMIT 10`,
      ).all(),
    ]);
    return json({
      pending_incidents: pending?.n ?? 0,
      connected_platforms: integrations?.n ?? 0,
      activity_7d: Object.fromEntries((events.results ?? []).map((item) => [item.event_type, item.n])),
      recent_activity: recent.results ?? [],
    });
  }
  if (path === "/community/incidents" && method === "GET") {
    const url = new URL(request.url);
    const limit = boundedInteger(url.searchParams.get("limit"), "limit", 50, 1, 200);
    const status = url.searchParams.get("status");
    const allowedStatuses = new Set(["pending", "processing", "completed", "dismissed", "deleted", "failed"]);
    if (status && !allowedStatuses.has(status)) throw new HttpError(400, "Invalid community incident status");
    const incidents = status
      ? await env.NYAMAL_DB.prepare(
        `SELECT id,platform,kind,risk,status,reason,message_text,proposed_response,sender_id,
         community_id,message_id,action,last_error,created_at,updated_at
         FROM community_incidents WHERE status=? ORDER BY created_at DESC LIMIT ?`,
      ).bind(status, limit).all()
      : await env.NYAMAL_DB.prepare(
        `SELECT id,platform,kind,risk,status,reason,message_text,proposed_response,sender_id,
         community_id,message_id,action,last_error,created_at,updated_at
         FROM community_incidents ORDER BY created_at DESC LIMIT ?`,
      ).bind(limit).all();
    return json({ incidents: incidents.results ?? [] });
  }
  if (path === "/community/activity" && method === "GET") {
    const url = new URL(request.url);
    const limit = boundedInteger(url.searchParams.get("limit"), "limit", 50, 1, 200);
    const events = await env.NYAMAL_DB.prepare(
      `SELECT id,platform,event_type,actor_id,remote_id,details,created_at
       FROM community_activity ORDER BY id DESC LIMIT ?`,
    ).bind(limit).all();
    return json({ activity: events.results ?? [] });
  }
  const communityAction = path.match(/^\/community\/incidents\/([^/]+)\/(approve|dismiss|delete)$/);
  if (communityAction && method === "POST") {
    const incident = await env.NYAMAL_DB.prepare(
      `SELECT id,source_key,platform,kind,status,proposed_response,sender_id,community_id,message_id
       FROM community_incidents WHERE id=?`,
    ).bind(communityAction[1]).first<{
      id: string;
      source_key: string;
      platform: string;
      kind: string;
      status: string;
      proposed_response: string | null;
      sender_id: string | null;
      community_id: string | null;
      message_id: string | null;
    }>();
    if (!incident) throw new HttpError(404, "Community incident not found");
    const action = communityAction[2];
    if (!["pending", "failed"].includes(incident.status)) {
      throw new HttpError(409, "This incident is no longer waiting for review");
    }
    if (action === "dismiss") {
      const dismissed = await env.NYAMAL_DB.prepare(
        "UPDATE community_incidents SET status='dismissed',action='dismissed',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('pending','failed')",
      ).bind(incident.id).run();
      if (!dismissed.meta.changes) throw new HttpError(409, "This incident is no longer waiting for review");
      await audit(env, "community.incident.dismissed", incident.id);
      return json({ ok: true });
    }
    if (action === "approve" && (incident.kind !== "response" || !incident.proposed_response || !incident.sender_id)) {
      throw new HttpError(400, "Only response drafts with a recipient can be approved");
    }
    if (action === "delete" && (incident.kind !== "moderation" || incident.platform !== "telegram"
      || !incident.community_id || !incident.message_id)) {
      throw new HttpError(400, "Only flagged Telegram messages can be deleted here");
    }
    const claimed = await env.NYAMAL_DB.prepare(
      "UPDATE community_incidents SET status='processing',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('pending','failed')",
    ).bind(incident.id).run();
    if (!claimed.meta.changes) throw new HttpError(409, "This incident is already being processed");
    try {
      if (action === "approve") {
        const welcomeDelivery = incident.source_key.match(/^telegram:welcome:([0-9a-f-]{36}):(\d+)$/i);
        if (incident.platform === "telegram" && welcomeDelivery) {
          if (!incident.community_id) throw new Error("Telegram welcome has no destination chat");
          await approveTelegramWelcomeDelivery(
            env,
            welcomeDelivery[1],
            Number(welcomeDelivery[2]),
            incident.community_id,
          );
          await env.NYAMAL_DB.prepare(
            "UPDATE community_incidents SET status='completed',action='response_sent',updated_at=CURRENT_TIMESTAMP WHERE id=?",
          ).bind(incident.id).run();
          await audit(env, "community.welcome.approved", incident.id);
          return json({ ok: true });
        }
        if (incident.platform === "telegram") {
          if (!incident.community_id) throw new Error("Telegram incident has no chat ID");
          await sendTelegramIncidentResponse(
            env, incident.community_id, incident.message_id, incident.proposed_response!,
          );
        } else if (["facebook", "instagram", "whatsapp"].includes(incident.platform)) {
          await sendApprovedSocialIncident(env, {
            platform: incident.platform as "facebook" | "instagram" | "whatsapp",
            sender_id: incident.sender_id!,
            community_id: incident.community_id,
            proposed_response: incident.proposed_response!,
          });
        } else {
          throw new Error("This platform does not support approved community replies");
        }
        await env.NYAMAL_DB.prepare(
          "UPDATE community_incidents SET status='completed',action='response_sent',updated_at=CURRENT_TIMESTAMP WHERE id=?",
        ).bind(incident.id).run();
        await recordCommunityActivity(env, {
          eventKey: `incident:${incident.id}:response-approved`,
          platform: incident.platform,
          eventType: "response_sent",
          actorId: incident.sender_id ?? undefined,
          remoteId: incident.message_id ?? undefined,
        });
        await audit(env, "community.incident.approved", incident.id);
        return json({ ok: true });
      }
      if (!incident.community_id || !incident.message_id) throw new Error("Telegram incident has no message identifiers");
      await deleteTelegramMessage(env, incident.community_id, incident.message_id);
      await env.NYAMAL_DB.prepare(
        "UPDATE community_incidents SET status='deleted',action='message_deleted',updated_at=CURRENT_TIMESTAMP WHERE id=?",
      ).bind(incident.id).run();
      await recordCommunityActivity(env, {
        eventKey: `incident:${incident.id}:message-deleted`,
        platform: incident.platform,
        eventType: "moderation_deleted",
        actorId: incident.sender_id ?? undefined,
        remoteId: incident.message_id,
        details: incident.kind,
      });
      await audit(env, "community.incident.message_deleted", incident.id);
      return json({ ok: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Community action failed";
      await env.NYAMAL_DB.prepare(
        "UPDATE community_incidents SET status='failed',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      ).bind(detail.slice(0, 500), incident.id).run();
      throw new HttpError(502, detail);
    }
  }
  if (path === "/ai/chat" && method === "GET") {
    const result = await env.NYAMAL_DB.prepare(
      "SELECT id,role,content,created_at FROM messages WHERE user_id=-1 ORDER BY id DESC LIMIT 40",
    ).all();
    return json({ messages: (result.results ?? []).reverse() });
  }
  if (path === "/ai/chat" && method === "POST") {
    const body = await readJson(request);
    const images = validateAiImages(body.images);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const prompt = message
      ? requiredString(message, "message", 1, 4000)
      : images.length ? "Please describe the attached image." : "";
    if (!prompt) throw new HttpError(400, "Enter a message or attach an image");
    let answer: string;
    try {
      answer = await generateReply(env, -1, prompt, "chat", { images });
    } catch (error) {
      if (error instanceof Error && error.message.includes("No enabled model")) {
        throw new HttpError(409, error.message);
      }
      throw new HttpError(502, "All enabled AI providers failed. Check provider health and model availability.");
    }
    await audit(env, "ai.admin_chat");
    return json({ answer });
  }
  if (path === "/ai/chat" && method === "DELETE") {
    await env.NYAMAL_DB.prepare("DELETE FROM messages WHERE user_id=-1").run();
    await audit(env, "ai.admin_chat.cleared");
    return json({ ok: true });
  }
  if (path === "/telegram/webhook" && method === "POST") {
    await registerTelegramWebhook(env, new URL(request.url).origin);
    await audit(env, "telegram.webhook.registered");
    return json({ ok: true });
  }
  if (path === "/tasks" && method === "GET") {
    const url = new URL(request.url);
    const limit = boundedInteger(url.searchParams.get("limit"), "limit", 100, 1, 500);
    const status = url.searchParams.get("status");
    const result = status
      ? await env.NYAMAL_DB.prepare("SELECT * FROM tasks WHERE status=? ORDER BY priority,created_at DESC LIMIT ?").bind(status, limit).all()
      : await env.NYAMAL_DB.prepare("SELECT * FROM tasks ORDER BY priority,created_at DESC LIMIT ?").bind(limit).all();
    return json({ tasks: result.results ?? [] });
  }
  if (path === "/tasks" && method === "POST") {
    const body = await readJson(request);
    const id = crypto.randomUUID();
    const name = requiredString(body.name, "name", 1, 160);
    const taskType = requiredString(body.task_type, "task_type", 1, 120);
    if (!["content.publish", "reports.daily"].includes(taskType)) {
      throw new HttpError(400, "Workers Free currently supports only content.publish and reports.daily task types; Python task handlers are not executable here");
    }
    const payload = JSON.stringify(body.payload && typeof body.payload === "object" ? body.payload : {});
    const approval = body.require_approval === true;
    const scheduleType = typeof body.schedule_type === "string" ? body.schedule_type : "once";
    const scheduleValue = typeof body.schedule_value === "string" ? body.schedule_value : "";
    if (!["once", "interval", "daily", "weekly", "monthly"].includes(scheduleType)) {
      throw new HttpError(400, "Unsupported schedule type");
    }
    if (scheduleType === "interval" && (!/^\d+$/.test(scheduleValue) || Number(scheduleValue) < 60)) {
      throw new HttpError(400, "Interval schedules require at least 60 seconds");
    }
    const scheduledAt = typeof body.next_execution_at === "string" && body.next_execution_at.trim()
      ? body.next_execution_at.trim()
      : new Date().toISOString();
    let parsedScheduled: Date;
    try { parsedScheduled = new Date(scheduledAt); } catch { throw new HttpError(400, "Invalid scheduled time"); }
    if (!Number.isFinite(parsedScheduled.getTime())) throw new HttpError(400, "Invalid scheduled time");
    const status = approval ? "Awaiting Approval"
      : scheduleType === "once" && parsedScheduled.getTime() > Date.now() ? "Scheduled"
        : scheduleType !== "once" ? "Scheduled" : "Pending";
    await env.NYAMAL_DB.prepare(
      `INSERT INTO tasks(id,name,task_type,payload_json,priority,status,schedule_type,schedule_value,timezone,next_execution_at,max_retries,timeout_seconds)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, name, taskType, payload, boundedInteger(body.priority, "priority", 5, 1, 10),
      status, scheduleType, scheduleValue, env.NYAMAL_TIMEZONE ?? "UTC",
      approval ? null : parsedScheduled.toISOString(),
      boundedInteger(body.max_retries, "max_retries", 3, 0, 20),
      boundedInteger(body.timeout_seconds, "timeout_seconds", 300, 5, 3600)).run();
    await audit(env, "task.created", id);
    return json({ id, name, task_type: taskType, status: approval ? "Awaiting Approval" : "Pending" }, 201);
  }
  const taskAction = path.match(/^\/tasks\/([^/]+)\/(approve|reject|run|pause|resume|cancel|enable|disable)$/);
  if (taskAction && method === "POST") {
    const [, id, action] = taskAction;
    const states: Record<string, string> = { approve: "Pending", reject: "Cancelled", run: "Pending", pause: "Paused", resume: "Pending", cancel: "Cancelled" };
    const status = states[action];
    const result = status
      ? await env.NYAMAL_DB.prepare(
        `UPDATE tasks SET status=?,next_execution_at=CASE WHEN ?='Pending' THEN CURRENT_TIMESTAMP ELSE next_execution_at END WHERE id=?${["approve", "reject"].includes(action) ? " AND status='Awaiting Approval'" : ""}`,
      ).bind(status, status, id).run()
      : await env.NYAMAL_DB.prepare("UPDATE tasks SET enabled=? WHERE id=?").bind(action === "enable" ? 1 : 0, id).run();
    if (!result.meta.changes) throw new HttpError(404, "Task not found or action not allowed");
    await audit(env, `task.${action}`, id);
    return json({ ok: true });
  }
  if (path === "/ai/providers/catalog" && method === "GET") {
    return json({ providers: PROVIDER_PRESETS, limitations: PROVIDER_LIMITATIONS });
  }
  if (path === "/ai/providers" && method === "GET") {
    const result = await env.NYAMAL_DB.prepare(
      `SELECT p.id,p.name,p.kind,p.api_protocol,p.base_url,p.auth_header,p.auth_prefix,p.model_list_path,p.api_version,
              p.enabled,p.priority,c.secret_enc IS NOT NULL has_key,h.last_status,h.last_error,h.checked_at,
              (SELECT COUNT(*) FROM ai_models m WHERE m.provider_id=p.id) models
         FROM ai_providers p LEFT JOIN ai_credentials c ON c.provider_id=p.id
         LEFT JOIN ai_provider_health h ON h.provider_id=p.id ORDER BY p.priority`,
    ).all();
    return json({ providers: result.results ?? [] });
  }
  if (path === "/ai/providers" && method === "POST") return saveProvider(env, await readJson(request));
  const providerPath = path.match(/^\/ai\/providers\/([^/]+)(?:\/(test|discover|import))?$/);
  if (providerPath && method === "DELETE" && !providerPath[2]) {
    const result = await env.NYAMAL_DB.prepare("DELETE FROM ai_providers WHERE id=?").bind(providerPath[1]).run();
    if (!result.meta.changes) throw new HttpError(404, "Provider not found");
    return json({ ok: true });
  }
  if (providerPath && providerPath[2] === "discover" && method === "GET") {
    try {
      const result = await discoverProviderModels(env, providerPath[1]);
      await audit(env, "ai.models.discovered", providerPath[1]);
      return json({ ...result, count: result.models.length });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Model discovery failed";
      throw new HttpError(detail.includes("not found") ? 404 : 502, detail);
    }
  }
  if (providerPath && providerPath[2] === "import" && method === "POST") {
    const body = await readJson(request);
    if (!Array.isArray(body.model_ids) || !body.model_ids.length || body.model_ids.length > 100
      || body.model_ids.some((item) => typeof item !== "string" || !item.trim())) {
      throw new HttpError(400, "model_ids must contain between 1 and 100 model IDs");
    }
    const discovery = await discoverProviderModels(env, providerPath[1]);
    const selected = new Set((body.model_ids as string[]).map((item) => item.trim()));
    const models = discovery.models.filter((model) => selected.has(model.id));
    if (models.length !== selected.size) throw new HttpError(400, "Import only model IDs returned by the provider's live catalog");
    const provider = await env.NYAMAL_DB.prepare("SELECT priority FROM ai_providers WHERE id=?")
      .bind(providerPath[1]).first<{ priority: number }>();
    if (!provider) throw new HttpError(404, "Provider not found");
    const imported: Array<{ id: string; model_name: string; status: string }> = [];
    for (const model of models) {
      const existing = await env.NYAMAL_DB.prepare(
        "SELECT id FROM ai_models WHERE provider_id=? AND model_name=? ORDER BY created_at LIMIT 1",
      ).bind(providerPath[1], model.id).first<{ id: string }>();
      const id = existing?.id ?? crypto.randomUUID();
      const capabilitiesJson = JSON.stringify(model.capabilities);
      if (existing) {
        await env.NYAMAL_DB.prepare(
          `UPDATE ai_models SET display_name=?,capabilities_json=CASE WHEN ?='{}' THEN capabilities_json ELSE ? END,
             context_window=COALESCE(?,context_window),input_cost_per_million=COALESCE(?,input_cost_per_million),
             output_cost_per_million=COALESCE(?,output_cost_per_million),
             catalog_status='discovered',last_seen_at=CURRENT_TIMESTAMP
           WHERE id=?`,
        ).bind(model.display_name, capabilitiesJson, capabilitiesJson, model.context_window ?? null,
          model.input_cost_per_million ?? null, model.output_cost_per_million ?? null, id).run();
      } else {
        await env.NYAMAL_DB.prepare(
          `INSERT INTO ai_models(id,provider_id,model_name,display_name,enabled,priority,task_types,context_window,
             capabilities,capabilities_json,catalog_status,last_seen_at,input_cost_per_million,output_cost_per_million)
           VALUES(?,?,?,?,0,100,'',?,'unknown',?,'discovered',CURRENT_TIMESTAMP,?,?)`,
        ).bind(id, providerPath[1], model.id, model.display_name, model.context_window ?? null, capabilitiesJson,
          model.input_cost_per_million ?? null, model.output_cost_per_million ?? null).run();
      }
      imported.push({ id, model_name: model.id, status: existing ? "updated" : "added_disabled" });
    }
    await audit(env, "ai.models.imported", providerPath[1]);
    return json({ imported });
  }
  if (providerPath && providerPath[2] === "test" && method === "POST") {
    const candidate = await providerCandidate(env, providerPath[1]);
    if (!candidate) throw new HttpError(404, "Enabled provider needs an encrypted API key and enabled model");
    const result = await testProviderConnection(env, providerPath[1]);
    await audit(env, "ai.provider.tested", providerPath[1]);
    return json(result);
  }
  if (path === "/ai/models" && method === "GET") {
    const result = await env.NYAMAL_DB.prepare("SELECT m.*,p.name provider_name FROM ai_models m JOIN ai_providers p ON p.id=m.provider_id ORDER BY m.priority,p.priority").all();
    return json({ models: result.results ?? [] });
  }
  if (path === "/ai/models" && method === "POST") return saveModel(env, await readJson(request));
  const modelPath = path.match(/^\/ai\/models\/([^/]+)$/);
  if (modelPath && method === "DELETE") {
    const result = await env.NYAMAL_DB.prepare("DELETE FROM ai_models WHERE id=?").bind(modelPath[1]).run();
    if (!result.meta.changes) throw new HttpError(404, "Model not found");
    return json({ ok: true });
  }
  if (modelPath && method === "PATCH") {
    const body = await readJson(request);
    const allowed = ["priority", "enabled", "task_types", "daily_token_limit", "daily_request_limit", "capabilities", "context_window"];
    const changes = Object.entries(body).filter(([key]) => allowed.includes(key));
    if (!changes.length) throw new HttpError(400, "No supported model settings supplied");
    const setters = changes.map(([key]) => `${key}=?`).join(",");
    const values = changes.map(([key, value]) => key === "enabled" ? Number(Boolean(value)) : value);
    const result = await env.NYAMAL_DB.prepare(`UPDATE ai_models SET ${setters} WHERE id=?`).bind(...values, modelPath[1]).run();
    if (!result.meta.changes) throw new HttpError(404, "Model not found");
    return json({ ok: true });
  }
  if (path === "/ai/usage" && method === "GET") {
    const limit = boundedInteger(new URL(request.url).searchParams.get("limit"), "limit", 100, 1, 500);
    const result = await env.NYAMAL_DB.prepare("SELECT l.*,p.name provider_name,m.model_name FROM ai_usage_logs l LEFT JOIN ai_providers p ON p.id=l.provider_id LEFT JOIN ai_models m ON m.id=l.model_id ORDER BY l.id DESC LIMIT ?").bind(limit).all();
    return json({ usage: result.results ?? [] });
  }
  if (path === "/content" && method === "GET") {
    const result = await env.NYAMAL_DB.prepare("SELECT * FROM content_items ORDER BY created_at DESC LIMIT 200").all();
    const publications = await env.NYAMAL_DB.prepare(
      "SELECT * FROM content_publications ORDER BY updated_at DESC LIMIT 500",
    ).all();
    return json({ items: result.results ?? [], publications: publications.results ?? [] });
  }
  if (path === "/content" && method === "POST") {
    const body = await readJson(request);
    const id = crypto.randomUUID();
    const platform = typeof body.platform === "string" ? body.platform : "draft";
    const platforms = Array.isArray(body.platforms)
      ? body.platforms.filter((item): item is string => typeof item === "string")
      : [platform];
    const allowedPlatforms = new Set(["draft", "telegram", "facebook", "instagram", "whatsapp", "naath_heritage", "custom_rest"]);
    if (platforms.length < 1 || platforms.length > 12 || platforms.some((item) => !allowedPlatforms.has(item))) {
      throw new HttpError(400, "Unsupported or excessive publishing platforms");
    }
    const category = typeof body.category === "string" ? body.category.slice(0, 80) : "general";
    const sourceUrls = Array.isArray(body.source_urls)
      ? body.source_urls.filter((item): item is string => typeof item === "string").slice(0, 50)
      : [];
    const status = body.require_approval === false ? "draft" : "awaiting_approval";
    await env.NYAMAL_DB.prepare(
      "INSERT INTO content_items(id,title,body,platform,status,created_by,media_url,link_url,category,source_urls_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(id, requiredString(body.title, "title", 1, 240), requiredString(body.body, "body", 1, 20000), platform,
        status, "admin", body.media_url ?? null, body.link_url ?? null, category, JSON.stringify(sourceUrls)).run();
    const publicationRows = [];
    for (const targetPlatform of [...new Set(platforms)].filter((item) => item !== "draft")) {
      const policy = await env.NYAMAL_DB.prepare(
        "SELECT mode FROM publishing_policies WHERE platform=? AND category=?",
      ).bind(targetPlatform, category).first<{ mode: string }>();
      const mode = policy?.mode ?? "manual";
      const sensitive = ["sensitive_political", "conflict", "humanitarian_emergency", "breaking_news", "major_statement", "financial_commitment"].includes(category);
      const publicationStatus = sensitive ? "awaiting_approval"
        : mode === "autonomous" && body.require_approval === false ? "scheduled"
          : status === "draft" ? "draft" : "awaiting_approval";
      const publicationId = crypto.randomUUID();
      const scheduledAt = typeof body.scheduled_at === "string" && body.scheduled_at.trim()
        ? body.scheduled_at.trim()
        : null;
      await env.NYAMAL_DB.prepare(
        `INSERT INTO content_publications(id,content_id,platform,content_version,status,scheduled_at,next_attempt_at,idempotency_key)
         VALUES(?,?,?,?,1,?,?,?)`,
      ).bind(
        publicationId, id, targetPlatform, publicationStatus, scheduledAt,
        scheduledAt ?? new Date().toISOString(), `content:${id}:${targetPlatform}:1`,
      ).run();
      await env.NYAMAL_DB.prepare(
        "INSERT INTO publication_events(publication_id,event,details) VALUES(?,'created',?)",
      ).bind(publicationId, `platform=${targetPlatform};mode=${mode};sensitive=${sensitive}`).run();
      publicationRows.push({ id: publicationId, platform: targetPlatform, status: publicationStatus });
    }
    await audit(env, "content.created", id);
    return json({ id, status, publications: publicationRows }, 201);
  }
  const contentAction = path.match(/^\/content\/([^/]+)\/(approve|reject|publish)$/);
  if (contentAction && method === "POST") {
    if (contentAction[2] === "publish") return publishContent(env, contentAction[1]);
    const nextStatus = contentAction[2] === "approve" ? "approved" : "rejected";
    const result = await env.NYAMAL_DB.prepare(
      "UPDATE content_items SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('draft','awaiting_approval')",
    ).bind(nextStatus, contentAction[1]).run();
    if (!result.meta.changes) throw new HttpError(404, "Content not found or not awaiting approval");
    await audit(env, `content.${contentAction[2]}`, contentAction[1]);
    return json({ ok: true });
  }
  const contentDelete = path.match(/^\/content\/([^/]+)$/);
  if (contentDelete && method === "DELETE") {
    const result = await env.NYAMAL_DB.prepare("DELETE FROM content_items WHERE id=?").bind(contentDelete[1]).run();
    if (!result.meta.changes) throw new HttpError(404, "Content not found");
    return json({ ok: true });
  }
  if (path === "/integrations" && method === "GET") {
    const result = await env.NYAMAL_DB.prepare(
      "SELECT id,platform,name,config_json,enabled,status,updated_at,secret_enc IS NOT NULL has_secret,app_secret_enc IS NOT NULL has_app_secret,verify_token_enc IS NOT NULL has_verify_token FROM integrations ORDER BY platform",
    ).all();
    return json({ integrations: (result.results ?? []).map((item) => ({
      ...item,
      config: typeof item.config_json === "string" ? JSON.parse(item.config_json) : {},
      webhook_path: ["facebook", "instagram", "whatsapp"].includes(String(item.platform))
        ? `/webhooks/${item.platform}`
        : null,
    })) });
  }
  if (path === "/integrations" && method === "POST") {
    const body = await readJson(request);
    const platform = requiredString(body.platform, "platform", 1, 80);
    if (!["telegram", "facebook", "instagram", "whatsapp", "naath_heritage", "custom_rest"].includes(platform)) {
      throw new HttpError(400, "Unsupported integration platform");
    }
    const name = requiredString(body.name, "name", 1, 120);
    const configValues = body.config && typeof body.config === "object" && !Array.isArray(body.config)
      ? { ...(body.config as Record<string, unknown>) }
      : {};
    const appSecretValue = body.app_secret ?? configValues.app_secret;
    const verifyTokenValue = body.verify_token ?? configValues.verify_token;
    delete configValues.app_secret;
    delete configValues.verify_token;
    const config = JSON.stringify(configValues);
    const secret = typeof body.secret === "string" && body.secret ? await encryptSecret(env, body.secret) : null;
    const appSecret = typeof appSecretValue === "string" && appSecretValue
      ? await encryptSecret(env, appSecretValue)
      : null;
    const verifyToken = typeof verifyTokenValue === "string" && verifyTokenValue
      ? await encryptSecret(env, verifyTokenValue)
      : null;
    if (["facebook", "instagram", "whatsapp"].includes(platform)
      && !appSecret
      && !await env.NYAMAL_DB.prepare("SELECT app_secret_enc FROM integrations WHERE id=? AND app_secret_enc IS NOT NULL").bind(platform).first()) {
      throw new HttpError(400, "Meta App Secret is required for inbound message webhooks");
    }
    if (["facebook", "instagram", "whatsapp"].includes(platform)
      && !verifyToken
      && !await env.NYAMAL_DB.prepare("SELECT verify_token_enc FROM integrations WHERE id=? AND verify_token_enc IS NOT NULL").bind(platform).first()) {
      throw new HttpError(400, "Webhook Verify Token is required for inbound message webhooks");
    }
    await env.NYAMAL_DB.prepare(
      `INSERT INTO integrations(id,platform,name,config_json,secret_enc,app_secret_enc,verify_token_enc,enabled,status,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name,config_json=excluded.config_json,
       secret_enc=COALESCE(excluded.secret_enc,integrations.secret_enc),
       app_secret_enc=COALESCE(excluded.app_secret_enc,integrations.app_secret_enc),
       verify_token_enc=COALESCE(excluded.verify_token_enc,integrations.verify_token_enc),
       enabled=excluded.enabled,status=excluded.status,updated_at=CURRENT_TIMESTAMP`,
    ).bind(
      platform, platform, name, config, secret, appSecret, verifyToken,
      body.enabled === false ? 0 : 1, body.enabled === false ? "disabled" : "configured",
    ).run();
    await audit(env, "integration.saved", platform);
    return json({ ok: true, secret: "encrypted and masked" });
  }
  const integrationTest = path.match(/^\/integrations\/([^/]+)\/test$/);
  if (integrationTest && method === "POST") {
    const row = await env.NYAMAL_DB.prepare("SELECT platform,name,enabled,secret_enc,config_json FROM integrations WHERE id=?")
      .bind(integrationTest[1]).first<{ platform: string; name: string; enabled: number; secret_enc: string | null; config_json: string }>();
    if (!row || !row.enabled || !row.secret_enc) throw new HttpError(400, "Integration is not enabled or credential is missing");
    const config = JSON.parse(row.config_json) as Record<string, unknown>;
    const secret = await decryptSecret(env, row.secret_enc);
    if (row.platform === "telegram") {
      const response = await fetch(`https://api.telegram.org/bot${secret}/getMe`, { signal: AbortSignal.timeout(15000) });
      const data = await response.json() as { ok?: boolean; description?: string; result?: { username?: string } };
      if (!response.ok || !data.ok) throw new HttpError(502, data.description ?? "Telegram credential test failed");
      return json({ status: "connected", bot: data.result?.username });
    }
    if (["facebook", "instagram", "whatsapp"].includes(row.platform)) {
      const version = typeof config.graph_version === "string" ? config.graph_version : "v23.0";
      const url = new URL(`https://graph.facebook.com/${version}/me`);
      url.searchParams.set("access_token", secret);
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const data = await response.json() as { id?: string; name?: string; error?: { message?: string } };
      if (!response.ok) throw new HttpError(502, data.error?.message ?? "Meta Graph API credential test failed");
      return json({ status: "connected", account: { id: data.id, name: data.name } });
    }
    return json({ status: "configured", note: `${row.name} credentials are stored. Use the platform's official API and permissions for publishing.` });
  }
  const memoryPath = path.match(/^\/memory\/([^/]+)(?:\/([^/]+))?$/);
  if (memoryPath && method === "GET") {
    const result = await env.NYAMAL_DB.prepare("SELECT * FROM long_memories WHERE user_id=? ORDER BY importance DESC,id DESC").bind(memoryPath[1]).all();
    return json({ memories: result.results ?? [] });
  }
  if (memoryPath && method === "POST" && !memoryPath[2]) {
    const body = await readJson(request);
    await env.NYAMAL_DB.prepare("INSERT INTO long_memories(user_id,memory,category,importance) VALUES(?,?,?,?) ON CONFLICT(user_id,memory) DO UPDATE SET updated_at=CURRENT_TIMESTAMP")
      .bind(memoryPath[1], requiredString(body.memory, "memory", 1, 1000), typeof body.category === "string" ? body.category : "general", boundedInteger(body.importance, "importance", 3, 1, 5)).run();
    return json({ ok: true });
  }
  if (memoryPath && method === "DELETE" && memoryPath[2]) {
    const result = await env.NYAMAL_DB.prepare("DELETE FROM long_memories WHERE user_id=? AND id=?").bind(memoryPath[1], memoryPath[2]).run();
    if (!result.meta.changes) throw new HttpError(404, "Memory not found");
    return json({ ok: true });
  }
  if (path === "/publishing/policies" && method === "GET") {
    const result = await env.NYAMAL_DB.prepare(
      "SELECT * FROM publishing_policies ORDER BY platform,category",
    ).all();
    return json({ policies: result.results ?? [] });
  }
  if (path === "/publishing/policies" && method === "POST") {
    const body = await readJson(request);
    const platform = requiredString(body.platform, "platform", 1, 80);
    const category = requiredString(body.category, "category", 1, 80);
    const mode = requiredString(body.mode, "mode", 1, 20);
    if (!["manual", "supervised", "autonomous"].includes(mode)) {
      throw new HttpError(400, "Publishing mode must be manual, supervised, or autonomous");
    }
    await env.NYAMAL_DB.prepare(
      `INSERT INTO publishing_policies(platform,category,mode,updated_by,updated_at)
       VALUES(?, ?, ?, 'admin', CURRENT_TIMESTAMP)
       ON CONFLICT(platform,category) DO UPDATE SET mode=excluded.mode,updated_by='admin',updated_at=CURRENT_TIMESTAMP`,
    ).bind(platform, category, mode).run();
    await audit(env, "publishing.policy.updated", `${platform}:${category}`);
    return json({ ok: true });
  }
  if (path === "/publications" && method === "GET") {
    const limit = boundedInteger(new URL(request.url).searchParams.get("limit"), "limit", 200, 1, 500);
    const result = await env.NYAMAL_DB.prepare(
      "SELECT p.*,c.title,c.category,c.scheduled_at FROM content_publications p JOIN content_items c ON c.id=p.content_id ORDER BY p.updated_at DESC LIMIT ?",
    ).bind(limit).all();
    return json({ publications: result.results ?? [] });
  }
  const publicationAction = path.match(/^\/publications\/([^/]+)\/(approve|reject|retry|cancel)$/);
  if (publicationAction && method === "POST") {
    const [, id, action] = publicationAction;
    const publication = await env.NYAMAL_DB.prepare(
      "SELECT id,status,content_version FROM content_publications WHERE id=?",
    ).bind(id).first<{ id: string; status: string; content_version: number }>();
    if (!publication) throw new HttpError(404, "Publication not found");
    if (action === "approve") {
      if (publication.status !== "awaiting_approval") throw new HttpError(409, "Publication is not awaiting approval");
      await env.NYAMAL_DB.batch([
        env.NYAMAL_DB.prepare("UPDATE content_publications SET status='approved',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id),
        env.NYAMAL_DB.prepare(
          "INSERT INTO publication_approvals(publication_id,content_version,decision,approved_by) VALUES(?,?,'approved','admin')",
        ).bind(id, publication.content_version),
        env.NYAMAL_DB.prepare(
          "INSERT INTO publication_events(publication_id,event,details) VALUES(?,'approved','approved by administrator')",
        ).bind(id),
      ]);
    } else if (action === "reject") {
      await env.NYAMAL_DB.prepare(
        "UPDATE content_publications SET status='rejected',updated_at=CURRENT_TIMESTAMP WHERE id=?",
      ).bind(id).run();
      await env.NYAMAL_DB.prepare(
        "INSERT INTO publication_events(publication_id,event) VALUES(?,'rejected')",
      ).bind(id).run();
    } else if (action === "retry") {
      if (!["failed", "cancelled"].includes(publication.status)) throw new HttpError(409, "Only failed or cancelled publications can be retried");
      await env.NYAMAL_DB.prepare(
        "UPDATE content_publications SET status='approved',attempts=0,next_attempt_at=CURRENT_TIMESTAMP,error_details=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      ).bind(id).run();
      await env.NYAMAL_DB.prepare(
        "INSERT INTO publication_events(publication_id,event) VALUES(?,'retry_requested')",
      ).bind(id).run();
    } else {
      await env.NYAMAL_DB.prepare(
        "UPDATE content_publications SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=?",
      ).bind(id).run();
      await env.NYAMAL_DB.prepare(
        "INSERT INTO publication_events(publication_id,event) VALUES(?,'cancelled')",
      ).bind(id).run();
    }
    await audit(env, `publication.${action}`, id);
    return json({ ok: true });
  }
  if (path === "/profile" && method === "GET") {
    const profile = await env.NYAMAL_DB.prepare(
      "SELECT display_name,photo_mime,updated_at,photo_base64 IS NOT NULL has_photo FROM admin_profile WHERE id=1",
    ).first<{ display_name: string; photo_mime: string | null; updated_at: string; has_photo: number }>();
    return json({
      display_name: profile?.display_name || "Administrator",
      photo_mime: profile?.has_photo ? profile.photo_mime : null,
      updated_at: profile?.updated_at || null,
    });
  }
  if (path === "/profile/photo" && method === "POST") {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
      throw new HttpError(400, "Profile photo must use multipart/form-data");
    }
    const form = await request.formData();
    const file = form.get("photo");
    if (!(file instanceof File)) throw new HttpError(400, "A photo file is required");
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      throw new HttpError(400, "Use PNG, JPEG, or WebP");
    }
    if (file.size < 1 || file.size > 1024 * 1024) {
      throw new HttpError(400, "Profile photo must be between 1 byte and 1 MB");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.slice(offset, offset + 0x8000));
    }
    const base64 = btoa(binary);
    await env.NYAMAL_DB.prepare(
      `INSERT INTO admin_profile(id,display_name,photo_mime,photo_base64,updated_at)
       VALUES(1,'Administrator',?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET photo_mime=excluded.photo_mime,photo_base64=excluded.photo_base64,updated_at=CURRENT_TIMESTAMP`,
    ).bind(file.type, base64).run();
    await audit(env, "profile.photo.updated");
    return json({ ok: true, photo_mime: file.type });
  }
  if (path === "/profile/photo" && method === "DELETE") {
    await env.NYAMAL_DB.prepare(
      "UPDATE admin_profile SET photo_mime=NULL,photo_base64=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=1",
    ).run();
    await audit(env, "profile.photo.removed");
    return json({ ok: true });
  }
  if (path === "/reports" && method === "GET") {
    const result = await env.NYAMAL_DB.prepare("SELECT * FROM daily_reports ORDER BY report_date DESC LIMIT 90").all();
    return json({ reports: result.results ?? [] });
  }
  if (path === "/reports/generate" && method === "POST") {
    const date = new Date().toISOString().slice(0, 10);
    const [tasks, content, usage] = await Promise.all([
      env.NYAMAL_DB.prepare("SELECT status,COUNT(*) count FROM tasks GROUP BY status").all(),
      env.NYAMAL_DB.prepare("SELECT status,COUNT(*) count FROM content_items GROUP BY status").all(),
      env.NYAMAL_DB.prepare("SELECT COUNT(*) requests,COALESCE(SUM(success),0) successes FROM ai_usage_logs WHERE date(created_at)=date('now')").first(),
    ]);
    const report = JSON.stringify({ tasks: tasks.results ?? [], content: content.results ?? [], ai_usage_today: usage });
    await env.NYAMAL_DB.prepare("INSERT INTO daily_reports(report_date,report_json) VALUES(?,?) ON CONFLICT(report_date) DO UPDATE SET report_json=excluded.report_json").bind(date, report).run();
    return json({ ok: true, report });
  }
  if (path === "/system/doctor" && method === "GET") {
    await env.NYAMAL_DB.prepare("SELECT 1").first();
    return json({
      status: "ok",
      storage: "Cloudflare D1",
      webhook: "POST /v1/telegram/webhook to register",
      admin_login_configured: Boolean(env.NYAMAL_ADMIN_USERNAME && env.NYAMAL_ADMIN_PASSWORD && env.NYAMAL_SESSION_SECRET),
      password_reset_email_configured: Boolean(env.RESEND_API_KEY && env.NYAMAL_EMAIL_FROM),
      encryption_key_configured: Boolean(env.NYAMAL_ENCRYPTION_KEY),
      backup: "Use Cloudflare D1 export or Wrangler; SQLite download is not available on Workers.",
    });
  }
  if (path === "/system/backup" && method === "GET") throw new HttpError(501, "D1 backups must be exported through Cloudflare dashboard or Wrangler");
  if (path === "/audit" && method === "GET") {
    const result = await env.NYAMAL_DB.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 500").all();
    return json({ logs: result.results ?? [] });
  }
  throw new HttpError(404, "Admin route not found");
}
