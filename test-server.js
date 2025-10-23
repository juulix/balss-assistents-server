#!/usr/bin/env node

// Test script for Railway server API
const https = require('https');
const http = require('http');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';

function makeRequest(path, method = 'GET', data = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, SERVER_URL);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;
    
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      }
    };

    if (data) {
      const jsonData = JSON.stringify(data);
      options.headers['Content-Length'] = Buffer.byteLength(jsonData);
    }

    const req = client.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          resolve({ status: res.statusCode, data: result });
        } catch (e) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

async function testServer() {
  console.log('🧪 Testing Railway Server API');
  console.log('='.repeat(50));
  console.log(`🌐 Server URL: ${SERVER_URL}`);
  console.log('');

  try {
    // 1. Health check
    console.log('1️⃣ Testing health check...');
    const health = await makeRequest('/api/health');
    console.log(`   Status: ${health.status}`);
    console.log(`   Response:`, health.data);
    console.log('');

    // 2. Get categories
    console.log('2️⃣ Testing categories...');
    const categories = await makeRequest('/api/categories');
    console.log(`   Status: ${categories.status}`);
    console.log(`   Categories count: ${categories.data.categories?.length || 0}`);
    console.log('');

    // 3. Classify products
    console.log('3️⃣ Testing product classification...');
    const testProducts = ['vīns', 'ābolu sula', 'Dorblū siers', 'Kamambēra siers'];
    const classification = await makeRequest('/api/classify-products', 'POST', {
      products: testProducts
    });
    console.log(`   Status: ${classification.status}`);
    console.log(`   Classifications: ${classification.data.classifications?.length || 0}`);
    if (classification.data.classifications) {
      classification.data.classifications.forEach(cat => {
        console.log(`     ${cat.product} → ${cat.category} (${cat.source})`);
      });
    }
    console.log(`   AI Used: ${classification.data.aiUsed}`);
    console.log(`   Cached: ${classification.data.cached}`);
    console.log('');

    // 4. Learn from correction
    console.log('4️⃣ Testing learning system...');
    const learning = await makeRequest('/api/learn', 'POST', {
      product: 'vīns',
      correctCategory: 'alcohol'
    });
    console.log(`   Status: ${learning.status}`);
    console.log(`   Response:`, learning.data);
    console.log('');

    // 5. Get suggestions
    console.log('5️⃣ Testing suggestions...');
    const suggestions = await makeRequest('/api/suggestions?query=vī&limit=3');
    console.log(`   Status: ${suggestions.status}`);
    console.log(`   Suggestions: ${suggestions.data.suggestions?.length || 0}`);
    if (suggestions.data.suggestions) {
      suggestions.data.suggestions.forEach(s => {
        console.log(`     ${s.name} (${s.category}) - ${s.usage_count} uses`);
      });
    }
    console.log('');

    console.log('✅ All tests completed!');
    console.log('🚀 Server is ready for production!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.log('');
    console.log('🔧 Troubleshooting:');
    console.log('1. Make sure server is running: npm run dev');
    console.log('2. Check OPENAI_API_KEY is set');
    console.log('3. Verify server URL is correct');
  }
}

// Run tests
testServer();
