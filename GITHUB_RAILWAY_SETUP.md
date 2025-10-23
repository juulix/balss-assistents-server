# 🚀 GitHub + Railway Deploy Setup

## 1. Izveidot GitHub Repository

1. Ejiet uz https://github.com/new
2. Repository name: `balss-assistents-server`
3. Description: `Railway server for Balss Assistents AI categorization`
4. Public repository
5. Create repository

## 2. Push kodu uz GitHub

```bash
git remote add origin https://github.com/ojars.juliks/balss-assistents-server.git
git branch -M main
git push -u origin main
```

## 3. Railway Deploy

1. Ejiet uz https://railway.app
2. Login ar GitHub (ojars.juliks@gmail.com)
3. "New Project" → "Deploy from GitHub repo"
4. Izvēlieties `balss-assistents-server` repository
5. Railway automātiski atpazīs `package.json` un deploy

## 4. Iestatīt Environment Variables

Railway Dashboard → Project → Variables:
```
OPENAI_API_KEY=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
```

## 5. Iegūt Servera URL

Railway Dashboard → Project → Settings → Domains
Kopējiet URL (piemēram: `https://balss-assistents-server-production.up.railway.app`)

## 6. Testēt Serveri

```bash
# Atjaunināt test-server.js ar jauno URL
export SERVER_URL=https://YOUR-RAILWAY-URL.railway.app
node test-server.js
```

## 7. Atjaunināt Aplikāciju

Atjauniniet `ServerAPIClient.swift`:
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

---

## 🎯 Nākamie Soļi

1. ✅ GitHub repository izveidots
2. ⏳ Push kodu uz GitHub
3. ⏳ Railway deploy
4. ⏳ Iestatīt environment variables
5. ⏳ Testēt serveri
6. ⏳ Atjaunināt aplikāciju
