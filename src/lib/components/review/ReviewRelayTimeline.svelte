<script lang="ts">
  // Prompt Relay segments UI: frame selector, draggable timeline, per-segment
  // editor. All relay segment state/logic lives here; the parent binds
  // relaySegments / totalRelayFrames / selectedSegmentIndex.
  import { _ } from "svelte-i18n";

  export let isEditable: boolean = true;
  export let hasAdvancedFeatures: boolean = false;
  export let relayGenerating: boolean = false;
  export let relayMessage: string = "";
  export let totalRelayFrames: number = 81;
  export let relaySegments: { prompt: string; frames: number }[] = [];
  export let generateRelayWithAI: () => void = () => {};
  // Computed by the parent (also needed for the generate button) and passed in:
  export let usedRelayFrames: number = 0;
  export let relayFramesValid: boolean = true;
  export let relaySegmentFramesValid: boolean = true;
  export let relaySegmentPromptsValid: boolean = true;
  export let canAddSegment: boolean = false;

  let selectedSegmentIndex: number = 0;

  const MAX_SEGMENT_FRAMES = 121;
  const MIN_SEGMENT_FRAMES = 9;

  // Max total relay frames based on user tier (free: 121, advanced: 177)
  $: maxRelayFrames = hasAdvancedFeatures ? 177 : 121;

  // Helper: snap n to nearest valid 4n+1 value
  function roundTo4n1(n: number): number {
    return Math.round((n - 1) / 4) * 4 + 1;
  }

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
</script>

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
