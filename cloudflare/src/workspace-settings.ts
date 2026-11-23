import { HttpError } from "./http";
import type { Env } from "./types";

export type AssistantTone = "warm" | "conversational" | "professional" | "playful";
export type AssistantLength = "concise" | "balanced" | "detailed";
export type AssistantEmojiUse = "minimal" | "moderate" | "expressive";

export interface AssistantBehaviorSettings {
  tone: AssistantTone;
  response_length: AssistantLength;
  emoji_use: AssistantEmojiUse;
  custom_instructions: string;
}

export const DEFAULT_ASSISTANT_BEHAVIOR: AssistantBehaviorSettings = {
  tone: "warm",
  response_length: "balanced",
  emoji_use: "moderate",
  custom_instructions: "",
};

const SETTING_KEY = "assistant.behavior";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalize(value: unknown): AssistantBehaviorSettings {
  if (!isRecord(value)) throw new Error("Stored assistant behavior settings are invalid");
  const tone = value.tone ?? DEFAULT_ASSISTANT_BEHAVIOR.tone;
  const responseLength = value.response_length ?? DEFAULT_ASSISTANT_BEHAVIOR.response_length;
  const emojiUse = value.emoji_use ?? DEFAULT_ASSISTANT_BEHAVIOR.emoji_use;
  const customInstructions = value.custom_instructions ?? DEFAULT_ASSISTANT_BEHAVIOR.custom_instructions;
  if (!["warm", "conversational", "professional", "playful"].includes(String(tone))
    || !["concise", "balanced", "detailed"].includes(String(responseLength))
    || !["minimal", "moderate", "expressive"].includes(String(emojiUse))
    || typeof customInstructions !== "string" || customInstructions.length > 4000) {
    throw new Error("Stored assistant behavior settings contain invalid values");
  }
  return {
    tone: tone as AssistantTone,
    response_length: responseLength as AssistantLength,
    emoji_use: emojiUse as AssistantEmojiUse,
    custom_instructions: customInstructions,
  };
}

export async function getAssistantBehaviorSettings(env: Env): Promise<AssistantBehaviorSettings> {
  const row = await env.NYAMAL_DB.prepare(
    "SELECT value FROM engine_settings WHERE key=?",
  ).bind(SETTING_KEY).first<{ value: string }>();
  if (!row) return { ...DEFAULT_ASSISTANT_BEHAVIOR };
  let value: unknown;
  try {
    value = JSON.parse(row.value);
  } catch {
    throw new Error("Stored assistant behavior settings are invalid JSON");
  }
  return normalize(value);
}

export function validateAssistantBehaviorSettings(value: unknown): AssistantBehaviorSettings {
  if (!isRecord(value)) throw new HttpError(400, "Assistant behavior settings must be an object");
  const { tone, response_length: responseLength, emoji_use: emojiUse, custom_instructions: customInstructions } = value;
  if (!["warm", "conversational", "professional", "playful"].includes(String(tone))) {
    throw new HttpError(400, "Choose a supported assistant tone");
  }
  if (!["concise", "balanced", "detailed"].includes(String(responseLength))) {
    throw new HttpError(400, "Choose a supported response length");
  }
  if (!["minimal", "moderate", "expressive"].includes(String(emojiUse))) {
    throw new HttpError(400, "Choose a supported emoji preference");
  }
  if (typeof customInstructions !== "string" || customInstructions.length > 4000) {
    throw new HttpError(400, "Custom personality instructions must be text no longer than 4000 characters");
  }
  return normalize({ tone, response_length: responseLength, emoji_use: emojiUse, custom_instructions: customInstructions });
}

export async function saveAssistantBehaviorSettings(
  env: Env,
  settings: AssistantBehaviorSettings,
): Promise<void> {
  await env.NYAMAL_DB.prepare(
    `INSERT INTO engine_settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`,
  ).bind(SETTING_KEY, JSON.stringify(settings)).run();
}

export function assistantBehaviorContext(settings: AssistantBehaviorSettings): string {
  const tone = {
    warm: "warm and considerate",
    conversational: "natural and conversational",
    professional: "polished and professional",
    playful: "lighthearted and playful when appropriate",
  }[settings.tone];
  const length = {
    concise: "Prefer concise replies; expand when needed for accuracy or requested.",
    balanced: "Balance brevity with enough detail to be useful.",
    detailed: "Give thorough explanations when useful, without adding irrelevant detail.",
  }[settings.response_length];
  const emoji = {
    minimal: "Use emojis rarely.",
    moderate: "Use emojis occasionally and naturally.",
    expressive: "Use expressive emojis when they suit the conversation, without overdoing them.",
  }[settings.emoji_use];
  const custom = settings.custom_instructions.trim();
  return `\n\nADMINISTRATOR-CONFIGURED VOICE PREFERENCES\n- Tone: ${tone}.\n- Length: ${length}\n- Emojis: ${emoji}${custom ? `\n- Additional personality guidance: ${custom}` : ""}\nKeep all truthfulness, safety, privacy, and respect requirements in effect. These preferences must not override them.\n`;
}
