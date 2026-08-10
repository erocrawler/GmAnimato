<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { goto } from "$app/navigation";
  import { _, locale } from "svelte-i18n";
  import { get } from "svelte/store";
  import { createTagsInput } from "@melt-ui/svelte";
  import { DEFAULT_LORA_PRESETS } from "$lib/loraPresets";
  import type { LoraPreset } from "$lib/loraPresets";
  import type { Workflow } from "$lib/IDatabase";
  import { isMiniMaxWorkflow } from "$lib/workflows";
  import { computeWorkflowQuotaCost } from "$lib/quotaCost";
  import ReviewImageCard from "$lib/components/review/ReviewImageCard.svelte";
  import ReviewSuggestionsCard from "$lib/components/review/ReviewSuggestionsCard.svelte";
  import ReviewPromptEditor from "$lib/components/review/ReviewPromptEditor.svelte";
  import ReviewRelayTimeline from "$lib/components/review/ReviewRelayTimeline.svelte";
  import ReviewAdvancedSettings from "$lib/components/review/ReviewAdvancedSettings.svelte";
  import ReviewActionBar from "$lib/components/review/ReviewActionBar.svelte";
  import ReviewBusyModal from "$lib/components/review/ReviewBusyModal.svelte";
  import ReviewEnhanceModal from "$lib/components/review/ReviewEnhanceModal.svelte";

  export let data: any;
  let entry = data.entry as any;
  let sponsorUrl = data.sponsorUrl || "";
  let prompt = entry.prompt || "";

  // Ref2V references: available refs (video first, then images), tokens present
  // in the prompt, and refs not yet referenced (shown in the "+" picker).
  $: refItems = (() => {
    const ao = entry.additional_options || {};
    const items: { kind: "video" | "image"; token: string; url: string; label: string }[] = [];
    if (ao.ref_video_url) {
      items.push({ kind: "video", token: "<Video 1>", url: ao.ref_video_url, label: "Video 1" });
    }
    (ao.ref_image_urls || []).forEach((u: string, i: number) => {
      items.push({ kind: "image", token: `<Picture ${i + 1}>`, url: u, label: `Picture ${i + 1}` });
    });
    return items;
  })();
  $: referencedTokens = [...prompt.matchAll(/<(Picture|Video)\s*\d+>/g)].map((m) => m[0]);
  $: availableRefs = refItems.filter((r) => !referencedTokens.includes(r.token));

  let busy = false;
  let message = "";
  let newtag = "";
  let showBusyModal = false;
  let busyModalMessage = "";
  let limitType: "user" | "system" | null = null;
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let progressPercentage: number | null = null;
  let quotaRemaining: number | null = null;
  let quotaLimit: number | null = null;
  let quotaLoading = true;
  let analyzing = false;
  let showAdvancedSettings = false;

  // MiniMax H3 prompt enhancer — rewrites a simple prompt into the structured
  // format the generation nodes expect, using the CUSTOM_VL endpoint. Runs
  // UI-side only; never part of the job workflow.
  let enhanceState: "idle" | "loading" | "done" | "error" = "idle";
  let enhanceError = "";
  let enhanceResult = "";

  async function enhancePrompt() {
    if (enhanceState === "loading" || !isEditable || !prompt.trim()) return;
    enhanceState = "loading";
    enhanceError = "";
    enhanceResult = "";
    try {
      const res = await fetch(`/api/video/${entry.id}/enhance-prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          workflowType: videoWorkflowType,
          videoDuration,
          locale: get(locale) === "zh" ? "zh" : "en",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success && data.enhancedPrompt) {
        enhanceResult = data.enhancedPrompt;
        enhanceState = "done";
      } else if (data.errorCode === "enhance_unavailable") {
        enhanceError = get(_)("review.enhance.errorUnavailable");
        enhanceState = "error";
      } else {
        enhanceError = get(_)("review.enhance.errorMessage", {
          values: { error: data.error || "unknown" },
        });
        enhanceState = "error";
      }
    } catch (err) {
      enhanceError = get(_)("review.enhance.errorMessage", {
        values: { error: String(err) },
      });
      enhanceState = "error";
    }
  }

  function closeEnhanceModal() {
    enhanceState = "idle";
    enhanceError = "";
    enhanceResult = "";
  }

  function useEnhancedPrompt() {
    if (enhanceResult) prompt = enhanceResult;
    closeEnhanceModal();
  }

  // Workflow management - initialize from loaded data
  let workflows: Workflow[] = data.workflows || [];
  let selectedWorkflowId: string = "";
  let loadingWorkflows = false;

  // Detect workflow type based on video mode
  $: videoWorkflowType = entry.additional_options?.ref2v === true
    ? "ref2v"
    : entry.last_image_url
      ? "fl2v"
      : "i2v";

  // Filter workflows by type to match the video
  $: filteredWorkflows = workflows.filter(
    (w) => w.workflowType === videoWorkflowType,
  );

  // Selected workflow + capability flags (MiniMax H3 uses a different node stack)
  $: selectedWorkflow =
    filteredWorkflows.find((w) => w.id === selectedWorkflowId) || null;
  // Effective credit cost for the CURRENT selections (workflow base + rules like
  // "2x if duration >= 8s" or "2x if no speed-up LoRA"). Shared calculator with
  // the kickoff route so the UI always matches what will be charged.
  $: selectedWorkflowQuotaCost = selectedWorkflow
    ? computeWorkflowQuotaCost(selectedWorkflow, {
        videoDuration,
        videoResolution,
        loraWeights,
      })
    : 1;
  $: isMiniMaxSelected = !!selectedWorkflow && isMiniMaxWorkflow(selectedWorkflow);

  // MiniMax H3 has no prompt relay / WAN-only features — force them off
  $: if (isMiniMaxSelected) promptRelayMode = false;

  const LORA_PRESETS: LoraPreset[] =
    data.loraPresets && data.loraPresets.length > 0
      ? data.loraPresets
      : DEFAULT_LORA_PRESETS;

  const hasAdvancedFeatures: boolean = data.hasAdvancedFeatures || false;

  // Check if entry has non-default values (indicating it's a previously saved video)
  // Only used for global settings (iteration/duration/resolution) — LoRA cache is always loaded
  const hasExistingSettings =
    entry.iteration_steps ||
    entry.video_duration ||
    entry.video_resolution ||
    entry.additional_options?.motion_scale !== undefined ||
    entry.additional_options?.freelong_blend_strength !== undefined;

  // Load global settings from localStorage if no existing settings
  let savedSettings: any = null;
  if (!hasExistingSettings && typeof window !== "undefined") {
    try {
      const saved = localStorage.getItem("video_generation_settings");
      if (saved) {
        savedSettings = JSON.parse(saved);
      }
    } catch (err) {
      console.error("Failed to load settings from localStorage:", err);
    }
  }

  // LoRA init gate — prevents save reactive from firing before restore completes
  let loraInitDone = false;

  type IterationSteps = 4 | 6 | 10 | 15;
  type VideoDuration = 4 | 6 | 8 | 10;
  type VideoResolution = "480p" | "720p";
  // Aspect ratio for ref2v output. 'video' follows the reference media's own
  // aspect; the rest are fixed presets (MiniMax H3 wants ~0.45-2.2 ratio).
  type Ref2vAspect = "video" | "16:9" | "4:3" | "square" | "3:4" | "9:16";
  let iterationSteps: IterationSteps =
    (entry.iteration_steps as IterationSteps) ||
    (savedSettings?.iterationSteps as IterationSteps) ||
    4;
  let videoDuration: VideoDuration =
    (entry.video_duration as VideoDuration) ||
    (savedSettings?.videoDuration as VideoDuration) ||
    4;
  let videoResolution: VideoResolution =
    (entry.video_resolution as VideoResolution) ||
    (savedSettings?.videoResolution as VideoResolution) ||
    "480p";
  let ref2vAspect: Ref2vAspect =
    (entry.additional_options?.ref2v_aspect as Ref2vAspect) ||
    (savedSettings?.ref2vAspect as Ref2vAspect) ||
    "video";
  let motionScale: number | undefined =
    entry.additional_options?.motion_scale ?? savedSettings?.motionScale; // 0.5 to 2.0
  let freeLongBlendStrength: number | undefined =
    entry.additional_options?.freelong_blend_strength ??
    savedSettings?.freeLongBlendStrength; // 0 to 1

  const MAX_SEGMENT_FRAMES = 121;
  const MIN_SEGMENT_FRAMES = 9;

  // Prompt relay mode
  interface RelaySegment {
    prompt: string;
    frames: number;
  }
  let promptRelayMode: boolean =
    entry.additional_options?.prompt_relay_mode === true
      ? true
      : savedSettings?.promptRelayMode === true;
  let relayGenerating = false;
  let relayMessage = "";

  // Total frames for relay timeline — user-controlled, must be 4n+1, tier-limited
  let totalRelayFrames: number = (() => {
    const segs = (entry.additional_options as any)?.prompt_relay_segments;
    if (Array.isArray(segs) && segs.length > 0) {
      const sum = segs.reduce(
        (s: number, seg: any) => s + (Number(seg.frames) || 0),
        0,
      );
      if (sum >= 81) return sum;
    }
    if (
      savedSettings?.relayTotalFrames &&
      Number.isFinite(Number(savedSettings.relayTotalFrames))
    ) {
      return Number(savedSettings.relayTotalFrames);
    }
    return 81;
  })();

  // Initialize relay segments from saved entry or defaults
  // Coerce frames to number to guard against stringified values from localStorage/JSON
  function coerceSegments(raw: any[]): RelaySegment[] {
    return raw.map((s) => ({
      prompt: String(s.prompt ?? ""),
      frames: Math.max(
        MIN_SEGMENT_FRAMES,
        Number(s.frames) || MIN_SEGMENT_FRAMES,
      ),
    }));
  }
  let relaySegments: RelaySegment[] = (() => {
    if (
      entry.additional_options?.prompt_relay_segments &&
      Array.isArray(entry.additional_options.prompt_relay_segments)
    ) {
      return coerceSegments(entry.additional_options.prompt_relay_segments);
    }
    // Restore frame layout only (no prompts) from localStorage
    if (
      savedSettings?.relaySegmentFrames &&
      Array.isArray(savedSettings.relaySegmentFrames) &&
      savedSettings.relaySegmentFrames.length > 0
    ) {
      return (savedSettings.relaySegmentFrames as number[]).map(f => ({ prompt: "", frames: Math.max(MIN_SEGMENT_FRAMES, Number(f) || MIN_SEGMENT_FRAMES) }));
    }
    return [{ prompt: "", frames: 81 }];
  })();

  $: usedRelayFrames = relaySegments.reduce(
    (sum, s) => sum + (Number(s.frames) || 0),
    0,
  );
  $: relayFramesValid = usedRelayFrames === totalRelayFrames;
  $: relaySegmentFramesValid = relaySegments.every(s => s.frames >= MIN_SEGMENT_FRAMES && s.frames <= MAX_SEGMENT_FRAMES);
  $: relaySegmentPromptsValid = relaySegments.every(s => s.prompt.trim().length > 0);

  // Whether a new segment can be added — either there's enough slack, or the last segment
  // has frames to spare (so we can steal the shortfall from it).
  $: canAddSegment =
    relaySegments.length < 10 &&
    (() => {
      const remaining = totalRelayFrames - usedRelayFrames;
      if (remaining >= MIN_SEGMENT_FRAMES) return true;
      const lastFrames = relaySegments[relaySegments.length - 1]?.frames ?? 0;
      const needed = MIN_SEGMENT_FRAMES - remaining; // frames to steal from last segment
      return lastFrames - needed >= MIN_SEGMENT_FRAMES; // last segment must keep ≥MIN after the steal
    })();

  // When totalRelayFrames changes, redistribute proportionally
  // Evaluate eagerly (same formula as $: totalRelayFrames) so it's never undefined
  let prevTotalRelayFrames: number = totalRelayFrames;
  $: if (totalRelayFrames !== prevTotalRelayFrames) {
    const ratio = totalRelayFrames / prevTotalRelayFrames;
    const adjusted = relaySegments.map((s) => ({
      ...s,
      frames: Math.max(MIN_SEGMENT_FRAMES, Math.round(s.frames * ratio)),
    }));
    // Fix rounding drift on last segment
    const drift =
      totalRelayFrames - adjusted.reduce((sum, s) => sum + s.frames, 0);
    if (adjusted.length > 0)
      adjusted[adjusted.length - 1].frames = Math.max(
        MIN_SEGMENT_FRAMES,
        adjusted[adjusted.length - 1].frames + drift,
      );
    relaySegments = adjusted;
    prevTotalRelayFrames = totalRelayFrames;
  }

  $: canUseQuality = hasAdvancedFeatures;

  // Track enabled state - Default ON + required (lightx2v) forced
  let loraEnabled: Record<string, boolean> = entry.lora_weights
    ? Object.fromEntries(
        LORA_PRESETS.map((lora) => [
          lora.id,
          entry.lora_weights?.[lora.id] !== undefined,
        ]),
      )
    : Object.fromEntries(
        LORA_PRESETS.map((lora) => [
          lora.id,
          lora.isConfigurable === false
            ? true
            : ((lora as any).defaultEnabled !== undefined
              ? (lora as any).defaultEnabled
              : (lora as any).enabled !== undefined
                ? (lora as any).enabled
                : true),
        ]),
      );
  let loraWeights: Record<string, number> =
    entry.lora_weights ||
    Object.fromEntries(LORA_PRESETS.map((lora) => [lora.id, lora.default]));

  // Get LoRAs compatible with selected workflow
  $: filteredLoraPresets =
    selectedWorkflowId && filteredWorkflows.length > 0
      ? (() => {
          const workflow = filteredWorkflows.find(
            (w) => w.id === selectedWorkflowId,
          );
          if (workflow) {
            return LORA_PRESETS.filter((lora) =>
              workflow.compatibleLoraIds.includes(lora.id),
            );
          }
          return LORA_PRESETS;
        })()
      : LORA_PRESETS;

  // When workflow changes, load the saved lora settings for that workflow
  // Always read fresh from localStorage — never use a stale snapshot
  $: if (
    selectedWorkflowId &&
    filteredLoraPresets &&
    Array.isArray(filteredLoraPresets) &&
    filteredLoraPresets.length > 0
  ) {
    // Read fresh from localStorage every time
    let freshAll: Record<string, any> = {};
    try {
      const raw = localStorage.getItem("workflow_lora_settings");
      if (raw) freshAll = JSON.parse(raw);
    } catch {}

    const workflowSettings = freshAll[selectedWorkflowId];

    const newLoraEnabled: Record<string, boolean> = {};
    const newLoraWeights: Record<string, number> = {};

    filteredLoraPresets.forEach((lora) => {
      // Required LoRAs (lightx2v on wan22 base) always enabled — cannot be turned off
      if (lora.isConfigurable === false) {
        newLoraEnabled[lora.id] = true;
      } else {
        const defOn = (lora as any).defaultEnabled !== undefined ? (lora as any).defaultEnabled : ((lora as any).enabled ?? true);
        newLoraEnabled[lora.id] =
          workflowSettings?.loraEnabled?.[lora.id] ?? defOn;
      }

      // Use saved weight for this workflow, or lora default
      newLoraWeights[lora.id] =
        workflowSettings?.loraWeights?.[lora.id] ?? lora.default;
    });

    loraEnabled = newLoraEnabled;
    loraWeights = newLoraWeights;
    loraInitDone = true; // Restore complete — allow saving
  }

  $: isEditable =
    entry.status !== "processing" &&
    entry.status !== "completed" &&
    entry.status !== "in_queue" &&
    entry.status !== "failed" &&
    entry.status !== "deleted";

  function getDefaultPrompt(nextEntry: any) {
    return nextEntry.prompt || "";
  }

  function shouldRefreshPrompt(nextEntry: any) {
    const previousPromptCandidates = new Set(
      [
        entry.prompt,
        getDefaultPrompt(entry),
        ...(entry.suggested_prompts || []),
      ].filter(Boolean),
    );

    return !prompt || previousPromptCandidates.has(prompt);
  }

  function applyEntryUpdate(nextEntry: any) {
    const shouldSyncPrompt = !prompt && shouldRefreshPrompt(nextEntry);

    entry = nextEntry;
    data = { ...data, entry: nextEntry };
    tags.set(
      (nextEntry.tags || []).map((value: string, index: number) => ({
        id: `${nextEntry.id}-${index}-${value}`,
        value,
      })),
    );

    if (shouldSyncPrompt) {
      prompt = getDefaultPrompt(nextEntry);
    }

    progressPercentage =
      typeof nextEntry.progress_percentage === "number"
        ? nextEntry.progress_percentage
        : null;
  }

  async function pollStatus() {
    if (
      entry.status === "completed" ||
      entry.status === "failed" ||
      entry.status === "deleted"
    ) {
      return; // Stop polling if completed or failed
    }

    try {
      const res = await fetch(`/api/video/${entry.id}/status`);
      if (res.ok) {
        const statusData = await res.json();
        console.log("Status poll result:", statusData);

        // Update entry status from server response
        entry = {
          ...entry,
          status: statusData.status || entry.status,
          validation_metadata: {
            ...(entry.validation_metadata || {}),
            revalidation_status: statusData.revalidation_status,
            manual_recognition_done: statusData.manual_recognition_done,
            manual_recognition_error: statusData.manual_recognition_error,
          },
        };

        // Update progress information
        if (typeof statusData.progress_percentage === "number") {
          progressPercentage = statusData.progress_percentage;
        } else {
          progressPercentage = null;
        }

        // If job is completed, redirect to videos page
        if (statusData.status === "completed") {
          await goto(`/videos/${entry.id}?returnTo=/videos`);
        }
      }
    } catch (err) {
      console.error("Failed to poll status:", err);
    }
  }

  async function runManualAnalysis() {
    if (analyzing || !isEditable) return;

    analyzing = true;
    message = "";

    try {
      const res = await fetch(`/api/video/${entry.id}/analyze`, {
        method: "POST",
      });

      if (!res.ok) {
        const contentType = res.headers.get("content-type") || "";
        const rawError = await res.text().catch(() => "");
        const isHtmlResponse =
          contentType.includes("text/html") ||
          /^\s*(<\!DOCTYPE|<html)/i.test(rawError);

        if (isHtmlResponse) {
          message = get(_)("review.analysisFailed", {
            values: { error: "connection timed out" },
          });
          return;
        }

        let payload: any = { error: rawError || `HTTP ${res.status}` };
        try {
          payload = rawError ? JSON.parse(rawError) : payload;
        } catch {
          // Keep text fallback for non-JSON responses.
        }

        if (payload.errorCode === "analysis_unavailable") {
          message = get(_)("review.analysisUnavailable");
        } else {
          message = get(_)("review.analysisFailed", {
            values: { error: payload.error || "unknown" },
          });
        }

        if (payload.entry) {
          applyEntryUpdate(payload.entry);
        }
        return;
      }

      const payload = await res.json();

      if (payload.success) {
        if (payload.entry) {
          applyEntryUpdate(payload.entry);
        }
        message = get(_)("review.analysisSuccess");
      } else {
        if (payload.errorCode === "analysis_unavailable") {
          message = get(_)("review.analysisUnavailable");
        } else {
          message = payload.error || get(_)("review.analysisUnavailable");
        }
        if (payload.entry) {
          applyEntryUpdate(payload.entry);
        }
      }
    } catch (error) {
      message = get(_)("review.analysisFailed", {
        values: { error: String(error) },
      });
    } finally {
      analyzing = false;
    }
  }

  async function retryGeneration() {
    try {
      const res = await fetch(`/api/video/${entry.id}/retry`, {
        method: "POST",
      });

      if (res.ok) {
        const result = await res.json();
        message = get(_)("review.jobResubmitted");
        // Update status from server response
        if (result.status) {
          entry = { ...entry, status: result.status, job_id: result.job_id };
        } else {
          entry = { ...entry, status: "in_queue" };
        }
        pollStatus();
        if (!pollInterval) {
          pollInterval = setInterval(pollStatus, 10000);
        }
      } else {
        const rawError = await res.text().catch(() => "");
        let error: any = { error: rawError || `HTTP ${res.status}` };
        try {
          error = rawError ? JSON.parse(rawError) : error;
        } catch {
          // Keep text fallback for non-JSON timeout/proxy responses.
        }
        const t = get(_);
        alert(
          t("review.failedToRetry", {
            values: { error: error.error || "Unknown error" },
          }),
        );
      }
    } catch (err) {
      console.error("Failed to retry generation:", err);
      alert(get(_)("review.failedToRetry", { values: { error: String(err) } }));
    }
  }

  async function generateRelayWithAI() {
    if (relayGenerating) return;
    // Confirm before overwriting if any segment already has a prompt
    const hasExistingContent = relaySegments.some(s => s.prompt.trim().length > 0);
    if (hasExistingContent) {
      const ok = window.confirm(get(_)("review.relay.aiOverwriteConfirm"));
      if (!ok) return;
    }
    relayGenerating = true;
    relayMessage = "";
    try {
      const res = await fetch(`/api/video/${entry.id}/analyze-relay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ totalFrames: totalRelayFrames, locale: get(locale) }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        prompt = data.globalPrompt || prompt;
        relaySegments = data.segments;
        relayMessage = get(_)("review.relay.aiSuccess");
      } else {
        relayMessage = get(_)("review.relay.aiError");
      }
    } catch (err) {
      relayMessage = get(_)("review.relay.aiError");
    } finally {
      relayGenerating = false;
    }
  }

  onMount(async () => {
    // Initialize workflow selection from loaded data
    const workflowsForType = workflows.filter(
      (w) => w.workflowType === videoWorkflowType,
    );

    // For editable entries, prefer localStorage (user's last choice)
    // For processing/completed entries, respect the entry's workflow_id
    if (isEditable && savedSettings?.selectedWorkflowId) {
      const savedWorkflow = workflowsForType.find(
        (w) => w.id === savedSettings.selectedWorkflowId,
      );
      if (savedWorkflow) {
        selectedWorkflowId = savedWorkflow.id;
      }
    }

    // Fallback to entry.workflow_id if we haven't set one yet
    if (!selectedWorkflowId && entry.workflow_id) {
      const savedWorkflow = workflowsForType.find(
        (w) => w.id === entry.workflow_id,
      );
      if (savedWorkflow) {
        selectedWorkflowId = savedWorkflow.id;
      }
    }

    // Final fallback to default workflow
    if (!selectedWorkflowId) {
      const defaultWorkflow = workflowsForType.find((w) => w.isDefault);
      selectedWorkflowId = defaultWorkflow?.id || workflowsForType[0]?.id || "";
    }

    // Fetch remaining quota
    try {
      const quotaRes = await fetch("/api/quota");
      if (quotaRes.ok) {
        const quotaData = await quotaRes.json();
        quotaRemaining = quotaData.remaining;
        quotaLimit = quotaData.limit;
      }
    } catch (err) {
      console.error("Failed to fetch quota:", err);
    } finally {
      quotaLoading = false;
    }

    // Redirect to video details if already completed
    if (entry.status === "completed") {
      setTimeout(() => {
        goto(`/videos/${entry.id}?returnTo=/videos`);
      }, 1000); // wait 1 second before redirecting, otherwise the entry may not be ready
      return;
    }

    // Start polling if video is in progress
    if (entry.status === "in_queue" || entry.status === "processing") {
      pollStatus(); // Initial poll
      pollInterval = setInterval(pollStatus, 5000); // Poll every 5 seconds
    }

    // Auto-start AI analysis: MiniMax H3 needs a good prompt to produce good
    // video, so kick off the suggestion analysis automatically for editable
    // entries that haven't been analyzed yet (no completed manual recognition,
    // no pending/errored request). The user can re-run it anytime via the button.
    const validation = entry.validation_metadata || {};
    const analysisPending = validation.manual_recognition_requested_at && !validation.manual_recognition_done && !validation.manual_recognition_error;
    const shouldAutoAnalyze =
      isEditable &&
      !validation.manual_recognition_done &&
      !validation.manual_recognition_error &&
      !analysisPending;

    if (shouldAutoAnalyze) {
      // Small delay so the page renders the "Analyzing..." state first
      setTimeout(() => {
        runManualAnalysis();
      }, 300);
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
    ref2vAspect,
    motionScale,
    freeLongBlendStrength,
    selectedWorkflowId,
    promptRelayMode,
    // Save frame layout only — prompts are content, not settings
    relaySegmentFrames: relaySegments.map(s => s.frames),
    relayTotalFrames: totalRelayFrames,
  };

  // Save global settings to localStorage whenever they change
  // Only save when editable — don't overwrite preferences while a job is processing
  $: if (typeof window !== "undefined" && isEditable) {
    try {
      localStorage.setItem(
        "video_generation_settings",
        JSON.stringify(settings),
      );
    } catch (err) {
      console.error("Failed to save settings to localStorage:", err);
    }
  }

  // Save per-workflow lora settings to localStorage
  // Gated by loraInitDone to prevent overwriting saved data with defaults before restore completes
  $: if (typeof window !== "undefined" && selectedWorkflowId && loraInitDone) {
    try {
      // Load existing workflow lora settings
      const saved = localStorage.getItem("workflow_lora_settings");
      const allSettings = saved ? JSON.parse(saved) : {};

      // Update settings for current workflow
      allSettings[selectedWorkflowId] = {
        loraEnabled,
        loraWeights,
      };

      localStorage.setItem(
        "workflow_lora_settings",
        JSON.stringify(allSettings),
      );
    } catch (err) {
      console.error(
        "Failed to save workflow lora settings to localStorage:",
        err,
      );
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
    loraWeights = Object.fromEntries(
      filteredLoraPresets.map((lora) => [lora.id, lora.default]),
    );
    loraEnabled = Object.fromEntries(
      filteredLoraPresets.map((lora) => [
        lora.id,
        lora.isConfigurable === false
          ? true
          : lora.enabled !== undefined
            ? lora.enabled
            : true,
      ]),
    );
  }

  function resetAdvancedSettings() {
    iterationSteps = 4;
    videoDuration = 4;
    videoResolution = "480p";
    ref2vAspect = "video";
    motionScale = undefined;
    freeLongBlendStrength = undefined;
    resetLoraWeights();

    // Reset to default workflow for current type
    const defaultWorkflow = filteredWorkflows.find((w) => w.isDefault);
    if (defaultWorkflow) {
      selectedWorkflowId = defaultWorkflow.id;
    }
  }

  // Tags input (melt) — API bundle passed to ReviewImageCard
  const {
    elements: { root, input, tag, deleteTrigger },
    states: { tags },
    helpers: { addTag },
  } = createTagsInput({
    defaultTags: entry.tags || [],
    unique: true,
    trim: true,
  });
  const meltApi = { root, input, tag, deleteTrigger, tags };

  function addNewTag() {
    if (newtag && newtag.trim() !== "") {
      addTag(newtag.trim());
      newtag = "";
    }
  }

  let lastAppliedEntrySnapshot = JSON.stringify({
    status: entry.status,
    tags: entry.tags || [],
    suggested_prompts: entry.suggested_prompts || [],
    prompt: entry.prompt || "",
    is_nsfw: entry.is_nsfw,
    is_photo_realistic: entry.is_photo_realistic,
    validation_metadata: entry.validation_metadata || null,
    progress_percentage: entry.progress_percentage ?? null,
  });

  $: {
    const nextEntry = data.entry;
    const nextSnapshot = JSON.stringify({
      status: nextEntry?.status,
      tags: nextEntry?.tags || [],
      suggested_prompts: nextEntry?.suggested_prompts || [],
      prompt: nextEntry?.prompt || "",
      is_nsfw: nextEntry?.is_nsfw,
      is_photo_realistic: nextEntry?.is_photo_realistic,
      validation_metadata: nextEntry?.validation_metadata || null,
      progress_percentage: nextEntry?.progress_percentage ?? null,
    });

    if (nextEntry && nextSnapshot !== lastAppliedEntrySnapshot) {
      lastAppliedEntrySnapshot = nextSnapshot;
      applyEntryUpdate(nextEntry);
    }
  }

  async function generate() {
    busy = true;
    message = "";
    showBusyModal = false;
    busyModalMessage = "";
    limitType = null;

    try {
      const t = get(_);
      // Check health before proceeding
      const healthRes = await fetch("/api/health");
      if (healthRes.ok) {
        const health = await healthRes.json();
        if (!health.available || health.queueFull) {
          showBusyModal = true;
          limitType = "system";
          busyModalMessage = t("review.serverBusy.queueFull");
          busy = false;
          return;
        }
      }

      // Kickoff the I2V job with updated prompt and tags
      // Only include enabled LoRAs
      const filteredLoraWeights = Object.fromEntries(
        Object.entries(loraWeights).filter(([id]) => loraEnabled[id]),
      );
      const res = await fetch("/api/i2v/kickoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: entry.id,
          prompt,
          tags: $tags.map((t) => t.value),
          workflowId: selectedWorkflowId,
          loraWeights: filteredLoraWeights,
          iterationSteps,
          videoDuration,
          videoResolution,
          ref2vAspect: videoWorkflowType === "ref2v" ? ref2vAspect : undefined,
          motionScale,
          freeLongBlendStrength,
          promptRelayMode,
          promptRelaySegments: promptRelayMode ? relaySegments : undefined,
        }),
      });

      if (!res.ok) {
        const rawError = await res.text().catch(() => "");
        let j: any = { error: rawError || `HTTP ${res.status}` };
        try {
          j = rawError ? JSON.parse(rawError) : j;
        } catch {
          // Keep text fallback for non-JSON timeout/proxy responses.
        }

        if (res.status === 429) {
          // User hit their personal limit
          showBusyModal = true;
          limitType = "user";
          if (j.errorCode === "quota_none") {
            busyModalMessage = t("review.quotaLimit.none");
          } else if (j.errorCode === "quota_exceeded") {
            busyModalMessage = t("review.quotaLimit.exceeded", {
              values: { limit: j.limit, used: j.used, cost: j.cost ?? 1 },
            });
          } else if (j.errorCode === "queue_limit") {
            busyModalMessage = t("review.quotaLimit.queueLimit", {
              values: { limit: j.limit },
            });
          } else {
            busyModalMessage = j.error || t("review.serverBusy.userLimit");
          }
        } else if (res.status === 503) {
          // System-wide queue full
          showBusyModal = true;
          limitType = "system";
          busyModalMessage = t("review.serverBusy.highDemand");
        } else {
          message = t("review.failedToSubmit", {
            values: { error: j.error || "unknown" },
          });
        }
        return;
      }

      const j = await res.json();
      if (j.success) {
        message = t("review.jobSubmitted");
        // Update local entry with the returned video data
        if (j.video) {
          entry = j.video;
        } else {
          // Fallback to manual status update
          entry = { ...entry, status: "in_queue" };
        }
        // navigate to user's videos or detail page
        await goto("/videos");
      } else {
        message = t("review.failedToSubmit", {
          values: { error: j.error || "unknown" },
        });
      }
    } catch (err) {
      message = "Error: " + String(err);
    } finally {
      busy = false;
    }
  }

  async function deleteVideo() {
    if (!confirm(get(_)("review.deleteConfirm"))) {
      return;
    }

    try {
      const res = await fetch(`/api/video/${entry.id}`, {
        method: "DELETE",
      });

      if (res.ok) {
        await goto("/videos");
      } else {
        alert("Failed to delete video");
      }
    } catch (err) {
      alert("Error deleting video: " + err);
    }
  }
