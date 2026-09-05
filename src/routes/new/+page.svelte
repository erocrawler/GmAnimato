<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { _ } from 'svelte-i18n';
  import { onMount } from 'svelte';
  import { clipVideoToWebm, getVideoDuration } from '$lib/videoClipper';
  import { MAX_IMAGE_BYTES } from '$lib/mediaLimits';
  import type { LoraPreset } from '$lib/loraPresets';

  type Mode = 'i2v' | 'fl2v' | 'ref2v';
  let mode: Mode = 'i2v';
  let imageFile: File | null = null;
  let firstImageFile: File | null = null;
  let lastImageFile: File | null = null;
  let preview = '';
  let firstPreview = '';
  let lastPreview = '';
  let validFile = false;
  let validFirstFile = false;
  let validLastFile = false;
  let submitting = false;
  let message = '';
  let messageType: 'success' | 'error' = 'error';
  let formElement: HTMLFormElement;
  let imageInput: HTMLInputElement;
  let firstImageInput: HTMLInputElement;
  let lastImageInput: HTMLInputElement;
  let isDraggingOver = false;
  let dragCounter = 0;
  let lastDragoverTimestamp = 0;
  let dragoverCheckInterval: ReturnType<typeof setInterval> | null = null;

  // ---- Ref2V state ----
  export let data: any = {};
  const reusableVideos: { id: string; prompt: string; url: string }[] = data.reusableVideos || [];
  // Ref2V mode is only offered once an admin has configured a ref2v workflow.
  const hasRef2vWorkflow: boolean = data.hasRef2vWorkflow === true;
  // Current ref video source: either an uploaded File or a video URL
  let refVideoSource: File | string | null = null;
  let refVideoFile: File | null = null; // the client-clipped webm sent to the server
  let refVideoUrlInput = ''; // user-pasted video URL (from their videos or the gallery)
  let refVideoName = '';
  let refVideoDuration = 0;
  let clipStart = 0;
  // Tier-based ref video length cap (free 6s / paid 15s), provided by the
  // server load so the client clips/limits to the user's entitlement.
  const MAX_REF_VIDEO_SECONDS: number = data.maxRefVideoSeconds || 10;
  let clipEnd = MAX_REF_VIDEO_SECONDS;
  let clipBusy = false;
  let clipError = '';
  // True when the LAST client-side clip attempt failed (as opposed to a
  // validation error like notVideo/tooLarge). Lets submit distinguish "the
  // browser couldn't clip it — fall back to server" from "the input is
  // invalid — block" (see handleUploadEnhance).
  let refVideoClipFailed = false;
  // Browser can't decode this container (e.g. MKV in Chromium — no Matroska
  // demuxer), so duration can't be probed and client-side clipping is
  // impossible. The raw file is uploaded and the server ffmpeg trims it.
  let refVideoNeedsServerClip = false;
  let includeAudio = true; // include the source audio track in the clip (default on)
  let refVideoPreviewUrl = '';
  // Clip range: one of the two thumbs is "active" so overlapping thumbs stay draggable
  let clipActiveThumb: 'start' | 'end' = 'start';
  // Whether the current source can be clipped client-side (File or same-origin
  // URL). Cross-origin URLs (legacy S3 links) can't be read by canvas — the
  // clip controls are hidden and the URL is passed through to the server.
  $: canClipRefVideo =
    !refVideoSource ||
    refVideoSource instanceof File ||
    (typeof refVideoSource === 'string' &&
      (refVideoSource.startsWith('/') ||
        (typeof location !== 'undefined' && refVideoSource.startsWith(location.origin))));
  // Slider range: span the FULL source duration when known, so the user can
  // pick WHERE the (max tier cap) clip comes from. Fall back to the clip cap
  // when the duration is unknown (e.g. cross-origin URLs). The clip LENGTH is
  // enforced in the drag handlers below (window slides within the source), so
  // the UI can never select a range longer than MAX_REF_VIDEO_SECONDS.
  $: sliderMax = refVideoDuration > 0 ? refVideoDuration : MAX_REF_VIDEO_SECONDS;
  // Up to 6 ref images (2 per row x 3 rows)
  let refImages: { file: File | null; preview: string; valid: boolean }[] = [];
  for (let i = 0; i < 6; i++) refImages.push({ file: null, preview: '', valid: false });
  let refImageInputs: (HTMLInputElement | undefined)[] = [];
  let refVideoInput: HTMLInputElement;

  // Standalone reference audio (ref2v): a single ≤15s clip, referenced as
  // <Audio 1> in the prompt (see the review page). It is a SEPARATE audio
  // input from the ref video's soundtrack — both can be present. Mirrors the
  // ref-video flow: a visible "choose" input feeds a hidden named input that
  // the form actually submits.
  let refAudioFile: File | null = null;
  let refAudioDuration = 0;
  let refAudioError = '';
  let refAudioPreviewUrl = '';
  let refAudioChooseInput: HTMLInputElement;
  let refAudioInput: HTMLInputElement;
  const MAX_REF_AUDIO_SECONDS = 15;

  function setFileInput(inputEl: HTMLInputElement | undefined, file: File | null) {
    if (!inputEl) return;
    const dt = new DataTransfer();
    if (file) {
      dt.items.add(file);
    }
    inputEl.files = dt.files;
  }

  function swapImages() {
    // Swap the file objects
    const tempFile = firstImageFile;
    firstImageFile = lastImageFile;
    lastImageFile = tempFile;

    // Swap the previews
    const tempPreview = firstPreview;
    firstPreview = lastPreview;
    lastPreview = tempPreview;

    // Swap the validation states
    const tempValid = validFirstFile;
    validFirstFile = validLastFile;
    validLastFile = tempValid;

    // Keep the underlying file inputs in sync
    setFileInput(firstImageInput, firstImageFile);
    setFileInput(lastImageInput, lastImageFile);
  }

  function resetDragStates() {
    isDraggingOver = false;
    dragCounter = 0;
  }

  function onModeChange() {
    // Reset all files when mode changes
    imageFile = null;
    firstImageFile = null;
    lastImageFile = null;
    preview = '';
    firstPreview = '';
    lastPreview = '';
    validFile = false;
    validFirstFile = false;
    validLastFile = false;
    message = '';
    setFileInput(imageInput, null);
    setFileInput(firstImageInput, null);
    setFileInput(lastImageInput, null);
  }

  function onFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0] || null;
    if (!f) {
      imageFile = null;
      validFile = false;
      preview = '';
      return;
    }
    handleFileInput(f, 'image');
  }

  function onFirstFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0] || null;
    if (!f) {
      firstImageFile = null;
      validFirstFile = false;
      firstPreview = '';
      return;
    }
    handleFileInput(f, 'first_image');
  }

  function onLastFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0] || null;
    if (!f) {
      lastImageFile = null;
      validLastFile = false;
      lastPreview = '';
      return;
    }
    handleFileInput(f, 'last_image');
  }

  // Returns an error message string if invalid, or null when valid
  function validateFile(f: File): Promise<string | null> {
    return new Promise((resolve) => {
      if (f.size > MAX_IMAGE_BYTES) {
        resolve($_('newVideo.errors.fileTooLarge', { values: { size: Math.round(MAX_IMAGE_BYTES / 1024 / 1024) } }));
        return;
      }

      if (!f.type || !f.type.startsWith('image/')) {
        // still try to load it as an image (some browsers may not provide type)
        resolve($_('newVideo.errors.notImage'));
        return;
      }

      // attempt to load the file into an <img> to ensure it's a valid image
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve($_('newVideo.errors.invalidImage'));
      };
      img.src = url;
    });
  }

  // The submit callback passed to `use:enhance` is awaited BEFORE the fetch
  // (see SvelteKit forms.js), so async work here (ref2v client-side clipping)
  // completes before FormData is serialized. It must return the result-handler.
  async function handleUploadEnhance({ formData, cancel }: any) {
    submitting = true;
    if (mode === 'ref2v' && clipError && !refVideoClipFailed) {
      // A validation error (notVideo / tooLarge / invalidUrl / urlNotReady)
      // on the current input — the ref video is wrong/stale, so block the
      // submit. Clip failures (refVideoClipFailed) are NOT validation errors:
      // the browser just couldn't decode/clip, so we fall back to the server
      // below instead of cancelling.
      submitting = false;
      message = clipError;
      messageType = 'error';
      cancel?.();
      return;
    }
    const isRef2v = mode === 'ref2v' && refVideoSource;
    const defaultTrim =
      Math.abs(clipStart) <= 0.16 &&
      (refVideoDuration <= 0 || clipEnd + 0.16 >= refVideoDuration);

    if (isRef2v) {
      // Trim required, OR the user asked to drop audio while the whole file
      // fits (a full-range "clip" must still re-encode to actually strip the
      // audio — the fast-path returns the original bytes otherwise).
      // Containers the browser can't decode (MKV etc.) can't be clipped
      // client-side — the raw file goes up and the server ffmpeg trims it.
      const needsClip =
        !refVideoFile && (!defaultTrim || !includeAudio) && canClipRefVideo && !refVideoNeedsServerClip;
      if (needsClip) {
        // Trim/audio-strip required → re-encode via canvas/MediaRecorder. On
        // failure, fall back to server-side processing (same path as browser-
        // undecodable containers): the raw file + trim/audio window go up and
        // the server ffmpeg handles them. A browser clip failure (e.g.
        // NS_ERROR_DOM_MEDIA_METADATA_ERR) is a browser limitation, not a bad
        // file — ffmpeg decodes far more containers/codecs than any browser,
        // so the server will almost always succeed. The server hard-fails on
        // genuinely undecodable files (trim requested → error), so this never
        // silently produces a broken entry.
        // Skip the retry when the last attempt already failed with this same
        // source/range (it would fail identically).
        const clipOk = refVideoClipFailed ? false : await applyClip();
        if (!clipOk && !refVideoFile) {
          clipError = '';
          refVideoNeedsServerClip = true;
          refVideoFile = refVideoSource instanceof File ? refVideoSource : null;
          if (refVideoFile) setFileInput(refVideoInput, refVideoFile);
          message = $_('newVideo.mode.ref2v.errors.clientClipFailed');
          messageType = 'success';
        }
      } else if (!refVideoFile) {
        // No existing clipped file
        if (refVideoSource instanceof File) {
          // Default trim: skip canvas re-encode, submit original File directly.
          // Server-side ffmpeg will downscale with audio preserved and also
          // generate the poster frame (extractVideoPoster) — no client-side
          // poster extraction needed.
          refVideoFile = refVideoSource as File;
          refVideoName = refVideoSource.name || refVideoName || 'ref_video.webm';
          setFileInput(refVideoInput, refVideoFile);
        } else if (typeof refVideoSource === 'string') {
          // Reused video URL (either /media/ default trim or cross-origin fallback)
          formData.delete('ref_video');
          formData.set('ref_video_url', refVideoSource);
        }
      }
    }

    // Sync hidden file inputs into the FormData that SvelteKit already built
    if (refVideoFile) {
      formData.set('ref_video', refVideoFile);
      formData.delete('ref_video_url');
    } else if (isRef2v && typeof refVideoSource === 'string') {
      // URL reuse path — keep URL, no binary
      formData.delete('ref_video');
      formData.set('ref_video_url', refVideoSource);
    } else if (mode === 'ref2v' && !refVideoSource) {
      // Pure text-to-video with optional images
      formData.delete('ref_video');
      formData.delete('ref_video_url');
    } else if (mode !== 'ref2v') {
      formData.delete('ref_video');
      formData.delete('ref_video_url');
    }
    // Browser-unsupported container (e.g. MKV): pass the trim range + audio
    // flag so the server ffmpeg clips the raw file on upload.
    if (refVideoNeedsServerClip && refVideoFile) {
      formData.set('ref_video_start', String(Math.max(0, clipStart)));
      formData.set('ref_video_end', String(clipEnd));
      formData.set('ref_video_include_audio', String(includeAudio));
    } else {
      formData.delete('ref_video_start');
      formData.delete('ref_video_end');
      formData.delete('ref_video_include_audio');
    }

    for (let i = 0; i < 6; i++) {
      const f = refImages[i].file;
      if (f) {
        formData.set(`ref_image_${i + 1}`, f);
      } else {
        formData.delete(`ref_image_${i + 1}`);
      }
    }
    // Carry the CLIPPED ref video duration so the review page can offer "follow
    // video duration" and the worker can match the output length to the source.
    // Use clipEnd - clipStart (not the original file duration) so a 20s video
    // clipped to 10s reports 10s, not 20s.
    if (isRef2v) {
      // For server-clipped containers the effective duration is the selected
      // window (source duration is unknown client-side). Otherwise report the
      // clipped window clamped to the probed source duration.
      const clippedDuration = refVideoNeedsServerClip
        ? clipEnd - clipStart
        : refVideoDuration > 0
          ? Math.min(clipEnd, refVideoDuration) - clipStart
          : 0;
      if (clippedDuration > 0) {
        formData.set("ref_video_duration", String(Math.min(MAX_REF_VIDEO_SECONDS, clippedDuration)));
      } else {
        formData.delete("ref_video_duration");
      }
    } else {
      formData.delete("ref_video_duration");
    }
    if (refAudioFile) {
      formData.set('ref_audio', refAudioFile);
    } else {
      formData.delete('ref_audio');
    }
    return async ({ result }: any) => {
      submitting = false;
      if (result.type === 'success' && result.data) {
        if (result.data.success) {
          const entry = (result.data as any).entry;
          if (entry && entry.id) {
            if (formElement) formElement.reset();
            imageFile = null;
            firstImageFile = null;
            lastImageFile = null;
            preview = '';
            firstPreview = '';
            lastPreview = '';
            validFile = false;
            validFirstFile = false;
            validLastFile = false;
            resetRefVideo();
            resetRefAudio();
            for (let i = 0; i < 6; i++) removeRefImage(i);
            await goto(`/new/review/${entry.id}`);
            return;
          }
          message = $_('newVideo.success');
          messageType = 'success';
        } else if (result.data.error) {
          message = $_('newVideo.errors.uploadFailed', { values: { error: result.data.error } });
          messageType = 'error';
        }
      } else {
        message = $_('newVideo.errors.unexpectedError');
        messageType = 'error';
      }
      setTimeout(() => (message = ''), 3000);
    };
  }

  $: isFormValid = mode === 'i2v' ? validFile : mode === 'fl2v' ? (validFirstFile && validLastFile) : true;

  // ---- Ref2V handlers ----

  function resetRefVideo() {
    refVideoSource = null;
    refVideoFile = null;
    refVideoName = '';
    refVideoDuration = 0;
    refVideoUrlInput = '';
    clipStart = 0;
    clipEnd = MAX_REF_VIDEO_SECONDS;
    clipError = '';
    refVideoClipFailed = false;
    refVideoNeedsServerClip = false;
    if (refVideoPreviewUrl && refVideoPreviewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(refVideoPreviewUrl);
    }
    refVideoPreviewUrl = '';
    setFileInput(refVideoInput, null);
  }

  async function onRefVideoFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0] || null;
    if (!f) return;
    if (!f.type.startsWith('video/')) {
      clipError = $_('newVideo.mode.ref2v.errors.notVideo');
      return;
    }
    if (f.size > 50 * 1024 * 1024) {
      clipError = $_('newVideo.mode.ref2v.errors.tooLarge');
      return;
    }
    clipError = '';
    resetRefVideo();
    refVideoSource = f;
    refVideoName = f.name || 'ref_video.webm';
    refVideoPreviewUrl = URL.createObjectURL(f);
    try {
      const dur = await getVideoDuration(f);
      refVideoNeedsServerClip = false;
      refVideoDuration = dur;
      clipStart = 0;
      clipEnd = Math.min(MAX_REF_VIDEO_SECONDS, dur);
    } catch {
      // Browser can't decode this container (e.g. MKV in Chromium — no
      // Matroska demuxer, see DEMUXER_ERROR_COULD_NOT_OPEN). The server ffmpeg
      // can handle it: upload the raw file and let the server trim/downscale.
      refVideoNeedsServerClip = true;
      refVideoDuration = 0;
      clipStart = 0;
      clipEnd = MAX_REF_VIDEO_SECONDS;
    }
  }

  async function useVideoUrl(url: string) {
    const trimmed = (url || '').trim();
    if (!trimmed) return;
    clipError = '';

    // Absolute URLs pointing at our own /media/ proxy (e.g. pasted from the
    // production site: https://animato.gmgard.moe/media/wan/xxx.mp4) are
    // normalized to the relative /media/... form. The browser then loads them
    // same-origin (no CORS), the client can clip them, and the server treats
    // them as media-proxy URLs — probing audio via S3_ENDPOINT instead of
    // fetching the app domain (which returns 403 without a session).
    const mediaMatch = trimmed.match(/^https?:\/\/[^/]+\/(media\/.+)$/i);
    const input = mediaMatch ? `/${mediaMatch[1]}` : trimmed;

    let resolvedSource: string = input;
    let resolvedName = 'ref_video.webm';

    // Page URLs / video IDs are resolved to the actual file URL via the
    // server (access-checked, returns a proxied /media/... URL):
    //   https://host/videos/<id>  /videos/<id>  /gallery/<id>  /<id>  https://host/<id>
    const isPageOrId =
      /\/videos\/[a-z0-9]{10,}(?:[?#]|$)/i.test(input) ||
      /\/gallery\/[a-z0-9]{10,}(?:[?#]|$)/i.test(input) ||
      /^\/?[a-z0-9]{20,}$/i.test(input) ||
      /^https?:\/\/[^/]+\/[a-z0-9]{20,}(?:[?#]|$)/i.test(input);
    if (isPageOrId) {
      try {
        const res = await fetch('/api/video/resolve-ref', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: trimmed }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success || !data.url) {
          if (data.error && /not ready|not completed/i.test(String(data.error))) {
            clipError = $_('newVideo.mode.ref2v.errors.urlNotReady');
          } else {
            clipError = data.error || $_('newVideo.mode.ref2v.errors.invalidUrl');
          }
          return;
        }
        resolvedSource = data.url;
        resolvedName = data.name || 'ref_video.webm';
      } catch (e) {
        clipError = String(e);
        return;
      }
    } else if (!/^(\/|https?:\/\/)/i.test(input)) {
      // Direct media URLs: /media/... or http(s) video URLs
      clipError = $_('newVideo.mode.ref2v.errors.invalidUrl');
      return;
    }

    resetRefVideo();
    refVideoSource = resolvedSource;
    refVideoName = resolvedName;
    refVideoPreviewUrl = resolvedSource;
    try {
      // Best-effort: probe duration so the clip slider spans the full source.
      const dur = await getVideoDuration(resolvedSource);
      refVideoDuration = dur;
      clipStart = 0;
      clipEnd = Math.min(MAX_REF_VIDEO_SECONDS, dur);
    } catch {
      // Cross-origin URLs can't be probed — leave duration 0 and rely on the
      // MAX cap (clip controls are hidden for those anyway).
      refVideoDuration = 0;
      clipStart = 0;
      clipEnd = MAX_REF_VIDEO_SECONDS;
    }
  }

  // Drag handlers enforce the clip LENGTH cap in the UI: the selected window
  // [clipStart, clipEnd] can never exceed MAX_REF_VIDEO_SECONDS. Dragging a
  // thumb past the cap slides the OTHER thumb along, so the window keeps its
  // max length and can move anywhere within the source (e.g. drag the end
  // thumb to 15s of a 17s video -> window 5-15s, still a 10s clip), instead of
  // allowing an arbitrarily long range that would only be capped later.
  function onClipStartInput(e: Event) {
    const v = Number((e.target as HTMLInputElement).value);
    let start = Math.max(0, Math.min(v, clipEnd - 0.1));
    let end = clipEnd;
    if (end - start > MAX_REF_VIDEO_SECONDS) end = start + MAX_REF_VIDEO_SECONDS;
    if (end > sliderMax) {
      end = sliderMax;
      start = Math.max(0, end - MAX_REF_VIDEO_SECONDS);
    }
    clipStart = start;
    clipEnd = end;
    clipActiveThumb = 'start';
  }

  function onClipEndInput(e: Event) {
    const v = Number((e.target as HTMLInputElement).value);
    let end = Math.min(sliderMax, Math.max(v, clipStart + 0.1));
    let start = clipStart;
    if (end - start > MAX_REF_VIDEO_SECONDS) start = end - MAX_REF_VIDEO_SECONDS;
    if (start < 0) {
      start = 0;
      end = Math.min(sliderMax, start + MAX_REF_VIDEO_SECONDS);
    }
    clipStart = start;
    clipEnd = end;
    clipActiveThumb = 'end';
  }

  function onClipRangePointerDown(e: PointerEvent) {
    // Raise whichever thumb is closer to the pointer so overlapping thumbs
    // remain individually draggable.
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const val = pct * sliderMax;
    clipActiveThumb = Math.abs(val - clipStart) <= Math.abs(val - clipEnd) ? 'start' : 'end';
  }

  /** Clip the ref video in the browser. Returns true on success, false on
   *  failure (sets `clipError`). On success `refVideoFile` is set to the
   *  clipped file. */
  async function applyClip(): Promise<boolean> {
    if (!refVideoSource) return false;
    clipBusy = true;
    clipError = '';
    try {
      const result = await clipVideoToWebm(refVideoSource, clipStart, clipEnd, MAX_REF_VIDEO_SECONDS, includeAudio);
      // Name the clipped file after the output container (result.mimeType is
      // the clean base type, e.g. 'video/mp4' -> .mp4).
      const ext = result.mimeType.includes('mp4') ? 'mp4' : 'webm';
      const baseName = (refVideoName || 'ref_video').replace(/\.(mp4|webm|mov|mkv)$/i, '');
      const clippedName = `${baseName}.${ext}`;
      refVideoFile = new File([result.blob], clippedName, { type: result.mimeType });
      setFileInput(refVideoInput, refVideoFile);
      if (refVideoPreviewUrl && refVideoPreviewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(refVideoPreviewUrl);
      }
      refVideoPreviewUrl = URL.createObjectURL(refVideoFile);
      // Poster frame is generated server-side (extractVideoPoster on the
      // uploaded S3 URL) — no client-side extraction needed here.
      refVideoClipFailed = false;
      return true;
    } catch (err) {
      clipError = String(err);
      refVideoClipFailed = true;
      console.warn('[Ref2V] Client-side clip failed:', err);
      return false;
    } finally {
      clipBusy = false;
    }
  }

  function onRefImageFile(e: Event, index: number) {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0] || null;
    if (!f) {
      removeRefImage(index);
      return;
    }
    validateFile(f).then((err) => {
      if (err) {
        message = err;
        messageType = 'error';
        setTimeout(() => (message = ''), 4000);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        refImages[index] = { file: f, preview: String(reader.result), valid: true };
        refImages = [...refImages];
        setFileInput(refImageInputs[index], f);
      };
      reader.readAsDataURL(f);
    });
  }

  function removeRefImage(index: number) {
    refImages[index] = { file: null, preview: '', valid: false };
    refImages = [...refImages];
    setFileInput(refImageInputs[index], null);
  }

  // ---- Ref2V reference audio handlers ----

  /** Read an audio file's duration (seconds) via <audio> metadata. */
  function getAudioDuration(source: File | string): Promise<number> {
    return new Promise((resolve, reject) => {
      const url = typeof source === 'string' ? source : URL.createObjectURL(source);
      const audio = new Audio();
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => {
        const d = audio.duration;
        if (typeof source !== 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url);
        resolve(Number.isFinite(d) && d > 0 ? d : 0);
      };
      audio.onerror = () => {
        if (typeof source !== 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url);
        reject(new Error($_('newVideo.mode.ref2v.errors.notAudio')));
      };
      audio.src = url;
    });
  }

  function resetRefAudio() {
    refAudioFile = null;
    refAudioDuration = 0;
    refAudioError = '';
    if (refAudioPreviewUrl && refAudioPreviewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(refAudioPreviewUrl);
    }
    refAudioPreviewUrl = '';
    setFileInput(refAudioInput, null);
  }

  async function onRefAudioFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0] || null;
    refAudioError = '';
    if (!f) {
      resetRefAudio();
      return;
    }
    if (!f.type.startsWith('audio/')) {
      refAudioError = $_('newVideo.mode.ref2v.errors.notAudio');
      // Clear the chooser so the same file can be re-picked after fixing it.
      setFileInput(input, null);
      return;
    }
    if (f.size > 50 * 1024 * 1024) {
      refAudioError = $_('newVideo.mode.ref2v.errors.audioTooLarge');
      setFileInput(input, null);
      return;
    }
    try {
      const dur = await getAudioDuration(f);
      if (dur > MAX_REF_AUDIO_SECONDS + 0.5) {
        refAudioError = $_('newVideo.mode.ref2v.errors.audioTooLong', {
          values: { max: MAX_REF_AUDIO_SECONDS },
        });
        setFileInput(input, null);
        setFileInput(refAudioInput, null);
        refAudioFile = null;
        return;
      }
      refAudioFile = f;
      refAudioDuration = dur;
      if (refAudioPreviewUrl && refAudioPreviewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(refAudioPreviewUrl);
      }
      refAudioPreviewUrl = URL.createObjectURL(f);
      setFileInput(refAudioInput, f);
      // Clear the chooser so selecting the same file again re-triggers change.
      setFileInput(input, null);
    } catch (err) {
      refAudioError = String(err);
      setFileInput(input, null);
      setFileInput(refAudioInput, null);
      refAudioFile = null;
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
    lastDragoverTimestamp = Date.now();
    dragCounter++;
    isDraggingOver = true;
  }

  function handleDragEnter(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter--;
    if (dragCounter === 0) {
      isDraggingOver = false;
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    isDraggingOver = false;
    lastDragoverTimestamp = 0;

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
    const videoFiles = Array.from(files).filter((f) => f.type.startsWith('video/'));

    if (mode === 'i2v') {
      // For i2v mode, take the first image file
      if (imageFiles.length === 0) return;
      handleFileInput(imageFiles[0], 'image');
    } else if (mode === 'ref2v') {
      // For ref2v mode, auto-detect: video -> ref video, image -> next ref slot.
      const videoFile = videoFiles[0];
      if (videoFile) {
        // Reuse the same validation as the file input handler.
        if (!videoFile.type.startsWith('video/')) {
          clipError = $_('newVideo.mode.ref2v.errors.notVideo');
        } else if (videoFile.size > 50 * 1024 * 1024) {
          clipError = $_('newVideo.mode.ref2v.errors.tooLarge');
        } else {
          clipError = '';
          resetRefVideo();
          refVideoSource = videoFile;
          refVideoName = videoFile.name || 'ref_video.webm';
          refVideoPreviewUrl = URL.createObjectURL(videoFile);
          getVideoDuration(videoFile).then((dur) => {
            refVideoNeedsServerClip = false;
            refVideoDuration = dur;
            clipStart = 0;
            clipEnd = Math.min(MAX_REF_VIDEO_SECONDS, dur);
          }).catch(() => {
            // Browser can't decode this container (e.g. MKV in Chromium) —
            // server ffmpeg will trim/convert it on upload.
            refVideoNeedsServerClip = true;
            refVideoDuration = 0;
            clipStart = 0;
            clipEnd = MAX_REF_VIDEO_SECONDS;
          });
        }
      }
      for (const img of imageFiles) {
        const emptySlot = refImages.findIndex((r) => !r.valid);
        if (emptySlot === -1) break; // all 6 slots filled
        onRefImageFile({ target: { files: [img] } } as unknown as Event, emptySlot);
      }
    } else {
      // For fl2v mode, assign intelligently
      if (imageFiles.length === 0) return;
      if (imageFiles.length >= 2) {
        // If user dropped 2+ images, assign first and second
        handleFileInput(imageFiles[0], 'first_image');
        handleFileInput(imageFiles[1], 'last_image');
      } else {
        // If user dropped 1 image, assign to first empty slot
        if (!firstImageFile) {
          handleFileInput(imageFiles[0], 'first_image');
        } else if (!lastImageFile) {
          handleFileInput(imageFiles[0], 'last_image');
        } else {
          // Both slots filled, replace first
          handleFileInput(imageFiles[0], 'first_image');
        }
      }
    }
  }

  function handleDropFirstImage(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    isDraggingOver = false;
    lastDragoverTimestamp = 0;

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) {
      return;
    }

    const imageFile = Array.from(files).find((f) => f.type.startsWith('image/'));
    if (imageFile) {
      handleFileInput(imageFile, 'first_image');
    }
  }

  function handleDropLastImage(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    isDraggingOver = false;
    lastDragoverTimestamp = 0;

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) {
      return;
    }

    const imageFile = Array.from(files).find((f) => f.type.startsWith('image/'));
    if (imageFile) {
      handleFileInput(imageFile, 'last_image');
    }
  }

  function handleFileInput(file: File, inputType: 'image' | 'first_image' | 'last_image') {
    validateFile(file).then((err) => {
      if (err) {
        message = err;
        messageType = 'error';
        setTimeout(() => (message = ''), 4000);
        return;
      }

      if (inputType === 'image') {
        imageFile = file;
        validFile = true;
        setFileInput(imageInput, file);
        const reader = new FileReader();
        reader.onload = () => (preview = String(reader.result));
        reader.readAsDataURL(file);
      } else if (inputType === 'first_image') {
        firstImageFile = file;
        validFirstFile = true;
        setFileInput(firstImageInput, file);
        const reader = new FileReader();
        reader.onload = () => (firstPreview = String(reader.result));
        reader.readAsDataURL(file);
      } else if (inputType === 'last_image') {
        lastImageFile = file;
        validLastFile = true;
        setFileInput(lastImageInput, file);
        const reader = new FileReader();
        reader.onload = () => (lastPreview = String(reader.result));
        reader.readAsDataURL(file);
      }
    });
  }

  onMount(() => {
    // If ref2v became unavailable (no ref2v workflow configured), fall back to
    // i2v so the UI never shows a ref2v-only state.
    if (mode === 'ref2v' && !hasRef2vWorkflow) {
      mode = 'i2v';
    }

    // Heartbeat strategy: check if dragover events are still firing
    // If no dragover event for 100ms, the user has dragged away
    dragoverCheckInterval = setInterval(() => {
      const timeSinceLastDragover = Date.now() - lastDragoverTimestamp;
      if (lastDragoverTimestamp > 0 && timeSinceLastDragover > 100) {
        resetDragStates();
        lastDragoverTimestamp = 0;
      }
    }, 50);

    // Reset drag states if user presses Escape
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        resetDragStates();
        lastDragoverTimestamp = 0;
      }
    };

    document.addEventListener('keydown', handleEscape);

    return () => {
      if (dragoverCheckInterval) {
        clearInterval(dragoverCheckInterval);
      }
      document.removeEventListener('keydown', handleEscape);
    };
  });
