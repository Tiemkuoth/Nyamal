import { HttpError, requiredString } from "./http";
import { validWelcomeTemplate } from "./telegram-welcome";
import type { Env } from "./types";

export type CommunityAutonomyLevel = 1 | 2 | 3 | 4;
export type CommunityRisk = "safe" | "suspicious" | "high_risk" | "confirmed_malicious" | "sensitive";
export type TelegramWelcomeStyle = "warm" | "concise" | "celebratory";

export interface CommunitySettings {
  autonomy_level: CommunityAutonomyLevel;
  welcome_enabled: boolean;
  welcome_message: string;
  telegram_welcome_individual_template: string;
  telegram_welcome_group_template: string;
  welcome_individual_enabled: boolean;
  welcome_collective_enabled: boolean;
  welcome_batch_window_seconds: 0 | 5 | 10 | 15 | 30;
  welcome_style: TelegramWelcomeStyle;
  welcome_mention_members: boolean;
  welcome_include_rules: boolean;
  welcome_include_description: boolean;
  welcome_include_links: boolean;
  welcome_include_onboarding_questions: boolean;
  welcome_useful_links: string;
  welcome_onboarding_questions: string;
  welcome_ignore_bots: boolean;
  welcome_returning_members: boolean;
  welcome_admin_invitees: boolean;
  welcome_max_messages_per_chat_per_hour: number;
  community_description: string;
  community_rules: string;
  knowledge_base: string;
  telegram_group_replies: "mention_only" | "disabled";
  social_auto_replies: boolean;
  link_protection: boolean;
  trusted_domains: string[];
  blocked_domains: string[];
  auto_delete_blocked_telegram_links: boolean;
  notify_admin: boolean;
  max_auto_replies_per_sender_per_hour: number;
}

export const DEFAULT_COMMUNITY_SETTINGS: CommunitySettings = {
  autonomy_level: 3,
  welcome_enabled: true,
  welcome_message: "Welcome, {name}! 👋 We’re glad you’re here. I’m Nyamal, the AI community assistant. {community}",
  telegram_welcome_individual_template: "Welcome to our community, {name}! 👋 {join_context} We're happy to have you here. Feel free to introduce yourself and connect with everyone. If you need anything, I'm Nyamal, your community assistant. ❤️ {community} {rules} {links} {questions}",
  telegram_welcome_group_template: "Welcome to our new members! 🎉\n\n{member_list}\n\n{join_context} We're happy to have you all here. Feel free to introduce yourselves, connect with everyone, and participate in our community. Welcome aboard! ❤️ {community} {rules} {links} {questions}",
  welcome_individual_enabled: true,
  welcome_collective_enabled: true,
  welcome_batch_window_seconds: 10,
  welcome_style: "warm",
  welcome_mention_members: true,
  welcome_include_rules: false,
  welcome_include_description: false,
  welcome_include_links: false,
  welcome_include_onboarding_questions: false,
  welcome_useful_links: "",
  welcome_onboarding_questions: "",
  welcome_ignore_bots: true,
  welcome_returning_members: false,
  welcome_admin_invitees: true,
  welcome_max_messages_per_chat_per_hour: 10,
  community_description: "",
  community_rules: "",
  knowledge_base: "",
  telegram_group_replies: "mention_only",
  social_auto_replies: true,
  link_protection: true,
  trusted_domains: [],
  blocked_domains: [],
  auto_delete_blocked_telegram_links: false,
  notify_admin: true,
  max_auto_replies_per_sender_per_hour: 6,
};

