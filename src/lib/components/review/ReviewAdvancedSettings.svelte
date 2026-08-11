<script lang="ts">
  // Advanced Settings panel for the review page: workflow selector, iteration
  // steps, video duration, resolution, LoRA weights, motion scale, freeLong.
  // All option derivation (step/resolution/duration lists) lives here; the
  // parent binds the underlying values.
  import { _ } from "svelte-i18n";
  import type { Workflow } from "$lib/IDatabase";
  import type { LoraPreset } from "$lib/loraPresets";

  export let isEditable: boolean = true;
  export let loadingWorkflows: boolean = false;
  export let filteredWorkflows: Workflow[] = [];
  export let selectedWorkflowId: string = "";
  export let isMiniMaxSelected: boolean = false;
  export let promptRelayMode: boolean = false;
  export let canUseQuality: boolean = false;
  export let showAdvancedSettings: boolean = false;
  export let videoWorkflowType: string = "";
  export let iterationSteps: number = 4;
  export let videoDuration: number = 4;
  export let videoResolution: string = "480p";
  export let ref2vAspect: "video" | "16:9" | "4:3" | "square" | "3:4" | "9:16" = "video";
  export let ref2vFollowDuration: boolean = false;
  export let refVideoDurationSec: number = 0;
  export let motionScale: number | undefined = undefined;
  export let freeLongBlendStrength: number | undefined = undefined;
  export let filteredLoraPresets: LoraPreset[] = [];
  export let loraEnabled: Record<string, boolean> = {};
  export let loraWeights: Record<string, number> = {};
  export let updateLoraWeight: (id: string, value: number) => void = () => {};
  export let toggleLoraEnabled: (id: string) => void = () => {};
  export let resetLoraWeights: () => void = () => {};
  export let resetAdvancedSettings: () => void = () => {};

  type IterationSteps = 4 | 6 | 10 | 12 | 15;
  type VideoDuration = 4 | 6 | 8 | 10;
  type VideoResolution = "480p" | "720p";

  let stepOptions: {
    value: IterationSteps;
    label: string;
    description: string;
    requiresPaid?: boolean;
  }[] = [];
  let resolutionOptions: {
    value: VideoResolution;
    label: string;
    description: string;
    requiresPaid?: boolean;
  }[] = [
    { value: "480p", label: "", description: "", requiresPaid: false },
    { value: "720p", label: "", description: "", requiresPaid: true },
  ];

  // Iteration steps — WAN uses 4/6 (analogous quality tiers), MiniMax uses 10/12/15
  // (10 fast/free to limit GPU time, 12 balanced/premium = quality baseline with
  // reasonable audio, 15 quality/premium = top tier for a visible difference).
  // Default per model: WAN 4, MiniMax 10.
  $: stepOptions = isMiniMaxSelected
    ? [
        {
          value: 10 as IterationSteps,
          label: $_("review.iteration.fast"),
          description: $_("review.iteration.minimaxStepsFast"),
          requiresPaid: false,
        },
        {
          value: 12 as IterationSteps,
          label: $_("review.iteration.balanced"),
          description: $_("review.iteration.minimaxStepsBalanced"),
          requiresPaid: true,
        },
        {
          value: 15 as IterationSteps,
          label: $_("review.iteration.quality"),
          description: $_("review.iteration.minimaxStepsQuality"),
          requiresPaid: true,
        },
      ]
    : [
        {
          value: 4 as IterationSteps,
          label: $_("review.iteration.fast"),
          description: $_("review.iteration.steps.fast"),
          requiresPaid: false,
        },
        {
          value: 6 as IterationSteps,
          label: $_("review.iteration.balanced"),
          description: $_("review.iteration.steps.balanced"),
          requiresPaid: true,
        },
      ];
  $: defaultIterationSteps = isMiniMaxSelected ? 10 : 4;

  $: resolutionOptions = [
    {
      value: "480p",
      label: $_("review.resolution.standard"),
      description: $_("review.resolution.standardDesc"),
      requiresPaid: false,
    },
    {
      value: "720p",
      label: $_("review.resolution.hd"),
      description: $_("review.resolution.hdDesc"),
      requiresPaid: true,
    },
  ];

  $: visibleStepOptions = canUseQuality
    ? stepOptions
    : stepOptions.filter((o) => !o.requiresPaid);
  $: visibleResolutionOptions = canUseQuality
    ? resolutionOptions
    : resolutionOptions.filter((o) => !o.requiresPaid);

  // Frame counts: WAN uses fixed 4n+1 counts; MiniMax H3 derives frames on the
  // worker via ComfyMathExpression at 24fps:
  //   max(5, round(s*24)) + (5 - (max(5, round(s*24)) % 17)) % 17  (Python modulo)
  function wanFrameCount(duration: number): number {
    return duration === 4 ? 81 : duration === 6 ? 121 : 177;
  }
  function minimaxFrameCount(duration: number): number {
    const base = Math.max(5, Math.round(duration * 24));
    const pyMod = ((5 - (base % 17)) % 17 + 17) % 17; // Python-style modulo
    return base + pyMod;
  }
  function durationDescription(duration: number): string {
    const frames = isMiniMaxSelected
      ? minimaxFrameCount(duration)
      : wanFrameCount(duration);
    return $_("review.duration.framesCount", { values: { n: frames } });
  }

  // Sentinel value for the "follow reference video duration" option. Must not
  // collide with the numeric presets (4/6/8/10).
  const FOLLOW_DURATION = 0 as const;

  type DurationOption = {
    value: VideoDuration | typeof FOLLOW_DURATION;
    label: string;
    description: string;
    requiresPaid: boolean;
  };

  // Duration options — 10s for advanced users (WAN: relay mode only; MiniMax: standard mode)
  // 8s is a MiniMax H3 premium-only option. For ref2v with a known reference
  // length, a "Follow video duration" radio is prepended (value FOLLOW_DURATION).
  $: durationOptions = ((): DurationOption[] => [
    ...(videoWorkflowType === "ref2v" && refVideoDurationSec > 0
      ? [
          {
            value: FOLLOW_DURATION,
            label: $_("review.ref2v.followDuration.shortTitle"),
            description: $_("review.ref2v.followDuration.helpKnown", {
              values: { s: refVideoDurationSec.toFixed(1) },
            }),
            requiresPaid: false,
          },
        ]
      : []),
    {
      value: 4 as VideoDuration,
      label: $_("review.duration.short"),
      description: isMiniMaxSelected
        ? durationDescription(4)
        : $_("review.duration.shortDesc"),
      requiresPaid: false,
    },
    {
      value: 6 as VideoDuration,
      label: $_("review.duration.long"),
      description: isMiniMaxSelected
        ? durationDescription(6)
        : $_("review.duration.longDesc"),
      requiresPaid: false,
    },
    ...(canUseQuality && isMiniMaxSelected
      ? [
          {
            value: 8 as VideoDuration,
            label: $_("review.duration.medium"),
            description: durationDescription(8),
            requiresPaid: true,
          },
        ]
      : []),
    ...(canUseQuality && (promptRelayMode || isMiniMaxSelected)
      ? [
          {
            value: 10 as VideoDuration,
            label: $_("review.duration.extended"),
            description: isMiniMaxSelected
              ? durationDescription(10)
              : $_("review.duration.extendedDesc"),
            requiresPaid: true,
          },
        ]
      : []),
  ])();

  // Effective selected value for display: FOLLOW_DURATION when follow is on.
  $: selectedDurationValue = ref2vFollowDuration ? FOLLOW_DURATION : videoDuration;
  $: currentDurationOption = durationOptions.find(
    (o) => o.value === selectedDurationValue,
  );

  function setVideoDuration(value: number) {
    if (value === FOLLOW_DURATION) {
      ref2vFollowDuration = true;
      return;
    }
    ref2vFollowDuration = false;
    videoDuration = value as VideoDuration;
  }

  // If the selected step isn't available for the current model/tier, snap to default
  $: if (!stepOptions.some((o) => o.value === iterationSteps)) iterationSteps = defaultIterationSteps as IterationSteps;
  $: if (!canUseQuality && iterationSteps === (isMiniMaxSelected ? 12 : 6)) iterationSteps = isMiniMaxSelected ? 10 : 4;
  $: if (!canUseQuality && isMiniMaxSelected && iterationSteps === 15) iterationSteps = 10;

  $: if (!canUseQuality && videoResolution === "720p") videoResolution = "480p";

  $: if (
    !isMiniMaxSelected &&
    (videoDuration === 8 || (videoDuration === 10 && !promptRelayMode))
  )
    videoDuration = 6;
