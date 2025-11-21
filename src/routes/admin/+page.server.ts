import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { getAdminSettings, getAllUsers, getVideosByUser } from '$lib/db';

export const load: PageServerLoad = async ({ locals }) => {
  // Check if user is logged in
  if (!locals.user) {
    throw redirect(303, '/login');
  }

  // Check if user has admin role
  if (!locals.user.roles?.includes('admin')) {
    throw redirect(303, '/');
  }

  // Load admin data
  const settings = await getAdminSettings();
  const users = await getAllUsers();

  // Get video counts for each user
  const userStats = await Promise.all(
    users.map(async (user) => {
      const videos = await getVideosByUser(user.id);
      return {
        ...user,
        videoCount: videos.length,
      };
    })
  );

  return {
    settings,
    users: userStats,
  };
};