const KNOWN_SHORTENERS = new Set([
  "bit.ly", "t.co", "tinyurl.com", "lnkd.in", "cutt.ly", "is.gd", "rebrand.ly",
  "ow.ly", "tiny.cc", "shorturl.at", "buff.ly", "rb.gy",
]);
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>]*)?/gi;
const SCAM_CUES = /\b(?:verify your account|account suspended|claim your prize|send (?:me )?money|double your money|guaranteed returns|seed phrase|recovery phrase|one.time password|share (?:your )?(?:password|otp|code)|urgent payment|free giveaway)\b/i;
const SENSITIVE_CUES = /\b(?:suicid(?:e|al)|self.harm|kill myself|hurt myself|medical emergency|life.threatening|legal action|lawsuit|sexual assault|rape|credible threat|in immediate danger)\b/i;

function domainList(value: unknown, name: string): string[] {
  if (value === undefined) return DEFAULT_COMMUNITY_SETTINGS[name as "trusted_domains" | "blocked_domains"];
  if (!Array.isArray(value) || value.length > 100) {
    throw new HttpError(400, `${name} must be a list of up to 100 domains`);
  }
  const domains = new Set<string>();
  for (const entry of value) {
    const raw = requiredString(entry, name, 1, 253).trim().toLowerCase();
    if (raw.includes("://") || /[/?#:@\s*]/.test(raw)) {
      throw new HttpError(400, `${name} entries must be plain hostnames without wildcards or paths`);
    }
    let hostname: string;
    try {
      hostname = new URL(`https://${raw}`).hostname.toLowerCase();
    } catch {
      throw new HttpError(400, `Invalid domain in ${name}`);
    }
    if (hostname !== raw || !hostname.includes(".") || hostname.endsWith(".local")
      || hostname === "localhost" || /^\d+(?:\.\d+){3}$/.test(hostname)) {
      throw new HttpError(400, `Invalid public domain in ${name}`);
    }
    domains.add(hostname);
  }
  return [...domains];
}

function storedSettings(value: unknown): CommunitySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_COMMUNITY_SETTINGS };
  const raw = value as Record<string, unknown>;
  const level = Number(raw.autonomy_level);
  return {
    ...DEFAULT_COMMUNITY_SETTINGS,
    ...raw,
    autonomy_level: ([1, 2, 3, 4].includes(level) ? level : DEFAULT_COMMUNITY_SETTINGS.autonomy_level) as CommunityAutonomyLevel,
    welcome_enabled: raw.welcome_enabled !== false,
    welcome_message: typeof raw.welcome_message === "string" ? raw.welcome_message : DEFAULT_COMMUNITY_SETTINGS.welcome_message,
    telegram_welcome_individual_template: typeof raw.telegram_welcome_individual_template === "string"
      ? raw.telegram_welcome_individual_template
      : DEFAULT_COMMUNITY_SETTINGS.telegram_welcome_individual_template,
    telegram_welcome_group_template: typeof raw.telegram_welcome_group_template === "string"
      ? raw.telegram_welcome_group_template
      : DEFAULT_COMMUNITY_SETTINGS.telegram_welcome_group_template,
    welcome_individual_enabled: raw.welcome_individual_enabled !== false,
    welcome_collective_enabled: raw.welcome_collective_enabled !== false,
    welcome_batch_window_seconds: [0, 5, 10, 15, 30].includes(Number(raw.welcome_batch_window_seconds))
      ? Number(raw.welcome_batch_window_seconds) as CommunitySettings["welcome_batch_window_seconds"]
      : DEFAULT_COMMUNITY_SETTINGS.welcome_batch_window_seconds,
    welcome_style: ["warm", "concise", "celebratory"].includes(String(raw.welcome_style))
      ? raw.welcome_style as TelegramWelcomeStyle
      : DEFAULT_COMMUNITY_SETTINGS.welcome_style,
    welcome_mention_members: raw.welcome_mention_members !== false,
    welcome_include_rules: raw.welcome_include_rules === true,
    welcome_include_description: raw.welcome_include_description === true,
    welcome_include_links: raw.welcome_include_links === true,
    welcome_include_onboarding_questions: raw.welcome_include_onboarding_questions === true,
    welcome_useful_links: typeof raw.welcome_useful_links === "string" ? raw.welcome_useful_links : "",
    welcome_onboarding_questions: typeof raw.welcome_onboarding_questions === "string" ? raw.welcome_onboarding_questions : "",
    welcome_ignore_bots: raw.welcome_ignore_bots !== false,
    welcome_returning_members: raw.welcome_returning_members === true,
    welcome_admin_invitees: raw.welcome_admin_invitees !== false,
    welcome_max_messages_per_chat_per_hour: Math.min(100, Math.max(1, Number(raw.welcome_max_messages_per_chat_per_hour) || 10)),
    community_description: typeof raw.community_description === "string" ? raw.community_description : "",
    community_rules: typeof raw.community_rules === "string" ? raw.community_rules : "",
    knowledge_base: typeof raw.knowledge_base === "string" ? raw.knowledge_base : "",
    telegram_group_replies: raw.telegram_group_replies === "disabled" ? "disabled" : "mention_only",
    social_auto_replies: raw.social_auto_replies !== false,
    link_protection: raw.link_protection !== false,
    trusted_domains: Array.isArray(raw.trusted_domains) ? raw.trusted_domains.filter((item): item is string => typeof item === "string") : [],
    blocked_domains: Array.isArray(raw.blocked_domains) ? raw.blocked_domains.filter((item): item is string => typeof item === "string") : [],
    auto_delete_blocked_telegram_links: raw.auto_delete_blocked_telegram_links === true,
    notify_admin: raw.notify_admin !== false,
    max_auto_replies_per_sender_per_hour: Math.min(20, Math.max(1, Number(raw.max_auto_replies_per_sender_per_hour) || 6)),
  };
}

