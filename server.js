// Railway server for Balss Assistents shopping list
// Handles AI categorization, learning, and product suggestions

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const client = require('prom-client');
const Sentry = require('@sentry/node');
const OpenAI = require('openai');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Initialize Sentry
if (process.env.SENTRY_DSN) {
  Sentry.init({ 
    dsn: process.env.SENTRY_DSN, 
    tracesSampleRate: 0.1,
    environment: process.env.NODE_ENV || "production"
  });
}

const app = express();
const PORT = process.env.PORT || 3000;
const REQUIRED_BEARER = process.env.APP_BEARER_TOKEN;
const REQUIRE_BEARER = String(process.env.REQUIRE_BEARER).toLowerCase() === 'true';

// Optional fail-fast: only when explicitly enabled
if (REQUIRE_BEARER && !REQUIRED_BEARER) {
  console.error('❌ REQUIRE_BEARER=true but APP_BEARER_TOKEN is not set. Refusing to start.');
  process.exit(1);
}
if (!REQUIRE_BEARER && !REQUIRED_BEARER) {
  console.warn('⚠️ Bearer token enforcement is DISABLED (REQUIRE_BEARER=false). Server accepting requests without Authorization header.');
}

// Simple in-memory cache for responses
const responseCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const MAX_CACHE_SIZE = 1000; // Maximum 1000 cached responses

// Clean cache periodically
setInterval(() => {
  responseCache.clear();
  console.log('🗑️ Cache cleared');
}, CACHE_TTL);

// Sentry middleware
if (process.env.SENTRY_DSN) {
  app.use(Sentry.requestHandler());
  app.use(Sentry.tracingHandler());
}

// Prometheus metrics
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequests = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "path", "status"]
});

const httpLatency = new client.Histogram({
  name: "http_request_duration_ms",
  help: "HTTP request duration (ms)",
  labelNames: ["method", "path", "status"],
  buckets: [50, 100, 200, 400, 800, 1500, 3000, 5000]
});

const aiClassifications = new client.Counter({
  name: "ai_classifications_total",
  help: "Total AI classifications performed",
  labelNames: ["status"]
});

const databaseOperations = new client.Counter({
  name: "database_operations_total",
  help: "Total database operations",
  labelNames: ["operation", "table"]
});

const dictHits = new client.Counter({
  name: "dict_hits_total",
  help: "Total dictionary hits (products found in dictionary)",
  labelNames: ["slug"]
});

const dictMisses = new client.Counter({
  name: "dict_misses_total",
  help: "Total dictionary misses (products not found in dictionary)",
  labelNames: []
});

register.registerMetric(httpRequests);
register.registerMetric(httpLatency);
register.registerMetric(aiClassifications);
register.registerMetric(databaseOperations);
register.registerMetric(dictHits);
register.registerMetric(dictMisses);

// Product dictionary in memory
const productDict = new Map();
const TAXONOMY_VERSION = process.env.TAXONOMY_VERSION || "1.0.0";

// Middleware
app.use(cors());
app.use(express.json());

