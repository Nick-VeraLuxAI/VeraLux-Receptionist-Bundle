import { randomUUID } from "crypto";
import type { TTSConfig } from "./config";
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
const SWEEP_EVERY_MS = 60 * 1000;
const MAX_JOBS = 200;

function sweepJobs(): void {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.expiresAt <= now) jobs.delete(id);
  }
}

setInterval(sweepJobs, SWEEP_EVERY_MS).unref?.();

/**
 * Starts background TTS synthesis. Returns immediately with a job id for polling.
 * Use from admin preview behind slow proxies (e.g. Cloudflare) where a single long
 * HTTP response may 502 before synthesis finishes.
 */
export function createPreviewJob(tenantId: string, cfg: TTSConfig, text: string): string {
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

export type PreviewPollResult =
  | { kind: "pending" }
  | { kind: "done"; body: Buffer }
  | { kind: "error"; message: string; code: string }
  | { kind: "not_found" }
  | { kind: "forbidden" };

export function pollPreviewJob(id: string, tenantId: string): PreviewPollResult {
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
