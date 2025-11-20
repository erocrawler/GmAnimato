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

export type User = {
  id: string;
  username: string;
  email?: string;
  password_hash: string; // Hashed password
  created_at: string;
  updated_at?: string;
};

export type UserPublic = Omit<User, 'password_hash'>;

export interface IDatabase {
  // Video methods
  createVideoEntry(entry: Omit<VideoEntry, 'id' | 'created_at'> & { id?: string }): Promise<VideoEntry>;
  getVideosByUser(user_id: string): Promise<VideoEntry[]>;
  getActiveJobsByUser(user_id: string): Promise<VideoEntry[]>;
  getPublishedVideos(): Promise<VideoEntry[]>;
  getVideoById(id: string): Promise<VideoEntry | undefined>;
  updateVideo(id: string, patch: Partial<VideoEntry>): Promise<VideoEntry | null>;
  toggleLike(videoId: string, userId: string): Promise<VideoEntry | null>;
  
  // User methods
  createUser(username: string, password_hash: string, email?: string): Promise<User>;
  getUserById(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  updateUser(id: string, patch: Partial<Omit<User, 'id' | 'created_at'>>): Promise<User | null>;
  deleteUser(id: string): Promise<boolean>;
}
