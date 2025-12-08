<script lang="ts">
  import { enhance } from '$app/forms';
</script>

<div class="flex items-center justify-center min-h-screen">
  <div class="card w-96 bg-base-100 shadow-xl">
    <div class="card-body">
      <h2 class="card-title">Redirecting to GmGard...</h2>
      <p>Please wait while we redirect you to GmGard for authentication.</p>
      <form method="POST" use:enhance>
        <button type="submit" class="btn btn-primary w-full">
          Continue to GmGard
        </button>
      </form>
    </div>
  </div>
</div>
