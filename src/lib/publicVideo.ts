/**
 * Videos shown to people other than their owner (gallery pages and feeds).
 *
 * The webhook that finishes a job authorises on the video's job_id alone, so the job id is a credential: it must only
 * reach the owner (kickoff response) and the worker, never a gallery viewer.
 */
export function toPublicVideo<T extends { job_id?: unknown }>(video: T): Omit<T, 'job_id'> {
  const { job_id: _jobId, ...rest } = video;
  return rest;
}
