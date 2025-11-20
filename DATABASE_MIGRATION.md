# Database Migration Guide

This project now supports both JSON file-based storage and SQL Server database through a clean interface abstraction.

## Architecture

The database layer has been refactored to use the **Repository Pattern** with the following components:

- **`IDatabase`** (`src/lib/IDatabase.ts`): Interface defining all database operations
- **`JsonFileDatabase`** (`src/lib/db-json.ts`): JSON file-based implementation (original behavior)
- **`SqlServerDatabase`** (`src/lib/db-sqlserver.ts`): SQL Server implementation using Prisma
- **`db.ts`** (`src/lib/db.ts`): Main module that provides a factory and backward-compatible exports

## Switching Between Implementations

The database implementation is controlled by the `DATABASE_PROVIDER` environment variable:

```bash
# Use JSON file storage (default)
DATABASE_PROVIDER=json

# Use SQL Server
DATABASE_PROVIDER=sqlserver
```

## Setting Up SQL Server

### 1. Install SQL Server

For development, you can use:
- **SQL Server Express** (Windows)
- **SQL Server Docker Container** (Cross-platform)
- **Azure SQL Database** (Cloud)

#### Docker Setup (Recommended for Development)

```bash
# Run SQL Server in Docker
docker run -e "ACCEPT_EULA=Y" -e "SA_PASSWORD=YourStrong@Password" \
  -p 1433:1433 --name sqlserver \
  -d mcr.microsoft.com/mssql/server:2022-latest
```

### 2. Configure Environment Variables

Create a `.env` file (or update existing one):

```env
# Set provider to SQL Server
DATABASE_PROVIDER=sqlserver

# SQL Server connection string
DATABASE_URL="sqlserver://localhost:1433;database=gmi2v;user=sa;password=YourStrong@Password;encrypt=true;trustServerCertificate=true"
```

**Connection String Format:**
```
sqlserver://SERVER:PORT;database=DATABASE_NAME;user=USERNAME;password=PASSWORD;encrypt=true;trustServerCertificate=true
```

### 3. Generate Prisma Client

```bash
npm run prisma:generate
```

This generates the TypeScript types and Prisma Client from the schema.

### 4. Create/Update Database Schema

You have two options:

#### Option A: Use Migrations (Recommended for Production)

```bash
npm run prisma:migrate
```

This creates migration files in `prisma/migrations/` and applies them to the database.

#### Option B: Push Schema Directly (Good for Development)

```bash
npm run db:push
```

This syncs your Prisma schema directly to the database without creating migration files.

### 5. Seed Demo User

```bash
npm run db:seed
```

This creates the demo user (username: `demo`, password: `demo123`) in your database.

### 6. (Optional) Browse Database with Prisma Studio

```bash
npm run prisma:studio
```

Opens a web interface at `http://localhost:5555` to view and edit database records.

## Database Schema

The SQL Server schema (in `prisma/schema.prisma`) mirrors the original JSON structure with additional user management:

**Note**: This project uses Prisma 7, where the connection URL is passed to the PrismaClient constructor rather than in the schema file.

### User Model

```prisma
model User {
  id            String   @id @default(cuid())
  username      String   @unique
  email         String?  @unique
  passwordHash  String   // bcrypt hashed password
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  
  videos        Video[]  // Relationship to videos
}
```

### Video Model

```prisma
model Video {
  id                 String   @id @default(cuid())
  userId             String
  originalImageUrl   String
  prompt             String?
  tags               String?  // JSON array
  suggestedPrompts   String?  // JSON array
  status             String   // 'uploaded' | 'in_queue' | 'processing' | 'completed' | 'failed'
  jobId              String?
  finalVideoUrl      String?
  isPublished        Boolean  @default(false)
  likes              String?  // JSON array of user_ids
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
  
  user               User     @relation(fields: [userId], references: [id])
}
```

## Authentication

User authentication now uses:
- **bcrypt** for password hashing (10 rounds)
- **Database storage** for user accounts (JSON or SQL Server)
- **Unique username** constraint
- **Optional email** field

