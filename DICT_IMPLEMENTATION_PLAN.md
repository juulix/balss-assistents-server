# 📚 Produktu vārdnīcas implementācijas plāns

## 📊 CSV analīze

**Faila saraksts:**
- 520 produktu termi
- 17 kategorijas (vegetables, fruits, meat, fish, dairy, eggs, bakery, grains, condiments, snacks, ready_meals, beverages, household, hygiene, pet, other, construction)

**Top kategorijas:**
- Condiments: 56 (piedevas, garšvielas)
- Vegetables: 50
- Fruits: 50
- Dairy: 44
- Beverages: 43
- Meat: 36

**Problēma:** Nav "construction" kategorijas CSV (bet app to atbalsta)

---

## ✅ Ko darīsies

### 1. ✅ Faila ievietojums (gatavs)
- `data/ontology/products_base_lv_520.csv`

### 2. ⚠️ CSV normalizācija
**Problēma:** CSV ir ar diakritiskajām zīmēm (`āēīōūčģķļņšž`)

**Normalizācija prasībās:**
```javascript
function normalizeTerm(term) {
  return term
    .toLowerCase()
    .trim()
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
    .replace(/\s+/g, ' ');
}
```

**Piemērs:**
- CSV: `"ķiploki"` → normalize → `"kiploki"` → lookup → slug
- Input: `"Ķiploki"` → normalize → `"kiploki"` → lookup → slug

### 3. Klasifikācijas plūsma

**PĒC implementācijas:**
```javascript
// 1. Normalizē input
const normalized = normalizeInput(product);

// 2. Meklē vārdnīcā
if (productDict.has(normalized)) {
  // ✅ Dict HIT - atgriež bez AI
  const slug = productDict.get(normalized);
  dictHits.inc();
  return { product, category: slug, source: 'dictionary' };
}

// 3. AI fallback (tikai ja nav vārdnīcā)
dictMisses.inc();
const aiResult = await classifyWithAI([product]);

// 4. Validē AI rezultātu
const validated = validateAndMapCategory(aiResult.category);
return { product, category: validated, source: 'ai' };
```

### 4. Unknown terms tracking

**Ja AI atgriež nezināmu kategoriju:**
```javascript
// Ierakstīt unknown_terms tabulā
db.run(
  `INSERT OR IGNORE INTO unknown_terms (term, suggested_slug, hits) 
   VALUES (?, ?, 1)
   ON CONFLICT(term) DO UPDATE SET hits = hits + 1`,
  [product, aiCategory]
);
```

---

## 🚧 Implementācijas reizināšana

**Neiztikšanas pēdas:**
1. ✅ CSV normalizācija
2. ✅ Unknown_terms SQLite tabula
3. ✅ Admin endpoints ar auth
4. ✅ Prometheus metrikas

**Vienkāršākais sākums:**
1. ✅ Ielādē CSV atmiņā (boot)
2. ✅ Dict lookup pirms AI
3. ✅ Metrikas (hits/misses)
4. ⏸️ Unknown_terms tabula (vēlāk)
5. ⏸️ Admin endpoints (vēlāk)

---

## ❓ Jautājums

Vai vēlaties:
- **A)** Pamata implementācija (dict lookup + metrikas)
- **B)** Pilna implementācija (unknown_terms + admin endpoints)
- **C)** Uzrakstu tikai koda draft, jūs patestējat

**Es iesaku A)** - ātrākais un darbojas uzreiz!

