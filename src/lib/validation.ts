/**
 * Input validation utilities for database field limits
 */

export const DB_LIMITS = {
  USERNAME: 50,
  EMAIL: 255,
  PASSWORD_HASH: 255,
  ORIGINAL_IMAGE_URL: 500,
  PROMPT: 2000,
  TAGS_JSON: 1000,
  SUGGESTED_PROMPTS_JSON: 2000,
  JOB_ID: 200,
  FINAL_VIDEO_URL: 500,
} as const;

export type ValidationError = {
  field: string;
  message: string;
  limit: number;
  actual: number;
};

/**
 * Validate a string field against its database limit
 */
export function validateStringLength(
  value: string | undefined | null,
  fieldName: string,
  maxLength: number
): ValidationError | null {
  if (!value) return null;
  
  if (value.length > maxLength) {
    return {
      field: fieldName,
      message: `${fieldName} exceeds maximum length of ${maxLength} characters`,
      limit: maxLength,
      actual: value.length,
    };
  }
  
  return null;
}

/**
 * Validate JSON array serialization against database limit
 */
export function validateJsonArrayLength(
  array: string[] | undefined | null,
  fieldName: string,
  maxLength: number
): ValidationError | null {
  if (!array || array.length === 0) return null;
  
  const jsonString = JSON.stringify(array);
  if (jsonString.length > maxLength) {
    return {
      field: fieldName,
      message: `${fieldName} (as JSON) exceeds maximum length of ${maxLength} characters`,
      limit: maxLength,
      actual: jsonString.length,
    };
  }
  
  return null;
}

/**
 * Validate video entry fields
 */
export function validateVideoEntry(data: {
  original_image_url?: string;
  prompt?: string;
  tags?: string[];
  suggested_prompts?: string[];
  job_id?: string;
  final_video_url?: string;
}): ValidationError[] {
  const errors: ValidationError[] = [];

  const checks = [
    validateStringLength(data.original_image_url, 'original_image_url', DB_LIMITS.ORIGINAL_IMAGE_URL),
    validateStringLength(data.prompt, 'prompt', DB_LIMITS.PROMPT),
    validateJsonArrayLength(data.tags, 'tags', DB_LIMITS.TAGS_JSON),
    validateJsonArrayLength(data.suggested_prompts, 'suggested_prompts', DB_LIMITS.SUGGESTED_PROMPTS_JSON),
    validateStringLength(data.job_id, 'job_id', DB_LIMITS.JOB_ID),
    validateStringLength(data.final_video_url, 'final_video_url', DB_LIMITS.FINAL_VIDEO_URL),
  ];

  for (const error of checks) {
    if (error) errors.push(error);
  }

  return errors;
}

/**
 * Validate user fields
 */
export function validateUser(data: {
  username?: string;
  email?: string;
}): ValidationError[] {
  const errors: ValidationError[] = [];

  const checks = [
    validateStringLength(data.username, 'username', DB_LIMITS.USERNAME),
    validateStringLength(data.email, 'email', DB_LIMITS.EMAIL),
  ];

  for (const error of checks) {
    if (error) errors.push(error);
  }

  return errors;
}

/**
 * Format validation errors into a user-friendly message
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  if (errors.length === 0) return '';
  if (errors.length === 1) {
    const e = errors[0];
    return `${e.message} (${e.actual}/${e.limit} characters)`;
  }
  return errors.map(e => `${e.field}: ${e.actual}/${e.limit} characters`).join(', ');
}
