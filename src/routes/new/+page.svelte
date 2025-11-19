<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';

  let imageFile: File | null = null;
  let preview = '';
  let validFile = false;
  let submitting = false;
  let message = '';
  let messageType: 'success' | 'error' = 'error';
  let formElement: HTMLFormElement;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

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

  // Returns an error message string if invalid, or null when valid
  function validateFile(f: File): Promise<string | null> {
    return new Promise((resolve) => {
      if (f.size > MAX_IMAGE_BYTES) {
        resolve(`File is too large. Maximum size is ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB.`);
        return;
      }

      if (!f.type || !f.type.startsWith('image/')) {
        // still try to load it as an image (some browsers may not provide type)
        resolve('Selected file does not appear to be an image.');
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
        resolve('The file could not be parsed as an image.');
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
            preview = '';
            validFile = false;
            await goto(`/new/review/${entry.id}`);
            return;
          }
          message = 'Image uploaded.';
          messageType = 'success';
        } else if (result.data.error) {
          message = 'Upload failed: ' + result.data.error;
          messageType = 'error';
        }
      } else {
        message = 'An unexpected error occurred';
        messageType = 'error';
      }
      setTimeout(() => (message = ''), 3000);
    };
  }
</script>

<div class="max-w-2xl mx-auto">
  <h1 class="text-4xl font-bold mb-8">Create a new Image→Video job</h1>

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
        <div class="form-control w-full">
          <label class="label" for="image">
            <span class="label-text font-semibold">Select Image</span>
            <span class="label-text-alt">Max 5MB</span>
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
              <span class="label-text font-semibold">Preview</span>
            </div>
            <div class="rounded-lg overflow-hidden shadow-lg">
              <img src={preview} alt="preview" class="w-full max-h-96 object-contain bg-base-200" />
            </div>
          </div>
        {/if}
        
        <div class="card-actions justify-end mt-6">
          <button type="submit" class="btn btn-primary btn-lg" disabled={submitting || !imageFile}>
            {#if submitting}
              <span class="loading loading-spinner"></span>
              Uploading...
            {:else}
              <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
              Start Processing
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
      <h3 class="font-bold">Next Steps</h3>
      <div class="text-sm">After upload, you'll be able to add prompts and generate your video.</div>
    </div>
  </div>
</div>
