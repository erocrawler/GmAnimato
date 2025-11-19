<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { createTagsInput, melt } from '@melt-ui/svelte';

  export let data: any;
  let entry = data.entry as any;
  let prompt =
    entry.prompt ||
    (entry.suggested_prompts && entry.suggested_prompts[0]) ||
    "";
  let busy = false;
  let message = "";
  let newtag = "";
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  $: isEditable = entry.status !== 'processing' && entry.status !== 'completed' && entry.status !== 'in_queue' && entry.status !== 'failed';

  async function pollStatus() {
    if (entry.status === 'completed' || entry.status === 'failed') {
      return; // Stop polling if completed or failed
    }

    try {
      const res = await fetch(`/api/video/${entry.id}/status`);
      if (res.ok) {
        const statusData = await res.json();
        console.log('Status poll result:', statusData);
        
        // Update entry status from server response
        if (statusData.status && statusData.status !== entry.status) {
          entry = { ...entry, status: statusData.status };
        }

        // If job is completed, redirect to videos page
        if (statusData.status === 'completed') {
          await goto('/videos');
        }
      }
    } catch (err) {
      console.error('Failed to poll status:', err);
    }
  }

  async function retryGeneration() {
    try {
      const res = await fetch(`/api/video/${entry.id}/retry`, {
        method: 'POST'
      });
      
      if (res.ok) {
        const result = await res.json();
        console.log('Retry initiated:', result);
        message = "Job resubmitted — processing.";
        // Update status and start polling again
        entry = { ...entry, status: 'in_queue' };
        pollStatus();
        if (!pollInterval) {
          pollInterval = setInterval(pollStatus, 10000);
        }
      } else {
        const error = await res.json();
        alert(`Failed to retry: ${error.error || 'Unknown error'}`);
      }
    } catch (err) {
      console.error('Failed to retry generation:', err);
      alert('Failed to retry generation');
    }
  }

  onMount(() => {
    // Start polling if video is in progress
    if (entry.status === 'in_queue' || entry.status === 'processing') {
      pollStatus(); // Initial poll
      pollInterval = setInterval(pollStatus, 5000); // Poll every 5 seconds
    }
  });

  onDestroy(() => {
    if (pollInterval) {
      clearInterval(pollInterval);
    }
  });

  const {
    elements: { root, input, tag, deleteTrigger, edit },
    states: { tags },
    helpers: { addTag }
  } = createTagsInput({
    defaultTags: entry.tags || [],
    unique: true,
    trim: true,
    disabled: !isEditable
  });

  async function generate() {
    busy = true;
    message = "";
    try {
      // First update the stored prompt and tags so they're saved with the entry
      await fetch("/api/video/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id, prompt, tags: $tags.map(t => t.value) }),
      });

      // Then kickoff the I2V job
      const res = await fetch("/api/i2v/kickoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id }),
      });
      const j = await res.json();
      if (j.success) {
        message = "Job submitted — processing.";
        // navigate to user's videos or detail page
        await goto("/videos");
      } else {
        message = "Failed to submit: " + (j.error || "unknown");
      }
    } catch (err) {
      message = "Error: " + String(err);
    } finally {
      busy = false;
    }
  }

  async function deleteVideo() {
    if (!confirm('Are you sure you want to delete this video?')) {
      return;
    }
    
    try {
      const res = await fetch(`/api/video/${entry.id}`, {
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

  function addNewTag() {
    if (newtag && newtag.trim() !== "") {
      addTag(newtag.trim());
      newtag = "";
    }
  }
</script>

<div class="max-w-4xl mx-auto">
  <div class="flex justify-between items-center mb-8">
    <h1 class="text-4xl font-bold">Review: Suggested tags & prompts</h1>
    <div class="badge badge-lg" 
      class:badge-success={entry.status === 'completed'}
      class:badge-warning={entry.status === 'processing' || entry.status === 'in_queue'}
      class:badge-info={entry.status === 'uploaded'}
      class:badge-error={entry.status === 'failed'}
    >
      {entry.status}
    </div>
  </div>

  {#if message}
    <div class="alert alert-info shadow-lg mb-6">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-6 h-6">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
      </svg>
      <span>{message}</span>
    </div>
  {/if}

  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
    <!-- Image Preview Card -->
    <div class="card bg-base-100 shadow-xl">
      <figure class="px-4 pt-4">
        <img src={entry.original_image_url} alt="preview" class="rounded-lg max-h-96 object-contain" />
      </figure>
      <div class="card-body">
        <div>
          <h3 class="font-semibold mb-2">Tags</h3>
          <div class="join w-full">
            <div use:melt={$root} class="join-item flex flex-wrap gap-2 p-3 border border-base-300 rounded-l-lg bg-base-100 min-h-[3rem] items-center flex-1">
              {#each $tags as t}
                <div use:melt={$tag(t)}>
                  <span>{t.value}</span>
                  <button use:melt={$deleteTrigger(t)} aria-label="Remove tag">
                    ✕
                  </button>
                </div>
              {/each}
              <input 
                use:melt={$input}
                bind:value={newtag}
                type="text" 
                placeholder="Type and press Enter..." 
                disabled={!isEditable}
              />
            </div>
            <button class="btn btn-primary join-item min-h-[3rem]" on:click={addNewTag} disabled={!isEditable}>Add</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Prompts Card -->
    <div class="card bg-base-100 shadow-xl">
      <div class="card-body">
        <h2 class="card-title">AI Suggestions</h2>
        <div class="divider my-2"></div>
        
        {#if entry.suggested_prompts && entry.suggested_prompts.length > 0}
          <div class="space-y-2">
            <h3 class="font-semibold text-sm">Suggested Prompts:</h3>
            {#each entry.suggested_prompts as sp, i}
              <button class="alert alert-success py-2 cursor-pointer hover:shadow-md transition-shadow w-full text-left" on:click={() => prompt = sp} disabled={!isEditable}>
                <span class="text-sm">{i + 1}. {sp}</span>
              </button>
            {/each}
          </div>
        {:else}
          <div class="alert">
            <span class="text-sm">No AI suggestions available</span>
          </div>
        {/if}
      </div>
    </div>
  </div>

  <!-- Prompt Input & Generate -->
  <div class="card bg-base-100 shadow-xl">
    <div class="card-body">
      <h2 class="card-title">Your Prompt</h2>
      <p class="text-sm opacity-70 mb-2">Edit or enter your custom prompt. Click a suggestion above to use it.</p>
      <div class="form-control">
        <textarea
          id="prompt"
          bind:value={prompt}
          placeholder="Describe how you want your video to look..."
          class="textarea textarea-bordered textarea-lg h-32 w-full"
          disabled={!isEditable}
        ></textarea>
      </div>
      
      <div class="card-actions justify-between mt-4">
        <button 
          class="btn btn-error btn-outline" 
          on:click={deleteVideo}
          disabled={entry.status === "processing" || entry.status === "in_queue"}
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          Delete
        </button>
        <div class="flex gap-2">
          {#if entry.status === "failed"}
            <button 
              class="btn btn-warning btn-lg" 
              on:click={retryGeneration}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Retry Generation
            </button>
          {:else}
            <button 
              class="btn btn-primary btn-lg" 
              on:click={generate} 
              disabled={busy || entry.status === "processing" || entry.status === "in_queue"}
            >
              {#if busy}
                <span class="loading loading-spinner"></span>
                Submitting...
              {:else if entry.status === "processing" || entry.status === "in_queue"}
                <span class="loading loading-spinner"></span>
                {entry.status === "in_queue" ? "Queued..." : "Processing..."}
              {:else}
                <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Generate Video
              {/if}
            </button>
          {/if}
        </div>
      </div>
    </div>
  </div>
</div>
