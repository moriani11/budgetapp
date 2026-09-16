import crypto from "crypto";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { Income, Expense } from "./types";

// Resultaat van fetchEnableBankingTransactions: dezelfde velden als een
// (deel van een) Expense, plus een expliciete markering wanneer het om een
// spaarstorting gaat (overschrijving naar BEHEERDER_IBAN) in plaats van
// een gewone uitgave. index.ts gebruikt isSaving om te bepalen naar welke
// collectie (uitgaven of spaarpot) een transactie moet worden weggeschreven.
export type BankTransactionResult = Partial<Expense> & { isSaving?: boolean };
import { parseDateOnly, toMonthKey } from "./dateUtils";

const ENABLE_BANKING_BASE_URL = "https://api.enablebanking.com";


export interface EnableBankingAccount {
    uid: string;
    account_id?: {
        iban?: string;
        other?: string;
    };
    currency?: string;
    servicer?: {
        bank_name?: string;
    };
}

export interface ASPSP {
    name: string;
    country: string;
    logo?: string;
}

export const POPULAR_BANKS: ASPSP[] = [
    { name: "KBC Bank", country: "BE", logo: "🏦" },
    { name: "Belfius Bank", country: "BE", logo: "🔴" },
    { name: "ING Belgium", country: "BE", logo: "🦁" },
    { name: "BNP Paribas Fortis", country: "BE", logo: "🟩" },
    { name: "Argenta", country: "BE", logo: "🍎" },
    { name: "Crelan", country: "BE", logo: "🌾" },
    { name: "Rabobank", country: "NL", logo: "🟠" },
    { name: "ABN AMRO", country: "NL", logo: "🟢" }
];

// Test of een van de trefwoorden voorkomt in de tekst, op woordgrenzen.
// Zonder woordgrenzen zou bv. "fit" ook matchen binnen "outfit" of "profit",
// en "ah" binnen "graham" — dit veroorzaakte verkeerde categorisatie van
// transacties waarvan de naam toevallig zo'n substring bevatte.
function matchesKeyword(text: string, keywords: string[]): boolean {
    return keywords.some((keyword) => {
        const escaped = keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`\\b${escaped}\\b`, "i").test(text);
    });
}

// Normaliseert een IBAN/rekeningnummer voor vergelijking: spaties eruit,
// hoofdletters. Banken leveren IBAN's soms met spaties aan (bv. "BE68
// 5390 0754 7034") en soms aaneengesloten, en met wisselend hoofdletter-
// gebruik, dus we vergelijken altijd op deze genormaliseerde vorm.
function normalizeAccountIdentifier(value: string | undefined | null): string {
    if (!value) {
        return "";
    }
    return value.replace(/\s+/g, "").toUpperCase();
}

// Vergelijkt de rekening van de ontvanger (creditor_account) van een
// transactie met het geconfigureerde BEHEERDER_IBAN, om overschrijvingen
// naar de spaarrekening te herkennen.
//
// LET OP — dit moet je zelf controleren met echte data: het exacte veld
// waarin Enable Banking het rekeningnummer van de ontvanger teruggeeft
// hebben we nog niet in een gevulde vorm gezien (in het eerder gedeelde
// voorbeeld was creditor_account altijd null, dat was een gewone
// kaartbetaling). Op basis van hetzelfde patroon als EnableBankingAccount
// elders in dit bestand (account_id met een .iban EN een .other veld)
// gaan we ervan uit dat creditor_account dezelfde vorm heeft: een volledig
// IBAN in .iban, of — als de bank geen IBAN maar een lokaal rekeningnummer
// teruggeeft — een rekeningnummer zonder landcode-prefix in .other.
//
// Om dat tweede geval ("IBAN met en zonder BE-prefix") op te vangen,
// vergelijken we niet alleen het volledige IBAN, maar ook de BBAN-vorm
// van het geconfigureerde IBAN (zonder de eerste 4 tekens: 2-letterige
// landcode + 2 controlecijfers, bv. "BE68" eraf) tegen wat de bank
// teruggeeft.
function matchesBeheerderIban(creditorAccount: any): boolean {
    const beheerderIban = normalizeAccountIdentifier(process.env.BEHEERDER_IBAN);
    if (!beheerderIban) {
        return false;
    }

    const candidates = [
        creditorAccount?.iban,
        creditorAccount?.other
    ]
        .map(normalizeAccountIdentifier)
        .filter((v) => v.length > 0);

    if (candidates.length === 0) {
        return false;
    }

    // BBAN-variant van het geconfigureerde IBAN (zonder landcode +
    // controlecijfers), voor het geval de bank alleen een lokaal
    // rekeningnummer zonder landcode teruggeeft in plaats van het
    // volledige IBAN.
    const beheerderBban = beheerderIban.length > 4 ? beheerderIban.slice(4) : "";

    return candidates.some(
        (candidate) => candidate === beheerderIban || (beheerderBban !== "" && candidate === beheerderBban)
    );
}

