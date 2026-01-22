<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { _ } from 'svelte-i18n';
  import { onMount } from 'svelte';

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
  let isDraggingOver = false;
  let dragCounter = 0;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
  let lastDragoverTimestamp = 0;
  let dragoverCheckInterval: ReturnType<typeof setInterval> | null = null;

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

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
    lastDragoverTimestamp = Date.now();
    
    if (!isDraggingOver) {
      console.log('Drag started, mode:', mode);
    }
    
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
    console.log('handleDrop called, mode:', mode);
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    isDraggingOver = false;
    lastDragoverTimestamp = 0;

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    if (mode === 'i2v') {
      // For i2v mode, take the first image file
      handleFileInput(imageFiles[0], 'image');
    } else {
      // For fl2v mode, assign intelligently
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
    console.log('handleDropFirstImage called');
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    isDraggingOver = false;
    lastDragoverTimestamp = 0;

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) {
      console.warn('No files in drop event for first image');
      return;
    }

    const imageFile = Array.from(files).find((f) => f.type.startsWith('image/'));
    if (imageFile) {
      console.log('Dropping file to first image:', imageFile.name);
      handleFileInput(imageFile, 'first_image');
    } else {
      console.warn('No image files found in drop');
    }
  }

  function handleDropLastImage(e: DragEvent) {
    console.log('handleDropLastImage called');
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    isDraggingOver = false;
    lastDragoverTimestamp = 0;

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) {
      console.warn('No files in drop event for last image');
      return;
    }

    const imageFile = Array.from(files).find((f) => f.type.startsWith('image/'));
    if (imageFile) {
      console.log('Dropping file to last image:', imageFile.name);
      handleFileInput(imageFile, 'last_image');
    } else {
      console.warn('No image files found in drop');
    }
  }

  function handleFileInput(file: File, inputType: 'image' | 'first_image' | 'last_image') {
    console.log('handleFileInput called with:', inputType, file.name);
    validateFile(file).then((err) => {
      if (err) {
        console.error('File validation error:', err);
        message = err;
        messageType = 'error';
        setTimeout(() => (message = ''), 4000);
        return;
      }

      console.log('File validation passed, setting file for:', inputType);
      if (inputType === 'image') {
        imageFile = file;
        validFile = true;
        const reader = new FileReader();
        reader.onload = () => (preview = String(reader.result));
        reader.readAsDataURL(file);
      } else if (inputType === 'first_image') {
        firstImageFile = file;
        validFirstFile = true;
        const reader = new FileReader();
        reader.onload = () => (firstPreview = String(reader.result));
        reader.readAsDataURL(file);
      } else if (inputType === 'last_image') {
        lastImageFile = file;
        validLastFile = true;
        const reader = new FileReader();
        reader.onload = () => (lastPreview = String(reader.result));
        reader.readAsDataURL(file);
      }
    });
  }

  onMount(() => {
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
