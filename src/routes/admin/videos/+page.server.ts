import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { getAllUsers, getVideosByUser } from '$lib/db';

export const load: PageServerLoad = async ({ locals, url }) => {
  // Check if user is logged in and is admin
  if (!locals.user) {
    throw redirect(303, '/login');
  }

  if (!locals.user.roles?.includes('admin')) {
    throw redirect(303, '/');
  }

  const page = parseInt(url.searchParams.get('page') || '1');
  const pageSize = 30;
  const statusFilter = url.searchParams.get('status') || '';
  const userFilter = url.searchParams.get('user') || '';

  // Get all users to build video list
  const allUsers = await getAllUsers();
  
  // Collect all videos from all users
  const allVideosPromises = allUsers.map(async (user) => {
    const result = await getVideosByUser(user.id, 1, 1000); // Get up to 1000 videos per user
    return result.videos.map(v => ({
      ...v,
      username: user.username,
    }));
  });
  
  const allVideosNested = await Promise.all(allVideosPromises);
  let allVideos = allVideosNested.flat();

  // Filter by status
  if (statusFilter) {
    allVideos = allVideos.filter(v => v.status === statusFilter);
  }

  // Filter by user
  if (userFilter) {
    allVideos = allVideos.filter(v => v.username.toLowerCase().includes(userFilter.toLowerCase()));
  }

  // Sort by created_at descending
  allVideos.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const total = allVideos.length;
  const totalPages = Math.ceil(total / pageSize);
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const videos = allVideos.slice(start, end);

  return {
    videos,
    page,
    totalPages,
    total,
    pageSize,
    statusFilter,
    userFilter,
  };
};
