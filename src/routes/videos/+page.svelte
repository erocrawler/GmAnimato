<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { _ } from 'svelte-i18n';

  let { data } = $props<{ data: { videos: any[]; page: number; totalPages: number; total: number; pageSize: number } }>();
  let videos = $state(data.videos);
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  
  async function pollActiveVideos() {
    const activeVideos = videos.filter(v => v.status === 'in_queue' || v.status === 'processing');
    
    if (activeVideos.length === 0) {
      return;
    }

    for (const video of activeVideos) {
      try {
        const res = await fetch(`/api/video/${video.id}/status`);
        if (res.ok) {
          const statusData = await res.json();
          console.log(`[Video List Poll] Status for ${video.id}:`, statusData);
          
          // Update the video in the list if status changed
          if (statusData.status && statusData.status !== video.status) {
            videos = videos.map(v => 
              v.id === video.id ? { ...v, status: statusData.status } : v
            );
          }
        }
      } catch (err) {
        console.error(`[Video List Poll] Failed to poll status for ${video.id}:`, err);
      }
    }
  }

  onMount(() => {
    const hasActiveVideos = videos.some(v => v.status === 'in_queue' || v.status === 'processing');
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
    const url = new URL(window.location.href);
    url.searchParams.set('page', newPage.toString());
    await goto(url.toString());
  }

  function getStatusText(status: string): string {
    const statusMap: Record<string, string> = {
      'uploaded': $_('videos.status.uploaded'),
      'in_queue': $_('videos.status.inQueue'),
      'processing': $_('videos.status.processing'),
      'completed': $_('videos.status.completed'),
      'failed': $_('videos.status.failed')
    };
    return statusMap[status] || status;
  }
</script>

<div class="max-w-6xl mx-auto">
  <div class="flex justify-between items-center mb-8">
    <h1 class="text-4xl font-bold">{$_('videos.title')}</h1>
    <a href="/new" class="btn btn-primary">
      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
      </svg>
      {$_('videos.createNew')}
    </a>
  </div>

  {#if data.videos.length === 0}
    <div class="hero min-h-[50vh] bg-base-200 rounded-lg">
      <div class="hero-content text-center">
        <div class="max-w-md">
          <div class="text-6xl mb-4">📹</div>
          <h2 class="text-3xl font-bold mb-4">{$_('videos.empty.title')}</h2>
          <p class="mb-6">{$_('videos.empty.message')}</p>
          <a href="/new" class="btn btn-primary btn-lg">{$_('videos.empty.button')}</a>
        </div>
      </div>
    </div>
  {:else}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {#each videos as v}
        <div class="card bg-base-100 shadow-xl image-full">
          {#if v.original_image_url}
            <figure>
              <img src={v.original_image_url} alt="thumbnail" class="w-full h-full object-cover" />
            </figure>
          {:else}
            <figure class="bg-base-300">
              <div class="w-full h-full flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-24 w-24 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
            </figure>
          {/if}
          <div class="card-body">
            <div class="flex items-center gap-2 mb-2">
              <div class="badge badge-lg" 
                class:badge-success={v.status === 'completed'}
                class:badge-warning={v.status === 'processing' || v.status === 'in_queue'}
                class:badge-info={v.status === 'uploaded'}
                class:badge-error={v.status === 'failed'}
              >
                {getStatusText(v.status)}
              </div>
            </div>
            
            {#if v.prompt}
              <p class="text-sm line-clamp-2 mb-2">{v.prompt}</p>
            {/if}
            
            {#if v.status === "completed"}
              <div class="card-actions justify-end mt-auto">
                <a href="/videos/{v.id}" class="btn btn-sm btn-primary">{$_('videos.actions.view')}</a>
                <button class="btn btn-sm btn-error" onclick={() => deleteVideo(v.id)}>{$_('common.delete')}</button>
              </div>
            {:else if v.status === "processing" || v.status === "in_queue"}
              <div class="card-actions justify-end mt-auto">
                <a href="/new/review/{v.id}" class="btn btn-sm btn-primary">{$_('review.viewStatus')}</a>
              </div>
            {:else if v.status === "uploaded"}
              <div class="card-actions justify-end mt-auto">
                <a href="/new/review/{v.id}" class="btn btn-sm btn-primary">{$_('review.continueSetup')}</a>
                <button class="btn btn-sm btn-error" onclick={() => deleteVideo(v.id)}>{$_('common.delete')}</button>
              </div>
            {:else}
              <div class="card-actions justify-end mt-auto">
                <a href="/new/review/{v.id}" class="btn btn-sm btn-error">{$_('videos.actions.retry')}</a>
                <button class="btn btn-sm btn-error" onclick={() => deleteVideo(v.id)}>{$_('common.delete')}</button>
              </div>
            {/if}
          </div>
        </div>
      {/each}
    </div>

    <!-- Pagination -->
    {#if data.totalPages > 1}
      <div class="flex justify-center mt-8">
        <div class="join">
          <button 
            class="join-item btn" 
            disabled={data.page === 1}
            onclick={() => setPage(data.page - 1)}
          >
            «
          </button>
          {#each Array.from({ length: data.totalPages }, (_, i) => i + 1) as pageNum}
            {#if pageNum === 1 || pageNum === data.totalPages || Math.abs(pageNum - data.page) <= 2}
              <button 
                class="join-item btn" 
                class:btn-active={pageNum === data.page}
                onclick={() => setPage(pageNum)}
              >
                {pageNum}
              </button>
            {:else if pageNum === data.page - 3 || pageNum === data.page + 3}
              <button class="join-item btn btn-disabled">...</button>
            {/if}
          {/each}
          <button 
            class="join-item btn" 
            disabled={data.page === data.totalPages}
            onclick={() => setPage(data.page + 1)}
          >
            »
          </button>
        </div>
      </div>
    {/if}
  {/if}
</div>
