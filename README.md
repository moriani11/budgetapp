# BudgetApp - Functionele & Technische Analyse

## 1. Projectoverzicht

**Naam:** BudgetApp  
**Doel:** Een persoonlijke expense tracker waarmee je per maand inkomsten, vaste uitgaven en dagelijkse aankopen per categorie kunt bijhouden. De app berekent automatisch de buffer en biedt een AI-gesprekspartner die je helpt inzicht te krijgen in je uitgaven en te bekijken waar je kunt besparen.

### Juridische pagina's voor Enable Banking

De publieke, statische pagina's voor de Enable Banking-registratie staan in `public/legal/`:

- `privacy.html` — privacyverklaring
- `terms.html` — voorwaarden

Vervang vóór publicatie alle waarden tussen vierkante haken. Voor lokaal bekijken start je de app en open je `/legal/privacy.html`. Voor de registratie moet je deze twee bestanden (met `styles.css`) apart publiek hosten, bijvoorbeeld via GitHub Pages. De Express/MongoDB-app zelf hoeft daarvoor niet gehost te zijn.

**Voorbeeld uit de vraag:**
> Vaste uitgaven volgende maand zijn €1.240. Verwachte inkomsten zijn €1.350. Buffer: €110.

De app wordt gebouwd als **full-stack webapplicatie** zonder frontend-framework (dus geen React), op basis van de **MEN-stack**: MongoDB, Express en Node.js. De views worden gerenderd met **EJS** op de server. De backend is geschreven in **TypeScript** en gebruikt de **MongoDB Native Driver**. Voor spraakherkenning en dynamische onderdelen wordt een klein stukje vanilla JavaScript in de EJS-templates gebruikt. De AI-adviesfunctie maakt gebruik van een externe LLM API.

---

## 2. Functionele Analyse

### 2.1 Kernfunctionaliteit (MVP)

De Minimale Viable Product (MVP) bevat de volgende functionaliteit:

1. **Inkomsten beheren per maand**
   - Een gebruiker kan per maand één inkomensbedrag invoeren.
   - Het inkomen kan worden aangepast.

2. **Categorieën beheren**
   - Gebruiker kan eigen uitgavecategorieën maken en beheren, bijvoorbeeld "Voeding", "Tanken", "Vervoer", "Wonen", "Abonnementen", "Verzekering".
   - Categorieën hebben een naam en optioneel een kleur/icoontje.

3. **Snelle uitgaven invoeren**
   - Bij elke aankoop kan de gebruiker snel een bedrag invoeren en een categorie kiezen.
   - Invoer kan via typen of via spraak (microfoon-knop in de browser).
   - Standaard wordt de huidige datum en maand gebruikt.

4. **Vaste uitgaven beheren**
   - Een gebruiker kan uitgaven toevoegen met naam, bedrag, categorie en maand.
   - Een uitgave kan terugkerend (vast) of eenmalig zijn.
   - Uitgaven kunnen worden bewerkt en verwijderd.

5. **Buffer berekenen**
   - De app berekent automatisch: `buffer = inkomsten − totale uitgaven`.
   - De buffer wordt visueel weergegeven (groen bij positief, rood als negatief).

6. **Maandoverzicht en categorieverdeling**
   - De gebruiker kan wisselen tussen maanden.
   - Per maand worden inkomsten, uitgaven, buffer en uitgaven per categorie getoond.

7. **AI-advies over uitgaven**
   - De gebruiker kan vragen stellen aan een AI over zijn/haar uitgaven, bijvoorbeeld:
     - "Waar geef ik de meeste geld aan uit?"
     - "Hoe kan ik volgende maand minder uitgeven?"
     - "Vergelijk mijn uitgaven van januari met februari."
   - De AI krijgt alleen de eigen uitgaven- en inkomensdata van de gebruiker als context.

### 2.2 Optionele uitbreidingen (na de MVP)

- **Grafieken**: visuele weergave van uitgaven per categorie en maandverloop via Chart.js.
- **Budgetteren**: gebruiker kan een budget per categorie instellen en waarschuwingen krijgen bij overschrijding.
- **Exporteren**: overzicht exporteren naar CSV of PDF.
- **CSV-import**: banktransacties importeren uit een CSV-export.
- **Meerdere gebruikers / authenticatie**: inloggen met gebruikersaccount.

### 2.3 User Stories