export async function getCommunitySettings(env: Env): Promise<CommunitySettings> {
  const row = await env.NYAMAL_DB.prepare(
    "SELECT settings_json FROM community_settings WHERE id=1",
  ).first<{ settings_json: string }>();
  if (!row) return { ...DEFAULT_COMMUNITY_SETTINGS };
  let value: unknown;
  try {
    value = JSON.parse(row.settings_json);
  } catch {
    throw new Error("Stored community settings are invalid JSON");
  }
  return storedSettings(value);
}

export function validateCommunitySettings(value: unknown): CommunitySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Community settings must be an object");
  }
  const body = value as Record<string, unknown>;
  const autonomy = Number(body.autonomy_level);
  if (![1, 2, 3, 4].includes(autonomy)) throw new HttpError(400, "Autonomy level must be 1, 2, 3, or 4");
  const groupReplies = body.telegram_group_replies === undefined
    ? DEFAULT_COMMUNITY_SETTINGS.telegram_group_replies
    : body.telegram_group_replies;
  if (groupReplies !== "mention_only" && groupReplies !== "disabled") {
    throw new HttpError(400, "Telegram group replies must be mention_only or disabled");
  }
  const replyLimit = body.max_auto_replies_per_sender_per_hour === undefined
    ? DEFAULT_COMMUNITY_SETTINGS.max_auto_replies_per_sender_per_hour
    : Number(body.max_auto_replies_per_sender_per_hour);
  if (!Number.isInteger(replyLimit) || replyLimit < 1 || replyLimit > 20) {
    throw new HttpError(400, "Reply limit must be between 1 and 20 per person per hour");
  }
  const textField = (field: string, maximum: number, fallback: string): string => {
    if (body[field] === undefined) return fallback;
    if (typeof body[field] !== "string" || body[field].length > maximum) {
      throw new HttpError(400, `${field} must be text no longer than ${maximum} characters`);
    }
    return body[field] as string;
  };
  const welcomeWindow = body.welcome_batch_window_seconds === undefined
    ? DEFAULT_COMMUNITY_SETTINGS.welcome_batch_window_seconds
    : Number(body.welcome_batch_window_seconds);
  if (![0, 5, 10, 15, 30].includes(welcomeWindow)) {
    throw new HttpError(400, "Welcome batch window must be immediate, 5, 10, 15, or 30 seconds");
  }
  const welcomeStyle = body.welcome_style === undefined ? DEFAULT_COMMUNITY_SETTINGS.welcome_style : body.welcome_style;
  if (welcomeStyle !== "warm" && welcomeStyle !== "concise" && welcomeStyle !== "celebratory") {
    throw new HttpError(400, "Welcome style must be warm, concise, or celebratory");
  }
  const welcomeFrequency = body.welcome_max_messages_per_chat_per_hour === undefined
    ? DEFAULT_COMMUNITY_SETTINGS.welcome_max_messages_per_chat_per_hour
    : Number(body.welcome_max_messages_per_chat_per_hour);
  if (!Number.isInteger(welcomeFrequency) || welcomeFrequency < 1 || welcomeFrequency > 100) {
    throw new HttpError(400, "Welcome message limit must be between 1 and 100 per group per hour");
  }
  const individualTemplate = textField(
    "telegram_welcome_individual_template", 1200, DEFAULT_COMMUNITY_SETTINGS.telegram_welcome_individual_template,
  );
  if (!validWelcomeTemplate(individualTemplate, "name")) {
    throw new HttpError(400, "Individual welcome template must use {name} and supported placeholders");
  }
  const groupTemplate = textField(
    "telegram_welcome_group_template", 1500, DEFAULT_COMMUNITY_SETTINGS.telegram_welcome_group_template,
  );
  if (!validWelcomeTemplate(groupTemplate, "member_list")) {
    throw new HttpError(400, "Collective welcome template must use {member_list} and supported placeholders");
  }
  const booleanField = (field: string, fallback: boolean): boolean => {
    if (body[field] === undefined) return fallback;
    if (typeof body[field] !== "boolean") throw new HttpError(400, `${field} must be true or false`);
    return body[field] as boolean;
  };
  return {
    autonomy_level: autonomy as CommunityAutonomyLevel,
    welcome_enabled: booleanField("welcome_enabled", DEFAULT_COMMUNITY_SETTINGS.welcome_enabled),
    welcome_message: textField("welcome_message", 1000, DEFAULT_COMMUNITY_SETTINGS.welcome_message),
    telegram_welcome_individual_template: individualTemplate,
    telegram_welcome_group_template: groupTemplate,
    welcome_individual_enabled: booleanField("welcome_individual_enabled", true),
    welcome_collective_enabled: booleanField("welcome_collective_enabled", true),
    welcome_batch_window_seconds: welcomeWindow as CommunitySettings["welcome_batch_window_seconds"],
    welcome_style: welcomeStyle,
    welcome_mention_members: booleanField("welcome_mention_members", true),
    welcome_include_rules: booleanField("welcome_include_rules", false),
    welcome_include_description: booleanField("welcome_include_description", false),
    welcome_include_links: booleanField("welcome_include_links", false),
    welcome_include_onboarding_questions: booleanField("welcome_include_onboarding_questions", false),
    welcome_useful_links: textField("welcome_useful_links", 1500, ""),
    welcome_onboarding_questions: textField("welcome_onboarding_questions", 1000, ""),
    welcome_ignore_bots: booleanField("welcome_ignore_bots", true),
    welcome_returning_members: booleanField("welcome_returning_members", false),
    welcome_admin_invitees: booleanField("welcome_admin_invitees", true),
    welcome_max_messages_per_chat_per_hour: welcomeFrequency,
    community_description: textField("community_description", 2000, ""),
    community_rules: textField("community_rules", 4000, ""),
    knowledge_base: textField("knowledge_base", 8000, ""),
    telegram_group_replies: groupReplies,
    social_auto_replies: booleanField("social_auto_replies", DEFAULT_COMMUNITY_SETTINGS.social_auto_replies),
    link_protection: booleanField("link_protection", DEFAULT_COMMUNITY_SETTINGS.link_protection),
    trusted_domains: domainList(body.trusted_domains, "trusted_domains"),
    blocked_domains: domainList(body.blocked_domains, "blocked_domains"),
    auto_delete_blocked_telegram_links: booleanField(
      "auto_delete_blocked_telegram_links",
      DEFAULT_COMMUNITY_SETTINGS.auto_delete_blocked_telegram_links,
    ),
    notify_admin: booleanField("notify_admin", DEFAULT_COMMUNITY_SETTINGS.notify_admin),
    max_auto_replies_per_sender_per_hour: replyLimit,
  };
}

