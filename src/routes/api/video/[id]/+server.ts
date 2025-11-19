import type { RequestHandler } from '@sveltejs/kit';
import { getVideoById } from '$lib/db';
import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = path.resolve('data');
const DB_FILE = path.join(DATA_DIR, 'videos.json');

export const DELETE: RequestHandler = async ({ params, locals }) => {
  try {
    // Check authentication
    if (!locals.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
        status: 401, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    const id = params.id;
    if (!id) {
      return new Response(JSON.stringify({ error: 'missing id' }), { 
        status: 400, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    // Read current data
    const txt = await fs.readFile(DB_FILE, 'utf-8');
    const videos = JSON.parse(txt);

    // Find the video
    const video = videos.find((v: any) => v.id === id);
    if (!video) {
      return new Response(JSON.stringify({ error: 'not found' }), { 
        status: 404, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    // Check ownership
    if (video.user_id !== locals.user.id) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { 
        status: 403, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    // Don't allow deletion of processing videos
    if (video.status === 'processing') {
      return new Response(JSON.stringify({ error: 'Cannot delete video while processing' }), { 
        status: 400, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    // Remove the video from the array
    const filtered = videos.filter((v: any) => v.id !== id);
    
    // Write back to file
    await fs.writeFile(DB_FILE, JSON.stringify(filtered, null, 2), 'utf-8');

    return new Response(JSON.stringify({ success: true }), { 
      headers: { 'Content-Type': 'application/json' } 
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
};
