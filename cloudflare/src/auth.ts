import { constantTimeEqual } from "./crypto";
import { HttpError, json, readJson, requiredString } from "./http";
import type { Env } from "./types";

const COOKIE_NAME = "nyamal_session";
const SESSION_SECONDS = 8 * 60 * 60;
const EMAIL_TOKEN_SECONDS = 30 * 60;
const MIN_PASSWORD_LENGTH = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface SessionPayload {
  username: string;
  expiresAt: number;
  sessionVersion: number;
  nonce: string;
}

interface AdminAuthRecord {
  password_hash: string;
  password_salt: string;
  email: string | null;
  email_verified_at: string | null;
  session_version: number;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function copyToArrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

function getSessionSecret(env: Env): string {
  const secret = env.NYAMAL_SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new HttpError(503, "Dashboard session secret is not configured");
  }
  return secret;
}

async function signature(env: Env, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(getSessionSecret(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return encodeBase64Url(new Uint8Array(digest));
}

function sessionCookie(value: string, maxAge: number): string {
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function cookieValue(request: Request): string | undefined {
  const header = request.headers.get("Cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE_NAME) return value.join("=");
  }
  return undefined;
}

async function passwordHash(env: Env, salt: string, password: string): Promise<string> {
  const encryptionKey = env.NYAMAL_ENCRYPTION_KEY?.trim();
  if (!encryptionKey) {
    throw new HttpError(503, "Dashboard password key is not configured");
  }
  const rawKey = decodeBase64Url(encryptionKey);
  if (rawKey.byteLength !== 32) {
    throw new HttpError(503, "NYAMAL_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  const masterKey = await crypto.subtle.importKey(
    "raw",
    copyToArrayBuffer(rawKey),
    "HKDF",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("nyamal-dashboard-auth-v1"),
      info: encoder.encode("password-verifier"),
    },
    masterKey,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`nyamal-admin-password-v1\u0000${salt}\u0000${password}`),
  );
  return encodeHex(new Uint8Array(digest));
}

async function getAuthRecord(env: Env, initialize = false): Promise<AdminAuthRecord | null> {
  let record = await env.NYAMAL_DB.prepare(
    "SELECT password_hash,password_salt,email,email_verified_at,session_version FROM admin_auth WHERE id=1",
  ).first<AdminAuthRecord>();
  if (record || !initialize) return record;

  const password = env.NYAMAL_ADMIN_PASSWORD;
  if (!password || password.length < 16 || password.length > 256) {
    throw new HttpError(503, "Dashboard bootstrap password is not configured correctly");
  }
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = encodeBase64Url(saltBytes);
  const hash = await passwordHash(env, salt, password);
  await env.NYAMAL_DB.prepare(
    `INSERT OR IGNORE INTO admin_auth(id,password_hash,password_salt)
     VALUES(1,?,?)`,
  ).bind(hash, salt).run();
  record = await env.NYAMAL_DB.prepare(
    "SELECT password_hash,password_salt,email,email_verified_at,session_version FROM admin_auth WHERE id=1",
  ).first<AdminAuthRecord>();
  if (!record) throw new Error("Could not initialize dashboard credentials");
  return record;
}

async function issueSession(
  env: Env,
  username: string,
  sessionVersion: number,
  response: Response,
): Promise<Response> {
  const payload: SessionPayload = {
    username,
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
    sessionVersion,
    nonce: crypto.randomUUID(),
  };
  const encoded = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
  response.headers.append("Set-Cookie", sessionCookie(`${encoded}.${await signature(env, encoded)}`, SESSION_SECONDS));
  return response;
}

async function readSession(request: Request, env: Env): Promise<SessionPayload | null> {
  const cookie = cookieValue(request);
  if (!cookie) return null;
  const separator = cookie.lastIndexOf(".");
  if (separator <= 0) return null;
  const encoded = cookie.slice(0, separator);
  const suppliedSignature = cookie.slice(separator + 1);
  if (!suppliedSignature || !constantTimeEqual(await signature(env, encoded), suppliedSignature)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(decoder.decode(decodeBase64Url(encoded))) as SessionPayload;
  } catch {
    return null;
  }
  if (
    payload.username !== env.NYAMAL_ADMIN_USERNAME
    || !Number.isSafeInteger(payload.expiresAt)
    || payload.expiresAt <= Math.floor(Date.now() / 1000)
    || !Number.isSafeInteger(payload.sessionVersion)
    || typeof payload.nonce !== "string"
  ) {
    return null;
  }
  const current = await env.NYAMAL_DB.prepare(
    "SELECT session_version FROM admin_auth WHERE id=1",
  ).first<{ session_version: number }>();
  return current?.session_version === payload.sessionVersion ? payload : null;
}

async function requestIpHash(request: Request): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(ip)));
  return encodeHex(digest);
}

