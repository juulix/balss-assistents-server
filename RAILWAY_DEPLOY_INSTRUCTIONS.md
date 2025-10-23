# 🚀 Railway Deploy Instrukcijas

## 1. Railway Login (Manuāli)

Atveriet termināli un izpildiet:

```bash
railway login
```

Tas atvērs pārlūku Railway login lapā.

## 2. Izveidot Projektu

```bash
railway init --name balss-assistents-server
```

## 3. Iestatīt Environment Variables

```bash
railway variables set OPENAI_API_KEY=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
```

## 4. Deploy

```bash
railway up
```

## 5. Iegūt URL

```bash
railway domain
```

## 6. Testēt Serveri

```bash
node test-server.js
```

---

## 🔧 Alternatīva: Railway Dashboard

1. Ejiet uz https://railway.app
2. Login ar GitHub
3. "New Project" → "Deploy from GitHub repo"
4. Izvēlieties repository
5. Iestatiet `OPENAI_API_KEY` environment variable
6. Deploy

---

## 📱 Aplikācijas Atjaunināšana

Pēc Railway deploy, atjauniniet `ServerAPIClient.swift`:

```swift
init(baseURL: String = "https://YOUR-RAILWAY-URL.railway.app") {
    self.baseURL = baseURL
}
```

---

## ✅ Pārbaude

Serveris būs pieejams:
- Health: `https://YOUR-URL.railway.app/api/health`
- Classify: `https://YOUR-URL.railway.app/api/classify-products`
- Learn: `https://YOUR-URL.railway.app/api/learn`
- Suggestions: `https://YOUR-URL.railway.app/api/suggestions`
- Categories: `https://YOUR-URL.railway.app/api/categories`