export async function saveCommunitySettings(env: Env, settings: CommunitySettings): Promise<void> {
  await env.NYAMAL_DB.prepare(
    `INSERT INTO community_settings(id,settings_json,updated_at) VALUES(1,?,CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json,updated_at=CURRENT_TIMESTAMP`,
  ).bind(JSON.stringify(settings)).run();
}

export function classifyCommunityText(text: string, settings: CommunitySettings): {
  risk: CommunityRisk;
  reason: string;
  domains: string[];
} {
  if (!settings.link_protection) return { risk: "safe", reason: "Link protection is disabled.", domains: [] };
  const matches = text.match(URL_PATTERN) ?? [];
  const domains: string[] = [];
  for (const match of matches.slice(0, 10)) {
    const cleaned = match.replace(/[),.!?;:]+$/g, "");
    try {
      const url = new URL(cleaned.startsWith("www.") ? `https://${cleaned}` : cleaned.includes("://") ? cleaned : `https://${cleaned}`);
      if (url.protocol === "http:" || url.protocol === "https:") domains.push(url.hostname.toLowerCase());
    } catch {
      continue;
    }
  }
  if (!domains.length) return { risk: "safe", reason: "No web links found.", domains: [] };

  const blocked = domains.find((domain) => domainMatches(domain, settings.blocked_domains));
  if (blocked && !domainMatches(blocked, settings.trusted_domains)) {
    return { risk: "confirmed_malicious", reason: `Link matches the administrator blocklist: ${blocked}`, domains };
  }
  const untrusted = domains.filter((domain) => !domainMatches(domain, settings.trusted_domains));
  if (!untrusted.length) return { risk: "safe", reason: "All links match trusted domains.", domains };

  const shortener = untrusted.find((domain) => domainMatches(domain, [...KNOWN_SHORTENERS]));
  if (shortener && SCAM_CUES.test(text)) {
    return { risk: "high_risk", reason: `Untrusted short link combined with a common scam pattern: ${shortener}`, domains };
  }
  if (SCAM_CUES.test(text)) {
    return { risk: "high_risk", reason: "Untrusted link combined with a common credential, payment, or prize scam pattern.", domains };
  }
  if (shortener) {
    return { risk: "suspicious", reason: `Link uses a URL shortener and cannot be safely expanded here: ${shortener}`, domains };
  }
  return { risk: "safe", reason: "Link found; no blocklist or strong scam indicators matched.", domains };
}