function requireSameOrigin(request: Request): void {
  if (request.headers.get("Origin") !== new URL(request.url).origin) {
    throw new HttpError(403, "Request origin was not accepted");
  }
}

async function limitAuthKey(
  env: Env,
  action: string,
  subjectHash: string,
  maximum: number,
): Promise<void> {
  await env.NYAMAL_DB.prepare(
    `INSERT INTO admin_auth_attempts(action,subject_hash,attempts,window_started_at)
     VALUES(?,?,1,CURRENT_TIMESTAMP)
     ON CONFLICT(action,subject_hash) DO UPDATE SET
       attempts=CASE WHEN window_started_at < datetime('now','-15 minutes') THEN 1 ELSE attempts+1 END,
       window_started_at=CASE WHEN window_started_at < datetime('now','-15 minutes')
         THEN CURRENT_TIMESTAMP ELSE window_started_at END`,
  ).bind(action, subjectHash).run();
  const attempt = await env.NYAMAL_DB.prepare(
    "SELECT attempts FROM admin_auth_attempts WHERE action=? AND subject_hash=?",
  ).bind(action, subjectHash).first<{ attempts: number }>();
  if ((attempt?.attempts ?? 0) > maximum) {
    throw new HttpError(429, "Too many requests. Try again in 15 minutes.");
  }
}

async function limitAuthAction(
  request: Request,
  env: Env,
  action: string,
  maximum: number,
): Promise<void> {
  await limitAuthKey(env, action, await requestIpHash(request), maximum);
}

async function limitEmailAction(env: Env, action: string, email: string): Promise<void> {
  const subjectHash = await signature(env, `email-limit:${action}:${email}`);
  await limitAuthKey(env, action, subjectHash, 3);
}

function validateNewPassword(value: unknown): string {
  if (typeof value !== "string" || value.length < MIN_PASSWORD_LENGTH || value.length > 256) {
    throw new HttpError(400, `New password must be ${MIN_PASSWORD_LENGTH}..256 characters`);
  }
  return value;
}

function emailValue(value: unknown): string {
  const email = requiredString(value, "email", 3, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "Enter a valid email address");
  }
  return email;
}

function requireEmailDelivery(env: Env): { apiKey: string; from: string } {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.NYAMAL_EMAIL_FROM?.trim();
  if (!apiKey || !from) {
    throw new HttpError(503, "Email recovery is not configured. Configure the Resend API key and sender address.");
  }
  return { apiKey, from };
}

async function sendEmail(
  env: Env,
  to: string,
  subject: string,
  intro: string,
  link: string,
): Promise<void> {
  const { apiKey, from } = requireEmailDelivery(env);
  const safeLink = link.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text: `${intro}\n\n${link}\n\nThis link expires in 30 minutes. If you did not request this, you can ignore this message.`,
        html: `<p>${intro}</p><p><a href="${safeLink}">Continue securely</a></p><p>This link expires in 30 minutes. If you did not request this, you can ignore this message.</p>`,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    console.error("Email provider request failed", error);
    throw new HttpError(503, "Email delivery is unavailable. Please try again later.");
  }
  if (!response.ok) {
    console.error("Resend rejected an authentication email", response.status);
    throw new HttpError(503, "Email delivery is unavailable. Check the Resend sender configuration and try again.");
  }
}

