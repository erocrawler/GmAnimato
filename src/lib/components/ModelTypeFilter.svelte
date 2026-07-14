<script lang="ts">
  import { _ } from 'svelte-i18n';
  import type { VideoModelType } from '$lib/IDatabase';

  let {
    modelTypes = [],
    selected = [],
    id = 'model-type-filter',
    label = '',
    placeholderAll = '',
    onToggle,
  }: {
    modelTypes: VideoModelType[];
    selected: string[];
    id?: string;
    label?: string;
    placeholderAll?: string;
    onToggle?: (id: string) => void;
  } = $props();

  function getName(id: string): string {
    const mt = modelTypes.find((m:any) => m.id === id);
    return mt?.name || id;
  }

  const grouped = $derived.by(() => {
    const types = modelTypes || [];
    const i2v = types.filter((m:any) => m.workflowType === 'i2v');
    const fl2v = types.filter((m:any) => m.workflowType === 'fl2v');
    const other = types.filter((m:any) => m.workflowType !== 'i2v' && m.workflowType !== 'fl2v');
    return { i2v, fl2v, other };
  });

  function handleToggle(mid: string) {
    if (onToggle) onToggle(mid);
  }
</script>

<div class="form-control w-full" id={id}>
  {#if label}
    <label class="label" for="{id}-btn"><span class="label-text">{label}</span></label>
  {/if}
  <div class="dropdown w-full">
    <div tabindex="0" role="button" id="{id}-btn" class="select select-bordered w-full flex items-center justify-between min-h-10 h-auto py-1 cursor-pointer">
      {#if selected.length === 0}
        <span class="opacity-60">{placeholderAll || $_('common.all') || 'All'}</span>
      {:else}
        <span class="flex flex-wrap gap-1 py-1">
          {#each selected as mt}
            <span class="badge badge-primary badge-sm gap-1">
              {getName(mt)}
              <button type="button" onclick={(e) => { e.preventDefault(); e.stopPropagation(); handleToggle(mt); }} class="cursor-pointer" aria-label="remove">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </span>
          {/each}
        </span>
      {/if}
      <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 opacity-60 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
    </div>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div tabindex="0" class="dropdown-content z-50 menu p-2 shadow-xl bg-base-100 rounded-box w-full min-w-64 max-h-72 overflow-y-auto">
      {#if modelTypes.length === 0}
        <span class="text-sm opacity-60 px-2 py-1">No models</span>
      {:else}
        <label class="label cursor-pointer justify-start gap-3 py-1">
          <input type="checkbox" class="checkbox checkbox-sm" checked={selected.length === 0} onchange={() => { if (selected.length > 0) { for (const s of [...selected]) handleToggle(s); } }} />
          <span class="label-text">{$_('common.all') || 'All'}</span>
        </label>
        <div class="divider my-0 h-1"></div>
        {#if grouped.i2v.length > 0}
          <div class="text-xs font-semibold opacity-60 px-2 pt-1 pb-0.5">I2V</div>
          {#each grouped.i2v as mt}
            <label class="label cursor-pointer justify-start gap-3 py-1">
              <input type="checkbox" class="checkbox checkbox-sm" checked={selected.includes(mt.id)} onchange={() => handleToggle(mt.id)} />
              <span class="label-text flex items-center gap-1">
                {mt.name}
                {#if mt.isDeleted}<span class="badge badge-error badge-xs">del</span>{:else if !mt.available}<span class="badge badge-warning badge-xs">legacy</span>{/if}
              </span>
            </label>
          {/each}
        {/if}
        {#if grouped.fl2v.length > 0}
          <div class="text-xs font-semibold opacity-60 px-2 pt-2 pb-0.5">FL2V</div>
          {#each grouped.fl2v as mt}
            <label class="label cursor-pointer justify-start gap-3 py-1">
              <input type="checkbox" class="checkbox checkbox-sm" checked={selected.includes(mt.id)} onchange={() => handleToggle(mt.id)} />
              <span class="label-text flex items-center gap-1">
                {mt.name}
                {#if mt.isDeleted}<span class="badge badge-error badge-xs">del</span>{:else if !mt.available}<span class="badge badge-warning badge-xs">legacy</span>{/if}
              </span>
            </label>
          {/each}
        {/if}
        {#if grouped.other.length > 0}
          <div class="text-xs font-semibold opacity-60 px-2 pt-2 pb-0.5">Other</div>
          {#each grouped.other as mt}
            <label class="label cursor-pointer justify-start gap-3 py-1">
              <input type="checkbox" class="checkbox checkbox-sm" checked={selected.includes(mt.id)} onchange={() => handleToggle(mt.id)} />
              <span class="label-text">{mt.name}</span>
            </label>
          {/each}
        {/if}
      {/if}
    </div>
  </div>
</div>
