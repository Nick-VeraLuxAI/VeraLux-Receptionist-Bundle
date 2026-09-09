import { randomUUID } from "crypto";
import type { CallState, Lead, Stage } from "./runTypes";
import { isUuid } from "./utils/validation";

const INITIAL_STAGE: Stage = "greeting";

export const CALL_TTL_MS = Number(process.env.CALL_TTL_MS ?? 30 * 60_000); // 30 min
const SWEEP_MS = Number(process.env.CALL_SWEEP_MS ?? 60_000); // 60 sec

const ENDED_STAGES = new Set(["end", "ended", "closed", "completed", "missed"]);

export function isEndedCallStage(stage: unknown): boolean {
  return ENDED_STAGES.has(String(stage || "").toLowerCase());
}

/** In-progress calls only — excludes ended rows and history hydrated without a live timestamp. */
export function isLiveCall(call: Pick<CallState, "stage" | "lastActivityAt" | "createdAt">, now = Date.now()): boolean {
  if (isEndedCallStage(call.stage)) return false;
  const last = call.lastActivityAt ?? call.createdAt ?? 0;
  return Boolean(last) && now - last <= CALL_TTL_MS;
}

export class InMemoryCallStore {
  private calls = new Map<string, CallState>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private tenantId: string,
    initialCalls?: CallState[],
    private onChange?: () => void,
    // Optional hook so the server can release global capacity counters too
    private onDeleteCall?: (callId: string) => void
  ) {
    if (initialCalls) {
      initialCalls.forEach((call) => {
        if (call && call.id) this.index(call);
      });
    }

    // Start background sweep
    this.sweepTimer = setInterval(() => this.sweepExpiredCalls(), SWEEP_MS);
    this.sweepTimer.unref();
  }

  private keysFor(call: CallState): string[] {
    const keys = [call.id];
    const cc =
      call.lead && typeof (call.lead as Lead).voiceCallControlId === "string"
        ? String((call.lead as Lead).voiceCallControlId).trim()
        : "";
    if (cc && cc !== call.id) keys.push(cc);
    return keys;
  }

  private index(call: CallState): void {
    for (const key of this.keysFor(call)) this.calls.set(key, call);
  }

  private unindex(call: CallState): void {
    for (const key of this.keysFor(call)) this.calls.delete(key);
  }

  createCall(callerId?: string, callId?: string): CallState {
    const now = Date.now();
    const externalId = typeof callId === "string" && callId.trim() ? callId.trim() : undefined;
    const id = externalId && isUuid(externalId) ? externalId : randomUUID();
    const lead: Lead = {};
    if (externalId) lead.voiceCallControlId = externalId;
    const call: CallState = {
      id,
      tenantId: this.tenantId,
      callerId,
      stage: INITIAL_STAGE,
      lead,
      history: [],
      createdAt: now,
      lastActivityAt: now,
    };
    this.index(call);
    this.onChange?.();
    return call;
  }

  getCall(callId: string): CallState | undefined {
    return this.calls.get(callId);
  }

  listCalls(): CallState[] {
    const seen = new Set<string>();
    const out: CallState[] = [];
    for (const call of this.calls.values()) {
      if (seen.has(call.id)) continue;
      seen.add(call.id);
      out.push(call);
    }
    return out;
  }

  countLiveCalls(now = Date.now()): number {
    return this.listCalls().filter((call) => isLiveCall(call, now)).length;
  }

  save(call: CallState): CallState {
    const now = Date.now();
    const next: CallState = {
      ...call,
      createdAt: call.createdAt ?? now,
      lastActivityAt: now,
    };
    this.index(next);
    this.onChange?.();
    return next;
  }

  deleteCall(callId: string): void {
    const call = this.getCall(callId);
    if (!call) return;
    this.unindex(call);
    this.onDeleteCall?.(call.id);
    this.onChange?.();
  }

  serialize(): CallState[] {
    return this.listCalls();
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private sweepExpiredCalls(): void {
    const now = Date.now();
    let changed = false;

    for (const call of this.listCalls()) {
      const last = call.lastActivityAt ?? call.createdAt ?? 0;
      if (last && now - last > CALL_TTL_MS) {
        this.unindex(call);
        this.onDeleteCall?.(call.id);
        changed = true;
      }
    }

    if (changed) this.onChange?.();
  }
}
