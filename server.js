// Railway server for Balss Assistents shopping list
// Handles AI categorization, learning, and product suggestions

const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

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

// API Routes

// 1. Classify products
app.post('/api/classify-products', async (req, res) => {
  try {
    const { products } = req.body;
    
    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'Products array is required' });
    }

    console.log(`🤖 Classifying ${products.length} products:`, products);

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
      console.log('✅ All products found in database');
      return res.json({ 
        classifications: knownProducts,
        cached: true 
      });
    }

    // Use AI for unknown products
    console.log(`🤖 Using AI for ${unknownProducts.length} unknown products`);
    
    const aiClassifications = await classifyWithAI(unknownProducts);
    
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
      aiUsed: true
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
    
    const systemMessage = "Tu esi eksperts latviešu valodā. Labo produktu nosaukumus, lai tie būtu gramatiski pareizi un skaidri. Ja nosaukums jau ir pareizs, atstāj to nemainītu. Atbildi tikai JSON formātā.";
    const userMessage = `Labo šos produktu nosaukumus latviešu valodā: ${productList}

Piemēri:
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
- vegetables (dārzeņi: tomāti, gurķi, kartupeļi, sīpoli, burkāni)
- fruits (augļi: āboli, banāni, citrusi, ogles)
- meat (gaļa: liellopa gaļa, vista, desa, zivis, maltā gaļa)
- dairy (piena produkti: piens, siers, jogurts, krējums, biezpiens, sviests)
- eggs (olas)
- bakery (maize, kliņģeris, kūkas)
- beverages (dzērieni: ūdens, sula, kafija, tēja, vīns, alus)
- snacks (uzkodas: čipsi, saldumi, rieksti)
- household (mājsaimniecība: šampūns, zobu birste, papīrs)
- hygiene (higiēna: zobu pasta, šampūns, ziepes)
- pet (mājdzīvniekiem: suņu barība, kaķu barība)
- international (starptautiskie produkti)
- construction (būvniecība: krāsa, skrūves)

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

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Balss Assistents Server running on port ${PORT}`);
  console.log(`📊 Database: ${dbPath}`);
  console.log(`🤖 OpenAI API: ${process.env.OPENAI_API_KEY ? 'Configured' : 'Missing'}`);
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

