<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';

  export let data;

  let username = '';
  let password = '';
  let error = '';
  let loading = false;
  let isRegister = false;
  let registrationEnabled = data.registrationEnabled ?? true;

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    error = '';
    loading = true;

    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: isRegister ? 'register' : 'login',
          username,
          password,
        }),
      });

      const json = await res.json();

      if (!res.ok) {
        error = json.error || 'Authentication failed';
        return;
      }

      // Success - invalidate all data and redirect to home
      await invalidateAll();
      await goto('/');
    } catch (err) {
      error = String(err);
    } finally {
      loading = false;
    }
  }

  function toggleMode() {
    if (isRegister && !registrationEnabled) return; // Prevent toggling to register mode if disabled
    isRegister = !isRegister;
    error = '';
  }
</script>

<div class="hero min-h-screen bg-base-200">
  <div class="hero-content flex-col lg:flex-row-reverse">
    <div class="text-center lg:text-left lg:ml-8">
      <div class="mb-6 flex justify-center lg:justify-start">
        <img src="/images/LOGO_COLOR.png" alt="Logo" class="w-full h-auto" />
      </div>
      <h1 class="text-5xl font-bold">{isRegister ? 'Join' : 'Welcome Back'}!</h1>
      <p class="py-6">
        {#if isRegister}
          Create your account to start generating amazing videos from your images.
        {:else}
          Login to continue creating and managing your video projects.
        {/if}
      </p>
    </div>
    
    <div class="card flex-shrink-0 w-full max-w-sm shadow-2xl bg-base-100">
      <form class="card-body" on:submit={handleSubmit} class:opacity-50={isRegister && !registrationEnabled} class:pointer-events-none={isRegister && !registrationEnabled}>
        <div class="text-center mb-4">
          <h2 class="text-2xl font-bold">{isRegister ? 'Create Account' : 'Login'}</h2>
        </div>

        {#if isRegister && !registrationEnabled}
          <div class="alert alert-warning shadow-lg mb-4">
            <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4v2m0 0v2m0-6V9m6 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>Registration is currently disabled. Please login with an existing account.</span>
          </div>
        {/if}

        {#if error}
          <div class="alert alert-error shadow-lg mb-4">
            <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>{error}</span>
          </div>
        {/if}

        <div class="form-control">
          <label class="label" for="username">
            <span class="label-text">Username</span>
          </label>
          <input
            id="username"
            type="text"
            bind:value={username}
            placeholder="Enter username"
            class="input input-bordered"
            disabled={loading}
            required
          />
        </div>

        <div class="form-control">
          <label class="label" for="password">
            <span class="label-text">Password</span>
          </label>
          <input
            id="password"
            type="password"
            bind:value={password}
            placeholder="Enter password"
            class="input input-bordered"
            disabled={loading}
            required
          />
        </div>

        <div class="form-control mt-6">
          <button type="submit" class="btn btn-primary" disabled={loading}>
            {#if loading}
              <span class="loading loading-spinner"></span>
              Loading...
            {:else}
              {isRegister ? 'Create Account' : 'Login'}
            {/if}
          </button>
        </div>

        <div class="divider">OR</div>

        <div class="form-control">
          <a href="/auth/gmgard" class="btn btn-outline gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd" />
            </svg>
            Sign in with GmGard
          </a>
        </div>

        <div class="divider"></div>

        <div class="text-center">
          {#if isRegister}
            <p class="text-sm">Already have an account?</p>
            <button type="button" class="btn btn-link btn-sm" on:click={toggleMode}>Login</button>
          {:else}
            {#if registrationEnabled}
              <p class="text-sm">Don't have an account?</p>
              <button type="button" class="btn btn-link btn-sm" on:click={toggleMode}>Register</button>
            {:else}
              <p class="text-sm text-gray-500">Registration is currently disabled</p>
            {/if}
          {/if}
        </div>
      </form>
    </div>
  </div>
</div>
