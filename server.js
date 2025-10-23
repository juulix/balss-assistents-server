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

register.registerMetric(httpRequests);
register.registerMetric(httpLatency);
register.registerMetric(aiClassifications);
register.registerMetric(databaseOperations);

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

// X-User-Id validation middleware
app.use((req, res, next) => {
  const method = req.method?.toUpperCase();
  const needsUser = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  const isPublicGet = method === "GET" && ["/api/health", "/api/categories", "/api/suggestions"].includes(req.path);
  
  if (!needsUser || isPublicGet) return next();
  
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
    requestId: (req) => req.requestId,
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

// Database setup
const dbPath = path.join(__dirname, 'products.db');
const db = new sqlite3.Database(dbPath);

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
    { name: 'Alkohols', icon: '🍷', slug: 'alcohol', aisle_order: 110 },
    { name: 'Sausā gaļa', icon: '🥓', slug: 'deli', aisle_order: 120 },
    { name: 'Bērnu barība', icon: '👶', slug: 'baby_food', aisle_order: 130 },
    { name: 'Mājsaimniecība', icon: '🧴', slug: 'household', aisle_order: 200 },
    { name: 'Higiēna', icon: '🧼', slug: 'hygiene', aisle_order: 210 },
    { name: 'Mājdzīvniekiem', icon: '🐾', slug: 'pet', aisle_order: 220 },
    { name: 'Starptautiskie', icon: '🌍', slug: 'international', aisle_order: 230 },
    { name: 'Būvniecība', icon: '🧱', slug: 'construction', aisle_order: 240 },
    { name: 'Cits', icon: '❓', slug: 'other', aisle_order: 999 }
  ];

  const stmt = db.prepare(`INSERT OR IGNORE INTO categories (name, icon, slug, aisle_order) VALUES (?, ?, ?, ?)`);
  defaultCategories.forEach(cat => {
    stmt.run(cat.name, cat.icon, cat.slug, cat.aisle_order);
  });
  stmt.finalize();
});

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