async function createEmailToken(
  env: Env,
  purpose: "verify_email" | "password_reset",
  email: string,
): Promise<string> {
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = encodeBase64Url(tokenBytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
  const tokenHash = encodeHex(digest);
  await env.NYAMAL_DB.prepare(
    "DELETE FROM admin_auth_email_tokens WHERE purpose=? AND consumed_at IS NULL",
  ).bind(purpose).run();
  await env.NYAMAL_DB.prepare(
    `INSERT INTO admin_auth_email_tokens(token_hash,purpose,email,expires_at)
     VALUES(?,?,?,datetime('now','+30 minutes'))`,
  ).bind(tokenHash, purpose, email).run();
  return token;
}

async function tokenHash(token: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(400, "This link is invalid or has expired");
  return encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token))));
}

function actionLink(request: Request, action: "reset" | "verify", token: string): string {
  const link = new URL("/dashboard", request.url);
  link.hash = `${action}=${token}`;
  return link.toString();
}

async function login(request: Request, env: Env): Promise<Response> {
  const username = env.NYAMAL_ADMIN_USERNAME?.trim();
  if (!username) throw new HttpError(503, "Dashboard username is not configured");
  const body = await readJson(request);
  const suppliedUsername = requiredString(body.username, "username", 1, 120);
  if (typeof body.password !== "string" || body.password.length < 1 || body.password.length > 256) {
    throw new HttpError(400, "password must be a string of 1..256 characters");
  }

  const ipHash = await requestIpHash(request);
  await env.NYAMAL_DB.prepare(
    `INSERT INTO admin_login_attempts(ip_hash,attempts,window_started_at)
     VALUES(?,1,CURRENT_TIMESTAMP)
     ON CONFLICT(ip_hash) DO UPDATE SET
       attempts=CASE WHEN window_started_at < datetime('now','-15 minutes') THEN 1 ELSE attempts+1 END,
       window_started_at=CASE WHEN window_started_at < datetime('now','-15 minutes')
         THEN CURRENT_TIMESTAMP ELSE window_started_at END`,
  ).bind(ipHash).run();
  const attempt = await env.NYAMAL_DB.prepare(
    "SELECT attempts FROM admin_login_attempts WHERE ip_hash=?",
  ).bind(ipHash).first<{ attempts: number }>();
  if ((attempt?.attempts ?? 0) > 8) throw new HttpError(429, "Too many sign-in attempts. Try again in 15 minutes.");

  const record = await getAuthRecord(env, true);
  if (!record) throw new HttpError(503, "Dashboard password is not configured");
  const usernameMatches = constantTimeEqual(suppliedUsername, username);
  const passwordMatches = constantTimeEqual(await passwordHash(env, record.password_salt, body.password), record.password_hash);
  if (!usernameMatches || !passwordMatches) throw new HttpError(401, "Incorrect username or password");
  await env.NYAMAL_DB.prepare("DELETE FROM admin_login_attempts WHERE ip_hash=?").bind(ipHash).run();
  return issueSession(env, username, record.session_version, json({ ok: true, username }));
}

function logout(request: Request): Response {
  requireSameOrigin(request);
  const response = json({ ok: true });
  response.headers.append("Set-Cookie", sessionCookie("", 0));
  return response;
}

