import pino from 'pino';
import { redactValue } from './observability/redaction';

/**
 * JSON logs always include `svc: "runtime"` so you can grep/jq alongside control-plane (`svc: "control"`).
 * Override with LOG_SERVICE_NAME for multiple runtime instances.
 */
export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    svc: process.env.LOG_SERVICE_NAME ?? 'runtime',
  },
  hooks: {
    logMethod(args, method) {
      const redactTranscripts = (process.env.LOG_REDACT_TRANSCRIPTS ?? 'true').toLowerCase() !== 'false';
      const safeArgs = args.map((arg) =>
        arg && typeof arg === 'object' ? redactValue(arg, { redactTranscripts }) : arg,
      );
      method.apply(this, safeArgs as Parameters<typeof method>);
    },
  },
});