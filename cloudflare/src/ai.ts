import { decryptSecret } from "./crypto";
import type { AiHistoryItem, Env } from "./types";
import { SYSTEM_PROMPT } from "./system-prompt";
import type { ProviderProtocol } from "./provider-catalog";
import { HttpError } from "./http";
import { assistantBehaviorContext, getAssistantBehaviorSettings } from "./workspace-settings";
import { shouldTryNextProviderModel, transientProviderRetryDelay } from "./provider-retry";

type Candidate = {
  id: string;
  provider_id: string;
  provider_name: string;
  protocol: ProviderProtocol;
  base_url: string;
  auth_header: string;
  auth_prefix: string;
  api_version: string | null;
  model_list_path: string | null;
  model_name: string;
  secret_enc: string;
  task_types: string;
  capabilities_json: string;
  daily_token_limit: number | null;
  daily_request_limit: number | null;
};

type ProviderReply = {
  answer: string;
  inputTokens?: number;
  outputTokens?: number;
};

export type DiscoveredModel = {
  id: string;
  display_name: string;
  capabilities: Record<string, "supported" | "unsupported">;
  context_window?: number;
  input_cost_per_million?: number;
  output_cost_per_million?: number;
};

export type AiImage = {
  media_type: "image/jpeg" | "image/png" | "image/webp";
  data: string;
};

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_IMAGE_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

export function validateAiImages(value: unknown): AiImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) {
    throw new HttpError(400, "Attach no more than 4 images");
  }
  const images: AiImage[] = [];
  let totalBytes = 0;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new HttpError(400, "Each image must include a supported image type and base64 data");
    }
    const raw = item as Record<string, unknown>;
    if (!["image/jpeg", "image/png", "image/webp"].includes(String(raw.media_type))
      || typeof raw.data !== "string"
      || raw.data.length > MAX_IMAGE_BASE64_LENGTH
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.data)) {
      throw new HttpError(400, "Images must be valid JPEG, PNG, or WebP files");
    }
    let bytes: string;
    try {
      bytes = atob(raw.data);
    } catch {
      throw new HttpError(400, "Image data is not valid base64");
    }
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
      throw new HttpError(400, "Each image must be smaller than 2 MB");
    }
    const matchesType = raw.media_type === "image/jpeg"
      ? bytes.charCodeAt(0) === 0xff && bytes.charCodeAt(1) === 0xd8 && bytes.charCodeAt(2) === 0xff
      : raw.media_type === "image/png"
        ? bytes.startsWith("\x89PNG\r\n\x1a\n")
        : bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP";
    if (!matchesType) throw new HttpError(400, "Image content does not match its declared file type");
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new HttpError(400, "Attached images must total no more than 6 MB");
    }
    images.push({ media_type: raw.media_type as AiImage["media_type"], data: raw.data });
  }
  return images;
}

class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfter?: string | null,
  ) {
    super(message);
  }
}

function providerUrl(baseUrl: string, suffix: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith(suffix) ? base : `${base}/${suffix.replace(/^\/+/, "")}`;
}

function candidateHeaders(candidate: Pick<Candidate, "protocol" | "auth_header" | "auth_prefix" | "api_version">, apiKey: string): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (candidate.auth_header && candidate.auth_header.toLowerCase() !== "none") {
    headers.set(candidate.auth_header, `${candidate.auth_prefix}${apiKey}`);
  }
  if (candidate.protocol === "anthropic" && candidate.api_version) {
    headers.set("anthropic-version", candidate.api_version);
  }
  return headers;
}

async function providerFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("AI provider timeout"), 20_000);
  try {
    return await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
  } catch (error) {
    throw new ProviderError(error instanceof Error ? error.message : "AI provider request failed");
  } finally {
    clearTimeout(timeout);
  }
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new ProviderError(
      `AI provider returned HTTP ${response.status}`,
      response.status,
      response.headers.get("Retry-After"),
    );
  }
  try {
    const data: unknown = await response.json();
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch {
    throw new ProviderError("AI provider returned invalid JSON");
  }
  throw new ProviderError("AI provider returned an invalid response");
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function textFrom(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (!part || typeof part !== "object") return "";
    const item = part as Record<string, unknown>;
    return typeof item.text === "string" ? item.text : "";
  }).join("").trim();
}

