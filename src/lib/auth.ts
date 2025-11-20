/**
 * Authentication module with database-backed user storage and bcrypt password hashing.
 * Supports both JSON file and SQL Server backends.
 */

import bcrypt from 'bcrypt';
import { createUser, getUserById, getUserByUsername, type UserPublic, type User as DbUser } from './db';

const SALT_ROUNDS = 10;

export type User = UserPublic;

/**
 * Register a new user (username must be unique)
 * Automatically hashes the password before storing
 * @param roles Optional roles array (defaults to ['free-tier'] if not provided)
 */
export async function registerUser(
  username: string, 
  password: string, 
  email?: string,
  roles?: string[]
): Promise<User | null> {
  // Check if username already exists
  const existing = await getUserByUsername(username);
  if (existing) {
    return null; // User already exists
  }

  // Hash the password
  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

  // Create user in database
  const user = await createUser(username, password_hash, email, roles);

  // Return user without password hash
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    roles: user.roles,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

/**
 * Authenticate a user by username/password
 * Verifies password against stored hash
 */
export async function authenticateUser(username: string, password: string): Promise<User | null> {
  const user = await getUserByUsername(username);
  if (!user) {
    return null; // User not found
  }

  // Verify password
  const isValid = await bcrypt.compare(password, user.password_hash);
  if (!isValid) {
    return null; // Invalid password
  }

  // Return user without password hash
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    roles: user.roles,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

/**
 * Get a user by ID (without password hash)
 */
export async function getUserByIdPublic(id: string): Promise<User | null> {
  const user = await getUserById(id);
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    roles: user.roles,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}