async function changePassword(request: Request, env: Env): Promise<Response> {
  await authorizeAdmin(request, env);
  await limitAuthAction(request, env, "password_change", 5);
  const body = await readJson(request);
  if (typeof body.current_password !== "string" || body.current_password.length > 256) {
    throw new HttpError(400, "Enter your current password");
  }
  const nextPassword = validateNewPassword(body.new_password);
  const record = await getAuthRecord(env);
  if (!record || !constantTimeEqual(
    await passwordHash(env, record.password_salt, body.current_password),
    record.password_hash,
  )) {
    throw new HttpError(401, "Current password is incorrect");
  }
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = encodeBase64Url(saltBytes);
  const hash = await passwordHash(env, salt, nextPassword);
  const updated = await env.NYAMAL_DB.prepare(
    `UPDATE admin_auth SET password_hash=?,password_salt=?,session_version=session_version+1,
       updated_at=CURRENT_TIMESTAMP WHERE id=1 AND session_version=?`,
  ).bind(hash, salt, record.session_version).run();
  if (!updated.meta.changes) throw new HttpError(409, "Account changed during this request. Sign in again.");
  await env.NYAMAL_DB.prepare(
    "UPDATE admin_auth_email_tokens SET consumed_at=CURRENT_TIMESTAMP WHERE consumed_at IS NULL",
  ).run();
  return issueSession(
    env,
    env.NYAMAL_ADMIN_USERNAME?.trim() ?? "",
    record.session_version + 1,
    json({ ok: true }),
  );
}

async function accountInfo(request: Request, env: Env): Promise<Response> {
  await authorizeAdmin(request, env);
  const record = await getAuthRecord(env);
  if (!record) throw new HttpError(503, "Dashboard password is not configured");
  return json({
    email: record.email,
    email_verified: Boolean(record.email_verified_at),
    email_delivery_configured: Boolean(env.RESEND_API_KEY?.trim() && env.NYAMAL_EMAIL_FROM?.trim()),
    minimum_password_length: MIN_PASSWORD_LENGTH,
  });
}

async function setRecoveryEmail(request: Request, env: Env): Promise<Response> {
  await authorizeAdmin(request, env);
  requireEmailDelivery(env);
  await limitAuthAction(request, env, "email_verification", 5);
  const body = await readJson(request);
  const email = emailValue(body.email);
  await limitEmailAction(env, "email_verification_address", email);
  const record = await getAuthRecord(env);
  if (!record) throw new HttpError(503, "Dashboard account is not initialized");
  if (record.email === email && record.email_verified_at) {
    return json({ ok: true, email, email_verified: true });
  }
  await env.NYAMAL_DB.prepare(
    `UPDATE admin_auth SET email=?,email_verified_at=NULL,updated_at=CURRENT_TIMESTAMP
     WHERE id=1`,
  ).bind(email).run();
  const token = await createEmailToken(env, "verify_email", email);
  await sendEmail(
    env,
    email,
    "Verify your Nyamal dashboard email",
    "Use this link to verify the email address for dashboard password recovery.",
    actionLink(request, "verify", token),
  );
  return json({ ok: true, email, email_verified: false });
}

async function verifyRecoveryEmail(request: Request, env: Env): Promise<Response> {
  requireSameOrigin(request);
  const body = await readJson(request);
  const hash = await tokenHash(requiredString(body.token, "token", 43, 43));
  const token = await env.NYAMAL_DB.prepare(
    `SELECT email FROM admin_auth_email_tokens
     WHERE token_hash=? AND purpose='verify_email' AND consumed_at IS NULL
       AND expires_at>CURRENT_TIMESTAMP`,
  ).bind(hash).first<{ email: string }>();
  if (!token) throw new HttpError(400, "This verification link is invalid or has expired");
  const claimed = await env.NYAMAL_DB.prepare(
    `UPDATE admin_auth_email_tokens SET consumed_at=CURRENT_TIMESTAMP
     WHERE token_hash=? AND purpose='verify_email' AND consumed_at IS NULL
       AND expires_at>CURRENT_TIMESTAMP`,
  ).bind(hash).run();
  if (!claimed.meta.changes) throw new HttpError(400, "This verification link is invalid or has expired");
  const updated = await env.NYAMAL_DB.prepare(
    `UPDATE admin_auth SET email_verified_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
     WHERE id=1 AND email=? AND email_verified_at IS NULL`,
  ).bind(token.email).run();
  if (!updated.meta.changes) throw new HttpError(400, "This verification link is no longer valid");
  return json({ ok: true });
}

