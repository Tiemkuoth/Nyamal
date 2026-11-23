import { generateReply, type AiImage } from "./ai";
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
  type CommunitySettings,
} from "./community";
import { constantTimeEqual } from "./crypto";
import {
  renderTelegramWelcome,
  splitTelegramWelcome,
  validWelcomeTemplate,
  type TelegramTextMentionEntity,
  type TelegramWelcomeMember,
} from "./telegram-welcome";
import type { Env, ExecutionContextLike, TelegramMessage, TelegramUpdate, TelegramUser } from "./types";

type TelegramJoinMethod = "organic" | "invite_link" | "group_invitation" | "admin_added" | "join_request" | "unknown";
const JOIN_METHOD_CONFIDENCE: Record<TelegramJoinMethod, number> = {
  unknown: 0,
  group_invitation: 1,
  organic: 2,
  admin_added: 3,
  invite_link: 4,
  join_request: 5,
};

interface QueuedWelcomeBatch {
  id: string;
  chat_id: string;
  window_ends_at: number;
}

class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

async function telegram(
  env: Env,
  method: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await response.json()) as {
    ok?: boolean;
    description?: string;
    result?: unknown;
    parameters?: { retry_after?: number };
  };
  if (!response.ok || !data.ok) {
    throw new TelegramApiError(
      `Telegram ${method} failed: ${data.description ?? response.status}`,
      data.parameters?.retry_after,
    );
  }
  return data.result;
}

async function telegramPhotoAsAiImage(env: Env, message: TelegramMessage): Promise<AiImage> {
  const photo = [...(message.photo ?? [])]
    .filter((item) => item.file_size === undefined || item.file_size <= 2 * 1024 * 1024)
    .sort((left, right) => (left.file_size ?? 0) - (right.file_size ?? 0))
    .pop();
  if (!photo) throw new Error("Telegram image is larger than Nyamal's 2 MB per-image limit");
  const file = await telegram(env, "getFile", { file_id: photo.file_id }) as {
    file_path?: string;
    file_size?: number;
  };
  if (!file.file_path || (file.file_size !== undefined && file.file_size > 2 * 1024 * 1024)) {
    throw new Error("Telegram could not provide an image within Nyamal's 2 MB limit");
  }
  const filePath = file.file_path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`,
    { signal: AbortSignal.timeout(15000) },
  );
  if (!response.ok) throw new Error(`Telegram image download failed with HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024) {
    throw new Error("Telegram image is larger than Nyamal's 2 MB per-image limit");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.byteLength > 2 * 1024 * 1024) {
    throw new Error("Telegram image is larger than Nyamal's 2 MB per-image limit");
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return { media_type: "image/jpeg", data: btoa(binary) };
}

export async function registerTelegramWebhook(env: Env, origin: string): Promise<void> {
  const result = await telegram(env, "setWebhook", {
    url: `${origin.replace(/\/+$/, "")}/telegram/webhook`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ["message", "my_chat_member", "chat_member", "chat_join_request"],
    drop_pending_updates: false,
  });
  if (result !== true) throw new Error("Telegram did not confirm webhook registration");
}

async function queueWelcomeForReview(
  env: Env,
  sourceKey: string,
  chatId: number,
  text: string,
  messageId?: number,
): Promise<void> {
  const incident = await recordCommunityIncident(env, {
    sourceKey,
    platform: "telegram",
    kind: "response",
    risk: "safe",
    reason: "Autonomy Level 1 requires approval before a welcome is sent.",
    messageText: "A new member joined the Telegram community.",
    proposedResponse: text,
    senderId: String(chatId),
    communityId: String(chatId),
    messageId: messageId === undefined ? undefined : String(messageId),
  });
  const settings = await getCommunitySettings(env);
  if (incident.inserted && settings.notify_admin) {
    try {
      await sendOwnerNotification(env, "A Telegram welcome message is waiting for approval in the Community Manager.");
    } catch (error) {
      console.error("Could not notify the owner about a Telegram welcome draft", { chatId, error });
    }
  }
}

async function botWelcome(env: Env, chatId: number, updateId: number, messageId?: number): Promise<void> {
  const settings = await getCommunitySettings(env);
  if (!settings.welcome_enabled) return;
  const message = welcomeText(settings, "everyone");
  const text = `${message}\n\nAsk me a question or say /help to see what I can do.`;
  if (settings.autonomy_level < 2) {
    await queueWelcomeForReview(env, `telegram:${updateId}:bot-welcome`, chatId, text, messageId);
    return;
  }
  await telegram(env, "sendMessage", { chat_id: chatId, text });
  await recordCommunityActivity(env, {
    eventKey: `telegram:${updateId}:bot-welcome`,
    platform: "telegram",
    eventType: "bot_welcomed",
    remoteId: String(chatId),
  });
}

function isChatMember(status: string, isMember?: boolean): boolean {
  return ["creator", "administrator", "member"].includes(status)
    || (status === "restricted" && isMember === true);
}

async function classifyJoinMethod(
  env: Env,
  chatId: number,
  member: TelegramUser,
  actor: TelegramUser | undefined,
  hasInviteLink: boolean,
  viaJoinRequest: boolean,
): Promise<TelegramJoinMethod> {
  if (viaJoinRequest) return "join_request";
  if (hasInviteLink) return "invite_link";
  if (!actor) return "unknown";
  if (actor.id === member.id) return "organic";
  try {
    const actorStatus = await telegram(env, "getChatMember", {
      chat_id: chatId,
      user_id: actor.id,
    }) as { status?: string };
    return actorStatus.status === "administrator" || actorStatus.status === "creator"
      ? "admin_added"
      : "group_invitation";
  } catch (error) {
    console.warn("Could not verify the inviter's Telegram role; using a general invitation welcome", {
      chatId,
      actorId: actor.id,
      error,
    });
    return "group_invitation";
  }
}

