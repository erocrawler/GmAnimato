<script lang="ts">
  import { goto } from '$app/navigation';
  import { navigating } from '$app/stores';
  import { _ } from 'svelte-i18n';
  import type { PageData } from './$types';
  import VideoList from '$lib/components/VideoList.svelte';
  import Pagination from '$lib/components/Pagination.svelte';
  import LayoutToggle from '$lib/components/LayoutToggle.svelte';

  let { data } = $props<{ data: PageData }>();
  let statusFilter = $state(data.statusFilter || '');
  let userFilter = $state(data.userFilter || '');
  let message = $state('');
  const isLoading = $derived(Boolean($navigating));

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
    await goto(url.toString());
  }

  async function clearFilters() {
    if (isLoading) return;
    statusFilter = '';
    userFilter = '';
    await goto('/admin/videos');
  }

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
