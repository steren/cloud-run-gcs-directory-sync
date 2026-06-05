// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const SHARED_DIR = process.env.SHARED_DIR || '/data';

// Set up Multer for processing file uploads in memory
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure shared directory exists
async function ensureDir() {
  try {
    await fs.mkdir(SHARED_DIR, { recursive: true });
    console.log(`Shared directory is active at: ${SHARED_DIR}`);
  } catch (err) {
    console.error(`Warning: Could not create shared directory ${SHARED_DIR}:`, err.message);
  }
}

// ==========================================
// SQLite Database Configuration
// ==========================================
const dbPath = path.join(SHARED_DIR, 'admin.sqlite');
let db;

function initDatabase() {
  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error('FATAL: Failed to connect to SQLite database:', err.message);
      return;
    }
    console.log(`Connected to SQLite database at: ${dbPath}`);

    // Create the users table for our fake Admin CRUD UI
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) {
        console.error('Failed to create users table:', err.message);
      } else {
        // Insert seed users if the table is currently empty
        db.get('SELECT COUNT(*) AS count FROM users', [], (err, row) => {
          if (!err && row.count === 0) {
            const stmt = db.prepare('INSERT INTO users (name, email, role, status) VALUES (?, ?, ?, ?)');
            stmt.run('Steren Giannini', 'steren@google.com', 'Administrator', 'Active');
            stmt.run('Jane Doe', 'jane.doe@example.com', 'Developer', 'Active');
            stmt.run('Bob Smith', 'bob.smith@example.com', 'Viewer', 'Suspended');
            stmt.finalize();
            console.log('Inserted GCS demo database seed users.');
          }
        });
      }
    });
  });
}

// ==========================================
// Helper functions
// ==========================================

// Parse dynamic relative path elements safely to block path traversal
function sanitizeRelativePath(relPath) {
  if (!relPath) return null;
  const parts = relPath.replace(/\\/g, '/').split('/').filter(part => part !== '' && part !== '..' && part !== '.');
  // Skip system folders
  if (parts.includes('lost+found') || parts.some(part => part.startsWith('.'))) {
    return null;
  }
  return parts;
}

// Build recursive file tree structure
async function getFileTree(dirPath, relativeDir = '') {
  const files = await fs.readdir(dirPath, { withFileTypes: true });
  const nodes = [];

  for (const file of files) {
    if (file.name === 'lost+found' || file.name.startsWith('.')) {
      continue;
    }

    const relPath = path.join(relativeDir, file.name);
    const absPath = path.join(dirPath, file.name);

    if (file.isDirectory()) {
      const children = await getFileTree(absPath, relPath);
      nodes.push({
        name: file.name,
        type: 'directory',
        path: relPath,
        children: children
      });
    } else {
      try {
        const stat = await fs.stat(absPath);
        nodes.push({
          name: file.name,
          type: 'file',
          path: relPath,
          size: stat.size,
          updatedAt: stat.mtime
        });
      } catch (e) {
        // Ignore files we cannot read
      }
    }
  }

  // Directories first, then files alphabetically
  nodes.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return nodes;
}

// ==========================================
// File Sync API Endpoints
// ==========================================

