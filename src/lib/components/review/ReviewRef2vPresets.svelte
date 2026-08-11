<script lang="ts">
  /**
   * Ref2V quick prompts — FULL H3 ref-en.txt format dropdown.
   * Hidden when no refs at all; shows disabled states when video missing.
   */
  import { _ } from "svelte-i18n";

  export let refItems: { kind: "video" | "image"; token: string; url: string; label: string }[] = [];
  export let isEditable: boolean = true;
  /** Output video duration in seconds — used to place cut times in detailed_description. */
  export let videoDuration: number = 4;
  export let onSelect: (newPrompt: string) => void = () => {};

  $: hasVideo = refItems.some((r) => r.kind === "video");
  $: picCount = refItems.filter((r) => r.kind === "image").length;

  // Hide entirely when there is no source video – all current presets are video-editing tasks.
  // Showing a grid of disabled buttons when no video was uploaded wastes space and confuses users.

  function P(n: number) { return `<Picture ${n}>`; }
  const V = "<Video 1>";
  const S = (n: number) => `<Subject ${n}>`;

  interface Preset {
    id: string;
    icon: string;
    titleKey: string;
    descKey: string;
    needsVideo: boolean;
    minPics: number;
    build: (opts: { hasVideo: boolean; picCount: number; duration: number }) => string;
  }

  const presets: Preset[] = [
    {
      id: "replace_person",
      icon: "🧑‍🎤",
      titleKey: "review.ref2v.presets.replacePerson.title",
      descKey: "review.ref2v.presets.replacePerson.desc",
      needsVideo: true,
      minPics: 1,
      build: ({ hasVideo, picCount, duration }) => {
        const v = hasVideo;
        // Split the shot plan so cut times fall within the requested duration.
        const dur = Math.max(1, Math.round(duration) || 4);
        const cut1 = Math.max(1, Math.round(dur * 0.4));
        const cut2 = Math.max(cut1 + 1, Math.round(dur * 0.7));
        const fmt = (s: number) =>
          `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.000`;
        return `subject_definitions:
${S(1)} is the person whose appearance, face, hairstyle, clothing and body proportions come from ${P(1)} and whose motion, body actions and spatial trajectory come from ${v ? V : P(1)}.
${S(2)} is the environment, camera path and lighting from ${v ? V : P(1)}.
${v ? `${V} is the source video for the target video edit.` : `${P(1)} is the first frame of [Shot 1].`}
${picCount >= 2 ? `${P(2)} 不适用。` : ""}

summary:
[reference generation + video editing] The target video is an edited version of ${v ? V : P(1)}. ${S(1)} replaces the original person in ${v ? V : P(1)} while preserving the motion, actions, camera movement and environment of ${v ? V : P(1)}.

retention_analysis:
${S(1)} (appears in [Shot 1], [Shot 2], [Shot 3]): attribute_transfer - the appearance from ${P(1)} is transferred onto the person from ${v ? V : P(1)}, with full body proportions, clothing, face, hairstyle and skin tone preserved from ${P(1)}.
${S(2)} (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - environment, camera movement, lighting and timing preserved.
${v ? `${V} (motion and environment): fully_preserved - camera cuts, pacing and background kept.` : ""}

detailed_description:
The target video is in a live-action, cinematic style with natural lighting and a realistic color palette. ${S(1)} is centered in the scene, with the detailed facial features, hairstyle and outfit from ${P(1)} shown clearly at every appearance.
[Shot 1] A medium shot frames ${S(1)} standing in the scene, whose appearance comes from ${P(1)} with detailed facial features, hairstyle and outfit retained. The camera remains locked to ${v ? V : P(1)}'s original camera path and tracks ${S(1)} as they perform the same actions from ${v ? V : P(1)} — walking, turning and gestures — with realistic contact, occlusion and scale. ${S(2)}, the background and lighting from ${v ? V : P(1)}, stays fully preserved with consistent perspective. ${S(1)}'s hands and feet make natural contact with the environment exactly as in the source, and their silhouette, height and gait match the original subject so the replacement is seamless.
[Shot 2] At ${fmt(cut1)}, the shot transitions to a close-up of ${S(1)}'s face, showing the hairstyle, eye color, skin tone and expression from ${P(1)}. The camera pushes in with small amplitude at slow speed, following ${S(1)}'s head movement from ${v ? V : P(1)}. ${S(2)} remains visible as a softly blurred background, preserving the original scene's depth and color grade.
[Shot 3] At ${fmt(cut2)}, the shot cuts back to a medium-wide view of ${S(1)} completing the final action from ${v ? V : P(1)}. The camera holds ${v ? V : P(1)}'s ending framing as ${S(1)} exits the frame or settles into the final pose, with ${S(2)} fully preserved and the original lighting intact.

overall_soundscape:
Natural environment tone from the original scene continues throughout. Light footsteps, fabric movement and subtle room ambience match the source ${v ? V : "recording"}.

non_diegetic_music:
N/A`;
      }
    },
    {
      id: "face_swap",
      icon: "🎭",
      titleKey: "review.ref2v.presets.faceSwap.title",
      descKey: "review.ref2v.presets.faceSwap.desc",
      needsVideo: true,
      minPics: 1,
      build: () => `subject_definitions:
${S(1)} is the person whose facial identity comes from ${P(1)} and whose body, clothing, motion and spatial actions come from ${V}.
${S(2)} is the environment and camera movement from ${V}.
${V} is the source video for the target video edit.

summary:
[reference generation + video editing] The target video is an edited version of ${V}. ${S(1)} keeps the original body and motion from ${V} but facial identity comes from ${P(1)}.

retention_analysis:
${S(1)} (appears in [Shot 1]): attribute_transfer - face from ${P(1)} transferred onto ${V} body, aligning head pose, gaze and expression from ${V}, with natural skin blending.
${S(2)} (appears in [Shot 1]): fully_preserved - background, camera and lighting from ${V} retained.
${V} (body motion and camera): fully_preserved - torso, limbs, clothing and scene preserved.

detailed_description:
The target video is in a realistic, live-action, close-up to medium-shot style.
[Shot 1] A medium close-up frames ${S(1)}, whose body and clothing come from ${V} and whose face comes from ${P(1)}. The camera lightly pushes in with small amplitude at slow speed, following ${S(1)}'s head orientation from ${V}. ${S(1)}'s facial features, skin tone and hairline match ${P(1)} while head pose and expression track ${V}. ${S(2)} remains fully preserved behind the subject.

overall_soundscape:
Quiet indoor room tone continues with subtle breathing and fabric rustle.

non_diegetic_music:
N/A`
    },
    {
      id: "outfit_change",
      icon: "👗",
      titleKey: "review.ref2v.presets.outfit.title",
      descKey: "review.ref2v.presets.outfit.desc",
      needsVideo: true,
      minPics: 1,
      build: () => `subject_definitions:
${S(1)} is the person in ${V}, retaining face, hair, body and motion from ${V}.
${S(2)} is the clothing style whose appearance comes from ${P(1)}.
${S(3)} is the environment and camera movement from ${V}.
${V} is the source video for the target video edit.

summary:
[reference generation + video editing] The target video is an edited version of ${V}. ${S(1)} keeps original identity and motion, only the garment changes to match ${S(2)} from ${P(1)}.

retention_analysis:
${S(1)} (appears in [Shot 1]): fully_preserved - face, hair, body proportions and motion from ${V} retained.
${S(2)} (appears in [Shot 1]): attribute_transfer - clothing from ${P(1)} transferred onto ${S(1)}, same garment type, color, fabric and fit.
${S(3)} (appears in [Shot 1]): fully_preserved - background and camera from ${V} retained.

detailed_description:
The target video is in a live-action, cinematic style with soft natural light.
[Shot 1] A medium shot frames ${S(1)}, the person from ${V}, standing in the original pose. The camera holds a static shot while ${S(1)} performs the same actions from ${V}. ${S(2)}, the clothing from ${P(1)}, appears on ${S(1)} with accurate tailoring, wrinkles during motion and proper occlusions when arms cross. ${S(3)}, the environment from ${V}, stays unchanged.

overall_soundscape:
Ambient room tone continues with light clothing rustle and footsteps.

non_diegetic_music:
N/A`
    },
    {
      id: "background_replace",
      icon: "🏞️",
      titleKey: "review.ref2v.presets.bgReplace.title",
      descKey: "review.ref2v.presets.bgReplace.desc",
      needsVideo: true,
      minPics: 1,
      build: () => `subject_definitions:
${S(1)} is the person whose appearance, motion and actions come from ${V}.
${S(2)} is the environment whose appearance comes from ${P(1)}.
${V} is the source video for the target video edit.

summary:
[reference generation + video editing] The target video is an edited version of ${V}. ${S(1)} is fully preserved from ${V} while the background is replaced by ${S(2)} from ${P(1)}.

retention_analysis:
${S(1)} (appears in [Shot 1]): fully_preserved - appearance and motion from ${V} retained.
${S(2)} (appears in [Shot 1]): fully_preserved - scene layout, architecture, lighting direction and depth from ${P(1)} retained.

detailed_description:
The target video is in a live-action, cinematic style with depth-of-field separation between foreground and background.
[Shot 1] A medium-wide shot frames ${S(1)}, the person from ${V}, performing the same walk and gestures from ${V}. The camera tracks ${S(1)} following ${V}'s original camera path while ${S(2)}, the environment from ${P(1)}, appears behind ${S(1)} with matched perspective, scale and light direction for seamless integration. Foreground occlusions and contact shadows remain realistic.

overall_soundscape:
Environment ambience from ${P(1)} type — wind, distant traffic or indoor tone — with footsteps and fabric from foreground action.

non_diegetic_music:
N/A`
    },
    {
      id: "two_people",
      icon: "👥",
      titleKey: "review.ref2v.presets.twoPeople.title",
      descKey: "review.ref2v.presets.twoPeople.desc",
      needsVideo: true,
      minPics: 2,
      build: () => `subject_definitions:
${S(1)} is the person on the left whose appearance comes from ${P(1)}.
${S(2)} is the person on the right whose appearance comes from ${P(2)}.
${S(3)} is the environment, camera path and timing from ${V}.
${V} is the source video for the target video edit.

summary:
[reference generation + video editing] The target video is an edited version of ${V}. ${S(1)} and ${S(2)} appear together in ${S(3)}, following ${V}'s camera movement and setting with natural interaction.

retention_analysis:
${S(1)} (appears in [Shot 1]): fully_preserved - appearance, clothing and hairstyle from ${P(1)} retained.
${S(2)} (appears in [Shot 1]): fully_preserved - appearance, clothing and hairstyle from ${P(2)} retained.
${S(3)} (appears in [Shot 1]): fully_preserved - background, camera and timing from ${V} retained.

detailed_description:
The target video is in a live-action, cinematic style with warm natural light.
[Shot 1] A medium-wide shot establishes ${S(3)}, the setting from ${V}. The camera pans right with small amplitude at slow speed revealing ${S(1)} on the left and ${S(2)} on the right standing at natural conversational distance. ${S(1)} and ${S(2)} look toward each other with consistent eye lines, proper spacing and matched lighting. Both maintain recognizable faces and outfits from ${P(1)} and ${P(2)} throughout.

overall_soundscape:
Ambient room tone with subtle footsteps, light fabric and soft breathing from two persons.

non_diegetic_music:
N/A`
    },
    {
      id: "object_insert",
      icon: "📦",
      titleKey: "review.ref2v.presets.object.title",
      descKey: "review.ref2v.presets.object.desc",
      needsVideo: true,
      minPics: 1,
      build: () => `subject_definitions:
${S(1)} is the person whose appearance and motion come from ${V}.
${S(2)} is the physical prop object whose appearance comes from ${P(1)}.
${S(3)} is the environment and camera movement from ${V}.
${V} is the source video for the target video edit.

summary:
[reference generation + video editing] The target video is an edited version of ${V}. ${S(1)} now holds and uses ${S(2)} from ${P(1)} while ${S(3)} remains unchanged.

retention_analysis:
${S(1)} (appears in [Shot 1]): fully_preserved - person and motion from ${V} retained.
${S(2)} (appears in [Shot 1]): fully_preserved - shape, texture, color and material from ${P(1)} retained, with realistic hand contact.
${S(3)} (appears in [Shot 1]): fully_preserved - background and camera from ${V} retained.

detailed_description:
The target video is in a realistic, product-focused, live-action style.
[Shot 1] A medium shot frames ${S(1)}, the person from ${V}, holding ${S(2)}, the object from ${P(1)}, in both hands at chest level. The camera holds a static shot as ${S(1)} lifts and rotates ${S(2)} slightly. ${S(2)} stays centered, in focus, with accurate grip, occlusion over fingers, soft shadows and subtle reflections matching the scene lighting. ${S(3)} remains the original background from ${V}.

overall_soundscape:
Quiet indoor room tone with soft handling sounds and light object contact.

non_diegetic_music:
N/A`
    },
    {
      id: "style_transfer",
      icon: "🎨",
      titleKey: "review.ref2v.presets.style.title",
      descKey: "review.ref2v.presets.style.desc",
      needsVideo: true,
      minPics: 1,
      build: () => `subject_definitions:
${S(1)} is the person whose motion, composition and identity come from ${V} but rendered in the art style of ${P(1)}.
${S(2)} is the environment transformed into the style of ${P(1)}.
${S(3)} is the art style whose visual characteristics come from ${P(1)}, including color palette, linework, shading and rendering method.
${V} is the source video for the target video edit.

summary:
[reference generation] The target video applies ${S(3)} from ${P(1)} to ${V}, preserving ${V}'s motion, camera, composition and timing while changing the rendering style.

retention_analysis:
${S(1)} (appears in [Shot 1]): partially_preserved - motion and identity from ${V} kept, visual style transformed to ${P(1)}.
${S(2)} (appears in [Shot 1]): partially_preserved - layout and depth from ${V} kept, style matches ${P(1)}.
${S(3)} (style from ${P(1)}): weak_reference - palette, linework and rendering guide the final look.

detailed_description:
The target video is in a stylized ${P(1)} art style with expressive color and clean composition.
[Shot 1] A medium-wide shot frames ${S(1)}, the person from ${V} now in ${P(1)} style with recognizable facial features and silhouette but with ${S(3)} colors, linework and shading. The camera follows ${V}'s original movement, panning right with small amplitude at normal speed. ${S(2)}, the background, is re-rendered in ${P(1)} style while keeping depth and perspective from ${V}.

overall_soundscape:
Original environmental ambience is preserved from the source scene with soft footsteps.

non_diegetic_music:
N/A`
    },
    {
      id: "add_companion",
      icon: "🤝",
      titleKey: "review.ref2v.presets.addCompanion.title",
      descKey: "review.ref2v.presets.addCompanion.desc",
      needsVideo: true,
      minPics: 1,
      build: () => `subject_definitions:
${S(1)} is the original person whose appearance and motion come from ${V}.
${S(2)} is the added companion whose appearance comes from ${P(1)}.
${S(3)} is the environment, lighting and camera from ${V}.
${V} is the source video for the target video edit.

summary:
[reference generation + video editing] The target video is an edited version of ${V}. ${S(2)} from ${P(1)} appears beside ${S(1)} in ${S(3)} with natural interaction.

retention_analysis:
${S(1)} (appears in [Shot 1]): fully_preserved - appearance and motion from ${V} retained.
${S(2)} (appears in [Shot 1]): fully_preserved - appearance from ${P(1)} retained, placed beside ${S(1)} with proper scale and spacing.
${S(3)} (appears in [Shot 1]): fully_preserved - background, lighting and camera from ${V} retained.

detailed_description:
The target video is in a live-action, cinematic style with balanced two-person framing.
[Shot 1] A medium-wide shot frames ${S(3)}, the environment from ${V}. The camera holds a static shot revealing ${S(1)} from ${V} on one side and ${S(2)} from ${P(1)} introduced beside them at conversational distance. ${S(1)} and ${S(2)} exchange a natural glance and small gesture while maintaining consistent lighting, scale and depth separation from ${S(3)}.

overall_soundscape:
Soft indoor ambience with light collective footsteps and breathing.

non_diegetic_music:
N/A`
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
    const built = p.build({ hasVideo, picCount, duration: videoDuration });
    onSelect(built);
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
