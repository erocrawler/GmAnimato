<script lang="ts">
  interface Props {
    currentPage: number;
    totalPages: number;
    onPageChange: (page: number) => void;
  }

  let { currentPage, totalPages, onPageChange }: Props = $props();
</script>

{#if totalPages > 1}
  <div class="flex justify-center mt-8">
    <div class="join">
      <button 
        class="join-item btn" 
        disabled={currentPage === 1}
        onclick={() => onPageChange(currentPage - 1)}
      >
        «
      </button>
      {#each Array.from({ length: totalPages }, (_, i) => i + 1) as pageNum}
        {#if pageNum === 1 || pageNum === totalPages || Math.abs(pageNum - currentPage) <= 2}
          <button 
            class="join-item btn" 
            class:btn-active={pageNum === currentPage}
            onclick={() => onPageChange(pageNum)}
          >
            {pageNum}
          </button>
        {:else if pageNum === currentPage - 3 || pageNum === currentPage + 3}
          <button class="join-item btn btn-disabled">...</button>
        {/if}
      {/each}
      <button 
        class="join-item btn" 
        disabled={currentPage === totalPages}
        onclick={() => onPageChange(currentPage + 1)}
      >
        »
      </button>
    </div>
  </div>
{/if}
