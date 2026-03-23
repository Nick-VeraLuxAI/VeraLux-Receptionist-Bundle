/**
 * Redis-backed (or in-memory fallback) job queue for workflow execution.
 * Uses LPUSH/RPOP for FIFO processing.
 */

import * as redis from "../redis";
import type { WorkflowEvent } from "./types";

const QUEUE_KEY = "veralux:workflow:jobs";
const MAX_RETRIES = 3;
const DEFAULT_MAX_JOBS_PER_POLL = 20;

export interface WorkflowJob {
  workflowId: string;
  tenantId: string;
  event: WorkflowEvent;
  retries?: number;
}

// In-memory queue fallback (when Redis is not available)
const memQueue: WorkflowJob[] = [];
const jobListeners: Array<(job: WorkflowJob) => void | Promise<void>> = [];
let processing = false;

/**
 * Enqueue a workflow job for async execution.
 */
export async function enqueueJob(job: WorkflowJob): Promise<void> {
  const payload = JSON.stringify({ ...job, retries: job.retries ?? 0 });

  try {
    await redis.lpush(QUEUE_KEY, payload);
  } catch {
    // Fallback to in-memory
    const parsed: WorkflowJob = JSON.parse(payload);
    memQueue.push(parsed);
    // Notify in-memory processor
    processMemQueue();
  }
}

/**
 * Dequeue the next job. Returns null if empty.
 */
export async function dequeueJob(): Promise<WorkflowJob | null> {
  try {
    const payload = await redis.rpop(QUEUE_KEY);
    if (!payload) return null;
    return JSON.parse(payload);
  } catch {
    // In-memory fallback
    return memQueue.shift() ?? null;
  }
}

/**
 * Re-enqueue a failed job with retry logic.
 */
export async function retryJob(job: WorkflowJob): Promise<boolean> {
  const retries = (job.retries ?? 0) + 1;
  if (retries > MAX_RETRIES) {
    console.warn(`[jobQueue] Job for workflow ${job.workflowId} exceeded max retries (${MAX_RETRIES})`);
    return false;
  }

  // Exponential backoff delay (2^retries seconds)
  const delaySec = Math.pow(2, retries);
  console.log(`[jobQueue] Retrying workflow ${job.workflowId} in ${delaySec}s (attempt ${retries}/${MAX_RETRIES})`);

  setTimeout(async () => {
    await enqueueJob({ ...job, retries });
  }, delaySec * 1000);

  return true;
}

/**
 * Register a job processor function. Called when jobs arrive.
 */
export function onJob(fn: (job: WorkflowJob) => void | Promise<void>): void {
  jobListeners.push(fn);
}

/**
 * Start polling for jobs in Redis. Call once at startup.
 */
let pollInterval: ReturnType<typeof setInterval> | null = null;

async function processJob(job: WorkflowJob): Promise<void> {
  await Promise.allSettled(
    jobListeners.map(async (fn) => {
      try {
        await fn(job);
      } catch (err) {
        console.error("[jobQueue] Processor error:", err);
      }
    }),
  );
}

export function startPolling(intervalMs = 2000, maxJobsPerPoll = DEFAULT_MAX_JOBS_PER_POLL): void {
  if (pollInterval) return;

  pollInterval = setInterval(async () => {
    try {
      for (let i = 0; i < maxJobsPerPoll; i++) {
        const job = await dequeueJob();
        if (!job) break;
        await processJob(job);
      }
    } catch (err) {
      console.error("[jobQueue] Poll error:", err);
    }
  }, intervalMs);

  console.log("[jobQueue] Polling started");
}

export function stopPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.log("[jobQueue] Polling stopped");
  }
}

/**
 * Process in-memory queue (when Redis is unavailable).
 */
function processMemQueue(): void {
  if (processing) return;
  processing = true;

  setImmediate(async () => {
    while (memQueue.length > 0) {
      const job = memQueue.shift()!;
      await processJob(job);
    }
    processing = false;
  });
}