// Normaliseert een naam voor vergelijking: diakritische tekens weg (é/è/ë
// → e), alles kleine letters, leestekens/cijfers weg, dubbele spaties
// weg. Nodig omdat banken namen soms met net iets andere spelling,
// hoofdlettergebruik of extra tekens teruggeven.
function normalizeName(value: string | undefined | null): string {
    if (!value) {
        return "";
    }
    return value
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

// Herkent een overschrijving naar jezelf: als de naam van de afzender
// (debtor, dat ben jij bij een uitgaande overschrijving) en de naam van de
// ontvanger (creditor) overeenkomen, gaat het geld naar een rekening op je
// eigen naam — typisch een interne overboeking naar je eigen spaarrekening.
// Dit werkt zonder enige configuratie, voor iedere gebruiker, in
// tegenstelling tot het handmatig ingestelde BEHEERDER_IBAN hierboven, dat
// als aanvullend vangnet blijft dienen voor het geval namen een keer niet
// exact overeenkomen (bv. bij verschillende schrijfwijzen tussen de twee
// gekoppelde rekeningen).
function isSelfTransfer(debtorName: string | undefined | null, creditorName: string | undefined | null): boolean {
    const debtor = normalizeName(debtorName);
    const creditor = normalizeName(creditorName);
    if (!debtor || !creditor) {
        return false;
    }
    return debtor === creditor;
}

// Automatische categorisatie op basis van transactienaam en omschrijving.
//
// Dit is en blijft een trefwoorden-whitelist: elke transactie waarvan de
// naam niet voorkomt in onderstaande lijsten valt terug op "Overig". Met
// maar een handvol merken per categorie viel daardoor bijna alles onder
// "Overig", simpelweg omdat de lijst veel te smal was voor wat een normale
// rekening aan winkels/webshops/diensten tegenkomt. Onderstaande lijsten
// zijn sterk uitgebreid, en er zijn twee categorieën bijgekomen
// (Gezondheid & verzorging, Kleding & Winkelen) die voorheen volledig
// ontbraken en daardoor altijd in Overig belandden.
export function autoCategorize(name: string, description: string = ""): string {
    const text = `${name} ${description}`.toLowerCase();

    if (
        matchesKeyword(text, [
            "colruyt", "okay", "proxi", "albert heijn", "ah", "delhaize",
            "carrefour", "aldi", "lidl", "jumbo", "intermarche", "match",
            "cora", "makro", "spar", "louis delhaize",
            "mcdonald", "burger king", "kfc", "quick", "subway",
            "domino", "pizza hut", "exki", "panos", "le pain quotidien",
            "starbucks", "coffee company", "friture", "frituur", "snackbar",
            "smullers", "traiteur", "bakker", "bakkerij", "slager",
            "restaurant", "brasserie", "bistro", "eetcafe",
            "deliveroo", "takeaway", "uber eats", "thuisbezorgd"
        ])
    ) {
        return "Voeding";
    }

    if (
        matchesKeyword(text, [
            "shell", "total", "q8", "esso", "bp", "octa", "dats 24", "gabriels",
            "tank", "tanken", "brandstof", "electric charge", "fastned",
            "nmbs", "sncb", "de lijn", "stib", "mivb", "tec", "ns ",
            "thalys", "eurostar", "flixbus", "ryanair", "brussels airlines",
            "uber", "bolt", "taxi", "cambio", "poppy", "velo", "blue-bike",
            "parkmobile", "interparking", "vinci park", "4411", "parking",
            "garage", "carglass", "autokeuring"
        ])
    ) {
        return "Vervoer";
    }

    if (
        matchesKeyword(text, [
            "huur", "hypotheek", "syndic", "lening",
            "engie", "luminus", "totalenergies", "eneco", "essent", "mega",
            "fluvius", "sibelga", "ores", "resa",
            "aquafin", "vivaqua", "farys", "pidpa", "water",
            "telenet", "proximus", "orange", "voo", "scarlet", "base",
            "elektriciteit", "interkabel",
            "ethias", "dvv", "axa", "allianz", "belfius insurance",
            "kbc verzekeringen", "baloise", "p&v", "vivium"
        ])
    ) {
        return "Wonen";
    }

    if (
        matchesKeyword(text, [
            "apotheek", "pharmacie", "pharmacy", "dokter", "huisarts",
            "tandarts", "kinesist", "kine", "fysio", "ziekenhuis",
            "mutualiteit", "ziekenfonds", "bond moyson", "cm ",
            "specsavers", "pearle", "optiek", "brillen", "kruidvat"
        ])
    ) {
        return "Gezondheid & verzorging";
    }

    if (
        matchesKeyword(text, [
            "zalando", "bol.com", "amazon", "coolblue", "mediamarkt",
            "fnac", "vanden borre", "krefel",
            "h&m", "zara", "primark", "c&a", "jbc", "bershka",
            "decathlon", "torfs", "bristol", "shein", "asos", "wehkamp",
            "vinted", "ikea", "action", "hema", "wibra", "trendhim"
        ])
    ) {
        return "Kleding & Winkelen";
    }

    if (
        matchesKeyword(text, [
            "netflix", "spotify", "disney", "amazon prime", "hbo",
            "youtube premium", "audible", "podimo", "deezer", "twitch",
            "steam", "playstation", "xbox", "nintendo", "epic games",
            "basic-fit", "basic fit", "healthcity", "fitness", "sport",
            "kinepolis", "pathe", "utopolis", "cinema", "bioscoop",
            "ticket", "ticketmaster", "eventim", "concert", "festival",
            "museum", "zoo", "planckendael", "pairi daiza", "efteling",
            "plopsaland", "bowling", "cafe", "bar"
        ])
    ) {
        return "Vrije tijd";
    }

    // Vanaf hier gaat het niet meer om "welke winkel is dit", maar om het
    // TYPE transactie zelf, herkenbaar aan de vaste Belgische bank-
    // terminologie in de omschrijving, ongeacht welke naam erbij staat:
    //
    // - Een geldopname geeft als "naam" gewoon de locatie van de
    //   geldautomaat (bv. "DEURNE DEURNE DE"), nooit een winkel — die kan
    //   dus per definitie nooit via de winkel-trefwoorden hierboven
    //   herkend worden.
    // - Een overschrijving naar een privépersoon (bv. via Belfius Mobile)
    //   is geen "onbekende aankoop" maar een heel ander soort transactie
    //   (geld delen/terugbetalen), en verdient een eigen categorie in
    //   plaats van in dezelfde ongedefinieerde "Overig"-emmer te vallen
    //   als een écht onbekende winkel.
    if (matchesKeyword(text, ["geldopneming", "cash withdrawal", "atm withdrawal"])) {
        return "Geldopname";
    }

    if (matchesKeyword(text, ["overschrijving"]) && text.includes("naar")) {
        return "Overschrijving";
    }

    return "Overig";
}

// De categorieën waar de AI-classificatie exact één van moet teruggeven.
// Bewust dezelfde lijst als de trefwoorden-categorieën hierboven (zonder
// Geldopname/Overschrijving, want die worden al betrouwbaar herkend via
// de vaste banktekst en hebben geen AI nodig).
const AI_CATEGORIES = [
    "Voeding", "Vervoer", "Wonen", "Gezondheid & verzorging",
    "Kleding & Winkelen", "Vrije tijd", "Overig"
];

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI | null {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey === "dummy" || apiKey.trim() === "") {
        return null;
    }
    if (!openaiClient) {
        openaiClient = new OpenAI({ apiKey });
    }
    return openaiClient;
}

