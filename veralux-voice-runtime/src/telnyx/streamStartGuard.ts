const started = new Set<string>();

/** Returns true if this is the first streaming_start for the call. */
export function claimStreamingStart(callControlId: string): boolean {
  if (started.has(callControlId)) return false;
  started.add(callControlId);
  return true;
}

export function releaseStreamingStart(callControlId: string): void {
  started.delete(callControlId);
}
