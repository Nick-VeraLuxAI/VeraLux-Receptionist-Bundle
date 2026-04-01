import pino from 'pino';

/**
 * JSON logs always include `svc: "runtime"` so you can grep/jq alongside control-plane (`svc: "control"`).
 * Override with LOG_SERVICE_NAME for multiple runtime instances.
 */
export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    svc: process.env.LOG_SERVICE_NAME ?? 'runtime',
  },
});