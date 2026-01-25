# Quick Setup Guide

## Prerequisites

- Node.js 18+
- npm 9+
- (Optional) Postgres or Docker for production database

## Step 1: Install Dependencies

```bash
npm install
```

## Step 2: Configure Environment

Create `.env` file in project root:

```env
# Database (default: JSON file storage)
DATABASE_PROVIDER=json
# DATABASE_PROVIDER=postgres  # Uncomment for PostgreSQL

# PostgreSQL connection string (if using postgres provider)
# DATABASE_URL="postgresql://user:password@localhost:5432/gmanimato"

# JWT Authentication (optional - fallback to session tokens if not set)
JWT_PRIVATE_KEY=<your-private-key>
JWT_PUBLIC_KEY=<your-public-key>

# S3/R2 Media Storage
S3_ENDPOINT=http://localhost:9000  # MinIO or R2 endpoint
```

## Step 3: Run Development Server

```bash
npm run dev
```

Visit http://localhost:5173

**Demo account:** `demo` / `demo123`

## Step 4 (Optional): Set Up PostgreSQL

If using JSON storage, skip this section. For production PostgreSQL:

### Using Docker:
```bash
docker run --name postgres-gmanimato \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=gmanimato \
  -p 5432:5432 \
  -d postgres:latest
```

### Update `.env`:
```env
DATABASE_PROVIDER=postgres
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/gmanimato"
```

### Create tables:
```bash
npm run db:push
npm run db:seed
```
