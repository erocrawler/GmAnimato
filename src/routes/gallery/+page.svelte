<script lang="ts">
  export let data: { videos: any[]; user?: any };

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
        data.videos = data.videos.map(v => 
          v.id === videoId ? { ...v, likes: result.likes } : v
        );
      }
    } catch (err) {
      console.error('Failed to toggle like:', err);
    }
  }

  function isLiked(video: any): boolean {
    if (!data.user || !video.likes) return false;
    return video.likes.includes(data.user.id);
  }

  function getLikesCount(video: any): number {
    return video.likes?.length || 0;
  }
</script>

<div class="max-w-7xl mx-auto">
  <div class="mb-8">
    <h1 class="text-4xl font-bold mb-2">Gallery</h1>
    <p class="text-lg opacity-70">Explore videos created by the community</p>
  </div>

  {#if data.videos.length === 0}
    <div class="hero min-h-[50vh] bg-base-200 rounded-lg">
      <div class="hero-content text-center">
        <div class="max-w-md">
          <div class="text-6xl mb-4">🖼️</div>
          <h2 class="text-3xl font-bold mb-4">No published videos yet</h2>
          <p class="mb-6">Be the first to share your creation with the community!</p>
          <a href="/new" class="btn btn-primary btn-lg">Create & Publish</a>
        </div>
      </div>
    </div>
  {:else}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
      {#each data.videos as v}
        <a href="/gallery/{v.id}" class="card bg-base-100 shadow-xl hover:shadow-2xl transition-shadow cursor-pointer">
          {#if v.status === 'completed' && v.final_video_url}
            <figure class="aspect-video bg-base-200">
              <!-- svelte-ignore a11y_media_has_caption -->
              <video src={v.final_video_url} class="w-full h-full object-cover pointer-events-none"></video>
            </figure>
            <div class="card-body p-4">
              <h2 class="card-title text-base">
                {v.prompt || 'Untitled Video'}
              </h2>
              <div class="flex items-center justify-between mt-2">
                <div class="flex items-center gap-2 text-sm opacity-60">
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  <span>AI Generated</span>
                </div>
                <button 
                  class="btn btn-ghost btn-sm gap-1" 
                  class:text-error={isLiked(v)}
                  on:click={(e) => toggleLike(v.id, e)}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill={isLiked(v) ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                  </svg>
                  <span>{getLikesCount(v)}</span>
                </button>
              </div>
            </div>
          {:else}
            <div class="card-body">
              <div class="flex items-center justify-center h-48 bg-base-200 rounded-lg">
                <div class="text-center">
                  <div class="loading loading-spinner loading-lg text-primary"></div>
                  <p class="mt-4 text-sm opacity-60">Processing...</p>
                </div>
              </div>
            </div>
          {/if}
        </a>
      {/each}
    </div>
  {/if}
</div>
