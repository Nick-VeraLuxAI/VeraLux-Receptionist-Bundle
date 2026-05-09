import type { EchoSuppressionMode } from './assistantEcho';
import { env } from '../env';

export function getEchoSuppressionMode(): EchoSuppressionMode {
  const m = env.STT_ECHO_SUPPRESSION_MODE;
  if (m === 'conservative' || m === 'permissive' || m === 'balanced') return m;
  return 'balanced';
}

/** Extra multiplier on effective RMS/peak floor right after playback grace buffer is replayed. */
export function postPlaybackEchoEnergyMultiplier(): number {
  switch (getEchoSuppressionMode()) {
    case 'conservative':
      return env.STT_ECHO_POST_PLAYBACK_RMS_MULT_CONSERVATIVE;
    case 'permissive':
      return env.STT_ECHO_POST_PLAYBACK_RMS_MULT_PERMISSIVE;
    case 'balanced':
    default:
      return env.STT_ECHO_POST_PLAYBACK_RMS_MULT_BALANCED;
  }
}