app.get('/api/metrics', async (req, res) => {
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

    // Check database first for known products
    const knownProducts = [];
    const unknownProducts = [];

    for (const product of products) {
      const normalizedName = normalizeInput(product);
      
      const existingProduct = await new Promise((resolve, reject) => {
        db.get(
          'SELECT * FROM products WHERE normalized_name = ?',
          [normalizedName],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      if (existingProduct) {
        // Update usage count
        db.run(
          'UPDATE products SET usage_count = usage_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [existingProduct.id]
        );
        
        knownProducts.push({
          product: product,
          category: existingProduct.category,
          confidence: existingProduct.confidence,
          source: existingProduct.source
        });
      } else {
        unknownProducts.push(product);
      }
    }

    // If all products are known, return immediately
    if (unknownProducts.length === 0) {
      console.log(`✅ [${req.requestId}] All products found in database`);
      return res.json({ 
        classifications: knownProducts,
        cached: true,
        requestId: req.requestId
      });
    }

    // Use AI for unknown products
    console.log(`🤖 [${req.requestId}] Using AI for ${unknownProducts.length} unknown products`);
    
    const aiClassifications = await classifyWithAI(unknownProducts);
    
    // Track AI classifications
    aiClassifications.inc({ status: "success" }, unknownProducts.length);
    
    // Save AI classifications to database
    for (const classification of aiClassifications) {
      const normalizedName = normalizeInput(classification.product);
      
      db.run(
        `INSERT INTO products (name, normalized_name, category, confidence, source) 
         VALUES (?, ?, ?, ?, ?)`,
        [classification.product, normalizedName, classification.category, 0.8, 'ai']
      );
    }

    // Combine known and AI classifications
    const allClassifications = [...knownProducts, ...aiClassifications];

    res.json({
      classifications: allClassifications,
      cached: false,
      aiUsed: true,
      requestId: req.requestId
    });

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
    
    const systemMessage = "Tu esi eksperts latviešu valodā. Labo produktu nosaukumus, lai tie būtu gramatiski pareizi un skaidri. SAGLABĀJ brand nosaukumus un specifiskus aprakstus. Ja nosaukums jau ir pareizs, atstāj to nemainītu. Atbildi tikai JSON formātā.";
    const userMessage = `Labo šos produktu nosaukumus latviešu valodā: ${productList}

Svarīgi - SAGLABĀJ:
- Brand nosaukumus: "dore blue siers" → "dore blue siers" (NEMAINĪT)
- Specifiskus aprakstus: "bērnu cīsiņi" → "bērnu cīsiņi" (NEMAINĪT)
- Produktu veidus: "bezlaktozes jogurts" → "bezlaktozes jogurts" (NEMAINĪT)

Labo tikai gramatikas kļūdas:
- "biespiena sieriņš" → "biezpiena sieriņš"
- "apelsinu sulu" → "apelsīnu sula" 
- "balto vinu" → "baltais vīns"
- "degvins" → "degvīns"
- "kefirs" → "kefīrs"

Atbildi JSON formātā:
{
  "correctedNames": ["labots_nosaukums1", "labots_nosaukums2", ...]
}`;

    const messages = [
      { role: "system", content: systemMessage },
      { role: "user", content: userMessage }
    ];

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages,
      max_tokens: 500,
      temperature: 0.1
    });

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
    
    // Update or insert the correct classification
    db.run(
      `INSERT INTO products (name, normalized_name, category, confidence, source) 
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(normalized_name) DO UPDATE SET
       category = excluded.category,
       confidence = 1.0,
       source = 'manual',
       updated_at = CURRENT_TIMESTAMP`,
      [product, normalizedName, correctCategory, 1.0, 'manual']
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

// AI Classification function
async function classifyWithAI(products) {
  const productList = products.join(', ');
  
  const prompt = `Klasificē šos latviešu pārtikas produktus pēc kategorijām:

Kategorijas:
- vegetables (dārzeņi: tomāti, gurķi, kartupeļi, sīpoli, burkāni, ķirši)
- fruits (augļi: āboli, banāni, citrusi, ogles, bumbieri)
- meat (gaļa: liellopa gaļa, vista, cūkgaļa, maltā gaļa, kotletes)
- fish (zivis: zivis, zivju filejas, vēzis, krabji)
- dairy (piena produkti: piens, siers, jogurts, krējums, biezpiens, sviests, kefīrs)
- eggs (olas: vistas olas, pīļu olas)
- bakery (maize: maize, kliņģeris, kūkas, biskvīti, kāpostmaize)
- grains (graudi: rīsi, griķi, auzas, kvieši, makaroni)
- snacks (uzkodas: čipsi, saldumi, rieksti, sēklas, kūkas)
- ready_meals (gatavie ēdieni: salāti, zupas, ēdieni uzreiz)
- beverages (dzērieni: ūdens, sula, kafija, tēja, limonāde, kvass)
- alcohol (alkohols: vīns, vodka, alus, degvīns, konjaks, šampanietis)
- deli (sausā gaļa: cīsiņi, desa, šašliks, kūpināta gaļa, sieriņi)
- baby_food (bērnu barība: bērnu barība, bērnu cīsiņi, bērnu jogurts, bērnu sula)
- household (mājsaimniecība: šampūns, zobu birste, papīrs, ziepes)
- hygiene (higiēna: zobu pasta, šampūns, ziepes, kremas)
- pet (mājdzīvniekiem: suņu barība, kaķu barība, putnu barība)
- international (starptautiskie produkti: ķīniešu ēdieni, japāņu ēdieni)
- construction (būvniecība: krāsa, skrūves, dēļi)
- other (cits: ja nevar noteikt kategoriju)

Svarīgi:
- "sarkanvīns" → alcohol (nevis beverages)
- "vodka" → alcohol (nevis beverages) 
- "cīsiņi" → deli (nevis meat)
- "bērnu cīsiņi" → baby_food (nevis deli)
- "dore blue siers" → dairy (saglabājot pilno nosaukumu)
- "bezlaktozes jogurts" → dairy (saglabājot pilno nosaukumu)

Produkti: ${productList}

Atbildi tikai JSON formātā:
[
  {"product": "produkta_nosaukums", "category": "kategorijas_slug"},
  ...
]`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Tu esi eksperts pārtikas produktu klasifikācijā. Atbildi tikai JSON formātā." },
        { role: "user", content: prompt }
      ],
      max_tokens: 1000,
      temperature: 0.1
    });

    const content = completion.choices[0].message.content.trim();
    console.log('🤖 AI Response:', content);

    // Clean JSON response
    const cleanContent = content
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();

    const classifications = JSON.parse(cleanContent);
    
    console.log(`✅ AI classified ${classifications.length} products`);
    return classifications;

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

