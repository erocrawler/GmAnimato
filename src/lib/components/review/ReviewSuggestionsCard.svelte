<script lang="ts">
  // AI Suggestions card for the review page.
  import { _ } from "svelte-i18n";

  export let entry: any;
  export let isEditable: boolean;
  export let analyzing: boolean;
  export let onAnalyze: () => void;
  export let onUsePrompt: (prompt: string) => void;
</script>

<div class="card bg-base-100 shadow-xl">
  <div class="card-body">
    <div class="flex justify-between items-center gap-3">
      <h2 class="card-title">{$_("review.aiSuggestions")}</h2>
      {#if !entry.validation_metadata?.manual_recognition_done}
        <button
          class="btn btn-sm btn-outline"
          on:click={onAnalyze}
          disabled={!isEditable || analyzing}
        >
          {#if analyzing}
            <span class="loading loading-spinner loading-xs"></span>
            {$_("review.analyzing")}
          {:else}
            {$_("review.analyzeWithCustomVL")}
          {/if}
        </button>
      {/if}
    </div>
    <div class="divider my-2"></div>

    {#if entry.validation_metadata?.manual_recognition_error}
      <div class="alert alert-warning py-2">
        <span class="text-sm">{$_("review.analysisUnavailable")}</span>
      </div>
    {/if}

    {#if entry.suggested_prompts && entry.suggested_prompts.length > 0}
      <div class="space-y-2">
        <h3 class="font-semibold text-sm">
          {$_("review.suggestedPrompts")}
        </h3>
        {#each entry.suggested_prompts as sp, i}
          <button
            class="alert alert-success py-2 cursor-pointer hover:shadow-md transition-shadow w-full text-left"
            on:click={() => onUsePrompt(sp)}
            disabled={!isEditable}
          >
            <span class="text-sm">{i + 1}. {sp}</span>
          </button>
        {/each}
      </div>
    {:else}
      <div class="alert">
        <span class="text-sm">{$_("review.noSuggestions")}</span>
      </div>
    {/if}
  </div>
</div>