</script>

<div class="max-w-2xl mx-auto">
  <h1 class="text-4xl font-bold mb-8">{$_('newVideo.title')}</h1>

  {#if message}
    <div class="alert mb-6" class:alert-error={messageType === 'error'} class:alert-success={messageType === 'success'}>
      <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
        {#if messageType === 'success'}
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        {:else}
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
        {/if}
      </svg>
      <span>{message}</span>
    </div>
  {/if}

  <div 
    class="card bg-base-100 shadow-xl transition-all duration-200"
    class:ring-4={isDraggingOver}
    class:ring-primary={isDraggingOver}
    class:scale-105={isDraggingOver}
    on:dragenter={handleDragEnter}
    on:dragover={handleDragOver}
    on:dragleave={handleDragLeave}
    on:drop={handleDrop}
    role="region"
  >
    <div class="card-body">
      {#if isDraggingOver}
        <div class="absolute inset-0 bg-primary/10 rounded-2xl flex items-center justify-center pointer-events-none">
          <div class="text-center">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-16 w-16 mx-auto mb-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
            </svg>
            <p class="text-lg font-semibold text-primary">{$_('newVideo.dragAndDrop')}</p>
          </div>
        </div>
      {/if}
      <form bind:this={formElement} method="post" enctype="multipart/form-data" use:enhance={handleUploadEnhance}>
        <!-- Mode Selection -->
        <div class="form-control w-full mb-6">
          <div class="label">
            <span class="label-text font-semibold">{$_('newVideo.mode.title')}</span>
          </div>
          <div class="flex flex-col sm:flex-row sm:flex-wrap gap-4">
            <label class="label cursor-pointer gap-2 flex-1 min-w-0 basis-full sm:basis-[30%] border rounded-lg p-4" class:border-primary={mode === 'i2v'} class:bg-base-200={mode === 'i2v'}>
              <input type="radio" name="mode" value="i2v" bind:group={mode} on:change={onModeChange} class="radio radio-primary shrink-0" />
              <div class="flex-1 min-w-0 whitespace-normal">
                <span class="label-text font-semibold break-words">{$_('newVideo.mode.i2v.title')}</span>
                <p class="text-xs opacity-70 mt-1 break-words">{$_('newVideo.mode.i2v.description')}</p>
              </div>
            </label>
            <label class="label cursor-pointer gap-2 flex-1 min-w-0 basis-full sm:basis-[30%] border rounded-lg p-4" class:border-primary={mode === 'fl2v'} class:bg-base-200={mode === 'fl2v'}>
              <input type="radio" name="mode" value="fl2v" bind:group={mode} on:change={onModeChange} class="radio radio-primary shrink-0" />
              <div class="flex-1 min-w-0 whitespace-normal">
                <span class="label-text font-semibold break-words">{$_('newVideo.mode.fl2v.title')}</span>
                <p class="text-xs opacity-70 mt-1 break-words">{$_('newVideo.mode.fl2v.description')}</p>
              </div>
            </label>
            {#if hasRef2vWorkflow}
              <label class="label cursor-pointer gap-2 flex-1 min-w-0 basis-full sm:basis-[30%] border rounded-lg p-4" class:border-primary={mode === 'ref2v'} class:bg-base-200={mode === 'ref2v'}>
                <input type="radio" name="mode" value="ref2v" bind:group={mode} on:change={onModeChange} class="radio radio-primary shrink-0" />
                <div class="flex-1 min-w-0 whitespace-normal">
                  <span class="label-text font-semibold break-words">{$_('newVideo.mode.ref2v.title')}</span>
                  <p class="text-xs opacity-70 mt-1 break-words">{$_('newVideo.mode.ref2v.description')}</p>
                </div>
              </label>
            {/if}
          </div>
        </div>

        {#if mode === 'i2v'}
          <!-- I2V Mode: Single Image -->
          <div class="form-control w-full">
            <label class="label" for="image">
              <span class="label-text font-semibold">{$_('newVideo.selectImage')}</span>
              <span class="label-text-alt">{$_('newVideo.maxSize')}</span>
            </label>
            <input 
              id="image" 
              name="image" 
              type="file" 
              accept="image/*" 
              bind:this={imageInput}
              on:change={onFile}
              on:drop={(e) => { e.preventDefault(); e.stopPropagation(); const file = e.dataTransfer?.files?.[0]; if (file) handleFileInput(file, 'image'); }}
              class="file-input file-input-bordered file-input-primary w-full"
              required 
            />
          </div>
          
          {#if preview}
            <div class="mt-6">
              <div class="rounded-lg overflow-hidden shadow-lg">
                <img src={preview} alt="preview" class="w-full max-h-96 object-contain bg-base-200" />
              </div>
            </div>
          {/if}
        {:else if mode === 'fl2v'}
          <!-- FL2V Mode: Two Images -->
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="form-control w-full">
              <label class="label" for="first_image">
                <span class="label-text font-semibold">{$_('newVideo.mode.fl2v.firstFrame')}</span>
                <span class="label-text-alt">{$_('newVideo.maxSize')}</span>
              </label>
              <input 
                id="first_image" 
                name="first_image" 
                type="file" 
                accept="image/*" 
                bind:this={firstImageInput}
                on:change={onFirstFile}
                on:drop={(e) => { e.preventDefault(); e.stopPropagation(); const file = e.dataTransfer?.files?.[0]; if (file) handleFileInput(file, 'first_image'); }}
                class="file-input file-input-bordered file-input-primary w-full"
                required 
              />
              {#if firstPreview}
                <div class="mt-4 rounded-lg overflow-hidden shadow-lg">
                  <img src={firstPreview} alt="first frame preview" class="w-full max-h-64 object-contain bg-base-200" />
                </div>
              {/if}
            </div>

            <div class="form-control w-full">
              <label class="label" for="last_image">
                <span class="label-text font-semibold">{$_('newVideo.mode.fl2v.lastFrame')}</span>
                <span class="label-text-alt">{$_('newVideo.maxSize')}</span>
              </label>
              <input 
                id="last_image" 
                name="last_image" 
                type="file" 
                accept="image/*" 
                bind:this={lastImageInput}
                on:change={onLastFile}
                on:drop={(e) => { e.preventDefault(); e.stopPropagation(); const file = e.dataTransfer?.files?.[0]; if (file) handleFileInput(file, 'last_image'); }}
                class="file-input file-input-bordered file-input-primary w-full"
                required 
              />
              {#if lastPreview}
                <div class="mt-4 rounded-lg overflow-hidden shadow-lg">
                  <img src={lastPreview} alt="last frame preview" class="w-full max-h-64 object-contain bg-base-200" />
                </div>
              {/if}
            </div>
          </div>

          <!-- Swap button -->
          {#if firstPreview || lastPreview}
            <div class="flex justify-center mt-4">
              <button 
                type="button"
                class="btn btn-ghost btn-sm"
                on:click={swapImages}
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16V4m0 0L3 4m4 0l4-4m10 4v12m0 0l4 4m-4-4l-4 4" />
                </svg>
                {$_('newVideo.swapImages')}
              </button>
            </div>
          {/if}
        {:else}
          <!-- Ref2V Mode: optional ref video (client-clipped) + up to 5 optional ref images -->
          <div class="alert alert-info shadow-lg mb-6">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-6 h-6">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
            </svg>
            <div class="text-sm">{$_('newVideo.mode.ref2v.optionalHint')}</div>
          </div>

          <!-- Reference video -->
          <div class="form-control w-full mb-4">
            <div class="label">
              <span class="label-text font-semibold">{$_('newVideo.mode.ref2v.videoLabel')}</span>
              <span class="label-text-alt">{$_('newVideo.mode.ref2v.videoHint', { values: { max: MAX_REF_VIDEO_SECONDS } })}</span>
            </div>
            <input 
              id="ref_video_source" 
              type="file" 
              accept="video/*" 
              on:change={onRefVideoFile}
              class="file-input file-input-bordered file-input-primary w-full"
            />
            <input id="ref_video" name="ref_video" type="file" accept="video/*" class="hidden" bind:this={refVideoInput} />
          </div>

          <!-- Or paste a video URL (from your videos or the gallery) -->
          <div class="form-control w-full mb-4">
            <div class="label">
              <span class="label-text font-semibold">{$_('newVideo.mode.ref2v.urlLabel')}</span>
              <span class="label-text-alt">{$_('newVideo.mode.ref2v.urlHint')}</span>
            </div>
            <div class="flex gap-2">
              <input
                type="url"
                class="input input-bordered input-sm flex-1 min-w-0"
                placeholder={$_('newVideo.mode.ref2v.urlPlaceholder')}
                bind:value={refVideoUrlInput}
                list="ref2v-video-suggestions"
                on:keydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); useVideoUrl(refVideoUrlInput); } }}
              />
              <button
                type="button"
                class="btn btn-sm btn-outline"
                disabled={!refVideoUrlInput.trim()}
                on:click={() => useVideoUrl(refVideoUrlInput)}
              >{$_('newVideo.mode.ref2v.urlUse')}</button>
            </div>
            {#if reusableVideos.length > 0}
              <datalist id="ref2v-video-suggestions">
                {#each reusableVideos as v}
                  <option value={v.url}>{v.prompt || v.id}</option>
                {/each}
              </datalist>
            {/if}
          </div>

          {#if refVideoSource}
            <div class="mt-4 rounded-lg overflow-hidden shadow-lg bg-base-200">
              {#if refVideoNeedsServerClip}
                <div class="flex items-center gap-3 p-4 text-sm opacity-80">
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 4v16M17 4v16M3 8h4M3 16h4M17 8h4M17 16h4M3 12h18" />
                  </svg>
                  <span class="truncate">{refVideoName || 'ref_video.mkv'}</span>
                </div>
              {:else}
                {#key refVideoPreviewUrl}
                  <video
                    src={refVideoPreviewUrl}
                    controls
                    muted
                    playsinline
                    preload="auto"
                    class="w-full max-h-72"
                  ></video>
                {/key}
              {/if}
            </div>

            {#if canClipRefVideo}
              <div class="form-control w-full mt-4">
                <label class="label" for="clip_range">
                  <span class="label-text font-semibold">{$_('newVideo.mode.ref2v.clipRange')}</span>
                  <span class="label-text-alt font-mono">{clipStart.toFixed(1)}s — {clipEnd.toFixed(1)}s</span>
                </label>
                <div
                  id="clip_range"
                  class="dual-range"
                  style={`--range-min: 0; --range-max: ${sliderMax}; --range-a: ${clipStart}; --range-b: ${clipEnd};`}
                  role="group"
                  aria-label={$_('newVideo.mode.ref2v.clipRange')}
                  on:pointerdown={onClipRangePointerDown}
                >
                  <input
                    type="range"
                    min="0"
                    max={sliderMax}
                    step="0.1"
                    bind:value={clipStart}
                    on:input={onClipStartInput}
                    class:z-raise={clipActiveThumb === 'start'}
                    aria-label={$_('newVideo.mode.ref2v.clipStart')}
                  />
                  <input
                    type="range"
                    min="0"
                    max={sliderMax}
                    step="0.1"
                    bind:value={clipEnd}
                    on:input={onClipEndInput}
                    class:z-raise={clipActiveThumb === 'end'}
                    aria-label={$_('newVideo.mode.ref2v.clipEnd')}
                  />
                </div>
              </div>

              <div class="flex items-center gap-3 mt-4">
                {#if refVideoNeedsServerClip}
                  <div class="alert alert-warning shadow-lg py-2 w-full">
                    <span class="text-sm">{$_('newVideo.mode.ref2v.serverClipHint')}</span>
                  </div>
                {:else}
                  <button type="button" class="btn btn-primary" disabled={clipBusy} on:click={applyClip}>
                    {#if clipBusy}
                      <span class="loading loading-spinner"></span>
                    {:else}
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                    {/if}
                    {$_('newVideo.mode.ref2v.clipButton')}
                  </button>
                  {#if refVideoFile}
                    <span class="text-sm opacity-70">{$_('newVideo.mode.ref2v.clipped')} {refVideoFile.name}</span>
                  {/if}
                {/if}
              </div>

              <!-- Include audio in the clip (default on) -->
              <label class="flex items-center gap-2 mt-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  class="checkbox checkbox-primary checkbox-sm"
                  bind:checked={includeAudio}
                />
                <span class="text-sm">{$_('newVideo.mode.ref2v.includeAudio')}</span>
              </label>
            {:else}
              <div class="alert alert-info shadow-lg mt-4 py-2">
                <span class="text-sm">{$_('newVideo.mode.ref2v.crossOriginHint')}</span>
              </div>
            {/if}
            {#if clipError}
              <div class="alert alert-error shadow-lg mt-4">
                <span>{clipError}</span>
              </div>
            {/if}
          {/if}

          <!-- Standalone reference audio (optional, ≤15s): an extra audio
               reference (<Audio 1>) alongside the ref video's soundtrack. -->
          <div class="form-control w-full mt-6">
            <div class="label">
              <span class="label-text font-semibold">{$_('newVideo.mode.ref2v.audioLabel')}</span>
              <span class="label-text-alt">{$_('newVideo.mode.ref2v.audioHint', { values: { max: MAX_REF_AUDIO_SECONDS } })}</span>
            </div>
            <input
              id="ref_audio_source"
              type="file"
              accept="audio/*"
              on:change={onRefAudioFile}
              bind:this={refAudioChooseInput}
              class="file-input file-input-bordered file-input-primary w-full"
            />
            <input id="ref_audio" name="ref_audio" type="file" accept="audio/*" class="hidden" bind:this={refAudioInput} />
            {#if refAudioFile}
              <div class="flex items-center gap-3 mt-3 rounded-lg bg-base-200 p-3">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
                <div class="min-w-0 flex-1">
                  <p class="text-sm truncate">{refAudioFile.name}</p>
                  <p class="text-xs opacity-60">
                    {refAudioDuration > 0 ? refAudioDuration.toFixed(1) + 's' : ''}
                  </p>
                </div>
                <audio controls class="h-9 max-w-[220px]" src={refAudioPreviewUrl}></audio>
                <button
                  type="button"
                  class="btn btn-circle btn-xs btn-error"
                  on:click={resetRefAudio}
                  aria-label={$_('newVideo.mode.ref2v.audioRemove')}
                >✕</button>
              </div>
            {/if}
            {#if refAudioError}
              <div class="alert alert-error shadow-lg mt-3 py-2">
                <span class="text-sm">{refAudioError}</span>
              </div>
            {/if}
          </div>

          <!-- Reference images (up to 6) -->
          <div class="form-control w-full mt-6">
            <div class="label">
              <span class="label-text font-semibold">{$_('newVideo.mode.ref2v.imagesLabel')}</span>
              <span class="label-text-alt">{$_('newVideo.mode.ref2v.imagesHint')}</span>
            </div>
            <div class="grid grid-cols-2 gap-3">
              {#each refImages as rimg, i}
                <div class="card bg-base-200 rounded-lg p-2">
                  <input
                    id="ref_image_{i + 1}"
                    name="ref_image_{i + 1}"
                    type="file"
                    accept="image/*"
                    class="file-input file-input-bordered file-input-sm file-input-ghost w-full text-xs"
                    bind:this={refImageInputs[i]}
                    on:change={(e) => onRefImageFile(e, i)}
                  />
                  {#if rimg.preview}
                    <div class="relative mt-2">
                      <img src={rimg.preview} alt={`ref image ${i + 1}`} class="w-full h-24 object-cover rounded" />
                      <button
                        type="button"
                        class="btn btn-circle btn-xs btn-error absolute top-1 right-1"
                        on:click={() => removeRefImage(i)}
                        aria-label="Remove"
                      >✕</button>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}
        
        <div class="card-actions justify-end mt-6">
          <button type="submit" class="btn btn-primary btn-lg" disabled={submitting || !isFormValid}>
            {#if submitting}
              <span class="loading loading-spinner"></span>
              {$_('common.uploading')}...
            {:else}
              <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
              {#if mode === 'i2v'}
                {$_('newVideo.startProcessing')}
              {:else if mode === 'fl2v'}
                {$_('newVideo.mode.fl2v.generateButton')}
              {:else}
                {$_('newVideo.mode.ref2v.generateButton')}
              {/if}
            {/if}
          </button>
        </div>
      </form>
    </div>
  </div>

  <div class="alert alert-info shadow-lg mt-6">
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-6 h-6">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
    </svg>
    <div>
      <h3 class="font-bold">{$_('newVideo.nextSteps')}</h3>
      <div class="text-sm">{$_('newVideo.nextStepsMessage')}</div>
    </div>
  </div>
</div>

<style>
  /* Dual-thumb range slider (start/end clip) */
  .dual-range {
    position: relative;
    height: 2rem;
  }
  .dual-range::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 6px;
    transform: translateY(-50%);
    border-radius: 3px;
    background: linear-gradient(
      to right,
      color-mix(in oklch, var(--color-base-content) 20%, transparent) 0%,
      color-mix(in oklch, var(--color-base-content) 20%, transparent) calc(var(--range-a) / var(--range-max) * 100%),
      var(--color-primary) calc(var(--range-a) / var(--range-max) * 100%),
      var(--color-primary) calc(var(--range-b) / var(--range-max) * 100%),
      color-mix(in oklch, var(--color-base-content) 20%, transparent) calc(var(--range-b) / var(--range-max) * 100%),
      color-mix(in oklch, var(--color-base-content) 20%, transparent) 100%
    );
  }
  .dual-range input[type='range'] {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    background: transparent;
    pointer-events: none;
    -webkit-appearance: none;
    appearance: none;
    z-index: 1;
  }
  .dual-range input[type='range'].z-raise {
    z-index: 2;
  }
  .dual-range input[type='range']::-webkit-slider-runnable-track {
    background: transparent;
    height: 6px;
  }
  .dual-range input[type='range']::-moz-range-track {
    background: transparent;
    height: 6px;
  }
  .dual-range input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    pointer-events: auto;
    width: 18px;
    height: 18px;
    border-radius: 9999px;
    background: var(--color-primary);
    border: 2px solid var(--color-base-100);
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.3);
    margin-top: -6px;
    cursor: grab;
  }
  .dual-range input[type='range']::-webkit-slider-thumb:active {
    cursor: grabbing;
  }
  .dual-range input[type='range']::-moz-range-thumb {
    pointer-events: auto;
    width: 16px;
    height: 16px;
    border-radius: 9999px;
    background: var(--color-primary);
    border: 2px solid var(--color-base-100);
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.3);
    cursor: grab;
  }
  .dual-range input[type='range']::-moz-range-thumb:active {
    cursor: grabbing;
  }
</style>