async function enqueueTelegramWelcome(
  env: Env,
  settings: CommunitySettings,
  event: {
    chatId: number;
    member: TelegramUser;
    method: TelegramJoinMethod;
    joinedAt: number;
    updateId: number;
    sourceKind: "message" | "chat_member";
  },
): Promise<QueuedWelcomeBatch | null> {
  if (!settings.welcome_enabled) return null;
  if (settings.welcome_ignore_bots && event.member.is_bot) {
    await recordCommunityActivity(env, {
      eventKey: `telegram:welcome-skip-bot:${event.chatId}:${event.member.id}:${event.joinedAt}`,
      platform: "telegram",
      eventType: "member_welcome_skipped_bot",
      actorId: String(event.member.id),
      remoteId: String(event.chatId),
    });
    return null;
  }
  const memberId = String(event.member.id);
  const recentDuplicate = await env.NYAMAL_DB.prepare(
    `SELECT id,join_method FROM telegram_welcome_events
     WHERE chat_id=? AND user_id=? AND ABS(joined_at-?)<=2
     ORDER BY ABS(joined_at-?) LIMIT 1`,
  ).bind(String(event.chatId), memberId, event.joinedAt, event.joinedAt)
    .first<{ id: number; join_method: TelegramJoinMethod }>();
  if (recentDuplicate) {
    if (JOIN_METHOD_CONFIDENCE[event.method] > JOIN_METHOD_CONFIDENCE[recentDuplicate.join_method]) {
      await env.NYAMAL_DB.prepare(
        "UPDATE telegram_welcome_events SET join_method=? WHERE id=?",
      ).bind(event.method, recentDuplicate.id).run();
    }
    return null;
  }

  if (event.method === "admin_added" && !settings.welcome_admin_invitees) {
    await recordCommunityActivity(env, {
      eventKey: `telegram:welcome-skip-admin:${event.chatId}:${event.member.id}:${event.joinedAt}`,
      platform: "telegram",
      eventType: "member_welcome_skipped_admin_invitee",
      actorId: String(event.member.id),
      remoteId: String(event.chatId),
    });
    return null;
  }

  if (!settings.welcome_returning_members) {
    const previouslyWelcomed = await env.NYAMAL_DB.prepare(
      `SELECT 1 FROM telegram_welcome_events e
       JOIN telegram_welcome_batches b ON b.id=e.batch_id
       WHERE e.chat_id=? AND e.user_id=? AND b.status='sent' LIMIT 1`,
    ).bind(String(event.chatId), memberId).first();
    if (previouslyWelcomed) {
      await recordCommunityActivity(env, {
        eventKey: `telegram:welcome-skip-returning:${event.chatId}:${memberId}:${event.joinedAt}`,
        platform: "telegram",
        eventType: "member_welcome_skipped_returning",
        actorId: memberId,
        remoteId: String(event.chatId),
      });
      return null;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const batchId = crypto.randomUUID();
  const windowEndsAt = now + settings.welcome_batch_window_seconds;
  const eventKey = `telegram:join:${event.chatId}:${memberId}:${event.joinedAt}`;
  await env.NYAMAL_DB.batch([
    env.NYAMAL_DB.prepare(
      `UPDATE telegram_welcome_batches SET status='ready',updated_at=CURRENT_TIMESTAMP
       WHERE chat_id=? AND status='collecting' AND window_ends_at<=?`,
    ).bind(String(event.chatId), now),
    env.NYAMAL_DB.prepare(
      `INSERT OR IGNORE INTO telegram_welcome_batches(id,chat_id,window_ends_at,status)
       VALUES(?,?,?,'collecting')`,
    ).bind(batchId, String(event.chatId), windowEndsAt),
    env.NYAMAL_DB.prepare(
      `INSERT OR IGNORE INTO telegram_welcome_events
         (event_key,batch_id,chat_id,user_id,first_name,last_name,username,is_bot,join_method,joined_at,update_id,source_kind)
       SELECT ?,id,?,?,?,?,?,?,?,?,?,?
       FROM telegram_welcome_batches WHERE chat_id=? AND status='collecting'`,
    ).bind(
      eventKey,
      String(event.chatId),
      memberId,
      event.member.first_name ?? null,
      event.member.last_name ?? null,
      event.member.username ?? null,
      event.member.is_bot ? 1 : 0,
      event.method,
      event.joinedAt,
      event.updateId,
      event.sourceKind,
      String(event.chatId),
    ),
  ]);
  const queued = await env.NYAMAL_DB.prepare(
    `SELECT b.id,b.chat_id,b.window_ends_at
     FROM telegram_welcome_events e JOIN telegram_welcome_batches b ON b.id=e.batch_id
     WHERE e.event_key=?`,
  ).bind(eventKey).first<QueuedWelcomeBatch>();
  if (!queued) throw new Error("Telegram join event could not be added to the welcome queue");
  return queued;
}

async function handleTelegramJoinEvents(
  env: Env,
  update: TelegramUpdate,
  context?: ExecutionContextLike,
): Promise<void> {
  const settings = await getCommunitySettings(env);
  const batches = new Map<string, number>();
  const queueMember = async (
    chatId: number,
    member: TelegramUser,
    actor: TelegramUser | undefined,
    joinedAt: number,
    sourceKind: "message" | "chat_member",
    hasInviteLink = false,
    viaJoinRequest = false,
  ): Promise<void> => {
    const method = await classifyJoinMethod(env, chatId, member, actor, hasInviteLink, viaJoinRequest);
    const queued = await enqueueTelegramWelcome(env, settings, {
      chatId, member, method, joinedAt, updateId: update.update_id, sourceKind,
    });
    if (queued) {
      batches.set(queued.id, Math.max(0, queued.window_ends_at * 1000 - Date.now()));
    }
  };

  const memberUpdate = update.chat_member;
  if (memberUpdate
    && !isChatMember(memberUpdate.old_chat_member.status, memberUpdate.old_chat_member.is_member)
    && isChatMember(memberUpdate.new_chat_member.status, memberUpdate.new_chat_member.is_member)) {
    await queueMember(
      memberUpdate.chat.id,
      memberUpdate.new_chat_member.user,
      memberUpdate.from,
      memberUpdate.date,
      "chat_member",
      Boolean(memberUpdate.invite_link),
      memberUpdate.via_join_request === true,
    );
  }

  if (update.chat_join_request) {
    await recordCommunityActivity(env, {
      eventKey: `telegram:${update.update_id}:join-request`,
      platform: "telegram",
      eventType: "join_request_received",
      actorId: String(update.chat_join_request.from.id),
      remoteId: String(update.chat_join_request.chat.id),
      details: "A Telegram join request is awaiting an administrator decision.",
    });
  }

  const message = update.message;
  if (message?.new_chat_members?.length) {
    const bot = await botIdentity(env);
    if (message.new_chat_members.some((member) => member.id === bot.id)) {
      await botWelcome(env, message.chat.id, update.update_id, message.message_id);
    }
    for (const member of message.new_chat_members) {
      if (member.id === bot.id) continue;
      await queueMember(
        message.chat.id,
        member,
        message.from,
        message.date,
        "message",
      );
    }
  }

  for (const [batchId, delayMilliseconds] of batches) {
    if (!context) continue;
    const work = (async () => {
      if (delayMilliseconds > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMilliseconds));
      }
      await processTelegramWelcomeQueue(env, 10);
    })();
    context.waitUntil(work.catch((error) => {
      console.error("Background Telegram welcome processing failed; the scheduled worker will retry queued batches", {
        batchId,
        error,
      });
    }));
  }
}

type TelegramBotIdentity = { id: number; username: string };

async function botIdentity(env: Env): Promise<TelegramBotIdentity> {
  const cached = await env.NYAMAL_DB.prepare(
    "SELECT value FROM engine_settings WHERE key='telegram.bot_identity'",
  ).first<{ value: string }>();
  if (cached) {
    try {
      const identity = JSON.parse(cached.value) as TelegramBotIdentity;
      if (Number.isSafeInteger(identity.id) && identity.username) return identity;
    } catch {
      throw new Error("Stored Telegram bot identity is invalid JSON");
    }
  }
  const identity = await telegram(env, "getMe", {}) as { id?: number; username?: string };
  if (!identity.id || !identity.username) throw new Error("Telegram did not return the bot identity");
  const result = { id: identity.id, username: identity.username.toLowerCase() };
  await env.NYAMAL_DB.prepare(
    `INSERT INTO engine_settings(key,value) VALUES('telegram.bot_identity',?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`,
  ).bind(JSON.stringify(result)).run();
  return result;
}

async function addressedToBot(env: Env, message: TelegramMessage): Promise<boolean> {
  if (message.chat.type === "private") return true;
  const candidateText = message.text ?? message.caption ?? "";
  if (!/@[A-Za-z0-9_]+/.test(candidateText) && !message.reply_to_message?.from?.is_bot) return false;
  const identity = await botIdentity(env);
  const mention = new RegExp(`(^|\\s)@${identity.username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\b|\\s|$)`, "i");
  return mention.test(candidateText) || message.reply_to_message?.from?.id === identity.id;
}