// Onthoudt per winkelnaam welke categorie de AI koos, zodat dezelfde
// (kleine, onbekende) winkel niet bij elke synchronisatie opnieuw aan de
// AI wordt voorgelegd zolang de server blijft draaien. Dit is een
// aanvulling op de al-bekende-transacties-check in
// fetchEnableBankingTransactions hieronder, die het merendeel van het
// herhaalde werk al voorkomt.
const aiCategoryCache = new Map<string, string>();

// Vraagt de AI om een categorie te kiezen voor transacties die de
// trefwoorden-whitelist niet herkent, bijvoorbeeld kleine lokale zaken
// zoals "ZEHRA" of "LAM ET DAH" die nooit in een statische lijst zullen
// voorkomen. Geeft null terug als er geen (geldige) OpenAI API key is
// geconfigureerd, of als de aanroep om wat voor reden dan ook mislukt —
// in beide gevallen valt de aanroeper terug op "Overig".
async function categorizeWithAI(name: string, description: string): Promise<string | null> {
    const client = getOpenAIClient();
    if (!client) {
        return null;
    }

    const cacheKey = name.trim().toLowerCase();
    const cached = aiCategoryCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    try {
        const completion = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content:
                        "Je categoriseert Belgische/Nederlandse banktransacties voor een " +
                        "budgetapp. Antwoord met NIETS anders dan exact één van deze " +
                        `categorienamen, letterlijk zoals hier geschreven: ${AI_CATEGORIES.join(", ")}. ` +
                        "Gebruik je algemene kennis om ook kleinere, minder bekende winkels, " +
                        "restaurants en diensten in te schatten op basis van de naam en " +
                        "omschrijving. Kies \"Overig\" alleen als werkelijk geen enkele andere " +
                        "categorie ook maar enigszins aannemelijk is."
                },
                {
                    role: "user",
                    content: `Transactienaam: "${name}"\nOmschrijving: "${description}"`
                }
            ],
            max_tokens: 20,
            temperature: 0
        });

        const raw = completion.choices[0]?.message?.content?.trim() || "";
        const match = AI_CATEGORIES.find(
            (c) => c.toLowerCase() === raw.toLowerCase()
        );

        if (match) {
            aiCategoryCache.set(cacheKey, match);
            return match;
        }

        console.warn(`AI-categorisatie gaf een onverwacht antwoord terug ("${raw}"), val terug op Overig.`);
        return null;
    } catch (err) {
        console.error("AI-categorisatie mislukt, val terug op Overig:", err);
        return null;
    }
}

