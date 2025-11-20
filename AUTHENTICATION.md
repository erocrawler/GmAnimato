# Authentication System

## Overview

The authentication system has been upgraded from in-memory storage to persistent database-backed authentication with secure password hashing.

## Features

- ✅ **Persistent User Storage**: Users stored in database (JSON or SQL Server)
- ✅ **Secure Password Hashing**: bcrypt with 10 salt rounds
- ✅ **Username Uniqueness**: Enforced at database level
- ✅ **Optional Email**: Support for email addresses
- ✅ **Session-based Auth**: HTTP-only cookies for security

## User Model

```typescript
type User = {
  id: string;
  username: string;
  email?: string;
  password_hash: string;  // bcrypt hashed
  created_at: string;
  updated_at?: string;
};

type UserPublic = Omit<User, 'password_hash'>;
```

## API Functions

### `registerUser(username, password, email?)`

Creates a new user account with hashed password.

```typescript
import { registerUser } from '$lib/auth';

const user = await registerUser('john', 'securepass123', 'john@example.com');
if (!user) {
  console.log('Username already exists');
} else {
  console.log('User created:', user.id);
}
```

**Returns**: `UserPublic | null`
- `null` if username already exists
- `UserPublic` object on success (without password_hash)

### `authenticateUser(username, password)`

Verifies credentials and returns user if valid.

```typescript
import { authenticateUser } from '$lib/auth';

const user = await authenticateUser('john', 'securepass123');
if (!user) {
  console.log('Invalid credentials');
} else {
  console.log('Logged in:', user.username);
}
```

**Returns**: `UserPublic | null`
- `null` if credentials are invalid
- `UserPublic` object on success

### `getUserByIdPublic(id)`

Retrieves user by ID without exposing password hash.

```typescript
import { getUserByIdPublic } from '$lib/auth';

const user = await getUserByIdPublic('user-123');
if (user) {
  console.log('Found user:', user.username);
}
```

**Returns**: `UserPublic | null`

## Database Functions

Lower-level database functions (from `$lib/db`):

```typescript
import { 
  createUser, 
  getUserById, 
  getUserByUsername,
  getUserByEmail,
  updateUser,
  deleteUser 
} from '$lib/db';

// Create user with pre-hashed password
const user = await createUser('john', hashedPassword, 'john@example.com');

// Find users
const userById = await getUserById('user-123');
const userByName = await getUserByUsername('john');
const userByEmail = await getUserByEmail('john@example.com');

// Update user
await updateUser('user-123', { email: 'newemail@example.com' });

// Delete user (also deletes all their videos in SQL Server)
await deleteUser('user-123');
```

## Password Security

### Hashing

All passwords are hashed using bcrypt with 10 salt rounds before storage:

```typescript
import bcrypt from 'bcrypt';

const password_hash = await bcrypt.hash(password, 10);
```

### Verification

Password verification uses bcrypt's constant-time comparison:

```typescript
const isValid = await bcrypt.compare(password, user.password_hash);
```

## Session Management

Sessions are stored in HTTP-only cookies for security.

### Login Flow

1. User submits credentials to `/api/auth` with `action: 'login'`
2. Server validates credentials with `authenticateUser()`
3. If valid, server creates session cookie with user data (without password)
4. Cookie is sent with all subsequent requests
5. `hooks.server.ts` validates session and populates `event.locals.user`

### Registration Flow

1. User submits credentials to `/api/auth` with `action: 'register'`
2. Server checks if username exists
3. If available, creates user with `registerUser()`
4. Session cookie is created automatically
5. User is logged in immediately after registration

### Session Cookie

```typescript
cookies.set('session', JSON.stringify(user), {
  path: '/',
  httpOnly: true,      // Prevents JavaScript access
  sameSite: 'lax',     // CSRF protection
  maxAge: 60 * 60 * 24 * 7  // 7 days
});
```

## Protected Routes

Routes are protected by the `hooks.server.ts` middleware:

**Public Routes** (no authentication required):
- `/`
- `/login`
- `/gallery`
- `/api/auth`
- `/api/logout`
- `/api/i2v-webhook`

**Protected Routes** (authentication required):
- `/new` - Upload new video
- `/videos` - User's video library
- `/api/upload` - File upload
- `/api/i2v/*` - Video processing endpoints
- All other `/api/*` endpoints

## Demo Account

A demo account is available for testing:

- **Username**: `demo`
- **Password**: `demo123`

### Creating Demo User

Run the seed script to create the demo user in your database:

```bash
npm run db:seed
```

This works with both JSON and SQL Server backends.

## Data Storage

### JSON File Backend

Users are stored in `data/users.json`:

```json
[
  {
    "id": "user-1234567890",
    "username": "demo",
    "email": null,
    "password_hash": "$2b$10$...",
    "created_at": "2025-01-01T00:00:00.000Z",
    "updated_at": "2025-01-01T00:00:00.000Z"
  }
]
```

### SQL Server Backend

Users are stored in the `users` table with:
- Unique constraints on `username` and `email`
- Indexes on `username` and `email` for fast lookups
- Cascade delete relationship with videos

## Migration from Old System

The old in-memory authentication system has been completely replaced. If you have custom user creation logic, update it to use the new database-backed functions.

**Old (in-memory)**:
```typescript
// Don't use this anymore
const users = new Map();
users.set('demo', { id: 'user-demo', username: 'demo', password: 'demo123' });
```

**New (database-backed)**:
```typescript
import { registerUser } from '$lib/auth';
await registerUser('demo', 'demo123');
```

## Security Best Practices

1. ✅ **Passwords are never stored in plain text**
2. ✅ **Password hashes are never exposed in API responses**
3. ✅ **Session cookies are HTTP-only** (can't be accessed by JavaScript)
4. ✅ **CSRF protection** via SameSite cookie policy
5. ✅ **Constant-time password comparison** (bcrypt prevents timing attacks)
6. ⚠️ **HTTPS recommended in production** (cookies should use `secure: true`)

## Future Enhancements

- [ ] Email verification
- [ ] Password reset functionality
- [ ] Two-factor authentication (2FA)
- [ ] OAuth/Social login (Google, GitHub, etc.)
- [ ] Session invalidation/logout from all devices
- [ ] Password strength requirements
- [ ] Rate limiting on login attempts
- [ ] Account lockout after failed attempts