export async function sendTelegramIncidentResponse(
  env: Env,
  chatId: string,
  messageId: string | null,
  text: string,
): Promise<void> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: text.slice(0, 4000),
  };
  if (messageId && /^-?\d+$/.test(chatId) && /^\d+$/.test(messageId)) {
    payload.reply_parameters = { message_id: Number(messageId), allow_sending_without_reply: true };
  }
  await telegram(env, "sendMessage", payload);
}

export async function deleteTelegramMessage(env: Env, chatId: string, messageId: string): Promise<void> {
  if (!/^-?\d+$/.test(chatId) || !/^\d+$/.test(messageId)) {
    throw new Error("Telegram chat or message ID is invalid");
  }
  await telegram(env, "deleteMessage", { chat_id: Number(chatId), message_id: Number(messageId) });
}

async function reply(env: Env, message: TelegramMessage, text: string): Promise<void> {
  await telegram(env, "sendMessage", {
    chat_id: message.chat.id,
    text: text.slice(0, 4000),
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
  });
}

export async function sendOwnerNotification(env: Env, text: string): Promise<void> {
  if (!env.NYAMAL_OWNER_TELEGRAM_ID) return;
  await telegram(env, "sendMessage", {
    chat_id: env.NYAMAL_OWNER_TELEGRAM_ID,
    text: text.slice(0, 4000),
  });
}

function joinContext(method: TelegramJoinMethod): string {
  switch (method) {
    case "organic": return "We're glad you found us.";
    case "invite_link": return "We're happy you joined through an invite.";
    case "group_invitation": return "We're glad you accepted an invitation to join us.";
    case "admin_added": return "You've been invited to join us, and we're happy to have you here.";
    case "join_request": return "We're glad your request to join was approved.";
    default: return "We're glad you're here.";
  }
}

function welcomeValues(
  settings: CommunitySettings,
  method: TelegramJoinMethod,
): {
  name: string;
  join_context: string;
  member_list: string;
  community: string;
  rules: string;
  links: string;
  questions: string;
} {
  return {
    name: "",
    join_context: joinContext(method),
    member_list: "",
    community: settings.welcome_include_description
      ? `\n\n${settings.community_description.trim().slice(0, 400)}`
      : "",
    rules: settings.welcome_include_rules
      ? `\n\nCommunity rules: ${settings.community_rules.trim().slice(0, 400)}`
      : "",
    links: settings.welcome_include_links
      ? `\n\nUseful links: ${settings.welcome_useful_links.trim().slice(0, 500)}`
      : "",
    questions: settings.welcome_include_onboarding_questions
      ? `\n\nIf you'd like, tell us: ${settings.welcome_onboarding_questions.trim().slice(0, 300)}`
      : "",
  };
}

async function welcomeTemplateVariation(
  env: Env,
  settings: CommunitySettings,
  userId: number,
  template: string,
  requiredPlaceholder: "name" | "member_list",
  method: TelegramJoinMethod,
  eventKey?: string,
): Promise<string> {
  const prompt = [
    "Write one natural, short Telegram welcome-message variation based on the administrator's template.",
    `Style: ${settings.welcome_style}.`,
    `Joining context: ${method}.`,
    `Keep the required placeholder ${`{${requiredPlaceholder}}`} exactly, and preserve any other supported placeholders.`,
    "Do not add member names, usernames, genders, pronouns, private invitation details, rules, links, or facts that are not in the template.",
    "Use a warm, respectful community-host voice and moderate emoji. Output only the message template.",
    "Administrator template:",
    template,
  ].join("\n");
  try {
    const variation = (await generateReply(env, userId, prompt, "chat", {
      persist: false,
      includeHistory: false,
      includeMemories: false,
      systemContext: communitySystemContext(settings),
    })).trim();
    if (!validWelcomeTemplate(variation, requiredPlaceholder)) {
      throw new Error("AI welcome variation did not preserve the required template placeholders");
    }
    return variation;
  } catch (error) {
    console.error("AI welcome generation failed; the administrator's saved template will be used", {
      eventKey,
      error,
    });
    if (eventKey) {
      await recordCommunityActivity(env, {
        eventKey: `${eventKey}:ai-fallback`,
        platform: "telegram",
        eventType: "welcome_ai_fallback",
        details: "The saved administrator template was used because AI could not create a valid variation.",
      });
    }
    return template;
  }
}

async function createWelcomeMessages(
  env: Env,
  settings: CommunitySettings,
  members: TelegramWelcomeMember[],
  methods: TelegramJoinMethod[],
  eventKey?: string,
): Promise<Array<{ text: string; entities: TelegramTextMentionEntity[] }>> {
  const collective = members.length > 1;
  if (collective ? !settings.welcome_collective_enabled : !settings.welcome_individual_enabled) return [];
  const uniqueMethods = [...new Set(methods)];
  const method = uniqueMethods.length === 1 ? uniqueMethods[0] : "unknown";
  const requiredPlaceholder = collective ? "member_list" : "name";
  const baseTemplate = collective
    ? settings.telegram_welcome_group_template
    : settings.telegram_welcome_individual_template;
  const template = await welcomeTemplateVariation(
    env,
    settings,
    members[0].id,
    baseTemplate,
    requiredPlaceholder,
    method,
    eventKey,
  );
  return splitTelegramWelcome(
    template,
    members,
    welcomeValues(settings, method),
    settings.welcome_mention_members,
  );
}

export async function sendTelegramWelcomeDelivery(
  env: Env,
  chatId: string,
  text: string,
  entities: TelegramTextMentionEntity[],
): Promise<string> {
  const result = await telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    entities,
  }) as { message_id?: number } | null;
  if (!result?.message_id) throw new Error("Telegram accepted the welcome but did not return a message ID");
  return String(result.message_id);
}

async function reserveWelcomeAnnouncement(
  env: Env,
  batchId: string,
  chatId: string,
  settings: CommunitySettings,
): Promise<number | null> {
  const now = Math.floor(Date.now() / 1000);
  const hourStart = Math.floor(now / 3600) * 3600;
  const batch = await env.NYAMAL_DB.prepare(
    "SELECT rate_hour_start FROM telegram_welcome_batches WHERE id=?",
  ).bind(batchId).first<{ rate_hour_start: number | null }>();
  if (!batch) throw new Error("Telegram welcome batch disappeared before rate-limit check");
  if (batch.rate_hour_start === hourStart) return null;

  await env.NYAMAL_DB.prepare(
    `INSERT OR IGNORE INTO telegram_welcome_rate_limits(chat_id,hour_start,announcement_count)
     VALUES(?,?,0)`,
  ).bind(chatId, hourStart).run();
  const reservation = await env.NYAMAL_DB.prepare(
    `UPDATE telegram_welcome_rate_limits SET announcement_count=announcement_count+1,
       updated_at=CURRENT_TIMESTAMP
     WHERE chat_id=? AND hour_start=? AND announcement_count<?`,
  ).bind(chatId, hourStart, settings.welcome_max_messages_per_chat_per_hour).run();
  if (!reservation.meta.changes) return hourStart + 3600;
  await env.NYAMAL_DB.prepare(
    "UPDATE telegram_welcome_batches SET rate_reserved=1,rate_hour_start=? WHERE id=?",
  ).bind(hourStart, batchId).run();
  return null;
}

