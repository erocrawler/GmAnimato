/**
 * Seed script to create an admin user in the database
 * This ensures the admin account exists for both JSON and PostgreSQL backends
 * 
 * Usage:
 *   npx tsx scripts/seed-admin-user.ts
 * 
 * You can customize the admin credentials via environment variables:
 *   ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 npx tsx scripts/seed-admin-user.ts
 */

import { getUserByUsername, createUser, updateUser } from './db-script';
import bcrypt from 'bcrypt';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const SALT_ROUNDS = 10;

async function seedAdminUser() {
  console.log('Checking for admin user...\n');

  // Check if admin user already exists
  const existing = await getUserByUsername(ADMIN_USERNAME);
  
  if (existing) {
    console.log('✓ Admin user already exists');
    console.log(`  Username: ${existing.username}`);
    console.log(`  Email: ${existing.email || 'N/A'}`);
    console.log(`  ID: ${existing.id}`);
    console.log(`  Roles: ${existing.roles.join(', ')}`);
    console.log(`  Created: ${existing.created_at}`);
    
    // Check if user already has admin role
    if (!existing.roles.includes('admin')) {
      console.log('\nAdding admin role to existing user...');
      const roles = [...new Set([...existing.roles, 'admin'])];
      await updateUser(existing.id, { roles });
      console.log('✓ Admin role added successfully!');
      console.log(`  Updated roles: ${roles.join(', ')}`);
    }
    
    return;
  }

  // Create admin user
  console.log('Creating admin user...');
  const password_hash = await bcrypt.hash(ADMIN_PASSWORD, SALT_ROUNDS);
  const user = await createUser(
    ADMIN_USERNAME, 
    password_hash, 
    ADMIN_EMAIL,
    ['admin', 'paid-tier']
  );

  console.log('✓ Admin user created successfully!');
  console.log(`  Username: ${user.username}`);
  console.log(`  Password: ${ADMIN_PASSWORD}`);
  console.log(`  Email: ${user.email}`);
  console.log(`  Roles: ${user.roles.join(', ')}`);
  console.log(`  ID: ${user.id}`);
  console.log(`  Created: ${user.created_at}`);
  console.log('\n⚠️  IMPORTANT: Please change the password after first login!');
}

seedAdminUser()
  .then(() => {
    console.log('\nDone!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error seeding admin user:', error);
    process.exit(1);
  });
