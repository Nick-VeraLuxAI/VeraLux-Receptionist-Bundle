import type { TenantCallQualitySettingsRow } from "./db";
import type { RuntimeCallQuality } from "@veralux/shared";

export function tenantCallQualityRowToRuntime(
  row: TenantCallQualitySettingsRow
): RuntimeCallQuality {
  return {
    callQualityAnalyticsEnabled: row.call_quality_analytics_enabled,
    transcriptStorageEnabled: row.transcript_storage_enabled,
    transcriptRetentionDays: row.transcript_retention_days,
    rawAudioDiagnosticsMode: row.raw_audio_diagnostics_mode,
    rawAudioDiagnosticsExpiresAt: row.raw_audio_diagnostics_expires_at,
    rawAudioDiagnosticsEnabledBy: row.raw_audio_diagnostics_enabled_by,
    rawAudioDiagnosticsReason: row.raw_audio_diagnostics_reason,
    qualitySummaryVisibleToClient: row.quality_summary_visible_to_client,
    rawArtifactsVisibleToClient: row.raw_artifacts_visible_to_client,
    rawAudioDiagnosticsNextCallPending: row.raw_audio_diagnostics_next_call_pending,
  };
}
