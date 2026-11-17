import type { RequestHandler } from '@sveltejs/kit';
import { getAdminSettings, checkDailyQuota } from '$lib/db';
import { jsonServerError } from '$lib/server/safe-error';

export const GET: RequestHandler = async ({ locals }) => {
  try {
    // Require authentication
    if (!locals.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const settings = await getAdminSettings();
    const quotaCheck = await checkDailyQuota(locals.user, settings);

    return new Response(JSON.stringify({
      used: quotaCheck.used,
      limit: quotaCheck.limit,
      remaining: quotaCheck.limit - quotaCheck.used,
      exceeded: quotaCheck.exceeded
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return jsonServerError('[API /quota] Error:', err);
  }
};
