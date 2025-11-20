# Quick Setup Guide

## Current Setup (JSON File Storage - Default)

Your application is already configured to use JSON file storage. No additional setup needed!

Just run:
```bash
npm run dev
```

## Switching to SQL Server

### Step 1: Set up SQL Server

**Option A: Using Docker (Recommended)**
```bash
docker run -e "ACCEPT_EULA=Y" -e "SA_PASSWORD=YourStrong@Password123" \
  -p 1433:1433 --name sqlserver-gmanimato \
  -d mcr.microsoft.com/mssql/server:2022-latest
```

**Option B: Use existing SQL Server**
- Ensure SQL Server is running
- Create a database named `gmanimato` (or use existing)

### Step 2: Configure Environment

Create or update `.env` file:
```env
DATABASE_PROVIDER=sqlserver
DATABASE_URL="sqlserver://localhost:1433;database=gmanimato;user=sa;password=YourStrong@Password123;encrypt=true;trustServerCertificate=true"
```

**Note**: This project uses Prisma 7, where `DATABASE_URL` is passed to the PrismaClient constructor at runtime, not in the schema file.

**For Azure SQL Database:**
```env
DATABASE_URL="sqlserver://yourserver.database.windows.net:1433;database=gmanimato;user=yourusername;password=yourpassword;encrypt=true"
```

### Step 3: Generate Prisma Client

```bash
npm run prisma:generate
```

This will:
- Generate TypeScript types from the schema
- Create the Prisma Client
- Fix TypeScript errors in `db-sqlserver.ts`

### Step 4: Create Database Tables

```bash
npm run db:push
```

This creates the `users` and `videos` tables in your SQL Server database.

### Step 5: Seed Demo User

```bash
npm run db:seed
```

This creates the demo user account (demo/demo123) in the database.

### Step 6: (Optional) Migrate Existing Data

If you have existing data in `data/videos.json`:

```bash
npm run db:migrate-json
```

### Step 7: Run Your Application

```bash
npm run dev
```

Your app now uses SQL Server! 🎉

## Switching Back to JSON

Simply update `.env`:
```env
DATABASE_PROVIDER=json
```

Or remove the `DATABASE_PROVIDER` variable entirely (JSON is the default).

## Verifying Your Setup

### Check Database Connection

```bash
npm run prisma:studio
```

This opens a web interface at http://localhost:5555 where you can view your database.

### Test the Application

1. Start dev server: `npm run dev`
2. Login with demo/demo123
3. Upload an image at `/new`
4. Check `/videos` to see your video entries
5. Use Prisma Studio to verify data is being saved to SQL Server

## Troubleshooting

**"Module '@prisma/client' has no exported member 'PrismaClient'"**
- Run `npm run prisma:generate`

**"Cannot connect to SQL Server"**
- Verify SQL Server is running
- Check DATABASE_URL is correct
- Test connection: `npm run prisma:studio`

**"Table 'videos' does not exist"**
- Run `npm run db:push`

## Need More Help?

See the detailed guide: [DATABASE_MIGRATION.md](./DATABASE_MIGRATION.md)
