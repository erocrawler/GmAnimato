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
 * Find a node by class_type and optionally by predicate function
 * @param workflow The workflow object
 * @param classType The class_type to search for
 * @param predicate Optional predicate function to filter nodes, or title pattern (string/RegExp)
 * @returns The node ID if found, otherwise null
 */
export function findNode(
  workflow: any, 
  classType: string, 
  predicate?: ((node: any) => boolean) | string | RegExp
): string | null {
  const wf = workflow?.input?.workflow;
  if (!wf) return null;
  
  for (const [nodeId, node] of Object.entries(wf)) {
    if ((node as any).class_type === classType) {
      if (!predicate) return nodeId;
      
      // If predicate is a function, use it to test the node
      if (typeof predicate === 'function') {
        if (predicate(node)) return nodeId;
      }
      // If predicate is a string or regex, match against title
      else {
        const title = (node as any)._meta?.title || '';
        if (typeof predicate === 'string') {
          if (title.includes(predicate)) return nodeId;
        } else if (predicate instanceof RegExp) {
          if (predicate.test(title)) return nodeId;
        }
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
  const totalPixels = resolution === '720p' ? 921600 : 409600;
  let aspectRatio = imageWidth / imageHeight;
  
  // Clamp aspect ratio to reasonable range:
  // 1:2.2 (phone full screen portrait) to 2.2:1 (cinema widescreen)
  const minAspectRatio = 1 / 2.2;  // ~0.45
  const maxAspectRatio = 2.2;       // 2.2
  aspectRatio = Math.max(minAspectRatio, Math.min(maxAspectRatio, aspectRatio));
  
  // Calculate dimensions that fit the total pixel count while maintaining aspect ratio
  // width * height = totalPixels
  // width / height = aspectRatio
  // width = sqrt(totalPixels * aspectRatio)
  // height = sqrt(totalPixels / aspectRatio)
  const width = Math.sqrt(totalPixels * aspectRatio);
  const height = Math.sqrt(totalPixels / aspectRatio);
  
  // Round both dimensions to multiples of 16
  let finalWidth = roundToMultipleOf16(width);
  let finalHeight = roundToMultipleOf16(height);
  
  // Ensure minimum dimensions of 256 pixels
  if (finalWidth < 256) finalWidth = 256;
  if (finalHeight < 256) finalHeight = 256;
  
  return {
    width: finalWidth,
    height: finalHeight
  };
}

/**
 * Add upscale nodes to workflow for 720p generation
 * @param workflow The workflow object to modify
 * @param decodeNodeId The VAE decode node ID to connect from
 * @param videoCombineNodeId The video combine node ID to update
 * @param sourceWidth Source video width (480p)
 * @param sourceHeight Source video height (480p)
 * @param imageWidth Original image width
 * @param imageHeight Original image height
 */
export function add720pUpscaleNodes(
  workflow: any,
  decodeNodeId: string,
  videoCombineNodeId: string,
  sourceWidth: number,
  sourceHeight: number,
  imageWidth: number,
  imageHeight: number
): void {
  // Calculate 720p target dimensions using the same logic
  const { width: targetWidth, height: targetHeight } = calculateVideoDimensions(
    imageWidth,
    imageHeight,
    '720p'
  );
  
  // Add upscale model loader node
  const modelLoaderNodeId = '998:upscale_model';
  workflow.input.workflow[modelLoaderNodeId] = {
    inputs: {
      model_name: 'RealESRGAN_x2plus.pth'
    },
    class_type: 'UpscaleModelLoader',
    _meta: {
      title: 'Load Upscale Model'
    }
  };
  
  // Add upscale image node
  const upscaleNodeId = '999:upscale720p';
  workflow.input.workflow[upscaleNodeId] = {
    inputs: {
      upscale_model: [modelLoaderNodeId, 0],
      image: [decodeNodeId, 0]
    },
    class_type: 'ImageUpscaleWithModel',
    _meta: {
      title: 'Upscale to 720p'
    }
  };
  
  // Add resize node to ensure exact target dimensions
  const resizeNodeId = '997:resize_exact';
  workflow.input.workflow[resizeNodeId] = {
    inputs: {
      upscale_method: 'lanczos',
      width: targetWidth,
      height: targetHeight,
      crop: 'disabled',
      image: [upscaleNodeId, 0]
    },
    class_type: 'ImageScale',
    _meta: {
      title: 'Resize to Exact 720p'
    }
  };
  
  // Update VideoCombine to use resized images
  const videoCombineInputs = getNodeInputs(workflow, videoCombineNodeId);
  if (videoCombineInputs) {
    videoCombineInputs.images = [resizeNodeId, 0];
  }
  
  // Add node weights
  workflow.input.node_weights[modelLoaderNodeId] = 1.0;
  workflow.input.node_weights[upscaleNodeId] = 8.0;
  workflow.input.node_weights[resizeNodeId] = 2.0;
}
