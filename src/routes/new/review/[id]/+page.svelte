<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { goto } from "$app/navigation";
  import { _ } from 'svelte-i18n';
  import { get } from 'svelte/store';
  import { createTagsInput, melt } from '@melt-ui/svelte';
  import { DEFAULT_LORA_PRESETS } from '$lib/loraPresets';
  import type { LoraPreset } from '$lib/loraPresets';
  import type { Workflow } from '$lib/IDatabase';

  export let data: any;
  let entry = data.entry as any;
  let sponsorUrl = data.sponsorUrl || '';
  let prompt =
    entry.prompt ||
    (entry.suggested_prompts && entry.suggested_prompts[0]) ||
    "";
  let busy = false;
  let message = "";
  let newtag = "";
  let showBusyModal = false;
  let busyModalMessage = "";
  let limitType: 'user' | 'system' | null = null;
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let showAdvancedSettings = false;
  let progressPercentage: number | null = null;
  let quotaRemaining: number | null = null;
  let quotaLoading = true;

  // Workflow management - initialize from loaded data
  let workflows: Workflow[] = data.workflows || [];
  let selectedWorkflowId: string = '';
  let loadingWorkflows = false;
  
  // Detect workflow type based on video mode
  $: videoWorkflowType = entry.last_image_url ? 'fl2v' : 'i2v';
  
  // Filter workflows by type to match the video
  $: filteredWorkflows = workflows.filter(w => w.workflowType === videoWorkflowType);

  const LORA_PRESETS: LoraPreset[] = (data.loraPresets && data.loraPresets.length > 0)
    ? data.loraPresets
    : DEFAULT_LORA_PRESETS;

  const hasAdvancedFeatures: boolean = data.hasAdvancedFeatures || false;

  type IterationSteps = 4 | 6;
  let stepOptions: { value: IterationSteps; label: string; description: string; requiresPaid?: boolean }[] = [];

  // Check if entry has non-default values (indicating it's a previously saved video)
  const hasExistingSettings = entry.iteration_steps || entry.video_duration || entry.video_resolution || 
                               entry.additional_options?.motion_scale !== undefined || 
                               entry.additional_options?.freelong_blend_strength !== undefined ||
                               entry.lora_weights;

  // Load from localStorage if no existing settings
  let savedSettings: any = null;
  let savedWorkflowLoraSettings: Record<string, { loraEnabled: Record<string, boolean>, loraWeights: Record<string, number> }> = {};
  if (!hasExistingSettings && typeof window !== 'undefined') {
    try {
      const saved = localStorage.getItem('video_generation_settings');
      if (saved) {
        savedSettings = JSON.parse(saved);
      }
      // Load per-workflow lora settings
      const savedLora = localStorage.getItem('workflow_lora_settings');
      if (savedLora) {
        savedWorkflowLoraSettings = JSON.parse(savedLora);
      }
    } catch (err) {
      console.error('Failed to load settings from localStorage:', err);
    }
  }

  type VideoDuration = 4 | 6;
  type VideoResolution = '480p' | '720p';
  let iterationSteps: IterationSteps = (entry.iteration_steps as IterationSteps) || (savedSettings?.iterationSteps as IterationSteps) || 4;
  let videoDuration: VideoDuration = (entry.video_duration as VideoDuration) || (savedSettings?.videoDuration as VideoDuration) || 4;
  let videoResolution: VideoResolution = (entry.video_resolution as VideoResolution) || (savedSettings?.videoResolution as VideoResolution) || '480p';
  let motionScale: number | undefined = entry.additional_options?.motion_scale ?? savedSettings?.motionScale; // 0.5 to 2.0
  let freeLongBlendStrength: number | undefined = entry.additional_options?.freelong_blend_strength ?? savedSettings?.freeLongBlendStrength; // 0 to 1
  
  let resolutionOptions: { value: VideoResolution; label: string; description: string; requiresPaid?: boolean }[] = [
    { value: '480p', label: '', description: '', requiresPaid: false },
    { value: '720p', label: '', description: '', requiresPaid: true },
  ];

  $: canUseQuality = hasAdvancedFeatures;
  $: visibleStepOptions = canUseQuality ? stepOptions : stepOptions.filter((o) => !o.requiresPaid);
  $: visibleResolutionOptions = canUseQuality ? resolutionOptions : resolutionOptions.filter((o) => !o.requiresPaid);
  
  // Get LoRAs compatible with selected workflow
  $: filteredLoraPresets = selectedWorkflowId && filteredWorkflows.length > 0
    ? (() => {
        const workflow = filteredWorkflows.find(w => w.id === selectedWorkflowId);
        if (workflow) {
          return LORA_PRESETS.filter(lora => workflow.compatibleLoraIds.includes(lora.id));
        }
        return LORA_PRESETS;
      })()
    : LORA_PRESETS;
  $: if (!canUseQuality && videoResolution === '720p') videoResolution = '480p';
  $: if (!canUseQuality && iterationSteps === 6) iterationSteps = 4;
  $: resolutionOptions = [
    { value: '480p', label: get(_)('review.resolution.standard'), description: get(_)('review.resolution.standardDesc'), requiresPaid: false },
    { value: '720p', label: get(_)('review.resolution.hd'), description: get(_)('review.resolution.hdDesc'), requiresPaid: true },
  ];
  $: stepOptions = [
    { value: 4, label: get(_)('review.iteration.fast'), description: get(_)('review.iteration.steps.fast'), requiresPaid: false },
    { value: 6, label: get(_)('review.iteration.balanced'), description: get(_)('review.iteration.steps.balanced'), requiresPaid: true },
  ];


  // Track enabled state for each LoRA - initialize with defaults
  // Will be updated by reactive statement when workflow is selected
  let loraEnabled: Record<string, boolean> = entry.lora_weights 
    ? Object.fromEntries(
        LORA_PRESETS.map((lora) => [
          lora.id,
          entry.lora_weights?.[lora.id] !== undefined
        ])
      )
    : Object.fromEntries(
        LORA_PRESETS.map((lora) => [
          lora.id,
          lora.isConfigurable === false
            ? true
            : lora.enabled !== undefined
              ? lora.enabled
              : true
        ])
      );
  let loraWeights: Record<string, number> = entry.lora_weights || Object.fromEntries(
    LORA_PRESETS.map((lora) => [lora.id, lora.default])
  );

  // When workflow changes, load the saved lora settings for that workflow
  $: if (selectedWorkflowId && filteredLoraPresets && Array.isArray(filteredLoraPresets)) {
    // Check if we have saved settings for this workflow
    const workflowSettings = savedWorkflowLoraSettings[selectedWorkflowId];
    
    const newLoraEnabled: Record<string, boolean> = {};
    const newLoraWeights: Record<string, number> = {};
    
    filteredLoraPresets.forEach((lora) => {
      // For required LoRAs, always enable them
      if (lora.isConfigurable === false) {
        newLoraEnabled[lora.id] = true;
      } else {
        // Use saved value for this workflow, or lora default
        newLoraEnabled[lora.id] = workflowSettings?.loraEnabled?.[lora.id] ?? 
          (lora.enabled !== undefined ? lora.enabled : true);
      }
      
      // Use saved weight for this workflow, or lora default
      newLoraWeights[lora.id] = workflowSettings?.loraWeights?.[lora.id] ?? lora.default;
    });
    
    loraEnabled = newLoraEnabled;
    loraWeights = newLoraWeights;
  }

  $: isEditable = entry.status !== 'processing' && entry.status !== 'completed' && entry.status !== 'in_queue' && entry.status !== 'failed' && entry.status !== 'deleted';

  async function pollStatus() {
    if (entry.status === 'completed' || entry.status === 'failed' || entry.status === 'deleted') {
      return; // Stop polling if completed or failed
    }

    try {
      const res = await fetch(`/api/video/${entry.id}/status`);
      if (res.ok) {
        const statusData = await res.json();
        console.log('Status poll result:', statusData);
        
        // Update entry status from server response
        if (statusData.status && statusData.status !== entry.status) {
          entry = { ...entry, status: statusData.status };
        }
        
        // Update progress information
        if (typeof statusData.progress_percentage === 'number') {
          progressPercentage = statusData.progress_percentage;
        } else {
          progressPercentage = null;
        }

        // If job is completed, redirect to videos page
        if (statusData.status === 'completed') {
          await goto(`/videos/${entry.id}?returnTo=/videos`);
        }
      }
    } catch (err) {
      console.error('Failed to poll status:', err);
    }
  }

  async function retryGeneration() {
    try {
      const res = await fetch(`/api/video/${entry.id}/retry`, {
        method: 'POST'
      });
      
      if (res.ok) {
        const result = await res.json();
        message = get(_)('review.jobResubmitted');
        // Update status from server response
        if (result.status) {
          entry = { ...entry, status: result.status, job_id: result.job_id };
        } else {
          entry = { ...entry, status: 'in_queue' };
        }
        pollStatus();
        if (!pollInterval) {
          pollInterval = setInterval(pollStatus, 10000);
        }
      } else {
        const error = await res.json();
        const t = get(_);
        alert(t('review.failedToRetry', { values: { error: error.error || 'Unknown error' } }));
      }
    } catch (err) {
      console.error('Failed to retry generation:', err);
      alert(get(_)('review.failedToRetry', { values: { error: String(err) } }));
    }
  }

  onMount(async () => {
    // Initialize workflow selection from loaded data
    const workflowsForType = workflows.filter(w => w.workflowType === videoWorkflowType);
    
    // For editable entries, prefer localStorage (user's last choice)
    // For processing/completed entries, respect the entry's workflow_id
    if (isEditable && savedSettings?.selectedWorkflowId) {
      const savedWorkflow = workflowsForType.find(w => w.id === savedSettings.selectedWorkflowId);
      if (savedWorkflow) {
        selectedWorkflowId = savedWorkflow.id;
      }
    }
    
    // Fallback to entry.workflow_id if we haven't set one yet
    if (!selectedWorkflowId && entry.workflow_id) {
      const savedWorkflow = workflowsForType.find(w => w.id === entry.workflow_id);
      if (savedWorkflow) {
        selectedWorkflowId = savedWorkflow.id;
      }
    }
    
    // Final fallback to default workflow
    if (!selectedWorkflowId) {
      const defaultWorkflow = workflowsForType.find(w => w.isDefault);
      selectedWorkflowId = defaultWorkflow?.id || (workflowsForType[0]?.id || '');
    }


    // Fetch remaining quota
    try {
      const quotaRes = await fetch('/api/quota');
      if (quotaRes.ok) {
        const quotaData = await quotaRes.json();
        quotaRemaining = quotaData.remaining;
      }
    } catch (err) {
      console.error('Failed to fetch quota:', err);
    } finally {
      quotaLoading = false;
    }

    // Redirect to video details if already completed
    if (entry.status === 'completed') {
      setTimeout(() => {
        goto(`/videos/${entry.id}?returnTo=/videos`);
      }, 1000); // wait 1 second before redirecting, otherwise the entry may not be ready
      return;
    }
    
    // Start polling if video is in progress
    if (entry.status === 'in_queue' || entry.status === 'processing') {
      pollStatus(); // Initial poll
      pollInterval = setInterval(pollStatus, 5000); // Poll every 5 seconds
    }
  });

  onDestroy(() => {
    if (pollInterval) {
      clearInterval(pollInterval);
    }
  });

  // Automatically save settings to localStorage whenever any setting changes
  // Access variables first to ensure Svelte tracks them
  $: settings = {
    iterationSteps,
    videoDuration,
    videoResolution,
    motionScale,
    freeLongBlendStrength,
    selectedWorkflowId
  };
  
  // Save global settings to localStorage whenever they change
  $: if (typeof window !== 'undefined') {
    try {
      localStorage.setItem('video_generation_settings', JSON.stringify(settings));
    } catch (err) {
      console.error('Failed to save settings to localStorage:', err);
    }
  }
  
  // Save per-workflow lora settings to localStorage
  $: if (typeof window !== 'undefined' && selectedWorkflowId) {
    try {
      // Load existing workflow lora settings
      const saved = localStorage.getItem('workflow_lora_settings');
      const allSettings = saved ? JSON.parse(saved) : {};
      
      // Update settings for current workflow
      allSettings[selectedWorkflowId] = {
        loraEnabled,
        loraWeights
      };
      
      localStorage.setItem('workflow_lora_settings', JSON.stringify(allSettings));
    } catch (err) {
      console.error('Failed to save workflow lora settings to localStorage:', err);
    }
  }



  function updateLoraWeight(id: string, value: number) {
    const preset = LORA_PRESETS.find((p) => p.id === id);
    const min = preset?.min ?? 0;
    const max = preset?.max ?? 1.5;
    const clamped = Math.max(min, Math.min(max, value));
    loraWeights = { ...loraWeights, [id]: clamped };
  }

  function toggleLoraEnabled(id: string) {
    const preset = LORA_PRESETS.find((p) => p.id === id);
    if (preset && preset.isConfigurable !== false) {
      loraEnabled = { ...loraEnabled, [id]: !loraEnabled[id] };
    }
  }

  function resetLoraWeights() {
    loraWeights = Object.fromEntries(filteredLoraPresets.map((lora) => [lora.id, lora.default]));
    loraEnabled = Object.fromEntries(
      filteredLoraPresets.map((lora) => [
        lora.id,
        lora.isConfigurable === false
          ? true
          : lora.enabled !== undefined
            ? lora.enabled
            : true
      ])
    );
  }

  function resetAdvancedSettings() {
    iterationSteps = 4;
    videoDuration = 4;
    videoResolution = '480p';
    motionScale = undefined;
    freeLongBlendStrength = undefined;
    resetLoraWeights();
    
    // Reset to default workflow for current type
    const defaultWorkflow = filteredWorkflows.find(w => w.isDefault);
    if (defaultWorkflow) {
      selectedWorkflowId = defaultWorkflow.id;
    }
  }

  const {
    elements: { root, input, tag, deleteTrigger, edit },
    states: { tags },
    helpers: { addTag }
  } = createTagsInput({
    defaultTags: entry.tags || [],
    unique: true,
    trim: true
  });

  async function generate() {
    busy = true;
    message = "";
    showBusyModal = false;
    busyModalMessage = "";
    limitType = null;
    
    try {
      const t = get(_);
      // Check health before proceeding
      const healthRes = await fetch('/api/health');
      if (healthRes.ok) {
        const health = await healthRes.json();
        if (!health.available || health.queueFull) {
          showBusyModal = true;
          limitType = 'system';
          busyModalMessage = t('review.serverBusy.queueFull');
          busy = false;
          return;
        }
      }
      
      // Kickoff the I2V job with updated prompt and tags
      // Only include enabled LoRAs
      const filteredLoraWeights = Object.fromEntries(
        Object.entries(loraWeights).filter(([id]) => loraEnabled[id])
      );
      const res = await fetch("/api/i2v/kickoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          id: entry.id, 
          prompt, 
          tags: $tags.map(t => t.value),
          workflowId: selectedWorkflowId,
          loraWeights: filteredLoraWeights,
          iterationSteps,
          videoDuration,
          videoResolution,
          motionScale,
          freeLongBlendStrength
        }),
      });
      
      if (!res.ok) {
        const j = await res.json();
        if (res.status === 429) {
          // User hit their personal limit
          showBusyModal = true;
          limitType = 'user';
          busyModalMessage = j.error || t('review.serverBusy.userLimit');
        } else if (res.status === 503) {
          // System-wide queue full
          showBusyModal = true;
          limitType = 'system';
          busyModalMessage = t('review.serverBusy.highDemand');
        } else {
          message = t('review.failedToSubmit', { values: { error: j.error || 'unknown' } });
        }
        return;
      }
      
      const j = await res.json();
      if (j.success) {
        message = t('review.jobSubmitted');
        // Update local entry with the returned video data
        if (j.video) {
          entry = j.video;
        } else {
          // Fallback to manual status update
          entry = { ...entry, status: 'in_queue' };
        }
        // navigate to user's videos or detail page
        await goto("/videos");
      } else {
        message = t('review.failedToSubmit', { values: { error: j.error || 'unknown' } });
      }
    } catch (err) {
      message = "Error: " + String(err);
    } finally {
      busy = false;
    }
  }

  async function deleteVideo() {
    if (!confirm(get(_)('review.deleteConfirm'))) {
      return;
    }
    
    try {
      const res = await fetch(`/api/video/${entry.id}`, {
        method: 'DELETE'
      });
      
      if (res.ok) {
        await goto('/videos');
      } else {
        alert('Failed to delete video');
      }
    } catch (err) {
      alert('Error deleting video: ' + err);
    }
  }

  function addNewTag() {
    if (newtag && newtag.trim() !== "") {
      addTag(newtag.trim());
      newtag = "";
    }
  }
