<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { goto } from "$app/navigation";
  import { _, locale } from "svelte-i18n";
  import { get } from "svelte/store";
  import { createTagsInput, melt } from "@melt-ui/svelte";
  import { DEFAULT_LORA_PRESETS } from "$lib/loraPresets";
  import type { LoraPreset } from "$lib/loraPresets";
  import type { Workflow } from "$lib/IDatabase";
  import { isMiniMaxWorkflow } from "$lib/workflows";
  import { computeWorkflowQuotaCost } from "$lib/quotaCost";

  export let data: any;
  let entry = data.entry as any;
  let sponsorUrl = data.sponsorUrl || "";
  let prompt = entry.prompt || "";
  // Ref2V reference-chip state: a "+" button opens a picker of the ref video /
  // ref images; selecting one inserts its <Picture N> / <Video 1> token into the
  // prompt at the cursor. The prompt editor is a contenteditable that renders
  // tokens as inline badges. The raw <Picture N>/<Video 1> text is what gets
  // sent to the server (the MiniMax H3 model splices vision blocks at those tags).
  let promptEditor: HTMLDivElement | undefined;
  let promptCursor = -1;
  // True while an IME composition (e.g. Chinese input) is in progress — we skip
  // re-rendering the editor during composition or the IME breaks.
  let composing = false;
  // Available references, in the same order the model presents them (video 1st,
  // then images 1..N). Token ordinals are per-type (always <Video 1>, <Picture N>).
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
  // Tokens present in the prompt (in any position, any count)
  $: referencedTokens = [...prompt.matchAll(/<(Picture|Video)\s*\d+>/g)].map((m) => m[0]);
  // Refs not yet referenced — shown in the "+" picker (multiple uses allowed, so
  // a ref stays in the picker as long as it's not already referenced)
  $: availableRefs = refItems.filter((r) => !referencedTokens.includes(r.token));

  /** Render the prompt text into the contenteditable, tokenizing <Picture N> /
   *  <Video 1> into badge spans. Preserves cursor where possible. Skips the
   *  rebuild when nothing changed structurally (plain typing keeps native
   *  editing + undo). Zero-width caret anchors are ignored in the comparison,
   *  and the regenerated HTML is parsed by the browser first so self-closing
   *  <img /> / attribute forms serialize identically on both sides. */
  function renderPromptEditor() {
    if (!promptEditor) return;
    const el = promptEditor;
    const html = tokenizePrompt(prompt);
    const probe = document.createElement('div');
    probe.innerHTML = html;
    if (el.innerHTML.replace(/\u200b/g, '') === probe.innerHTML) return;
    // Save caret position as character offset into the plain text
    const caretOffset = getEditorCaretOffset();
    el.innerHTML = html;
    restoreEditorCaret(caretOffset);
  }

  function tokenizePrompt(text: string): string {
    // Split on tokens, wrap each in a badge span. The badge's visible text is
    // exactly the token (escaped), so DOM text length == source prompt length
    // and caret offsets computed via the DOM walkers stay consistent.
    const parts = text.split(/(<(?:Picture|Video)\s*\d+>)/g);
    return parts
      .map((part) => {
        const m = part.match(/^<(Picture|Video)\s*(\d+)>$/);
        if (m) {
          const kind = m[1].toLowerCase();
          const num = m[2];
          const ref = refItems.find((r) => r.token === part);
          const thumb = ref?.kind === 'image'
            ? `<img src="${ref.url}" alt="" class="w-3.5 h-3.5 rounded object-cover inline-block align-middle" />`
            : '';
          const icon = ref?.kind === 'video'
            ? '<svg class="w-3.5 h-3.5 inline-block align-middle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>'
            : '';
          return `<span class="inline-flex items-center gap-1 badge badge-primary badge-sm font-normal px-1.5 py-0.5 align-middle" contenteditable="false" data-ref-token="${escapeHtml(part)}">${thumb}${icon}<span>${escapeHtml(part)}</span></span>`;
        }
        return escapeHtml(part).replace(/\n/g, '<br>');
      })
      .join("");
  }

  function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** Walk a node, appending its "source prompt" text: text nodes verbatim
   *  (zero-width caret anchors stripped), <br> as "\n", badges as their
   *  token, icons skipped. Used by both editorToPrompt and
   *  getEditorCaretOffset so they can never disagree. */
  function domWalk(node: Node, onText: (t: string) => void): void {
    if (node.nodeType === Node.TEXT_NODE) {
      onText((node.textContent || '').replace(/\u00a0/g, ' ').replace(/\u200b/g, ''));
      return;
    }
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (tag === 'BR') {
      onText('\n');
      return;
    }
    if (tag === 'IMG' || tag === 'SVG') return; // decorative icons
    if (el.hasAttribute('data-ref-token')) {
      onText(el.getAttribute('data-ref-token') || '');
      return;
    }
    el.childNodes.forEach((c) => domWalk(c, onText));
  }

  function editorToPrompt(): string {
    if (!promptEditor) return prompt;
    let out = '';
    promptEditor.childNodes.forEach((c) => domWalk(c, (t) => (out += t)));
    return out;
  }

  function getEditorCaretOffset(): number {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !promptEditor) return -1;
    const range = sel.getRangeAt(0);
    const startNode = range.startContainer;
    const startOffset = range.startOffset;
    let offset = 0;
    let done = false;

    const walk = (node: Node) => {
      if (done) return;
      if (node === startNode) {
        if (node.nodeType === Node.TEXT_NODE) {
          const t = (node.textContent || '').replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
          offset += Math.min(startOffset, t.length);
        } else {
          const children = Array.from(node.childNodes);
          for (let i = 0; i < Math.min(startOffset, children.length); i++) {
            domWalk(children[i], (t) => (offset += t.length));
          }
        }
        done = true;
        return;
      }
      domWalk(node, (t) => (offset += t.length));
    };
    promptEditor.childNodes.forEach(walk);
    return done ? offset : -1;
  }

  function restoreEditorCaret(offset: number) {
    if (offset < 0 || !promptEditor) return;
    const sel = window.getSelection();
    if (!sel) return;
    let remaining = offset;
    let target: { node: Node; off: number; mode: 'in' | 'before' | 'after' } | null = null;

    const walk = (node: Node): boolean => {
      if (target) return true;
      if (node.nodeType === Node.TEXT_NODE) {
        const raw = node.textContent || '';
        const stripped = raw.replace(/\u200b/g, '');
        if (stripped.length === 0) return false; // ZWSP caret-anchor node: invisible, skip
        if (remaining <= stripped.length) {
          // Map the stripped-space offset back to a raw offset in the node.
          let rawOff = 0;
          let seen = 0;
          for (let i = 0; i < raw.length; i++) {
            if (raw[i] === '\u200b') { rawOff++; continue; }
            if (seen === remaining) break;
            seen++; rawOff++;
          }
          target = { node, off: rawOff, mode: 'in' };
          return true;
        }
        remaining -= stripped.length;
        return false;
      }
      const el = node as HTMLElement;
      const tag = el.tagName;
      if (tag === 'BR') {
        if (remaining <= 1) {
          target = { node, off: 0, mode: 'before' };
          return true;
        }
        remaining -= 1;
        return false;
      }
      if (tag === 'IMG' || tag === 'SVG') return false;
      if (el.hasAttribute('data-ref-token')) {
        const tok = el.getAttribute('data-ref-token') || '';
        if (remaining <= tok.length) {
          target = { node: el, off: 0, mode: remaining === tok.length ? 'after' : 'before' };
          return true;
        }
        remaining -= tok.length;
        return false;
      }
      for (const c of Array.from(el.childNodes)) {
        if (walk(c)) return true;
      }
      return false;
    };

    for (const c of Array.from(promptEditor.childNodes)) {
      if (walk(c)) break;
    }

    const range = document.createRange();
    if (!target) {
      range.selectNodeContents(promptEditor);
      range.collapse(false);
    } else {
      const t = target as { node: Node; off: number; mode: 'in' | 'before' | 'after' };
      if (t.mode === 'in') {
        const text = t.node.textContent || '';
        range.setStart(t.node, Math.min(t.off, text.length));
        range.collapse(true);
      } else if (t.mode === 'before') {
        range.setStartBefore(t.node);
        range.collapse(true);
      } else {
        range.setStartAfter(t.node);
        range.collapse(true);
      }
    }
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function onEditorInput() {
    prompt = editorToPrompt();
    promptCursor = getEditorCaretOffset();
    // Live-render: if the user typed a token, turn it into a badge. Skipped
    // during IME composition — re-rendering would break the composition.
    if (!composing) renderPromptEditor();
  }

  /** Insert a single <br> at the caret with the caret placed AFTER it, then
   *  re-sync the prompt. (execCommand insertHTML/insertLineBreak in this
   *  Chromium misplace the caret or insert double breaks.)
   *
   *  Chromium quirk: a caret placed after a *trailing* <br> is normalized back
   *  before it, so the next keystroke lands on the previous line (requiring a
   *  second Enter to "create" the new line). We anchor the caret with an
   *  invisible zero-width space after a trailing break; the anchor is stripped
   *  everywhere (domWalk / getEditorCaretOffset / renderPromptEditor) and gets
   *  consumed naturally by the next keystroke. */
  function insertLineBreakAtCaret() {
    if (!promptEditor) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const br = document.createElement('br');
    range.insertNode(br);
    // Is the br trailing (nothing meaningful after it)? Only then anchor.
    let trailing = true;
    for (let s = br.nextSibling; s; s = s.nextSibling) {
      const meaningful =
        s.nodeType === Node.TEXT_NODE
          ? (s.textContent || '').replace(/\u200b/g, '') !== ''
          : s.nodeType === Node.ELEMENT_NODE && (s as HTMLElement).tagName !== 'BR';
      if (meaningful) { trailing = false; break; }
    }
    let anchor: Text | null = null;
    if (trailing) {
      anchor = document.createTextNode('\u200b');
      br.parentNode?.insertBefore(anchor, br.nextSibling);
    }
    const after = document.createRange();
    if (anchor) {
      after.setStart(anchor, 1); // after the zero-width space
    } else {
      after.setStartAfter(br);
    }
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    onEditorInput();
  }

  function insertRefToken(token: string) {
    if (!isEditable) return;
    if (!promptEditor) {
      prompt = (prompt.trim() + " " + token).trim();
      return;
    }
    // Prefer the live caret when the selection is still inside the editor (it
    // persists after clicking the + button); fall back to the last tracked
    // promptCursor position.
    const sel = window.getSelection();
    const liveCaret =
      sel && sel.rangeCount > 0 && promptEditor.contains(sel.getRangeAt(0).startContainer)
        ? getEditorCaretOffset()
        : -1;
    let caretOffset = liveCaret >= 0 ? liveCaret : promptCursor;
    if (caretOffset < 0 || caretOffset > prompt.length) caretOffset = prompt.length;
    const before = prompt.slice(0, caretOffset);
    const after = prompt.slice(caretOffset);
    const sepBefore = before && !/\s$/.test(before) ? " " : "";
    const sepAfter = after && !/^\s/.test(after) ? " " : "";
    prompt = before + sepBefore + token + sepAfter + after;
    promptCursor = (before + sepBefore + token).length;
    renderPromptEditor();
    // renderPromptEditor restores the *old* caret (it re-reads the DOM before
    // the rebuild). Then focus the editor FIRST and place the caret after the
    // inserted badge LAST: if the editor lost focus (user clicked the + button
    // and a picker item), .focus() would restore the browser's stored pre-blur
    // caret and clobber the placement otherwise.
    promptEditor.focus();
    restoreEditorCaret(promptCursor);
  }

  function insertAllRefTokens() {
    if (!isEditable || availableRefs.length === 0) return;
    // Append every not-yet-referenced token at the end of the prompt (separated
    // by a space), so a user can quickly make all refs explicit.
    const suffix = availableRefs.map((r) => r.token).join(" ");
    prompt = (prompt.trim() + " " + suffix).trim();
    renderPromptEditor();
    // Focus first, then place the caret at the end (see insertRefToken).
    if (promptEditor) promptEditor.focus();
    restoreEditorCaret(prompt.length);
  }
  let busy = false;
  let message = "";
  let newtag = "";
  let showBusyModal = false;
  let busyModalMessage = "";
  let limitType: "user" | "system" | null = null;
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let showAdvancedSettings = false;
  let progressPercentage: number | null = null;
  let quotaRemaining: number | null = null;
  let quotaLimit: number | null = null;
  let quotaLoading = true;
  let analyzing = false;

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

  type IterationSteps = 4 | 6 | 10 | 15;
  let stepOptions: {
    value: IterationSteps;
    label: string;
    description: string;
    requiresPaid?: boolean;
  }[] = [];

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

  type VideoDuration = 4 | 6 | 8 | 10;
  type VideoResolution = "480p" | "720p";
  let iterationSteps: IterationSteps =
    (entry.iteration_steps as IterationSteps) ||
    (savedSettings?.iterationSteps as IterationSteps) ||
    4;  let videoDuration: VideoDuration =
    (entry.video_duration as VideoDuration) ||
    (savedSettings?.videoDuration as VideoDuration) ||
    4;
  let videoResolution: VideoResolution =
    (entry.video_resolution as VideoResolution) ||
    (savedSettings?.videoResolution as VideoResolution) ||
    "480p";
  let motionScale: number | undefined =
    entry.additional_options?.motion_scale ?? savedSettings?.motionScale; // 0.5 to 2.0
  let freeLongBlendStrength: number | undefined =
    entry.additional_options?.freelong_blend_strength ??
    savedSettings?.freeLongBlendStrength; // 0 to 1

  let resolutionOptions: {
    value: VideoResolution;
    label: string;
    description: string;
    requiresPaid?: boolean;
  }[] = [
    { value: "480p", label: "", description: "", requiresPaid: false },
    { value: "720p", label: "", description: "", requiresPaid: true },
  ];
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

  // Max total relay frames based on user tier (free: 121, advanced: 177)
  $: maxRelayFrames = hasAdvancedFeatures ? 177 : 121;

  // Helper: snap n to nearest valid 4n+1 value
  function roundTo4n1(n: number): number {
    return Math.round((n - 1) / 4) * 4 + 1;
  }

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

  // Duration options — 10s for advanced users (WAN: relay mode only; MiniMax: standard mode)
  // 8s is a MiniMax H3 premium-only option
  $: durationOptions = [
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
  ];
  $: if (
    !isMiniMaxSelected &&
    (videoDuration === 8 || (videoDuration === 10 && !promptRelayMode))
  )
    videoDuration = 6;

  // Duration slider — tick marks across all possible values; some are disabled
  // per model/tier (8s MiniMax premium only, 10s premium & relay/WAN gated)
  const DURATION_TICKS = [4, 6, 8, 10] as const;
  $: currentDurationOption = durationOptions.find((o) => o.value === videoDuration);
  // Precompute tick state reactively — template cannot see deps inside
  // function calls, so disabled/opacity/badge must come from a tracked variable.
  $: durationTicks = DURATION_TICKS.map((tick) => {
    const option = durationOptions.find((o) => o.value === tick);
    return {
      value: tick,
      allowed: !!option,
      premium: option?.requiresPaid === true,
    };
  });

  function setVideoDuration(value: number) {
    // Snap to nearest allowed duration (ties prefer the lower value)
    const snap = durationOptions.reduce((best, o) =>
      Math.abs(o.value - value) < Math.abs(best.value - value) ? o : best,
    );
    videoDuration = snap.value as VideoDuration;
  }

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
  $: if (!canUseQuality && videoResolution === "720p") videoResolution = "480p";
  // If the selected step isn't available for the current model/tier, snap to default
  $: if (!stepOptions.some((o) => o.value === iterationSteps)) iterationSteps = defaultIterationSteps as IterationSteps;
  $: if (!canUseQuality && iterationSteps === (isMiniMaxSelected ? 12 : 6)) iterationSteps = isMiniMaxSelected ? 10 : 4;
  $: if (!canUseQuality && isMiniMaxSelected && iterationSteps === 15) iterationSteps = 10;
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

  // Segment colours — cycle through these
  const SEGMENT_COLORS_HEX = [
    "#570df8", // primary   - violet
    "#f000b8", // secondary - magenta
    "#37cdbe", // accent    - teal
    "#f87272", // error     - red
    "#fbbd23", // warning   - amber
    "#3abff8", // info      - sky blue
    "#ff6b35", //            - orange
    "#7c3aed", //            - purple
  ];

  let selectedSegmentIndex: number = 0;

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

  function addRelaySegment() {
    if (!canAddSegment) return;
    const remaining = totalRelayFrames - usedRelayFrames;
    const updated = [...relaySegments];
    let newFrames: number;

    if (remaining >= MIN_SEGMENT_FRAMES) {
      // Slack is enough — new segment gets capped at MAX, excess stays with last segment
      newFrames = Math.min(MAX_SEGMENT_FRAMES, remaining);
    } else {
      // Not enough slack — steal the shortfall from the last segment
      const needed = MIN_SEGMENT_FRAMES - remaining;
      const lastIdx = updated.length - 1;
      updated[lastIdx] = {
        ...updated[lastIdx],
        frames: updated[lastIdx].frames - needed,
      };
      newFrames = MIN_SEGMENT_FRAMES;
    }

    relaySegments = [...updated, { prompt: "", frames: newFrames }];
    selectedSegmentIndex = relaySegments.length - 1;
  }

  function removeRelaySegment(index: number) {
    if (relaySegments.length <= 1) return;
    let remaining = relaySegments[index].frames;
    let next = relaySegments.filter((_, i) => i !== index).map(s => ({ ...s }));
    // Distribute freed frames across remaining segments, respecting MAX_SEGMENT_FRAMES
    // First pass: fill each segment up to the cap, starting from the neighbour
    const startIdx = index < next.length ? index : next.length - 1;
    const order = [
      ...Array.from({ length: next.length - startIdx }, (_, i) => startIdx + i),
      ...Array.from({ length: startIdx }, (_, i) => startIdx - 1 - i),
    ];
    for (const i of order) {
      if (remaining <= 0) break;
      const canTake = MAX_SEGMENT_FRAMES - next[i].frames;
      const give = Math.min(canTake, remaining);
      next[i].frames += give;
      remaining -= give;
    }
    relaySegments = next;
    selectedSegmentIndex = Math.min(selectedSegmentIndex, next.length - 1);
  }

  function updateRelaySegmentFrames(index: number, value: number) {
    const clamped = Math.max(
      MIN_SEGMENT_FRAMES,
      Math.min(
        MAX_SEGMENT_FRAMES,
        Math.min(
          totalRelayFrames - (relaySegments.length - 1) * MIN_SEGMENT_FRAMES,
          value,
        ),
      ),
    );
    relaySegments = relaySegments.map((s, i) =>
      i === index ? { ...s, frames: clamped } : s,
    );
  }

  function updateRelaySegmentPrompt(index: number, value: string) {
    relaySegments = relaySegments.map((s, i) =>
      i === index ? { ...s, prompt: value } : s,
    );
  }

  // ── Timeline drag logic ──────────────────────────────────────────────────
  let timelineEl: HTMLDivElement;
  let draggingDivider: number | null = null;
  let draggingRightEdge = false;
  let rightEdgeDragStart: { x: number; totalFrames: number } | null = null;

  function onDividerPointerDown(e: PointerEvent, leftIndex: number) {
    if (!isEditable) return;
    e.preventDefault();
    draggingDivider = leftIndex;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onRightEdgePointerDown(e: PointerEvent) {
    if (!isEditable) return;
    e.preventDefault();
    draggingRightEdge = true;
    rightEdgeDragStart = {
      x: e.clientX,
      totalFrames: relaySegments[relaySegments.length - 1].frames,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onTimelinePointerMove(e: PointerEvent) {
    if ((draggingDivider === null && !draggingRightEdge) || !timelineEl) return;
    const rect = timelineEl.getBoundingClientRect();

    if (draggingRightEdge && rightEdgeDragStart) {
      // Delta-based: px -> frames using totalRelayFrames as the reference scale
      const framesPerPx = (totalRelayFrames || 81) / rect.width;
      const deltaFrames = Math.round(
        (e.clientX - rightEdgeDragStart.x) * framesPerPx,
      );
      const otherFrames = relaySegments
        .slice(0, -1)
        .reduce((s, seg) => s + seg.frames, 0);
      const maxLast = Math.min(
        MAX_SEGMENT_FRAMES,
        totalRelayFrames - otherFrames,
      );
      const newLast = Math.max(
        MIN_SEGMENT_FRAMES,
        Math.min(maxLast, rightEdgeDragStart.totalFrames + deltaFrames),
      );
      relaySegments = relaySegments.map((s, i) =>
        i === relaySegments.length - 1 ? { ...s, frames: newLast } : s,
      );
      return;
    }

    if (draggingDivider === null) return;
    const ratio = Math.max(
      0,
      Math.min(1, (e.clientX - rect.left) / rect.width),
    );
    const totalLeft = relaySegments
      .slice(0, draggingDivider + 1)
      .reduce((s, seg) => s + seg.frames, 0);
    const totalRight = relaySegments
      .slice(draggingDivider + 1)
      .reduce((s, seg) => s + seg.frames, 0);
    const combined = totalLeft + totalRight;
    const newLeft = Math.round(ratio * totalRelayFrames);
    const minLeft = draggingDivider * MIN_SEGMENT_FRAMES + MIN_SEGMENT_FRAMES;
    const maxLeft =
      combined -
      (relaySegments.length - draggingDivider - 1) * MIN_SEGMENT_FRAMES;
    const clampedLeft = Math.max(minLeft, Math.min(maxLeft, newLeft));
    const delta = clampedLeft - totalLeft;
    const left = relaySegments[draggingDivider];
    const right = relaySegments[draggingDivider + 1];
    const newLeftFrames = Math.max(
      MIN_SEGMENT_FRAMES,
      Math.min(MAX_SEGMENT_FRAMES, left.frames + delta),
    );
    const newRightFrames = Math.max(
      MIN_SEGMENT_FRAMES,
      Math.min(MAX_SEGMENT_FRAMES, right.frames - delta),
    );
    if (newLeftFrames + newRightFrames !== left.frames + right.frames) return;
    const divIdx = draggingDivider;
    relaySegments = relaySegments.map((s, i) => {
      if (i === divIdx) return { ...s, frames: newLeftFrames };
      if (i === divIdx + 1) return { ...s, frames: newRightFrames };
      return s;
    });
  }

  function onTimelinePointerUp() {
    draggingDivider = null;
    draggingRightEdge = false;
    rightEdgeDragStart = null;
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
        renderPromptEditor();
      } else {
        relayMessage = get(_)("review.relay.aiError");
      }
    } catch (err) {
      relayMessage = get(_)("review.relay.aiError");
    } finally {
      relayGenerating = false;
    }
  }

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
      renderPromptEditor();
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

    // Render the prompt editor (tokenize <Picture N>/<Video 1> into badges)
    renderPromptEditor();
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
    motionScale = undefined;
    freeLongBlendStrength = undefined;
    resetLoraWeights();

    // Reset to default workflow for current type
    const defaultWorkflow = filteredWorkflows.find((w) => w.isDefault);
    if (defaultWorkflow) {
      selectedWorkflowId = defaultWorkflow.id;
    }
  }

  const {
    elements: { root, input, tag, deleteTrigger, edit },
    states: { tags },
    helpers: { addTag },
  } = createTagsInput({
    defaultTags: entry.tags || [],
    unique: true,
    trim: true,
  });

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

  function addNewTag() {
    if (newtag && newtag.trim() !== "") {
      addTag(newtag.trim());
      newtag = "";
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
    <!-- Image Preview Card -->
    <div class="card bg-base-100 shadow-xl">
      <figure class="px-4 pt-4">
        {#if videoWorkflowType === "ref2v"}
          <!-- Ref2V Mode: show ref video (if any) + ref images -->
          {#if entry.additional_options?.ref_video_url}
            <video
              src={entry.additional_options.ref_video_url}
              controls
              muted
              playsinline
              class="rounded-lg max-h-72 w-full object-contain bg-base-200"
            ></video>
          {:else}
            <div class="w-full rounded-lg bg-base-200 py-10 text-center text-sm opacity-70">
              {entry.additional_options?.ref_image_urls?.length
                ? $_("review.ref2v.noRefVideoWithImages")
                : $_("review.ref2v.noRefVideo")}
            </div>
          {/if}
          {#if entry.additional_options?.ref_image_urls?.length}
            <div class="grid grid-cols-3 gap-2 w-full mt-3">
              {#each entry.additional_options.ref_image_urls as refUrl, i}
                <img
                  src={refUrl}
                  alt="ref image {i + 1}"
                  class="rounded-lg max-h-32 object-contain w-full bg-base-200"
                />
              {/each}
            </div>
          {/if}
        {:else if entry.last_image_url}
          <!-- FL2V Mode: Show both images -->
          <div class="grid grid-cols-2 gap-2 w-full">
            <div>
              <p class="text-xs text-center mb-2 font-semibold">
                {$_("review.firstFrame")}
              </p>
              <img
                src={entry.original_image_url}
                alt="first frame"
                class="rounded-lg max-h-64 object-contain w-full"
              />
            </div>
            <div>
              <p class="text-xs text-center mb-2 font-semibold">
                {$_("review.lastFrame")}
              </p>
              <img
                src={entry.last_image_url}
                alt="last frame"
                class="rounded-lg max-h-64 object-contain w-full"
              />
            </div>
          </div>
        {:else}
          <!-- I2V Mode: Show single image -->
          <img
            src={entry.original_image_url}
            alt="preview"
            class="rounded-lg max-h-96 object-contain"
          />
        {/if}
      </figure>
      <div class="card-body">
        <div>
          <h3 class="font-semibold mb-2">{$_("review.tags")}</h3>
          <div class="join w-full">
            <div
              use:melt={$root}
              class="join-item flex flex-wrap gap-2 p-3 border border-base-300 rounded-l-lg bg-base-100 min-h-[3rem] items-center flex-1"
            >
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
                placeholder={$_("review.tagPlaceholder")}
                disabled={!isEditable}
              />
            </div>
            <button
              class="btn btn-primary join-item min-h-[3rem]"
              on:click={addNewTag}
              disabled={!isEditable}>{$_("review.addTag")}</button
            >
          </div>
        </div>
      </div>
    </div>

    <!-- Prompts Card -->
    <div class="card bg-base-100 shadow-xl">
      <div class="card-body">
        <div class="flex justify-between items-center gap-3">
          <h2 class="card-title">{$_("review.aiSuggestions")}</h2>
          {#if !entry.validation_metadata?.manual_recognition_done}
            <button
              class="btn btn-sm btn-outline"
              on:click={runManualAnalysis}
              disabled={!isEditable || analyzing}
            >
              {#if analyzing}
                <span class="loading loading-spinner loading-xs"></span>
                {$_("review.analyzing")}
              {:else}
                {$_("review.analyzeWithCustomVL")}
              {/if}
            </button>
          {/if}
        </div>
        <div class="divider my-2"></div>

        {#if entry.validation_metadata?.manual_recognition_error}
          <div class="alert alert-warning py-2">
            <span class="text-sm">{$_("review.analysisUnavailable")}</span>
          </div>
        {/if}

        {#if entry.suggested_prompts && entry.suggested_prompts.length > 0}
          <div class="space-y-2">
            <h3 class="font-semibold text-sm">
              {$_("review.suggestedPrompts")}
            </h3>
            {#each entry.suggested_prompts as sp, i}
              <button
                class="alert alert-success py-2 cursor-pointer hover:shadow-md transition-shadow w-full text-left"
                on:click={() => { prompt = sp; renderPromptEditor(); }}
                disabled={!isEditable}
              >
                <span class="text-sm">{i + 1}. {sp}</span>
              </button>
            {/each}
          </div>
        {:else}
          <div class="alert">
            <span class="text-sm">{$_("review.noSuggestions")}</span>
          </div>
        {/if}
      </div>
    </div>
  </div>

  <!-- Prompt Input & Generate -->
  <div class="card bg-base-100 shadow-xl">
    <div class="card-body">
      <h2 class="card-title">{$_("review.yourPrompt")}</h2>
      <p class="text-sm opacity-70 mb-2">{$_("review.promptHelp")}</p>

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

      <div class="form-control">
        <label class="label pb-1" for="prompt">
          <span class="label-text text-sm font-medium">
            {promptRelayMode
              ? $_("review.relay.globalPrompt")
              : $_("review.yourPrompt")}
          </span>
        </label>

        {#if videoWorkflowType === "ref2v" && refItems.length > 0}
          <!-- Ref2V reference editor: tokens render as inline badges, and a "+"
               button opens a picker of all refs (referenced or not) to insert at
               the cursor. Refs may be used multiple times. -->
          <div class="flex flex-wrap items-center gap-2 mb-2">
            <span class="text-xs opacity-70">{$_("review.ref2v.referencesLabel")}</span>

            <!-- "+" button opens the picker of all refs. mousedown|preventDefault
                 keeps focus in the prompt editor so the browser never stores a
                 pre-blur selection that would later restore the caret before the
                 inserted badge. -->
            <details class="dropdown dropdown-end">
              <summary
                class="btn btn-xs btn-outline btn-circle"
                aria-label={$_("review.ref2v.addReference")}
                on:mousedown|preventDefault
              >+</summary>
              <ul
                class="menu dropdown-content bg-base-200 rounded-box z-10 w-56 max-h-64 overflow-y-auto p-1 shadow"
              >
                {#if availableRefs.length > 1}
                  <li>
                    <button
                      type="button"
                      class="flex items-center gap-2 text-xs font-semibold"
                      on:mousedown|preventDefault
                      on:click={() => { insertAllRefTokens(); }}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
                      {$_("review.ref2v.addAllReferences")}
                    </button>
                  </li>
                  <li class="menu-title"><span class="text-xs opacity-50">{$_("review.ref2v.referencesLabel")}</span></li>
                {/if}
                {#each refItems as ref (ref.token)}
                  <li>
                    <button
                      type="button"
                      class="flex items-center gap-2 text-sm"
                      on:mousedown|preventDefault
                      on:click={() => { insertRefToken(ref.token); }}
                    >
                      {#if referencedTokens.includes(ref.token)}
                        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-success shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                      {/if}
                      {#if ref.kind === "video"}
                        <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>
                      {:else}
                        <img src={ref.url} alt={ref.label} class="w-8 h-8 rounded object-cover shrink-0" />
                      {/if}
                      <span>{ref.label}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            </details>

            {#if availableRefs.length > 0}
              <span class="text-xs text-warning">
                {$_("review.ref2v.unreferencedHint", { values: { count: availableRefs.length } })}
              </span>
            {:else}
              <span class="text-xs text-success">{$_("review.ref2v.allReferencesUsedShort")}</span>
            {/if}
            <span class="text-xs opacity-50">{$_("review.ref2v.referencesHint")}</span>
          </div>
        {/if}

        <div
          id="prompt"
          contenteditable={isEditable}
          tabindex="0"
          class="textarea textarea-bordered textarea-lg min-h-32 w-full whitespace-pre-wrap"
          role="textbox"
          aria-multiline="true"
          aria-label={$_("review.yourPrompt")}
          bind:this={promptEditor}
          on:input={onEditorInput}
          on:keyup={() => (promptCursor = getEditorCaretOffset())}
          on:click={() => (promptCursor = getEditorCaretOffset())}
          on:focus={() => (promptCursor = getEditorCaretOffset())}
          on:compositionstart={() => (composing = true)}
          on:compositionend={() => {
            composing = false;
            onEditorInput();
          }}
          on:paste={(e) => {
            // Normalize pasted text (strip HTML so tokens stay plain text,
            // and convert newlines to <br> so the DOM stays text+br+badges)
            e.preventDefault();
            const text = e.clipboardData?.getData('text/plain') || '';
            const lines = text.split('\n');
            lines.forEach((line, i) => {
              if (i > 0) insertLineBreakAtCaret();
              if (line) document.execCommand('insertText', false, line);
            });
            onEditorInput();
          }}
          on:keydown={(e) => {
            // Enter must insert a single bare <br> (with the caret after it)
            // instead of the browser's default <div> block, so the DOM stays
            // text+br+badges and the DOM walker stays exact.
            if (e.key === 'Enter' && isEditable) {
              e.preventDefault();
              insertLineBreakAtCaret();
            }
          }}
        ></div>
      </div>

      <!-- Prompt Relay Segments -->
      {#if promptRelayMode}
        <div class="mt-4 space-y-3">
          <div class="flex items-center justify-between">
            <h3 class="font-semibold text-sm">{$_("review.relay.segments")}</h3>
            <button
              class="btn btn-ghost btn-xs"
              on:click={generateRelayWithAI}
              disabled={!isEditable || relayGenerating}
            >
              {relayGenerating
                ? $_("review.relay.generating")
                : $_("review.relay.generateWithAI")}
            </button>
          </div>

          {#if relayMessage}
            <div
              class="alert py-2 text-sm {relayMessage.includes('failed') ||
              relayMessage.includes('error')
                ? 'alert-error'
                : 'alert-success'}"
            >
              {relayMessage}
            </div>
          {/if}

          <!-- Total frames selector -->
          <div class="flex items-center gap-2 flex-wrap mb-1">
            <span class="text-xs opacity-50"
              >{$_("review.relay.totalFrames")}:</span
            >
            {#each [81, 121, ...(hasAdvancedFeatures ? [177] : [])] as preset}
              <button
                class="btn btn-xs {totalRelayFrames === preset
                  ? 'btn-primary'
                  : 'btn-outline'}"
                on:click={() => (totalRelayFrames = preset)}
                disabled={!isEditable}
                >{(preset / 18).toFixed(1)}s ({preset}f)</button
              >
            {/each}
            <span class="text-xs opacity-40">|</span>
            <span class="text-xs opacity-50"
              >{$_("review.relay.customFrames")}:</span
            >
            <input
              type="number"
              class="input input-bordered input-xs w-24"
              bind:value={totalRelayFrames}
              min={81}
              max={maxRelayFrames}
              step={4}
              on:blur={() => {
                totalRelayFrames = Math.max(
                  81,
                  Math.min(maxRelayFrames, roundTo4n1(totalRelayFrames)),
                );
              }}
              disabled={!isEditable}
            />
            <span class="text-xs opacity-40">≤{maxRelayFrames}f</span>
          </div>

          <!-- Timeline bar -->
          <div
            class="relative w-full select-none"
            bind:this={timelineEl}
            on:pointermove={onTimelinePointerMove}
            on:pointerup={onTimelinePointerUp}
            on:pointercancel={onTimelinePointerUp}
            role="group"
            aria-label="Segment timeline"
          >
            <!-- Track: 100% = totalRelayFrames; colored segments + gray unused remainder -->
            <div
              class="flex h-14 w-full rounded-lg overflow-hidden border border-base-300 cursor-pointer"
            >
              {#each relaySegments as seg, i}
                {@const pct = (seg.frames / (totalRelayFrames || 81)) * 100}
                {@const color =
                  SEGMENT_COLORS_HEX[i % SEGMENT_COLORS_HEX.length]}
                {@const isSelected = selectedSegmentIndex === i}
                <div
                  class="relative flex flex-col items-center justify-center h-full overflow-hidden transition-all"
                  style="width:{pct}%; background-color:{color}; opacity:{isSelected
                    ? 1
                    : 0.65}; outline:{isSelected
                    ? '2px solid white'
                    : 'none'}; outline-offset:'-2px';"
                  on:click={() => (selectedSegmentIndex = i)}
                  role="button"
                  tabindex="0"
                  on:keydown={(e) =>
                    e.key === "Enter" && (selectedSegmentIndex = i)}
                  aria-label="Segment {i + 1}"
                >
                  <span
                    class="text-white font-bold text-xs drop-shadow pointer-events-none truncate px-1 max-w-full"
                  >
                    {i + 1}
                  </span>
                  <span
                    class="text-white text-[10px] opacity-80 drop-shadow pointer-events-none"
                  >
                    {(seg.frames / 18).toFixed(1)}s
                  </span>
                  {#if seg.prompt}
                    <span
                      class="text-white text-[9px] opacity-60 drop-shadow pointer-events-none truncate px-1 max-w-full leading-tight mt-0.5"
                    >
                      {seg.prompt}
                    </span>
                  {/if}
                </div>
                <!-- Drag divider between segments -->
                {#if i < relaySegments.length - 1}
                  <div
                    class="absolute top-0 h-full w-3 -translate-x-1/2 flex items-center justify-center z-10 group"
                    style="left:{(relaySegments
                      .slice(0, i + 1)
                      .reduce((s, x) => s + x.frames, 0) /
                      (totalRelayFrames || 81)) *
                      100}%;"
                    role="separator"
                    aria-label="Drag to resize"
                    on:pointerdown={(e) => onDividerPointerDown(e, i)}
                    style:cursor={isEditable ? "col-resize" : "default"}
                  >
                    <div
                      class="w-1 h-full bg-white opacity-60 group-hover:opacity-100 group-active:opacity-100 transition-opacity rounded-full pointer-events-none"
                    ></div>
                  </div>
                {/if}
              {/each}
              <!-- Gray unused remainder -->
              {#if usedRelayFrames < totalRelayFrames}
                <div
                  class="h-full flex-1 opacity-20"
                  style="background:repeating-linear-gradient(45deg,#888 0,#888 2px,transparent 2px,transparent 8px);"
                ></div>
              {/if}
            </div>

            <!-- Right-edge handle: sits at usedRelayFrames boundary, resizes last segment only -->
            {#if isEditable}
              {@const edgePct =
                (usedRelayFrames / (totalRelayFrames || 81)) * 100}
              <div
                class="absolute top-0 h-14 w-5 -translate-x-1/2 flex items-center justify-center z-20 group"
                style="left:{edgePct}%;"
                role="separator"
                aria-label="Drag to resize last segment"
                on:pointerdown={onRightEdgePointerDown}
                style:cursor="col-resize"
              >
                <div
                  class="pointer-events-none h-10 w-3 rounded-sm flex flex-col items-center justify-center
                            border-2 border-base-content opacity-40 group-hover:opacity-90 group-active:opacity-100 transition-opacity
                            bg-base-100"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    class="w-2 h-3"
                    viewBox="0 0 8 12"
                    fill="currentColor"
                  >
                    <path d="M4 0L1 3h6L4 0zM4 12L1 9h6L4 12z" />
                  </svg>
                </div>
              </div>
            {/if}
          </div>

          <!-- ── Selected segment editor ──────────────────────────────────── -->
          {#each relaySegments as seg, i}
            {#if selectedSegmentIndex === i}
              <div
                class="rounded-xl border-2 p-3 space-y-2 transition-all"
                style="border-color:{SEGMENT_COLORS_HEX[
                  i % SEGMENT_COLORS_HEX.length
                ]}22; background-color:{SEGMENT_COLORS_HEX[
                  i % SEGMENT_COLORS_HEX.length
                ]}0d;"
              >
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-2">
                    <span
                      class="inline-block w-3 h-3 rounded-full flex-shrink-0"
                      style="background:{SEGMENT_COLORS_HEX[
                        i % SEGMENT_COLORS_HEX.length
                      ]};"
                    ></span>
                    <span class="font-semibold text-sm"
                      >{$_("review.relay.segments")} {i + 1}</span
                    >
                    <span class="text-xs opacity-50"
                      >{seg.frames}
                      {$_("review.relay.frames")} · {(seg.frames / 18).toFixed(
                        1,
                      )}s</span
                    >
                  </div>
                  <div class="flex items-center gap-1">
                    <!-- Add segment button -->
                    {#if relaySegments.length < 10 && seg.frames > 18}
                      <button
                        class="btn btn-ghost btn-xs"
                        title="Split segment"
                        on:click={() => {
                          const half = Math.floor(seg.frames / 2);
                          const other = seg.frames - half;
                          relaySegments = [
                            ...relaySegments
                              .slice(0, i + 1)
                              .map((s, j) =>
                                j === i ? { ...s, frames: half } : s,
                              ),
                            { prompt: "", frames: other },
                            ...relaySegments.slice(i + 1),
                          ];
                        }}
                        disabled={!isEditable}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          class="h-3.5 w-3.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"><path d="M12 3v18M3 12h18" /></svg
                        >
                        {$_("review.relay.splitSegment")}
                      </button>
                    {/if}
                    <button
                      class="btn btn-ghost btn-xs text-error"
                      on:click={() => removeRelaySegment(i)}
                      disabled={!isEditable || relaySegments.length <= 1}
                      >{$_("review.relay.removeSegment")}</button
                    >
                  </div>
                </div>
                <textarea
                  value={seg.prompt}
                  on:input={(e) =>
                    updateRelaySegmentPrompt(i, e.currentTarget.value)}
                  placeholder={$_("review.promptPlaceholder")}
                  class="textarea textarea-bordered textarea-sm h-20 w-full text-sm"
                  disabled={!isEditable}
                  maxlength={500}
                ></textarea>
                <!-- Manual frame nudge -->
                <div class="flex items-center gap-2 text-xs">
                  <span class="opacity-50">{$_("review.relay.frames")}:</span>
                  <button
                    class="btn btn-ghost btn-xs px-1"
                    on:click={() => updateRelaySegmentFrames(i, seg.frames - 1)}
                    disabled={!isEditable || seg.frames <= MIN_SEGMENT_FRAMES}
                    >−</button
                  >
                  <span class="font-mono w-8 text-center">{seg.frames}</span>
                  <button
                    class="btn btn-ghost btn-xs px-1"
                    on:click={() => updateRelaySegmentFrames(i, seg.frames + 1)}
                    disabled={!isEditable ||
                      usedRelayFrames >= totalRelayFrames ||
                      seg.frames >= MAX_SEGMENT_FRAMES}>+</button
                  >
                </div>
              </div>
            {/if}
          {/each}

          <!-- Add segment / frame tally -->
          <div class="flex items-center justify-between text-xs">
            <button
              class="btn btn-outline btn-xs gap-1"
              on:click={addRelaySegment}
              disabled={!isEditable || !canAddSegment}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                class="h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"><path d="M12 5v14M5 12h14" /></svg
              >
              {$_("review.relay.addSegment")}
            </button>
            <span
              class:text-error={!relayFramesValid}
              class:text-success={relayFramesValid}
              class="opacity-70"
            >
              {$_("review.relay.framesUsed", {
                values: { used: usedRelayFrames, total: totalRelayFrames },
              })}
              {#if !relayFramesValid}
                &nbsp;— {$_("review.relay.frameMismatch", {
                  values: { total: totalRelayFrames },
                })}
              {/if}
            </span>
            {#if !relaySegmentFramesValid}
              <span class="text-error opacity-70">
                {$_("review.relay.segmentFramesInvalid")}
              </span>
            {/if}
            {#if !relaySegmentPromptsValid}
              <span class="text-error opacity-70">
                {$_("review.relay.segmentPromptRequired")}
              </span>
            {/if}
          </div>
        </div>
      {/if}

      <!-- Advanced Settings -->
      <div class="divider mt-6 mb-2"></div>
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
              {#if canUseQuality}
                <input
                  type="range"
                  min={4}
                  max={10}
                  step={2}
                  bind:value={videoDuration}
                  on:input={(e) => setVideoDuration(+e.currentTarget.value)}
                  disabled={!isEditable}
                  class="range range-primary range-sm w-full"
                />
                <div class="flex justify-between px-1 text-xs">
                  {#each durationTicks as tick}
                    <button
                      type="button"
                      class="flex flex-col items-center gap-0.5 select-none"
                      class:opacity-40={!tick.allowed}
                      class:font-bold={videoDuration === tick.value}
                      class:text-primary={videoDuration === tick.value}
                      on:click={() => setVideoDuration(tick.value)}
                      disabled={!isEditable || !tick.allowed}
                    >
                      <span>{tick.value}s</span>
                      {#if tick.premium}
                        <span class="badge badge-xs badge-warning"
                          >{$_("review.paidOnly")}</span
                        >
                      {/if}
                    </button>
                  {/each}
                </div>
                {#if currentDurationOption}
                  <p class="text-sm opacity-70">
                    {currentDurationOption.label} — {currentDurationOption.description}
                  </p>
                {/if}
              {:else}
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {#each durationOptions as option}
                    <label
                      class="btn btn-outline flex items-center gap-3 justify-start"
                      class:btn-active={videoDuration === option.value}
                    >
                      <input
                        type="radio"
                        name="video-duration"
                        value={option.value}
                        checked={videoDuration === option.value}
                        on:change={() => (videoDuration = option.value)}
                        disabled={!isEditable}
                      />
                      <div>
                        <div class="font-semibold">{option.label}</div>
                        <div class="text-xs opacity-70">{option.description}</div>
                      </div>
                    </label>
                  {/each}
                </div>
              {/if}
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

      <div class="card-actions justify-between mt-4">
        <button
          class="btn btn-error btn-outline"
          on:click={deleteVideo}
          disabled={entry.status === "processing" ||
            entry.status === "in_queue"}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
            />
          </svg>
          {$_("common.delete")}
        </button>
        <div class="flex gap-2 flex-col sm:flex-row sm:items-center">
          {#if !quotaLoading && quotaRemaining !== null}
            {#if quotaLimit === 0}
              <div class="badge badge-lg badge-error">
                {$_("review.quotaNoAccess")}
              </div>
            {:else}
              <div
                class="badge badge-lg"
                class:badge-error={quotaRemaining < selectedWorkflowQuotaCost}
                class:badge-warning={quotaRemaining >= selectedWorkflowQuotaCost && quotaRemaining < 3}
                class:badge-success={quotaRemaining >= 3}
                title={selectedWorkflowQuotaCost > 1
                  ? $_("review.quotaCost", { values: { cost: selectedWorkflowQuotaCost } })
                  : undefined}
              >
                {$_("review.quotaRemaining", {
                  values: { count: quotaRemaining },
                })}
              </div>
            {/if}
          {/if}
          {#if entry.status === "failed"}
            <button class="btn btn-warning btn-lg" on:click={retryGeneration}>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                class="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              {$_("review.retryGeneration")}
            </button>
          {:else if entry.status === "deleted"}
            <div class="alert alert-info">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                class="stroke-current shrink-0 h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <span>{$_("review.videoDeleted")}</span>
            </div>
          {:else}
            {#if entry.is_nsfw && entry.is_photo_realistic}
              <div class="alert alert-error mb-4">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  class="stroke-current shrink-0 h-6 w-6"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <div>
                  <h3 class="font-bold">
                    {$_("review.warnings.nsfwRealistic.title")}
                  </h3>
                  <div class="text-sm">
                    {$_("review.warnings.nsfwRealistic.message")}
                  </div>
                </div>
              </div>
            {/if}
            <button
              class="btn btn-primary btn-lg"
              on:click={generate}
              disabled={busy ||
                entry.status === "processing" ||
                entry.status === "in_queue" ||
                (quotaRemaining !== null && quotaRemaining < selectedWorkflowQuotaCost) ||
                (promptRelayMode && !relayFramesValid) ||
                (promptRelayMode && !relaySegmentFramesValid) ||
                (promptRelayMode && !relaySegmentPromptsValid)}
            >
              {#if busy}
                <span class="loading loading-spinner"></span>
                {$_("review.submitting")}
              {:else if entry.status === "processing" || entry.status === "in_queue"}
                <span class="loading loading-spinner"></span>
                {entry.status === "in_queue"
                  ? $_("review.queued")
                  : $_("review.processing")}
              {:else}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  class="h-6 w-6"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
                  />
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                {$_("review.generateVideo")}
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
      {#if limitType === "user"}
        <h3 class="font-bold text-2xl mb-4">{$_("review.quotaLimit.title")}</h3>
        <div class="flex justify-center mb-4">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-32 w-32 text-warning"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </div>
        <p class="text-lg mb-4">
          {busyModalMessage}
        </p>
        <p class="text-base mb-6 opacity-80">
          {$_("review.quotaLimit.message")}
        </p>
        <div class="modal-action">
          <button class="btn btn-ghost" on:click={() => (showBusyModal = false)}
            >{$_("common.cancel")}</button
          >
          <a
            href={sponsorUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="btn btn-primary"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            {$_("review.quotaLimit.sponsorButton")}
          </a>
        </div>
      {:else}
        <h3 class="font-bold text-2xl mb-4">{$_("review.serverBusy.title")}</h3>
        <div class="flex justify-center mb-4">
          <img
            src="/images/BUSY.jpg"
            alt="Server Busy"
            class="rounded-lg max-w-full max-h-96 object-contain"
          />
        </div>
        <p class="text-lg mb-4">
          {busyModalMessage}
        </p>
        <div class="modal-action">
          <button
            class="btn btn-primary"
            on:click={() => (showBusyModal = false)}
            >{$_("review.serverBusy.okButton")}</button
          >
        </div>
      {/if}
    </div>
  </div>
{/if}
