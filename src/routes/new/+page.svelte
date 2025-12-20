<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { _ } from 'svelte-i18n';

  type Mode = 'i2v' | 'fl2v';
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
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

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
  }

  function onFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0] || null;
    imageFile = f;
    validFile = false;
    if (!f) {
      preview = '';
      return;
    }

    validateFile(f).then((err) => {
      if (err) {
        message = err;
        messageType = 'error';
        preview = '';
        // clear message after timeout
        setTimeout(() => (message = ''), 4000);
        return;
      }

      validFile = true;
      const reader = new FileReader();
      reader.onload = () => (preview = String(reader.result));
      reader.readAsDataURL(f);
    });
  }

  function onFirstFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0] || null;
    firstImageFile = f;
    validFirstFile = false;
    if (!f) {
      firstPreview = '';
      return;
    }

    validateFile(f).then((err) => {
      if (err) {
        message = err;
        messageType = 'error';
        firstPreview = '';
        setTimeout(() => (message = ''), 4000);
        return;
      }

      validFirstFile = true;
      const reader = new FileReader();
      reader.onload = () => (firstPreview = String(reader.result));
      reader.readAsDataURL(f);
    });
  }

  function onLastFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0] || null;
    lastImageFile = f;
    validLastFile = false;
    if (!f) {
      lastPreview = '';
      return;
    }

    validateFile(f).then((err) => {
      if (err) {
        message = err;
        messageType = 'error';
        lastPreview = '';
        setTimeout(() => (message = ''), 4000);
        return;
      }

      validLastFile = true;
      const reader = new FileReader();
      reader.onload = () => (lastPreview = String(reader.result));
      reader.readAsDataURL(f);
    });
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

  function handleUploadEnhance() {
    submitting = true;
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

  $: isFormValid = mode === 'i2v' ? validFile : (validFirstFile && validLastFile);
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

  <div class="card bg-base-100 shadow-xl">
    <div class="card-body">
      <form bind:this={formElement} method="post" enctype="multipart/form-data" use:enhance={handleUploadEnhance}>
        <!-- Mode Selection -->
        <div class="form-control w-full mb-6">
          <div class="label">
            <span class="label-text font-semibold">{$_('newVideo.mode.title')}</span>
          </div>
          <div class="flex gap-4">
            <label class="label cursor-pointer gap-2 flex-1 border rounded-lg p-4" class:border-primary={mode === 'i2v'} class:bg-base-200={mode === 'i2v'}>
              <input type="radio" name="mode" value="i2v" bind:group={mode} on:change={onModeChange} class="radio radio-primary" />
              <div class="flex-1">
                <span class="label-text font-semibold">{$_('newVideo.mode.i2v.title')}</span>
                <p class="text-xs opacity-70 mt-1">{$_('newVideo.mode.i2v.description')}</p>
              </div>
            </label>
            <label class="label cursor-pointer gap-2 flex-1 border rounded-lg p-4" class:border-primary={mode === 'fl2v'} class:bg-base-200={mode === 'fl2v'}>
              <input type="radio" name="mode" value="fl2v" bind:group={mode} on:change={onModeChange} class="radio radio-primary" />
              <div class="flex-1">
                <span class="label-text font-semibold">{$_('newVideo.mode.fl2v.title')}</span>
                <p class="text-xs opacity-70 mt-1">{$_('newVideo.mode.fl2v.description')}</p>
              </div>
            </label>
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
              on:change={onFile} 
              class="file-input file-input-bordered file-input-primary w-full"
              required 
            />
          </div>
          
          {#if preview}
            <div class="mt-6">
              <div class="label">
                <span class="label-text font-semibold">{$_('newVideo.preview')}</span>
              </div>
              <div class="rounded-lg overflow-hidden shadow-lg">
                <img src={preview} alt="preview" class="w-full max-h-96 object-contain bg-base-200" />
              </div>
            </div>
          {/if}
        {:else}
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
                on:change={onFirstFile} 
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
                on:change={onLastFile} 
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
              {:else}
                {$_('newVideo.mode.fl2v.generateButton')}
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