The old in-memory user storage has been replaced with persistent database storage.

## Migrating Existing Data

To migrate data from JSON to SQL Server:

### Step 1: Export Existing Data

Your existing data is in `data/videos.json`. Keep this file as a backup.

### Step 2: Create Migration Script

Create `scripts/migrate-json-to-sql.ts`:

```typescript
import { PrismaClient } from '@prisma/client';
import fs from 'fs/promises';
import path from 'path';

const prisma = new PrismaClient();

async function migrate() {
  const jsonData = await fs.readFile(
    path.resolve('data/videos.json'), 
    'utf-8'
  );
  const videos = JSON.parse(jsonData);

  for (const video of videos) {
    await prisma.video.create({
      data: {
        id: video.id,
        userId: video.user_id,
        originalImageUrl: video.original_image_url,
        prompt: video.prompt,
        tags: video.tags ? JSON.stringify(video.tags) : null,
        suggestedPrompts: video.suggested_prompts 
          ? JSON.stringify(video.suggested_prompts) 
          : null,
        status: video.status,
        jobId: video.job_id,
        finalVideoUrl: video.final_video_url,
        isPublished: video.is_published ?? false,
        likes: video.likes ? JSON.stringify(video.likes) : null,
        createdAt: new Date(video.created_at),
      },
    });
  }

  console.log(`Migrated ${videos.length} videos to SQL Server`);
  await prisma.$disconnect();
}

migrate().catch(console.error);
```

### Step 3: Run Migration

```bash
npx tsx scripts/migrate-json-to-sql.ts
```

## Development Workflow

### Using JSON File Storage (Default)

No setup needed! Just run:

```bash
npm run dev
```

Data is stored in `data/videos.json`.

### Using SQL Server

1. Start SQL Server (Docker or local)
2. Set environment variables in `.env`
3. Generate Prisma client: `npm run prisma:generate`
4. Push schema: `npm run db:push`
5. Run dev server: `npm run dev`

## Code Usage

All existing code continues to work without changes! The exports from `src/lib/db.ts` remain the same:

```typescript
import { 
  createVideoEntry, 
  getVideosByUser, 
  updateVideo,
  // ... all other functions
} from '$lib/db';

// Works with either JSON or SQL Server backend
const video = await createVideoEntry({ 
  user_id: '123', 
  status: 'uploaded',
  // ...
});
```

### Using the Interface Directly (Advanced)

For more control, you can use the database interface directly:

```typescript
import { getDatabase } from '$lib/db';

const db = getDatabase();
const videos = await db.getVideosByUser('user123');
```

## Production Deployment

### Environment Variables

Set these in your production environment:

```env
DATABASE_PROVIDER=sqlserver
DATABASE_URL="sqlserver://prod-server:1433;database=gmi2v;user=app_user;password=SecurePassword;encrypt=true"
```

### Build Steps

```bash
# Install dependencies
npm install

# Generate Prisma Client
npm run prisma:generate

# Build application
npm run build
```

### Database Initialization

On first deployment:

```bash
# Create database schema
npm run db:push

# Or use migrations
npm run prisma:migrate deploy
```

## Troubleshooting

### Connection Issues

**Error: "Connection refused"**
- Check SQL Server is running
- Verify port 1433 is open
- Check firewall settings

**Error: "Login failed"**
- Verify username and password in DATABASE_URL
- Check SQL Server authentication mode

### Schema Issues

**Error: "Table does not exist"**
- Run `npm run db:push` to create tables
- Or run `npm run prisma:migrate` to apply migrations

### Prisma Client Issues

**Error: "Cannot find module '@prisma/client'"**
- Run `npm install`
- Run `npm run prisma:generate`

## Additional Resources

- [Prisma Documentation](https://www.prisma.io/docs)
- [SQL Server Connection Strings](https://www.connectionstrings.com/sql-server/)
- [Prisma SQL Server Guide](https://www.prisma.io/docs/concepts/database-connectors/sql-server)
