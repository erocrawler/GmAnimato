/**
 * Shared utilities for workflow builders
 */

/**
 * Default negative prompt for video generation workflows
 */
export const DEFAULT_NEGATIVE_PROMPT = "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走，阴茎变形，脸部变形，画面转场，rapid mouth movement";

/**
 * Round to nearest multiple of 16
 */
export function roundToMultipleOf16(value: number): number {
  return Math.round(value / 16) * 16;
}

/**
 * Find a node by class_type and optionally by title
 * @param workflow The workflow object
 * @param classType The class_type to search for
 * @param titlePattern Optional title pattern to match (can be substring or regex)
 * @returns The node ID if found, otherwise null
 */
export function findNode(workflow: any, classType: string, titlePattern?: string | RegExp): string | null {
  const wf = workflow?.input?.workflow;
  if (!wf) return null;
  
  for (const [nodeId, node] of Object.entries(wf)) {
    if ((node as any).class_type === classType) {
      if (!titlePattern) return nodeId;
      
      const title = (node as any)._meta?.title || '';
      if (typeof titlePattern === 'string') {
        if (title.includes(titlePattern)) return nodeId;
      } else if (titlePattern instanceof RegExp) {
        if (titlePattern.test(title)) return nodeId;
      }
    }
  }
  
  return null;
}

/**
 * Get node inputs safely
 */
export function getNodeInputs(workflow: any, nodeId: string | null): any {
  if (!nodeId) return null;
  return workflow?.input?.workflow?.[nodeId]?.inputs;
}

/**
 * Calculate video dimensions based on image aspect ratio and resolution
 * @param imageWidth Original image width
 * @param imageHeight Original image height
 * @param resolution Target resolution (480p or 720p)
 * @returns {width, height} Video dimensions (both multiples of 16)
 */
export function calculateVideoDimensions(
  imageWidth: number,
  imageHeight: number,
  resolution: '480p' | '720p'
): { width: number; height: number } {
  const longSide = resolution === '720p' ? 1280 : 832;
  const squareSide = resolution === '720p' ? 960 : 640;
  const aspectRatio = imageWidth / imageHeight;
  
  // Portrait (taller than wide)
  if (aspectRatio < 0.95) {
    const width = roundToMultipleOf16(longSide * aspectRatio);
    return { width, height: longSide };
  }
  // Landscape (wider than tall)
  else if (aspectRatio > 1.05) {
    const height = roundToMultipleOf16(longSide / aspectRatio);
    return { width: longSide, height };
  }
  // Square (roughly 1:1 ratio, within 5% tolerance)
  else {
    return { width: squareSide, height: squareSide };
  }
}