export function domainMatches(hostname: string, domains: string[]): boolean {
  return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

export function requiresHumanReview(text: string): boolean {
  return SENSITIVE_CUES.test(text);
}

export function communitySystemContext(settings: CommunitySettings): string {
  const sections = [
    settings.community_description && `Community description:\n${settings.community_description}`,
    settings.community_rules && `Community rules:\n${settings.community_rules}`,
    settings.knowledge_base && `Administrator-approved information:\n${settings.knowledge_base}`,
  ].filter((item): item is string => Boolean(item));
  return sections.length
    ? `\n\nADMINISTRATOR-PROVIDED COMMUNITY CONTEXT\nUse only relevant details from this context. Do not invent missing facts.\n${sections.join("\n\n")}`
    : "";
}

export function welcomeText(settings: CommunitySettings, name?: string): string {
  const community = settings.community_description.trim();
  return settings.welcome_message
    .replaceAll("{name}", name?.trim() || "there")
    .replaceAll("{community}", community)
    .replaceAll("{rules}", settings.community_rules.trim())
    .slice(0, 1000);
}

export async function recordCommunityIncident(
  env: Env,
  incident: {
    sourceKey: string;
    platform: string;
    kind: "moderation" | "response" | "escalation";
    risk: CommunityRisk;
    reason: string;
    messageText: string;
    proposedResponse?: string;
    senderId?: string;
    communityId?: string;
    messageId?: string;
    status?: "pending" | "completed" | "dismissed" | "deleted" | "failed";
    action?: string;
  },
): Promise<{ id: string; inserted: boolean }> {
  const id = crypto.randomUUID();
  const result = await env.NYAMAL_DB.prepare(
    `INSERT OR IGNORE INTO community_incidents
       (id,source_key,platform,kind,risk,reason,message_text,proposed_response,sender_id,community_id,message_id,status,action)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id, incident.sourceKey, incident.platform, incident.kind, incident.risk,
    incident.reason.slice(0, 500), incident.messageText.slice(0, 4000),
    incident.proposedResponse?.slice(0, 4000) ?? null, incident.senderId ?? null,
    incident.communityId ?? null, incident.messageId ?? null,
    incident.status ?? "pending", incident.action ?? "none",
  ).run();
  if (result.meta.changes) return { id, inserted: true };
  const existing = await env.NYAMAL_DB.prepare(
    "SELECT id FROM community_incidents WHERE source_key=?",
  ).bind(incident.sourceKey).first<{ id: string }>();
  if (!existing) throw new Error("Could not retrieve an existing community incident");
  return { id: existing.id, inserted: false };
}

export async function recordCommunityActivity(
  env: Env,
  event: {
    eventKey: string;
    platform: string;
    eventType: string;
    actorId?: string;
    remoteId?: string;
    details?: string;
  },
): Promise<void> {
  await env.NYAMAL_DB.prepare(
    `INSERT OR IGNORE INTO community_activity(event_key,platform,event_type,actor_id,remote_id,details)
     VALUES(?,?,?,?,?,?)`,
  ).bind(
    event.eventKey, event.platform, event.eventType, event.actorId ?? null,
    event.remoteId ?? null, (event.details ?? "").slice(0, 1000),
  ).run();
}

export async function reserveAutoReply(
  env: Env,
  settings: CommunitySettings,
  platform: string,
  senderId: string,
  eventKey: string,
): Promise<boolean> {
  const result = await env.NYAMAL_DB.prepare(
    `INSERT INTO community_activity(event_key,platform,event_type,actor_id,details)
     SELECT ?,?,'response_reserved',?,''
     WHERE (SELECT COUNT(*) FROM community_activity
       WHERE platform=? AND actor_id=? AND event_type='response_sent'
         AND created_at>=datetime('now','-1 hour'))
       + (SELECT COUNT(*) FROM community_activity
       WHERE platform=? AND actor_id=? AND event_type='response_reserved'
         AND created_at>=datetime('now','-2 minutes')) < ?
     ON CONFLICT(event_key) DO UPDATE SET event_type='response_reserved',created_at=CURRENT_TIMESTAMP
       WHERE community_activity.event_type='response_failed'
         OR (community_activity.event_type='response_reserved'
           AND community_activity.created_at<datetime('now','-2 minutes'))`,
  ).bind(
    eventKey, platform, senderId, platform, senderId, platform, senderId,
    settings.max_auto_replies_per_sender_per_hour,
  ).run();
  return Boolean(result.meta.changes);
}

export async function finishAutoReply(env: Env, eventKey: string, sent: boolean): Promise<void> {
  const result = await env.NYAMAL_DB.prepare(
    "UPDATE community_activity SET event_type=?,created_at=CURRENT_TIMESTAMP WHERE event_key=? AND event_type='response_reserved'",
  ).bind(sent ? "response_sent" : "response_failed", eventKey).run();
  if (sent && !result.meta.changes) throw new Error("Could not finalize the community reply reservation");
}