</script>

<div class="max-w-4xl mx-auto">
  <div class="flex justify-between items-center mb-8">
    <h1 class="text-4xl font-bold">{$_('review.title')}</h1>
    <div class="badge badge-lg" 
      class:badge-success={entry.status === 'completed'}
      class:badge-warning={entry.status === 'processing' || entry.status === 'in_queue'}
      class:badge-info={entry.status === 'uploaded'}
      class:badge-error={entry.status === 'failed'}
      class:badge-neutral={entry.status === 'deleted'}
    >
      {$_(`videos.status.${entry.status}`) || entry.status}
    </div>
  </div>

  {#if (entry.status === 'processing' || entry.status === 'in_queue') && progressPercentage !== null}
    <div class="alert alert-info shadow-lg mb-6">
      <div class="flex flex-col w-full gap-2">
        <div class="flex justify-between items-center">
          <span class="font-semibold">{$_('review.processing')}</span>
          <span class="text-sm">{progressPercentage.toFixed(1)}%</span>
        </div>
        <progress class="progress progress-primary w-full" value={progressPercentage} max="100"></progress>
      </div>
    </div>
  {/if}

  {#if message}
    <div class="alert alert-info shadow-lg mb-6">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-6 h-6">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
      </svg>
      <span>{message}</span>
    </div>
  {/if}

  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
    <!-- Image Preview Card -->
    <div class="card bg-base-100 shadow-xl">
      <figure class="px-4 pt-4">
        {#if entry.last_image_url}
          <!-- FL2V Mode: Show both images -->
          <div class="grid grid-cols-2 gap-2 w-full">
            <div>
              <p class="text-xs text-center mb-2 font-semibold">{$_('review.firstFrame')}</p>
              <img src={entry.original_image_url} alt="first frame" class="rounded-lg max-h-64 object-contain w-full" />
            </div>
            <div>
              <p class="text-xs text-center mb-2 font-semibold">{$_('review.lastFrame')}</p>
              <img src={entry.last_image_url} alt="last frame" class="rounded-lg max-h-64 object-contain w-full" />
            </div>
          </div>
        {:else}
          <!-- I2V Mode: Show single image -->
          <img src={entry.original_image_url} alt="preview" class="rounded-lg max-h-96 object-contain" />
        {/if}
      </figure>
      <div class="card-body">
        <div>
          <h3 class="font-semibold mb-2">{$_('review.tags')}</h3>
          <div class="join w-full">
            <div use:melt={$root} class="join-item flex flex-wrap gap-2 p-3 border border-base-300 rounded-l-lg bg-base-100 min-h-[3rem] items-center flex-1">
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
                placeholder={$_('review.tagPlaceholder')}
                disabled={!isEditable}
              />
            </div>
            <button class="btn btn-primary join-item min-h-[3rem]" on:click={addNewTag} disabled={!isEditable}>{$_('review.addTag')}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Prompts Card -->
    <div class="card bg-base-100 shadow-xl">
      <div class="card-body">
        <h2 class="card-title">{$_('review.aiSuggestions')}</h2>
        <div class="divider my-2"></div>
        
        {#if entry.suggested_prompts && entry.suggested_prompts.length > 0}
          <div class="space-y-2">
            <h3 class="font-semibold text-sm">{$_('review.suggestedPrompts')}</h3>
            {#each entry.suggested_prompts as sp, i}
              <button class="alert alert-success py-2 cursor-pointer hover:shadow-md transition-shadow w-full text-left" on:click={() => prompt = sp} disabled={!isEditable}>
                <span class="text-sm">{i + 1}. {sp}</span>
              </button>
            {/each}
          </div>
        {:else}
          <div class="alert">
            <span class="text-sm">{$_('review.noSuggestions')}</span>
          </div>
        {/if}
      </div>
    </div>
  </div>

  <!-- Prompt Input & Generate -->
  <div class="card bg-base-100 shadow-xl">
    <div class="card-body">
      <h2 class="card-title">{$_('review.yourPrompt')}</h2>
      <p class="text-sm opacity-70 mb-2">{$_('review.promptHelp')}</p>
      <div class="form-control">
        <textarea
          id="prompt"
          bind:value={prompt}
          placeholder={$_('review.promptPlaceholder')}
          class="textarea textarea-bordered textarea-lg h-32 w-full"
          disabled={!isEditable}
        ></textarea>
      </div>

      <!-- Advanced Settings -->
      <div class="divider mt-6 mb-2"></div>
      <div class="collapse collapse-arrow bg-base-200">
        <input type="checkbox" bind:checked={showAdvancedSettings} />
        <div class="collapse-title text-lg font-medium">
          <span>{$_('review.advancedSettings')}</span>
        </div>
        <div class="collapse-content">
          {#if showAdvancedSettings}
            <div class="flex justify-end mb-4">
              <button 
                class="btn btn-ghost btn-sm"
                on:click={resetAdvancedSettings}
                disabled={!isEditable}
              >
                {$_('review.resetAll')}
              </button>
            </div>
          {/if}
          {#if !loadingWorkflows}
            <div class="space-y-4 mb-6">
              <div class="flex items-center justify-between">
                <h3 class="font-semibold">{$_('review.workflow.title')}</h3>
                <span class="text-xs opacity-70">{$_('review.workflow.help')}</span>
              </div>
              <select 
                class="select select-bordered w-full"
                bind:value={selectedWorkflowId}
                disabled={!isEditable}
              >
                {#each filteredWorkflows as workflow}
                  <option value={workflow.id}>{workflow.name}</option>
                {/each}
              </select>
              {#if filteredWorkflows.find(w => w.id === selectedWorkflowId)?.description}
                <p class="text-xs opacity-70">{filteredWorkflows.find(w => w.id === selectedWorkflowId)?.description}</p>
              {/if}
            </div>
            <div class="divider"></div>
          {/if}
          
          <div class="space-y-4 mb-6">
            <div class="flex items-center justify-between">
              <h3 class="font-semibold">{$_('review.iteration.title')}</h3>
              <span class="text-xs opacity-70">{$_('review.iteration.help')}</span>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {#each visibleStepOptions as option}
                <label class="btn btn-outline flex items-center gap-3 justify-start" class:btn-active={iterationSteps === option.value}>
                  <input
                    type="radio"
                    name="iteration-steps"
                    value={option.value}
                    checked={iterationSteps === option.value}
                    on:change={() => iterationSteps = option.value}
                    disabled={!isEditable}
                  />
                  <div>
                    <div class="font-semibold">{option.label}</div>
                    <div class="text-xs opacity-70">{option.description}</div>
                  </div>
                </label>
              {/each}
            </div>
          </div>
          
          <div class="divider"></div>
          
          <!-- Video Duration -->
          <div class="space-y-4 mb-6">
            <div class="flex items-center justify-between">
              <h3 class="font-semibold">{$_('review.duration.title')}</h3>
              <span class="text-xs opacity-70">{$_('review.duration.help')}</span>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label class="btn btn-outline flex items-center gap-3 justify-start" class:btn-active={videoDuration === 4}>
                <input
                  type="radio"
                  name="video-duration"
                  value={4}
                  checked={videoDuration === 4}
                  on:change={() => videoDuration = 4}
                  disabled={!isEditable}
                />
                <div>
                  <div class="font-semibold">{$_('review.duration.short')}</div>
                  <div class="text-xs opacity-70">{$_('review.duration.shortDesc')}</div>
                </div>
              </label>
              <label class="btn btn-outline flex items-center gap-3 justify-start" class:btn-active={videoDuration === 6}>
                <input
                  type="radio"
                  name="video-duration"
                  value={6}
                  checked={videoDuration === 6}
                  on:change={() => videoDuration = 6}
                  disabled={!isEditable}
                />
                <div>
                  <div class="font-semibold">{$_('review.duration.long')}</div>
                  <div class="text-xs opacity-70">{$_('review.duration.longDesc')}</div>
                </div>
              </label>
            </div>
          </div>
          
          <div class="divider"></div>
          
          <!-- Video Resolution -->
          <div class="space-y-4 mb-6">
            <div class="flex items-center justify-between">
              <h3 class="font-semibold">{$_('review.resolution.title')}</h3>
              <span class="text-xs opacity-70">{$_('review.resolution.help')}</span>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {#each visibleResolutionOptions as option}
                <label class="btn btn-outline flex items-center gap-3 justify-start" class:btn-active={videoResolution === option.value}>
                  <input
                    type="radio"
                    name="video-resolution"
                    value={option.value}
                    checked={videoResolution === option.value}
                    on:change={() => videoResolution = option.value}
                    disabled={!isEditable}
                  />
                  <div>
                    <div class="font-semibold">{option.label}</div>
                    <div class="text-xs opacity-70">{option.description}</div>
                  </div>
                </label>
              {/each}
            </div>
          </div>
          
          <div class="divider"></div>
          <div class="flex items-center justify-between mb-2">
            <h3 class="font-semibold">{$_('review.loraWeights')}</h3>
            <button class="btn btn-ghost btn-sm" on:click={resetLoraWeights} disabled={!isEditable}>{$_('review.reset')}</button>
          </div>
          <p class="text-sm opacity-70 mb-4">{$_('review.loraWeightsHelp')}</p>
          <div class="space-y-4">
            {#each filteredLoraPresets as lora}
              <div class="space-y-1">
                <div class="flex items-center justify-between text-sm">
                  <span>{lora.label}</span>
                  <span class="opacity-70">{(loraWeights[lora.id] ?? lora.default).toFixed(2)}</span>
                  {#if lora.isConfigurable !== false}
                    <label class="flex items-center gap-2 ml-2 cursor-pointer">
                      <input
                        type="checkbox"
                        class="toggle toggle-primary toggle-xs"
                        checked={loraEnabled[lora.id]}
                        on:change={() => toggleLoraEnabled(lora.id)}
                        disabled={!isEditable}
                      />
                      <span class="text-xs select-none">{$_('review.loraEnabled')}</span>
                    </label>
                  {:else}
                    <span class="badge badge-xs badge-ghost ml-2">{$_('review.loraRequired')}</span>
                  {/if}
                </div>
                <input
                  type="range"
                  min={lora.min ?? 0}
                  max={lora.max ?? 1.5}
                  step={lora.step ?? 0.05}
                  value={loraWeights[lora.id] ?? lora.default}
                  on:input={(event) => updateLoraWeight(lora.id, +event.currentTarget.value)}
                  disabled={!isEditable || lora.isConfigurable !== false && !loraEnabled[lora.id]}
                  class="range range-sm"
                />
              </div>
            {/each}
          </div>
          
          <div class="divider"></div>
          
          <!-- Additional Options -->
          <div class="space-y-3 mb-6">
            <h3 class="font-semibold flex items-center gap-2">
              {$_('review.additionalOptions.title')}
              <span class="badge badge-xs badge-warning">{$_('review.additionalOptions.experimental')}</span>
            </h3>
            
            <!-- Motion Scale -->
            <div class="space-y-2">
              <div class="flex items-center justify-between">
                <span class="text-sm">{$_('review.additionalOptions.motionScale.title')}</span>
                <label class="flex items-center gap-2 cursor-pointer">
                  <span class="text-xs opacity-70">{$_('review.additionalOptions.motionScale.enable')}</span>
                  <input
                    type="checkbox"
                    class="toggle toggle-primary toggle-xs"
                    checked={motionScale !== undefined}
                    on:change={() => motionScale = motionScale === undefined ? 1.0 : undefined}
                    disabled={!isEditable}
                  />
                </label>
              </div>
              {#if motionScale !== undefined}
                <div class="pl-4 border-l-2 border-base-300">
                  <div class="flex items-center gap-2 text-xs mb-1">
                    <span class="opacity-60">{$_('review.additionalOptions.motionScale.intensity')}</span>
                    <span class="font-mono opacity-70">{motionScale.toFixed(1)}</span>
                  </div>
                  <input
                    type="range"
                    min={0.5}
                    max={2.0}
                    step={0.1}
                    value={motionScale}
                    on:input={(event) => motionScale = +event.currentTarget.value}
                    disabled={!isEditable}
                    class="range range-xs range-primary"
                  />
                  <div class="text-xs opacity-60 mt-1">
                    {$_('review.additionalOptions.motionScale.slow')} (0.5) ← {$_('review.additionalOptions.motionScale.normal')} (1.0) → {$_('review.additionalOptions.motionScale.fast')} (2.0)
                  </div>
                </div>
              {/if}
            </div>
            
            <!-- FreeLong -->
            <div class="space-y-2">
              <div class="flex items-center justify-between">
                <span class="text-sm">{$_('review.additionalOptions.freeLong.title')}</span>
                <label class="flex items-center gap-2 cursor-pointer">
                  <span class="text-xs opacity-70">{$_('review.additionalOptions.freeLong.enable')}</span>
                  <input
                    type="checkbox"
                    class="toggle toggle-primary toggle-xs"
                    checked={freeLongBlendStrength !== undefined}
                    on:change={() => freeLongBlendStrength = freeLongBlendStrength === undefined ? 0.8 : undefined}
                    disabled={!isEditable}
                  />
                </label>
              </div>
              {#if freeLongBlendStrength !== undefined}
                <div class="pl-4 border-l-2 border-base-300">
                  <div class="flex items-center gap-2 text-xs mb-1">
                    <span class="opacity-60">{$_('review.additionalOptions.freeLong.blendStrength')}</span>
                    <span class="font-mono opacity-70">{freeLongBlendStrength.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={freeLongBlendStrength}
                    on:input={(event) => freeLongBlendStrength = +event.currentTarget.value}
                    disabled={!isEditable}
                    class="range range-xs range-primary"
                  />
                  <div class="text-xs opacity-60 mt-1">
                    {$_('review.additionalOptions.freeLong.detail')} (0) ← {$_('review.additionalOptions.freeLong.balanced')} (0.8) → {$_('review.additionalOptions.freeLong.smooth')} (1.0)
                  </div>
                </div>
              {/if}
            </div>
          </div>
        </div>
      </div>
      
      <div class="card-actions justify-between mt-4">
        <button 
          class="btn btn-error btn-outline" 
          on:click={deleteVideo}
          disabled={entry.status === "processing" || entry.status === "in_queue"}
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          {$_('common.delete')}
        </button>
        <div class="flex gap-2 flex-col sm:flex-row sm:items-center">
          {#if !quotaLoading && quotaRemaining !== null}
            <div class="badge badge-lg" class:badge-error={quotaRemaining === 0} class:badge-warning={quotaRemaining < 3} class:badge-success={quotaRemaining > 0}>
              {$_('review.quotaRemaining', { values: { count: quotaRemaining } })}
            </div>
          {/if}
          {#if entry.status === "failed"}
            <button 
              class="btn btn-warning btn-lg" 
              on:click={retryGeneration}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {$_('review.retryGeneration')}
            </button>
          {:else if entry.status === "deleted"}
            <div class="alert alert-info">
              <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>{$_('review.videoDeleted')}</span>
            </div>
          {:else}
            {#if !entry.tags || entry.tags.length === 0}
              <div class="alert alert-warning mb-4">
                <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div>
                  <h3 class="font-bold">{$_('review.warnings.noTags.title')}</h3>
                  <div class="text-sm">{$_('review.warnings.noTags.message')}</div>
                </div>
              </div>
            {/if}
            {#if entry.is_nsfw && entry.is_photo_realistic}
              <div class="alert alert-error mb-4">
                <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>
                  <h3 class="font-bold">{$_('review.warnings.nsfwRealistic.title')}</h3>
                  <div class="text-sm">{$_('review.warnings.nsfwRealistic.message')}</div>
                </div>
              </div>
            {/if}
            <button 
              class="btn btn-primary btn-lg" 
              on:click={generate} 
              disabled={busy || entry.status === "processing" || entry.status === "in_queue"}
            >
              {#if busy}
                <span class="loading loading-spinner"></span>
                {$_('review.submitting')}
              {:else if entry.status === "processing" || entry.status === "in_queue"}
                <span class="loading loading-spinner"></span>
                {entry.status === "in_queue" ? $_('review.queued') : $_('review.processing')}
              {:else}
                <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {$_('review.generateVideo')}
              {/if}
            </button>
          {/if}
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Busy Server Modal -->
{#if showBusyModal}
  <div class="modal modal-open">
    <div class="modal-box max-w-2xl">
      {#if limitType === 'user'}
        <h3 class="font-bold text-2xl mb-4">{$_('review.quotaLimit.title')}</h3>
        <div class="flex justify-center mb-4">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-32 w-32 text-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <p class="text-lg mb-4">
          {busyModalMessage}
        </p>
        <p class="text-base mb-6 opacity-80">
          {$_('review.quotaLimit.message')}
        </p>
        <div class="modal-action">
          <button class="btn btn-ghost" on:click={() => showBusyModal = false}>{$_('common.cancel')}</button>
          <a href={sponsorUrl} target="_blank" rel="noopener noreferrer" class="btn btn-primary">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {$_('review.quotaLimit.sponsorButton')}
          </a>
        </div>
      {:else}
        <h3 class="font-bold text-2xl mb-4">{$_('review.serverBusy.title')}</h3>
        <div class="flex justify-center mb-4">
          <img src="/images/BUSY.jpg" alt="Server Busy" class="rounded-lg max-w-full max-h-96 object-contain" />
        </div>
        <p class="text-lg mb-4">
          {busyModalMessage}
        </p>
        <div class="modal-action">
          <button class="btn btn-primary" on:click={() => showBusyModal = false}>{$_('review.serverBusy.okButton')}</button>
        </div>
      {/if}
    </div>
  </div>
{/if}
