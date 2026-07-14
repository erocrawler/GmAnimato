<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { _ } from 'svelte-i18n';
  import VideoList from '$lib/components/VideoList.svelte';
  import Pagination from '$lib/components/Pagination.svelte';
  import LayoutToggle from '$lib/components/LayoutToggle.svelte';
  import ModelTypeFilter from '$lib/components/ModelTypeFilter.svelte';

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
      modelTypes: any[];
      modelTypeFilter: string[];
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
  let modelTypeFilter = $state<string[]>(data.modelTypeFilter || []);
  
  $effect(() => {
    videos = data.videos;
    sortBy = data.sortBy as 'upload' | 'completion';
    sortDirection = data.sortDirection as 'asc' | 'desc';
    filterStatus = data.statusFilter || 'all';
    modelTypeFilter = data.modelTypeFilter || [];
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

  function toggleModelType(id: string) {
    if (modelTypeFilter.includes(id)) modelTypeFilter = modelTypeFilter.filter((m) => m !== id);
    else modelTypeFilter = [...modelTypeFilter, id];
  }

  async function applyFilters() {
    const url = new URL(window.location.href);
    url.searchParams.set('page', '1');
    url.searchParams.set('sortBy', sortBy);
    url.searchParams.set('sortDirection', sortDirection);

    if (filterStatus !== 'all') url.searchParams.set('statusFilter', filterStatus);
    else url.searchParams.delete('statusFilter');

    url.searchParams.delete('modelType');
    for (const mt of modelTypeFilter) url.searchParams.append('modelType', mt);

    const targetUrl = url.toString();
    if (targetUrl === window.location.href) return;

    loading = true;
    videos = [];
    await goto(targetUrl);
  }

  const hasActiveFilters = $derived(filterStatus !== 'all' || modelTypeFilter.length > 0);
  
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
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
      <!-- Sort By + Direction Toggle -->
      <div class="form-control">
        <label class="label" for="sort-by-select">
          <span class="label-text font-semibold">{$_('videos.filters.sortBy')}</span>
        </label>
        <div class="join w-full">
          <select id="sort-by-select" bind:value={sortBy} onchange={applyFilters} class="select select-bordered join-item flex-1">
            <option value="upload">{$_('videos.filters.uploadTime')}</option>
            <option value="completion">{$_('videos.filters.completionTime')}</option>
          </select>
          <button class="btn join-item" title={sortDirection === 'asc' ? $_('videos.filters.asc') : $_('videos.filters.desc')} onclick={() => { sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'; applyFilters(); }}>
            {#if sortDirection === 'asc'}↑{:else}↓{/if}
          </button>
        </div>
      </div>

      <!-- Filter by Status -->
      <div class="form-control">
        <label class="label" for="status-filter-select">
          <span class="label-text font-semibold">{$_('videos.filters.status')}</span>
        </label>
        <select id="status-filter-select" bind:value={filterStatus} onchange={applyFilters} class="select select-bordered w-full">
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

      <!-- Model Type Filter (shared component) -->
      <ModelTypeFilter modelTypes={data.modelTypes || []} selected={modelTypeFilter} label={$_('admin.videos.modelType') || 'Model'} placeholderAll={$_('common.all') || 'All'} onToggle={(id) => { toggleModelType(id); applyFilters(); }} />
    </div>
    {#if hasActiveFilters}
      <div class="mt-3 flex gap-2">
        <button class="btn btn-ghost btn-xs" onclick={() => { filterStatus='all'; modelTypeFilter=[]; applyFilters(); }}>Clear filters</button>
      </div>
    {/if}
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
