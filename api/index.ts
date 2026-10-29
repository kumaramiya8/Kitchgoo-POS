import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../apps/backend/src/serverless';

/**
 * Vercel Serverless Function entrypoint for privileged backend endpoints:
 * - /api/v1/tenants/onboard
 * - /api/v1/tenants/staff
 * - /api/v1/tenants/billing-webhook
 * - /api/v1/tenants/analytics
 * - /api/v1/auth/*
 */
export default async function (req: VercelRequest, res: VercelResponse) {
  return handler(req as any, res as any);
}
