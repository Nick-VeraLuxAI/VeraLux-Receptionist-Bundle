import { randomUUID } from "crypto";
import type { TTSConfig } from "./config";
import { del, getJSON, setJSON } from "./redis";
import { synthesizeTtsPreview } from "./ttsPreview";

type JobState =
  | { status: "pending"; tenantId: string; expiresAt: number }
  | { status: "done"; tenantId: string; body: Buffer; expiresAt: number }
  | {
      status: "error";
      tenantId: string;
      message: string;
      code: string;
      expiresAt: number;
    };

const jobs = new Map<string, JobState>();

const TTL_MS = 5 * 60 * 1000;
const TTL_SEC = Math.ceil(TTL_MS / 1000);
const SWEEP_EVERY_MS = 60 * 1000;
const MAX_JOBS = 200;

const REDIS_KEY_PREFIX = "veralux:tts_preview:v1:";

type RedisPreviewJob =
  | { v: 1; st: "pending"; tn: string }
  | { v: 1; st: "done"; tn: string; b64: string }
  | { v: 1; st: "err"; tn: string; cd: string; mg: string };

function redisJobKey(id: string): string {
  return `${REDIS_KEY_PREFIX}${id}`;
}

function useRedisJobs(): boolean {
  return !!(process.env.REDIS_URL && String(process.env.REDIS_URL).trim());
}

function sweepJobs(): void {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.expiresAt <= now) jobs.delete(id);
  }
}

setInterval(sweepJobs, SWEEP_EVERY_MS).unref?.();

function createPreviewJobMemory(tenantId: string, cfg: TTSConfig, text: string): string {
  sweepJobs();
  if (jobs.size >= MAX_JOBS) {
    throw new Error("tts_preview_jobs_busy");
  }

  const id = randomUUID();
  const expiresAt = Date.now() + TTL_MS;
  jobs.set(id, { status: "pending", tenantId, expiresAt });

  void (async () => {
    try {
      const { body } = await synthesizeTtsPreview(cfg, text);
      jobs.set(id, {
        status: "done",
        tenantId,
        body,
        expiresAt: Date.now() + TTL_MS,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const code =
        msg === "tts_url_missing" || msg.includes("tts_url_missing")
          ? "tts_url_missing"
          : "tts_preview_failed";
      jobs.set(id, {
        status: "error",
        tenantId,
        message: msg,
        code,
        expiresAt: Date.now() + TTL_MS,
      });
    }
  })();

  return id;
}

async function runRedisPreviewJob(
  id: string,
  tenantId: string,
  cfg: TTSConfig,
  text: string
): Promise<void> {
  try {
    const { body } = await synthesizeTtsPreview(cfg, text);
    const row: RedisPreviewJob = {
      v: 1,
      st: "done",
      tn: tenantId,
      b64: body.toString("base64"),
    };
    await setJSON(redisJobKey(id), row, TTL_SEC);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const code =
      msg === "tts_url_missing" || msg.includes("tts_url_missing")
        ? "tts_url_missing"
        : "tts_preview_failed";
    const row: RedisPreviewJob = { v: 1, st: "err", tn: tenantId, cd: code, mg: msg };
    await setJSON(redisJobKey(id), row, TTL_SEC);
  }
}

/**
 * Starts background TTS synthesis. Returns immediately with a job id for polling.
 * When REDIS_URL is set, state lives in Redis so multiple control-plane replicas share jobs.
 */
export async function createPreviewJob(
  tenantId: string,
  cfg: TTSConfig,
  text: string
): Promise<string> {
  if (!useRedisJobs()) {
    return createPreviewJobMemory(tenantId, cfg, text);
  }

  const id = randomUUID();
  const pending: RedisPreviewJob = { v: 1, st: "pending", tn: tenantId };
  await setJSON(redisJobKey(id), pending, TTL_SEC);
  void runRedisPreviewJob(id, tenantId, cfg, text);
  return id;
}

export type PreviewPollResult =
  | { kind: "pending" }
  | { kind: "done"; body: Buffer }
  | { kind: "error"; message: string; code: string }
  | { kind: "not_found" }
  | { kind: "forbidden" };

function pollPreviewJobMemory(id: string, tenantId: string): PreviewPollResult {
  sweepJobs();
  const job = jobs.get(id);
  if (!job) return { kind: "not_found" };
  if (job.tenantId !== tenantId) return { kind: "forbidden" };

  if (job.status === "pending") return { kind: "pending" };

  if (job.status === "error") {
    jobs.delete(id);
    return { kind: "error", message: job.message, code: job.code };
  }

  const body = job.body;
  jobs.delete(id);
  return { kind: "done", body };
}

export async function pollPreviewJob(id: string, tenantId: string): Promise<PreviewPollResult> {
  if (!useRedisJobs()) {
    return pollPreviewJobMemory(id, tenantId);
  }

  const row = (await getJSON(redisJobKey(id))) as RedisPreviewJob | null;
  if (!row || row.v !== 1) {
    return { kind: "not_found" };
  }
  if (row.tn !== tenantId) {
    return { kind: "forbidden" };
  }

  if (row.st === "pending") {
    return { kind: "pending" };
  }

  if (row.st === "err") {
    await del(redisJobKey(id));
    return { kind: "error", message: row.mg, code: row.cd };
  }

  if (row.st === "done") {
    await del(redisJobKey(id));
    try {
      const body = Buffer.from(row.b64, "base64");
      return { kind: "done", body };
    } catch {
      return { kind: "error", message: "invalid cached audio", code: "tts_preview_failed" };
    }
  }

  return { kind: "not_found" };
}