async function recordBatchMembersWelcomed(
  env: Env,
  batchId: string,
  chatId: string,
): Promise<void> {
  const members = await env.NYAMAL_DB.prepare(
    "SELECT user_id,join_method FROM telegram_welcome_events WHERE batch_id=? ORDER BY id",
  ).bind(batchId).all<{ user_id: string; join_method: TelegramJoinMethod }>();
  for (const member of members.results ?? []) {
    await recordCommunityActivity(env, {
      eventKey: `telegram:welcome:${batchId}:member:${member.user_id}`,
      platform: "telegram",
      eventType: "member_welcomed",
      actorId: member.user_id,
      remoteId: chatId,
      details: `Join method: ${member.join_method}`,
    });
  }
}

async function finishWelcomeBatch(env: Env, batchId: string, chatId: string): Promise<void> {
  const remaining = await env.NYAMAL_DB.prepare(
    "SELECT COUNT(*) count FROM telegram_welcome_deliveries WHERE batch_id=? AND status<>'sent'",
  ).bind(batchId).first<{ count: number }>();
  if ((remaining?.count ?? 0) > 0) {
    await env.NYAMAL_DB.prepare(
      "UPDATE telegram_welcome_batches SET status='ready',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='processing'",
    ).bind(batchId).run();
    return;
  }
  await env.NYAMAL_DB.prepare(
    "UPDATE telegram_welcome_batches SET status='sent',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?",
  ).bind(batchId).run();
  await recordBatchMembersWelcomed(env, batchId, chatId);
}

