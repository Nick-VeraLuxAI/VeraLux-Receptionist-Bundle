/**
 * Step pipeline: executes workflow steps sequentially,
 * passing context (event data + previous step outputs) through each step.
 */

import type {
  Workflow, WorkflowEvent, PipelineContext, StepResult,
} from "./types";
import { createRun, updateRun, getWorkflow } from "./db";
import { actionHandlers } from "./actions";
import { retryJob } from "./jobQueue";
import type { WorkflowJob } from "./jobQueue";

/**
 * Execute a full workflow pipeline.
 */
export async function executePipeline(job: WorkflowJob): Promise<void> {
  const { workflowId, tenantId, event } = job;

  // Load the workflow definition
  const workflow = await getWorkflow(workflowId);
  if (!workflow) {
    console.warn(`[pipeline] Workflow ${workflowId} not found, skipping`);
    return;
  }

  if (!workflow.enabled) {
    console.log(`[pipeline] Workflow "${workflow.name}" is disabled, skipping`);
    return;
  }

  // Sort steps by order
  const steps = [...workflow.steps].sort((a, b) => a.order - b.order);

  // Create a run record
  const run = await createRun({
    workflowId,
    tenantId,
    triggerEvent: event as any,
    stepsTotal: steps.length,
  });

  const ctx: PipelineContext = {
    event,
    workflow,
    runId: run.id,
    tenantId,
    stepOutputs: {},
  };

  const results: StepResult[] = [];
  let failed = false;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const handler = actionHandlers[step.action];

    if (!handler) {
      const result: StepResult = {
        action: step.action,
        order: step.order,
        status: "error",
        error: `Unknown action: ${step.action}`,
      };
      results.push(result);
      failed = true;

      await updateRun(run.id, {
        status: "failed",
        stepsCompleted: i,
        result: results,
        error: result.error,
      });
      break;
    }

    const startTime = Date.now();
    try {
      const output = await handler(ctx, step.config ?? {});
      const result: StepResult = {
        action: step.action,
        order: step.order,
        status: "ok",
        output,
        durationMs: Date.now() - startTime,
      };
      results.push(result);
      ctx.stepOutputs[step.order] = output;

      await updateRun(run.id, {
        stepsCompleted: i + 1,
        result: results,
      });

      console.log(
        `[pipeline] Step ${i + 1}/${steps.length} (${step.action}) completed in ${result.durationMs}ms`
      );
    } catch (err: any) {
      const result: StepResult = {
        action: step.action,
        order: step.order,
        status: "error",
        error: err.message ?? String(err),
        durationMs: Date.now() - startTime,
      };
      results.push(result);
      failed = true;

      console.error(
        `[pipeline] Step ${i + 1}/${steps.length} (${step.action}) failed:`,
        err.message
      );

      await updateRun(run.id, {
        status: "failed",
        stepsCompleted: i,
        result: results,
        error: result.error,
      });
      break;
    }
  }

  if (!failed) {
    await updateRun(run.id, {
      status: "completed",
      stepsCompleted: steps.length,
      result: results,
    });
    console.log(
      `[pipeline] Workflow "${workflow.name}" completed successfully (${steps.length} steps)`
    );
  } else {
    // Retry the job if possible
    const retried = await retryJob(job);
    if (retried) {
      console.log(`[pipeline] Workflow "${workflow.name}" queued for retry`);
    } else {
      console.warn(`[pipeline] Workflow "${workflow.name}" failed after max retries`);
    }
  }
}

/**
 * Execute a workflow pipeline in dry-run mode (no side effects).
 * Returns the results without persisting anything.
 */
export async function dryRunPipeline(
  workflow: Workflow,
  event: WorkflowEvent
): Promise<{
  steps: Array<StepResult & { type?: string; rendered?: string }>;
  wouldMatch: boolean;
  matched: boolean;
  enabled: boolean;
  reason: string;
  sample?: { callerId?: string; callId?: string };
}> {
  const { evaluateConditions } = await import("./matcher");
  const wouldMatch = evaluateConditions(workflow, event);
  const steps = [...workflow.steps].sort((a, b) => a.order - b.order);

  const results: Array<StepResult & { type?: string; rendered?: string }> = [];

  for (const step of steps) {
    const handler = actionHandlers[step.action];
    const rendered =
      (step.config?.message as string) ||
      (step.config?.template as string) ||
      (step.config?.body as string) ||
      (step.config?.url as string) ||
      (step.config?.summary as string) ||
      `Would execute ${step.action}`;
    if (!handler) {
      results.push({
        action: step.action,
        type: step.action,
        order: step.order,
        status: "error",
        error: `Unknown action: ${step.action}`,
        rendered,
      });
      continue;
    }

    results.push({
      action: step.action,
      type: step.action,
      order: step.order,
      status: "ok",
      rendered,
      output: {
        dryRun: true,
        description: `Would execute ${step.action} with config: ${JSON.stringify(step.config)}`,
      },
    });
  }

  return {
    steps: results,
    wouldMatch,
    matched: wouldMatch,
    enabled: workflow.enabled,
    reason: wouldMatch
      ? "Sample event matches this trigger."
      : "Sample event would not match this trigger’s conditions.",
    sample: {
      callerId: (event as any).callerId,
      callId: (event as any).callId,
    },
  };
}
