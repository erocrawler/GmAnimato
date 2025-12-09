export type VideoStatus = 'uploaded' | 'in_queue' | 'processing' | 'completed' | 'failed';

export function createStatusTranslations(translate: (key: string) => string): Record<VideoStatus, string> {
  return {
    'uploaded': translate('videos.status.uploaded'),
    'in_queue': translate('videos.status.in_queue'),
    'processing': translate('videos.status.processing'),
    'completed': translate('videos.status.completed'),
    'failed': translate('videos.status.failed')
  };
}

export function getTranslatedStatus(status: string, statusMap: Record<string, string>): string {
  return statusMap[status] || status;
}