// 1. Recursive File Tree
app.get('/api/tree', async (req, res) => {
  try {
    await fs.mkdir(SHARED_DIR, { recursive: true });
    const tree = await getFileTree(SHARED_DIR);
    res.json({ success: true, tree });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Read specific file (nested or flat)
app.get('/api/files', async (req, res) => {
  const relPath = req.query.path;
  if (!relPath) {
    // Legacy support: flat list of files under /data
    try {
      await fs.mkdir(SHARED_DIR, { recursive: true });
      const files = await fs.readdir(SHARED_DIR);
      const fileDetails = [];
      for (const file of files) {
        if (file === 'lost+found' || file.startsWith('.')) continue;
        const fullPath = path.join(SHARED_DIR, file);
        try {
          const stat = await fs.stat(fullPath);
          if (stat.isFile()) {
            fileDetails.push({
              name: file,
              size: stat.size,
              updatedAt: stat.mtime
            });
          }
        } catch (e) {}
      }
      fileDetails.sort((a, b) => b.updatedAt - a.updatedAt);
      return res.json({ success: true, files: fileDetails });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  const parts = sanitizeRelativePath(relPath);
  if (!parts) {
    return res.status(400).json({ success: false, error: 'Invalid or unsafe path' });
  }

  const safePath = path.join(SHARED_DIR, ...parts);
  try {
    const content = await fs.readFile(safePath, 'utf8');
    res.json({ success: true, name: parts[parts.length - 1], content });
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(404).json({ success: false, error: 'File not found' });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// Legacy Endpoint Compatibility for opening file
app.get('/api/files/:filename', async (req, res) => {
  const name = req.params.filename;
  const safePath = path.join(SHARED_DIR, name.replace(/[^a-zA-Z0-9.\-_]/g, ''));
  try {
    const content = await fs.readFile(safePath, 'utf8');
    res.json({ success: true, name, content });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Create or Update file content
app.post('/api/files', async (req, res) => {
  const { path: relPath, content } = req.body;
  if (!relPath || content === undefined) {
    return res.status(400).json({ success: false, error: 'Missing path or content' });
  }

  const parts = sanitizeRelativePath(relPath);
  if (!parts) {
    return res.status(400).json({ success: false, error: 'Invalid or unsafe path' });
  }

  const safePath = path.join(SHARED_DIR, ...parts);
  try {
    await fs.mkdir(path.dirname(safePath), { recursive: true });
    await fs.writeFile(safePath, content, 'utf8');
    res.json({ success: true, message: 'File saved successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Legacy Endpoint Compatibility for saving file
app.post('/api/files/:filename', async (req, res) => {
  const name = req.params.filename.replace(/[^a-zA-Z0-9.\-_]/g, '');
  const safePath = path.join(SHARED_DIR, name);
  const { content } = req.body;
  try {
    await fs.writeFile(safePath, content, 'utf8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Delete file or directory
app.delete('/api/files', async (req, res) => {
  const relPath = req.query.path;
  if (!relPath) {
    return res.status(400).json({ success: false, error: 'Missing path parameter' });
  }

  const parts = sanitizeRelativePath(relPath);
  if (!parts) {
    return res.status(400).json({ success: false, error: 'Invalid or unsafe path' });
  }

  const safePath = path.join(SHARED_DIR, ...parts);
  try {
    const stat = await fs.stat(safePath);
    if (stat.isDirectory()) {
      await fs.rm(safePath, { recursive: true, force: true });
    } else {
      await fs.unlink(safePath);
    }
    res.json({ success: true, message: 'Deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Legacy Endpoint Compatibility for deleting file
app.delete('/api/files/:filename', async (req, res) => {
  const name = req.params.filename.replace(/[^a-zA-Z0-9.\-_]/g, '');
  const safePath = path.join(SHARED_DIR, name);
  try {
    await fs.unlink(safePath);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Preserve Folder Structure Upload Endpoint
app.post('/api/upload', upload.single('file'), async (req, res) => {
  let relPath = req.query.path;
  if (!relPath) {
    return res.status(400).json({ success: false, error: 'Missing path parameter' });
  }

  const parts = sanitizeRelativePath(relPath);
  if (!parts) {
    return res.status(400).json({ success: false, error: 'Invalid or unsafe path' });
  }

  const safePath = path.join(SHARED_DIR, ...parts);
  try {
    await fs.mkdir(path.dirname(safePath), { recursive: true });
    
    if (req.file) {
      await fs.writeFile(safePath, req.file.buffer);
    } else {
      return res.status(400).json({ success: false, error: 'No file data received' });
    }
    
    res.json({ success: true, path: parts.join('/') });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// SQLite Admin Users Database CRUD Endpoints
// ==========================================

// 1. READ ALL
app.get('/api/users', (req, res) => {
  db.all('SELECT * FROM users ORDER BY id DESC', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
    res.json({ success: true, users: rows });
  });
});

// 2. CREATE
app.post('/api/users', (req, res) => {
  const { name, email, role, status } = req.body;
  if (!name || !email || !role || !status) {
    return res.status(400).json({ success: false, error: 'Missing required user parameters' });
  }
  db.run('INSERT INTO users (name, email, role, status) VALUES (?, ?, ?, ?)', [name, email, role, status], function(err) {
    if (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
    res.json({ success: true, user: { id: this.lastID, name, email, role, status, created_at: new Date() } });
  });
});

// 3. UPDATE
app.put('/api/users/:id', (req, res) => {
  const { name, email, role, status } = req.body;
  if (!name || !email || !role || !status) {
    return res.status(400).json({ success: false, error: 'Missing required user parameters' });
  }
  db.run('UPDATE users SET name = ?, email = ?, role = ?, status = ? WHERE id = ?', [name, email, role, status, req.params.id], function(err) {
    if (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
    res.json({ success: true });
  });
});

// 4. DELETE
app.delete('/api/users/:id', (req, res) => {
  db.run('DELETE FROM users WHERE id = ?', [req.params.id], function(err) {
    if (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
    res.json({ success: true });
  });
});

// ==========================================
// Server Bootstrap
// ==========================================
ensureDir().then(() => {
  initDatabase();
  app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`Node.js Premium Multi-Functional App running on port ${PORT}`);
    console.log(`Active Mount: ${SHARED_DIR}`);
    console.log(`SQLite DB Path: ${dbPath}`);
    console.log(`Access UI: http://localhost:${PORT}`);
    console.log(`==================================================`);
  });
});