// Haal de RSA private key op uit environment variables of bestand

export function getPrivateKey(): string | null {
    const key = process.env.ENABLE_BANKING_PRIVATE_KEY;

    if (key && key.trim().length > 0) {
        return key.replace(/\\n/g, "\n").trim();
    }

    const keyPath =
        process.env.ENABLE_BANKING_KEY_PATH ||
        path.join(__dirname, "private_key.pem");

    if (fs.existsSync(keyPath)) {
        try {
            return fs.readFileSync(keyPath, "utf-8").trim();
        } catch (err) {
            console.error("Fout bij lezen private_key.pem:", err);
        }
    }

    return null;
}

export function isEnableBankingConfigured(): boolean {
    const appId = process.env.ENABLE_BANKING_APPLICATION_ID || process.env.ENABLE_BANKING_APP_ID;
    const key = getPrivateKey();
    return Boolean(appId && appId.trim().length > 0 && key && key.length > 0);
}

// Genereer RS256 JWT voor Enable Banking authenticatie
export function getEnableBankingJWT(): string | null {
    const appId = process.env.ENABLE_BANKING_APPLICATION_ID || process.env.ENABLE_BANKING_APP_ID;
    const privateKey = getPrivateKey();

    if (!appId || !privateKey || appId === "dummy") {
        return null;
    }

    try {
        const header = {
            alg: "RS256",
            typ: "JWT",
            kid: appId.trim()
        };

        const now = Math.floor(Date.now() / 1000);
        const payload = {
            iss: "enablebanking.com",
            aud: "api.enablebanking.com",
            iat: now,
            exp: now + 3600
        };

        const base64Url = (obj: any) => Buffer.from(JSON.stringify(obj)).toString("base64url");
        const unsignedToken = `${base64Url(header)}.${base64Url(payload)}`;

        const signer = crypto.createSign("RSA-SHA256");
        signer.update(unsignedToken);

        const signature = signer.sign(privateKey, "base64url");

        return `${unsignedToken}.${signature}`;
    } catch (err) {
        console.error("Fout bij aanmaken Enable Banking JWT token:", err);
        return null;
    }
}

