<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { _ } from 'svelte-i18n';
  
  let { data } = $props<{ data: { videos: any[]; user?: any; page: number; totalPages: number; total: number; filter: string } }>();
  let videos = $state(data.videos);

  $effect(() => {
    videos = data.videos;
  });

  async function setFilter(mode: 'all' | 'liked') {
    const url = new URL(window.location.href);
    url.searchParams.set('filter', mode);
    url.searchParams.set('page', '1'); // Reset to first page when changing filter
    await goto(url.toString());
  }

  async function setPage(newPage: number) {
    const url = new URL(window.location.href);
    url.searchParams.set('page', newPage.toString());
    await goto(url.toString());
  }

  async function toggleLike(videoId: string, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    
    try {
      const res = await fetch(`/api/video/${videoId}/like`, {
        method: 'POST'
      });
      
      if (res.ok) {
        const result = await res.json();
        // Update the video in the list
        videos = videos.map((v: any) => 
          v.id === videoId ? { ...v, likesCount: result.likesCount, isLiked: result.isLiked } : v
        );
      }
    } catch (err) {
      console.error('Failed to toggle like:', err);
    }
  }

</script>

<div class="max-w-7xl mx-auto">
  <div class="mb-8">
    <div class="flex justify-between items-end mb-4">
      <div>
        <h1 class="text-4xl font-bold mb-2">{$_('gallery.title')}</h1>
        <p class="text-lg opacity-70">{$_('gallery.subtitle')}</p>
      </div>
      {#if data.user}
        <div class="tabs tabs-boxed">
          <button 
            class="tab" 
            class:tab-active={data.filter === 'all'}
            onclick={() => setFilter('all')}
          >
            {$_('gallery.filters.all')}
          </button>
          <button 
            class="tab" 
            class:tab-active={data.filter === 'liked'}
            onclick={() => setFilter('liked')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 mr-1" fill="currentColor" viewBox="0 0 24 24">
              <path d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
            {$_('gallery.filters.liked')}
          </button>
        </div>
      {/if}
    </div>
  </div>

  {#if data.videos.length === 0}
    <div class="hero min-h-[50vh] bg-base-200 rounded-lg">
      <div class="hero-content text-center">
        <div class="max-w-md">
          <div class="text-6xl mb-4">{data.filter === 'liked' ? '💔' : '🖼️'}</div>
          <h2 class="text-3xl font-bold mb-4">
            {data.filter === 'liked' ? $_('gallery.empty.noLiked') : $_('gallery.empty.noVideos')}
          </h2>
          <p class="mb-6">
            {data.filter === 'liked' 
              ? $_('gallery.empty.noLikedMessage') 
              : $_('gallery.empty.noVideosMessage')}
          </p>
          {#if data.filter === 'liked'}
            <button class="btn btn-primary btn-lg" onclick={() => setFilter('all')}>
              {$_('gallery.empty.browseGallery')}
            </button>
          {:else}
            <a href="/new" class="btn btn-primary btn-lg">{$_('gallery.empty.createAndPublish')}</a>
          {/if}
        </div>
      </div>
    </div>
  {:else}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
      {#each videos as v}
        <a href="/gallery/{v.id}" class="card bg-base-100 shadow-xl hover:shadow-2xl transition-shadow cursor-pointer">
          {#if v.original_image_url}
            <figure class="aspect-video bg-base-200">
              <img src={v.original_image_url} alt={v.prompt || 'Video thumbnail'} class="w-full h-full object-cover" />
            </figure>
            <div class="card-body p-4">
              <h2 class="card-title text-base">
                {v.prompt || $_('gallery.untitled')}
              </h2>
              <div class="flex items-center justify-between mt-2">
                <div class="flex items-center gap-2 text-sm opacity-60">
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  <span>{$_('gallery.aiGenerated')}</span>
                </div>
                <button 
                  class="btn btn-ghost btn-sm gap-1" 
                  class:text-error={v.isLiked}
                  onclick={(e) => toggleLike(v.id, e)}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill={v.isLiked ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                  </svg>
                  <span>{v.likesCount || 0}</span>
                </button>
              </div>
            </div>
          {:else}
            <div class="card-body">
              <div class="flex items-center justify-center h-48 bg-base-200 rounded-lg">
                <div class="text-center">
                  <div class="loading loading-spinner loading-lg text-primary"></div>
                  <p class="mt-4 text-sm opacity-60">{$_('common.processing')}...</p>
                </div>
              </div>
            </div>
          {/if}
        </a>
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
