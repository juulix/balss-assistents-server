# 🚀 Balss Assistents Server

Railway serveris AI produktu klasifikācijai un mācīšanās sistēmai.

## 🎯 Funkcionalitāte

- **AI Klasifikācija** - klasificē produktus ar OpenAI
- **Mācīšanās** - saglabā lietotāja labojumus
- **Caching** - ātrāka atbilde zināmiem produktiem
- **Produktu ieteikumi** - balstīti uz izmantošanas biežumu
- **SQLite bāze** - lokāla datu glabāšana

## 📡 API Endpoints

### 1. Klasificēt produktus
```http
POST /api/classify-products
Content-Type: application/json

{
  "products": ["vīns", "ābolu sula", "Dorblū siers"]
}
```

**Atbilde:**
```json
{
  "classifications": [
    {
      "product": "vīns",
      "category": "beverages",
      "confidence": 0.8,
      "source": "ai"
    }
  ],
  "cached": false,
  "aiUsed": true
}
```

### 2. Mācīties no labojumiem
```http
POST /api/learn
Content-Type: application/json

{
  "product": "vīns",
  "correctCategory": "alcohol"
}
```

### 3. Iegūt ieteikumus
```http
GET /api/suggestions?query=vī&limit=5
```

### 4. Iegūt kategorijas
```http
GET /api/categories
```

### 5. Health check
```http
GET /api/health
```

## 🚀 Railway Deployment

### 1. Izveidot Railway projektu
```bash
# Instalēt Railway CLI
npm install -g @railway/cli

# Login
railway login

# Izveidot projektu
railway init
```

### 2. Iestatīt Environment Variables
```bash
# Railway dashboard vai CLI
railway variables set OPENAI_API_KEY=sk-proj-...
```

### 3. Deploy
```bash
railway up
```

## 🏗️ Lokālā izstrāde

### 1. Instalēt dependencies
```bash
npm install
```

### 2. Iestatīt environment variables
```bash
export OPENAI_API_KEY=sk-proj-...
```

### 3. Palaist serveri
```bash
npm run dev
```

Serveris būs pieejams: `http://localhost:3000`

## 📊 Datu bāze

SQLite bāze ar tabulām:
- `products` - produkti ar kategorijām
- `categories` - pieejamās kategorijas

## 🔄 Mācīšanās Process

1. **Pirmais izsaukums:** Produkts → AI → Kategorija → Saglabāts DB
2. **Lietotāja labojums:** Produkts → Jauna kategorija → Atjaunināts DB
3. **Nākamais izsaukums:** Produkts → DB (bez AI) → Saglabātā kategorija

## 🎯 Priekšrocības

- ✅ **Mācīšanās** - katru reizi labāk
- ✅ **Ātrums** - zināmi produkti bez AI
- ✅ **Drošība** - API key nav aplikācijā
- ✅ **Lētums** - mazāk AI izsaukumu
- ✅ **Skalējamība** - viegli pievienot funkcionalitāti

## 🔧 Nākamie Soļi

1. Deploy uz Railway
2. Atjaunināt aplikāciju lai izmanto serveri
3. Pievienot vairāk funkcionalitātes
4. Optimizēt AI promptus
5. Pievienot analītiku
