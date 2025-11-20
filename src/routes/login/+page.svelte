<script lang="ts">
  import { goto } from '$app/navigation';

  let username = '';
  let password = '';
  let error = '';
  let loading = false;
  let isRegister = false;

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

      // Success - redirect to home
      await goto('/');
    } catch (err) {
      error = String(err);
    } finally {
      loading = false;
    }
  }

  function toggleMode() {
    isRegister = !isRegister;
    error = '';
  }
</script>

<div class="hero min-h-screen bg-base-200">
  <div class="hero-content flex-col lg:flex-row-reverse">
    <div class="text-center lg:text-left lg:ml-8">
      <div class="mb-6 flex justify-center lg:justify-start">
        <img src="/images/LOGO.png" alt="Logo" class="w-full h-auto" />
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
      <form class="card-body" on:submit={handleSubmit}>
        <div class="text-center mb-4">
          <h2 class="text-2xl font-bold">{isRegister ? 'Create Account' : 'Login'}</h2>
        </div>

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

        <div class="text-center">
          {#if isRegister}
            <p class="text-sm">Already have an account?</p>
            <button type="button" class="btn btn-link btn-sm" on:click={toggleMode}>Login</button>
          {:else}
            <p class="text-sm">Don't have an account?</p>
            <button type="button" class="btn btn-link btn-sm" on:click={toggleMode}>Register</button>
          {/if}
        </div>
      </form>
    </div>
  </div>
</div>
