# Backend Features

This guide covers OSW Studio's advanced backend features, available in **Server Mode** only.

## Overview

Server Mode unlocks powerful backend capabilities for your published deployments, including serverless API endpoints, database management, and secure secrets storage.

**Key Features:**
- **Edge Functions** - REST API endpoints with JavaScript runtime
- **Database** - Per-deployment SQLite with SQL editor and schema browser
- **Server Functions** - Reusable helper code for edge functions
- **Scheduled Functions** - Run edge functions on cron schedules
- **Secrets** - Encrypted storage for API keys and tokens
- **Logs** - Execution history and debugging
- **AI Integration** - AI awareness of backend features via `/.server/` folder

## Where Backend Features Live

Backend features are **project-scoped** — they belong to the project, not to a specific deployment. When you publish the project, its backend features are extracted into the deployment's runtime database. The same project can be published multiple times; each deployment gets a snapshot of the project's backend features at publish time.

You can manage backend features in three places:

1. **Project Settings** (primary, in the workspace): Click **Project Settings** in the workspace header to open a modal with Schema, Functions, Helpers, Secrets, and Schedules tabs. Changes take effect in the project and will be included in the next publish.
2. **Deployment Server Settings** (for an already-published deployment): Open the deployment in the Admin Dashboard to inspect and tweak the runtime copy of its backend. This is useful for rotating secrets or debugging a published deployment without re-publishing from the project.
3. **MCP connector**: An outside agent with `projects:write` can list, create, replace and delete functions, schedules and secrets on the project (`backend_list`, `backend_upsert`, `backend_delete`). Secret values can be set and are never returned. SQL against a deployment's live tables is `deployments_sql` (the `deploy` scope). See [MCP Server](?doc=mcp-server).

## Prerequisites

- OSW Studio running in **Server Mode**
- A project with Backend enabled (toggle in Project Settings)

## Accessing Server Settings

**From the workspace (recommended):**
1. Open your project
2. Click **Project Settings** in the workspace header
3. Toggle **Backend Enabled** if it isn't already
4. Use the tabs to create edge functions, server functions, secrets, and schedules

**From the Admin Dashboard (for published deployments):**
1. Open the **Admin Dashboard** (`/admin`) or `/w/{workspaceId}/deployments`
2. Navigate to **Deployments** and select your deployment
3. Click the **Server Settings** button (server icon) next to Deployment Settings
   - The server icon only appears for published deployments with database enabled
   - You can also access it via the "..." dropdown menu > "Server Settings"

The Server Settings modal contains seven tabs:
- **Schema** - Browse tables and columns
- **SQL** - Execute raw SQL queries
- **Functions** - Create and manage edge functions (HTTP endpoints)
- **Helpers** - Create and manage server functions (reusable code)
- **Secrets** - Store encrypted API keys and tokens
- **Schedules** - Create and manage scheduled functions (cron jobs)
- **Logs** - View function execution history

---

## Edge Functions

### Creating a Function

1. Go to **Server Settings > Functions**
2. Click **New Function**
3. Configure:
   - **Name**: Lowercase letters, numbers, and hyphens (e.g., `get-users`)
   - **HTTP Method**: GET, POST, PUT, DELETE, or ANY
   - **Description**: Optional description
   - **Timeout**: 1-30 seconds (default: 5s)
   - **Code**: JavaScript function body

4. Click **Create Function**

### Function URL

Each function is accessible at:
```
https://your-server.com/api/deployments/{deploymentId}/functions/{function-name}
```

For example:
```
https://your-instance.com/api/deployments/abc123/functions/get-products
```

### Calling Edge Functions from Published Sites

Published sites automatically route edge function calls! Your frontend JavaScript can call functions using simple paths:

```javascript
// In your published site's JavaScript
const response = await fetch('/submit-contact', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'John', email: 'john@example.com' })
});
const result = await response.json();
```

This works because OSW Studio injects a lightweight interceptor script (~1.5KB) into published HTML files that:
- Detects requests that look like edge function calls (paths without file extensions)
- Routes them to `/api/deployments/{deploymentId}/functions/{path}`
- Works with `fetch()`, `XMLHttpRequest`, and form submissions

**Form submissions** are also intercepted:
```html
<form action="/submit-contact" method="POST">
  <input name="email" type="email" required>
  <button type="submit">Subscribe</button>
</form>
```

