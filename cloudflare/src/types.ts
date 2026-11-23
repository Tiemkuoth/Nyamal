export interface Env {
  NYAMAL_DB: D1Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  NYAMAL_ADMIN_USERNAME?: string;
  NYAMAL_ADMIN_PASSWORD?: string;
  NYAMAL_SESSION_SECRET?: string;
  RESEND_API_KEY?: string;
  NYAMAL_EMAIL_FROM?: string;
  NYAMAL_OWNER_TELEGRAM_ID?: string;
  NYAMAL_ENCRYPTION_KEY?: string;
  NYAMAL_TIMEZONE?: string;
  NYAMAL_DAILY_REPORT_TIME?: string;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; width: number; height: number; file_size?: number }>;
  entities?: Array<{ type: string; offset: number; length: number }>;
  from?: TelegramUser;
  chat: { id: number; type: string };
  reply_to_message?: TelegramMessage;
  new_chat_members?: TelegramUser[];
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  chat_member?: {
    chat: { id: number; type: string };
    from: TelegramUser;
    date: number;
    old_chat_member: { status: string; is_member?: boolean; user: TelegramUser };
    new_chat_member: { status: string; is_member?: boolean; user: TelegramUser };
    invite_link?: { invite_link: string; creator?: TelegramUser };
    via_join_request?: boolean;
    via_chat_folder_invite_link?: boolean;
  };
  chat_join_request?: {
    chat: { id: number; type: string };
    from: TelegramUser;
    user_chat_id: number;
    date: number;
    bio?: string;
    invite_link?: { invite_link: string; creator?: TelegramUser };
  };
  my_chat_member?: {
    chat: { id: number; type: string };
    from: TelegramUser;
    old_chat_member: { status: string };
    new_chat_member: { status: string; user: TelegramUser };
  };
}

export interface AiHistoryItem {
  role: "user" | "assistant";
  content: string;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}
