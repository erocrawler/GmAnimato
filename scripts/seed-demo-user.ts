/**
 * Seed script to create a demo user in the database
 * This ensures the demo account exists for both JSON and SQL Server backends
 * 
 * Usage:
 *   npx tsx scripts/seed-demo-user.ts
 */

import { getUserByUsername, createUser } from './db-script';
import bcrypt from 'bcrypt';

const DEMO_USERNAME = 'demo';
const DEMO_PASSWORD = 'demo123';
const SALT_ROUNDS = 10;

async function seedDemoUser() {
  console.log('Checking for demo user...\n');

  // Check if demo user already exists
  const existing = await getUserByUsername(DEMO_USERNAME);
  
  if (existing) {
    console.log('✓ Demo user already exists');
    console.log(`  Username: ${existing.username}`);
    console.log(`  ID: ${existing.id}`);
    console.log(`  Created: ${existing.created_at}`);
    return;
  }

  // Create demo user
  console.log('Creating demo user...');
  const password_hash = await bcrypt.hash(DEMO_PASSWORD, SALT_ROUNDS);
  const user = await createUser(DEMO_USERNAME, password_hash);

  console.log('✓ Demo user created successfully!');
  console.log(`  Username: ${user.username}`);
  console.log(`  Password: ${DEMO_PASSWORD}`);
  console.log(`  ID: ${user.id}`);
  console.log(`  Created: ${user.created_at}`);
}

seedDemoUser()
  .then(() => {
    console.log('\nDone!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error seeding demo user:', error);
    process.exit(1);
  });