- Als gebruiker wil ik mijn verwachte inkomen van een maand invoeren, zodat ik weet wat mijn budget is.
- Als gebruiker wil ik categorieën aanmaken voor mijn uitgaven, zodat ik mijn uitgavenpatroon kan structureren.
- Als gebruiker wil ik snel na een aankoop het bedrag invoeren of inspreken, zodat ik mijn uitgaven bijhoud zonder veel tijd te verliezen.
- Als gebruiker wil ik vaste uitgaven invoeren, zodat ik zie waar mijn geld naartoe gaat.
- Als gebruiker wil ik uitgaven per maand en per categorie kunnen bekijken, zodat ik maandelijks kan vergelijken.
- Als gebruiker wil ik automatisch mijn buffer zien, zodat ik weet wat er overblijft.
- Als gebruiker wil ik aan een AI vragen stellen over mijn uitgaven, zodat ik advies krijg over hoe ik kan besparen.

---

## 3. Technische Analyse

### 3.1 Tech Stack

| Laag | Technologie |
|------|-------------|
| Runtime | Node.js (LTS) |
| Backend framework | Express.js |
| Database | MongoDB |
| Database driver | MongoDB Native Driver (`mongodb`) |
| Template engine | EJS |
| Taal | TypeScript (gecompileerd naar JavaScript) |
| Frontend | HTML5, CSS3, vanilla JavaScript (in EJS-templates) |
| Grafieken (optioneel) | Chart.js |
| Spraakherkenning | Web Speech API (browser) |
| AI-advies | OpenAI API of vergelijkbare LLM |
| Hosting DB | MongoDB Atlas (gratis tier) |
| Package manager | npm |
| HTTP-client | fetch() |

### 3.2 Projectstructuur

```
myApp/
├── README.md
├── package.json
├── tsconfig.json              # TypeScript configuratie
├── server.ts                  # Express server + MongoDB connectie
├── .env.example               # Voorbeeld van omgevingsvariabelen
├── db.ts                      # MongoDB client connectie helper
├── routes/
│   ├── categories.ts          # API routes voor categorieën
│   ├── expenses.ts            # API routes voor uitgaven
│   ├── income.ts              # API routes voor inkomsten
│   ├── summary.ts             # API route voor samenvatting
│   └── advice.ts              # API route voor AI-advies
├── views/
│   ├── index.ejs              # Dashboard
│   ├── quick-add.ejs          # Snelle invoer (typen of spraak)
│   ├── expenses.ejs           # Uitgaven beheren
│   ├── income.ejs             # Inkomsten instellen
│   └── ai-chat.ejs            # AI-gesprek over uitgaven
├── public/
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── speech.js          # Spraakherkenning
│       └── quickAdd.js        # Snelle invoer logica
├── types/
│   └── index.ts               # Gedeelde TypeScript interfaces
└── seed.ts                    # Optioneel: testdata vullen
```

### 3.3 Database Collecties en Documenten

Met de MongoDB Native Driver werk je direct met collecties en documenten. Er is geen schema-validatie op de database zelf (tenzij je die in MongoDB Atlas configureert); de applicatiecode zorgt voor de juiste structuur.

TypeScript interfaces (voor type-checking in de code):

```ts
interface Category {
  _id?: ObjectId;
  name: string;       // bijv. "Voeding"
  color: string;      // bijv. "#4CAF50"
  icon: string;       // bijv. "🍽️"
}

interface Expense {
  _id?: ObjectId;
  name: string;         // bijv. "Boodschappen Jumbo"
  amount: number;       // bijv. 45.20
  categoryId: ObjectId; // verwijzing naar categorie
  categoryName: string; // gedenormaliseerd voor eenvoudige weergave
  date: Date;           // bijv. 2026-09-13
  month: string;        // formaat "YYYY-MM", bijv. "2026-09"
  recurring: boolean;   // true = vaste maandelijkse uitgave
  inputMethod: string;  // "voice" of "manual"
}

interface Income {
  _id?: ObjectId;
  month: string;      // formaat "YYYY-MM", bijv. "2026-09"
  amount: number;     // bijv. 1350
}
```

MongoDB collecties die gebruikt worden:

- `categories` — voor uitgavecategorieën
- `expenses` — voor alle uitgaven
- `income` — voor maandelijkse inkomsten

**Aandachtspunt:** voor de MVP wordt uitgegaan van één gebruiker. Daarom is er geen `userId` opgenomen in de modellen. Bij latere uitbreiding met authenticatie wordt dit veld toegevoegd.

