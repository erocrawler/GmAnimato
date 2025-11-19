/**
 * Simple in-memory auth store for local dev/testing.
 * In production, replace with a real database and proper auth library.
 */

export type User = {
  id: string;
  username: string;
  password?: string; // only stored temporarily during login, never returned
};

// In-memory store of users (persists only during server runtime)
const users: Map<string, User> = new Map();

// Pre-populate with a demo account
users.set('demo', { id: 'user-demo', username: 'demo', password: 'demo123' });

/**
 * Register a new user (username must be unique)
 */
export function registerUser(username: string, password: string): User | null {
  if (users.has(username)) {
    return null; // User already exists
  }

  const user: User = {
    id: `user-${Date.now()}`,
    username,
    password, // In production, hash this!
  };

  users.set(username, user);
  return { ...user, password: undefined };
}

/**
 * Authenticate a user by username/password
 */
export function authenticateUser(username: string, password: string): User | null {
  const user = users.get(username);
  if (!user || user.password !== password) {
    return null; // Invalid credentials
  }

  // Return user without password
  return { id: user.id, username: user.username };
}

/**
 * Get a user by ID
 */
export function getUserById(id: string): User | null {
  for (const user of users.values()) {
    if (user.id === id) {
      return { id: user.id, username: user.username };
    }
  }
  return null;
}