async function requestPasswordReset(request: Request, env: Env): Promise<Response> {
  requireSameOrigin(request);
  requireEmailDelivery(env);
  await limitAuthAction(request, env, "password_reset", 5);
  const body = await readJson(request);
  const email = emailValue(body.email);
  await limitEmailAction(env, "password_reset_address", email);
  const record = await env.NYAMAL_DB.prepare(
    "SELECT email FROM admin_auth WHERE id=1 AND email=? AND email_verified_at IS NOT NULL",
  ).bind(email).first<{ email: string }>();
  if (record) {
    const token = await createEmailToken(env, "password_reset", email);
    await sendEmail(
      env,
      email,
      "Reset your Nyamal dashboard password",
      "Use this link to choose a new password for your dashboard account.",
      actionLink(request, "reset", token),
    );
  }
  return json({ ok: true, message: "If that verified email is registered, a password reset link will be sent." });
}

async function resetPassword(request: Request, env: Env): Promise<Response> {
  requireSameOrigin(request);
  const body = await readJson(request);
  const hash = await tokenHash(requiredString(body.token, "token", 43, 43));
  const nextPassword = validateNewPassword(body.new_password);
  const token = await env.NYAMAL_DB.prepare(
    `SELECT email FROM admin_auth_email_tokens
     WHERE token_hash=? AND purpose='password_reset' AND consumed_at IS NULL
       AND expires_at>CURRENT_TIMESTAMP`,
  ).bind(hash).first<{ email: string }>();
  if (!token) throw new HttpError(400, "This reset link is invalid or has expired");
  const claimed = await env.NYAMAL_DB.prepare(
    `UPDATE admin_auth_email_tokens SET consumed_at=CURRENT_TIMESTAMP
     WHERE token_hash=? AND purpose='password_reset' AND consumed_at IS NULL
       AND expires_at>CURRENT_TIMESTAMP`,
  ).bind(hash).run();
  if (!claimed.meta.changes) throw new HttpError(400, "This reset link is invalid or has expired");

  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = encodeBase64Url(saltBytes);
  const password = await passwordHash(env, salt, nextPassword);
  const updated = await env.NYAMAL_DB.prepare(
    `UPDATE admin_auth SET password_hash=?,password_salt=?,session_version=session_version+1,
       updated_at=CURRENT_TIMESTAMP
     WHERE id=1 AND email=? AND email_verified_at IS NOT NULL`,
  ).bind(password, salt, token.email).run();
  if (!updated.meta.changes) throw new HttpError(400, "This reset link is no longer valid");
  await env.NYAMAL_DB.prepare(
    "UPDATE admin_auth_email_tokens SET consumed_at=CURRENT_TIMESTAMP WHERE consumed_at IS NULL",
  ).run();
  return json({ ok: true });
}

export async function authorizeAdmin(request: Request, env: Env): Promise<void> {
  const session = await readSession(request, env);
  if (!session) throw new HttpError(401, "Sign in to the dashboard");
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) requireSameOrigin(request);
}

export async function handleAuth(request: Request, env: Env, path: string): Promise<Response> {
  if (path === "/auth/login" && request.method === "POST") return login(request, env);
  if (path === "/auth/logout" && request.method === "POST") return logout(request);
  if (path === "/auth/session" && request.method === "GET") {
    const session = await readSession(request, env);
    if (!session) return json({ ok: false });
    return json({ ok: true, username: session.username, expires_at: session.expiresAt });
  }
  if (path === "/auth/account" && request.method === "GET") return accountInfo(request, env);
  if (path === "/auth/password" && request.method === "POST") return changePassword(request, env);
  if (path === "/auth/email" && request.method === "POST") return setRecoveryEmail(request, env);
  if (path === "/auth/email/verify" && request.method === "POST") return verifyRecoveryEmail(request, env);
  if (path === "/auth/forgot-password" && request.method === "POST") return requestPasswordReset(request, env);
  if (path === "/auth/reset-password" && request.method === "POST") return resetPassword(request, env);
  throw new HttpError(404, "Authentication route not found");
}
