/**
 * Call Quality Analytics + Raw Audio Diagnostics policy (tenant Redis config + env override).
 */
import type { RuntimeCallQuality, RuntimeTenantConfig } from '@veralux/shared';

/** Read env without importing `../env` (avoids full zod parse when this module is unit-tested). */
function isEnvAudioForensicsMasterEnabled(): boolean {
  const v = (process.env.AUDIO_FORENSICS_ENABLED || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

export function mergeCallQualityDefaults(
  c?: RuntimeTenantConfig['callQuality'],
): RuntimeCallQuality {
  return {
    callQualityAnalyticsEnabled: c?.callQualityAnalyticsEnabled ?? true,
    transcriptStorageEnabled: c?.transcriptStorageEnabled ?? true,
    transcriptRetentionDays: c?.transcriptRetentionDays ?? 30,
    rawAudioDiagnosticsMode: c?.rawAudioDiagnosticsMode ?? 'off',
    rawAudioDiagnosticsExpiresAt: c?.rawAudioDiagnosticsExpiresAt ?? null,
    rawAudioDiagnosticsEnabledBy: c?.rawAudioDiagnosticsEnabledBy ?? null,
    rawAudioDiagnosticsReason: c?.rawAudioDiagnosticsReason ?? null,
    qualitySummaryVisibleToClient: c?.qualitySummaryVisibleToClient ?? true,
    rawArtifactsVisibleToClient: c?.rawArtifactsVisibleToClient ?? false,
    rawAudioDiagnosticsNextCallPending: c?.rawAudioDiagnosticsNextCallPending ?? false,
  };
}

export type RawForensicsDecision = {
  capture: boolean;
  operatorOverride: boolean;
  tenantDiagnostics: boolean;
  logLabel: string;
  diagnosticsManifest: Record<string, unknown>;
};

export function resolveRawForensicsCapture(
  tenantConfig?: RuntimeTenantConfig | null,
): RawForensicsDecision {
  const emptyMeta = (): Record<string, unknown> => ({
    rawAudioDiagnosticsMode: 'off',
    tenantId: tenantConfig?.tenantId ?? null,
  });

  if (isEnvAudioForensicsMasterEnabled()) {
    return {
      capture: true,
      operatorOverride: true,
      tenantDiagnostics: false,
      logLabel: 'operator_env_override',
      diagnosticsManifest: {
        ...emptyMeta(),
        source: 'AUDIO_FORENSICS_ENABLED',
        operatorOverride: true,
      },
    };
  }

  const cq = mergeCallQualityDefaults(tenantConfig?.callQuality);
  const now = Date.now();
  const baseMeta: Record<string, unknown> = {
    tenantId: tenantConfig?.tenantId ?? null,
    rawAudioDiagnosticsMode: cq.rawAudioDiagnosticsMode,
    rawAudioDiagnosticsEnabledBy: cq.rawAudioDiagnosticsEnabledBy ?? null,
    rawAudioDiagnosticsReason: cq.rawAudioDiagnosticsReason ?? null,
    rawAudioDiagnosticsExpiresAt: cq.rawAudioDiagnosticsExpiresAt ?? null,
    rawAudioDiagnosticsNextCallPending: cq.rawAudioDiagnosticsNextCallPending,
    source: 'tenant_call_quality',
  };

  if (cq.rawAudioDiagnosticsMode === 'all_calls_temporary') {
    const exp = cq.rawAudioDiagnosticsExpiresAt ? Date.parse(cq.rawAudioDiagnosticsExpiresAt) : NaN;
    if (Number.isFinite(exp) && exp > now) {
      return {
        capture: true,
        operatorOverride: false,
        tenantDiagnostics: true,
        logLabel: 'tenant_all_calls_temporary',
        diagnosticsManifest: baseMeta,
      };
    }
    return {
      capture: false,
      operatorOverride: false,
      tenantDiagnostics: false,
      logLabel: 'tenant_diagnostics_expired',
      diagnosticsManifest: baseMeta,
    };
  }

  if (
    (cq.rawAudioDiagnosticsMode === 'next_call_only' ||
      cq.rawAudioDiagnosticsMode === 'failed_calls_only') &&
    cq.rawAudioDiagnosticsNextCallPending
  ) {
    return {
      capture: true,
      operatorOverride: false,
      tenantDiagnostics: true,
      logLabel: `tenant_${cq.rawAudioDiagnosticsMode}_pending`,
      diagnosticsManifest: baseMeta,
    };
  }

  return {
    capture: false,
    operatorOverride: false,
    tenantDiagnostics: false,
    logLabel: 'off',
    diagnosticsManifest: { ...emptyMeta(), rawAudioDiagnosticsMode: cq.rawAudioDiagnosticsMode },
  };
}
