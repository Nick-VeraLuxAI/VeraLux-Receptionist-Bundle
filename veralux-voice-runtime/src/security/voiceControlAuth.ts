import type { NextFunction, Request, Response } from 'express';
import { env } from '../env';
import { incTenantAuthFailure } from '../metrics';

function extractBearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const trimmed = authHeader.trim();
  if (!trimmed.toLowerCase().startsWith('bearer ')) return undefined;
  const token = trimmed.slice(7).trim();
  return token || undefined;
}

export function resolveVoiceControlToken(req: Request): string | undefined {
  const bearer = extractBearerToken(
    typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
  );
  if (bearer) return bearer;
  const xAdmin = req.headers['x-admin-key'];
  if (typeof xAdmin === 'string' && xAdmin.trim()) return xAdmin.trim();
  if (Array.isArray(xAdmin) && xAdmin[0]?.trim()) return xAdmin[0].trim();
  return undefined;
}

export function voiceControlGuard(req: Request, res: Response, next: NextFunction): void {
  const expected = env.VOICE_CONTROL_API_KEY ?? env.CONTROL_PLANE_API_KEY;
  if (!expected) {
    if (env.NODE_ENV === 'production') {
      res.status(500).json({ error: 'voice_control_auth_misconfigured' });
      return;
    }
    next();
    return;
  }
  const provided = resolveVoiceControlToken(req);
  if (!provided || provided !== expected) {
    incTenantAuthFailure('voice_control');
    res.status(401).json({ error: 'voice_control_auth_required' });
    return;
  }
  next();
}
