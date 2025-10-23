# 🚀 Balss Assistents Server

Railway serveris AI produktu klasifikācijai un mācīšanās sistēmai.

## 🎯 Funkcionalitāte

- **AI Klasifikācija** - klasificē produktus ar OpenAI
- **Mācīšanās** - saglabā lietotāja labojumus
- **Caching** - ātrāka atbilde zināmiem produktiem
- **Produktu ieteikumi** - balstīti uz izmantošanas biežumu
- **SQLite bāze** - lokāla datu glabāšana

## 📡 API Endpoints

- `POST /api/classify-products` - Klasificē produktus
- `POST /api/learn` - Mācās no labojumiem  
- `GET /api/suggestions` - Produktu ieteikumi
- `GET /api/categories` - Pieejamās kategorijas
- `GET /api/health` - Servera statuss

## 🚀 Railway Deploy

1. Ejiet uz https://railway.app
2. Login ar GitHub
3. "New Project" → "Deploy from GitHub repo"
4. Izvēlieties `balss-assistents-server`
5. Iestatiet `OPENAI_API_KEY` environment variable

## 🔧 Lokālā izstrāde

```bash
npm install
export OPENAI_API_KEY=your-key
npm start
```

Serveris būs pieejams: `http://localhost:3000`
