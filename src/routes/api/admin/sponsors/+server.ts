import type { RequestHandler } from '@sveltejs/kit';
import { getAdminSettings } from '$lib/db';
import { env } from '$env/dynamic/private';

type CrawlerSponsor = {
  fansNickname?: string;
  fansAvatar?: string;
  fansDomainName?: string;
  schemeName?: string;
};

async function fetchSponsorsFromCrawler(): Promise<CrawlerSponsor[]> {
  const settings = await getAdminSettings();
  const crawlerUrl = settings.sponsorApiUrl || env.SPONSOR_API_URL || 'http://localhost:3999';
  const token = settings.sponsorApiToken || env.SPONSOR_API_TOKEN || '';
  const deviceId = settings.deviceId || '';

  if (!token) {
    console.warn('[Admin Sponsors] Sponsor API token not configured');
    return [];
  }

  const url = new URL(`${crawlerUrl}/sponsors`);
  if (deviceId) {
    url.searchParams.set('deviceId', deviceId);
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    console.error(`[Admin Sponsors] Failed to fetch sponsors from crawler: ${response.status}`);
    return [];
  }

  const data = await response.json();
  return Array.isArray(data?.sponsors) ? data.sponsors : [];
}

export const GET: RequestHandler = async ({ locals }) => {
  // Admin-only access
  if (!locals.user?.roles?.includes('admin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const crawlerSponsors = await fetchSponsorsFromCrawler();

    // Map to UI shape; use current time as createdAt to avoid invalid dates
    const mapped = crawlerSponsors.map((s) => ({
      userId: undefined,
      username: s.fansDomainName,
      nickname: s.fansNickname,
      avatar: s.fansAvatar,
      tier: s.schemeName,
      appliedRole: undefined,
      expiresAt: null,
      createdAt: new Date().toISOString(),
    }));

    return new Response(
      JSON.stringify({
        sponsors: mapped,
        page: 1,
        totalPages: 1,
        total: mapped.length,
        limit: mapped.length,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[Admin Sponsors] Failed to fetch sponsors:', err);
    return new Response(JSON.stringify({ error: 'Failed to fetch sponsors' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
