import { handleAdmin } from "./admin";
import { handleAuth } from "./auth";
import { errorResponse, json } from "./http";
import { publishApprovedContent } from "./publisher";
import { handleTelegramWebhook, processTelegramWelcomeQueue, sendOwnerNotification } from "./telegram";
import { handleSocialWebhook, processPendingIncoming } from "./social-inbox";
import type { Env } from "./types";

function nextScheduledTime(scheduleType: string, scheduleValue: string, now = new Date()):
  string | null {
  if (scheduleType === "once") return null;
  if (scheduleType === "interval") {
    const seconds = Number(scheduleValue);
    if (!Number.isFinite(seconds) || seconds < 60) return null;
    return new Date(now.getTime() + seconds * 1000).toISOString();
  }
  const parts = scheduleValue.match(/^(\d{1,2}):(\d{2})$/);
  if (scheduleType === "daily" && parts) {
    const candidate = new Date(now);
    candidate.setUTCHours(Number(parts[1]), Number(parts[2]), 0, 0);
    if (candidate <= now) candidate.setUTCDate(candidate.getUTCDate() + 1);
    return candidate.toISOString();
  }
  return null;
}

async function runScheduled(env: Env): Promise<void> {
  await processPendingIncoming(env, undefined, 3);
  try {
    await processTelegramWelcomeQueue(env, 10);
  } catch (error) {
    console.error("Could not process the persistent Telegram welcome queue", error);
  }
  const paused = await env.NYAMAL_DB.prepare(
    "SELECT value FROM engine_settings WHERE key='paused'",
  ).first<{ value: string }>();
  if (paused?.value === "true") return;

  const now = new Date();
  const timezone = env.NYAMAL_TIMEZONE ?? "UTC";
  const localParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const local = Object.fromEntries(localParts.map((part) => [part.type, part.value]));
  const localDate = `${local.year}-${local.month}-${local.day}`;
  if (`${local.hour}:${local.minute}` === (env.NYAMAL_DAILY_REPORT_TIME ?? "20:00")) {
    await env.NYAMAL_DB.prepare(
      `INSERT OR IGNORE INTO tasks(id,idempotency_key,name,task_type,priority,status,timezone,next_execution_at)
       VALUES(?,?,?,'reports.daily',8,'Pending',?,CURRENT_TIMESTAMP)`,
    ).bind(
      crypto.randomUUID(),
      `nyamal-daily-report-${localDate}`,
      "Nyamal daily operations report",
      timezone,
    ).run();
  }

  const limit = 3;
  for (let count = 0; count < limit; count++) {
    const task = await env.NYAMAL_DB.prepare(
      `SELECT id,task_type,payload_json,schedule_type,schedule_value,timezone FROM tasks
       WHERE enabled=1 AND status IN ('Pending','Scheduled')
         AND (next_execution_at IS NULL OR julianday(next_execution_at)<=julianday('now'))
       ORDER BY priority,created_at LIMIT 1`,
    ).first<{ id: string; task_type: string; payload_json: string; schedule_type: string; schedule_value: string; timezone: string }>();
    if (!task) return;
    const claimed = await env.NYAMAL_DB.prepare(
      "UPDATE tasks SET status='Running',locked_until=datetime('now','+2 minutes'),locked_by='cloudflare-cron' WHERE id=? AND status IN ('Pending','Scheduled')",
    ).bind(task.id).run();
    if (!claimed.meta.changes) continue;

    try {
      if (task.task_type === "reports.daily") {
        const date = localDate;
        const [tasks, content, usage] = await Promise.all([
          env.NYAMAL_DB.prepare("SELECT status,COUNT(*) count FROM tasks GROUP BY status").all(),
          env.NYAMAL_DB.prepare("SELECT status,COUNT(*) count FROM content_items GROUP BY status").all(),
          env.NYAMAL_DB.prepare("SELECT COUNT(*) requests,COALESCE(SUM(success),0) successes FROM ai_usage_logs WHERE date(created_at)=date('now')").first(),
        ]);
        const report = JSON.stringify({ tasks: tasks.results ?? [], content: content.results ?? [], ai_usage_today: usage });
        await env.NYAMAL_DB.prepare(
          "INSERT INTO daily_reports(report_date,report_json) VALUES(?,?) ON CONFLICT(report_date) DO UPDATE SET report_json=excluded.report_json",
        ).bind(date, report).run();
        const nextRun = nextScheduledTime(task.schedule_type, task.schedule_value);
        await env.NYAMAL_DB.prepare(
          `UPDATE tasks SET status=?,result=?,next_execution_at=?,retry_count=0,
           last_execution_at=CURRENT_TIMESTAMP,locked_until=NULL,locked_by=NULL WHERE id=?`,
        ).bind(nextRun ? "Scheduled" : "Completed", report.slice(0, 1000), nextRun, task.id).run();
        try {
          await sendOwnerNotification(env, `Nyamal daily report (${date})\n\n${report}`);
        } catch (error) {
          console.error("Could not send daily report to the owner", error);
        }
      } else if (task.task_type === "content.publish") {
        const payload = JSON.parse(task.payload_json) as { content_id?: string };
        if (!payload.content_id) throw new Error("content.publish task is missing content_id");
        await publishApprovedContent(env, payload.content_id);
        const nextRun = nextScheduledTime(task.schedule_type, task.schedule_value);
        await env.NYAMAL_DB.prepare(
          `UPDATE tasks SET status=?,next_execution_at=?,retry_count=0,
           last_execution_at=CURRENT_TIMESTAMP,locked_until=NULL,locked_by=NULL WHERE id=?`,
        ).bind(nextRun ? "Scheduled" : "Completed", nextRun, task.id).run();
      } else {
        const error = `Unsupported scheduled task type: ${task.task_type}`;
        await env.NYAMAL_DB.prepare(
          "UPDATE tasks SET status='Failed',error_details=?,last_execution_at=CURRENT_TIMESTAMP,locked_until=NULL,locked_by=NULL WHERE id=?",
        ).bind(error, task.id).run();
        await env.NYAMAL_DB.prepare(
          "INSERT INTO task_events(task_id,event,details) VALUES(?,'failed',?)",
        ).bind(task.id, error).run();
      }
    } catch (error) {
      console.error("Scheduled task failed", task.id, error);
      let publicationIdPayload: { content_id?: string } | null = null;
      try { publicationIdPayload = JSON.parse(task.payload_json) as { content_id?: string }; } catch {}
      await env.NYAMAL_DB.prepare(
        "UPDATE tasks SET status='Failed',error_details=?,last_execution_at=CURRENT_TIMESTAMP,locked_until=NULL,locked_by=NULL WHERE id=?",
      ).bind(error instanceof Error ? error.message.slice(0, 1000) : "Unknown task error", task.id).run();
      if (publicationIdPayload?.content_id) {
        await env.NYAMAL_DB.prepare(
          `UPDATE content_publications SET status='failed',attempts=attempts+1,
           error_details=?,updated_at=CURRENT_TIMESTAMP
           WHERE content_id=? AND status IN ('queued','approved','scheduled','publishing')`,
        ).bind(error instanceof Error ? error.message.slice(0, 500) : "Unknown publishing error",
          publicationIdPayload.content_id).run();
      }
    }
  }
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") {
        await env.NYAMAL_DB.prepare("SELECT 1").first();
        return json({ service: "nyamal-worker", status: "ok" });
      }
      if (url.pathname === "/profile-photo" && request.method === "GET") {
        const profile = await env.NYAMAL_DB.prepare(
          "SELECT photo_mime,photo_base64 FROM admin_profile WHERE id=1",
        ).first<{ photo_mime: string; photo_base64: string }>();
        if (!profile?.photo_mime || !profile.photo_base64) return new Response("No profile photo", { status: 404 });
        if (!["image/png", "image/jpeg", "image/webp"].includes(profile.photo_mime)) {
          return new Response("Invalid stored profile photo", { status: 404 });
        }
        const binary = atob(profile.photo_base64);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        return new Response(bytes, {
          headers: {
            "Content-Type": profile.photo_mime,
            "Cache-Control": "public, max-age=300",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      if (url.pathname === "/telegram/webhook" && request.method === "POST") {
        return await handleTelegramWebhook(request, env, context);
      }
      const socialWebhook = url.pathname.match(/^\/webhooks\/(facebook|instagram|whatsapp)$/);
      if (socialWebhook) {
        return await handleSocialWebhook(
          request,
          env,
          context,
          socialWebhook[1] as "facebook" | "instagram" | "whatsapp",
        );
      }
      if (url.pathname.startsWith("/v1/")) {
        const apiPath = url.pathname.slice(3);
        if (apiPath.startsWith("/auth/")) return await handleAuth(request, env, apiPath);
        return await handleAdmin(request, env, apiPath);
      }
      const assetUrl = new URL(request.url);
      if (assetUrl.pathname === "/") assetUrl.pathname = "/dashboard.html";
      return await env.ASSETS.fetch(new Request(assetUrl, request));
    } catch (error) {
      return errorResponse(error);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runScheduled(env);
  },
};
