<script lang="ts">
  /**
   * Ref2V quick prompts — one-line intents referencing the uploaded refs.
   * The ✨ enhancer expands each into the full structured H3 format.
   * Hidden when no refs at all; shows disabled states when video missing.
   */
  import { _ } from "svelte-i18n";

  export let refItems: { kind: "video" | "audio" | "image"; token: string; url: string; label: string }[] = [];
  export let isEditable: boolean = true;
  export let onSelect: (newPrompt: string) => void = () => {};

  $: hasVideo = refItems.some((r) => r.kind === "video");
  $: picCount = refItems.filter((r) => r.kind === "image").length;

  // Hide entirely when there is no source video – all current presets are video-editing tasks.
  // Showing a grid of disabled buttons when no video was uploaded wastes space and confuses users.

  function P(n: number) { return `<Picture ${n}>`; }
  const V = "<Video 1>";

  interface Preset {
    id: string;
    icon: string;
    titleKey: string;
    descKey: string;
    needsVideo: boolean;
    minPics: number;
    /** Simple one-line intent — the ✨ enhancer expands it into the full
     *  structured H3 prompt (subject definitions, shot plan, soundscape). */
    prompt: string;
  }

  const presets: Preset[] = [
    {
      id: "replace_person",
      icon: "🧑‍🎤",
      titleKey: "review.ref2v.presets.replacePerson.title",
      descKey: "review.ref2v.presets.replacePerson.desc",
      needsVideo: true,
      minPics: 1,
      prompt:
        "Replace the person in <Video 1> with the person from <Picture 1>, keeping the motion, actions, camera movement and environment of <Video 1>.",
    },
    {
      id: "face_swap",
      icon: "🎭",
      titleKey: "review.ref2v.presets.faceSwap.title",
      descKey: "review.ref2v.presets.faceSwap.desc",
      needsVideo: true,
      minPics: 1,
      prompt:
        "Swap the face of the person in <Video 1> with the face from <Picture 1>, keeping the body, clothing, motion and environment of <Video 1>.",
    },
    {
      id: "outfit_change",
      icon: "👗",
      titleKey: "review.ref2v.presets.outfit.title",
      descKey: "review.ref2v.presets.outfit.desc",
      needsVideo: true,
      minPics: 1,
      prompt:
        "Change the clothing of the person in <Video 1> to match the outfit in <Picture 1>, keeping everything else identical.",
    },
    {
      id: "background_replace",
      icon: "🏞️",
      titleKey: "review.ref2v.presets.bgReplace.title",
      descKey: "review.ref2v.presets.bgReplace.desc",
      needsVideo: true,
      minPics: 1,
      prompt:
        "Replace the background of <Video 1> with the scene from <Picture 1>, keeping the person and their motion from <Video 1> unchanged.",
    },
    {
      id: "two_people",
      icon: "👥",
      titleKey: "review.ref2v.presets.twoPeople.title",
      descKey: "review.ref2v.presets.twoPeople.desc",
      needsVideo: true,
      minPics: 2,
      prompt:
        "Place the people from <Picture 1> and <Picture 2> into <Video 1>'s environment with natural interaction, following its camera movement and timing.",
    },
    {
      id: "object_insert",
      icon: "📦",
      titleKey: "review.ref2v.presets.object.title",
      descKey: "review.ref2v.presets.object.desc",
      needsVideo: true,
      minPics: 1,
      prompt:
        "The person in <Video 1> now holds and uses the object from <Picture 1>, keeping <Video 1>'s environment and camera unchanged.",
    },
    {
      id: "style_transfer",
      icon: "🎨",
      titleKey: "review.ref2v.presets.style.title",
      descKey: "review.ref2v.presets.style.desc",
      needsVideo: true,
      minPics: 1,
      prompt:
        "Apply the art style of <Picture 1> to <Video 1>, preserving its motion, camera, composition and timing.",
    },
    {
      id: "add_companion",
      icon: "🤝",
      titleKey: "review.ref2v.presets.addCompanion.title",
      descKey: "review.ref2v.presets.addCompanion.desc",
      needsVideo: true,
      minPics: 1,
      prompt:
        "Add the person from <Picture 1> as a companion beside the person in <Video 1>, with natural interaction, keeping <Video 1>'s environment and camera.",
    },
  ];

  function isDisabled(p: Preset): boolean {
    if (!isEditable) return true;
    if (p.needsVideo && !hasVideo) return true;
    if (picCount < p.minPics) return true;
    return false;
  }

  $: usableCount = presets.filter((p) => !isDisabled(p)).length;

  let detailsEl: HTMLDetailsElement | undefined;

  function closeDropdown() {
    if (detailsEl) detailsEl.removeAttribute("open");
  }

  function handleSelect(p: Preset) {
    if (isDisabled(p)) return;
    onSelect(p.prompt);
    closeDropdown();
  }
</script>

{#if hasVideo}
  <div class="w-full mb-3">
    <div class="flex items-center gap-2 mb-2">
      <details bind:this={detailsEl} class="dropdown w-full">
        <summary class="btn btn-sm btn-outline gap-1.5 w-full justify-between">
          <span class="flex items-center gap-1.5">
            <span>⚡</span>
            <span>{$_("review.ref2v.presets.title")}</span>
            <span class="badge badge-xs badge-ghost">{usableCount}</span>
          </span>
          <span class="flex items-center gap-2">
            <span class="text-xs opacity-50 hidden sm:inline">{$_("review.ref2v.presets.hint")}</span>
            <svg class="w-3 h-3 opacity-60" viewBox="0 0 20 20" fill="currentColor"><path d="M5.5 7l4.5 4 4.5-4z" /></svg>
          </span>
        </summary>
        <ul class="menu dropdown-content bg-base-200 rounded-box z-20 w-full max-h-[28rem] overflow-y-auto p-2 shadow-lg mt-1 left-0 right-0 grid grid-cols-1 sm:grid-cols-2 gap-1">
          {#each presets as preset}
            {@const disabled = isDisabled(preset)}
            <li>
              <button
                type="button"
                class="flex gap-2 items-start text-left py-2.5 px-2 rounded-lg hover:bg-base-300"
                class:opacity-40={disabled}
                disabled={disabled}
                on:click={() => handleSelect(preset)}
              >
                <span class="text-base leading-none mt-0.5 shrink-0">{preset.icon}</span>
                <span class="flex flex-col min-w-0 flex-1">
                  <span class="font-semibold text-xs sm:text-[13px] leading-tight">{$_(preset.titleKey)}</span>
                  <span class="text-[11px] sm:text-xs opacity-70 leading-snug normal-case font-normal whitespace-normal line-clamp-3">{$_(preset.descKey)}</span>
                  <span class="text-[10px] opacity-50 font-mono mt-0.5">
                    {V} + {Array.from({ length: preset.minPics }, (_, i) => P(i + 1)).join(" + ")}
                  </span>
                </span>
                {#if disabled}
                  <span class="badge badge-xs badge-ghost shrink-0 ml-auto">
                    {$_("review.ref2v.presets.needImages", { values: { count: preset.minPics } })}
                  </span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      </details>
    </div>
  </div>
{/if}