async function sendPendingWelcomeDeliveries(env: Env, batchId: string, chatId: string): Promise<void> {
  const rows = await env.NYAMAL_DB.prepare(
    `SELECT id,sequence,text,entities_json,attempt_count
     FROM telegram_welcome_deliveries
     WHERE batch_id=? AND status='pending' AND retry_at<=?
     ORDER BY sequence`,
  ).bind(batchId, Math.floor(Date.now() / 1000))
    .all<{
      id: number;
      sequence: number;
      text: string;
      entities_json: string;
      attempt_count: number;
    }>();
  for (const delivery of rows.results ?? []) {
    const claimed = await env.NYAMAL_DB.prepare(
      `UPDATE telegram_welcome_deliveries SET status='sending',attempt_count=attempt_count+1,
         updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND status='pending'`,
    ).bind(delivery.id).run();
    if (!claimed.meta.changes) continue;

    let entities: TelegramTextMentionEntity[];
    try {
      const parsed = JSON.parse(delivery.entities_json) as TelegramTextMentionEntity[];
      if (!Array.isArray(parsed)) throw new Error("Welcome message mention data is invalid");
      entities = parsed;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Welcome message mention data is invalid";
      await env.NYAMAL_DB.prepare(
        "UPDATE telegram_welcome_deliveries SET status='failed',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      ).bind(detail.slice(0, 500), delivery.id).run();
      await env.NYAMAL_DB.prepare(
        "UPDATE telegram_welcome_batches SET status='failed',safe_to_retry=1,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      ).bind(detail.slice(0, 500), batchId).run();
      return;
    }

    try {
      const telegramMessageId = await sendTelegramWelcomeDelivery(env, chatId, delivery.text, entities);
      await env.NYAMAL_DB.prepare(
        `UPDATE telegram_welcome_deliveries SET status='sent',telegram_message_id=?,last_error=NULL,
           updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='sending'`,
      ).bind(telegramMessageId, delivery.id).run();
      await recordCommunityActivity(env, {
        eventKey: `telegram:welcome:${batchId}:delivery:${delivery.sequence}`,
        platform: "telegram",
        eventType: "welcome_message_sent",
        remoteId: chatId,
        details: `Welcome announcement ${delivery.sequence + 1} sent.`,
      });
    } catch (error) {
      const isRateLimit = error instanceof TelegramApiError
        && Number.isSafeInteger(error.retryAfterSeconds)
        && (error.retryAfterSeconds ?? 0) > 0;
      const attempt = delivery.attempt_count + 1;
      if (isRateLimit && attempt < 5) {
        const retryAt = Math.floor(Date.now() / 1000) + (error.retryAfterSeconds ?? 1);
        await env.NYAMAL_DB.prepare(
          `UPDATE telegram_welcome_deliveries SET status='pending',retry_at=?,last_error=?,
             updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        ).bind(retryAt, error.message.slice(0, 500), delivery.id).run();
        await env.NYAMAL_DB.prepare(
          `UPDATE telegram_welcome_batches SET status='ready',available_at=?,last_error=?,
             updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        ).bind(retryAt, error.message.slice(0, 500), batchId).run();
        await recordCommunityActivity(env, {
          eventKey: `telegram:welcome:${batchId}:retry:${delivery.sequence}:${attempt}`,
          platform: "telegram",
          eventType: "welcome_retry_scheduled",
          remoteId: chatId,
          details: `Telegram requested a retry after ${error.retryAfterSeconds} seconds.`,
        });
        return;
      }

      const uncertain = !(error instanceof TelegramApiError);
      const detail = `${uncertain ? "Delivery outcome uncertain: " : ""}${error instanceof Error ? error.message : "Telegram delivery failed"}`;
      await env.NYAMAL_DB.prepare(
        `UPDATE telegram_welcome_deliveries SET status='failed',last_error=?,updated_at=CURRENT_TIMESTAMP
         WHERE id=?`,
      ).bind(detail.slice(0, 500), delivery.id).run();
      await env.NYAMAL_DB.prepare(
        `UPDATE telegram_welcome_batches SET status='failed',safe_to_retry=?,last_error=?,
           updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      ).bind(uncertain ? 0 : 1, detail.slice(0, 500), batchId).run();
      await recordCommunityActivity(env, {
        eventKey: `telegram:welcome:${batchId}:delivery-failed:${delivery.sequence}`,
        platform: "telegram",
        eventType: "welcome_delivery_failed",
        remoteId: chatId,
        details: detail.slice(0, 500),
      });
      const settings = await getCommunitySettings(env);
      if (settings.notify_admin) {
        try {
          await sendOwnerNotification(env,
            `Nyamal could not confirm a Telegram welcome delivery for chat ${chatId}. ${detail.slice(0, 300)}${uncertain ? " Check the group before retrying." : ""}`);
        } catch (notifyError) {
          console.error("Could not notify the owner about a failed Telegram welcome", { batchId, error: notifyError });
        }
      }
      return;
    }
  }
  await finishWelcomeBatch(env, batchId, chatId);
}

async function processWelcomeBatch(env: Env, batchId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const claimed = await env.NYAMAL_DB.prepare(
    `UPDATE telegram_welcome_batches SET status='processing',attempt_count=attempt_count+1,
       updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND status='ready' AND available_at<=?`,
  ).bind(batchId, now).run();
  if (!claimed.meta.changes) return;

  const batch = await env.NYAMAL_DB.prepare(
    "SELECT chat_id,rate_hour_start FROM telegram_welcome_batches WHERE id=?",
  ).bind(batchId).first<{ chat_id: string; rate_hour_start: number | null }>();
  if (!batch) throw new Error("Claimed Telegram welcome batch could not be loaded");
  const settings = await getCommunitySettings(env);
  if (!settings.welcome_enabled) {
    await env.NYAMAL_DB.prepare(
      "UPDATE telegram_welcome_batches SET status='skipped',last_error='Welcomes were disabled before delivery',updated_at=CURRENT_TIMESTAMP WHERE id=?",
    ).bind(batchId).run();
    await recordCommunityActivity(env, {
      eventKey: `telegram:welcome:${batchId}:disabled`,
      platform: "telegram",
      eventType: "member_welcome_skipped_disabled",
      remoteId: batch.chat_id,
    });
    return;
  }

  const queuedMembers = await env.NYAMAL_DB.prepare(
    `SELECT user_id,first_name,last_name,username,is_bot,join_method
     FROM telegram_welcome_events WHERE batch_id=? ORDER BY id`,
  ).bind(batchId).all<{
    user_id: string;
    first_name: string | null;
    last_name: string | null;
    username: string | null;
    is_bot: number;
    join_method: TelegramJoinMethod;
  }>();
  const members = (queuedMembers.results ?? [])
    .filter((member) => !settings.welcome_ignore_bots || member.is_bot === 0)
    .filter((member) => settings.welcome_admin_invitees || member.join_method !== "admin_added")
    .map((member): TelegramWelcomeMember => ({
      id: Number(member.user_id),
      is_bot: member.is_bot === 1,
      first_name: member.first_name ?? undefined,
      last_name: member.last_name ?? undefined,
      username: member.username ?? undefined,
    }));
  const methods = (queuedMembers.results ?? [])
    .filter((member) => members.some((welcomeMember) => String(welcomeMember.id) === member.user_id))
    .map((member) => member.join_method);
  if (!members.length) {
    await env.NYAMAL_DB.prepare(
      "UPDATE telegram_welcome_batches SET status='skipped',updated_at=CURRENT_TIMESTAMP WHERE id=?",
    ).bind(batchId).run();
    return;
  }
  if (members.length > 1 && !settings.welcome_collective_enabled) {
    await env.NYAMAL_DB.prepare(
      "UPDATE telegram_welcome_batches SET status='skipped',last_error='Collective welcomes are disabled',updated_at=CURRENT_TIMESTAMP WHERE id=?",
    ).bind(batchId).run();
    await recordCommunityActivity(env, {
      eventKey: `telegram:welcome:${batchId}:collective-disabled`,
      platform: "telegram",
      eventType: "member_welcome_skipped_collective_disabled",
      remoteId: batch.chat_id,
    });
    return;
  }
  if (members.length === 1 && !settings.welcome_individual_enabled) {
    await env.NYAMAL_DB.prepare(
      "UPDATE telegram_welcome_batches SET status='skipped',last_error='Individual welcomes are disabled',updated_at=CURRENT_TIMESTAMP WHERE id=?",
    ).bind(batchId).run();
    await recordCommunityActivity(env, {
      eventKey: `telegram:welcome:${batchId}:individual-disabled`,
      platform: "telegram",
      eventType: "member_welcome_skipped_individual_disabled",
      actorId: String(members[0].id),
      remoteId: batch.chat_id,
    });
    return;
  }

  const existingDeliveries = await env.NYAMAL_DB.prepare(
    "SELECT COUNT(*) count FROM telegram_welcome_deliveries WHERE batch_id=?",
  ).bind(batchId).first<{ count: number }>();
  if (!existingDeliveries?.count) {
    const rendered = await createWelcomeMessages(
      env,
      settings,
      members,
      methods,
      `telegram:welcome:${batchId}`,
    );
    if (!rendered.length) {
      await env.NYAMAL_DB.prepare(
        "UPDATE telegram_welcome_batches SET status='skipped',updated_at=CURRENT_TIMESTAMP WHERE id=?",
      ).bind(batchId).run();
      return;
    }
    await env.NYAMAL_DB.batch(rendered.map((message, sequence) => env.NYAMAL_DB.prepare(
      `INSERT OR IGNORE INTO telegram_welcome_deliveries(batch_id,sequence,text,entities_json)
       VALUES(?,?,?,?)`,
    ).bind(batchId, sequence, message.text, JSON.stringify(message.entities))));
  }

  if (settings.autonomy_level < 2) {
    const deliveries = await env.NYAMAL_DB.prepare(
      "SELECT sequence,text FROM telegram_welcome_deliveries WHERE batch_id=? ORDER BY sequence",
    ).bind(batchId).all<{ sequence: number; text: string }>();
    for (const delivery of deliveries.results ?? []) {
      await recordCommunityIncident(env, {
        sourceKey: `telegram:welcome:${batchId}:${delivery.sequence}`,
        platform: "telegram",
        kind: "response",
        risk: "safe",
        reason: "Autonomy Level 1 requires approval before a Telegram welcome is sent.",
        messageText: `A batch of ${members.length} new Telegram member(s) joined.`,
        proposedResponse: delivery.text,
        senderId: batch.chat_id,
        communityId: batch.chat_id,
      });
    }
    await env.NYAMAL_DB.prepare(
      "UPDATE telegram_welcome_batches SET status='review',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?",
    ).bind(batchId).run();
    await recordCommunityActivity(env, {
      eventKey: `telegram:welcome:${batchId}:review`,
      platform: "telegram",
      eventType: "welcome_waiting_review",
      remoteId: batch.chat_id,
      details: `${members.length} member(s) are in the welcome approval queue.`,
    });
    if (settings.notify_admin) {
      try {
        await sendOwnerNotification(env, "A Telegram group welcome is waiting for approval in the Community Manager.");
      } catch (error) {
        console.error("Could not notify the owner about a Telegram welcome draft", { batchId, error });
      }
    }
    return;
  }

  const retryAt = await reserveWelcomeAnnouncement(env, batchId, batch.chat_id, settings);
  if (retryAt !== null) {
    await env.NYAMAL_DB.prepare(
      `UPDATE telegram_welcome_batches SET status='ready',available_at=?,last_error=?,
         updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    ).bind(retryAt, "The configured hourly welcome limit was reached; this batch is queued for the next interval.", batchId).run();
    await recordCommunityActivity(env, {
      eventKey: `telegram:welcome:${batchId}:rate-limited:${Math.floor(retryAt / 3600)}`,
      platform: "telegram",
      eventType: "welcome_rate_limited",
      remoteId: batch.chat_id,
      details: "The welcome batch was queued for the next hourly interval.",
    });
    return;
  }
  await sendPendingWelcomeDeliveries(env, batchId, batch.chat_id);
}

export async function processTelegramWelcomeQueue(env: Env, limit = 10): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.NYAMAL_DB.prepare(
    `UPDATE telegram_welcome_batches SET status='ready',updated_at=CURRENT_TIMESTAMP
     WHERE status='collecting' AND window_ends_at<=?`,
  ).bind(now).run();
  const stale = await env.NYAMAL_DB.prepare(
    `UPDATE telegram_welcome_batches
     SET status='failed',
         safe_to_retry=CASE WHEN EXISTS(
           SELECT 1 FROM telegram_welcome_deliveries d WHERE d.batch_id=telegram_welcome_batches.id AND d.status='sending'
         ) THEN 0 ELSE 1 END,
         last_error=CASE WHEN EXISTS(
           SELECT 1 FROM telegram_welcome_deliveries d WHERE d.batch_id=telegram_welcome_batches.id AND d.status='sending'
         ) THEN 'Delivery outcome uncertain: Worker stopped while a message was being sent.'
         ELSE 'Worker stopped while processing the welcome batch; it is safe to retry.' END,
         updated_at=CURRENT_TIMESTAMP
     WHERE status='processing' AND updated_at<datetime('now','-5 minutes')`,
  ).run();
  if (stale.meta.changes) {
    console.error("Telegram welcome batches were recovered after a stale worker lock", { count: stale.meta.changes });
  }
  await env.NYAMAL_DB.prepare(
    "UPDATE telegram_welcome_deliveries SET status='failed',last_error='Delivery outcome uncertain: Worker stopped while sending this message.',updated_at=CURRENT_TIMESTAMP WHERE status='sending' AND updated_at<datetime('now','-5 minutes')",
  ).run();
  await env.NYAMAL_DB.prepare(
    "DELETE FROM telegram_welcome_rate_limits WHERE hour_start<?",
  ).bind(now - 48 * 3600).run();

  const due = await env.NYAMAL_DB.prepare(
    `SELECT id FROM telegram_welcome_batches
     WHERE status='ready' AND window_ends_at<=? AND available_at<=?
     ORDER BY window_ends_at,id LIMIT ?`,
  ).bind(now, now, Math.max(1, Math.min(50, Math.trunc(limit)))).all<{ id: string }>();
  for (const batch of due.results ?? []) {
    try {
      await processWelcomeBatch(env, batch.id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Telegram welcome processing failed";
      console.error("Telegram welcome batch processing failed", { batchId: batch.id, error });
      await env.NYAMAL_DB.prepare(
        `UPDATE telegram_welcome_batches SET status='failed',safe_to_retry=1,last_error=?,
           updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='processing'`,
      ).bind(detail.slice(0, 500), batch.id).run();
      const batchInfo = await env.NYAMAL_DB.prepare(
        "SELECT chat_id FROM telegram_welcome_batches WHERE id=?",
      ).bind(batch.id).first<{ chat_id: string }>();
      await recordCommunityActivity(env, {
        eventKey: `telegram:welcome:${batch.id}:processing-failed`,
        platform: "telegram",
        eventType: "welcome_processing_failed",
        remoteId: batchInfo?.chat_id,
        details: detail.slice(0, 500),
      });
      const settings = await getCommunitySettings(env);
      if (settings.notify_admin) {
        try {
          await sendOwnerNotification(env, `Nyamal could not prepare a Telegram welcome batch. ${detail.slice(0, 300)}`);
        } catch (notifyError) {
          console.error("Could not notify the owner about Telegram welcome processing failure", {
            batchId: batch.id,
            error: notifyError,
          });
        }
      }
    }
  }
}

export async function approveTelegramWelcomeDelivery(
  env: Env,
  batchId: string,
  sequence: number,
  chatId: string,
): Promise<void> {
  const settings = await getCommunitySettings(env);
  const retryAt = await reserveWelcomeAnnouncement(env, batchId, chatId, settings);
  if (retryAt !== null) {
    throw new Error(`The Telegram welcome limit was reached. It can be sent after ${new Date(retryAt * 1000).toISOString()}.`);
  }
  const delivery = await env.NYAMAL_DB.prepare(
    "SELECT id,text,entities_json,status FROM telegram_welcome_deliveries WHERE batch_id=? AND sequence=?",
  ).bind(batchId, sequence).first<{
    id: number;
    text: string;
    entities_json: string;
    status: string;
  }>();
  if (!delivery || delivery.status !== "pending") {
    throw new Error("This welcome part is no longer waiting to be sent");
  }
  const claimed = await env.NYAMAL_DB.prepare(
    `UPDATE telegram_welcome_deliveries SET status='sending',attempt_count=attempt_count+1,
       updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'`,
  ).bind(delivery.id).run();
  if (!claimed.meta.changes) throw new Error("This welcome part is already being sent");
  let entities: TelegramTextMentionEntity[];
  try {
    const parsed = JSON.parse(delivery.entities_json) as TelegramTextMentionEntity[];
    if (!Array.isArray(parsed)) throw new Error("Welcome mention data is invalid");
    entities = parsed;
  } catch (error) {
    await env.NYAMAL_DB.prepare(
      "UPDATE telegram_welcome_deliveries SET status='failed',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
    ).bind(error instanceof Error ? error.message.slice(0, 500) : "Welcome mention data is invalid", delivery.id).run();
    throw error;
  }
  try {
    const messageId = await sendTelegramWelcomeDelivery(env, chatId, delivery.text, entities);
    await env.NYAMAL_DB.prepare(
      `UPDATE telegram_welcome_deliveries SET status='sent',telegram_message_id=?,last_error=NULL,
         updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    ).bind(messageId, delivery.id).run();
    await recordCommunityActivity(env, {
      eventKey: `telegram:welcome:${batchId}:delivery:${sequence}`,
      platform: "telegram",
      eventType: "welcome_message_sent",
      remoteId: chatId,
      details: `Welcome announcement ${sequence + 1} sent after administrator approval.`,
    });
    await env.NYAMAL_DB.prepare(
      "UPDATE telegram_welcome_batches SET status='review',updated_at=CURRENT_TIMESTAMP WHERE id=?",
    ).bind(batchId).run();
    await finishWelcomeBatch(env, batchId, chatId);
  } catch (error) {
    const uncertain = !(error instanceof TelegramApiError);
    const detail = `${uncertain ? "Delivery outcome uncertain: " : ""}${error instanceof Error ? error.message : "Telegram delivery failed"}`;
    await env.NYAMAL_DB.prepare(
      `UPDATE telegram_welcome_deliveries SET status='failed',last_error=?,updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
    ).bind(detail.slice(0, 500), delivery.id).run();
    await env.NYAMAL_DB.prepare(
      "UPDATE telegram_welcome_batches SET status='failed',safe_to_retry=?,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
    ).bind(uncertain ? 0 : 1, detail.slice(0, 500), batchId).run();
    throw error;
  }
}

export async function retryTelegramWelcomeBatch(env: Env, batchId: string): Promise<void> {
  const batch = await env.NYAMAL_DB.prepare(
    "SELECT status,safe_to_retry FROM telegram_welcome_batches WHERE id=?",
  ).bind(batchId).first<{ status: string; safe_to_retry: number }>();
  if (!batch) throw new Error("Telegram welcome batch not found");
  if (batch.status !== "failed" || batch.safe_to_retry !== 1) {
    throw new Error("This welcome batch cannot be retried automatically; verify whether Telegram sent it first.");
  }
  await env.NYAMAL_DB.prepare(
    `UPDATE telegram_welcome_deliveries SET status='pending',retry_at=0,last_error=NULL,
       updated_at=CURRENT_TIMESTAMP WHERE batch_id=? AND status='failed'`,
  ).bind(batchId).run();
  await env.NYAMAL_DB.prepare(
    `UPDATE telegram_welcome_batches SET status='ready',available_at=0,last_error=NULL,
       updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='failed' AND safe_to_retry=1`,
  ).bind(batchId).run();
}

export async function sendTelegramWelcomeTest(
  env: Env,
  chatId: string,
  type: "individual" | "collective" = "collective",
): Promise<void> {
  const settings = await getCommunitySettings(env);
  const members: TelegramWelcomeMember[] = type === "individual"
    ? [{ id: 1, first_name: "Alex" }]
    : [{ id: 1, first_name: "Alex" }, { id: 2, first_name: "Sam" }];
  const messages = await createWelcomeMessages(
    env,
    settings,
    members,
    members.map(() => "unknown"),
  );
  if (messages.length !== 1) {
    throw new Error(`The current ${type} welcome is disabled or too long for a single test message.`);
  }
  const label = type === "individual" ? "INDIVIDUAL" : "COLLECTIVE";
  const text = `🧪 TEST ${label} WELCOME — no join event\n\n${messages[0].text}`;
  if (text.length > 4096) throw new Error("The test welcome exceeds Telegram's message limit");
  await sendTelegramWelcomeDelivery(env, chatId, text, []);
}

async function isOwner(env: Env, userId: number): Promise<boolean> {
  return Boolean(env.NYAMAL_OWNER_TELEGRAM_ID) && String(userId) === env.NYAMAL_OWNER_TELEGRAM_ID;
}

async function command(
  env: Env,
  message: TelegramMessage,
  userId: number,
  text: string,
): Promise<boolean> {
  const [rawCommand, ...args] = text.trim().split(/\s+/);
  const name = rawCommand.split("@")[0].toLowerCase();
  const argument = args.join(" ").trim();
  if (name === "/start" || name === "/help") {
    await reply(env, message,
      "Hey, I'm Nyamal. Send me a message to chat, or try /ideas, /create <topic>, /remember <fact>, /memories, or /forget.");
  } else if (name === "/ideas") {
    await reply(env, message, await generateReply(env, userId, "Suggest 5 concise, varied social-media content ideas."));
  } else if (name === "/create") {
    if (!argument) await reply(env, message, "Usage: /create <topic>");
    else {
      const draft = await generateReply(env, userId, `Create an engaging social post about: ${argument}`,);
      const id = crypto.randomUUID();
      await env.NYAMAL_DB.prepare(
        `INSERT INTO content_items(id,title,body,platform,status,created_by)
         VALUES(?,?,?,'draft','draft',?)`,
      ).bind(id, argument.slice(0, 240), draft, String(userId)).run();
      await reply(env, message, `Draft saved for review:\n\n${draft}`);
    }
  } else if (name === "/remember") {
    if (!argument) await reply(env, message, "Usage: /remember <fact>");
    else {
      await env.NYAMAL_DB.prepare(
        `INSERT INTO long_memories(user_id,memory,category,importance)
         VALUES(?,?,'general',3) ON CONFLICT(user_id,memory) DO UPDATE SET updated_at=CURRENT_TIMESTAMP`,
      ).bind(userId, argument.slice(0, 1000)).run();
      await reply(env, message, "Got it. I'll keep that in mind.");
    }
  } else if (name === "/memories" || name === "/memory") {
    const memories = await env.NYAMAL_DB.prepare(
      "SELECT id,memory FROM long_memories WHERE user_id=? ORDER BY importance DESC,id DESC LIMIT 15",
    ).bind(userId).all<{ id: number; memory: string }>();
    await reply(env, message, (memories.results ?? []).length
      ? "Your saved memories:\n" + memories.results!.map((item) => `• ${item.memory} (/forget ${item.id})`).join("\n")
      : "You haven't saved any long-term memories yet. Use /remember <fact> when you want me to keep something.");
  } else if (name === "/providers") {
    const providers = await env.NYAMAL_DB.prepare(
      "SELECT p.name,COUNT(m.id) model_count FROM ai_providers p LEFT JOIN ai_models m ON m.provider_id=p.id AND m.enabled=1 WHERE p.enabled=1 GROUP BY p.id ORDER BY p.priority",
    ).all<{ name: string; model_count: number }>();
    await reply(env, message, (providers.results ?? []).length
      ? "Configured AI providers:\n" + providers.results!.map((item) => `• ${item.name} (${item.model_count} enabled models)`).join("\n")
      : "No AI providers are configured yet.");
  } else if (name === "/forget") {
    if (argument) {
      const memoryId = Number(argument);
      if (!Number.isSafeInteger(memoryId) || memoryId < 1) {
        await reply(env, message, "Use /forget <memory_id> to remove one saved memory, or /forget all to clear recent chat history.");
      } else {
        const result = await env.NYAMAL_DB.prepare("DELETE FROM long_memories WHERE user_id=? AND id=?")
          .bind(userId, memoryId).run();
        await reply(env, message, result.meta.changes ? "That saved memory is removed." : "I couldn't find that memory.");
      }
    } else {
      await env.NYAMAL_DB.prepare("DELETE FROM messages WHERE user_id=?").bind(userId).run();
      await reply(env, message, "Done. I've cleared our recent chat history; your saved memories are unchanged.");
    }
  } else if (["/status", "/tasks", "/pauseengine", "/resumeengine", "/approve", "/reject"].includes(name)) {
    if (!(await isOwner(env, userId))) {
      await reply(env, message, "That command is reserved for Nyamal's administrator.");
    } else if (name === "/status") {
      const [taskCounts, providers] = await Promise.all([
        env.NYAMAL_DB.prepare("SELECT status,COUNT(*) n FROM tasks GROUP BY status").all<{ status: string; n: number }>(),
        env.NYAMAL_DB.prepare("SELECT name FROM ai_providers WHERE enabled=1 ORDER BY priority").all<{ name: string }>(),
      ]);
      const taskText = (taskCounts.results ?? []).map((item) => `${item.status}: ${item.n}`).join(", ") || "none";
      await reply(env, message, `Nyamal status\nAI providers: ${(providers.results ?? []).map((item) => item.name).join(", ") || "none"}\nTasks: ${taskText}`);
    } else if (name === "/tasks") {
      const tasks = await env.NYAMAL_DB.prepare("SELECT id,name,status FROM tasks ORDER BY created_at DESC LIMIT 8")
        .all<{ id: string; name: string; status: string }>();
      await reply(env, message, (tasks.results ?? []).length
        ? "Recent tasks:\n" + tasks.results!.map((item) => `• ${item.name} — ${item.status} (${item.id.slice(0, 8)})`).join("\n")
        : "No autonomous tasks have been created yet.");
    } else if (name === "/pauseengine" || name === "/resumeengine") {
      await env.NYAMAL_DB.prepare(
        `INSERT INTO engine_settings(key,value) VALUES('paused',?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`,
      ).bind(name === "/pauseengine" ? "true" : "false").run();
      await reply(env, message, name === "/pauseengine"
        ? "Autonomous task execution is paused. Nyamal's chat remains available."
        : "Autonomous task execution has resumed.");
    } else {
      const taskId = argument;
      if (!taskId) await reply(env, message, `Usage: ${name} <task_id>`);
      else {
        const approved = name === "/approve";
        const updated = await env.NYAMAL_DB.prepare(
          "UPDATE tasks SET status=?,next_execution_at=CURRENT_TIMESTAMP WHERE id=? AND status='Awaiting Approval'",
        ).bind(approved ? "Pending" : "Cancelled", taskId).run();
        await reply(env, message, updated.meta.changes
          ? (approved ? "Task approved and queued." : "Task rejected.")
          : "Task not found or not awaiting approval.");
      }
    }
  } else {
    return false;
  }
  return true;
}

export async function handleTelegramWebhook(
  request: Request,
  env: Env,
  context?: ExecutionContextLike,
): Promise<Response> {
  const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!constantTimeEqual(supplied, env.WEBHOOK_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const update = (await request.json()) as TelegramUpdate;
  if (!Number.isSafeInteger(update.update_id)) return new Response("Bad update", { status: 400 });
  const inserted = await env.NYAMAL_DB.prepare("INSERT OR IGNORE INTO telegram_updates(update_id) VALUES(?)")
    .bind(update.update_id).run();
  if (!inserted.meta.changes) return Response.json({ ok: true });

  let replyReservation: string | null = null;
  try {
    const settings = await getCommunitySettings(env);
    const memberUpdate = update.my_chat_member;
    if (memberUpdate
      && ["member", "administrator"].includes(memberUpdate.new_chat_member.status)
      && ["left", "kicked", "restricted"].includes(memberUpdate.old_chat_member.status)) {
      await botWelcome(env, memberUpdate.chat.id, update.update_id);
      return Response.json({ ok: true });
    }

    if (update.chat_member || update.chat_join_request || update.message?.new_chat_members?.length) {
      await handleTelegramJoinEvents(env, update, context);
      if (update.chat_member || update.chat_join_request) return Response.json({ ok: true });
    }

    const message = update.message;
    if (!message) return Response.json({ ok: true });
    const text = (message.text ?? message.caption ?? "").trim();
    const hasImage = Boolean(message.photo?.length);
    if (!message.from || message.from.is_bot || (!text && !hasImage)) return Response.json({ ok: true });
    const userId = message.from.id;

    if (!(await isOwner(env, userId))) {
      const analysis = classifyCommunityText(text, settings);
      if (analysis.risk !== "safe") {
        const incident = await recordCommunityIncident(env, {
          sourceKey: `telegram:${update.update_id}:link`,
          platform: "telegram",
          kind: "moderation",
          risk: analysis.risk,
          reason: analysis.reason,
          messageText: text,
          senderId: String(userId),
          communityId: String(message.chat.id),
          messageId: String(message.message_id),
        });
        if (incident.inserted) {
          const canDelete = analysis.risk === "confirmed_malicious"
            && settings.autonomy_level >= 4
            && settings.auto_delete_blocked_telegram_links;
          if (canDelete) {
            try {
              await deleteTelegramMessage(env, String(message.chat.id), String(message.message_id));
              await env.NYAMAL_DB.prepare(
                `UPDATE community_incidents SET status='deleted',action='message_deleted',
                 updated_at=CURRENT_TIMESTAMP WHERE id=?`,
              ).bind(incident.id).run();
              await recordCommunityActivity(env, {
                eventKey: `telegram:${update.update_id}:blocked-link-deleted`,
                platform: "telegram",
                eventType: "moderation_deleted",
                actorId: String(userId),
                remoteId: String(message.message_id),
                details: analysis.reason,
              });
            } catch (error) {
              const detail = error instanceof Error ? error.message : "Telegram deletion failed";
              await env.NYAMAL_DB.prepare(
                `UPDATE community_incidents SET status='failed',action='delete_failed',last_error=?,
                 updated_at=CURRENT_TIMESTAMP WHERE id=?`,
              ).bind(detail.slice(0, 500), incident.id).run();
              console.error("Could not delete a blocklisted Telegram link", { updateId: update.update_id, error });
            }
          }
          if (settings.notify_admin) {
            try {
              await sendOwnerNotification(env,
                `Nyamal flagged a ${analysis.risk.replaceAll("_", " ")} Telegram message.\n${analysis.reason}\nReview it in the Community Manager.`);
            } catch (error) {
              console.error("Could not notify the owner about a Telegram moderation incident", { updateId: update.update_id, error });
            }
          }
        }
        return Response.json({ ok: true });
      }
    }

    if (requiresHumanReview(text)) {
      const incident = await recordCommunityIncident(env, {
        sourceKey: `telegram:${update.update_id}:sensitive`,
        platform: "telegram",
        kind: "escalation",
        risk: "sensitive",
        reason: "The message may need a human response; Nyamal did not generate or publish an answer.",
        messageText: text,
        senderId: String(userId),
        communityId: String(message.chat.id),
        messageId: String(message.message_id),
      });
      if (incident.inserted && settings.notify_admin) {
        try {
          await sendOwnerNotification(env, "A Telegram community message needs human attention. Review it in the Community Manager.");
        } catch (error) {
          console.error("Could not notify the owner about a Telegram escalation", { updateId: update.update_id, error });
        }
      }
      return Response.json({ ok: true });
    }

    const isAddressed = await addressedToBot(env, message);
    const isCommand = text.startsWith("/");
    if (isCommand && (message.chat.type === "private" || isAddressed)) {
      if (await command(env, message, userId, text)) return Response.json({ ok: true });
      if (/^\/[a-z]+/i.test(text)) {
        await reply(env, message, "I don't recognize that command. Try /help.");
        return Response.json({ ok: true });
      }
    }
    if (!isAddressed || (message.chat.type !== "private" && settings.telegram_group_replies === "disabled")) {
      return Response.json({ ok: true });
    }
    const images = hasImage ? [await telegramPhotoAsAiImage(env, message)] : [];
    const prompt = text || "Please describe the attached image.";
    const needsApproval = settings.autonomy_level < 2
      || (message.chat.type !== "private" && settings.autonomy_level < 3);
    if (needsApproval) {
      let answer: string;
      try {
        answer = await generateReply(env, userId, prompt, "chat", {
          persist: false,
          systemContext: communitySystemContext(settings),
          images,
        });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("No enabled model")) throw error;
        answer = "I’m not connected to an AI model yet. Please ask the administrator to configure one in the dashboard.";
      }
      const incident = await recordCommunityIncident(env, {
        sourceKey: `telegram:${update.update_id}:response`,
        platform: "telegram",
        kind: "response",
        risk: "safe",
        reason: settings.autonomy_level === 1
          ? "Autonomy Level 1 requires review before any reply."
          : "Autonomy Level 2 requires review before Telegram group replies.",
        messageText: text,
        proposedResponse: answer,
        senderId: String(userId),
        communityId: String(message.chat.id),
        messageId: String(message.message_id),
      });
      if (incident.inserted && settings.notify_admin) {
        try {
          await sendOwnerNotification(env, "A Telegram response draft is waiting for approval in the Community Manager.");
        } catch (error) {
          console.error("Could not notify the owner about a Telegram response draft", { updateId: update.update_id, error });
        }
      }
      return Response.json({ ok: true });
    }
    const responseEventKey = `telegram:${update.update_id}:response`;
    if (!await reserveAutoReply(env, settings, "telegram", String(userId), responseEventKey)) {
      await recordCommunityActivity(env, {
        eventKey: `telegram:${update.update_id}:reply-throttled`,
        platform: "telegram",
        eventType: "response_throttled",
        actorId: String(userId),
        remoteId: String(message.message_id),
      });
      return Response.json({ ok: true });
    }
    replyReservation = responseEventKey;

    const firstContact = message.chat.type === "private"
      ? !await env.NYAMAL_DB.prepare(
        "SELECT 1 FROM messages WHERE user_id=? LIMIT 1",
      ).bind(userId).first()
      : false;
    let answer: string;
    try {
      answer = await generateReply(env, userId, prompt, "chat", {
        systemContext: communitySystemContext(settings),
        images,
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("No enabled model")) throw error;
      answer = "I’m not connected to an AI model yet. Please ask the administrator to configure one in the dashboard.";
    }
    const responseText = firstContact && settings.welcome_enabled
      ? `${welcomeText(settings, message.from.first_name)}\n\n${answer}`
      : answer;
    await reply(
      env,
      message,
      responseText,
    );
    await finishAutoReply(env, responseEventKey, true);
    replyReservation = null;
    if (firstContact && settings.welcome_enabled) {
      await recordCommunityActivity(env, {
        eventKey: `telegram:${update.update_id}:private-welcome`,
        platform: "telegram",
        eventType: "member_welcomed",
        actorId: String(userId),
        remoteId: String(message.chat.id),
      });
    }
  } catch (error) {
    console.error("Telegram update failed", { updateId: update.update_id, error });
    if (replyReservation) {
      try {
        await finishAutoReply(env, replyReservation, false);
      } catch (reservationError) {
        console.error("Could not release a failed Telegram reply reservation", { updateId: update.update_id, error: reservationError });
      }
    }
    await env.NYAMAL_DB.prepare("DELETE FROM telegram_updates WHERE update_id=?").bind(update.update_id).run();
    throw error;
  }
  return Response.json({ ok: true });
}
