<script lang="ts">
  import { goto } from '$app/navigation';
  
  let { data } = $props<{ data: { video: any; user: any } }>();
  let video = $state(data.video);
  let publishing = false;

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

  async function toggleLike() {
    try {
      const res = await fetch(`/api/video/${video.id}/like`, {
        method: 'POST'
      });
      
      if (res.ok) {
        const result = await res.json();
        video = { ...video, likes: result.likes };
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

  async function downloadVideo() {
    try {
      const response = await fetch(video.final_video_url);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `video-${video.id}.mp4`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      console.error('Download failed:', err);
      alert('Failed to download video');
    }
  }

  const isLiked = $derived(data.user && video.likes?.includes(data.user.id));
  const likesCount = $derived(video.likes?.length || 0);
</script>

<div class="max-w-5xl mx-auto">
  <div class="flex justify-between items-center mb-8">
    <div>
      <a href="/videos" class="btn btn-ghost btn-sm mb-2">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
        </svg>
        Back to My Videos
      </a>
      <h1 class="text-4xl font-bold">Video Details</h1>
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
    <div class="lg:col-span-2">
      <div class="card bg-base-100 shadow-xl">
        <figure class="bg-base-300">
          {#if video.status === 'completed' && video.final_video_url}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video src={video.final_video_url} controls class="w-full max-h-[600px]" autoplay loop></video>
          {:else if video.original_image_url}
            <img src={video.original_image_url} alt="Original" class="w-full max-h-[600px] object-contain" />
          {:else}
            <div class="h-96 flex items-center justify-center">
              <span class="text-lg opacity-60">No video available</span>
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
          <h2 class="card-title">Prompt</h2>
          <p class="text-sm">{video.prompt || 'No prompt provided'}</p>
        </div>
      </div>

      <!-- Tags -->
      {#if video.tags && video.tags.length > 0}
        <div class="card bg-base-100 shadow-xl">
          <div class="card-body">
            <h2 class="card-title">Tags</h2>
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
          <h2 class="card-title">Actions</h2>
          
          {#if video.status === 'completed'}
            <div class="form-control">
              <label class="label cursor-pointer">
                <span class="label-text">Publish to Gallery</span>
                <input 
                  type="checkbox" 
                  class="toggle toggle-primary" 
                  checked={video.is_published}
                  onchange={togglePublish}
                  disabled={publishing || (video.is_nsfw && video.is_photo_realistic) || (!video.tags || video.tags.length === 0)}
                />
              </label>
              {#if video.is_nsfw && video.is_photo_realistic}
                <p class="text-xs text-error mt-1">NSFW photo-realistic content cannot be published</p>
              {:else if !video.tags || video.tags.length === 0}
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
              {isLiked ? 'Unlike' : 'Like'} ({likesCount})
            </button>

            <div class="divider"></div>

            <button class="btn btn-primary" onclick={downloadVideo}>
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Download Video
            </button>
          {/if}

          <button class="btn btn-error btn-outline" onclick={deleteVideo}>
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Delete Video
          </button>
        </div>
      </div>

      <!-- Metadata -->
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title">Info</h2>
          <div class="text-sm space-y-1">
            <p><strong>Created:</strong> {new Date(video.created_at).toLocaleString()}</p>
            <p><strong>Status:</strong> {video.status}</p>
            {#if video.is_published}
              <p><strong>Published:</strong> Yes</p>
            {/if}
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
