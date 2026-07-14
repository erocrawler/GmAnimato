<script lang="ts">
  import { goto } from '$app/navigation';
  import { _ } from 'svelte-i18n';
  import VideoList from '$lib/components/VideoList.svelte';
  import Pagination from '$lib/components/Pagination.svelte';
  import LayoutToggle from '$lib/components/LayoutToggle.svelte';
  import ShortVideoFeed from '$lib/components/ShortVideoFeed.svelte';
  
  let { data } = $props<{ data: { videos: any[]; user?: any; page: number; totalPages: number; total: number; filter: string; sortBy: 'date' | 'likes'; mode: string | null; galleryState?: any } }>();
  // svelte-ignore state_referenced_locally
  let videos = $state(data.videos);
  let loading = $state(false);

  // Server is authoritative for mode (?mode=short). localStorage is only a hint
  // for auto-redirect when user lands on /gallery without a mode param.
  // We must NOT render the feed with wrong data before redirecting, otherwise
  // the user sees latest videos and the "X new videos" banner at the same time.
  let shortMode = $derived(data.mode === 'short');
  let pendingShortRedirect = $state(false);

  $effect(() => {
    if (typeof localStorage === 'undefined') return;
    if (data.mode === 'short') {
      pendingShortRedirect = false;
      return;
    }
    if (localStorage.getItem('gallery-mode') !== 'short') {
      pendingShortRedirect = false;
      return;
    }
    const url = new URL(window.location.href);
    // User explicitly chose grid — respect it
    if (url.searchParams.get('mode') === 'grid') {
      pendingShortRedirect = false;
      return;
    }
    pendingShortRedirect = true;
    url.searchParams.set('mode', 'short');
    url.searchParams.delete('page');
    goto(url.toString(), { replaceState: true });
  });

  const queryParams = $derived.by(() => {
    const params = new URLSearchParams();
    if (data.sortBy !== 'date') params.set('sort', data.sortBy);
    if (data.page !== 1) params.set('page', data.page.toString());
    if (data.filter !== 'all') params.set('filter', data.filter);
    return params.toString();
  });

  $effect(() => {
    videos = data.videos;
    loading = false;
  });

  async function setFilter(mode: 'all' | 'liked') {
    loading = true;
    videos = [];
    const url = new URL(window.location.href);
    url.searchParams.set('filter', mode);
    url.searchParams.set('page', '1');
    await goto(url.toString());
  }

  async function toggleShortMode() {
    const url = new URL(window.location.href);
    if (shortMode) {
      url.searchParams.set('mode', 'grid');
      localStorage.setItem('gallery-mode', 'grid');
    } else {
      url.searchParams.set('mode', 'short');
      url.searchParams.delete('page');
      localStorage.setItem('gallery-mode', 'short');
    }
    await goto(url.toString());
  }

  async function setSort(sortBy: 'date' | 'likes') {
    loading = true;
    videos = [];
    const url = new URL(window.location.href);
    url.searchParams.set('sort', sortBy);
    url.searchParams.set('page', '1');
    await goto(url.toString());
  }

  async function setPage(newPage: number) {
    loading = true;
    videos = [];
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
      <div class="flex gap-4 items-center">
        <!-- Short video mode toggle -->
        <button
          class="btn btn-sm {shortMode ? 'btn-primary' : 'btn-ghost'} gap-2"
          onclick={toggleShortMode}
          aria-label={$_('gallery.short.toggle')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 4v16M17 4v16M3 8h4M3 16h4M17 8h4M17 16h4M3 12h18" />
          </svg>
          {$_('gallery.short.toggle')}
        </button>

        <!-- Layout toggle -->
        {#if !shortMode}
          <LayoutToggle />
        {/if}
        
        <!-- Sort selector -->
        <div class="form-control">
          <select 
            class="select select-bordered select-sm"
            value={data.sortBy}
            onchange={(e) => setSort(e.currentTarget.value as 'date' | 'likes')}
          >
            <option value="date">{$_('gallery.sort.date')}</option>
            <option value="likes">{$_('gallery.sort.likes')}</option>
          </select>
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
  </div>

  {#if pendingShortRedirect}
    <div class="h-[calc(100vh-4rem)] bg-black rounded-lg flex items-center justify-center">
      <span class="loading loading-spinner loading-lg text-white"></span>
    </div>
  {:else if shortMode}
    {#if loading}
      <div class="h-[calc(100vh-4rem)] bg-black rounded-lg flex items-center justify-center">
        <span class="loading loading-spinner loading-lg text-white"></span>
      </div>
    {:else if videos.length === 0}
      <div class="hero min-h-[50vh] bg-base-200 rounded-lg">
        <div class="hero-content text-center">
          <div class="max-w-md">
            <div class="text-6xl mb-4">{data.filter === 'liked' ? '💔' : '🖼️'}</div>
            <p class="text-lg mb-6">{data.filter === 'liked' ? $_('gallery.empty.noLikedMessage') : $_('gallery.empty.noVideosMessage')}</p>
          </div>
        </div>
      </div>
    {:else}
      <ShortVideoFeed initialVideos={videos} sortBy={data.sortBy} filter={data.filter as 'all' | 'liked'} galleryState={data.galleryState} />
    {/if}
  {:else}
    <VideoList
      videos={videos}
      type="gallery"

      loading={loading}
      pageSize={data.pageSize}
      queryParams={queryParams}
      emptyMessage={data.filter === 'liked' ? $_('gallery.empty.noLikedMessage') : $_('gallery.empty.noVideosMessage')}
      emptyIcon={data.filter === 'liked' ? '💔' : '🖼️'}
      emptyAction={data.filter === 'liked' 
        ? null
        : { label: $_('gallery.empty.createAndPublish'), href: '/new' }}
      onToggleLike={toggleLike}
    />

    <Pagination
      currentPage={data.page}
      totalPages={data.totalPages}
      onPageChange={setPage}
    />
  {/if}
</div>
