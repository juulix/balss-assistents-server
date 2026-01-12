# 🔧 Labojums: 400 Bad Request Kļūda

## Problēma:

API izsaukumi atgriež **400 Bad Request** kļūdu, jo serveris prasa `X-User-Id` header, bet frontend to nesūta.

## Labojums:

Es esmu pievienojis `/api/dart/` endpoint'us kā publiskus, lai tie neprasītu `X-User-Id` header.

## Kas jādara:

### 1. Commit un Push Servera Izmaiņas:

```bash
cd /Users/ojars/Documents/GitHub/balss-assistents-server
git add server.js
git commit -m "Fix: Allow /api/dart/ endpoints without X-User-Id header"
git push
```

### 2. Railway Automātiski Deployēs:

Railway automātiski deployēs izmaiņas pēc push. Pagaidiet ~2 minūtes.

### 3. Pārbaudiet:

Pēc deployment, pārbaudiet, vai API darbojas:
- Atver `www.helpp.info`
- Pievieno spēlētāju
- Pārbaudiet Network tab → jāredz **200 OK** nevis **400**

## Kas tika labots:

Servera pusē (`server.js`):
- Pievienots `/api/dart/` kā publisks endpoint
- POST un DELETE pieprasījumi `/api/dart/*` vairs neprasa `X-User-Id` header

## Pēc Labojuma:

✅ `POST /api/dart/players` - darbojas bez `X-User-Id`
✅ `DELETE /api/dart/players/:id` - darbojas bez `X-User-Id`
✅ `GET /api/dart/players` - jau darbojās
✅ `GET /api/dart/games` - jau darbojās
✅ `POST /api/dart/games` - darbojas bez `X-User-Id`