### 3.4 AI, Spraakherkenning en Privacy

#### Spraakherkenning
- Gebruikt de **Web Speech API** die ingebouwd zit in moderne browsers (vooral Chrome en Edge).
- Gratis en werkt client-side; je stem wordt niet naar een server gestuurd.
- Werkt het beste in het Nederlands als de browser taal op Nederlands staat.
- Niet 100% accuraat; daarom wordt het resultaat altijd eerst getoond voordat het wordt opgeslagen.

#### AI-advies
- Maakt gebruik van de **OpenAI API** (of een vergelijkbare LLM).
- Je hebt een API key nodig van `https://platform.openai.com/api-keys`.
- OpenAI rekent per verzoek kleine kosten; met normaal gebruik (enkele vragen per dag) blijf je vaak binnen het gratis starttegoed.
- De API key staat alleen in `.env` op de server en komt nooit in de frontend.
- De app stuurt alleen je eigen financiële data (uitgaven, inkomsten, categorieën) als context mee naar OpenAI.
- Let op: als je het project online zet, moet je de API key geheim houden en niet delen.

---

## 4. API Specificatie

### 4.1 Uitgaven (`/api/expenses`)

| Methode | Endpoint | Beschrijving |
|---------|----------|--------------|
| GET | `/api/expenses` | Alle uitgaven ophalen, optioneel gefilterd op `?month=YYYY-MM` |
| POST | `/api/expenses` | Nieuwe uitgave toevoegen |
| PUT | `/api/expenses/:id` | Bestaande uitgave aanpassen |
| DELETE | `/api/expenses/:id` | Uitgave verwijderen |

**Voorbeeld request body (POST / PUT):**

```json
{
  "name": "Boodschappen Jumbo",
  "amount": 45.20,
  "categoryId": "64f8a...",
  "categoryName": "Voeding",
  "date": "2026-09-13",
  "month": "2026-09",
  "recurring": false,
  "inputMethod": "manual"
}
```

### 4.2 Inkomsten (`/api/income`)

| Methode | Endpoint | Beschrijving |
|---------|----------|--------------|
| GET | `/api/income/:month` | Inkomsten van een specifieke maand ophalen |
| POST | `/api/income` | Inkomsten voor een maand instellen of bijwerken |

**Voorbeeld request body (POST):**

```json
{
  "month": "2026-09",
  "amount": 1350
}
```

### 4.3 Categorieën (`/api/categories`)

| Methode | Endpoint | Beschrijving |
|---------|----------|--------------|
| GET | `/api/categories` | Alle categorieën ophalen |
| POST | `/api/categories` | Nieuwe categorie toevoegen |
| PUT | `/api/categories/:id` | Categorie aanpassen |
| DELETE | `/api/categories/:id` | Categorie verwijderen |

**Voorbeeld request body (POST / PUT):**

```json
{
  "name": "Voeding",
  "color": "#4CAF50",
  "icon": "🍽️"
}
```

### 4.4 Samenvatting (`/api/summary/:month`)

| Methode | Endpoint | Beschrijving |
|---------|----------|--------------|
| GET | `/api/summary/:month` | Totaal inkomsten, totaal uitgaven en buffer van een maand |

**Voorbeeld response:**

```json
{
  "month": "2026-09",
  "income": 1350,
  "expenses": 1240,
  "buffer": 110,
  "byCategory": [
    { "category": "Wonen", "total": 800 },
    { "category": "Voeding", "total": 240 },
    { "category": "Vervoer", "total": 120 }
  ]
}
```

### 4.5 AI-advies (`/api/advice`)

| Methode | Endpoint | Beschrijving |
|---------|----------|--------------|
| POST | `/api/advice` | Stuur een vraag naar de AI met je financiële data als context |

**Voorbeeld request body:**

```json
{
  "month": "2026-09",
  "question": "Waar geef ik de meeste geld aan uit?"
}
```

**Werking:** De backend haalt de inkomsten, uitgaven en categorieverdeling van de opgegeven maand op, bouwt daar een veilige prompt van en stuurt deze naar de OpenAI API. De API key blijft server-side.

**Voorbeeld response:**

```json
{
  "answer": "In september geef je het meeste uit aan Wonen (€800), gevolgd door Voeding (€240)."
}
```

---

## 5. Frontend Schermen

