<script lang="ts">
  import { goto } from '$app/navigation';
  import { _ } from 'svelte-i18n';
  import type { PageData } from './$types';

  let { data } = $props<{ data: PageData }>();
  let statusFilter = $state(data.statusFilter || '');
  let userFilter = $state(data.userFilter || '');
  let message = $state('');

  async function setPage(newPage: number) {
    const url = new URL(window.location.href);
    url.searchParams.set('page', newPage.toString());
    await goto(url.toString());
  }

  async function applyFilters() {
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
    await goto(url.toString());
  }

  async function clearFilters() {
    statusFilter = '';
    userFilter = '';
    await goto('/admin/videos');
  }

  async function unpublishVideo(videoId: string, username: string) {
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

  async function deleteVideo(videoId: string, username: string) {
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

  function getStatusBadgeClass(status: string) {
    switch (status) {
      case 'completed': return 'badge-success';
      case 'processing':
      case 'in_queue': return 'badge-warning';
      case 'failed': return 'badge-error';
      case 'deleted': return 'badge-neutral';
      default: return 'badge-info';
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
      <h2 class="card-title">{$_('admin.videos.filters')}</h2>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
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
          <label class="label" for="user-filter">
            <span class="label-text">{$_('users.username')}</span>
          </label>
          <input id="user-filter" type="text" bind:value={userFilter} placeholder="{$_('admin.videos.filters')}" class="input input-bordered" />
        </div>

        <div class="form-control flex flex-col justify-end">
          <div class="flex gap-2">
            <button class="btn btn-primary flex-1" onclick={applyFilters}>{$_('common.apply')}</button>
            <button class="btn btn-ghost" onclick={clearFilters}>{$_('common.clear')}</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Videos Grid -->
  <div class="mb-4 text-sm text-base-content/70">
    {$_('admin.videos.total', { values: { count: data.total } })}
  </div>

  {#if data.videos.length === 0}
    <div class="alert">
      <span>{$_('admin.videos.noVideos')}</span>
    </div>
  {:else}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-6">
      {#each data.videos as v}
        <div class="card bg-base-100 shadow-xl image-full">
          {#if v.original_image_url}
            <figure>
              <img src={v.original_image_url} alt="thumbnail" class="w-full h-full object-cover" />
            </figure>
          {:else}
            <figure class="bg-base-300">
              <div class="w-full h-full flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-24 w-24 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
            </figure>
          {/if}
          <div class="card-body">
            <div class="flex items-center gap-2 mb-2">
              <div class="badge badge-lg {getStatusBadgeClass(v.status)}">
                {v.status}
              </div>
              {#if v.is_published}
                <div class="badge badge-info">Published</div>
              {/if}
            </div>

            <p class="text-sm font-semibold mb-1">By: {v.username}</p>
            
            {#if v.prompt}
              <p class="text-sm line-clamp-2 mb-2">{v.prompt}</p>
            {/if}

            <div class="card-actions justify-end mt-auto gap-1">
              {#if v.status === 'completed'}
                <a href="/videos/{v.id}" class="btn btn-xs btn-primary" target="_blank">{$_('common.view')}</a>
              {/if}
              {#if v.is_published}
                <button class="btn btn-xs btn-warning" onclick={() => unpublishVideo(v.id, v.username)}>{$_('common.unpublish')}</button>
              {/if}
              {#if v.status !== 'deleted'}
                <button class="btn btn-xs btn-error" onclick={() => deleteVideo(v.id, v.username)}>{$_('common.delete')}</button>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>

    <!-- Pagination -->
    {#if data.totalPages > 1}
      <div class="flex justify-center">
        <div class="join">
          <button 
            class="join-item btn" 
            disabled={data.page === 1}
            onclick={() => setPage(data.page - 1)}
          >
            «
          </button>
          {#each Array.from({ length: data.totalPages }, (_, i) => i + 1) as pageNum}
            {#if pageNum === 1 || pageNum === data.totalPages || Math.abs(pageNum - data.page) <= 2}
              <button 
                class="join-item btn" 
                class:btn-active={pageNum === data.page}
                onclick={() => setPage(pageNum)}
              >
                {pageNum}
              </button>
            {:else if pageNum === data.page - 3 || pageNum === data.page + 3}
              <button class="join-item btn btn-disabled">...</button>
            {/if}
          {/each}
          <button 
            class="join-item btn" 
            disabled={data.page === data.totalPages}
            onclick={() => setPage(data.page + 1)}
          >
            »
          </button>
        </div>
      </div>
    {/if}
  {/if}
</div>
