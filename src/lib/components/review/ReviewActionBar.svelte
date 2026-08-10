<script lang="ts">
  // Bottom action bar: delete, quota badge, retry / generate button.
  import { _ } from "svelte-i18n";

  export let entry: any;
  export let busy: boolean = false;
  export let quotaLoading: boolean = true;
  export let quotaRemaining: number | null = null;
  export let quotaLimit: number | null = null;
  export let selectedWorkflowQuotaCost: number = 1;
  export let promptRelayMode: boolean = false;
  export let relayFramesValid: boolean = true;
  export let relaySegmentFramesValid: boolean = true;
  export let relaySegmentPromptsValid: boolean = true;
  export let onDelete: () => void = () => {};
  export let onRetry: () => void = () => {};
  export let onGenerate: () => void = () => {};
</script>

<div class="card-actions justify-between mt-4">
  <button
    class="btn btn-error btn-outline"
    on:click={onDelete}
    disabled={entry.status === "processing" ||
      entry.status === "in_queue"}
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      class="h-5 w-5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
      />
    </svg>
    {$_("common.delete")}
  </button>
  <div class="flex gap-2 flex-col sm:flex-row sm:items-center">
    {#if !quotaLoading && quotaRemaining !== null}
      {#if quotaLimit === 0}
        <div class="badge badge-lg badge-error">
          {$_("review.quotaNoAccess")}
        </div>
      {:else}
        <div
          class="badge badge-lg"
          class:badge-error={quotaRemaining < selectedWorkflowQuotaCost}
          class:badge-warning={quotaRemaining >= selectedWorkflowQuotaCost && quotaRemaining < 3}
          class:badge-success={quotaRemaining >= 3}
          title={selectedWorkflowQuotaCost > 1
            ? $_("review.quotaCost", { values: { cost: selectedWorkflowQuotaCost } })
            : undefined}
        >
          {$_("review.quotaRemaining", {
            values: { count: quotaRemaining },
          })}
        </div>
      {/if}
    {/if}
    {#if entry.status === "failed"}
      <button class="btn btn-warning btn-lg" on:click={onRetry}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
          />
        </svg>
        {$_("review.retryGeneration")}
      </button>
    {:else if entry.status === "deleted"}
      <div class="alert alert-info">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="stroke-current shrink-0 h-6 w-6"
          fill="none"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span>{$_("review.videoDeleted")}</span>
      </div>
    {:else}
      {#if entry.is_nsfw && entry.is_photo_realistic}
        <div class="alert alert-error mb-4">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="stroke-current shrink-0 h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <div>
            <h3 class="font-bold">
              {$_("review.warnings.nsfwRealistic.title")}
            </h3>
            <div class="text-sm">
              {$_("review.warnings.nsfwRealistic.message")}
            </div>
          </div>
        </div>
      {/if}
      <button
        class="btn btn-primary btn-lg"
        on:click={onGenerate}
        disabled={busy ||
          entry.status === "processing" ||
          entry.status === "in_queue" ||
          (quotaRemaining !== null && quotaRemaining < selectedWorkflowQuotaCost) ||
          (promptRelayMode && !relayFramesValid) ||
          (promptRelayMode && !relaySegmentFramesValid) ||
          (promptRelayMode && !relaySegmentPromptsValid)}
      >
        {#if busy}
          <span class="loading loading-spinner"></span>
          {$_("review.submitting")}
        {:else if entry.status === "processing" || entry.status === "in_queue"}
          <span class="loading loading-spinner"></span>
          {entry.status === "in_queue"
            ? $_("review.queued")
            : $_("review.processing")}
        {:else}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
            />
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          {$_("review.generateVideo")}
        {/if}
      </button>
    {/if}
  </div>
</div>
