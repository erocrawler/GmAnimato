import path from 'path';

export async function annotateImage(filePath: string): Promise<{ tags: string[]; suggested_prompts: string[] }> {
  // Very small local stub for image recognition.
  // Replace this with a real vision API call (AWS Rekognition, Google Vision, etc.)
  const name = path.basename(filePath).toLowerCase();
  const tags: string[] = [];

  if (name.includes('dog') || name.includes('puppy')) tags.push('dog', 'pet', 'animal');
  if (name.includes('cat') || name.includes('kitten')) tags.push('cat', 'pet', 'animal');
  if (name.includes('beach') || name.includes('sea')) tags.push('beach', 'ocean', 'coast');
  if (name.includes('city') || name.includes('street')) tags.push('city', 'urban');

  if (tags.length === 0) {
    tags.push('photo', 'scene');
  }

  const suggested_prompts = [
    `A cinematic video of ${tags.slice(0, 3).join(', ')}`,
    `Slow-motion close-up of ${tags[0]}`
  ];

  return { tags, suggested_prompts };
}
