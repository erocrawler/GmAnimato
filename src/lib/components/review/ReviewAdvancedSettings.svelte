<script lang="ts">
  // Advanced Settings panel for the review page: workflow selector, iteration
  // steps, video duration, resolution, LoRA weights, motion scale, freeLong.
  // All option derivation (step/resolution/duration lists) lives here; the
  // parent binds the underlying values.
  import { _ } from "svelte-i18n";
  import type { Workflow } from "$lib/IDatabase";
  import type { LoraPreset } from "$lib/loraPresets";
  import { maxAllowedDurationSeconds } from "$lib/mediaLimits";
  import { getWorkflowEngine, getWorkflowCapabilities } from "$lib/workflows";
  import {
    ENGINE_DEFAULT_CAPABILITIES,
    ENGINE_DEFAULT_STEP,
    FREE_DURATION_MAX,
    STEP_LABEL_KEY,
    MINIMAX_STEP_DESC_KEY,
    DURATION_LABEL_KEY,
    type CapabilityStep,
  } from "$lib/workflowCapabilities";

  export let isEditable: boolean = true;
  export let loadingWorkflows: boolean = false;
  export let filteredWorkflows: Workflow[] = [];
  export let selectedWorkflowId: string = "";
  // The resolved workflow (null before the workflows load). Its engine +
  // capability allowlists drive every option list below — no more hardcoded
  // "is this MiniMax?" ternaries.
  export let selectedWorkflow: Workflow | null = null;
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

  // Engine + effective capability allowlists, derived from the DB workflow
  // (falling back to the WAN defaults before the workflows have loaded).
  $: engine = selectedWorkflow ? getWorkflowEngine(selectedWorkflow) : "wan";
  $: isMiniMax = engine === "minimax";
  $: caps = selectedWorkflow
    ? getWorkflowCapabilities(selectedWorkflow)
    : ENGINE_DEFAULT_CAPABILITIES.wan;

  type IterationSteps = 4 | 6 | 8;
  type VideoDuration = 4 | 6 | 10 | 15;
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

  // Iteration steps — built from the workflow's capability allowlist. WAN uses
  // 4/6 (analogous quality tiers); MiniMax H3 with the distilled lightx2v turbo
  // LoRA uses 4/8 (NFE: 4 fast/free, 8 quality/premium). Steps above the free
  // max (4) are premium — a central business rule, applied to whatever the
  // workflow allows.
  $: stepOptions = caps.steps.map((value: CapabilityStep) => {
    const labelKey = STEP_LABEL_KEY[value] ?? String(value);
    const descKey =
      isMiniMax && MINIMAX_STEP_DESC_KEY[value]
        ? MINIMAX_STEP_DESC_KEY[value]
        : `steps.${labelKey}`;
    return {
      value: value as IterationSteps,
      label: $_(`review.iteration.${labelKey}`),
      description: $_(`review.iteration.${descKey}`),
      // Premium threshold is the workflow's own freeSteps (default 4). A turbo
      // workflow that raises freeSteps to 8 makes its 8-step mode free.
      requiresPaid: value > caps.freeSteps,
    };
  });
  // Default per engine (WAN 4, MiniMax 8) when the workflow allows it; otherwise
  // the cheapest allowed step so a radio is always available.
  $: defaultIterationSteps =
    caps.steps.includes(ENGINE_DEFAULT_STEP[engine])
      ? ENGINE_DEFAULT_STEP[engine]
      : (caps.steps[0] ?? 4);

  $: resolutionOptions = caps.resolutions.map((value) => ({
    value,
    label: $_(`review.resolution.${value === "480p" ? "standard" : "hd"}`),
    description: $_(`review.resolution.${value === "480p" ? "standardDesc" : "hdDesc"}`),
    requiresPaid: value !== "480p",
  }));

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
    const frames = isMiniMax
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

  // Duration options — built from the workflow's capability allowlist in
  // ascending order. Values ≤ FREE_DURATION_MAX (6s) are free; 10s is advanced
  // (WAN: relay mode only; MiniMax: standard mode); 15s is MiniMax H3
  // premium-only. For ref2v with a known reference length, a "Follow video
  // duration" radio is prepended (value FOLLOW_DURATION). Free tier caps output
  // at 6s, so the follow option reflects the capped value.
  $: followMaxSec = maxAllowedDurationSeconds(canUseQuality);
  $: followDurationSec = Math.min(followMaxSec, refVideoDurationSec);
  $: followDurationCapped = refVideoDurationSec > followMaxSec;
  $: durationOptions = ((): DurationOption[] => {
    const opts: DurationOption[] = [];
    if (videoWorkflowType === "ref2v" && refVideoDurationSec > 0) {
      opts.push({
        value: FOLLOW_DURATION,
        label: $_("review.ref2v.followDuration.shortTitle", {
          values: { s: followDurationSec.toFixed(1) },
        }),
        description: followDurationCapped
          ? $_("review.ref2v.followDuration.helpCapped", {
              values: { s: followMaxSec },
            })
          : $_("review.ref2v.followDuration.helpKnown", {
              values: { s: followDurationSec.toFixed(1) },
            }),
        requiresPaid: false,
      });
    }
    const sorted = [...caps.durations].sort((a, b) => a - b);
    for (const value of sorted) {
      const label = $_(`review.duration.${DURATION_LABEL_KEY[value] ?? value}`);
      if (value <= FREE_DURATION_MAX) {
        opts.push({
          value: value as VideoDuration,
          label,
          description: isMiniMax
            ? durationDescription(value)
            : $_(`review.duration.${DURATION_LABEL_KEY[value] ?? value}Desc`),
          requiresPaid: false,
        });
      } else if (value === 10) {
        // 10s is advanced; WAN only offers it in relay mode, MiniMax in standard.
        if (!canUseQuality || (!isMiniMax && !promptRelayMode)) continue;
        opts.push({
          value: 10 as VideoDuration,
          label,
          description: isMiniMax
            ? durationDescription(10)
            : $_("review.duration.extendedDesc"),
          requiresPaid: true,
        });
      } else if (value === 15) {
        // 15s is a MiniMax H3 premium-only option.
        if (!canUseQuality || !isMiniMax) continue;
        opts.push({
          value: 15 as VideoDuration,
          label,
          description: durationDescription(15),
          requiresPaid: true,
        });
      }
    }
    return opts;
  })();

  // Effective selected value for display: FOLLOW_DURATION when follow is on
  // (and there's a video to follow — the pref can be remembered from an earlier
  // job that had a ref video, but the current entry may have none).
  $: selectedDurationValue =
    ref2vFollowDuration && refVideoDurationSec > 0
      ? FOLLOW_DURATION
      : videoDuration;
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

  // If the selected step isn't available for the current model/tier, snap to
  // default. IMPORTANT: guard on `selectedWorkflowId` — same init-window race
  // as duration. At first render the workflow isn't resolved, so caps/engine
  // are the WAN ones; a MiniMax 8-step entry would be wrongly snapped to 4,
  // then re-snapped to the WAN-default 4→8 after resolution.
  $: if (
    selectedWorkflowId &&
    !stepOptions.some((o) => o.value === iterationSteps)
  )
    iterationSteps = defaultIterationSteps as IterationSteps;
  // Free tier: snap to the best step the workflow gives free users (the largest
  // allowed step ≤ the workflow's freeSteps). A workflow with no free step (e.g.
  // steps:[8] with the default freeSteps 4) is premium-only — leave the value so
  // the kickoff gate produces a clear "advanced features" error.
  $: if (!canUseQuality) {
    const bestFree = caps.steps
      .filter((s) => s <= caps.freeSteps)
      .sort((a, b) => b - a)[0];
    if (bestFree !== undefined && iterationSteps > bestFree) {
      iterationSteps = bestFree;
    }
  }

  $: if (!canUseQuality && videoResolution === "720p") videoResolution = "480p";

  // Free tier: durations above 6s are advanced features — snap down to 6s when
  // the workflow allows it so a radio is always checked. Premium-only durations
  // (workflow that excludes ≤6s) are left for kickoff to gate.
  $: if (
    !canUseQuality &&
    videoDuration > FREE_DURATION_MAX &&
    caps.durations.includes(FREE_DURATION_MAX)
  )
    videoDuration = FREE_DURATION_MAX;

  // Follow-duration is meaningless without a ref video (the pref is remembered
  // globally and may outlive the entry that set it). Snap it off so it never
  // leaves the duration radios in an empty state or sends a stale
  // ref2v_follow_duration flag to kickoff.
  $: if (ref2vFollowDuration && refVideoDurationSec <= 0) ref2vFollowDuration = false;

  // Keep the current value a real option: after the workflow resolves (or the
  // tier/relay gating drops a previously-valid option, e.g. WAN 10s outside
  // relay mode), snap to the nearest still-allowed numeric preset. Guarded on
  // selectedWorkflowId for the same init-window race as above.
  $: if (
    selectedWorkflowId &&
    !ref2vFollowDuration &&
    videoDuration > 0 &&
    !durationOptions.some((o) => o.value === videoDuration)
  ) {
    const numeric = durationOptions.filter(
      (o) => o.value !== FOLLOW_DURATION,
    ) as { value: number; requiresPaid: boolean }[];
    if (numeric.length > 0) {
      const nearest = numeric.reduce((best, o) =>
        Math.abs(o.value - videoDuration) < Math.abs(best.value - videoDuration) ? o : best,
      );
      videoDuration = nearest.value as VideoDuration;
    }
  }
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
    {#if !isMiniMax}
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