</script>

<div class="collapse collapse-arrow bg-base-200">
  <input type="checkbox" bind:checked={showAdvancedSettings} />
  <div class="collapse-title text-lg font-medium">
    <span>{$_("review.advancedSettings")}</span>
  </div>
  <div class="collapse-content">
    {#if showAdvancedSettings}
      <div class="flex justify-end mb-4">
        <button
          class="btn btn-ghost btn-sm"
          on:click={resetAdvancedSettings}
          disabled={!isEditable}
        >
          {$_("review.resetAll")}
        </button>
      </div>
    {/if}
    {#if !loadingWorkflows}
      <div class="space-y-4 mb-6">
        <div class="flex items-center justify-between">
          <h3 class="font-semibold">{$_("review.workflow.title")}</h3>
          <span class="text-xs opacity-70"
            >{$_("review.workflow.help")}</span
          >
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
        {#if filteredWorkflows.find((w) => w.id === selectedWorkflowId)?.description}
          <p class="text-xs opacity-70">
            {filteredWorkflows.find((w) => w.id === selectedWorkflowId)
              ?.description}
          </p>
        {/if}
      </div>
      <div class="divider"></div>
    {/if}

    <div class="space-y-4 mb-6">
      <div class="flex items-center justify-between">
        <h3 class="font-semibold">{$_("review.iteration.title")}</h3>
        <span class="text-xs opacity-70"
          >{$_("review.iteration.help")}</span
        >
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {#each visibleStepOptions as option}
            <label
              class="btn btn-outline flex items-center gap-3 justify-start"
              class:btn-active={iterationSteps === option.value}
            >
              <input
                type="radio"
                name="iteration-steps"
                value={option.value}
                checked={iterationSteps === option.value}
                on:change={() => (iterationSteps = option.value)}
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

    {#if !promptRelayMode}
      <!-- Video Duration -->
      <div class="space-y-4 mb-6">
        <div class="flex items-center justify-between">
          <h3 class="font-semibold">{$_("review.duration.title")}</h3>
          <span class="text-xs opacity-70"
            >{$_("review.duration.help")}</span
          >
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {#each durationOptions as option}
            <label
              class="btn btn-outline flex items-center gap-3 justify-start"
              class:btn-active={selectedDurationValue === option.value}
            >
              <input
                type="radio"
                name="video-duration"
                value={option.value}
                checked={selectedDurationValue === option.value}
                on:change={() => setVideoDuration(option.value as number)}
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
    {/if}

    <!-- Ref2V Aspect Ratio -->
    {#if videoWorkflowType === "ref2v"}
      <div class="space-y-4 mb-6">
        <div class="flex items-center justify-between">
          <h3 class="font-semibold">{$_("review.ref2v.aspect.title")}</h3>
          <span class="text-xs opacity-70"
            >{$_("review.ref2v.aspect.help")}</span
          >
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {#each (["video", "16:9", "4:3", "square", "3:4", "9:16"] as const) as value}
            <label
              class="btn btn-outline btn-sm justify-start gap-2"
              class:btn-active={ref2vAspect === value}
            >
              <input
                type="radio"
                name="ref2v-aspect"
                value={value}
                checked={ref2vAspect === value}
                on:change={() => (ref2vAspect = value)}
                disabled={!isEditable}
              />
              <span>{$_(`review.ref2v.aspect.${value}`)}</span>
            </label>
          {/each}
        </div>
      </div>

      <div class="divider"></div>
    {/if}

    <!-- Video Resolution -->
    <div class="space-y-4 mb-6">
      <div class="flex items-center justify-between">
        <h3 class="font-semibold">{$_("review.resolution.title")}</h3>
        <span class="text-xs opacity-70"
          >{$_("review.resolution.help")}</span
        >
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {#each visibleResolutionOptions as option}
          <label
            class="btn btn-outline flex items-center gap-3 justify-start"
            class:btn-active={videoResolution === option.value}
          >
            <input
              type="radio"
              name="video-resolution"
              value={option.value}
              checked={videoResolution === option.value}
              on:change={() => (videoResolution = option.value)}
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
      <h3 class="font-semibold">{$_("review.loraWeights")}</h3>
      <button
        class="btn btn-ghost btn-sm"
        on:click={resetLoraWeights}
        disabled={!isEditable}>{$_("review.reset")}</button
      >
    </div>
    <p class="text-sm opacity-70 mb-4">{$_("review.loraWeightsHelp")}</p>
    <div class="space-y-4">
      {#each filteredLoraPresets as lora}
          <div class="space-y-1">
            <div class="flex items-center justify-between text-sm">
              <span>{lora.label}</span>
              <span class="opacity-70"
                >{(loraWeights[lora.id] ?? lora.default).toFixed(2)}</span
              >
              {#if lora.isConfigurable !== false}
                <label class="flex items-center gap-2 ml-2 cursor-pointer">
                  <input
                    type="checkbox"
                    class="toggle toggle-primary toggle-xs"
                    checked={loraEnabled[lora.id]}
                    on:change={() => toggleLoraEnabled(lora.id)}
                    disabled={!isEditable}
                  />
                  <span class="text-xs select-none"
                    >{$_("review.loraEnabled")}</span
                  >
                </label>
              {:else}
                <span class="badge badge-xs badge-ghost ml-2"
                  >{$_("review.loraRequired")}</span
                >
              {/if}
            </div>
            <input
              type="range"
              min={lora.min ?? 0}
              max={lora.max ?? 1.5}
              step={lora.step ?? 0.05}
              value={loraWeights[lora.id] ?? lora.default}
              on:input={(event) =>
                updateLoraWeight(lora.id, +event.currentTarget.value)}
              disabled={!isEditable ||
                (lora.isConfigurable !== false && !loraEnabled[lora.id])}
              class="range range-sm"
            />
          </div>
        {/each}
      </div>

    <div class="divider"></div>

    <!-- Additional Options -->
    {#if !isMiniMaxSelected}
      <div class="space-y-3 mb-6">
        <h3 class="font-semibold flex items-center gap-2">
          {$_("review.additionalOptions.title")}
          <span class="badge badge-xs badge-warning"
            >{$_("review.additionalOptions.experimental")}</span
          >
        </h3>

        <!-- Motion Scale -->
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-sm"
              >{$_("review.additionalOptions.motionScale.title")}</span
            >
            <label class="flex items-center gap-2 cursor-pointer">
              <span class="text-xs opacity-70"
                >{$_("review.additionalOptions.motionScale.enable")}</span
              >
              <input
                type="checkbox"
                class="toggle toggle-primary toggle-xs"
                checked={motionScale !== undefined}
                on:change={() =>
                  (motionScale =
                    motionScale === undefined ? 1.0 : undefined)}
                disabled={!isEditable}
              />
            </label>
          </div>
          {#if motionScale !== undefined}
            <div class="pl-4 border-l-2 border-base-300">
              <div class="flex items-center gap-2 text-xs mb-1">
                <span class="opacity-60"
                  >{$_(
                    "review.additionalOptions.motionScale.intensity",
                  )}</span
                >
                <span class="font-mono opacity-70"
                  >{motionScale.toFixed(1)}</span
                >
              </div>
              <input
                type="range"
                min={0.5}
                max={2.0}
                step={0.1}
                value={motionScale}
                on:input={(event) =>
                  (motionScale = +event.currentTarget.value)}
                disabled={!isEditable}
                class="range range-xs range-primary"
              />
              <div class="text-xs opacity-60 mt-1">
                {$_("review.additionalOptions.motionScale.slow")} (0.5) ←
                {$_("review.additionalOptions.motionScale.normal")} (1.0)
                → {$_("review.additionalOptions.motionScale.fast")} (2.0)
              </div>
            </div>
          {/if}
        </div>

        <!-- FreeLong -->
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-sm"
              >{$_("review.additionalOptions.freeLong.title")}</span
            >
            <label class="flex items-center gap-2 cursor-pointer">
              <span class="text-xs opacity-70"
                >{$_("review.additionalOptions.freeLong.enable")}</span
              >
              <input
                type="checkbox"
                class="toggle toggle-primary toggle-xs"
                checked={freeLongBlendStrength !== undefined}
                on:change={() =>
                  (freeLongBlendStrength =
                    freeLongBlendStrength === undefined ? 0.8 : undefined)}
                disabled={!isEditable}
              />
            </label>
          </div>
          {#if freeLongBlendStrength !== undefined}
            <div class="pl-4 border-l-2 border-base-300">
              <div class="flex items-center gap-2 text-xs mb-1">
                <span class="opacity-60"
                  >{$_(
                    "review.additionalOptions.freeLong.blendStrength",
                  )}</span
                >
                <span class="font-mono opacity-70"
                  >{freeLongBlendStrength.toFixed(2)}</span
                >
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={freeLongBlendStrength}
                on:input={(event) =>
                  (freeLongBlendStrength = +event.currentTarget.value)}
                disabled={!isEditable}
                class="range range-xs range-primary"
              />
              <div class="text-xs opacity-60 mt-1">
                {$_("review.additionalOptions.freeLong.detail")} (0) ←
                {$_("review.additionalOptions.freeLong.balanced")} (0.8)
                → {$_("review.additionalOptions.freeLong.smooth")} (1.0)
              </div>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>