The form data is automatically converted to JSON and sent to your edge function.

**Custom event handling:**
```javascript
// Listen for edge function responses
document.addEventListener('edge-function-response', (e) => {
  console.log('Result:', e.detail.result);
});

document.addEventListener('edge-function-error', (e) => {
  console.error('Error:', e.detail.error);
});
```

### Available APIs

Your function code has access to these global objects:

#### `request` Object
```javascript
request.method   // HTTP method (GET, POST, etc.)
request.body     // Parsed JSON body (POST/PUT/PATCH)
request.query    // Query string parameters
request.headers  // Request headers
request.path     // URL path after function name
request.params   // Path parameters (if any)
```

`request.headers` carries `accept`, `accept-language`, `content-type`, `content-length`, `origin`, `referer`, `user-agent`, any `x-` header the caller sent (except `x-instance-api-key`), and `cookie`. The cookie header has OSW Studio's own cookies (every name starting `osw_`) removed, so a function sees the cookies its site set and never the visitor's studio session.

When a function sets response headers (the third argument to `Response.json`), only `content-type`, `content-disposition`, `content-language`, `cache-control`, `expires`, `vary`, `location`, `etag`, `last-modified`, `x-` headers (except proxy and framework control headers such as `x-accel-redirect`, `x-sendfile` and `x-middleware-*`) and `set-cookie` are passed on. A `set-cookie` for an `osw_` name is dropped, and a `Domain` attribute is removed so the cookie stays on the site's host.

#### `db` Object (Database)
```javascript
// Execute SELECT queries
const users = db.query('SELECT * FROM users WHERE active = ?', [true]);
const user = db.all('SELECT * FROM users LIMIT 10'); // alias for query

// Execute INSERT/UPDATE/DELETE
const result = db.run('INSERT INTO users (name, email) VALUES (?, ?)', ['John', 'john@example.com']);
// result = { changes: 1 }
```

#### `Response` Object
```javascript
// Return JSON
Response.json({ users: [...] });
Response.json({ error: 'Not found' }, 404);

// Return plain text
Response.text('Hello World');
Response.text('Created', 201);

// Return error
Response.error('Something went wrong', 500);
Response.error('Unauthorized', 401);
```

#### `fetch` Function
```javascript
// Make external HTTP requests
const response = await fetch('https://api.example.com/data');
const data = await response.json();
Response.json(data);

// With options
const res = await fetch('https://api.example.com/users', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: { name: 'John', email: 'john@example.com' }
});
```

**Security Limits:**
- Max 10 requests per function execution
- 10 second timeout per request
- 5MB max response body
- Only `http://` and `https://` protocols allowed
- Private and internal addresses are refused: loopback, `localhost`, private ranges (10.x, 172.16-31.x, 192.168.x), link-local and cloud metadata (169.254.x), 100.64.x, IPv6 loopback and private ranges, and any name that resolves to one of them
- Redirects are followed (up to 5) and each one is checked the same way; `Authorization` and `Cookie` headers are dropped when a redirect goes to another origin
- To let functions reach local services (for example an API on the same machine), set `FUNCTIONS_ALLOW_PRIVATE_FETCH=true` on the server

#### `atob` / `btoa` Functions
```javascript
// Base64 encode
const encoded = btoa('Hello World');  // "SGVsbG8gV29ybGQ="

// Base64 decode
const decoded = atob('SGVsbG8gV29ybGQ=');  // "Hello World"
```

#### `server` Object (Helper Functions)
```javascript
// Call server functions (helpers) defined in the Helpers tab
const auth = server.validateAuth(request.headers['x-api-key']);
const formatted = server.formatPrice(29.99, 'USD');
const user = server.getUserById(123);
```

