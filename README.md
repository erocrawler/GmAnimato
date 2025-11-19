# GmI2V - Image-to-Video Generator

A full-stack SvelteKit application for generating videos from images using AI. Upload an image, refine a prompt, and queue a video generation job.

## Project Structure

```
GmI2V/
  src/
    lib/
      auth.ts          # In-memory user management (dev)
      db.ts            # File-based video entry storage
    routes/
      +layout.svelte   # Root layout
      +page.svelte     # Home page with intro
      login/           # Login/Register UI
      new/             # Upload & queue new video
      videos/          # User's video library (protected)
      gallery/         # Published videos (public)
      api/
        auth/          # Login/Register endpoint
        logout/        # Logout endpoint
        upload/        # File upload endpoint
        i2v/
          kickoff/     # Start I2V job processing
        i2v-webhook/   # Receive job completion callbacks
  hooks.server.ts      # Session management & route protection
  data/
    videos.json        # Persistent video metadata store
  static/
    uploads/           # Uploaded images
```

## Quick Start

### Prerequisites
- Node.js 18+
- npm

### Installation

```bash
cd d:\Projects\GmI2V
npm install
```

### Development

Start the dev server:

```bash
npm run dev
```

Visit `http://localhost:5173/`

**Demo Account:**
- Username: `demo`
- Password: `demo123`

Or create a new account on the Register page.

### Build for Production

```bash
npm run build
npm run preview
```

## Features

### Authentication
- ✅ Local login/register (in-memory storage during dev)
- ✅ Session-based auth with httpOnly cookies
- ✅ Protected routes: `/new`, `/videos`, `/api/*`
- ✅ Public routes: `/`, `/login`, `/gallery`, `/api/logout`

### Video Generation Workflow
1. **Login** → Enter credentials
2. **Upload** (`/new`) → Select image + optional prompt
3. **Queue Job** → Image saved locally, VideoEntry created with `status: uploaded`
4. **Processing** → Kickoff endpoint marks status as `processing`
5. **Completion** → Mock webhook updates status to `completed` and adds video URL
6. **View** (`/videos`) → See completed videos with player
7. **Publish** → Toggle `is_published` to share in gallery
8. **Gallery** (`/gallery`) → Browse published videos

### Data Persistence
- **Videos:** `data/videos.json` (file-based, auto-created)
- **Images:** `static/uploads/` (local files)
- **Users:** In-memory map (resets on server restart)

## API Endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/auth` | Login/Register (action: `login` or `register`) |
| POST | `/api/logout` | Clear session |
| POST | `/api/upload` | Upload image file |
| POST | `/api/i2v/kickoff` | Start I2V job (`{id}`) |
| POST | `/api/i2v-webhook` | Receive job completion callback |

## Example Workflows

### Login
```bash
curl -X POST http://localhost:5173/api/auth \
  -H "Content-Type: application/json" \
  -d '{"action":"login","username":"demo","password":"demo123"}' \
  -c cookies.txt
```

### Register
```bash
curl -X POST http://localhost:5173/api/auth \
  -H "Content-Type: application/json" \
  -d '{"action":"register","username":"newuser","password":"pass123"}'
```

### Upload Image
```bash
curl -X POST http://localhost:5173/api/upload \
  -F "file=@image.png" \
  -b cookies.txt
```

## Development Notes

### Mock I2V Flow
The `/api/i2v/kickoff` endpoint currently:
1. Sets video status to `processing`
2. Schedules a mock webhook call after ~1.5s
3. Webhook updates DB with `status: completed` and a sample video URL

This allows testing the full flow without external I2V service. Replace with real API endpoint when ready.

### Session Handling
Sessions are stored in `session` cookie (httpOnly):
- Max age: 7 days
- Format: JSON `{id, username}`
- Validated on every request via `hooks.server.ts`

### Future Enhancements
- [ ] Real database (SQLite, PostgreSQL, etc.)
- [ ] OIDC/OAuth integration (Google, GitHub)
- [ ] S3 storage for images and videos
- [ ] Real I2V API integration (Runpod, Replicate, etc.)
- [ ] Video preview thumbnails
- [ ] User profile settings
- [ ] Comments/reactions on published videos
- [ ] Admin panel
- [ ] Rate limiting & quotas

## Testing

### End-to-End Flow (Local)

1. Start server: `npm run dev`
2. Login with `demo` / `demo123`
3. Go to `/new` and upload a test image
4. Monitor `/videos` to see status change to `completed` after ~1.5s
5. Visit `/gallery` to publish/view shared videos

### Unit Tests

```bash
cd d:\Projects\GmComfy
python -m unittest tests.test_handler -v
```

## Deployment

The app builds to a SvelteKit production artifact. For production, configure a proper adapter:

```bash
npm install -D @sveltejs/adapter-node  # or adapter-auto
```

Update `svelte.config.js` to use the adapter, then:

```bash
npm run build
node build/index.js  # Run the server
```

## License

MIT