function messageHistory(history: AiHistoryItem[]): Array<{ role: "user" | "assistant"; content: string }> {
  return history.slice(-12).map((item) => ({ role: item.role, content: item.content }));
}

async function callProvider(
  candidate: Candidate,
  apiKey: string,
  history: AiHistoryItem[],
  prompt: string,
  systemPrompt: string,
  images: AiImage[] = [],
): Promise<ProviderReply> {
  const base = candidate.base_url.replace(/\/+$/, "");
  const headers = candidateHeaders(candidate, apiKey);
  const messages = [...messageHistory(history), { role: "user" as const, content: prompt }];

  if (candidate.protocol === "gemini") {
    const contents = messages.map((item, index) => ({
      role: item.role === "assistant" ? "model" : "user",
      parts: [
        { text: item.content },
        ...(index === messages.length - 1
          ? images.map((image) => ({
            inline_data: { mime_type: image.media_type, data: image.data },
          }))
          : []),
      ],
    }));
    const model = candidate.model_name.replace(/^models\//, "");
    const response = await providerFetch(
      `${base}/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: { temperature: 0.7 },
        }),
      },
    );
    const data = await responseJson(response);
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    const first = candidates[0] as { content?: { parts?: unknown[] } } | undefined;
    const answer = textFrom(first?.content?.parts);
    const usage = data.usageMetadata as Record<string, unknown> | undefined;
    if (!answer) throw new ProviderError("AI provider returned an empty response");
    return {
      answer,
      inputTokens: numberValue(usage?.promptTokenCount),
      outputTokens: numberValue(usage?.candidatesTokenCount),
    };
  }

  if (candidate.protocol === "anthropic") {
    const response = await providerFetch(providerUrl(base, "messages"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: candidate.model_name,
        system: systemPrompt,
        messages: images.length
          ? messages.map((item, index) => index === messages.length - 1
            ? {
              role: item.role,
              content: [
                { type: "text", text: item.content },
                ...images.map((image) => ({
                  type: "image",
                  source: { type: "base64", media_type: image.media_type, data: image.data },
                })),
              ],
            }
            : item)
          : messages,
        max_tokens: 2048,
        temperature: 0.7,
      }),
    });
    const data = await responseJson(response);
    const answer = textFrom(data.content);
    const usage = data.usage as Record<string, unknown> | undefined;
    if (!answer) throw new ProviderError("AI provider returned an empty response");
    return {
      answer,
      inputTokens: numberValue(usage?.input_tokens),
      outputTokens: numberValue(usage?.output_tokens),
    };
  }

  if (candidate.protocol === "cohere") {
    if (images.length) throw new ProviderError("Image input is not supported by this Cohere adapter");
    const response = await providerFetch(providerUrl(base, "v2/chat"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: candidate.model_name,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        temperature: 0.7,
      }),
    });
    const data = await responseJson(response);
    const message = data.message as Record<string, unknown> | undefined;
    const answer = textFrom(message?.content);
    const usage = data.usage as Record<string, unknown> | undefined;
    const tokens = usage?.tokens as Record<string, unknown> | undefined;
    if (!answer) throw new ProviderError("AI provider returned an empty response");
    return {
      answer,
      inputTokens: numberValue(tokens?.input_tokens),
      outputTokens: numberValue(tokens?.output_tokens),
    };
  }

  let url: string;
  let body: Record<string, unknown>;
  if (candidate.protocol === "azure-openai") {
    if (!candidate.api_version) throw new ProviderError("Azure OpenAI requires an API version");
    const deploymentUrl = providerUrl(
      `${base}/openai/deployments/${encodeURIComponent(candidate.model_name)}`,
      "chat/completions",
    );
    const parsedUrl = new URL(deploymentUrl);
    parsedUrl.searchParams.set("api-version", candidate.api_version);
    url = parsedUrl.toString();
    body = {
      messages: [
        { role: "system", content: systemPrompt },
        ...openAiMessages(messages, images),
      ],
      temperature: 0.7,
    };
  } else {
    url = providerUrl(base, "chat/completions");
    body = {
      model: candidate.model_name,
      messages: [
        { role: "system", content: systemPrompt },
        ...openAiMessages(messages, images),
      ],
      temperature: 0.7,
    };
  }
  const response = await providerFetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await responseJson(response);
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const answer = textFrom(first?.message?.content);
  const usage = data.usage as Record<string, unknown> | undefined;
  if (!answer) throw new ProviderError("AI provider returned an empty response");
  return {
    answer,
    inputTokens: numberValue(usage?.prompt_tokens),
    outputTokens: numberValue(usage?.completion_tokens),
  };
}

async function callProviderWithRetry(
  candidate: Candidate,
  apiKey: string,
  history: AiHistoryItem[],
  prompt: string,
  systemPrompt: string,
  images: AiImage[] = [],
): Promise<ProviderReply> {
  try {
    return await callProvider(candidate, apiKey, history, prompt, systemPrompt, images);
  } catch (error) {
    if (!(error instanceof ProviderError) || error.status === undefined) throw error;
    const delay = transientProviderRetryDelay(error.status, error.retryAfter ?? null);
    if (delay === undefined) throw error;
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    return callProvider(candidate, apiKey, history, prompt, systemPrompt, images);
  }
}

function openAiMessages(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  images: AiImage[],
): Array<{ role: "user" | "assistant"; content: string | Array<Record<string, unknown>> }> {
  return messages.map((item, index) => index === messages.length - 1 && images.length
    ? {
      role: item.role,
      content: [
        { type: "text", text: item.content },
        ...images.map((image) => ({
          type: "image_url",
          image_url: { url: `data:${image.media_type};base64,${image.data}` },
        })),
      ],
    }
    : item);
}

function reportedCapabilities(raw: Record<string, unknown>): Record<string, "supported" | "unsupported"> {
  const capabilities: Record<string, "supported" | "unsupported"> = {};
  const architecture = raw.architecture as Record<string, unknown> | undefined;
  const input = Array.isArray(architecture?.input_modalities)
    ? architecture.input_modalities.filter((item): item is string => typeof item === "string")
    : undefined;
  const output = Array.isArray(architecture?.output_modalities)
    ? architecture.output_modalities.filter((item): item is string => typeof item === "string")
    : undefined;
  if (input) {
    capabilities.chat = input.includes("text") ? "supported" : "unsupported";
    capabilities.vision = input.includes("image") ? "supported" : "unsupported";
    capabilities.audio_input = input.includes("audio") ? "supported" : "unsupported";
    capabilities.video_input = input.includes("video") ? "supported" : "unsupported";
  }
  if (output) {
    capabilities.image_generation = output.includes("image") ? "supported" : "unsupported";
    capabilities.audio_output = output.includes("audio") ? "supported" : "unsupported";
  }
  const params = Array.isArray(raw.supported_parameters)
    ? raw.supported_parameters.filter((item): item is string => typeof item === "string")
    : undefined;
  if (params) {
    capabilities.tool_calling = params.some((item) => ["tools", "tool_choice", "functions", "function_call"].includes(item))
      ? "supported" : "unsupported";
    capabilities.structured_output = params.includes("response_format") ? "supported" : "unsupported";
    capabilities.reasoning = params.includes("reasoning") ? "supported" : "unsupported";
  }
  const methods = Array.isArray(raw.supportedGenerationMethods)
    ? raw.supportedGenerationMethods.filter((item): item is string => typeof item === "string")
    : undefined;
  if (methods) {
    capabilities.chat = methods.includes("generateContent") ? "supported" : "unsupported";
    capabilities.image_generation = methods.includes("generateImages") ? "supported" : capabilities.image_generation;
  }
  return capabilities;
}

function catalogEntries(data: Record<string, unknown>, protocol: ProviderProtocol): unknown[] {
  const key = protocol === "gemini" ? "models" : protocol === "azure-openai" ? "value" : "data";
  const items = data[key] ?? data.models;
  return Array.isArray(items) ? items : [];
}

function modelFromCatalog(value: unknown, protocol: ProviderProtocol): DiscoveredModel | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const name = typeof item.name === "string" ? item.name : "";
  const rawId = typeof item.id === "string" ? item.id : name;
  if (!rawId) return undefined;
  const id = protocol === "gemini" ? rawId.replace(/^models\//, "") : rawId;
  const capabilities = reportedCapabilities(item);
  const contextWindow = numberValue(item.context_length) ?? numberValue(item.context_window);
  const pricing = item.pricing as Record<string, unknown> | undefined;
  const inputCost = numberValue(pricing?.prompt);
  const outputCost = numberValue(pricing?.completion);
  return {
    id,
    display_name: typeof item.display_name === "string"
      ? item.display_name
      : typeof item.displayName === "string"
        ? item.displayName
        : typeof item.name === "string" ? item.name.split("/").pop() ?? item.name : rawId,
    capabilities,
    ...(contextWindow ? { context_window: contextWindow } : {}),
    ...(inputCost !== undefined ? { input_cost_per_million: inputCost * 1_000_000 } : {}),
    ...(outputCost !== undefined ? { output_cost_per_million: outputCost * 1_000_000 } : {}),
  };
}

function discoveryUrl(candidate: Candidate): string {
  const base = candidate.base_url.replace(/\/+$/, "");
  const path = candidate.model_list_path || (
    candidate.protocol === "azure-openai" ? "/openai/deployments" : "/models"
  );
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("..")) {
    throw new ProviderError("Provider model-list path must be a safe relative path");
  }
  const url = new URL(`${base}${path}`);
  if (candidate.protocol === "gemini") url.searchParams.set("pageSize", "100");
  if (candidate.protocol === "azure-openai") {
    if (!candidate.api_version) throw new ProviderError("Azure OpenAI discovery requires an API version");
    url.searchParams.set("api-version", candidate.api_version);
  }
  return url.toString();
}

export async function discoverProviderModels(env: Env, providerId: string): Promise<{
  models: DiscoveredModel[];
  note: string;
}> {
  const row = await env.NYAMAL_DB.prepare(
    `SELECT p.id,p.name,p.api_protocol protocol,p.base_url,p.auth_header,p.auth_prefix,p.api_version,p.model_list_path,c.secret_enc
     FROM ai_providers p JOIN ai_credentials c ON c.provider_id=p.id WHERE p.id=? AND p.enabled=1`,
  ).bind(providerId).first<{
    id: string; name: string; protocol: ProviderProtocol; base_url: string;
    auth_header: string; auth_prefix: string; api_version: string | null;
    model_list_path: string | null; secret_enc: string;
  }>();
  if (!row) throw new Error("Enabled provider or encrypted API key not found");
  const candidate = {
    ...row,
    provider_id: row.id,
    provider_name: row.name,
    protocol: row.protocol,
    model_name: "",
    task_types: "",
    capabilities_json: "{}",
    daily_token_limit: null,
    daily_request_limit: null,
  } satisfies Candidate;
  const response = await providerFetch(discoveryUrl(candidate), {
    method: "GET",
    headers: candidateHeaders(candidate, await decryptSecret(env, row.secret_enc)),
  });
  const data = await responseJson(response);
  const models = catalogEntries(data, row.protocol)
    .map((item) => modelFromCatalog(item, row.protocol))
    .filter((model): model is DiscoveredModel => Boolean(model));
  return {
    models,
    note: "Models are taken from the provider's live catalog. Unreported capabilities remain unknown; verify model access and capabilities before enabling routing.",
  };
}

export async function providerCandidate(
  env: Env,
  providerId: string,
  modelId?: string,
): Promise<Candidate | undefined> {
  return (await env.NYAMAL_DB.prepare(
    `SELECT m.id,m.provider_id,p.name provider_name,p.api_protocol protocol,p.base_url,p.auth_header,p.auth_prefix,
            p.api_version,p.model_list_path,m.model_name,c.secret_enc,m.task_types,m.capabilities_json,
            m.daily_token_limit,m.daily_request_limit
       FROM ai_models m
       JOIN ai_providers p ON p.id=m.provider_id
       JOIN ai_credentials c ON c.provider_id=p.id
      WHERE p.id=? AND p.enabled=1 AND m.enabled=1 AND (? IS NULL OR m.id=?)
      ORDER BY m.priority LIMIT 1`,
  ).bind(providerId, modelId ?? null, modelId ?? null).first<Candidate>()) ?? undefined;
}

export async function testProviderConnection(
  env: Env,
  providerId: string,
): Promise<{
  status: "healthy" | "failed";
  latency_ms: number;
  model_name?: string;
  fallback_used?: boolean;
  previous_failures?: string[];
  error?: string;
}> {
  const candidates = await env.NYAMAL_DB.prepare(
    `SELECT m.id,m.provider_id,p.name provider_name,p.api_protocol protocol,p.base_url,p.auth_header,p.auth_prefix,
            p.api_version,p.model_list_path,m.model_name,c.secret_enc,m.task_types,m.capabilities_json,
            m.daily_token_limit,m.daily_request_limit
       FROM ai_models m
       JOIN ai_providers p ON p.id=m.provider_id
       JOIN ai_credentials c ON c.provider_id=p.id
      WHERE p.id=? AND p.enabled=1 AND m.enabled=1
      ORDER BY m.priority,m.created_at,m.id LIMIT 3`,
  ).bind(providerId).all<Candidate>();
  const models = candidates.results ?? [];
  if (!models.length) throw new Error("Enabled provider needs an encrypted API key and an enabled model before testing");
  const started = Date.now();
  const apiKey = await decryptSecret(env, models[0].secret_enc);
  const failures: string[] = [];
  for (const [index, candidate] of models.entries()) {
    const attemptStarted = Date.now();
    try {
      const reply = await callProviderWithRetry(
        candidate,
        apiKey,
        [],
        "Reply exactly: Nyamal connection successful.",
        "You are a provider connectivity test. Reply with the requested text only.",
      );
      await logSuccess(env, candidate, null, "provider_test", attemptStarted, reply);
      return {
        status: "healthy",
        latency_ms: Date.now() - started,
        model_name: candidate.model_name,
        fallback_used: index > 0,
        ...(failures.length ? { previous_failures: failures } : {}),
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Provider test failed";
      failures.push(`${candidate.model_name}: ${detail}`);
      const status = error instanceof ProviderError ? error.status : undefined;
      const transientFailure = status === 429 || (status !== undefined && status >= 500)
        || /timed?\s*out|timeout|abort/i.test(detail);
      await env.NYAMAL_DB.prepare(
        `INSERT INTO ai_usage_logs(provider_id,model_id,task_type,success,latency_ms,error_code)
         VALUES(?,?,'provider_test',0,?,?)`,
      ).bind(candidate.provider_id, candidate.id, Date.now() - attemptStarted,
        status ? `HTTP_${status}` : detail.slice(0, 100)).run();
      await env.NYAMAL_DB.prepare(
        `INSERT INTO ai_provider_health(provider_id,last_status,last_error,checked_at)
         VALUES(?,?,?,CURRENT_TIMESTAMP)
         ON CONFLICT(provider_id) DO UPDATE SET last_status=excluded.last_status,last_error=excluded.last_error,checked_at=CURRENT_TIMESTAMP`,
      ).bind(candidate.provider_id, transientFailure ? "cooldown" : "error", detail.slice(0, 500)).run();
      if (!shouldTryNextProviderModel(status)) break;
    }
  }
  const detail = failures.join(" | ") || "Provider test failed";
  const lastFailure = failures[failures.length - 1] ?? detail;
  const cooldown = /HTTP_(408|429|5\d\d)|timed?\s*out|timeout|abort/i.test(lastFailure);
  await env.NYAMAL_DB.prepare(
    `INSERT INTO ai_provider_health(provider_id,last_status,last_error,checked_at)
     VALUES(?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(provider_id) DO UPDATE SET last_status=excluded.last_status,last_error=excluded.last_error,checked_at=CURRENT_TIMESTAMP`,
  ).bind(providerId, cooldown ? "cooldown" : "error", detail.slice(0, 500)).run();
  return { status: "failed", latency_ms: Date.now() - started, error: detail };
}

function taskAllowed(
  candidate: Candidate,
  taskType: string,
  requiredCapabilities: string[],
  hasImages: boolean,
): boolean {
  const types = candidate.task_types.split(",").map((item) => item.trim()).filter(Boolean);
  if (!types.includes(taskType) && !types.includes("all")) return false;
  if (hasImages && !["gemini", "anthropic", "openai-compatible", "azure-openai"].includes(candidate.protocol)) {
    return false;
  }
  if (!requiredCapabilities.length) return true;
  let capabilities: Record<string, string>;
  try {
    capabilities = JSON.parse(candidate.capabilities_json) as Record<string, string>;
  } catch {
    return false;
  }
  return requiredCapabilities.every((capability) => capabilities[capability] === "supported");
}

async function candidatesForTask(
  env: Env,
  taskType: string,
  requiredCapabilities: string[],
  hasImages: boolean,
): Promise<Candidate[]> {
  const result = await env.NYAMAL_DB.prepare(
    `SELECT m.id,m.provider_id,p.name provider_name,p.api_protocol protocol,p.base_url,p.auth_header,p.auth_prefix,
            p.api_version,p.model_list_path,m.model_name,c.secret_enc,m.task_types,m.capabilities_json,
            m.daily_token_limit,m.daily_request_limit
       FROM ai_models m
       JOIN ai_providers p ON p.id=m.provider_id
       JOIN ai_credentials c ON c.provider_id=p.id
       LEFT JOIN ai_provider_health h ON h.provider_id=p.id
      WHERE m.enabled=1 AND p.enabled=1
        AND (h.last_status IS NULL OR NOT (h.last_status='cooldown' AND h.checked_at > datetime('now','-2 minutes')))
      ORDER BY m.priority,p.priority`,
  ).all<Candidate>();
  return (result.results ?? []).filter((candidate) =>
    taskAllowed(candidate, taskType, requiredCapabilities, hasImages));
}

async function logSuccess(
  env: Env,
  candidate: Candidate,
  userId: number | string | null,
  taskType: string,
  started: number,
  reply: ProviderReply,
): Promise<void> {
  await env.NYAMAL_DB.prepare(
      `INSERT INTO ai_usage_logs(provider_id,model_id,task_type,user_id,success,latency_ms,input_tokens,output_tokens)
       VALUES(?,?,?,?,1,?,?,?)`,
    ).bind(candidate.provider_id, candidate.id, taskType, userId === null ? null : String(userId),
      Date.now() - started, reply.inputTokens ?? null, reply.outputTokens ?? null).run();
  await env.NYAMAL_DB.prepare(
      `INSERT INTO ai_provider_health(provider_id,last_status,last_error,checked_at)
       VALUES(?,'healthy',NULL,CURRENT_TIMESTAMP)
       ON CONFLICT(provider_id) DO UPDATE SET last_status='healthy',last_error=NULL,checked_at=CURRENT_TIMESTAMP`,
    ).bind(candidate.provider_id).run();
}

async function generateWithFallback(
  env: Env,
  userId: number | string | null,
  prompt: string,
  taskType: string,
  history: AiHistoryItem[],
  systemPrompt: string,
  requiredCapabilities: string[] = [],
  images: AiImage[] = [],
): Promise<{ answer: string; provider: string; model: string }> {
  const candidates = await candidatesForTask(env, taskType, requiredCapabilities, images.length > 0);
  if (!candidates.length) {
    const requirement = images.length ? "vision capability" : "required capabilities";
    throw new Error(`No enabled model is configured for task "${taskType}" with the ${requirement}.`);
  }

  const failures: string[] = [];
  for (const candidate of candidates) {
    const usage = await env.NYAMAL_DB.prepare(
      `SELECT COUNT(*) requests,
              COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0) tokens
         FROM ai_usage_logs WHERE model_id=? AND date(created_at)=date('now')`,
    ).bind(candidate.id).first<{ requests: number; tokens: number }>();
    if ((candidate.daily_request_limit && (usage?.requests ?? 0) >= candidate.daily_request_limit)
      || (candidate.daily_token_limit && (usage?.tokens ?? 0) >= candidate.daily_token_limit)) continue;

    const started = Date.now();
    try {
      const key = await decryptSecret(env, candidate.secret_enc);
      const reply = await callProviderWithRetry(candidate, key, history, prompt, systemPrompt, images);
      await logSuccess(env, candidate, userId, taskType, started, reply);
      return {
        ...reply,
        provider: candidate.provider_name,
        model: candidate.model_name,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "provider error";
      failures.push(`${candidate.provider_name}: ${detail}`);
      const status = error instanceof ProviderError ? error.status : undefined;
      const transientFailure = status === 429 || (status !== undefined && status >= 500)
        || /timed?\s*out|timeout|abort/i.test(detail);
      const health = transientFailure ? "cooldown" : "error";
      await env.NYAMAL_DB.prepare(
          `INSERT INTO ai_usage_logs(provider_id,model_id,task_type,user_id,success,latency_ms,error_code)
           VALUES(?,?,?, ?,0,?,?)`,
        ).bind(candidate.provider_id, candidate.id, taskType, userId === null ? null : String(userId),
          Date.now() - started, status ? `HTTP_${status}` : detail.slice(0, 100)).run();
      await env.NYAMAL_DB.prepare(
          `INSERT INTO ai_provider_health(provider_id,last_status,last_error,checked_at)
           VALUES(?,?,?,CURRENT_TIMESTAMP)
           ON CONFLICT(provider_id) DO UPDATE SET last_status=excluded.last_status,last_error=excluded.last_error,checked_at=CURRENT_TIMESTAMP`,
        ).bind(candidate.provider_id, health, detail.slice(0, 500)).run();
    }
  }
  console.error("All compatible AI models failed or reached their limits", { taskType, failures });
  throw new Error("All compatible configured AI models failed or reached their limits");
}

export async function generateReply(
  env: Env,
  userId: number | string,
  prompt: string,
  taskType = "chat",
  options: {
    systemContext?: string;
    persist?: boolean;
    includeHistory?: boolean;
    includeMemories?: boolean;
    images?: AiImage[];
  } = {},
): Promise<string> {
  const historyRows = options.includeHistory === false
    ? []
    : (await env.NYAMAL_DB.prepare(
      "SELECT role, content FROM messages WHERE user_id=? ORDER BY id DESC LIMIT 12",
    ).bind(userId).all<AiHistoryItem>()).results ?? [];
  const memories = options.includeMemories === false
    ? []
    : (await env.NYAMAL_DB.prepare(
      "SELECT memory FROM long_memories WHERE user_id=? ORDER BY importance DESC, id DESC LIMIT 12",
    ).bind(userId).all<{ memory: string }>()).results ?? [];
  const memoryContext = memories.map((item) => `- ${item.memory}`).join("\n");
  const behaviorContext = assistantBehaviorContext(await getAssistantBehaviorSettings(env));
  const systemPrompt = `${SYSTEM_PROMPT}${behaviorContext}${memoryContext
    ? `\n\nUSER-SAVED LONG-TERM MEMORY (use only when relevant):\n${memoryContext}`
    : ""}${options.systemContext ?? ""}`;
  const result = await generateWithFallback(
    env,
    userId,
    prompt,
    taskType,
    historyRows.reverse(),
    systemPrompt,
    options.images?.length ? ["vision"] : [],
    options.images ?? [],
  );
  if (options.persist !== false) {
    await env.NYAMAL_DB.prepare("INSERT INTO messages(user_id,role,content) VALUES(?,'user',?)").bind(userId, prompt).run();
    await env.NYAMAL_DB.prepare("INSERT INTO messages(user_id,role,content) VALUES(?,'assistant',?)").bind(userId, result.answer).run();
    await env.NYAMAL_DB.prepare(
      "DELETE FROM messages WHERE user_id=? AND id NOT IN (SELECT id FROM messages WHERE user_id=? ORDER BY id DESC LIMIT 40)",
    ).bind(userId, userId).run();
  }
  return result.answer;
}

export async function generateTaskText(
  env: Env,
  prompt: string,
  taskType: string,
  systemPrompt: string,
  requiredCapabilities: string[] = [],
): Promise<{ answer: string; provider: string; model: string }> {
  const behaviorContext = assistantBehaviorContext(await getAssistantBehaviorSettings(env));
  return generateWithFallback(
    env,
    null,
    prompt,
    taskType,
    [],
    `${systemPrompt}${behaviorContext}`,
    requiredCapabilities,
  );
}
