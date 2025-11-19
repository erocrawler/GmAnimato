import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = path.resolve('data');
const DB_FILE = path.join(DATA_DIR, 'videos.json');

export type VideoEntry = {
  id: string;
  user_id: string;
  original_image_url: string;
  prompt?: string;
  tags?: string[];
  suggested_prompts?: string[];
  status: 'uploaded' | 'in_queue' | 'processing' | 'completed' | 'failed';
  job_id?: string; // RunPod job ID for status polling
  final_video_url?: string;
  is_published?: boolean;
  likes?: string[]; // Array of user_ids who liked this video
  created_at: string;
};

async function ensureDB() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.access(DB_FILE);
  } catch (err) {
    await fs.writeFile(DB_FILE, '[]', 'utf-8');
  }
}

async function readAll(): Promise<VideoEntry[]> {
  await ensureDB();
  const txt = await fs.readFile(DB_FILE, 'utf-8');
  return JSON.parse(txt) as VideoEntry[];
}

async function writeAll(rows: VideoEntry[]) {
  await ensureDB();
  await fs.writeFile(DB_FILE, JSON.stringify(rows, null, 2), 'utf-8');
}

export async function createVideoEntry(entry: Omit<VideoEntry, 'id' | 'created_at'> & { id?: string }) {
  const rows = await readAll();
  const id = entry.id || String(Date.now()) + '-' + Math.floor(Math.random() * 1000);
  const created_at = new Date().toISOString();
  const row: VideoEntry = { ...entry, id, created_at } as VideoEntry;
  rows.push(row);
  await writeAll(rows);
  return row;
}

export async function getVideosByUser(user_id: string) {
  const rows = await readAll();
  return rows.filter((r) => r.user_id === user_id);
}

export async function getPublishedVideos() {
  const rows = await readAll();
  return rows.filter((r) => r.is_published);
}

export async function getVideoById(id: string) {
  const rows = await readAll();
  return rows.find((r) => r.id === id);
}

export async function updateVideo(id: string, patch: Partial<VideoEntry>) {
  const rows = await readAll();
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  rows[idx] = { ...rows[idx], ...patch } as VideoEntry;
  await writeAll(rows);
  return rows[idx];
}

export async function toggleLike(videoId: string, userId: string) {
  const rows = await readAll();
  const idx = rows.findIndex((r) => r.id === videoId);
  if (idx === -1) return null;
  
  const video = rows[idx];
  const likes = video.likes || [];
  const userIndex = likes.indexOf(userId);
  
  if (userIndex > -1) {
    // Unlike
    likes.splice(userIndex, 1);
  } else {
    // Like
    likes.push(userId);
  }
  
  rows[idx] = { ...video, likes };
  await writeAll(rows);
  return rows[idx];
}
