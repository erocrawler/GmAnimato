import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });
const deleted = await prisma.video.deleteMany({ where: { prompt: { contains: '[TEST]' } } });
console.log('Cleaned', deleted.count, 'fake videos');
await prisma.$disconnect();