See [Server Functions (Helpers)](#server-functions-helpers) for more details.

#### `secrets` Object (Encrypted Secrets)
```javascript
// Get secret value by name
const apiKey = secrets.get('STRIPE_API_KEY');
if (!apiKey) {
  Response.error('Stripe not configured', 500);
  return;
}

// Check if secret exists
if (secrets.has('SENDGRID_KEY')) {
  // Use SendGrid
}

// List all available secret names
const allSecrets = secrets.list(); // ['STRIPE_API_KEY', 'SENDGRID_KEY', ...]
```

See [Secrets](#secrets) for more details.

### Example Functions

#### List Items (GET)
```javascript
// GET /api/deployments/{deploymentId}/functions/list-items
const items = db.query('SELECT * FROM items ORDER BY created_at DESC LIMIT 20');
Response.json({ items });
```

#### Create Item (POST)
```javascript
// POST /api/deployments/{deploymentId}/functions/create-item
if (!request.body.name) {
  Response.error('Name is required', 400);
  return;
}

const result = db.run(
  'INSERT INTO items (name, description) VALUES (?, ?)',
  [request.body.name, request.body.description || '']
);

Response.json({
  id: result.lastInsertRowid,
  message: 'Item created'
}, 201);
```

#### Get Item by ID (GET with path)
```javascript
// GET /api/deployments/{deploymentId}/functions/get-item/123
const id = request.path.split('/')[1];
if (!id) {
  Response.error('ID required', 400);
  return;
}

const item = db.query('SELECT * FROM items WHERE id = ?', [id]);
if (item.length === 0) {
  Response.error('Item not found', 404);
  return;
}

Response.json(item[0]);
```

#### External API Proxy
```javascript
// GET /api/deployments/{deploymentId}/functions/weather?city=London
const city = request.query.city || 'New York';
const apiKey = secrets.get('WEATHER_API_KEY');
if (!apiKey) {
  Response.error('Weather API not configured', 500);
  return;
}

const res = await fetch(
  `https://api.weatherapi.com/v1/current.json?key=${apiKey}&q=${city}`
);
const data = await res.json();

Response.json({
  city: data.location.name,
  temp: data.current.temp_c,
  condition: data.current.condition.text
});
```

### Security Considerations

#### Sandboxed Execution
- Functions run in a **QuickJS WebAssembly sandbox** - a completely separate JavaScript engine
- True isolation via WASM boundary: no shared memory or access to Node.js internals
- Memory limits enforced by WASM (64MB default)
- Execution time limits with interrupt handler (configurable 1-30 seconds)
- Allowed globals: `JSON`, `Date`, `Math`, `Array`, `Object`, `String`, `Number`, `Boolean`, `RegExp`, `Error`, `Map`, `Set`, `Promise`, `Symbol`, `console`
- Network: `fetch` (with security limits - see above)
- Utility functions: `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `encodeURIComponent`, `decodeURIComponent`, `encodeURI`, `decodeURI`
- Base64: `atob` (decode), `btoa` (encode)
- No access to: `require`, `process`, `__dirname`, `Buffer`, file system
- `setTimeout`/`setInterval` disabled (prevents runaway execution)

#### Database Protection
System tables are protected and cannot be accessed:
- `site_info`
- `files`
- `file_tree_nodes`
- `pageviews`
- `interactions`
- `sessions`
- `edge_functions`
- `function_logs`
- `server_functions`
- `secrets`

Only user-created tables are accessible via the `db` API.

#### Query Limits
- Maximum 100 database queries per function execution
- Timeout enforced (1-30 seconds, configurable)
- SQL keywords validated to prevent dangerous operations

### Managing Functions

#### Enable/Disable
Click the dropdown menu on a function card and select **Enable** or **Disable**. Disabled functions return 404.

#### Edit
Click **Edit** in the dropdown to modify the function code, method, or timeout.

#### Delete
Click **Delete** in the dropdown. This cannot be undone.

#### Copy URL
Click **Copy URL** below the function card to copy the public endpoint URL.

---

## Server Functions (Helpers)

Server functions are reusable JavaScript helpers that can be called from your edge functions via the `server` object. They enable code reuse across multiple edge functions.

### Creating a Server Function

1. Go to **Server Settings > Helpers**
2. Click **New Helper**
3. Configure:
   - **Name**: Valid JavaScript identifier (camelCase or snake_case, e.g., `validateAuth`, `format_price`)
   - **Description**: Optional description
   - **Code**: JavaScript function body
4. Click **Create Function**

### How Server Functions Work

Server functions receive arguments via an `args` array and have access to `db`, `fetch`, and `console`. They return a value that is passed back to the calling edge function.

```javascript
// Server function "validateAuth"
const [apiKey] = args;
if (!apiKey) {
  return { valid: false, error: 'No API key provided' };
}

const users = db.query('SELECT * FROM users WHERE api_key = ?', [apiKey]);
if (users.length === 0) {
  return { valid: false, error: 'Invalid API key' };
}

return { valid: true, user: users[0] };
```

### Calling from Edge Functions

Server functions are available on the `server` object. Pass arguments as regular function parameters:

```javascript
// Edge function code
const auth = server.validateAuth(request.headers['x-api-key']);
if (!auth.valid) {
  Response.error(auth.error, 401);
  return;
}

// User is authenticated
const products = db.query(
  'SELECT * FROM products WHERE user_id = ?',
  [auth.user.id]
);
Response.json({ products });
```

### Available APIs in Server Functions

| API | Description |
|-----|-------------|
| `args` | Array of arguments passed from edge function |
| `db.query()` | Execute SELECT query |
| `db.run()` | Execute INSERT/UPDATE/DELETE |
| `db.all()` | Alias for query |
| `fetch()` | Make external HTTP requests |
| `console.log()` | Log messages (visible in function logs) |

### Example Server Functions

#### Validate API Key
```javascript
// Name: validateAuth
const [apiKey] = args;
if (!apiKey) return { valid: false };

const users = db.query('SELECT id, name, role FROM users WHERE api_key = ?', [apiKey]);
return users.length > 0 ? { valid: true, user: users[0] } : { valid: false };
```

#### Format Price
```javascript
// Name: formatPrice
const [amount, currency = 'USD'] = args;
const symbols = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' };
const symbol = symbols[currency] || currency + ' ';
return symbol + amount.toFixed(2);
```

#### Get User by ID
```javascript
// Name: getUserById
const [id] = args;
if (!id) return null;

const users = db.query('SELECT * FROM users WHERE id = ?', [id]);
return users.length > 0 ? users[0] : null;
```

#### Check Permission
```javascript
// Name: hasPermission
const [userId, permission] = args;
if (!userId || !permission) return false;

const perms = db.query(
  'SELECT 1 FROM user_permissions WHERE user_id = ? AND permission = ?',
  [userId, permission]
);
return perms.length > 0;
```

### Security Notes

- Server functions run in the same QuickJS WASM context as the parent edge function
- They share the total execution timeout (not additive)
- Recursive calls are possible but limited by timeout
- The `server_functions` table is protected and cannot be queried
- Only enabled server functions are available to edge functions

### Managing Server Functions

- **Enable/Disable**: Toggle from the dropdown menu. Disabled functions are not available to edge functions.
- **Edit**: Click Edit to modify the code or description
- **Delete**: Click Delete to remove (cannot be undone)

---

## Secrets

Secrets provide secure, encrypted storage for sensitive values like API keys, tokens, and passwords. Edge functions can access secrets via the `secrets` object without exposing the actual values in your code.

### Prerequisites

Before using secrets, you must set the `SECRETS_ENCRYPTION_KEY` environment variable:

```bash
# Generate a secure 256-bit key
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Add to your environment
export SECRETS_ENCRYPTION_KEY="your-generated-key-here"
```

### Creating a Secret

1. Go to **Server Settings > Secrets**
2. Click **New Secret**
3. Configure:
   - **Name**: SCREAMING_SNAKE_CASE (e.g., `STRIPE_API_KEY`, `SENDGRID_TOKEN`)
   - **Value**: The secret value (will be encrypted)
   - **Description**: Optional description
4. Click **Create Secret**

### Using Secrets in Edge Functions

The `secrets` object is available in all edge functions:

```javascript
// Get a secret value
const apiKey = secrets.get('STRIPE_API_KEY');

// Check if a secret exists
if (secrets.has('STRIPE_API_KEY')) {
  // Use the secret
}

// List all available secret names (not values)
const names = secrets.list(); // ['STRIPE_API_KEY', 'SENDGRID_TOKEN', ...]
```

### Example: Stripe API Integration

```javascript
// POST /api/deployments/{deploymentId}/functions/create-charge
const stripeKey = secrets.get('STRIPE_API_KEY');
if (!stripeKey) {
  Response.error('Stripe not configured', 500);
  return;
}

const { amount, currency, source } = request.body;
if (!amount || !source) {
  Response.error('Amount and source are required', 400);
  return;
}

const res = await fetch('https://api.stripe.com/v1/charges', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${stripeKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({
    amount: String(amount),
    currency: currency || 'usd',
    source,
  }),
});

const charge = await res.json();
Response.json({ charge });
```

### Secrets API Reference

| Method | Description |
|--------|-------------|
| `secrets.get(name)` | Get secret value, or `null` if not found |
| `secrets.has(name)` | Check if secret exists (returns boolean) |
| `secrets.list()` | Get array of all secret names (not values) |

### Security Notes

- **Encryption**: Secrets are encrypted using AES-256-GCM with unique IVs per secret
- **Never logged**: Secret values are never written to logs or exposed in API responses
- **Admin-only**: Only authenticated admins can create, view (metadata only), or delete secrets
- **Protected table**: The `secrets` table cannot be queried directly from edge functions
- **Key management**: The master encryption key must be stored securely as an environment variable

### Managing Secrets

- **Edit**: Click Edit in the dropdown to update the value or description (name cannot be changed)
- **Delete**: Click Delete to permanently remove (cannot be undone)
- **No value display**: Secret values are never displayed after creation for security

---

## Scheduled Functions (Cron Jobs)

Scheduled functions run edge functions automatically on a cron schedule. Use them for periodic tasks like database cleanup, report generation, cache warming, or external API syncing.

### Creating a Scheduled Function

1. Go to **Server Settings > Schedules**
2. Click **New Schedule**
3. Configure:
   - **Name**: Lowercase letters, numbers, and hyphens (e.g., `daily-cleanup`)
   - **Edge Function**: Select which edge function to invoke
   - **Cron Expression**: Standard 5-field cron syntax (e.g., `0 8 * * *`)
   - **Timezone**: IANA timezone (default: `UTC`)
   - **Description**: Optional description
   - **Config**: Optional JSON object passed as the request body
4. Click **Create Schedule**

### How It Works

When a scheduled function fires:
1. The cron scheduler triggers at the specified time
2. The linked edge function is invoked with the `config` object as `request.body`
3. The execution result (success/error) and duration are recorded
4. The next run time is calculated from the cron expression

The edge function runs in the same QuickJS sandbox as HTTP-triggered invocations, with full access to `db`, `fetch`, `secrets`, `server`, and `console`.

### Cron Expression Reference

Cron expressions use 5 fields: `minute hour day-of-month month day-of-week`

**Minimum interval: 5 minutes.** Expressions that resolve to intervals shorter than 5 minutes will be rejected.

| Expression | Description |
|------------|-------------|
| `*/5 * * * *` | Every 5 minutes |
| `0 * * * *` | Every hour (at minute 0) |
| `0 8 * * *` | Daily at 8:00 AM |
| `0 0 * * *` | Daily at midnight |
| `30 9 * * 1-5` | Weekdays at 9:30 AM |
| `0 0 * * 1` | Every Monday at midnight |
| `0 0 1 * *` | First of every month at midnight |
| `0 0 1 1 *` | January 1st at midnight (yearly) |

**Field ranges:**
- Minute: 0-59
- Hour: 0-23
- Day of month: 1-31
- Month: 1-12
- Day of week: 0-7 (0 and 7 = Sunday)

### Example Scheduled Functions

#### Daily Database Cleanup
Clean up old records every day at 3:00 AM UTC:

- **Edge Function** (`cleanup`):
```javascript
const daysToKeep = request.body.daysToKeep || 30;
const cutoff = new Date(Date.now() - daysToKeep * 86400000).toISOString();

const result = db.run('DELETE FROM logs WHERE created_at < ?', [cutoff]);
Response.json({ deleted: result.changes, cutoff });
```

- **Schedule config**:
  - Cron: `0 3 * * *`
  - Config: `{ "daysToKeep": 30 }`

#### Hourly Stats Aggregation
Aggregate analytics data every hour:

- **Edge Function** (`aggregate-stats`):
```javascript
const hourAgo = new Date(Date.now() - 3600000).toISOString();
const stats = db.query('SELECT COUNT(*) as views FROM pageviews WHERE timestamp > ?', [hourAgo]);

db.run('INSERT INTO hourly_stats (hour, views) VALUES (?, ?)',
  [new Date().toISOString().slice(0, 13), stats[0].views]);

Response.json({ aggregated: true, views: stats[0].views });
```

- **Schedule config**:
  - Cron: `0 * * * *`
  - Config: `{}`

#### Weekly Report Email
Send a weekly summary every Monday at 9:00 AM:

- **Edge Function** (`send-weekly-report`):
```javascript
const apiKey = secrets.get('SENDGRID_KEY');
if (!apiKey) { Response.error('Email not configured', 500); return; }

const stats = db.query('SELECT COUNT(*) as total FROM orders WHERE created_at > datetime("now", "-7 days")');

const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    personalizations: [{ to: [{ email: request.body.recipient }] }],
    from: { email: 'reports@example.com' },
    subject: 'Weekly Report',
    content: [{ type: 'text/plain', value: 'Orders this week: ' + stats[0].total }]
  })
});

Response.json({ sent: res.ok });
```

- **Schedule config**:
  - Cron: `0 9 * * 1`
  - Timezone: `America/New_York`
  - Config: `{ "recipient": "admin@example.com" }`

### Managing Scheduled Functions

- **Enable/Disable**: Toggle from the dropdown menu. Disabled schedules won't fire.
- **Edit**: Click Edit to modify the cron expression, linked function, timezone, or config.
- **Delete**: Click Delete to remove (cannot be undone).
- **Status tracking**: Each schedule card shows the next run time, last run status (success/error), and last run time.

---

## SQL Editor

The SQL Editor allows direct SQL query execution against your deployment's database.

### Executing Queries

1. Go to **Server Settings > SQL**
2. Type your SQL query in the editor
3. Click **Execute** or press `Ctrl/Cmd + Enter`
4. View results in the table below

### Query History

The editor maintains a history of your last 20 queries (stored in browser localStorage).

Click **History** to view and re-run previous queries.

### Supported Operations

```sql
-- SELECT queries
SELECT * FROM products WHERE price > 100;
SELECT COUNT(*) FROM orders;

-- INSERT
INSERT INTO products (name, price) VALUES ('Widget', 29.99);

-- UPDATE
UPDATE products SET price = 24.99 WHERE id = 1;

-- DELETE
DELETE FROM products WHERE discontinued = 1;

-- CREATE TABLE
CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price REAL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ALTER TABLE
ALTER TABLE products ADD COLUMN stock INTEGER DEFAULT 0;

-- DROP TABLE (use with caution!)
DROP TABLE old_products;
```

### Query Safety

- System tables are accessible (read-only for some operations)
- All queries are executed with full permissions - use caution!
- No automatic transaction management - consider wrapping related operations

---

## Schema Viewer

The Schema Viewer displays your database structure.

### Viewing Tables

1. Go to **Server Settings > Schema**
2. Click on a table name to expand and view columns
3. Each column shows: name, type, nullable, default value, primary key status

### System Tables

Toggle **Show System Tables** to view OSW Studio's internal tables:
- `site_info` - Deployment metadata
- `files` - File contents
- `file_tree_nodes` - File tree structure
- `pageviews` / `interactions` / `sessions` - Analytics data
- `edge_functions` - Function definitions
- `function_logs` - Execution logs

System tables are marked with a "(system)" label.

---

## Execution Logs

View function execution history in the **Logs** tab.

### Log Information

Each log entry shows:
- **Status**: Success (2xx), redirect (3xx), or error (4xx/5xx)
- **Function**: Function name
- **Method**: HTTP method used
- **Path**: Request path
- **Duration**: Execution time in milliseconds
- **Time**: Timestamp

### Managing Logs

- Click **Refresh** to load latest logs
- Click **Clear** to delete all logs (cannot be undone)
- Logs are limited to the most recent 200 entries

---

## Best Practices

### Function Design

1. **Keep functions focused** - One function per operation
2. **Validate input** - Check `request.body` and `request.query` before use
3. **Handle errors** - Return appropriate HTTP status codes
4. **Use meaningful names** - `create-order` not `func1`

### Database Usage

1. **Use parameterized queries** - Prevents SQL injection
   ```javascript
   // Good
   db.query('SELECT * FROM users WHERE id = ?', [userId]);

   // Bad - SQL injection risk!
   db.query(`SELECT * FROM users WHERE id = ${userId}`);
   ```

2. **Create indexes** for frequently queried columns:
   ```sql
   CREATE INDEX idx_orders_user_id ON orders(user_id);
   ```

3. **Limit result sets** to avoid memory issues:
   ```javascript
   db.query('SELECT * FROM products LIMIT 100');
   ```

### Performance

1. **Set appropriate timeouts** - Don't use 30s if 5s is sufficient
2. **Minimize external requests** - Each `fetch()` adds latency
3. **Cache when possible** - Store API responses in your database

---

## Troubleshooting

### Function Returns 404
- Check that the function is **enabled**
- Verify the function name in the URL is correct
- Ensure the deployment is published and has database enabled

### Function Returns 500
- Check the **Logs** tab for error details
- Verify your SQL queries are valid
- Ensure external APIs are responding

### Query Execution Failed
- Check SQL syntax
- Verify table and column names
- Look for constraint violations (unique, foreign key)

### Cannot Access Table
- System tables are protected in edge functions
- Use the SQL Editor for system table access

---

## API Reference

### Public Endpoints

| Method | URL | Description |
|--------|-----|-------------|
| * | `/api/deployments/{deploymentId}/functions/{name}` | Invoke edge function |
| * | `/api/deployments/{deploymentId}/functions/{name}/*` | Invoke with path params |

### Admin Endpoints (Requires Authentication)

| Method | URL | Description |
|--------|-----|-------------|
| GET | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/functions` | List edge functions |
| POST | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/functions` | Create edge function |
| GET | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/functions/{id}` | Get edge function |
| PUT | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/functions/{id}` | Update edge function |
| DELETE | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/functions/{id}` | Delete edge function |
| GET | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/server-functions` | List server functions |
| POST | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/server-functions` | Create server function |
| GET | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/server-functions/{id}` | Get server function |
| PUT | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/server-functions/{id}` | Update server function |
| DELETE | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/server-functions/{id}` | Delete server function |
| GET | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/scheduled-functions` | List scheduled functions |
| POST | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/scheduled-functions` | Create scheduled function |
| GET | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/scheduled-functions/{id}` | Get scheduled function |
| PUT | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/scheduled-functions/{id}` | Update scheduled function |
| DELETE | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/scheduled-functions/{id}` | Delete scheduled function |
| GET | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/secrets` | List secrets (metadata only) |
| POST | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/secrets` | Create secret |
| GET | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/secrets/{id}` | Get secret (metadata only) |
| PUT | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/secrets/{id}` | Update secret |
| DELETE | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/secrets/{id}` | Delete secret |
| GET | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/database/schema` | Get schema |
| POST | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/database/query` | Execute SQL |
| GET | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/database/logs` | Get logs |
| DELETE | `/api/w/{workspaceId}/admin/deployments/{deploymentId}/database/logs` | Clear logs |

---

## AI Integration

OSW Studio's AI assistant can understand and work with your backend features when you select a deployment in the workspace.

### How It Works

1. **Project Backend Context** - When the project has Backend Enabled, its edge functions, helpers, secrets, schedules, and schema are mounted automatically in `/.server/`
2. **Optional Deployment Overlay** - Selecting a deployment in the workspace header additionally layers in that deployment's runtime state (published functions, live schema, etc.)
3. **AI Awareness** - The AI receives information about available:
   - Edge functions (endpoints, methods)
   - Database schema (tables, columns)
   - Server functions (helpers)
   - Scheduled functions (cron schedules)
   - Secrets (names only, not values)

### The `/.server/` Folder

When a deployment is selected, a hidden `/.server/` folder appears in the file explorer containing:

| Folder | Contents |
|--------|----------|
| `edge-functions/*.json` | Edge function endpoints |
| `server-functions/*.json` | Helper functions |
| `scheduled-functions/*.json` | Cron schedules |
| `secrets/*.json` | Secret names (not values) |
| `db/schema.sql` | Database schema |

These files reflect the project's backend feature state:
- **Schema** (`db/schema.sql`) is read-only — edit schema by running SQL in Project Settings or via the AI's `sqlite3` bash command
- **Functions, helpers, secrets, and schedules** can be created and edited by the AI using bash commands. Changes update the corresponding records in the project's database

Files are transient in the sense that they're regenerated from the project's backend state — you don't commit them manually.

### Using AI with Backend Features

**Example prompts:**

```
What tables are in the database?
```

```
Create an edge function to list all products
```

```
I need an endpoint that validates API keys using the STRIPE_KEY secret
```

```
Create a scheduled function to clean up old records every night
```

```
Help me design a schema for a blog with posts and comments
```

The AI can:
- Read and explain your current schema
- Suggest edge function implementations
- Reference available secrets by name
- Help design database structures
- Debug function issues

### Viewing Hidden Files

To see the `/.server/` folder:
1. Right-click in the File Explorer
2. Select **Show Hidden Files**
3. Look for the folder with the orange server icon

See also: **[Server Mode > Server Context Integration](?doc=server-mode#server-context-integration)** · **[MCP Server](?doc=mcp-server)**