// Request ID middleware
app.use((req, res, next) => {
  req.requestId = req.header('X-Request-Id') || `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  next();
});

// Prometheus metrics middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const labels = { 
      method: req.method, 
      path: req.route?.path || req.path, 
      status: String(res.statusCode) 
    };
    httpRequests.inc(labels, 1);
    httpLatency.observe(labels, ms);
  });
  next();
});

// Bearer auth for API endpoints (except public health/version) — only enforce if required
app.use((req, res, next) => {
  // allowlist of public endpoints
  const publicPaths = new Set([
    '/',
    '/api/health',
    '/api/ready',
    '/api/version'
  ]);
  if (publicPaths.has(req.path)) return next();
  if (REQUIRE_BEARER) {
    const auth = req.header('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    if (token !== REQUIRED_BEARER) {
      return res.status(401).json({ error: 'unauthorized', requestId: req.requestId });
    }
  }
  next();
});

// X-User-Id validation middleware
app.use((req, res, next) => {
  const method = req.method?.toUpperCase();
  const needsUser = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  const isPublicGet = method === "GET" && ["/api/health", "/api/categories", "/api/suggestions"].includes(req.path);
  // Dart Master Pro endpoints don't require X-User-Id
  const isDartEndpoint = req.path.startsWith('/api/dart/');
  
  if (!needsUser || isPublicGet || isDartEndpoint) return next();
  
  const userId = req.header("X-User-Id");
  if (!userId || !/^u-\d+-[a-z0-9]{8}$/.test(userId)) {
    return res.status(400).json({ 
      error: "missing_or_invalid_user_id",
      requestId: req.requestId,
      expectedFormat: "u-timestamp-8chars"
    });
  }
  req.userId = userId;
  next();
});

// Structured logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const originalSend = res.send;
  
  res.send = function(data) {
    const duration = Date.now() - start;
    const logData = {
      requestId: req.requestId,
      userId: req.userId || 'anon',
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      userAgent: req.header('User-Agent'),
      appVersion: req.header('X-App-Version'),
      deviceId: req.header('X-Device-Id'),
      plan: req.header('X-Plan')
    };
    
    if (res.statusCode >= 400) {
      console.error(`❌ [${req.requestId}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`, logData);
    } else {
      console.log(`✅ [${req.requestId}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`, logData);
    }
    
    return originalSend.call(this, data);
  };
  
  next();
});

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  keyGenerator: (req) => req.userId || req.ip,
  message: {
    error: "rate_limit_exceeded",
    retryAfter: "1 minute"
  },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', limiter);

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* ===== OPENAI HELPER FUNCTIONS ===== */
// Models that don't support temperature parameter (only default 1)
const FIXED_TEMP_MODELS = new Set([
  "gpt-4o-mini-transcribe",
  "gpt-5-mini",
  "gpt-realtime",
  // Add other fixed-temp models here as needed
]);

/**
 * Build OpenAI API parameters with automatic temperature handling
 * @param {Object} params - API parameters
 * @param {string} params.model - Model name
 * @param {Array} params.messages - Messages array
 * @param {string} [params.system] - System message (alternative to messages)
 * @param {boolean} [params.json=false] - Use JSON response format
 * @param {number} [params.max=300] - Max completion tokens
 * @param {number|null} [params.temperature=0] - Temperature (0-2), null to omit
 * @returns {Object} OpenAI API parameters
 */
function buildParams({ model, messages, system, json = false, max = 300, temperature = 0 }) {
  const p = {
    model,
    max_completion_tokens: max,
  };

  if (messages) p.messages = messages;
  if (system) {
    // If system is provided separately, prepend it to messages or create new messages array
    if (!messages) {
      p.messages = [{ role: "system", content: system }];
    } else {
      // Prepend system message if not already present
      const hasSystem = messages.some(m => m.role === "system");
      if (!hasSystem) {
        p.messages = [{ role: "system", content: system }, ...messages];
      }
    }
  }

  if (json) p.response_format = { type: "json_object" };

  // Only include temperature if the model allows it
  if (!FIXED_TEMP_MODELS.has(model) && temperature != null) {
    p.temperature = temperature;
  }

  return p;
}

/**
 * Safe OpenAI API call with automatic temperature retry
 * @param {Object} params - OpenAI API parameters
 * @returns {Promise} OpenAI API response
 */
async function safeCreate(params) {
  try {
    return await openai.chat.completions.create(params);
  } catch (e) {
    const msg = e?.error?.message || e?.message || "";
    if (msg.includes("temperature") && msg.includes("Only the default (1) value is supported")) {
      // Retry without temperature parameter
      const clone = { ...params };
      delete clone.temperature;
      console.log(`⚠️ Temperature not supported for ${params.model}, retrying without temperature`);
      return await openai.chat.completions.create(clone);
    }
    throw e;
  }
}

// Database setup
// DB_PATH lets the file live on a persistent volume (e.g. /data/products.db on Railway);
// without it the DB sits in the container filesystem and is lost on every redeploy.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'products.db');
const db = new sqlite3.Database(dbPath);

console.log(`✅ Database initialized at ${dbPath}`);

// Initialize database
db.serialize(() => {
  // Products table - stores all products with their categories
  db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    normalized_name TEXT NOT NULL,
    category TEXT NOT NULL,
    confidence REAL DEFAULT 1.0,
    source TEXT DEFAULT 'ai',
    usage_count INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Categories table - stores available categories
  db.run(`CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    icon TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    aisle_order INTEGER NOT NULL
  )`);

  // Insert default categories
  const defaultCategories = [
    { name: 'Dārzeņi', icon: '🥕', slug: 'vegetables', aisle_order: 10 },
    { name: 'Augļi', icon: '🍎', slug: 'fruits', aisle_order: 20 },
    { name: 'Gaļa', icon: '🥩', slug: 'meat', aisle_order: 30 },
    { name: 'Zivis', icon: '🐟', slug: 'fish', aisle_order: 40 },
    { name: 'Piena produkti', icon: '🧀', slug: 'dairy', aisle_order: 50 },
    { name: 'Olas', icon: '🥚', slug: 'eggs', aisle_order: 55 },
    { name: 'Maize', icon: '🍞', slug: 'bakery', aisle_order: 60 },
    { name: 'Graudi', icon: '🌾', slug: 'grains', aisle_order: 70 },
    { name: 'Uzkodas', icon: '🍫', slug: 'snacks', aisle_order: 80 },
    { name: 'Gatavie ēdieni', icon: '🧊', slug: 'ready_meals', aisle_order: 90 },
    { name: 'Dzērieni', icon: '🥤', slug: 'beverages', aisle_order: 100 },
    { name: 'Mājsaimniecība', icon: '🧴', slug: 'household', aisle_order: 200 },
    { name: 'Higiēna', icon: '🧼', slug: 'hygiene', aisle_order: 210 },
    { name: 'Mājdzīvniekiem', icon: '🐾', slug: 'pet', aisle_order: 220 },
    { name: 'Starptautiskie', icon: '🌍', slug: 'international', aisle_order: 230 },
    { name: 'Būvniecība', icon: '🧱', slug: 'construction', aisle_order: 240 }
  ];

  const stmt = db.prepare(`INSERT OR IGNORE INTO categories (name, icon, slug, aisle_order) VALUES (?, ?, ?, ?)`);
  defaultCategories.forEach(cat => {
    stmt.run(cat.name, cat.icon, cat.slug, cat.aisle_order);
  });
  stmt.finalize();
  
  // Create indexes for better performance
  db.run(`CREATE INDEX IF NOT EXISTS idx_normalized_name ON products(normalized_name)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_category ON products(category)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_usage_count ON products(usage_count DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_name ON products(name)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_updated_at ON products(updated_at DESC)`);
  
  // Dart Master Pro tables
  // Players table
  db.run(`CREATE TABLE IF NOT EXISTS dart_players (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar TEXT,
    stats TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Games table
  db.run(`CREATE TABLE IF NOT EXISTS dart_games (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    mode TEXT NOT NULL,
    players TEXT NOT NULL,
    winner TEXT,
    player_stats TEXT NOT NULL,
    legs_to_win INTEGER,
    double_in BOOLEAN DEFAULT 0,
    double_out BOOLEAN DEFAULT 0,
    start_time INTEGER NOT NULL,
    end_time INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Create indexes for dart tables
  db.run(`CREATE INDEX IF NOT EXISTS idx_dart_games_start_time ON dart_games(start_time DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_dart_games_end_time ON dart_games(end_time DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_dart_games_winner ON dart_games(winner)`);
  
  console.log('✅ Database indexes created');
  console.log('✅ Dart Master Pro tables initialized');
});

// Load product dictionary from CSV
function loadProductDictionary() {
  const dictPath = process.env.DICT_FILE || path.join(__dirname, 'data/ontology/products_base_lv_520.csv');
  
  try {
    if (!fs.existsSync(dictPath)) {
      console.warn(`⚠️ Dictionary file not found: ${dictPath}`);
      return;
    }
    
    const content = fs.readFileSync(dictPath, 'utf8');
    const lines = content.split('\n');
    
    // Skip header (first line)
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const [term, slug] = line.split(',');
      if (!term || !slug) continue;
      
      // Normalize term and store
      const normalized = normalizeInput(term);
      productDict.set(normalized, slug.trim());
    }
    
    console.log(`✅ Loaded ${productDict.size} products from dictionary`);
    
  } catch (error) {
    console.error(`❌ Failed to load product dictionary: ${error.message}`);
  }
}

// Load dictionary on startup
loadProductDictionary();

// Helper functions
function normalizeInput(input) {
  return input.toLowerCase()
    .replace(/ā/g, 'a')
    .replace(/ē/g, 'e')
    .replace(/ī/g, 'i')
    .replace(/ō/g, 'o')
    .replace(/ū/g, 'u')
    .replace(/č/g, 'c')
    .replace(/ģ/g, 'g')
    .replace(/ķ/g, 'k')
    .replace(/ļ/g, 'l')
    .replace(/ņ/g, 'n')
    .replace(/š/g, 's')
    .replace(/ž/g, 'z')
    .replace(/[.,-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Health endpoints
app.get('/', (req, res) => res.json({ 
  ok: true, 
  requestId: req.requestId,
  timestamp: new Date().toISOString()
}));

app.get('/api/health', (req, res) => res.json({ 
  status: "healthy",
  requestId: req.requestId,
  timestamp: new Date().toISOString(),
  uptime: process.uptime()
}));

app.get('/api/ready', (req, res) => {
  // Check if database and OpenAI are accessible
  const isReady = !!process.env.OPENAI_API_KEY;
  const status = isReady ? "ready" : "not_ready";
  const statusCode = isReady ? 200 : 503;
  
  res.status(statusCode).json({
    status,
    requestId: req.requestId,
    timestamp: new Date().toISOString(),
    openai: isReady ? "configured" : "missing",
    database: "sqlite"
  });
});

app.get('/api/version', (req, res) => res.json({
  version: "2025.01.15-1",
  requestId: req.requestId,
  timestamp: new Date().toISOString(),
  commit: process.env.RAILWAY_GIT_COMMIT_SHA || "unknown",
  node: process.version
}));

// Protect metrics with bearer token only if required
app.get('/api/metrics', async (req, res) => {
  if (REQUIRE_BEARER) {
    const auth = req.header('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    if (token !== REQUIRED_BEARER) {
      return res.status(401).json({ error: 'unauthorized', requestId: req.requestId });
    }
  }
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// API Routes

// 1. Classify products
app.post('/api/classify-products', async (req, res) => {
  try {
    const { products } = req.body;
    
    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ 
        error: 'Products array is required',
        requestId: req.requestId
      });
    }

    console.log(`🤖 [${req.requestId}] Classifying ${products.length} products:`, products);

    // Check cache first
    const cacheKey = JSON.stringify(products.sort());
    if (responseCache.has(cacheKey)) {
      console.log(`✅ [${req.requestId}] Cache hit - returning cached response`);
      return res.json(responseCache.get(cacheKey));
    }

    // BATCH PROCESSING: Check database first for known products
    const normalizedNames = products.map(p => normalizeInput(p));
    const placeholders = normalizedNames.map(() => '?').join(',');
    
    // Single batch query instead of N+1 queries
    const knownProductsMap = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM products WHERE normalized_name IN (${placeholders})`,
        normalizedNames,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    // Create lookup map for quick access
    const knownProductsDict = {};
    knownProductsMap.forEach(row => {
      knownProductsDict[row.normalized_name] = row;
    });

    const knownProducts = [];
    const unknownProducts = [];
    const dictProducts = [];
    const productMap = new Map(); // Map products to their normalized names

    products.forEach((product, index) => {
      const normalizedName = normalizedNames[index];
      productMap.set(normalizedName, product);
      
      if (knownProductsDict[normalizedName]) {
        // From database
        knownProducts.push({
          product: product,
          category: knownProductsDict[normalizedName].category,
          confidence: knownProductsDict[normalizedName].confidence,
          source: knownProductsDict[normalizedName].source
        });
      } else if (productDict.has(normalizedName)) {
        // From dictionary
        const category = productDict.get(normalizedName);
        dictHits.inc({ slug: category });
        dictProducts.push({
          product: product,
          category: validateAndMapCategory(category),
          confidence: 1.0,
          source: 'dictionary'
        });
      } else {
        // Need AI classification
        dictMisses.inc();
        unknownProducts.push(product);
      }
    });

    // Batch update usage counts for known products
    const knownIds = Object.values(knownProductsDict).map(row => row.id);
    if (knownIds.length > 0) {
      const updatePlaceholders = knownIds.map(() => '?').join(',');
      db.run(
        `UPDATE products SET usage_count = usage_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id IN (${updatePlaceholders})`,
        knownIds
      );
    }

    // If all products are found (DB or dict), return immediately
    if (unknownProducts.length === 0) {
      console.log(`✅ [${req.requestId}] All products found (DB: ${knownProducts.length}, Dict: ${dictProducts.length})`);
      
      // Combine DB and dictionary results
      const allClassifications = [...knownProducts, ...dictProducts];
      
      // Validate all categories
      const validatedClassifications = allClassifications.map(cls => ({
        ...cls,
        category: validateAndMapCategory(cls.category)
      }));
      
      const response = { 
        classifications: validatedClassifications,
        cached: true,
        requestId: req.requestId
      };
      
      // Add taxonomy version header
      res.set('X-Taxonomy-Version', TAXONOMY_VERSION);
      
      // Cache the response
      if (responseCache.size < MAX_CACHE_SIZE) {
        responseCache.set(cacheKey, response);
      }
      
      return res.json(response);
    }

    // Use AI for unknown products
    console.log(`🤖 [${req.requestId}] Using AI for ${unknownProducts.length} unknown products`);
    
    const aiResults = await classifyWithAI(unknownProducts);
    
    // Track AI classifications
    aiClassifications.inc({ status: "success" }, unknownProducts.length);
    
    // Save AI classifications to database (already validated)
    for (const classification of aiResults) {
      const normalizedName = normalizeInput(classification.product);
      
      // category is already validated by validateAndMapCategory
      db.run(
        `INSERT INTO products (name, normalized_name, category, confidence, source) 
         VALUES (?, ?, ?, ?, ?)`,
        [classification.product, normalizedName, classification.category, 0.8, 'ai']
      );
    }

    // Combine known, dictionary, and AI classifications
    const allClassifications = [...knownProducts, ...dictProducts, ...aiResults];
    
    // Validate all categories (including known ones from DB)
    const validatedClassifications = allClassifications.map(cls => ({
      ...cls,
      category: validateAndMapCategory(cls.category)
    }));
    
    const response = {
      classifications: validatedClassifications,
      cached: false,
      aiUsed: true,
      requestId: req.requestId
    };
    
    // Add taxonomy version header
    res.set('X-Taxonomy-Version', TAXONOMY_VERSION);
    
    // Cache the response
    if (responseCache.size < MAX_CACHE_SIZE) {
      responseCache.set(cacheKey, response);
      console.log(`💾 [${req.requestId}] Response cached (size: ${responseCache.size})`);
    }

    res.json(response);

  } catch (error) {
    console.error('❌ Classification error:', error);
    res.status(500).json({ error: 'Classification failed', details: error.message });
  }
});

// 2. Correct product names using AI
app.post('/api/correct-names', async (req, res) => {
  try {
    const { products } = req.body;
    
    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'Products array is required' });
    }

    console.log(`🔧 Correcting ${products.length} product names:`, products);

    // Use OpenAI to correct product names
    const productList = products.join(', ');
    
    const systemMessage = "Tu esi eksperts latviešu valodā. Labo produktu nosaukumus, lai tie būtu gramatiski pareizi un skaidri. SAGLABĀJ brand nosaukumus, personu vārdus, ciparus un specifiskus aprakstus. Ja nosaukums jau ir pareizs, atstāj to nemainītu. Atbildi tikai JSON formātā.";
    const userMessage = `Labo šos produktu nosaukumus latviešu valodā: ${productList}

Svarīgi - SAGLABĀJ (NEMAINĪT):
- Brand nosaukumus: "dore blue siers" → "dore blue siers"
- Personu vārdus: "WhatsApp sapulce ar Silardu" → "WhatsApp sapulce ar Silardu"
- Ciparus un datus: "projekts 2024" → "projekts 2024"
- Specifiskus aprakstus: "bērnu cīsiņi" → "bērnu cīsiņi"
- Produktu veidus: "bezlaktozes jogurts" → "bezlaktozes jogurts"

Labo gramatikas kļūdas un sajukumu:
- "biespiena sieriņš" → "biezpiena sieriņš"
- "apelsinu sulu" → "apelsīnu sula" 
- "balto vinu" → "baltais vīns"
- "degvins" → "degvīns"
- "kefirs" → "kefīrs"
- "purciņas" → "burciņas"
- ⚠️ "purkšķus" → "burciņas"

⚠️ NELABO ārā kontekstu un personu vārdus:
- "WhatsApp sapulce ar Silardu" → NEMAINĪT (personvārds)
- "Projekts 2024" → NEMAINĪT (cipars)

Atbildi JSON formātā:
{
  "correctedNames": ["labots_nosaukums1", "labots_nosaukums2", ...]
}`;

    const messages = [
      { role: "system", content: systemMessage },
      { role: "user", content: userMessage }
    ];

    const response = await safeCreate(
      buildParams({
        model: "gpt-5-mini",
        messages: messages,
        json: true,
        max: 500,
        temperature: 0.1
      })
    );

    const content = response.choices[0].message.content.trim();
    console.log('🔧 AI correction response:', content);

    // Parse JSON response
    const correctedData = JSON.parse(content);
    const correctedNames = correctedData.correctedNames || products;

    console.log('✅ Corrected names:', correctedNames);
    res.json({ correctedNames });

  } catch (error) {
    console.error('❌ Name correction error:', error);
    res.status(500).json({ error: 'Name correction failed', details: error.message });
  }
});

// 3. Learn from user corrections
app.post('/api/learn', async (req, res) => {
  try {
    const { product, correctCategory } = req.body;
    
    if (!product || !correctCategory) {
      return res.status(400).json({ error: 'Product and correctCategory are required' });
    }

    const normalizedName = normalizeInput(product);
    
    // Validate category before saving
  const validatedCategory = validateAndMapCategory(correctCategory);
  
  // Update or insert the correct classification
    db.run(
      `INSERT INTO products (name, normalized_name, category, confidence, source) 
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(normalized_name) DO UPDATE SET
       category = excluded.category,
       confidence = 1.0,
       source = 'manual',
       updated_at = CURRENT_TIMESTAMP`,
      [product, normalizedName, validatedCategory, 1.0, 'manual']
    );

    console.log(`📚 Learned: "${product}" → "${correctCategory}"`);

    res.json({ success: true, message: 'Learning saved' });

  } catch (error) {
    console.error('❌ Learning error:', error);
    res.status(500).json({ error: 'Learning failed', details: error.message });
  }
});

// 3. Get product suggestions
app.get('/api/suggestions', async (req, res) => {
  try {
    const { query, limit = 10 } = req.query;
    
    let sql = `
      SELECT name, category, usage_count 
      FROM products 
      WHERE usage_count > 0
    `;
    let params = [];

    if (query) {
      const normalizedQuery = normalizeInput(query);
      sql += ` AND (name LIKE ? OR normalized_name LIKE ?)`;
      params.push(`%${query}%`, `%${normalizedQuery}%`);
    }

    sql += ` ORDER BY usage_count DESC, name ASC LIMIT ?`;
    params.push(parseInt(limit));

    const suggestions = await new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    res.json({ suggestions });

  } catch (error) {
    console.error('❌ Suggestions error:', error);
    res.status(500).json({ error: 'Failed to get suggestions', details: error.message });
  }
});

// 4. Get all categories
app.get('/api/categories', async (req, res) => {
  try {
    const categories = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM categories ORDER BY aisle_order', (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    res.json({ categories });

  } catch (error) {
    console.error('❌ Categories error:', error);
    res.status(500).json({ error: 'Failed to get categories', details: error.message });
  }
});

// 5. Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// ==========================================
// DART MASTER PRO API ENDPOINTS
// ==========================================

// Get all players
app.get('/api/dart/players', async (req, res) => {
  try {
    const players = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM dart_players ORDER BY created_at DESC', (err, rows) => {
        if (err) reject(err);
        else {
          const parsed = rows.map(row => ({
            ...row,
            stats: JSON.parse(row.stats)
          }));
          resolve(parsed);
        }
      });
    });
    res.json({ players, requestId: req.requestId });
  } catch (error) {
    console.error('❌ Get players error:', error);
    res.status(500).json({ error: 'Failed to get players', details: error.message, requestId: req.requestId });
  }
});

