<script lang="ts">
  import { goto } from '$app/navigation';
  import { _ } from 'svelte-i18n';
  
  let { data } = $props<{ data: { video: any; user: any } }>();
  let video = $state(data.video);
  let publishing = $state(false);
  let showOriginal = $state(false);

  async function togglePublish() {
    publishing = true;
    try {
      const res = await fetch('/api/video/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          id: video.id, 
          is_published: !video.is_published 
        })
      });
      
      if (res.ok) {
        video.is_published = !video.is_published;
      } else {
        alert('Failed to update publish status');
      }
    } catch (err) {
      alert('Error: ' + err);
    } finally {
      publishing = false;
    }
  }

  let likesCount = $state(video.likesCount || 0);
  let isLiked = $state(video.isLiked || false);

  async function toggleLike() {
    try {
      const res = await fetch(`/api/video/${video.id}/like`, {
        method: 'POST'
      });
      
      if (res.ok) {
        const result = await res.json();
        likesCount = result.likesCount;
        isLiked = result.isLiked;
      }
    } catch (err) {
      console.error('Failed to toggle like:', err);
    }
  }

  async function deleteVideo() {
    if (!confirm('Are you sure you want to delete this video?')) {
      return;
    }
    
    try {
      const res = await fetch(`/api/video/${video.id}`, {
        method: 'DELETE'
      });
      
      if (res.ok) {
        await goto('/videos');
      } else {
        alert('Failed to delete video');
      }
    } catch (err) {
      alert('Error deleting video: ' + err);
    }
  }
</script>

<div class="max-w-5xl mx-auto">
  <div class="flex justify-between items-center mb-8">
    <div>
      <a href="/videos" class="btn btn-ghost btn-sm mb-2">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
        </svg>
        {$_('videoDetail.backToMyVideos')}
      </a>
      <h1 class="text-4xl font-bold">{$_('videoDetail.title')}</h1>
    </div>
    <div class="badge badge-lg" 
      class:badge-success={video.status === 'completed'}
      class:badge-warning={video.status === 'processing'}
      class:badge-info={video.status === 'uploaded'}
      class:badge-error={video.status === 'failed'}
    >
      {video.status}
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
          {#if showOriginal}
            <img src={video.original_image_url} alt="Original" class="w-full max-h-[600px] object-contain" />
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
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title">{$_('videoDetail.actions')}</h2>
          
          {#if video.status === 'completed'}
            <div class="form-control">
              <label class="label cursor-pointer">
                <span class="label-text">{$_('videoDetail.publish')}</span>
                <input 
                  type="checkbox" 
                  class="toggle toggle-primary" 
                  checked={video.is_published}
                  onchange={togglePublish}
                  disabled={publishing || (video.is_nsfw && video.is_photo_realistic) || (!video.suggested_prompts || video.suggested_prompts.length === 0)}
                />
              </label>
              {#if video.is_nsfw && video.is_photo_realistic}
                <p class="text-xs text-error mt-1">NSFW photo-realistic content cannot be published</p>
              {:else if !video.suggested_prompts || video.suggested_prompts.length === 0}
                <p class="text-xs text-warning mt-1">⚠️ Image recognition failed - cannot publish to gallery. Please try uploading again.</p>
              {/if}
            </div>

            {#if video.is_published}
              <a href="/gallery/{video.id}" class="btn btn-ghost">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                View in Gallery
              </a>
            {/if}

            <div class="divider"></div>

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
          {/if}

          <button class="btn btn-error btn-outline" onclick={deleteVideo}>
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            {$_('common.delete')} {$_('videos.title')}
          </button>
        </div>
      </div>

      <!-- Metadata -->
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title">{$_('videoDetail.info')}</h2>
          <div class="text-sm space-y-1">
            <p><strong>{$_('videoDetail.created')}:</strong> {new Date(video.created_at).toLocaleString()}</p>
            <p><strong>{$_('videoDetail.status')}:</strong> {video.status}</p>
            {#if video.is_published}
              <p><strong>Published:</strong> Yes</p>
            {/if}
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