</script>

<div class="max-w-4xl mx-auto">
  <div class="flex justify-between items-center mb-8">
    <h1 class="text-4xl font-bold">{$_("review.title")}</h1>
    <div
      class="badge badge-lg"
      class:badge-success={entry.status === "completed"}
      class:badge-warning={entry.status === "processing" ||
        entry.status === "in_queue"}
      class:badge-info={entry.status === "uploaded"}
      class:badge-error={entry.status === "failed"}
      class:badge-neutral={entry.status === "deleted"}
    >
      {$_(`videos.status.${entry.status}`) || entry.status}
    </div>
  </div>

  {#if (entry.status === "processing" || entry.status === "in_queue") && progressPercentage !== null}
    <div class="alert alert-info shadow-lg mb-6">
      <div class="flex flex-col w-full gap-2">
        <div class="flex justify-between items-center">
          <span class="font-semibold">{$_("review.processing")}</span>
          <span class="text-sm">{progressPercentage.toFixed(1)}%</span>
        </div>
        <progress
          class="progress progress-primary w-full"
          value={progressPercentage}
          max="100"
        ></progress>
      </div>
    </div>
  {/if}

  {#if message}
    <div class="alert alert-info shadow-lg mb-6">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        class="stroke-current shrink-0 w-6 h-6"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        ></path>
      </svg>
      <span>{message}</span>
    </div>
  {/if}

  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
    <ReviewImageCard
      {entry}
      {videoWorkflowType}
      {isEditable}
      bind:newtag
      {meltApi}
      {addNewTag}
    />
    <ReviewSuggestionsCard
      {entry}
      {isEditable}
      {analyzing}
      onAnalyze={runManualAnalysis}
      onUsePrompt={(p) => (prompt = p)}
    />
  </div>

  <!-- Prompt Input & Generate -->
  <div class="card bg-base-100 shadow-xl">
    <div class="card-body">
      <div class="flex items-center justify-between gap-3">
        <h2 class="card-title">{$_("review.yourPrompt")}</h2>
        {#if (videoWorkflowType === "ref2v" || isMiniMaxSelected) && isEditable && !promptRelayMode}
          <button
            class="btn btn-sm btn-outline btn-primary"
            on:click={enhancePrompt}
            disabled={enhanceState === "loading" || !prompt.trim()}
          >
            {#if enhanceState === "loading"}
              <span class="loading loading-spinner loading-xs"></span>
            {/if}
            {$_("review.enhance.button")}
          </button>
        {/if}
      </div>
      <p class="text-sm opacity-70 mb-2">{$_("review.promptHelp")}</p>

      <!-- Ref2V only: the reference-to-video model understands a strict
           structured prompt format. Plain text often yields unexpected
           results, so strongly suggest the enhancer. -->
      {#if videoWorkflowType === "ref2v" && isEditable}
        <div class="alert alert-warning py-2 mb-3 text-sm">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="stroke-current shrink-0 h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <span>{$_("review.enhance.ref2vHint")}</span>
        </div>
      {/if}

      <!-- Prompt Mode Toggle -->
      {#if !isMiniMaxSelected}
        <div class="join mb-3">
          <button
            class="btn btn-sm join-item"
            class:btn-primary={!promptRelayMode}
            class:btn-ghost={promptRelayMode}
            on:click={() => (promptRelayMode = false)}
            disabled={!isEditable}>{$_("review.promptMode.standard")}</button
          >
          <button
            class="btn btn-sm join-item"
            class:btn-primary={promptRelayMode}
            class:btn-ghost={!promptRelayMode}
            on:click={() => (promptRelayMode = true)}
            disabled={!isEditable}>{$_("review.promptMode.relay")}</button
          >
        </div>
      {/if}

      <ReviewPromptEditor
        bind:prompt
        {isEditable}
        {videoWorkflowType}
        {promptRelayMode}
        {refItems}
        {referencedTokens}
        {availableRefs}
      />

      <!-- Prompt Relay Segments -->
      {#if promptRelayMode}
        <ReviewRelayTimeline
          {isEditable}
          {hasAdvancedFeatures}
          {relayGenerating}
          {relayMessage}
          bind:totalRelayFrames
          bind:relaySegments
          {usedRelayFrames}
          {relayFramesValid}
          {relaySegmentFramesValid}
          {relaySegmentPromptsValid}
          {canAddSegment}
          generateRelayWithAI={generateRelayWithAI}
        />
      {/if}

      <!-- Advanced Settings -->
      <div class="divider mt-6 mb-2"></div>
      <ReviewAdvancedSettings
        {isEditable}
        {loadingWorkflows}
        {filteredWorkflows}
        bind:selectedWorkflowId
        {isMiniMaxSelected}
        {promptRelayMode}
        {canUseQuality}
        {videoWorkflowType}
        bind:showAdvancedSettings
        bind:iterationSteps
        bind:videoDuration
        bind:videoResolution
        bind:ref2vAspect
        bind:motionScale
        bind:freeLongBlendStrength
        {filteredLoraPresets}
        bind:loraEnabled
        bind:loraWeights
        {updateLoraWeight}
        {toggleLoraEnabled}
        {resetLoraWeights}
        {resetAdvancedSettings}
      />

      <ReviewActionBar
        {entry}
        {busy}
        {quotaLoading}
        {quotaRemaining}
        {quotaLimit}
        {selectedWorkflowQuotaCost}
        {promptRelayMode}
        {relayFramesValid}
        {relaySegmentFramesValid}
        {relaySegmentPromptsValid}
        onDelete={deleteVideo}
        onRetry={retryGeneration}
        onGenerate={generate}
      />
    </div>
  </div>
</div>

<!-- Busy Server Modal -->
<ReviewBusyModal
  {showBusyModal}
  {limitType}
  {busyModalMessage}
  {sponsorUrl}
  onClose={() => (showBusyModal = false)}
/>

<!-- MiniMax H3 Prompt Enhancer Modal -->
<ReviewEnhanceModal
  show={enhanceState === "loading" || enhanceState === "error" || enhanceState === "done"}
  loading={enhanceState === "loading"}
  error={enhanceError}
  result={enhanceResult}
  onUse={useEnhancedPrompt}
  onCancel={closeEnhanceModal}
  onRetry={enhancePrompt}
/>