// Save/Update player
app.post('/api/dart/players', async (req, res) => {
  try {
    const { players } = req.body;
    if (!players || !Array.isArray(players)) {
      return res.status(400).json({ error: 'Players array is required', requestId: req.requestId });
    }

    const stmt = db.prepare(`INSERT OR REPLACE INTO dart_players (id, name, avatar, stats, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`);
    
    for (const player of players) {
      stmt.run(
        player.id,
        player.name,
        player.avatar || '',
        JSON.stringify(player.stats || {})
      );
    }
    stmt.finalize();

    res.json({ success: true, message: `Saved ${players.length} player(s)`, requestId: req.requestId });
  } catch (error) {
    console.error('❌ Save players error:', error);
    res.status(500).json({ error: 'Failed to save players', details: error.message, requestId: req.requestId });
  }
});

// Delete player
app.delete('/api/dart/players/:id', async (req, res) => {
  try {
    const { id } = req.params;
    db.run('DELETE FROM dart_players WHERE id = ?', [id], function(err) {
      if (err) {
        return res.status(500).json({ error: 'Failed to delete player', details: err.message, requestId: req.requestId });
      }
      res.json({ success: true, message: 'Player deleted', requestId: req.requestId });
    });
  } catch (error) {
    console.error('❌ Delete player error:', error);
    res.status(500).json({ error: 'Failed to delete player', details: error.message, requestId: req.requestId });
  }
});

