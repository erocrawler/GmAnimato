<script lang="ts">
  // Busy / quota-limit modal for the review page.
  import { _ } from "svelte-i18n";

  export let showBusyModal: boolean = false;
  export let limitType: "user" | "system" | null = null;
  export let busyModalMessage: string = "";
  export let sponsorUrl: string = "";
  export let onClose: () => void = () => {};
</script>

{#if showBusyModal}
  <div class="modal modal-open">
    <div class="modal-box max-w-2xl">
      {#if limitType === "user"}
        <h3 class="font-bold text-2xl mb-4">{$_("review.quotaLimit.title")}</h3>
        <div class="flex justify-center mb-4">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-32 w-32 text-warning"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </div>
        <p class="text-lg mb-4">
          {busyModalMessage}
        </p>
        <p class="text-base mb-6 opacity-80">
          {$_("review.quotaLimit.message")}
        </p>
        <div class="modal-action">
          <button class="btn btn-ghost" on:click={onClose}
            >{$_("common.cancel")}</button
          >
          <a
            href={sponsorUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="btn btn-primary"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            {$_("review.quotaLimit.sponsorButton")}
          </a>
        </div>
      {:else}
        <h3 class="font-bold text-2xl mb-4">{$_("review.serverBusy.title")}</h3>
        <div class="flex justify-center mb-4">
          <img
            src="/images/BUSY.jpg"
            alt="Server Busy"
            class="rounded-lg max-w-full max-h-96 object-contain"
          />
        </div>
        <p class="text-lg mb-4">
          {busyModalMessage}
        </p>
        <div class="modal-action">
          <button
            class="btn btn-primary"
            on:click={onClose}
            >{$_("review.serverBusy.okButton")}</button
          >
        </div>
      {/if}
    </div>
  </div>
{/if}
