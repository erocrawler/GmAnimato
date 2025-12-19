<script lang="ts">
  import { _ } from 'svelte-i18n';
  import { createStatusTranslations, getTranslatedStatus } from '$lib/videoStatus';
  import type { VideoEntry } from '$lib/IDatabase';


  import { layoutMode } from '$lib/stores/layoutMode';
  type VideoType = 'user' | 'gallery' | 'admin';

  interface Props {
    videos: any[];
    type?: VideoType;
    loading?: boolean;
    pageSize?: number;
    emptyMessage?: string;
    emptyIcon?: string;
    emptyAction?: { label: string; href: string } | null;
    queryParams?: string;
    onDelete?: (id: string) => void;
    onUnpublish?: (id: string) => void;
    onToggleLike?: (id: string, event: MouseEvent) => void;
  }

  let {
    videos,
    type = 'user',
    loading = false,
    pageSize = 12,
    emptyMessage,
    emptyIcon,
    emptyAction = null,
    queryParams = '',
    onDelete,
    onUnpublish,
    onToggleLike
  }: Props = $props();

  const statusMap = $derived(createStatusTranslations((key) => $_(key)));

  function getStatusText(status: string): string {
    return getTranslatedStatus(status, statusMap);
  }

  function getStatusBadgeClass(status: string) {
    switch (status) {
      case 'completed': return 'badge-success';
      case 'processing':
      case 'in_queue': return 'badge-warning';
      case 'uploaded': return 'badge-info';
      case 'failed': return 'badge-error';
      case 'deleted': return 'badge-neutral';
      default: return 'badge-info';
    }
  }

  const gridClasses = $derived(
    $layoutMode === 'compact' 
      ? (type === 'gallery' 
          ? 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3' 
          : 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3')
      : (type === 'gallery'
          ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6'
          : 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6')
  );

  const skeletonCount = $derived(pageSize);
</script>

{#if loading}
  <!-- Loading skeletons -->
  <div class={gridClasses}>
    {#each Array(skeletonCount) as _}
      <div class="card bg-base-100 shadow-xl">
        <figure class="skeleton {$layoutMode === 'compact' ? 'h-32' : 'h-48'}"></figure>
        {#if $layoutMode === 'grid'}
          <div class="card-body p-4">
            <div class="skeleton h-4 w-3/4 mb-2"></div>
            <div class="skeleton h-4 w-1/2 mb-4"></div>
            <div class="flex gap-2 justify-end">
              <div class="skeleton h-8 w-20"></div>
            </div>
          </div>
        {/if}
      </div>
    {/each}
  </div>
{:else if videos.length === 0}
  <!-- Empty state -->
  <div class="hero min-h-[50vh] bg-base-200 rounded-lg">
    <div class="hero-content text-center">
      <div class="max-w-md">
        {#if emptyIcon}
          <div class="text-6xl mb-4">{emptyIcon}</div>
        {/if}
        <p class="text-lg mb-6">{emptyMessage || $_('videos.empty.message')}</p>
        {#if emptyAction}
          <a href={emptyAction.href} class="btn btn-primary btn-lg">{emptyAction.label}</a>
        {/if}
      </div>
    </div>
  </div>
{:else}
  <!-- Video grid -->
  <div class={gridClasses}>
    {#each videos as v}
      {#if type === 'gallery'}
        <!-- Gallery card -->
        <a href="/gallery/{v.id}{queryParams ? `?${queryParams}` : ''}" class="card bg-base-100 shadow-xl hover:shadow-2xl transition-shadow cursor-pointer">
          {#if v.original_image_url}
            <figure class="{$layoutMode === 'compact' ? 'h-32' : 'aspect-video'} bg-base-200">
              <img src={v.original_image_url} alt={v.prompt || 'Video thumbnail'} class="w-full h-full object-cover" />
            </figure>
            {#if $layoutMode === 'grid'}
              <div class="card-body p-4">
                <h2 class="card-title text-base line-clamp-3">
                  {v.prompt || $_('gallery.untitled')}
                </h2>
                <div class="flex items-center justify-between mt-2">
                  <div class="flex items-center gap-2 text-sm opacity-60">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    <span>{$_('gallery.aiGenerated')}</span>
                  </div>
                  <button 
                    class="btn btn-ghost btn-sm gap-1" 
                    class:text-error={v.isLiked}
                    onclick={(e) => onToggleLike?.(v.id, e)}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill={v.isLiked ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                    </svg>
                    <span>{v.likesCount || 0}</span>
                  </button>
                </div>
              </div>
            {:else}
              <!-- Compact: overlay likes on image -->
              <div class="absolute bottom-2 right-2">
                <button 
                  class="btn btn-ghost btn-xs gap-1 bg-base-100/80" 
                  class:text-error={v.isLiked}
                  onclick={(e) => onToggleLike?.(v.id, e)}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill={v.isLiked ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                  </svg>
                  <span class="text-xs">{v.likesCount || 0}</span>
                </button>
              </div>
            {/if}
          {/if}
        </a>
      {:else}
        <!-- User/Admin card -->
        <div class="card bg-base-100 shadow-xl {$layoutMode === 'grid' ? 'image-full' : ''}">
          {#if v.original_image_url}
            <figure class={$layoutMode === 'compact' ? 'h-32' : ''}>
              <img src={v.original_image_url} alt="thumbnail" class="w-full h-full object-cover" />
            </figure>
          {:else}
            <figure class="bg-base-300 {$layoutMode === 'compact' ? 'h-32' : 'h-48'}">
              <div class="w-full h-full flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
            </figure>
          {/if}
          <div class="card-body {$layoutMode === 'compact' ? 'p-3' : ''}">
            <div class="flex items-center gap-2 mb-2">
              <div class="badge {$layoutMode === 'compact' ? 'badge-sm' : 'badge-lg'} {getStatusBadgeClass(v.status)}">
                {getStatusText(v.status)}
              </div>
              {#if v.is_published}
                <div class="badge badge-info {$layoutMode === 'compact' ? 'badge-sm' : ''}">
                  {#if type === 'admin'}
                    Published
                  {:else}
                    {$_('videoDetail.published')}
                  {/if}
                </div>
              {/if}
            </div>

            {#if type === 'admin' && v.username}
              <p class="text-xs font-semibold mb-1">By: {v.username}</p>
            {/if}
            
            {#if v.prompt && $layoutMode === 'grid'}
              <p class="text-sm line-clamp-2 mb-2">{v.prompt}</p>
            {/if}
            
            {#if (v.status === 'processing' || v.status === 'in_queue') && v.progress_percentage !== null && v.progress_percentage !== undefined}
              <div class="mb-2">
                <div class="flex justify-between text-xs mb-1">
                  <span>{$_('review.processing')}</span>
                  <span>{v.progress_percentage.toFixed(0)}%</span>
                </div>
                <progress class="progress progress-primary w-full {$layoutMode === 'compact' ? 'progress-sm' : ''}" value={v.progress_percentage} max="100"></progress>
              </div>
            {/if}
            
            {#if v.status === "completed"}
              <div class="card-actions justify-end mt-auto gap-1">
                <a href="{type === 'admin' ? '/videos/' : '/videos/'}{v.id}" class="btn {$layoutMode === 'compact' ? 'btn-xs' : 'btn-sm'} btn-primary">{$_('videos.actions.view')}</a>
                {#if type === 'admin' && v.is_published && onUnpublish}
                  <button class="btn {$layoutMode === 'compact' ? 'btn-xs' : 'btn-sm'} btn-warning" onclick={() => onUnpublish?.(v.id)}>{$_('common.unpublish')}</button>
                {/if}
                {#if onDelete && v.status !== 'deleted'}
                  <button class="btn {$layoutMode === 'compact' ? 'btn-xs' : 'btn-sm'} btn-error" onclick={() => onDelete?.(v.id)}>{$_('common.delete')}</button>
                {/if}
              </div>
            {:else if v.status === "processing" || v.status === "in_queue"}
              <div class="card-actions justify-end mt-auto">
                <a href="/new/review/{v.id}" class="btn {$layoutMode === 'compact' ? 'btn-xs' : 'btn-sm'} btn-primary">{$_('review.viewStatus')}</a>
              </div>
            {:else if v.status === "uploaded"}
              <div class="card-actions justify-end mt-auto gap-1">
                <a href="/new/review/{v.id}" class="btn {$layoutMode === 'compact' ? 'btn-xs' : 'btn-sm'} btn-primary">{$_('review.continueSetup')}</a>
                {#if onDelete}
                  <button class="btn {$layoutMode === 'compact' ? 'btn-xs' : 'btn-sm'} btn-error" onclick={() => onDelete?.(v.id)}>{$_('common.delete')}</button>
                {/if}
              </div>
            {:else if v.status === 'failed'}
              <div class="card-actions justify-end mt-auto gap-1">
                <a href="/new/review/{v.id}" class="btn {$layoutMode === 'compact' ? 'btn-xs' : 'btn-sm'} btn-warning">{$_('videos.actions.retry')}</a>
                {#if onDelete}
                  <button class="btn {$layoutMode === 'compact' ? 'btn-xs' : 'btn-sm'} btn-error" onclick={() => onDelete?.(v.id)}>{$_('common.delete')}</button>
                {/if}
              </div>
            {:else if v.status === 'deleted'}
              <div class="card-actions justify-end mt-auto">
                <span class="text-xs opacity-60">{$_('videos.deleted')}</span>
              </div>
            {/if}
          </div>
        </div>
      {/if}
    {/each}
  </div>
{/if}