// Get all games
app.get('/api/dart/games', async (req, res) => {
  try {
    const games = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM dart_games ORDER BY start_time DESC', (err, rows) => {
        if (err) reject(err);
        else {
          const parsed = rows.map(row => ({
            id: row.id,
            type: row.type,
            mode: row.mode,
            players: JSON.parse(row.players),
            winner: row.winner,
            playerStats: JSON.parse(row.player_stats),
            legsToWin: row.legs_to_win,
            doubleIn: Boolean(row.double_in),
            doubleOut: Boolean(row.double_out),
            startTime: row.start_time,
            endTime: row.end_time
          }));
          resolve(parsed);
        }
      });
    });
    res.json({ games, requestId: req.requestId });
  } catch (error) {
    console.error('❌ Get games error:', error);
    res.status(500).json({ error: 'Failed to get games', details: error.message, requestId: req.requestId });
  }
});

// Save game
app.post('/api/dart/games', async (req, res) => {
  try {
    const game = req.body;
    if (!game || !game.id) {
      return res.status(400).json({ error: 'Game object with id is required', requestId: req.requestId });
    }

    db.run(
      `INSERT OR REPLACE INTO dart_games 
       (id, type, mode, players, winner, player_stats, legs_to_win, double_in, double_out, start_time, end_time, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        game.id,
        game.type || 'X01',
        game.mode || '501',
        JSON.stringify(game.players || []),
        game.winner || null,
        JSON.stringify(game.playerStats || {}),
        game.legsToWin || null,
        game.doubleIn ? 1 : 0,
        game.doubleOut ? 1 : 0,
        game.startTime || Date.now(),
        game.endTime || null
      ],
      function(err) {
        if (err) {
          return res.status(500).json({ error: 'Failed to save game', details: err.message, requestId: req.requestId });
        }
        res.json({ success: true, message: 'Game saved', requestId: req.requestId });
      }
    );
  } catch (error) {
    console.error('❌ Save game error:', error);
    res.status(500).json({ error: 'Failed to save game', details: error.message, requestId: req.requestId });
  }
});

// ==========================================
// OCR TEXT NORMALIZATION ENDPOINTS
// ==========================================

// POST /api/ocr/normalize
// AI-powered text normalization for OCR results
// Cleans up OCR artifacts, fixes Latvian diacritics, and structures text
app.post('/api/ocr/normalize', async (req, res) => {
  try {
    const { text, language = 'lv' } = req.body;
    
    if (!text || text.trim().length === 0) {
      return res.status(400).json({ 
        error: 'Text is required',
        requestId: req.requestId 
      });
    }
    
    // Limit text length to prevent abuse
    const maxLength = 10000;
    if (text.length > maxLength) {
      return res.status(400).json({ 
        error: `Text too long. Maximum ${maxLength} characters allowed.`,
        requestId: req.requestId 
      });
    }
    
    console.log(`📝 [${req.requestId}] OCR Normalize - Processing ${text.length} characters in ${language}`);
    
    const normalizedText = await normalizeOCRText(text, language);
    
    res.json({
      original_text: text,
      normalized_text: normalizedText,
      language: language,
      character_count: normalizedText.length,
      requestId: req.requestId
    });
    
  } catch (error) {
    console.error(`❌ [${req.requestId}] OCR Normalize error:`, error);
    res.status(500).json({ 
      error: error.message || 'Failed to normalize text',
      requestId: req.requestId 
    });
  }
});

// Helper: Normalize OCR text using GPT
async function normalizeOCRText(text, language = 'lv') {
  const systemPrompt = language === 'lv' 
    ? `Tu esi teksta korekcijas asistents. Tavs uzdevums ir izlabot OCR (optiskās rakstzīmju atpazīšanas) kļūdas tekstā.

Veic šādas korekcijas:
1. Izlabo acīmredzamas drukas kļūdas un OCR artefaktus
2. Pievieno pareizās latviešu diakritiskās zīmes (ā, ē, ī, ū, č, ģ, ķ, ļ, ņ, š, ž)
3. Izlabo nepareizi sadalītus vārdus (piem. "lab dien" -> "labdien")
4. Normalizē atstarpju un rindu pārrāvumus
5. Saglabā oriģinālo teksta struktūru un nozīmi
6. NESĀC atbildi ar "Labots teksts:" vai līdzīgu ievadu - atgriez TIKAI izlaboto tekstu

Atgriez TIKAI izlaboto tekstu, bez paskaidrojumiem.`
    : `You are a text correction assistant. Your task is to fix OCR (Optical Character Recognition) errors in text.

Make these corrections:
1. Fix obvious typos and OCR artifacts
2. Add correct diacritical marks for the language
3. Fix incorrectly split words
4. Normalize spacing and line breaks
5. Preserve original text structure and meaning
6. DO NOT start with "Corrected text:" or similar - return ONLY the corrected text

Return ONLY the corrected text, without explanations.`;

  try {
    const response = await safeCreate(
      buildParams({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text }
        ],
        temperature: 0.3, // Lower temperature for more consistent corrections
        max: Math.min(text.length * 2, 4000) // Allow up to 2x expansion, max 4000 tokens
      })
    );

    const normalizedText = response.choices[0].message.content.trim();
    console.log(`✅ OCR text normalized: ${text.length} -> ${normalizedText.length} characters`);
    
    return normalizedText;
  } catch (error) {
    console.error('❌ GPT normalization error:', error);
    // Return original text if normalization fails
    return text;
  }
}

// Category mapping: alias → official slug
const CATEGORY_MAPPING = {
  // Garšvielas/piedevas
  'spices': 'condiments',
  'garšvielas': 'condiments',
  'seasonings': 'condiments',
  'herbs': 'condiments',
  'garšvielām': 'condiments',
  'spice': 'condiments',
  'seasoning': 'condiments',
  'herb': 'condiments',
  
  // Other mappings
  'unknown': 'other'
};

// Official categories that app recognizes
const OFFICIAL_CATEGORIES = [
  'vegetables', 'fruits', 'meat', 'fish', 'dairy', 'eggs',
  'bakery', 'grains', 'condiments', 'snacks', 'ready_meals',
  'beverages', 'household', 'hygiene', 'pet', 'international',
  'construction', 'other'
];

// Validate and map category
function validateAndMapCategory(rawCategory) {
  const lowercased = rawCategory.toLowerCase().trim();
  
  // 1. Pārbaudīt, vai ir oficiālā kategorija
  if (OFFICIAL_CATEGORIES.includes(lowercased)) {
    return lowercased;
  }
  
  // 2. Map alias → oficiālais slug
  if (CATEGORY_MAPPING[lowercased]) {
    console.log(`📌 Category mapped: '${rawCategory}' → '${CATEGORY_MAPPING[lowercased]}'`);
    return CATEGORY_MAPPING[lowercased];
  }
  
  // 3. Fallback uz "other" + warning
  console.warn(`⚠️ Unknown category: '${rawCategory}', defaulting to 'other'`);
  return 'other';
}

// AI Classification function
// Enhanced to handle Latvian brand names, international products, and compound product names
async function classifyWithAI(products) {
  const productList = products.join(', ');
  
  const prompt = `Tu esi eksperts pārtikas produktu klasifikācijā LATVIEŠU valodā. Tev ir jāklasificē produkti no Latvijas veikalu iepirkumu sarakstiem.

KATEGORIJAS (izmanto TIKAI šos slug nosaukumus):
- vegetables (dārzeņi - kartupeļi, tomāti, gurķi, kāposti, bietes u.c.)
- fruits (augļi - āboli, banāni, apelsīni, vīnogas, ogas u.c.)
- meat (GAĻA un DESAS - visa veida gaļa, desas, šķiņķis, bekons, cīsiņi, salami, chorizo, prosciutto u.c.)
- fish (zivis - lasis, forele, siļķe, garneles, tunzivis u.c.)
- dairy (piena produkti - piens, siers, biezpiens, jogurts, sviests, krējums, kefīrs u.c.)
- eggs (olas)
- bakery (maize un konditorejas - maize, bulciņas, kruasāni, kūkas, cepumi u.c.)
- grains (graudi un makaroni - rīsi, griķi, makaroni, spageti, auzu pārslas u.c.)
- condiments (piedevas - eļļa, garšvielas, mērces, kečups, majonēze, sāls, pipari, cukurs, medus u.c.)
- snacks (uzkodas - čipsi, šokolāde, konfektes, rieksti, saldējums u.c.)
- ready_meals (gatavie ēdieni - pelmeņi, pica, konservi, saldēti ēdieni u.c.)
- beverages (dzērieni - ūdens, sula, alus, vīns, kafija, tēja, limonāde u.c.)
- household (mājsaimniecība - tīrīšanas līdzekļi, veļas pulveris, salvetes u.c.)
- hygiene (higiēna - zobu pasta, šampūns, ziepes, dezodorants u.c.)
- pet (mājdzīvniekiem - kaķu/suņu barība u.c.)
- construction (būvniecība - krāsas, instrumenti u.c.)

SVARĪGI NOTEIKUMI:

1. BRENDI UN RAŽOTĀJI:
   - "Smiltenes biezpiens" → dairy (biezpiens ir galvenais produkts, Smiltene ir brends)
   - "Valmieras piens" → dairy (piens ir galvenais produkts)
   - "Kārums sieriņi" → dairy (sieriņi ir galvenais produkts)
   - "Laima šokolāde" → snacks (šokolāde ir galvenais produkts)
   - "Dore Blue siers" → dairy (siers ir galvenais produkts)

2. STARPTAUTISKĀS DESAS UN GAĻA (VISI ir "meat" kategorijā):
   - "spāņu desa", "čorizo", "chorizo" → meat
   - "itāļu desa", "salami", "prosciutto" → meat
   - "vācu desa", "bratwurst" → meat
   - "poļu desa", "kielbasa" → meat
   - "mortadella", "pepperoni" → meat

3. PRODUKTI AR APRAKSTIEM:
   - "liellopa maltā gaļa 600g" → meat (galvenais: gaļa)
   - "vistas fileja marinēta ar ķiplokiem" → meat (galvenais: fileja/gaļa)
   - "bezlaktozes piens 2.5%" → dairy (galvenais: piens)
   - "grieķu jogurts ar zemenēm" → dairy (galvenais: jogurts)

4. STARPTAUTISKIE SIERI (visi ir "dairy"):
   - "mozzarella", "parmazāns", "čeders", "gouda", "brie" → dairy

5. ALKOHOLS UN DZĒRIENI (visi ir "beverages"):
   - "sarkanvīns", "baltvīns", "alus", "šampanietis" → beverages

Produkti: ${productList}

Atbildi JSON formātā ar šādu struktūru:
[{"product": "produkta nosaukums", "category": "category_slug"}]

NEKAD neizmanto kategorijas, kas nav sarakstā augstāk!`;

  try {
    const completion = await safeCreate(
      buildParams({
        model: "gpt-5-mini",
        messages: [
          { role: "system", content: "Tu esi eksperts Latvijas pārtikas produktu klasifikācijā. Atbildi TIKAI JSON formātā. Klasificē produktus pēc to galvenā nosaukuma, ignorējot brendus un aprakstus." },
          { role: "user", content: prompt }
        ],
        json: true,
        max: 1000,
        temperature: 0.1
      })
    );

    const content = completion.choices[0].message.content.trim();
    console.log('🤖 AI Response:', content);

    // Clean JSON response
    const cleanContent = content
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();

    const classifications = JSON.parse(cleanContent);
    
    // Validate and map all categories before returning
    const validatedClassifications = classifications.map(cls => ({
      ...cls,
      category: validateAndMapCategory(cls.category)
    }));
    
    console.log(`✅ AI classified ${validatedClassifications.length} products`);
    return validatedClassifications;

  } catch (error) {
    console.error('❌ AI Classification error:', error);
    throw new Error(`AI classification failed: ${error.message}`);
  }
}

// Sentry error handler
if (process.env.SENTRY_DSN) {
  app.use(Sentry.errorHandler());
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Balss Assistents Server running on port ${PORT}`);
  console.log(`📊 Database: ${dbPath}`);
  console.log(`🤖 OpenAI API: ${process.env.OPENAI_API_KEY ? 'Configured' : 'Missing'}`);
  console.log(`📈 Sentry: ${process.env.SENTRY_DSN ? 'Configured' : 'Not configured'}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Shutting down server...');
  db.close((err) => {
    if (err) {
      console.error('❌ Error closing database:', err);
    } else {
      console.log('✅ Database closed');
    }
    process.exit(0);
  });
});

