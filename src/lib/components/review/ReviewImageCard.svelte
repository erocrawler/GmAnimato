<script lang="ts">
  // Image/Video Preview card + tags input for the review page.
  import { melt } from "@melt-ui/svelte";
  import { _ } from "svelte-i18n";

  export let entry: any;
  export let videoWorkflowType: string;
  export let isEditable: boolean;
  export let newtag = "";
  // melt API bundle (actions + tags store) created by the parent
  export let meltApi: {
    root: any;
    input: any;
    tag: any;
    deleteTrigger: any;
    tags: any;
  };
  export let addNewTag: () => void;

  const { root, input, tag, deleteTrigger, tags } = meltApi;
</script>

<div class="card bg-base-100 shadow-xl">
  <figure class="px-4 pt-4">
    {#if videoWorkflowType === "ref2v"}
      <!-- Ref2V Mode: show ref video (if any) + ref images. The daisyUI
           <figure> is display:flex (row), so both must live inside ONE
           w-full shrink-0 wrapper — as sibling flex items they'd sit side
           by side and overflow (overflow:hidden clips the row). -->
      <div class="w-full shrink-0">
        {#if entry.additional_options?.ref_video_url}
          <video
            src={entry.additional_options.ref_video_url}
            controls
            muted
            playsinline
            class="rounded-lg h-72 w-full object-contain bg-base-200"
          ></video>
        {:else}
          <div class="w-full rounded-lg bg-base-200 py-10 text-center text-sm opacity-70">
            {entry.additional_options?.ref_image_urls?.length
              ? $_("review.ref2v.noRefVideoWithImages")
              : $_("review.ref2v.noRefVideo")}
          </div>
        {/if}
        {#if entry.additional_options?.ref_image_urls?.length}
          <div class="flex gap-2 w-full mt-3">
            {#each entry.additional_options.ref_image_urls as refUrl, i}
              <img
                src={refUrl}
                alt="ref image {i + 1}"
                class="rounded-lg h-24 min-w-0 flex-1 object-contain bg-base-200"
              />
            {/each}
          </div>
        {/if}
        {#if entry.additional_options?.ref_audio_url}
          <div class="w-full mt-3 flex items-center gap-3 rounded-lg bg-base-200 p-3">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
            <div class="min-w-0 flex-1">
              <p class="text-xs opacity-70 truncate">{$_("review.ref2v.audioLabel")} · &lt;Audio 1&gt;</p>
              <audio controls src={entry.additional_options.ref_audio_url} class="w-full h-8"></audio>
            </div>
          </div>
        {/if}
      </div>
    {:else if entry.last_image_url}
      <!-- FL2V Mode: Show both images -->
      <div class="grid grid-cols-2 gap-2 w-full">
        <div>
          <p class="text-xs text-center mb-2 font-semibold">
            {$_("review.firstFrame")}
          </p>
          <img
            src={entry.original_image_url}
            alt="first frame"
            class="rounded-lg max-h-64 object-contain w-full"
          />
        </div>
        <div>
          <p class="text-xs text-center mb-2 font-semibold">
            {$_("review.lastFrame")}
          </p>
          <img
            src={entry.last_image_url}
            alt="last frame"
            class="rounded-lg max-h-64 object-contain w-full"
          />
        </div>
      </div>
    {:else}
      <!-- I2V Mode: Show single image -->
      <img
        src={entry.original_image_url}
        alt="preview"
        class="rounded-lg max-h-96 object-contain"
      />
    {/if}
  </figure>
  <div class="card-body">
    <div>
      <h3 class="font-semibold mb-2">{$_("review.tags")}</h3>
      <div class="join w-full">
        <div
          use:melt={$root}
          class="join-item flex flex-wrap gap-2 p-3 border border-base-300 rounded-l-lg bg-base-100 min-h-[3rem] items-center flex-1"
        >
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
            placeholder={$_("review.tagPlaceholder")}
            disabled={!isEditable}
          />
        </div>
        <button
          class="btn btn-primary join-item min-h-[3rem]"
          on:click={addNewTag}
          disabled={!isEditable}>{$_("review.addTag")}</button
        >
      </div>
    </div>
  </div>
</div>
