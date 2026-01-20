<script lang="ts">
    import { _ } from "svelte-i18n";

    let {
        video,
        workflow = undefined,
        loraPresets = [],
        showAuthor = false,
        authorName = undefined,
    }: {
        video: any;
        workflow?: any;
        loraPresets?: any[];
        showAuthor?: boolean;
        authorName?: string;
    } = $props();

    function getLoraDisplayName(loraId: string): string {
        const preset = loraPresets?.find((p) => p.id === loraId);
        if (preset?.label) return preset.label;
        // Extract filename without path and show just the filename
        const filename = loraId.split("/").pop() || loraId;
        return filename;
    }
</script>

<div class="text-sm space-y-1">
    {#if showAuthor && authorName}
        <p><strong>{$_("videoDetail.author")}:</strong> {authorName}</p>
    {/if}
    <p>
        <strong>{$_("videoDetail.created")}:</strong>
        {new Date(video.created_at).toLocaleString()}
    </p>
    {#if video.processing_started_at}
        <p>
            <strong>{$_("videoDetail.processingStarted")}:</strong>
            {new Date(video.processing_started_at).toLocaleString()}
        </p>
    {/if}
    {#if video.processing_started_at && video.processing_time_ms}
        {@const completedAt = new Date(
            new Date(video.processing_started_at).getTime() +
                video.processing_time_ms,
        )}
        <p>
            <strong>{$_("videoDetail.processingCompleted")}:</strong>
            {completedAt.toLocaleString()}
        </p>
    {/if}
    {#if video.status}
        <p><strong>{$_("videoDetail.status")}:</strong> {video.status}</p>
    {/if}
    {#if video.is_published}
        <p>
            <strong>{$_("videoDetail.published")}:</strong>
            {$_("common.yes")}
        </p>
    {/if}
    {#if workflow}
        <details class="mt-2">
            <summary class="cursor-pointer"
                ><strong>{$_("videoDetail.workflow")}:</strong>
                {workflow.name}</summary
            >
            <div class="ml-4 mt-2 space-y-1">
                {#if video.iteration_steps}
                    <p>
                        <strong>{$_("videoDetail.iterationSteps")}:</strong>
                        {video.iteration_steps}
                        {$_("videoDetail.steps")}
                    </p>
                {/if}
                {#if video.video_duration}
                    <p>
                        <strong>{$_("videoDetail.duration")}:</strong>
                        {video.video_duration}s
                    </p>
                {/if}
                {#if video.video_resolution}
                    <p>
                        <strong>{$_("videoDetail.resolution")}:</strong>
                        {video.video_resolution}
                    </p>
                {/if}
            </div>
        </details>
    {/if}
    {#if video.lora_weights && Object.keys(video.lora_weights).length > 0}
        <details class="mt-2">
            <summary class="cursor-pointer font-semibold"
                >{$_("videoDetail.lorasUsed")} ({Object.keys(video.lora_weights)
                    .length})</summary
            >
            <div class="ml-4 mt-2 space-y-1">
                {#each Object.entries(video.lora_weights) as [loraId, weight]}
                    <p class="text-xs">
                        <span class="opacity-70"
                            >{getLoraDisplayName(loraId)}:</span
                        >
                        {weight}
                    </p>
                {/each}
            </div>
        </details>
    {/if}
    {#if video.additional_options}
        <details class="mt-2">
            <summary class="cursor-pointer font-semibold"
                >{$_("review.additionalOptions.title")}</summary
            >
            <div class="ml-4 mt-2 space-y-1">
                {#if video.additional_options.motion_scale !== undefined}
                    <p class="text-xs">
                        <span class="opacity-70"
                            >{$_(
                                "review.additionalOptions.motionScale.title",
                            )}:</span
                        >
                        {video.additional_options.motion_scale.toFixed(1)}
                    </p>
                {/if}
                {#if video.additional_options.freelong_blend_strength !== undefined}
                    <p class="text-xs">
                        <span class="opacity-70"
                            >{$_(
                                "review.additionalOptions.freeLong.title",
                            )}:</span
                        >
                        {video.additional_options.freelong_blend_strength.toFixed(
                            2,
                        )}
                    </p>
                {/if}
            </div>
        </details>
    {/if}
</div>