### 5.1 Dashboard (`/`) — `views/index.ejs`

Het startpunt van de app. Toont drie grote kaarten:

- **Totaal inkomsten** van de geselecteerde maand.
- **Totaal uitgaven** van de geselecteerde maand.
- **Buffer**: groen als positief, rood als negatief.

Daarnaast een maandselector, een lijst van uitgaven voor die maand en een categorieverdeling.

### 5.2 Snelle invoer (`/quick-add`) — `views/quick-add.ejs`

Pagina die bedoeld is om direct na een aankoop te gebruiken:

- Grote bedragsinvoer (numerveld of snelle knoppen).
- Categorie-selector met kleurtjes/icoontjes.
- **Microfoon-knop** om het bedrag en de categorie in te spreken via de Web Speech API.
- Knop "Toevoegen" die direct naar de API stuurt.

**Spraakherkenning:** De browser vangt spraak op en probeert automatisch een bedrag en categorie te herkennen. Bijvoorbeeld: "12 euro 50 aan voeding". Als de herkenning onzeker is, wordt het resultaat handmatig controleerbaar getoond voordat het wordt opgeslagen.

### 5.3 Uitgaven beheren (`/expenses`) — `views/expenses.ejs`

Pagina met:

- Formulier om een nieuwe uitgave toe te voegen (naam, bedrag, categorie, terugkerend, maand).
- Tabel met alle uitgaven, met knoppen voor bewerken en verwijderen.
- Filter per maand.

### 5.4 Inkomsten instellen (`/income`) — `views/income.ejs`

Eenvoudige pagina met:

- Formulier om inkomsten voor een maand in te voeren of te wijzigen.
- Overzicht van eerder ingevoerde inkomsten per maand.

### 5.5 AI-chat (`/ai-chat`) — `views/ai-chat.ejs`

Chat-achtige pagina met:

- Gespreksgeschiedenis.
- Suggesties voor vragen, bijvoorbeeld "Waar geef ik te veel uit?" of "Hoe kan ik besparen?".
- Antwoorden van de AI worden opgehaald via `/api/advice`.
- Optioneel: mogelijkheid om meerdere maanden mee te geven als context.

---

## 6. Stap-voor-stap Implementatieplan

### Fase 1: Project opzetten

1. `npm init -y` uitvoeren in de projectmap.
2. Dependencies installeren:
   ```bash
   npm install express mongodb ejs dotenv cors openai
   npm install --save-dev typescript ts-node nodemon @types/express @types/node
   ```
3. `tsconfig.json` aanmaken met basis TypeScript-instellingen.
4. `server.ts` aanmaken met een basis Express "Hello World" op poort 3000.
5. `nodemon` en `dev` scripts toevoegen aan `package.json`:
   ```json
   "scripts": {
     "dev": "nodemon server.ts",
     "build": "tsc",
     "start": "node dist/server.js"
   }
   ```

### Fase 2: MongoDB Atlas configureren

1. Account aanmaken op MongoDB Atlas.
2. Een gratis cluster aanmaken.
3. Database-gebruiker aanmaken met wachtwoord.
4. Network Access toestaan voor het eigen IP-adres (of `0.0.0.0/0` voor overal).
5. Connection string kopiëren en opslaan in `.env`:
   ```env
   PORT=3000
   MONGODB_URI=mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/budgetapp?retryWrites=true&w=majority
   ```

### Fase 3: Backend bouwen

1. `db.ts` aanmaken met een MongoDB client connectie helper.
2. TypeScript interfaces `Category`, `Expense` en `Income` aanmaken in `types/index.ts`.
3. Routes bouwen in `routes/` voor categories, expenses, income, summary en advice. Elke route gebruikt de MongoDB Native Driver om direct met collecties te werken.
4. AI-advies route bouwen die inkomens- en uitgavendata veilig naar de OpenAI API stuurt.
5. Routes registreren in `server.ts`.
6. Statische bestanden serveren vanuit `public/` en EJS als view engine configureren.
7. API testen met Postman of browser.

### Fase 4: Frontend bouwen

1. EJS-views aanmaken in `views/`: `index.ejs`, `quick-add.ejs`, `expenses.ejs`, `income.ejs`, `ai-chat.ejs`.
2. CSS styling toevoegen in `public/css/style.css`.
3. Vanilla JavaScript toevoegen in `public/js/` voor client-side logica zoals spraakherkenning en fetch-aanroepen naar de API.
4. Spraakherkenning implementeren in `public/js/speech.js`.
5. Dashboard, snelle invoer en AI-chat vullen met data via server-side rendering en API calls.

