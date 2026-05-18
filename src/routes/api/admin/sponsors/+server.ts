import type { RequestHandler } from '@sveltejs/kit';
import { getAdminSettings, getAllSponsorClaims, getAllUsers, updateSponsorClaim, expireSponsorClaim } from '$lib/db';
import { env } from '$env/dynamic/private';
import type { AdminSettings, SponsorClaim } from '$lib/IDatabase';

type CrawlerSponsor = {
  fansNickname?: string;
  fansAvatar?: string;
  fansDomainName?: string;
  schemeName?: string;
};

type SponsorDiscrepancy =
  | 'missing_in_crawler'
  | 'tier_mismatch'
  | 'role_mismatch'
  | 'role_mapping_missing'
  | 'db_expired_but_in_crawler';

type MergedSponsorRecord = {
  username: string;
  dbUsername?: string;
  expectedRole?: string;
  crawler: {
    nickname?: string;
    avatar?: string;
    tier?: string;
  } | null;
  db: {
    userId: string;
    nickname?: string;
    avatar?: string;
    tier: string;
    appliedRole: string;
    claimedAt: string;
    expiresAt?: string | null;
  } | null;
  discrepancies: SponsorDiscrepancy[];
  hasDiscrepancy: boolean;
};

async function fetchSponsorsFromCrawler(settings: AdminSettings): Promise<CrawlerSponsor[]> {
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

type CrawlerFetchResult = {
  sponsors: CrawlerSponsor[];
  available: boolean;
  error?: string;
};

async function fetchSponsorsFromCrawlerSafe(settings: AdminSettings): Promise<CrawlerFetchResult> {
  try {
    const sponsors = await fetchSponsorsFromCrawler(settings);
    if (sponsors.length === 0 && (settings.sponsorApiUrl || env.SPONSOR_API_URL)) {
      return { sponsors: [], available: false, error: 'Crawler returned empty or unavailable' };
    }
    return { sponsors, available: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('[Admin Sponsors] Crawler fetch error:', errorMsg);
    return { sponsors: [], available: false, error: errorMsg };
  }
}

function normalizeValue(value?: string | null): string {
  return (value || '').trim().toLowerCase();
}

function hasTextMismatch(left?: string | null, right?: string | null): boolean {
  const normalizedLeft = normalizeValue(left);
  const normalizedRight = normalizeValue(right);

  if (!normalizedLeft && !normalizedRight) return false;
  return normalizedLeft !== normalizedRight;
}

function getConfiguredSponsorTierSet(settings: AdminSettings): Set<string> {
  const roles = settings.roles || [];
  return new Set(roles.map((role) => normalizeValue(role.sponsorTier)).filter(Boolean));
}

function tierRequiresSponsor(tier: string | undefined, configuredSponsorTiers: Set<string>): boolean {
  const normalizedTier = normalizeValue(tier);
  return Boolean(normalizedTier) && configuredSponsorTiers.has(normalizedTier);
}

function getExpectedRoleForTier(tier: string | undefined, settings: AdminSettings): string | undefined {
  if (!tier) return undefined;

  const roles = settings.roles || [];
  const normalizedTier = normalizeValue(tier);
  const match = roles.find((role) => normalizeValue(role.sponsorTier) === normalizedTier);
  return match?.name;
}

function mapDiscrepancies(
  crawler: CrawlerSponsor | undefined,
  dbClaim: SponsorClaim | undefined,
  expectedRole: string | undefined,
  sponsorRequired: boolean,
  crawlerAvailable: boolean,
): SponsorDiscrepancy[] {
  const discrepancies: SponsorDiscrepancy[] = [];

  if (!crawlerAvailable) {
    return discrepancies;
  }

  if (!sponsorRequired) {
    return discrepancies;
  }

  if (!crawler) {
    // Expired DB entries are expected to be missing from crawler - not a discrepancy
    if (!dbClaim?.expired_at) {
      discrepancies.push('missing_in_crawler');
    }
    return discrepancies;
  }

  // Crawler-only entries (no dbClaim) are not flagged - user may not have an account on this site
  if (dbClaim) {
    if (hasTextMismatch(crawler.schemeName, dbClaim.sponsor_tier)) {
      discrepancies.push('tier_mismatch');
    }

    if (!expectedRole) {
      discrepancies.push('role_mapping_missing');
    } else if (hasTextMismatch(expectedRole, dbClaim.applied_role)) {
      discrepancies.push('role_mismatch');
    }

    if (dbClaim.expired_at) {
      discrepancies.push('db_expired_but_in_crawler');
    }
  }

  return discrepancies;
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
    const settings = await getAdminSettings();
    const configuredSponsorTiers = getConfiguredSponsorTierSet(settings);
    const [crawlerResult, dbClaims, allUsers] = await Promise.all([
      fetchSponsorsFromCrawlerSafe(settings),
      getAllSponsorClaims(),
      getAllUsers(),
    ]);

    const userById = new Map(allUsers.map(u => [u.id, u.username]));

    const crawlerSponsors = crawlerResult.sponsors;
    const crawlerAvailable = crawlerResult.available;

    const crawlerByUsername = new Map<string, CrawlerSponsor>();
    for (const sponsor of crawlerSponsors) {
      const key = normalizeValue(sponsor.fansDomainName);
      if (!key || crawlerByUsername.has(key)) continue;
      crawlerByUsername.set(key, sponsor);
    }

    const dbByUsername = new Map<string, SponsorClaim>();
    for (const claim of dbClaims) {
      const key = normalizeValue(claim.sponsor_username);
      if (!key || dbByUsername.has(key)) continue;
      dbByUsername.set(key, claim);
    }

    const allUsernames = Array.from(new Set([...crawlerByUsername.keys(), ...dbByUsername.keys()])).sort((a, b) =>
      a.localeCompare(b),
    );

    const merged: MergedSponsorRecord[] = allUsernames.map((username) => {
      const crawler = crawlerByUsername.get(username);
      const dbClaim = dbByUsername.get(username);
      const tierForDecision = crawler?.schemeName || dbClaim?.sponsor_tier;
      const sponsorRequired = tierRequiresSponsor(tierForDecision, configuredSponsorTiers);
      const expectedRole = sponsorRequired
        ? getExpectedRoleForTier(crawler?.schemeName || dbClaim?.sponsor_tier, settings)
        : undefined;
      const discrepancies = mapDiscrepancies(crawler, dbClaim, expectedRole, sponsorRequired, crawlerAvailable);

      return {
        username,
        dbUsername: dbClaim ? (userById.get(dbClaim.user_id) ?? undefined) : undefined,
        expectedRole,
        crawler: crawler
          ? {
              nickname: crawler.fansNickname || undefined,
              avatar: crawler.fansAvatar || undefined,
              tier: crawler.schemeName || undefined,
            }
          : null,
        db: dbClaim
          ? {
              userId: dbClaim.user_id,
              nickname: dbClaim.sponsor_nickname,
              avatar: dbClaim.sponsor_avatar,
              tier: dbClaim.sponsor_tier,
              appliedRole: dbClaim.applied_role,
              claimedAt: dbClaim.claimed_at,
              expiresAt: dbClaim.expired_at,
            }
          : null,
        discrepancies,
        hasDiscrepancy: discrepancies.length > 0,
      };
    });

    // Sort by expiration date (no-expiry first, then most recent expiration first)
    merged.sort((a, b) => {
      const aExpiry = a.db?.expiresAt ? new Date(a.db.expiresAt).getTime() : null;
      const bExpiry = b.db?.expiresAt ? new Date(b.db.expiresAt).getTime() : null;
      if (aExpiry === null && bExpiry === null) return 0;
      if (aExpiry === null) return -1; // a has no expiry, goes to front
      if (bExpiry === null) return 1;  // b has no expiry, goes to front
      return bExpiry - aExpiry; // descending order (latest expiry first)
    });

    const summary = {
      total: merged.length,
      missingInCrawler: merged.filter((s) => s.discrepancies.includes('missing_in_crawler')).length,
      tierMismatch: merged.filter((s) => s.discrepancies.includes('tier_mismatch')).length,
      roleMismatch: merged.filter((s) => s.discrepancies.includes('role_mismatch')).length,
      roleMappingMissing: merged.filter((s) => s.discrepancies.includes('role_mapping_missing')).length,
      dbExpiredButInCrawler: merged.filter((s) => s.discrepancies.includes('db_expired_but_in_crawler')).length,
      withDiscrepancy: merged.filter((s) => s.hasDiscrepancy).length,
    };

    // Detect users who have a configured sponsor role but no active sponsor claim
    const configuredSponsorRoleNames = new Set(
      (settings.roles || []).filter(r => r.sponsorTier).map(r => normalizeValue(r.name))
    );
    const activeClaimsByUserId = new Set(
      dbClaims.filter(c => !c.expired_at).map(c => c.user_id)
    );
    const usersWithRoleButNoClaim = allUsers.filter(u =>
      u.roles.some(r => configuredSponsorRoleNames.has(normalizeValue(r))) &&
      !activeClaimsByUserId.has(u.id)
    ).map(u => ({ userId: u.id, username: u.username, roles: u.roles }));

    return new Response(
      JSON.stringify({
        sponsors: merged,
        summary,
        crawlerAvailable,
        crawlerError: crawlerResult.error,
        usersWithRoleButNoClaim,
        fetchedAt: new Date().toISOString(),
        page: 1,
        totalPages: 1,
        total: merged.length,
        limit: merged.length,
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


