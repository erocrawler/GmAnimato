import type { Actions, PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { getVideosByUser, getWorkflows } from '$lib/db';
import { createDraftFromUploadForm, resolveMaxRefVideoSeconds } from '$lib/uploadForm';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) {
    throw redirect(303, '/login');
  }
  // Completed videos the user can reuse as a ref video (proxied URLs load in a
  // same-origin <video>, so client-side clipping works without CORS issues).
  let reusableVideos: { id: string; prompt: string; url: string }[] = [];
  try {
    const page = await getVideosByUser(locals.user.id, 1, 20, {
      status: 'completed',
      sortBy: 'completion'
    });
    reusableVideos = (page.videos ?? [])
      .filter((v) => v.final_video_url)
      .map((v) => ({ id: v.id, prompt: v.prompt || '', url: v.final_video_url! }));
  } catch (e) {
    console.error('[New] Failed to load reusable videos:', e);
  }
  // Hide the ref2v mode until an admin has configured a ref2v workflow
  // (jobs can't run without one). Active (non-deleted) workflows only.
  let hasRef2vWorkflow = false;
  try {
    const workflows = await getWorkflows();
    hasRef2vWorkflow = workflows.some((w) => w.workflowType === 'ref2v');
  } catch (e) {
    console.error('[New] Failed to load workflows:', e);
  }

  // Ref2V reference-video length cap by tier, so the client can clip/limit
  // the uploaded ref video accordingly (free 6s, advanced/paid 15s).
  const maxRefVideoSeconds = await resolveMaxRefVideoSeconds(locals.user?.roles);

  return { reusableVideos, hasRef2vWorkflow, maxRefVideoSeconds };
};

export const actions: Actions = {
  default: async ({ request, locals }) => {
    if (!locals.user) return { error: 'unauthenticated' };
    const form = await request.formData();
    // Validation + S3 upload + draft creation are shared with POST /api/uploads.
    return createDraftFromUploadForm(form, locals.user);
  }
};
