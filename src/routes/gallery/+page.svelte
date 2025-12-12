<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { _ } from 'svelte-i18n';
  import VideoList from '$lib/components/VideoList.svelte';
  import Pagination from '$lib/components/Pagination.svelte';
  import LayoutToggle from '$lib/components/LayoutToggle.svelte';
  
  let { data } = $props<{ data: { videos: any[]; user?: any; page: number; totalPages: number; total: number; filter: string; sortBy: 'date' | 'likes' } }>();
  let videos = $state(data.videos);
  let loading = $state(false);

  const queryParams = $derived(() => {
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
        <!-- Layout toggle -->
        <LayoutToggle />
        
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

  <VideoList
    videos={videos}
    type="gallery"

    loading={loading}
    pageSize={data.pageSize}
    queryParams={queryParams()}
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
</div>
