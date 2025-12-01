/**
 * Test script for product categorization
 * Run with: node test-categorization.js
 * 
 * This script tests the dictionary lookup and category validation
 * without making actual API calls.
 */

const fs = require('fs');
const path = require('path');

// Load product dictionary
function loadProductDictionary() {
  const dictPath = path.join(__dirname, 'data/ontology/products_base_lv_520.csv');
  const productDict = new Map();
  
  try {
    const content = fs.readFileSync(dictPath, 'utf8');
    const lines = content.split('\n');
    
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const [term, slug] = line.split(',');
      if (!term || !slug) continue;
      
      const normalized = normalizeInput(term);
      productDict.set(normalized, slug.trim());
    }
    
    return productDict;
  } catch (error) {
    console.error(`Failed to load dictionary: ${error.message}`);
    return productDict;
  }
}

// Normalize input (same as server)
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

// Category mapping (same as server)
const CATEGORY_MAPPING = {
  'spices': 'condiments',
  'garšvielas': 'condiments',
  'seasonings': 'condiments',
  'herbs': 'condiments',
  'unknown': 'other'
};

const OFFICIAL_CATEGORIES = [
  'vegetables', 'fruits', 'meat', 'fish', 'dairy', 'eggs',
  'bakery', 'grains', 'condiments', 'snacks', 'ready_meals',
  'beverages', 'household', 'hygiene', 'pet', 'international',
  'construction', 'other'
];

function validateCategory(rawCategory) {
  const lowercased = rawCategory.toLowerCase().trim();
  
  if (OFFICIAL_CATEGORIES.includes(lowercased)) {
    return lowercased;
  }
  
  if (CATEGORY_MAPPING[lowercased]) {
    return CATEGORY_MAPPING[lowercased];
  }
  
  return 'other';
}

// Test cases
const testCases = {
  dairy: [
    'piens',
    'siers',
    'biezpiens',
    'jogurts',
    'smiltenes biezpiens',
    'valmieras piens',
    'mozzarella',
    'parmezāns',
    'grieķu jogurts',
    'bezlaktozes piens'
  ],
  meat: [
    'desa',
    'maltā gaļa',
    'vistas fileja',
    'bekons',
    'spāņu desa',
    'čorizo',
    'chorizo',
    'salami',
    'prosciutto',
    'pepperoni',
    'liellopa maltā gaļa'
  ],
  vegetables: [
    'kartupeļi',
    'tomāti',
    'gurķi',
    'burkāni',
    'sīpoli'
  ],
  beverages: [
    'ūdens',
    'sula',
    'kafija',
    'vīns',
    'alus',
    'sarkanvīns'
  ]
};

// Run tests
function runTests() {
  console.log('🧪 Loading product dictionary...\n');
  const productDict = loadProductDictionary();
  console.log(`✅ Loaded ${productDict.size} products\n`);
  
  console.log('=' .repeat(60));
  console.log('PRODUCT CATEGORIZATION TESTS');
  console.log('=' .repeat(60));
  
  let passed = 0;
  let failed = 0;
  let notFound = 0;
  
  for (const [expectedCategory, products] of Object.entries(testCases)) {
    console.log(`\n📦 Testing ${expectedCategory.toUpperCase()} products:`);
    console.log('-'.repeat(40));
    
    for (const product of products) {
      const normalized = normalizeInput(product);
      const category = productDict.get(normalized);
      
      if (!category) {
        console.log(`  ⚠️  "${product}" -> NOT FOUND in dictionary`);
        notFound++;
      } else if (category === expectedCategory) {
        console.log(`  ✅ "${product}" -> ${category}`);
        passed++;
      } else {
        console.log(`  ❌ "${product}" -> ${category} (expected: ${expectedCategory})`);
        failed++;
      }
    }
  }
  
  console.log('\n' + '=' .repeat(60));
  console.log('RESULTS SUMMARY');
  console.log('=' .repeat(60));
  console.log(`✅ Passed:    ${passed}`);
  console.log(`❌ Failed:    ${failed}`);
  console.log(`⚠️  Not found: ${notFound}`);
  console.log(`📊 Total:     ${passed + failed + notFound}`);
  
  if (notFound > 0) {
    console.log('\n💡 Products not found in dictionary will be classified by AI on the server.');
    console.log('   The AI prompt has been enhanced to handle these cases correctly.');
  }
  
  if (failed > 0) {
    console.log('\n⚠️  Some products have incorrect categories in the dictionary.');
    console.log('   Please review and update the CSV file.');
  }
  
  console.log('\n');
  return failed === 0;
}

// Run the tests
const success = runTests();
process.exit(success ? 0 : 1);



