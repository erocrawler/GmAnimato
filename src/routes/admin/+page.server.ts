import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { getAdminSettings, getAllUsers, getVideosByUser } from '$lib/db';

export const load: PageServerLoad = async ({ locals, url }) => {
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
  
  // Pagination and search for users
  const userPage = parseInt(url.searchParams.get('userPage') || '1');
  const userSearch = url.searchParams.get('userSearch') || '';
  const userPageSize = 20;
  const allUsers = await getAllUsers();
  
  // Filter users by search query
  const filteredUsers = userSearch 
    ? allUsers.filter(user => 
        user.username.toLowerCase().includes(userSearch.toLowerCase()) ||
        user.email?.toLowerCase().includes(userSearch.toLowerCase())
      )
    : allUsers;
  
  const userTotal = filteredUsers.length;
  const userTotalPages = Math.ceil(userTotal / userPageSize);
  const userStart = (userPage - 1) * userPageSize;
  const userEnd = userStart + userPageSize;
  const paginatedUsers = filteredUsers.slice(userStart, userEnd);

  // Get video counts for paginated users
  const userStats = await Promise.all(
    paginatedUsers.map(async (user) => {
      const videos = await getVideosByUser(user.id);
      return {
        ...user,
        videoCount: videos.total,
      };
    })
  );

  return {
    settings,
    users: userStats,
    userPage,
    userTotalPages,
    userTotal,
    userSearch,
  };
};
