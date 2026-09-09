import {
  applySpeakPolicy,
  extractIntakeSlots,
  formatTalkerBoard,
  buildDemoShopTalkerBoard,
  greetingWithCallerName,
  ingestDtmfDigit,
  normalizeIntakeProfile,
  planReceptionistTurn,
  slotsToLead,
  emptyPromise,
  evaluateShopAction,
  extractQuoteCents,
  extractZip,
  inferShopIntent,
  normalizeShopPlaybook,
  type CallCompletion,
  type IntakeProfile,
  type ReceptionistTurnPlan,
  type ShopEvaluation,
} from '@veralux/shared';
import type { RuntimeTenantConfig, TransferProfile } from '../tenants/tenantConfig';
import type { ConversationTurn } from './types';

export type ShopGateResult = {
  text: string;
  completion?: CallCompletion;
  transferTo?: string;
  timeoutSecs?: number;
  pageSms: boolean;
};

export {
  applySpeakPolicy,
  extractIntakeSlots,
  formatTalkerBoard,
  buildDemoShopTalkerBoard,
  greetingWithCallerName,
  ingestDtmfDigit,
  normalizeIntakeProfile,
  planReceptionistTurn,
  slotsToLead,
};
export type { IntakeProfile, ReceptionistTurnPlan };

export function applyShopSpeakGate(input: {
  playbookRaw: unknown;
  transferProfiles?: TransferProfile[];
  userText: string;
  replyText: string;
  existingOpenJobs?: number;
  membership?: string;
}): ShopGateResult {
  const playbook = normalizeShopPlaybook(input.playbookRaw as never);
  const ev: ShopEvaluation = evaluateShopAction(playbook, {
    intent: inferShopIntent(input.userText),
    utterance: input.userText,
    zip: extractZip(input.userText),
    quoteCents: extractQuoteCents(input.userText),
    existingOpenJobs: input.existingOpenJobs,
    membership: input.membership,
  });

  if (ev.decision === 'refuse' || ev.decision === 'hold') {
    return { text: ev.speak || input.replyText, completion: ev.completion, pageSms: false };
  }

  if (ev.decision === 'escalate') {
    const dest =
      ev.reason === 'human_overflow' && playbook.humanOverflowE164
        ? playbook.humanOverflowE164
        : playbook.onCallE164 ||
          input.transferProfiles?.find((p) => p.id === 'oncall' || p.responsibilities?.includes('on-call'))
            ?.destination;
    return {
      text: ev.speak || input.replyText,
      completion: ev.completion,
      transferTo: dest,
      timeoutSecs: playbook.onCallTimeoutSecs,
      pageSms: Boolean(dest),
    };
  }

  if (emptyPromise(input.replyText)) {
    return {
      text: "I've written a task for the shop so this does not get lost.",
      completion: 'tasked',
      pageSms: false,
    };
  }

  if (ev.decision === 'allow' && ev.completion === 'booked' && /\bbooked\b/i.test(input.replyText)) {
    return { text: input.replyText, completion: 'booked', pageSms: false };
  }

  return { text: input.replyText, completion: ev.completion, pageSms: false };
}

export function playbookFromTenant(cfg?: RuntimeTenantConfig): unknown {
  return cfg?.shopPlaybook;
}

export function tenantIntakeProfile(cfg?: RuntimeTenantConfig, tenantId?: string): IntakeProfile {
  return normalizeIntakeProfile(cfg?.intakeProfile, tenantId || cfg?.tenantId);
}

export function extractNightDeskLead(input: {
  history: ConversationTurn[];
  callerId?: string;
  existingCustomerName?: string;
  membership?: string;
  dtmfPhone?: string | null;
  profile?: IntakeProfile | null;
  tenantId?: string;
}): Record<string, unknown> {
  const slots = extractIntakeSlots({
    history: input.history,
    callerId: input.callerId,
    dtmfPhone: input.dtmfPhone,
    existingName: input.existingCustomerName,
    profile: input.profile,
    tenantId: input.tenantId,
  });
  return slotsToLead(slots, {
    membership: input.membership,
    existingCustomer: input.existingCustomerName,
  });
}

export function gcalBookHelperUrl(): string {
  return (
    process.env.BOOK_HELPER_URL ||
    process.env.DEMO_SHOP_BOOK_HELPER_URL ||
    'http://demo-shop-book-helper:8791/book'
  );
}
