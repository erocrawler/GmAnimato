<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { _ } from 'svelte-i18n';
  import VideoList from '$lib/components/VideoList.svelte';
  import Pagination from '$lib/components/Pagination.svelte';
  import LayoutToggle from '$lib/components/LayoutToggle.svelte';

  let { data } = $props<{ data: { videos: any[]; page: number; totalPages: number; total: number; pageSize: number } }>();
  let videos = $state(data.videos);
  let loading = $state(false);
  let layout = $state<'grid' | 'compact'>('grid');
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  
  async function pollActiveVideos() {
    const activeVideos = videos.filter((v: any) => v.status === 'in_queue' || v.status === 'processing');
    
    if (activeVideos.length === 0) {
      return;
    }

    for (const video of activeVideos) {
      try {
        const res = await fetch(`/api/video/${video.id}/status`);
        if (res.ok) {
          const statusData = await res.json();
          console.log(`[Video List Poll] Status for ${video.id}:`, statusData);
          
          // Update the video in the list if status or progress changed
          if (statusData.status !== video.status || 
              statusData.progress_percentage !== video.progress_percentage) {
            videos = videos.map((v: any) => 
              v.id === video.id ? { 
                ...v, 
                status: statusData.status,
                progress_percentage: statusData.progress_percentage,
                progress_details: statusData.progress_details
              } : v
            );
          }
        }
      } catch (err) {
        console.error(`[Video List Poll] Failed to poll status for ${video.id}:`, err);
      }
    }
  }

  onMount(() => {
    const hasActiveVideos = videos.some((v: any) => v.status === 'in_queue' || v.status === 'processing');
    if (hasActiveVideos) {
      pollActiveVideos(); // Initial poll
      pollInterval = setInterval(pollActiveVideos, 10000); // Poll every 10 seconds
    }
  });

  onDestroy(() => {
    if (pollInterval) {
      clearInterval(pollInterval);
    }
  });
  
  async function deleteVideo(id: string) {
    if (!confirm($_('videos.actions.deleteConfirm'))) {
      return;
    }
    
    try {
      const res = await fetch(`/api/video/${id}`, {
        method: 'DELETE'
      });
      
      if (res.ok) {
        // Reload the page to refresh the list
        window.location.reload();
      } else {
        alert('Failed to delete video');
      }
    } catch (err) {
      alert('Error deleting video: ' + err);
    }
  }

  async function setPage(newPage: number) {
    loading = true;
    videos = []; // Clear current videos immediately for visual feedback
    const url = new URL(window.location.href);
    url.searchParams.set('page', newPage.toString());
    await goto(url.toString());
  }

  $effect(() => {
    videos = data.videos;
    loading = false;
  });
</script>

<div class="max-w-6xl mx-auto">
  <div class="flex justify-between items-center mb-8">
    <h1 class="text-4xl font-bold">{$_('videos.title')}</h1>
    <div class="flex gap-4 items-center">
      <LayoutToggle />
      <a href="/new" class="btn btn-primary">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
        </svg>
        {$_('videos.createNew')}
      </a>
    </div>
  </div>

  <VideoList
    videos={videos}
    type="user"
    loading={loading}
    pageSize={data.pageSize}
    emptyMessage={$_('videos.empty.message')}
    emptyIcon="📹"
    emptyAction={{ label: $_('videos.empty.button'), href: '/new' }}
    onDelete={deleteVideo}
  />

  <Pagination
    currentPage={data.page}
    totalPages={data.totalPages}
    onPageChange={setPage}
  />
</div>