// Haal beschikbare banken (ASPSPs) op voor een land
export async function getASPSPs(country: string = "BE"): Promise<ASPSP[]> {
    const token = getEnableBankingJWT();
    if (!token) {
        return POPULAR_BANKS;
    }

    try {
        const response = await fetch(`${ENABLE_BANKING_BASE_URL}/aspsps?country=${country}`, {
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        });

        if (!response.ok) {
            return POPULAR_BANKS;
        }

        const data = await response.json() as any;
        const list = (data.aspsps || []).map((b: any) => ({
            name: b.name,
            country: b.country || country,
            logo: b.logo
        }));

        return list.length > 0 ? list : POPULAR_BANKS;
    } catch (err) {
        return POPULAR_BANKS;
    }
}

// Start een autorisatiesessie bij Enable Banking (/auth)
export async function startAuth(aspspName: string, aspspCountry: string = "BE", state: string): Promise<{ url: string; sessionId?: string } | null> {
    const token = getEnableBankingJWT();
    const redirectUrl = process.env.ENABLE_BANKING_REDIRECT_URL || "http://localhost:3000/bank/callback";

    if (!token) {
        return null;
    }

    try {
        const validUntil = new Date(Date.now() + 89 * 24 * 60 * 60 * 1000).toISOString();
        const response = await fetch(`${ENABLE_BANKING_BASE_URL}/auth`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                access: {
                    valid_until: validUntil
                },
                aspsp: {
                    name: aspspName,
                    country: aspspCountry
                },
                state: state,
                redirect_url: redirectUrl
            })
        });

        if (!response.ok) {
            console.error("Enable Banking /auth response error:", response.status, await response.text());
            return null;
        }

        const data = await response.json() as any;
        return {
            url: data.url,
            sessionId: data.session_id
        };
    } catch (err) {
        console.error("Fout bij aanroepen Enable Banking /auth:", err);
        return null;
    }
}

