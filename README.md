# GmAnimato - Image-to-Video Generator

A SvelteKit application for generating videos from images. Upload an image, refine a prompt, and queue a video generation job. Minimal setup by default; PostgreSQL optional.

## Quick Start

- Prerequisites: Node.js 18+, npm
- Install: `npm install`
- Run dev: `npm run dev`
- Visit: http://localhost:5173

Demo account:
- Username: `demo`
- Password: `demo123`

See [QUICK_SETUP.md](./QUICK_SETUP.md) for environment variables and optional PostgreSQL setup.

## Project Structure

```
GmAnimato/
  src/
    lib/
      auth.ts          # Authentication helpers
      oauth.ts         # OAuth client helpers (GmGard)
      db.ts            # Database factory & exports
      IDatabase.ts     # Database interface
      db-json.ts       # JSON file storage implementation
      db-postgres.ts   # PostgreSQL implementation (Prisma)
    routes/
      +layout.svelte   # Root layout
      +page.svelte     # Home page
      login/           # Login/Register UI
      new/             # Upload & queue new video
      videos/          # User's video library (protected)
      gallery/         # Published videos (public)
      media/[...path]  # Media proxy to S3/R2 (images/videos, range support)
      image/[...path]  # Image resize endpoint (?w=width)
    auth/
      gmgard/          # OAuth login + callback
      api/
        auth/          # Login/Register endpoint
        logout/        # Logout endpoint
        upload/        # File upload endpoint
        i2v/
          kickoff/     # Start I2V job processing
        i2v-webhook/   # Receive job completion callbacks
  hooks.server.ts      # Auth middleware (JWT + session fallback)
  prisma/
    schema.prisma      # Database schema (PostgreSQL)
  data/
    videos.json        # Persistent video metadata (JSON mode)
    users.json         # Persistent user store (JSON mode)
  static/
    uploads/           # Uploaded images
```

## Features

### Authentication
- bcrypt-hashed passwords
- JWT (RS256) when keys configured; session fallback when not
- httpOnly cookies; 7-day expiry
- Admin/public route protection
- See [AUTHENTICATION.md](./AUTHENTICATION.md)

### Media
- `/media/*` proxy to object storage (supports HTTP Range for videos)
- `/image/*?w=WIDTH` resizing with preserved aspect ratio (allowlist widths)

### Video Workflow
1. Login
2. Upload (`/new`) image + optional prompt
3. Queue job → `uploaded`
4. Processing → `processing`
5. Completion via webhook → `completed`
6. View in `/videos`; publish to `/gallery`

### Data Persistence
- JSON file storage (default)
- PostgreSQL via Prisma (optional)

## API Endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/auth` | Login/Register (action: `login` or `register`) |
| POST | `/api/logout` | Clear session |
| POST | `/api/upload` | Upload image file |
| POST | `/api/i2v/kickoff` | Start I2V job (`{id}`) |
| POST | `/api/i2v-webhook` | Receive job completion callback |
| GET  | `/media/{path}` | Proxy media (images/videos; supports Range) |
| GET  | `/image/{path}?w=WIDTH` | Resize image to allowed width |

## Development Notes

### Auth Middleware
- Hybrid auth in `hooks.server.ts`: JWT first (if enabled), else session lookup
- Valid JWT still requires user to exist in DB (deleted users rejected)

### OAuth (GmGard)
- Optional OIDC login via issuer endpoints and client secret

### Mock I2V Flow
- Kickoff sets `processing`; webhook sets `completed` with a sample URL

## Build & Deploy

```bash
npm run build
npm run preview
```

Use a SvelteKit adapter (e.g., `@sveltejs/adapter-node`) for production as needed.

## License

MIT
