<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { _ } from 'svelte-i18n';
  import VideoList from '$lib/components/VideoList.svelte';
  import Pagination from '$lib/components/Pagination.svelte';
  import LayoutToggle from '$lib/components/LayoutToggle.svelte';

  let { data } = $props<{ 
    data: { 
      videos: any[]; 
      page: number; 
      totalPages: number; 
      total: number; 
      pageSize: number;
      sortBy: string;
      sortDirection: string;
      status?: string;
      isPublished?: string;
    } 
  }>();
  let videos = $state<any[]>([]);
  let loading = $state(false);
  let layout = $state<'grid' | 'compact'>('grid');
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  
  // Filter and sort state
  let sortBy = $state<'upload' | 'completion'>(data.sortBy as 'upload' | 'completion');
  let sortDirection = $state<'asc' | 'desc'>(data.sortDirection as 'asc' | 'desc');
  let filterStatus = $state<string>(data.statusFilter || 'all');
  
  $effect(() => {
    videos = data.videos;
    sortBy = data.sortBy as 'upload' | 'completion';
    sortDirection = data.sortDirection as 'asc' | 'desc';
    filterStatus = data.statusFilter || 'all';
  });
  
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

  async function applyFilters() {
    const url = new URL(window.location.href);
    url.searchParams.set('page', '1'); // Reset to page 1 when filters change
    url.searchParams.set('sortBy', sortBy);
    url.searchParams.set('sortDirection', sortDirection);
    
    if (filterStatus !== 'all') {
      url.searchParams.set('statusFilter', filterStatus);
    } else {
      url.searchParams.delete('statusFilter');
    }
    
    const targetUrl = url.toString();
    if (targetUrl === window.location.href) {
      return;
    }

    loading = true;
    videos = [];
    await goto(targetUrl);
  }

  // Check if filters are active (not in default state)
  const hasActiveFilters = $derived(filterStatus !== 'all');
  
  // Conditionally set empty state message and action
  const emptyMessage = $derived(
    hasActiveFilters 
      ? $_('videos.empty.filtered')
      : $_('videos.empty.message')
  );
  
  const emptyAction = $derived(
    hasActiveFilters
      ? null
      : { label: $_('videos.empty.button'), href: '/new' }
  );

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

  <!-- Filter and Sort Controls -->
  <div class="mb-6 p-4 bg-base-200 rounded-lg">
    <div class="flex flex-col md:flex-row md:items-end gap-4">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 flex-1">
        <!-- Sort By + Direction Toggle -->
        <div class="form-control">
          <label class="label" for="sort-by-select">
            <span class="label-text font-semibold">{$_('videos.filters.sortBy')}</span>
          </label>
          <div class="join">
            <select id="sort-by-select" bind:value={sortBy} onchange={applyFilters} class="select select-bordered join-item">
              <option value="upload">{$_('videos.filters.uploadTime')}</option>
              <option value="completion">{$_('videos.filters.completionTime')}</option>
            </select>
            <button
              class="btn join-item"
              title={sortDirection === 'asc' ? $_('videos.filters.asc') : $_('videos.filters.desc')}
              aria-label={$_('videos.filters.sortDirection')}
              onclick={() => { sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'; applyFilters(); }}
            >
              {#if sortDirection === 'asc'}
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v14m0-14l-4 4m4-4l4 4" />
                </svg>
              {:else}
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19V5m0 14l-4-4m4 4l4-4" />
                </svg>
              {/if}
            </button>
          </div>
        </div>

        <!-- Filter by Status (includes published state) -->
        <div class="form-control">
          <label class="label" for="status-filter-select">
            <span class="label-text font-semibold">{$_('videos.filters.status')}</span>
          </label>
          <select id="status-filter-select" bind:value={filterStatus} onchange={applyFilters} class="select select-bordered">
            <option value="all">{$_('videos.filters.allVideos')}</option>
            <option value="uploaded">{$_('videos.filters.uploaded')}</option>
            <option value="in_queue">{$_('videos.filters.inQueue')}</option>
            <option value="processing">{$_('videos.filters.processing')}</option>
            <option value="completed">{$_('videos.filters.completed')}</option>
            <option value="completed-published">{$_('videos.filters.completedPublished')}</option>
            <option value="completed-unpublished">{$_('videos.filters.completedUnpublished')}</option>
            <option value="failed">{$_('videos.filters.failed')}</option>
          </select>
        </div>
      </div>
    </div>
  </div>

  <VideoList
    videos={videos}
    type="user"
    loading={loading}
    pageSize={data.pageSize}
    emptyMessage={emptyMessage}
    emptyIcon="📹"
    emptyAction={emptyAction}
    onDelete={deleteVideo}
  />

  <Pagination
    currentPage={data.page}
    totalPages={data.totalPages}
    onPageChange={setPage}
  />
</div>
