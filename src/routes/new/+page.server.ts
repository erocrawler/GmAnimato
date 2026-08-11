import type { Actions, PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { uploadBufferToS3 } from '$lib/s3';
import { Buffer } from 'buffer';
import { validateAndConvertImage } from '$lib/imageValidation';
import { validateAndConvertVideo, extractVideoPoster, probeVideoDuration, hasAudioFromBuffer, MAX_REF_VIDEO_SECONDS } from '$lib/videoValidation';
