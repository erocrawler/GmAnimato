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

import { getUserByUsername, createUser, updateUser, getAdminSettings, updateAdminSettings } from './db-script';
import bcrypt from 'bcrypt';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const SPONSOR_API_URL = process.env.SPONSOR_API_URL || 'http://localhost:3999';
const SPONSOR_API_TOKEN = process.env.SPONSOR_API_TOKEN || '';
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
async function seedAdminSettings() {
  console.log('\nSetting up admin settings...\n');

  const settings = await getAdminSettings();

  // Default role configuration
  const defaultRoles = [
    { name: 'free-tier', sponsorTier: undefined, description: 'Free tier users' },
    { name: 'gmgard-user', sponsorTier: undefined, description: 'Registered users' },
    { name: 'paid-tier', sponsorTier: undefined, description: 'Paid tier users' },
    { name: 'premium-tier', sponsorTier: undefined, description: 'Premium tier users' },
  ];

  // Default quota per day
  const defaultQuotaPerDay = {
    'free-tier': 10,
    'gmgard-user': 50,
    'paid-tier': 100,
    'premium-tier': 100,
  };

  // Check if settings need updating
  const needsUpdate = !settings.roles || settings.roles.length === 0;

  if (needsUpdate) {
    console.log('Initializing admin settings with defaults...');
    await updateAdminSettings({
      registrationEnabled: true,
      roles: defaultRoles,
      quotaPerDay: defaultQuotaPerDay,
      maxConcurrentJobs: 5,
      maxQueueThreshold: 5000,
      localQueueThreshold: 0,
      sponsorApiUrl: SPONSOR_API_URL,
      sponsorApiToken: SPONSOR_API_TOKEN || undefined,
    });
    console.log('✓ Admin settings initialized');
    console.log(`  Roles: ${defaultRoles.map(r => r.name).join(', ')}`);
    console.log(`  Sponsor API URL: ${SPONSOR_API_URL}`);
  } else {
    console.log('✓ Admin settings already configured');
    console.log(`  Roles: ${settings.roles?.map((r: any) => r.name).join(', ')}`);
    
    // Update sponsor API config from environment if needed
    if ((SPONSOR_API_URL && settings.sponsorApiUrl !== SPONSOR_API_URL) || 
        (SPONSOR_API_TOKEN && settings.sponsorApiToken !== SPONSOR_API_TOKEN)) {
      console.log('  Updating sponsor API configuration...');
      await updateAdminSettings({
        sponsorApiUrl: SPONSOR_API_URL,
        sponsorApiToken: SPONSOR_API_TOKEN || undefined,
      });
      console.log('  ✓ Sponsor API configuration updated');
    }
  }
}
seedAdminUser()
  .then(() => seedAdminSettings())
  .then(() => {
    console.log('\nDone!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error seeding:', error);
    process.exit(1);
  });
