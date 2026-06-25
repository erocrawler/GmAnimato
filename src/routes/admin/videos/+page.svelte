<script lang="ts">
  import { goto } from '$app/navigation';
  import { navigating } from '$app/stores';
  import { _ } from 'svelte-i18n';
  import type { PageData } from './$types';
  import VideoList from '$lib/components/VideoList.svelte';
  import Pagination from '$lib/components/Pagination.svelte';
  import LayoutToggle from '$lib/components/LayoutToggle.svelte';

  let { data } = $props<{ data: PageData }>();
  let statusFilter = $state('');
  let userFilter = $state('');
  let modelTypeFilter = $state<string[]>([]);
  let message = $state('');
  const isLoading = $derived(Boolean($navigating));

  // Sync filters with data when it changes
  $effect(() => {
    statusFilter = data.statusFilter || '';
    userFilter = data.userFilter || '';
    modelTypeFilter = Array.isArray(data.modelTypeFilter) ? [...data.modelTypeFilter] : [];
  });

  async function setPage(newPage: number) {
    if (isLoading) return;
    const url = new URL(window.location.href);
    url.searchParams.set('page', newPage.toString());
    await goto(url.toString());
  }

  async function applyFilters() {
    if (isLoading) return;
    const url = new URL(window.location.href);
    url.searchParams.set('page', '1');
    if (statusFilter) {
      url.searchParams.set('status', statusFilter);
    } else {
      url.searchParams.delete('status');
    }
    if (userFilter) {
      url.searchParams.set('user', userFilter);
    } else {
      url.searchParams.delete('user');
    }
    url.searchParams.delete('modelType');
    for (const mt of modelTypeFilter) {
      url.searchParams.append('modelType', mt);
    }
    await goto(url.toString());
  }

  async function clearFilters() {
    if (isLoading) return;
    statusFilter = '';
    userFilter = '';
    modelTypeFilter = [];
    await goto('/admin/videos');
  }

  function toggleModelType(id: string) {
    if (modelTypeFilter.includes(id)) {
      modelTypeFilter = modelTypeFilter.filter((m) => m !== id);
    } else {
      modelTypeFilter = [...modelTypeFilter, id];
    }
  }

  function getModelName(id: string): string {
    const mt = (data.modelTypes || []).find((m: any) => m.id === id);
    return mt?.name || id;
  }

  // Group model types by workflowType: i2v, fl2v, then other/unassigned
  const groupedModelTypes = $derived.by(() => {
    const types = data.modelTypes || [];
    const i2v = types.filter((m: any) => m.workflowType === 'i2v');
    const fl2v = types.filter((m: any) => m.workflowType === 'fl2v');
    const other = types.filter((m: any) => m.workflowType !== 'i2v' && m.workflowType !== 'fl2v');
    return { i2v, fl2v, other };
  });

  async function unpublishVideo(videoId: string) {
    const video = data.videos.find((v: any) => v.id === videoId);
    const username = video?.username || 'Unknown';
    const message_confirm = $_('admin.videos.unpublishConfirm', { values: { username } });
    if (!confirm(message_confirm)) return;

    try {
      const response = await fetch(`/api/admin/videos/${videoId}/unpublish`, {
        method: 'POST',
      });

      if (response.ok) {
        message = $_('admin.videos.videoUnpublished');
        setTimeout(() => message = '', 3000);
        window.location.reload();
      } else {
        const error = await response.json();
        message = $_('admin.videos.unpublishError', { values: { error: error.error || 'Failed to unpublish video' } });
      }
    } catch (err) {
      message = $_('admin.videos.unpublishError', { values: { error: String(err) } });
    }
  }

  async function deleteVideo(videoId: string) {
    const video = data.videos.find((v: any) => v.id === videoId);
    const username = video?.username || 'Unknown';
    const message_confirm = $_('admin.videos.deleteConfirm', { values: { username } });
    if (!confirm(message_confirm)) return;

    try {
      const response = await fetch(`/api/admin/videos/${videoId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        message = $_('admin.videos.videoDeleted');
        setTimeout(() => message = '', 3000);
        window.location.reload();
      } else {
        const error = await response.json();
        message = $_('admin.videos.unpublishError', { values: { error: error.error || 'Failed to delete video' } });
      }
    } catch (err) {
      message = $_('admin.videos.unpublishError', { values: { error: String(err) } });
    }
  }
</script>

<div class="container mx-auto p-6 max-w-7xl">
  <div class="flex justify-between items-center mb-6">
    <h1 class="text-3xl font-bold">{$_('admin.videos.title')}</h1>
    <a href="/admin" class="btn btn-ghost">
      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
      </svg>
      Back to Admin
    </a>
  </div>

  {#if message}
    <div class="alert mb-4" class:alert-success={message.startsWith('✓')} class:alert-error={message.startsWith('✗')}>
      {message}
    </div>
  {/if}

  <!-- Filters -->
  <div class="card bg-base-200 shadow-xl mb-6">
    <div class="card-body">
      <div class="flex justify-between items-center mb-4">
        <h2 class="card-title">{$_('admin.videos.filters')}</h2>
        <LayoutToggle />
      </div>
      <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div class="form-control">
          <label class="label" for="status-filter">
            <span class="label-text">{$_('videos.filters.status')}</span>
          </label>
          <select id="status-filter" bind:value={statusFilter} class="select select-bordered">
            <option value="">{$_('common.all')}</option>
            <option value="uploaded">{$_('videos.status.uploaded')}</option>
            <option value="in_queue">{$_('videos.status.in_queue')}</option>
            <option value="processing">{$_('videos.status.processing')}</option>
            <option value="completed">{$_('videos.status.completed')}</option>
            <option value="failed">{$_('videos.status.failed')}</option>
            <option value="deleted">Deleted</option>
          </select>
        </div>

        <div class="form-control">
          <label class="label" for="model-type-filter">
            <span class="label-text">{$_('admin.videos.modelType')}</span>
          </label>
          <div class="dropdown w-full" id="model-type-filter">
            <div tabindex="0" role="button" class="select select-bordered w-full flex items-center justify-between min-h-10 h-auto py-1 cursor-pointer">
              {#if modelTypeFilter.length === 0}
                <span class="opacity-60">{$_('common.all')}</span>
              {:else}
                <span class="flex flex-wrap gap-1 py-1">
                  {#each modelTypeFilter as mt}
                    <span class="badge badge-primary badge-sm gap-1">
                      {getModelName(mt)}
                      <button type="button" onclick={(e) => { e.preventDefault(); e.stopPropagation(); toggleModelType(mt); }} class="cursor-pointer" aria-label={$_('common.clear')}>
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </span>
                  {/each}
                </span>
              {/if}
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 opacity-60 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </div>
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <div tabindex="0" class="dropdown-content z-50 menu p-2 shadow-xl bg-base-100 rounded-box w-full min-w-64 max-h-72 overflow-y-auto">
                {#if (data.modelTypes || []).length === 0}
                  <span class="text-sm opacity-60 px-2 py-1">{$_('admin.videos.noModelTypes')}</span>
                {:else}
                  <label class="label cursor-pointer justify-start gap-3 py-1">
                    <input type="checkbox" class="checkbox checkbox-sm" checked={modelTypeFilter.length === 0} onchange={() => { if (modelTypeFilter.length > 0) modelTypeFilter = []; }} />
                    <span class="label-text">{$_('common.all')}</span>
                  </label>
                  <div class="divider my-0 h-1"></div>
                  {#if groupedModelTypes.i2v.length > 0}
                    <div class="text-xs font-semibold opacity-60 px-2 pt-1 pb-0.5">{$_('admin.videos.groupI2V')}</div>
                    {#each groupedModelTypes.i2v as mt}
                      <label class="label cursor-pointer justify-start gap-3 py-1">
                        <input type="checkbox" class="checkbox checkbox-sm" checked={modelTypeFilter.includes(mt.id)} onchange={() => toggleModelType(mt.id)} />
                        <span class="label-text flex items-center gap-1">
                          {mt.name}
                          {#if mt.isDeleted}
                            <span class="badge badge-error badge-xs" title={$_('admin.videos.deletedModel')}>{$_('admin.videos.deleted')}</span>
                          {:else if !mt.available}
                            <span class="badge badge-warning badge-xs" title={$_('admin.videos.legacyModel')}>{$_('admin.videos.legacy')}</span>
                          {/if}
                        </span>
                      </label>
                    {/each}
                  {/if}
                  {#if groupedModelTypes.fl2v.length > 0}
                    <div class="text-xs font-semibold opacity-60 px-2 pt-2 pb-0.5">{$_('admin.videos.groupFL2V')}</div>
                    {#each groupedModelTypes.fl2v as mt}
                      <label class="label cursor-pointer justify-start gap-3 py-1">
                        <input type="checkbox" class="checkbox checkbox-sm" checked={modelTypeFilter.includes(mt.id)} onchange={() => toggleModelType(mt.id)} />
                        <span class="label-text flex items-center gap-1">
                          {mt.name}
                          {#if mt.isDeleted}
                            <span class="badge badge-error badge-xs" title={$_('admin.videos.deletedModel')}>{$_('admin.videos.deleted')}</span>
                          {:else if !mt.available}
                            <span class="badge badge-warning badge-xs" title={$_('admin.videos.legacyModel')}>{$_('admin.videos.legacy')}</span>
                          {/if}
                        </span>
                      </label>
                    {/each}
                  {/if}
                  {#if groupedModelTypes.other.length > 0}
                    <div class="text-xs font-semibold opacity-60 px-2 pt-2 pb-0.5">{$_('admin.videos.groupOther')}</div>
                    {#each groupedModelTypes.other as mt}
                      <label class="label cursor-pointer justify-start gap-3 py-1">
                        <input type="checkbox" class="checkbox checkbox-sm" checked={modelTypeFilter.includes(mt.id)} onchange={() => toggleModelType(mt.id)} />
                        <span class="label-text flex items-center gap-1">
                          {mt.name}
                          {#if mt.isDeleted}
                            <span class="badge badge-error badge-xs" title={$_('admin.videos.deletedModel')}>{$_('admin.videos.deleted')}</span>
                          {:else if !mt.available}
                            <span class="badge badge-warning badge-xs" title={$_('admin.videos.legacyModel')}>{$_('admin.videos.legacy')}</span>
                          {/if}
                        </span>
                      </label>
                    {/each}
                  {/if}
                {/if}
            </div>
          </div>
        </div>

        <div class="form-control">
          <label class="label" for="user-filter">
            <span class="label-text">{$_('users.username')}</span>
          </label>
          <input id="user-filter" type="text" bind:value={userFilter} placeholder="{$_('admin.videos.filters')}" class="input input-bordered" />
        </div>

        <div class="form-control flex flex-col justify-end">
          <div class="flex gap-2">
            <button class="btn btn-primary flex-1" disabled={isLoading} onclick={applyFilters}>{$_('common.apply')}</button>
            <button class="btn btn-ghost" disabled={isLoading} onclick={clearFilters}>{$_('common.clear')}</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Videos Grid -->
  <div class="mb-4 text-sm text-base-content/70">
    {$_('admin.videos.total', { values: { count: data.total } })}
  </div>

  <VideoList
    videos={data.videos}
    type="admin"
    loading={isLoading}

    pageSize={data.pageSize}
    emptyMessage={$_('admin.videos.noVideos')}
    onDelete={deleteVideo}
    onUnpublish={unpublishVideo}
  />

  <Pagination
    currentPage={data.page}
    totalPages={data.totalPages}
    disabled={isLoading}
    onPageChange={setPage}
  />
</div>