### Fase 5: Testen en verfijnen

1. Handmatige end-to-end test doorlopen: inkomen invoeren, categorieën maken, uitgaven toevoegen, buffer controleren.
2. Spraakherkenning testen in verschillende browsers (Chrome/Edge werken het beste).
3. AI-advies testen met voorbeeldvragen.
4. Foutafhandeling toevoegen (bijv. lege velden, verkeerde maandformaten, ongeldige API key).
5. UX verfijnen (laadindicatoren, bevestigingen bij verwijderen, microfoonfeedback).

### Fase 6: Optionele uitbreidingen

1. Budget per categorie instellen en waarschuwingen tonen.
2. Chart.js integreren voor grafieken.
3. Maandoverzichten met navigatie.
4. CSV-import voor banktransacties.
5. Meerdere gebruikers / authenticatie.

---

## 7. Installatie- en Startinstructies

### Vereisten

- Node.js geïnstalleerd (LTS-versie aanbevolen).
- MongoDB Atlas account of lokale MongoDB-installatie.
- Een OpenAI API key (voor AI-advies, gratis starttegoed beschikbaar).
- Een code-editor (bijv. Visual Studio Code).

### Installatie

1. Clone of maak de projectmap aan.
2. Voer uit:
   ```bash
   npm install
   ```
3. Kopieer `.env.example` naar `.env` en vul je MongoDB URI en OpenAI API key in.
4. Start de development server:
   ```bash
   npm run dev
   ```
5. Open de browser op `http://localhost:3000`.

---

## 8. Testplan

### Backend testen

- Met Postman of browser:
  - POST `/api/categories` om een paar categorieën aan te maken.
  - POST `/api/income` met een maand en bedrag.
  - POST `/api/expenses` met meerdere uitgaven en een `categoryId`.
  - GET `/api/summary/:month` controleert of `buffer = income − expenses` en de categorieverdeling klopt.
  - POST `/api/advice` met een vraag en controleer of de AI een relevant antwoord geeft.

### Frontend testen

- Open `http://localhost:3000`.
- Voer inkomsten in voor een maand.
- Maak categorieën aan.
- Voer handmatig en via spraak een uitgave in.
- Controleer of het dashboard de juiste buffer en categorieverdeling toont.
- Wissel van maand en controleer of de data mee verandert.
- Stel een vraag in de AI-chat en controleer het antwoord.

---

## 9. Ontwerpkeuzes en Aandachtspunten

- **Geen React**: de gebruiker wil bewust een lichte stack. Vanilla JS houdt het project eenvoudig en leerzaam.
- **Geen auth in MVP**: dit vereenvoudigt de database en API. Later uit te breiden.
- **Maand als `String` in formaat `YYYY-MM`**: dit maakt filteren en sorteren eenvoudig zonder datumobjecten.
- **Twee aparte modellen**: inkomsten en uitgaven zijn aparte concepten. Dit voorkomt complexe aggregaties en maakt de API leesbaar.
- **Buffer server-side berekenen**: in de summary route, niet alleen in de frontend. Dit maakt de API herbruikbaar.
- **Spraakherkenning client-side**: de Web Speech API werkt in de browser zonder extra backend-kosten of privacyrisico's. De audio blijft lokaal.
- **AI API key server-side**: de `OPENAI_API_KEY` wordt nooit in de frontend geplaatst. De backend fungeert als proxy en bouwt de prompt.
- **Categorieën apart model**: dit maakt het eenvoudig om kleuren, iconen en later budgetten toe te voegen.
- **Gedenormaliseerde `categoryName` in Expense**: dit voorkomt dat elke uitgave een aparte lookup naar Category nodig heeft voor weergave.

---

## 10. Volgende Acties

De volgende concrete stappen om het project daadwerkelijk te starten:

1. Node.js-project initialiseren met `npm init -y`.
2. TypeScript + Express + MongoDB Native Driver + EJS opzetten in `server.ts`.
3. MongoDB Atlas cluster aanmaken en `.env` configureren.
4. Eerste API-routes bouwen (categories, expenses, income, summary) met de MongoDB Native Driver.
5. OpenAI API key aanmaken voor de adviesfunctie.

Wil je dat ik een van deze stappen direct uitwerk in code?
