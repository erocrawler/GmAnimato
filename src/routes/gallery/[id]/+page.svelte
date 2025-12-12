<script lang="ts">
  import { _ } from 'svelte-i18n';
  
  let { data } = $props<{ data: { video: any; user?: any; relatedVideos: any[]; author?: { id: string; username: string } | null } }>();
  let video = $state(data.video);
  $effect(() => {
    video = data.video;
  });
  const likesCount = $derived(video.likesCount || 0);
  const isLiked = $derived(video.isLiked || false);
  let showOriginal = $state(false);

  // ...existing code...

  async function toggleLike() {
    try {
      const res = await fetch(`/api/video/${video.id}/like`, {
        method: 'POST'
      });
      
      if (res.ok) {
        const result = await res.json();
        video = { ...video, likesCount: result.likesCount, isLiked: result.isLiked };
      }
    } catch (err) {
      console.error('Failed to toggle like:', err);
    }
  }
  const authorName = $derived(data.author?.username ?? $_('videoDetail.unknownAuthor'));

  function buildGalleryUrl(id?: string) {
    if (typeof window === 'undefined') return id ? `/gallery/${id}` : '/gallery';

    const params = new URLSearchParams(window.location.search);
    const sort = params.get('sort');
    const page = params.get('page');
    const filter = params.get('filter');

    const galleryParams = new URLSearchParams();
    if (sort) galleryParams.set('sort', sort);
    if (page) galleryParams.set('page', page);
    if (filter) galleryParams.set('filter', filter);

    const base = id ? `/gallery/${id}` : '/gallery';
    return galleryParams.toString() ? `${base}?${galleryParams.toString()}` : base;
  }
</script>

<div class="max-w-5xl mx-auto">
  <div class="flex justify-between items-center mb-8">
    <div>
      <a href={buildGalleryUrl()} class="btn btn-ghost btn-sm mb-2">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
        </svg>
        {$_('videoDetail.backToGallery')}
      </a>
    </div>
  </div>

  <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
    <!-- Video Player -->
    <div class="lg:col-span-2 space-y-4">
      {#if video.status === 'completed' && video.final_video_url && video.original_image_url}
        <div class="flex justify-end">
          <button 
            class="btn btn-sm gap-2" 
            onclick={() => showOriginal = !showOriginal}
          >
            {#if showOriginal}
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {$_('videoDetail.showVideo')}
            {:else}
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              {$_('videoDetail.showOriginal')}
            {/if}
          </button>
        </div>
      {/if}
      
      <div class="card bg-base-100 shadow-xl">
        <figure class="bg-base-300">
          {#if video.status === 'completed' && video.final_video_url && video.original_image_url}
            {#if showOriginal}
              <img src={video.original_image_url} alt="Original" class="w-full max-h-[600px] object-contain" />
            {:else}
              <!-- svelte-ignore a11y_media_has_caption -->
              <video src={video.final_video_url} controls class="w-full max-h-[600px]" autoplay loop></video>
            {/if}
          {:else if video.status === 'completed' && video.final_video_url}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video src={video.final_video_url} controls class="w-full max-h-[600px]" autoplay loop></video>
          {:else if video.original_image_url}
            <img src={video.original_image_url} alt="Original" class="w-full max-h-[600px] object-contain" />
          {:else}
            <div class="h-96 flex items-center justify-center">
              <span class="text-lg opacity-60">{$_('videoDetail.noVideoAvailable')}</span>
            </div>
          {/if}
        </figure>
      </div>
    </div>

    <!-- Info Panel -->
    <div class="space-y-6">
      <!-- Prompt -->
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title">{$_('videoDetail.prompt')}</h2>
          <p class="text-sm">{video.prompt || $_('videoDetail.noPrompt')}</p>
        </div>
      </div>

      <!-- Tags -->
      {#if video.tags && video.tags.length > 0}
        <div class="card bg-base-100 shadow-xl">
          <div class="card-body">
            <h2 class="card-title">{$_('videoDetail.tags')}</h2>
            <div class="flex flex-wrap gap-2">
              {#each video.tags as tag}
                <div class="badge badge-primary">{tag}</div>
              {/each}
            </div>
          </div>
        </div>
      {/if}

      <!-- Actions -->
      {#if video.status === 'completed' && video.final_video_url}
        <div class="card bg-base-100 shadow-xl">
          <div class="card-body">
            <button 
              class="btn" 
              class:btn-error={isLiked}
              class:btn-outline={!isLiked}
              onclick={toggleLike}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill={isLiked ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
              </svg>
              {isLiked ? $_('videoDetail.unlike') : $_('videoDetail.like')} ({likesCount})
            </button>

            <div class="divider"></div>
            
            <a 
              href={video.final_video_url}
              download="video-{video.id}.mp4"
              class="btn btn-primary"
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {$_('videoDetail.download')}
            </a>
          </div>
        </div>
      {/if}

      <!-- Metadata -->
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title">{$_('videoDetail.info')}</h2>
          <div class="text-sm space-y-1">
            <p><strong>{$_('videoDetail.author')}:</strong> {authorName}</p>
            <p><strong>{$_('videoDetail.created')}:</strong> {new Date(video.created_at).toLocaleString()}</p>
            <p><strong>{$_('videoDetail.status')}:</strong> {video.status}</p>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- More Videos -->
  {#if data.relatedVideos && data.relatedVideos.length > 0}
    <div class="mt-12">
      <h2 class="text-2xl font-bold mb-6">{$_('videoDetail.moreVideos')}</h2>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {#each data.relatedVideos as v}
          <a href={buildGalleryUrl(v.id)} class="card bg-base-100 shadow-xl hover:shadow-2xl transition-shadow cursor-pointer">
            {#if v.original_image_url}
              <figure class="aspect-video bg-base-200">
                <img src={v.original_image_url} alt={v.prompt || 'Video thumbnail'} class="w-full h-full object-cover" />
              </figure>
              <div class="card-body p-4">
                <h3 class="card-title text-sm line-clamp-2">
                  {v.prompt || 'Untitled Video'}
                </h3>
                <div class="flex items-center justify-between mt-2">
                  <div class="flex items-center gap-1 text-xs opacity-60">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    <span>AI</span>
                  </div>
                  {#if v.likes && v.likes.length > 0}
                    <div class="flex items-center gap-1 text-xs">
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                      </svg>
                      <span>{v.likes.length}</span>
                    </div>
                  {/if}
                </div>
              </div>
            {/if}
          </a>
        {/each}
      </div>
    </div>
  {/if}
</div>
