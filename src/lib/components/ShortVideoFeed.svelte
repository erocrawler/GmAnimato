<script lang="ts">
  import { _ } from 'svelte-i18n';

  interface ShortVideo {
    id: string;
    final_video_url?: string;
    original_image_url?: string;
    prompt?: string;
    username?: string;
    likesCount?: number;
    isLiked?: boolean;
  }

  interface Props {
    initialVideos: ShortVideo[];
    sortBy: 'date' | 'likes';
    filter: 'all' | 'liked';
    galleryState?: {
      lastVideoId?: string;
      newestSeenId?: string;
      lastVisitAt?: string;
      history?: string[];
    } | null;
  }

  let { initialVideos, sortBy, filter, galleryState }: Props = $props();

  let videos = $state<ShortVideo[]>([...initialVideos]);
  let loading = $state(false);
  let hasMore = $state(true);
  let activeIndex = $state(0);
  let container: HTMLElement | null = $state(null);
  let isFullscreen = $state(false);

  // --- Position tracking & state persistence ---
  let newCount = $state<number | null>(null);
  let showHistory = $state(false);
  let historyVideos = $state<ShortVideo[]>([]);
  let loadingHistory = $state(false);
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;

  // Check for new videos on mount
  $effect(() => {
    if (galleryState?.newestSeenId) {
      fetch(`/api/gallery/short/count?since=${galleryState.newestSeenId}`)
        .then((r) => r.json())
        .then((data) => { newCount = data.count; })
        .catch(() => {});
    }
  });

  // Debounced state save — called when user changes active video
  function debouncedSaveState(updates: { lastVideoId?: string; newestSeenId?: string }) {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      const currentVideo = videos[activeIndex];
      if (!currentVideo) return;
      const history = galleryState?.history || [];
      const newHistory = [currentVideo.id, ...history.filter((id) => id !== currentVideo.id)].slice(0, 20);

      // newestSeenId must track the GLOBALLY newest video we've ever seen at the
      // top of a fresh feed. On a resume load (startAtId) videos[0] is the resume
      // position — NOT the newest — so we must NOT clobber newestSeenId with it.
      // Only treat videos[0] as the newest when:
      //   - it was explicitly provided (e.g. jumpToTop), or
      //   - we have no saved newestSeenId yet AND this isn't a resume load.
      let newestToSend = updates.newestSeenId;
      if (newestToSend === undefined && !galleryState?.newestSeenId) {
        const firstIsResume =
          !!galleryState?.lastVideoId && videos[0]?.id === galleryState.lastVideoId;
        if (!firstIsResume) newestToSend = videos[0]?.id;
      }

      const body: Record<string, unknown> = {
        lastVideoId: updates.lastVideoId ?? currentVideo.id,
        history: newHistory,
      };
      // Only emit newestSeenId when we have a real value — omitting it makes the
      // server keep its existing value via `?? existing`.
      if (newestToSend !== undefined) body.newestSeenId = newestToSend;

      fetch('/api/gallery/short', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => {});
    }, 2000);
  }

  function jumpToTop() {
    loading = true;
    const params = new URLSearchParams({ limit: '10', sort: sortBy, filter });
    fetch(`/api/gallery/short?${params}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.videos.length > 0) {
          videos = data.videos;
          hasMore = data.hasMore;
          newCount = null;
          debouncedSaveState({ newestSeenId: videos[0]?.id });
          container?.scrollTo({ top: 0, behavior: 'smooth' });
        }
      })
      .finally(() => { loading = false; });
  }

  async function loadHistory() {
    if (!galleryState?.history?.length) return;
    loadingHistory = true;
    showHistory = true;
    try {
      const historyItems = await Promise.all(
        galleryState.history.slice(0, 10).map(async (id) => {
          try {
            const res = await fetch(`/api/gallery/short?around=${id}&limit=1`);
            const data = await res.json();
            return data.videos?.[0] || null;
          } catch { return null; }
        })
      );
      historyVideos = historyItems.filter(Boolean) as ShortVideo[];
    } finally {
      loadingHistory = false;
    }
  }

  function jumpToVideo(videoId: string) {
    loading = true;
    showHistory = false;
    const params = new URLSearchParams({ limit: '10', sort: sortBy, filter });
    params.set('around', videoId);
    fetch(`/api/gallery/short?${params}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.videos.length > 0) {
          videos = data.videos;
          hasMore = data.hasMore;
          requestAnimationFrame(() => container?.scrollTo({ top: 0, behavior: 'smooth' }));
        }
      })
      .finally(() => { loading = false; });
  }

  // --- Fullscreen ---
  function toggleFullscreen() {
    if (!container) return;
    if (!document.fullscreenElement) {
      container.requestFullscreen?.().then(() => { isFullscreen = true; }).catch(() => {});
    } else {
      document.exitFullscreen?.().then(() => { isFullscreen = false; }).catch(() => {});
    }
  }
  $effect(() => {
    function onFsChange() { isFullscreen = !!document.fullscreenElement; }
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  });

  // --- Infinite scroll ---
  async function loadMore() {
    if (loading || !hasMore) return;
    loading = true;
    try {
      const lastId = videos[videos.length - 1]?.id;
      const params = new URLSearchParams({
        limit: '10',
        sort: sortBy,
        filter,
      });
      if (lastId) params.set('after', lastId);

      const res = await fetch(`/api/gallery/short?${params}`);
      if (res.ok) {
        const data = await res.json();
        if (data.videos.length === 0) {
          hasMore = false;
        } else {
          videos = [...videos, ...data.videos];
          hasMore = data.hasMore;
        }
      }
    } catch (err) {
      console.error('Failed to load more videos:', err);
    } finally {
      loading = false;
    }
  }

  // --- Intersection observer for autoplay + position tracking ---
  let observer: IntersectionObserver | null = null;

  $effect(() => {
    if (!container) return;
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
            const idx = parseInt(entry.target.getAttribute('data-index') || '0');
            activeIndex = idx;
            // Autoplay the active video, pause others
            const activeVideo = entry.target.querySelector('video');
            if (activeVideo) {
              activeVideo.play().catch(() => {});
            }
            // Pause all other videos
            container?.querySelectorAll('video').forEach((v) => {
              if (v !== activeVideo) v.pause();
            });
            // Load more when near the end
            if (idx >= videos.length - 3 && hasMore) {
              loadMore();
            }
            // Track position (debounced save to DB)
            debouncedSaveState({});
          }
        }
      },
      { root: container, threshold: [0.6] }
    );
    // Observe all video slides
    container?.querySelectorAll('[data-index]').forEach((el) => {
      observer?.observe(el);
    });
    return () => {
      observer?.disconnect();
      observer = null;
    };
  });

  // Re-observe when new videos are loaded
  $effect(() => {
    videos; // dependency
    if (observer && container) {
      container.querySelectorAll('[data-index]').forEach((el) => {
        observer.observe(el);
      });
    }
  });

  // Preload URLs: the next 2 videos after the active one
  let preloadUrls = $derived(
    videos
      .slice(activeIndex + 1, activeIndex + 3)
      .flatMap((v) => (v.final_video_url ? [v.final_video_url] : []))
  );

  async function toggleLike(videoId: string) {
    try {
      const res = await fetch(`/api/video/${videoId}/like`, { method: 'POST' });
      if (res.ok) {
        const result = await res.json();
        videos = videos.map((v) =>
          v.id === videoId
            ? { ...v, likesCount: result.likesCount, isLiked: result.isLiked }
            : v
        );
      }
    } catch (err) {
      console.error('Failed to toggle like:', err);
    }
  }
