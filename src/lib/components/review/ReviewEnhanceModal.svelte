<script lang="ts">
  // Modal preview for the MiniMax H3 prompt enhancer. Shows the enhanced prompt
  // with Use / Cancel so the user reviews before overwriting the editor.
  import { _ } from "svelte-i18n";

  export let show: boolean = false;
  export let loading: boolean = false;
  export let error: string = "";
  export let result: string = "";
  export let onUse: () => void = () => {};
  export let onCancel: () => void = () => {};
  export let onRetry: () => void = () => {};
</script>

{#if show}
  <div class="modal modal-open">
    <div class="modal-box max-w-3xl">
      {#if loading}
        <h3 class="font-bold text-2xl mb-4">
          {$_("review.enhance.generating")}
        </h3>
        <div class="flex items-center gap-3 py-6">
          <span class="loading loading-spinner loading-lg"></span>
          <p class="opacity-70">{$_("review.enhance.generatingHint")}</p>
        </div>
      {:else if error}
        <h3 class="font-bold text-2xl mb-4 text-error">
          {$_("review.enhance.errorTitle")}
        </h3>
        <div class="alert alert-error">
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
          <span>{error}</span>
        </div>
        <div class="modal-action">
          <button class="btn btn-ghost" on:click={onCancel}
            >{$_("common.cancel")}</button
          >
          <button class="btn btn-primary" on:click={onRetry}
            >{$_("review.enhance.retry")}</button
          >
        </div>
      {:else}
        <h3 class="font-bold text-2xl mb-1">
          {$_("review.enhance.previewTitle")}
        </h3>
        <p class="text-sm opacity-70 mb-4">
          {$_("review.enhance.previewHint")}
        </p>
        <pre
          class="whitespace-pre-wrap rounded-xl bg-base-200 p-4 max-h-[70vh] overflow-y-auto text-sm leading-relaxed"
        >{result}</pre
        >
        <div class="modal-action">
          <button class="btn btn-ghost" on:click={onCancel}
            >{$_("common.cancel")}</button
          >
          <button class="btn btn-outline btn-primary" on:click={onRetry}
            >{$_("review.enhance.regenerate")}</button
          >
          <button class="btn btn-primary" on:click={onUse}
            >{$_("review.enhance.useButton")}</button
          >
        </div>
      {/if}
    </div>
  </div>
{/if}
