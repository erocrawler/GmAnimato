<script lang="ts">
  import { _ } from 'svelte-i18n';

  let { videoId, videoUrl, fullWidth = false } = $props<{ videoId: string; videoUrl: string; fullWidth?: boolean }>();

  let showMenu = $state(false);
  let converting = $state<'gif' | 'gif-small' | 'webp' | null>(null);

  function clickOutside(node: HTMLElement, callback: () => void) {
    const handle = (e: MouseEvent) => {
      if (!node.contains(e.target as Node)) callback();
    };
    document.addEventListener('click', handle, true);
    return { destroy() { document.removeEventListener('click', handle, true); } };
  }

  async function downloadConverted(format: 'gif' | 'webp', quality?: 'small') {
    converting = format === 'gif' ? (quality === 'small' ? 'gif-small' : 'gif') : 'webp';
    try {
      const qs = new URLSearchParams({ format });
      if (quality) qs.set('quality', quality);
      const res = await fetch(`/api/video/${videoId}/download?${qs}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        alert($_('videoDetail.downloadConvertError') + ': ' + (err.error || res.statusText));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `video-${videoId}${quality === 'small' ? '-small' : ''}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert($_('videoDetail.downloadConvertError') + ': ' + err);
    } finally {
      converting = null;
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="dropdown dropdown-end"
  class:w-full={fullWidth}
  class:dropdown-open={showMenu}
  use:clickOutside={() => showMenu = false}
>
  <div class:join={true} class:w-full={fullWidth}>
    <a
      href={videoUrl}
      download="video-{videoId}.mp4"
      class="btn btn-primary join-item gap-2"
    >
      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
      </svg>
      {$_('videoDetail.download')}
    </a>
    <button
      class="btn btn-primary join-item px-2 flex-grow"
      aria-label={$_('videoDetail.moreDownloads')}
      aria-expanded={showMenu}
      onclick={() => showMenu = true}
    >
      <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
      </svg>
    </button>
  </div>
  <ul class="dropdown-content menu bg-base-100 rounded-box z-10 w-52 shadow-lg border border-base-300 mt-1 p-1">
    <li>
      <button
        onclick={() => { downloadConverted('gif'); showMenu = false; }}
        disabled={converting !== null}
        class="flex items-center gap-2"
      >
        {#if converting === 'gif'}
          <span class="loading loading-spinner loading-xs"></span>
        {:else}
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
        {/if}
        {converting === 'gif' ? $_('videoDetail.downloadConverting') : $_('videoDetail.downloadGif')}
      </button>
    </li>
    <li>
      <button
        onclick={() => { downloadConverted('gif', 'small'); showMenu = false; }}
        disabled={converting !== null}
        class="flex items-center gap-2"
      >
        {#if converting === 'gif-small'}
          <span class="loading loading-spinner loading-xs"></span>
        {:else}
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
        {/if}
        {converting === 'gif-small' ? $_('videoDetail.downloadConverting') : $_('videoDetail.downloadGifSmall')}
      </button>
    </li>
    <li>
      <button
        onclick={() => { downloadConverted('webp'); showMenu = false; }}
        disabled={converting !== null}
        class="flex items-center gap-2"
      >
        {#if converting === 'webp'}
          <span class="loading loading-spinner loading-xs"></span>
        {:else}
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
        {/if}
        {converting === 'webp' ? $_('videoDetail.downloadConverting') : $_('videoDetail.downloadWebp')}
      </button>
    </li>
  </ul>
</div>