</script>

<svelte:head>
  {#each preloadUrls as url (url)}
    <link rel="preload" as="video" href={url} />
  {/each}
</svelte:head>

<div class="relative h-[calc(100vh-4rem)]" class:fullscreen-mode={isFullscreen}>
  <!-- Fixed overlay toolbar - stays pinned while scrolling, but below drawer (drawer is z-50) -->
  <div class="absolute top-0 left-0 right-0 z-[5] pointer-events-none">
    <div class="relative p-3 flex justify-between items-start">
      <!-- Top-left: History dropdown button -->
      {#if galleryState?.history?.length}
        <div class="pointer-events-auto">
          <div class="relative">
            <button
              class="w-10 h-10 rounded-full bg-black/40 backdrop-blur flex items-center justify-center transition-transform active:scale-90"
              onclick={() => showHistory ? (showHistory = false) : loadHistory()}
              aria-label={$_('gallery.short.history')}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
            {#if showHistory}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="fixed inset-0 z-[5]" onclick={() => showHistory = false} role="presentation"></div>
              <div class="absolute top-12 left-0 z-[5] bg-base-100 rounded-box shadow-xl p-2 w-64 max-h-80 overflow-y-auto">
                {#if loadingHistory}
                  <div class="flex justify-center py-4"><span class="loading loading-spinner loading-md"></span></div>
                {:else if historyVideos.length === 0}
                  <p class="text-sm opacity-60 px-2 py-3">{$_('gallery.short.noHistory')}</p>
                {:else}
                  <p class="text-xs font-semibold opacity-60 px-2 pb-1">{$_('gallery.short.history')}</p>
                  {#each historyVideos as hv (hv.id)}
                    <button
                      class="flex items-center gap-2 p-2 rounded-lg hover:bg-base-200 w-full text-left"
                      onclick={() => jumpToVideo(hv.id)}
                    >
                      {#if hv.original_image_url}
                        <img src={hv.original_image_url} alt="" class="w-10 h-10 rounded object-cover shrink-0" />
                      {:else}
                        <div class="w-10 h-10 rounded bg-base-300 shrink-0"></div>
                      {/if}
                      <span class="text-sm line-clamp-2 flex-1">{hv.prompt || $_('gallery.untitled')}</span>
                    </button>
                  {/each}
                {/if}
              </div>
            {/if}
          </div>
        </div>
      {:else}
        <div></div>
      {/if}

      <!-- Top-center: New videos banner -->
      {#if newCount && newCount > 0}
        <div class="pointer-events-auto absolute left-1/2 -translate-x-1/2">
          <button class="btn btn-sm btn-primary gap-2 shadow-lg" onclick={jumpToTop}>
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 10l7-7m0 0l7 7m-7-7v18" />
            </svg>
            {newCount === -1
              ? $_('gallery.short.manyNew')
              : $_('gallery.short.newVideos', { values: { count: newCount } })}
          </button>
        </div>
      {/if}

      <!-- Top-right: Fullscreen button -->
      <div class="pointer-events-auto">
        <button
          class="w-10 h-10 rounded-full bg-black/40 backdrop-blur flex items-center justify-center transition-transform active:scale-90"
          onclick={toggleFullscreen}
          aria-label={isFullscreen ? $_('gallery.short.exitFullscreen') : $_('gallery.short.fullscreen')}
        >
          {#if isFullscreen}
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          {:else}
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l4 4m8-4h4m0 0v4m0-4l-4 4M4 16v4m0 0h4m-4 0l4-4m8 4h4m0 0v-4m0 4l-4-4" />
            </svg>
          {/if}
        </button>
      </div>
    </div>
  </div>

  <div
    bind:this={container}
    class="h-[calc(100vh-4rem)] overflow-y-auto snap-y snap-mandatory scrollbar-hide relative"
    class:fullscreen-scroll={isFullscreen}
  >
  {#each videos as v, i (v.id)}
    <div
      data-index={i}
      class="snap-start snap-always h-[calc(100vh-4rem)] fullscreen-mode:h-screen relative flex items-center justify-center bg-black"
    >
      {#if v.final_video_url}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          src={v.final_video_url}
          class="h-full w-full object-contain"
          loop
          muted
          playsinline
          preload={i >= activeIndex && i <= activeIndex + 2 ? 'auto' : 'none'}
        ></video>
      {:else if v.original_image_url}
        <img src={v.original_image_url} alt={v.prompt || 'Video'} class="h-full w-full object-contain" />
      {/if}

      <!-- Gradient overlay at bottom -->
      <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-6 pb-8 pointer-events-none">
        {#if v.username}
          <p class="text-white font-bold text-lg mb-1">@{v.username}</p>
        {/if}
        {#if v.prompt}
          <p class="text-white/90 text-sm line-clamp-3">{v.prompt}</p>
        {/if}
      </div>

      <!-- Right-side action bar -->
      <div class="absolute right-3 bottom-20 flex flex-col items-center gap-5">
        <button
          class="flex flex-col items-center gap-1"
          onclick={() => toggleLike(v.id)}
          aria-label={v.isLiked ? $_('gallery.unlike') : $_('gallery.like')}
        >
          <div class="w-12 h-12 rounded-full bg-black/40 backdrop-blur flex items-center justify-center transition-transform active:scale-90">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="h-6 w-6 transition-colors"
              fill={v.isLiked ? '#ef4444' : 'none'}
              viewBox="0 0 24 24"
              stroke={v.isLiked ? '#ef4444' : 'white'}
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
          </div>
          <span class="text-white text-xs font-semibold">{v.likesCount ?? 0}</span>
        </button>

        <a
          href="/gallery/{v.id}"
          class="flex flex-col items-center gap-1"
          aria-label={$_('gallery.title')}
        >
          <div class="w-12 h-12 rounded-full bg-black/40 backdrop-blur flex items-center justify-center transition-transform active:scale-90">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
          </div>
        </a>
      </div>

      <!-- Loading indicator on last slide -->
      {#if i === videos.length - 1 && loading}
        <div class="absolute bottom-4 left-1/2 -translate-x-1/2">
          <span class="loading loading-spinner loading-lg text-white"></span>
        </div>
      {/if}
    </div>
  {/each}

    {#if !hasMore && videos.length > 0}
      <div class="snap-start snap-always h-32 flex items-center justify-center bg-black">
        <p class="text-white/50 text-sm">{$_('gallery.short.noMore')}</p>
      </div>
    {/if}
  </div>
</div>
