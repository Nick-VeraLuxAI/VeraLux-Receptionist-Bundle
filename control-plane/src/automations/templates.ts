/**
 * Enable / seed workflow templates onto a tenant.
 */

import {
  DEFAULT_ON_TEMPLATE_IDS,
  instantiateWorkflowTemplate,
  isDemoShopLegacyWorkflowName,
  listWorkflowTemplatesForGallery,
  type WorkflowTemplateId,
} from "@veralux/shared";
import type { TriggerType, Workflow, WorkflowStep } from "./types";
import {
  createWorkflow,
  getWorkflowByTemplate,
  listWorkflows,
  updateWorkflow,
} from "./db";

export function galleryPayload(installed: Workflow[]) {
  const byTemplate: Record<string, string> = {};
  for (const wf of installed) {
    if (wf.templateId) byTemplate[wf.templateId] = wf.id;
  }
  return {
    templates: listWorkflowTemplatesForGallery(),
    installed: byTemplate,
    defaultOn: DEFAULT_ON_TEMPLATE_IDS,
  };
}

export async function adoptDemoShopWorkflows(tenantId: string): Promise<Workflow[]> {
  const existing = await listWorkflows(tenantId);
  const adopted: Workflow[] = [];
  for (const wf of existing) {
    if (!isDemoShopLegacyWorkflowName(wf.name) && wf.templateId !== "night-desk-capture-book") {
      continue;
    }
    if (wf.templateId === "night-desk-capture-book" && wf.name === "Night desk capture & book") {
      adopted.push(wf);
      continue;
    }
    const updated = await updateWorkflow(wf.id, {
      name: "Night desk capture & book",
      templateId: "night-desk-capture-book",
    });
    if (updated) adopted.push(updated);
  }
  return adopted;
}

export async function enableWorkflowTemplate(params: {
  tenantId: string;
  templateId: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  createdBy?: string;
  adminLocked?: boolean;
}): Promise<{ workflow: Workflow; created: boolean }> {
  const inst = instantiateWorkflowTemplate(params.templateId, {
    enabled: params.enabled ?? true,
    config: params.config,
    adminLocked: params.adminLocked,
  });
  const existing = await getWorkflowByTemplate(params.tenantId, inst.templateId);
  if (existing) {
    const updated = await updateWorkflow(existing.id, {
      name: inst.name,
      enabled: params.enabled ?? existing.enabled,
      triggerType: inst.triggerType as TriggerType,
      triggerConfig: inst.triggerConfig,
      steps: inst.steps as WorkflowStep[],
      adminLocked: params.adminLocked ?? existing.adminLocked,
      templateId: inst.templateId,
    });
    return { workflow: updated || existing, created: false };
  }
  try {
    const workflow = await createWorkflow({
      tenantId: params.tenantId,
      name: inst.name,
      triggerType: inst.triggerType as TriggerType,
      triggerConfig: inst.triggerConfig,
      steps: inst.steps as WorkflowStep[],
      createdBy: params.createdBy ?? "admin",
      adminLocked: inst.adminLocked,
      enabled: inst.enabled,
      templateId: inst.templateId,
    });
    return { workflow, created: true };
  } catch (err: any) {
    if (err?.code === "23505") {
      const raced = await getWorkflowByTemplate(params.tenantId, inst.templateId);
      if (raced) return { workflow: raced, created: false };
    }
    throw err;
  }
}

/**
 * Seed default-ON templates for new / empty tenants.
 * Always adopts a Demo Shop legacy row onto night-desk-capture-book.
 * After a Demo Shop adopt (or if any template_id is present), fill missing defaults.
 */
export async function ensureTenantWorkflows(tenantId: string): Promise<Workflow[]> {
  const adopted = await adoptDemoShopWorkflows(tenantId);
  const current = await listWorkflows(tenantId);
  const hasTemplate = current.some((wf) => Boolean(wf.templateId));
  const shouldSeedDefaults = current.length === 0 || hasTemplate || adopted.length > 0;

  if (shouldSeedDefaults) {
    for (const templateId of DEFAULT_ON_TEMPLATE_IDS) {
      const already = current.find((wf) => wf.templateId === templateId);
      if (already) continue;
      await enableWorkflowTemplate({
        tenantId,
        templateId,
        enabled: true,
        createdBy: "admin",
        adminLocked: true,
      });
    }
  }

  return listWorkflows(tenantId);
}

export type { WorkflowTemplateId };