// Wissel de autorisatie-code in voor sessie- en rekeningdetails (/sessions)
export async function createSessionFromCode(code: string): Promise<{ sessionId: string; accounts: EnableBankingAccount[] } | null> {
    const token = getEnableBankingJWT();
    if (!token) {
        return null;
    }

    try {
        const response = await fetch(`${ENABLE_BANKING_BASE_URL}/sessions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ code })
        });

        if (!response.ok) {
            console.error("Enable Banking /sessions error:", response.status, await response.text());
            return null;
        }

        const data = await response.json() as any;
        return {
            sessionId: data.session_id,
            accounts: data.accounts || []
        };
    } catch (err) {
        console.error("Fout bij aanmaken sessie via Enable Banking:", err);
        return null;
    }
}

// Haal gekoppelde bankrekeningen op van Enable Banking
export async function getEnableBankingAccounts(): Promise<EnableBankingAccount[]> {
    const token = getEnableBankingJWT();
    if (!token) {
        return [];
    }

    try {
        const response = await fetch(`${ENABLE_BANKING_BASE_URL}/accounts`, {
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        });

        if (!response.ok) {
            return [];
        }

        const data = await response.json() as any;
        return data.accounts || [];
    } catch (err) {
        return [];
    }
}

// Haal transacties op voor een specifieke rekening bij Enable Banking

export async function fetchEnableBankingTransactions(
    accountUid: string,
    dateFrom?: string,
    // Bank­transactie-ID's die al in de database staan (zie
    // getKnownBankTransactionIds in database.ts). Wanneer meegegeven,
    // slaan we die transacties meteen over vóórdat we ze categoriseren
    // (inclusief de eventuele AI-aanroep), zodat elke uurlijkse
    // automatische synchronisatie niet telkens opnieuw de volledige
    // opgevraagde periode herclassificeert.
    knownBankTransactionIds?: Set<string>
): Promise<BankTransactionResult[]> {
    const token = getEnableBankingJWT();

    if (!token) {
        return [];
    }

    const result: BankTransactionResult[] = [];

    try {
        // Enable Banking geeft transacties gepagineerd terug via een
        // continuation_key in de response. Zonder deze lus te doorlopen
        // kreeg je alleen de EERSTE pagina — dat verklaart zowel het
        // wisselende aantal transacties per sync (43 vs 48) als het feit
        // dat oudere historie ontbrak. We blijven pagina's ophalen tot er
        // geen continuation_key meer terugkomt.
        let continuationKey: string | undefined = undefined;

        do {
            let url = `${ENABLE_BANKING_BASE_URL}/accounts/${accountUid}/transactions`;
            const params = new URLSearchParams();

            if (dateFrom) {
                params.set("date_from", dateFrom);
            }
            if (continuationKey) {
                params.set("continuation_key", continuationKey);
            }

            const queryString = params.toString();
            if (queryString) {
                url += `?${queryString}`;
            }

            const response = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json"
                }
            });

            if (!response.ok) {
                console.error(
                    "Enable Banking transactions response niet OK:",
                    response.status,
                    await response.text()
                );
                break;
            }

            const data = await response.json() as any;
            const txList = data.transactions || [];
            continuationKey = data.continuation_key || undefined;

            for (const tx of txList) {
            const rawAmount = parseFloat(
                tx.transaction_amount?.amount ||
                tx.amount ||
                "0"
            );

            // Transactie zonder geldig bedrag overslaan
            if (!rawAmount || rawAmount === 0) {
                continue;
            }

            const creditDebitIndicator =
                tx.credit_debit_indicator ||
                (rawAmount < 0 ? "DBIT" : "CRDT");

            const amount = Math.abs(rawAmount);

            // Naam van tegenpartij. Bij een uitgave (DBIT) is de tegenpartij
            // de "creditor" (de winkel/leverancier die het geld ontvangt);
            // bij inkomen (CRDT) is de tegenpartij de "debtor" (wie ons
            // betaalt).
            //
            // BELANGRIJK: we vallen hier NIET terug op de andere partij
            // (dus bij een uitgave niet op debtor, en bij inkomen niet op
            // creditor), want die andere partij ben je bij een reguliere
            // overschrijving altijd ZELF. Deed je dat wel, dan kreeg elke
            // uitgave waarvan de winkelnaam ontbrak in de brondata jouw
            // eigen naam te zien als "winkel" (verwarrend en fout), in
            // plaats van door te vallen op de omschrijving hieronder, die
            // vaak wél de echte winkelnaam/locatie bevat. Bij een
            // overschrijving naar je eigen (spaar)rekening ben JIJ wel
            // degelijk de creditor.name, dus die blijft hier gewoon
            // correct herkend worden.
            const name =
                (creditDebitIndicator === "DBIT"
                    ? tx.creditor?.name
                    : tx.debtor?.name) ||
                tx.remittance_information?.[0] ||
                tx.remittance_information_unstructured ||
                "Banktransactie";

            // Gebruik de echte AANKOOPdatum van de banktransactie.
            // transaction_date staat het dichtst bij het echte moment van
            // aankoop. booking_date/value_date zijn de datum waarop de bank
            // de transactie heeft verwerkt/afgehandeld, wat bij kaart-
            // betalingen vaak 1 tot enkele dagen LATER is dan de aankoop
            // zelf (settlement-vertraging) — vandaar staat transaction_date
            // hier vóórop.
            const dateStr =
                tx.transaction_date ||
                tx.booking_date ||
                tx.value_date ||
                tx.date;

            // Geen datum gevonden: niet doen alsof de transactie vandaag is
            if (!dateStr) {
                console.warn(
                    "Banktransactie zonder datum overgeslagen:",
                    tx
                );
                continue;
            }

            // Belangrijk: booking_date/value_date/transaction_date zijn
            // kalenderdatums ("YYYY-MM-DD") zonder tijdcomponent.
            // `new Date("2024-01-15")` interpreteert dit als middernacht
            // UTC, wat bij weergave op een server met een andere tijdzone
            // een dag kan verschuiven. parseDateOnly houdt de kalenderdatum
            // consistent.
            const date = parseDateOnly(dateStr);

            // Ongeldige datum overslaan
            if (isNaN(date.getTime())) {
                console.warn(
                    "Ongeldige bankdatum overgeslagen:",
                    dateStr
                );
                continue;
            }

            // Maand bepalen op basis van de echte (lokale) transactiedatum
            const month = toMonthKey(date);

            const bankTransactionId =
                tx.entry_reference ||
                tx.transaction_id ||
                `eb_${date.getTime()}_${amount}`;

            // Deze transactie staat al in de database (van een vorige
            // synchronisatie) — overslaan vóórdat we tijd/geld besteden aan
            // categoriseren (en mogelijk een AI-aanroep) voor iets dat toch
            // nooit opnieuw wordt ingevoegd.
            if (knownBankTransactionIds?.has(bankTransactionId)) {
                continue;
            }

            const description =
                Array.isArray(tx.remittance_information)
                    ? tx.remittance_information.join(" ")
                    : (
                        tx.remittance_information_unstructured || ""
                    );

            // Spaarpot: een overschrijving VAN of NAAR je eigen
            // spaarrekening is geen gewone uitgave/inkomen, maar een
            // spaarstorting (DBIT, geld gaat naar de spaarrekening) of een
            // spaaropname (CRDT, geld komt terug vanaf de spaarrekening).
            // Beide richtingen worden op dezelfde manier herkend:
            //   a) de tegenrekening komt overeen met het handmatig
            //      ingestelde BEHEERDER_IBAN (bij DBIT is dat de
            //      ontvanger/creditor_account, bij CRDT de afzender/
            //      debtor_account), óf
            //   b) de naam van de afzender (debtor) is gelijk aan de naam
            //      van de ontvanger (creditor) — een overschrijving tussen
            //      twee rekeningen op je eigen naam. Dit is symmetrisch en
            //      werkt dus voor beide richtingen, zonder configuratie.
            // Dit controleren we vóórdat autoCategorize()/de AI worden
            // aangeroepen, zowel om verkeerde categorisatie te voorkomen
            // als om geen onnodige AI-kosten te maken voor iets dat toch
            // geen "Overig"-uitgave is.
            // We controleren BEIDE partij-velden (creditor_account EN
            // debtor_account) tegen BEHEERDER_IBAN, in plaats van alleen
            // het veld dat bij de richting van de transactie hoort. Reden:
            // banken vullen voor een inkomende overschrijving (CRDT, dus
            // een spaaropname) het debtor_account-veld lang niet altijd
            // even betrouwbaar/volledig in als het creditor_account-veld
            // bij een uitgaande overschrijving. Als dat veld leeg is,
            // werd een spaaropname hierdoor nooit als "isSaving" herkend
            // en kwam hij dus als gewoon inkomen binnen — met als gevolg
            // dat de Spaarpot alleen maar groeide (alleen stortingen) en
            // opnames niet zichtbaar waren. Door altijd allebei te
            // controleren maakt het niet meer uit welke kant de bank wél
            // vult.
            const isSaving =
                matchesBeheerderIban(tx.creditor_account) ||
                matchesBeheerderIban(tx.debtor_account) ||
                isSelfTransfer(tx.debtor?.name, tx.creditor?.name);

            let category: string;

            if (isSaving) {
                category = "Spaarpot";
            } else {
                category = autoCategorize(name, description);

                // De trefwoordenlijst herkent geen kleine/onbekende zaken
                // (bv. "ZEHRA", "LAM ET DAH"). Voor uitgaven die daardoor
                // op "Overig" uitkomen, laten we de AI een gefundeerde
                // inschatting maken op basis van naam en omschrijving.
                // Geldopname/Overschrijving slaan we hier bewust over: die
                // zijn al betrouwbaar herkend aan de vaste banktekst en
                // hebben geen AI nodig.
                if (creditDebitIndicator === "DBIT" && category === "Overig") {
                    const aiCategory = await categorizeWithAI(name, description);
                    if (aiCategory) {
                        category = aiCategory;
                    }
                }
            }

            // Negatieve transactie = uitgave (of spaarstorting)
            // Positieve transactie = inkomen (of spaaropname)
            result.push({
                name,

                amount:
                    creditDebitIndicator === "DBIT"
                        ? -amount
                        : amount,

                categoryName: isSaving
                    ? "Spaarpot"
                    : (creditDebitIndicator === "DBIT" ? category : "Inkomen"),

                date,
                month,

                recurring: false,
                inputMethod: "bank",

                bankTransactionId,

                isSaving
                });
            }
        } while (continuationKey);

    } catch (err) {
        console.error(
            "Fout bij ophalen transacties via Enable Banking:",
            err
        );
    }

    return result;
}