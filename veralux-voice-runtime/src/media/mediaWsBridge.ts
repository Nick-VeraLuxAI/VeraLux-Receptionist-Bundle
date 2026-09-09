type SendFn = (callControlId: string, json: string) => boolean;
type WaitFn = (callControlId: string, timeoutMs: number) => Promise<boolean>;

let sendFn: SendFn | null = null;
let waitFn: WaitFn | null = null;

export function bindMediaWsBridge(send: SendFn, wait: WaitFn): void {
  sendFn = send;
  waitFn = wait;
}

export function sendMediaWsJson(callControlId: string, json: string): boolean {
  return sendFn?.(callControlId, json) ?? false;
}

export async function waitForMediaWs(callControlId: string, timeoutMs: number): Promise<boolean> {
  if (!waitFn) return false;
  return waitFn(callControlId, timeoutMs);
}
