# 🔐 GitHub Autentifikācijas Problēma

## Problēma
Git nevar autentificēties ar GitHub (Device not configured).

## Risinājumi

### 1. GitHub Personal Access Token (Ieteicams)

1. Ejiet uz https://github.com/settings/tokens
2. "Generate new token" → "Generate new token (classic)"
3. Note: "Balss Assistents Server"
4. Expiration: "No expiration" (vai 90 days)
5. Scopes: ✅ "repo" (Full control of private repositories)
6. Generate token
7. **KOPĒJIET TOKEN** (sk-ghp_...)

### 2. Izmantot Token terminālī

```bash
# Mēģināt ar token
git push -u origin main
# Kad prasīs username: ojars.juliks
# Kad prasīs password: IELĪMĒJIET TOKEN
```

### 3. Vai arī izmantot GitHub Desktop

1. Lejupielādējiet GitHub Desktop
2. Login ar GitHub
3. "Clone a repository from the Internet"
4. URL: https://github.com/juulix/balss-assistents-server
5. Clone
6. Drag & drop failus no mūsu mapes
7. Commit & Push

### 4. Vai arī manuāli upload

1. Ejiet uz https://github.com/juulix/balss-assistents-server
2. "uploading an existing file"
3. Drag & drop šos failus:
   - server.js
   - package.json
   - railway.toml
   - test-server.js
   - .gitignore
   - RAILWAY_SERVER_README.md
   - RAILWAY_DEPLOY_INSTRUCTIONS.md
   - GITHUB_RAILWAY_SETUP.md

## Kuru metodi izvēlaties?

1. **GitHub Token** (ātrāk)
2. **GitHub Desktop** (vienkāršāk)
3. **Manuāli upload** (bez komandām)
